import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {request} from 'node:http';
import {PassThrough} from 'node:stream';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {ProjectMemory} from '../src/memory.js';
import {Router} from '../src/core.js';
import {createMcpHandler} from '../src/mcp.js';
import {startHttp} from '../src/http.js';
import {startStdio} from '../src/stdio.js';
import {inspectLock, removeStaleLock} from '../src/locks.js';
import {inspectMemory} from '../src/memory-repair.js';
import {BudgetLedger} from '../src/budget.js';
import {ConcurrencyLimiter} from '../src/concurrency.js';
import {RateLimiter} from '../src/ratelimit.js';
import {Metrics, MAX_SERIES} from '../src/metrics.js';
import {modelAllowed} from '../src/targets.js';
import {providerRegistry} from '../src/providers.js';
import {config, budgetConfig} from '../src/config.js';
import {ToolError, RateLimitError, toolErrorHttpStatus} from '../src/errors.js';
import {forbiddenPath} from '../scripts/release-check.mjs';

const TOKEN = 'audit-fixes-primary-token-for-tests-00000';
const source = fileURLToPath(new URL('../', import.meta.url));

async function tempDir(t, prefix = 'dz23-audit-') {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fsp.rm(dir, {recursive: true, force: true}));
  return dir;
}

const LOCAL = {name: 'local', baseURL: 'http://fixture.invalid', apiKey: 'local', keyName: 'LOCAL', credentialSource: 'none', defaultModel: 'm',
  tier: 'local', protocol: 'openai', location: 'local', capabilities: {text: true}, enabled: true, configured: true};
const CLOUD = {name: 'cloud', baseURL: 'http://cloud.invalid', apiKey: 'fixture', keyName: 'CLOUD_API_KEY', credentialSource: 'env:CLOUD_API_KEY', defaultModel: 'd',
  tier: 'free-tier', protocol: 'openai', location: 'cloud', capabilities: {text: true}, enabled: true, configured: true};

async function routerFixture(t, cfg = {}, caller) {
  const dir = await tempDir(t);
  const memory = new ProjectMemory(dir);
  const full = {rotation: ['local:m'], allowPaid: false, policy: 'free-first', maxConcurrency: 4, maxWorkersPerTarget: 4, timeoutMs: 5000, maxContextChars: 20000, ...cfg};
  const seen = [];
  const router = new Router(full, memory, {registry: {local: LOCAL, cloud: CLOUD}, caller: async (target, messages, options) => {
    seen.push(JSON.stringify(messages));
    return caller ? caller(target, messages, options) : {content: 'ok'};
  }});
  return {dir, memory, router, seen, cfg: full};
}

async function serve(t, cfg = {}) {
  const f = await routerFixture(t, {host: '127.0.0.1', port: 0, token: TOKEN, ...cfg});
  const server = await startHttp(f.cfg, f.router, f.memory, createMcpHandler(f.router, f.memory));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const port = server.address().port;
  const raw = (options, body) => new Promise((resolve, reject) => {
    const req = request({host: '127.0.0.1', port, ...options}, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body: text ? JSON.parse(text) : null}));
    });
    req.on('error', reject);
    req.end(body);
  });
  return {...f, url: `http://127.0.0.1:${port}`, raw};
}

const auth = (token = TOKEN) => ({authorization: `Bearer ${token}`});

test('concurrent checkpoints keep every appended item (no lost update)', async t => {
  const memory = new ProjectMemory(await tempDir(t));
  await Promise.all(Array.from({length: 20}, (_, i) => memory.recordCheckpoint('p', 'm', {decisions: [`d${i}`]})));
  const mission = await memory.getMission('p', 'm');
  assert.equal(mission.decisions.length, 20);
  assert.deepEqual(new Set(mission.decisions), new Set(Array.from({length: 20}, (_, i) => `d${i}`)));
});

test('checkpoint lists and total state size are bounded; the tool response is a compact summary', async t => {
  const dir = await tempDir(t);
  const capped = new ProjectMemory(dir, {maxListItems: 10});
  for (let batch = 0; batch < 3; batch++) await capped.recordCheckpoint('p', 'm', {decisions: Array.from({length: 10}, (_, i) => `d${batch * 10 + i}`)});
  const mission = await capped.getMission('p', 'm');
  assert.deepEqual([mission.decisions.length, mission.decisions.at(-1), mission.decisions[0]], [10, 'd29', 'd20']);
  const small = new ProjectMemory(dir, {maxStateBytes: 4096});
  await assert.rejects(small.recordCheckpoint('p', 'big', {summary: 'x'.repeat(8000)}), error => error instanceof ToolError && error.code === 'memory_limit_exceeded');
  assert.equal(toolErrorHttpStatus(new ToolError('memory_limit_exceeded', 'x')), 413);
  const cfg = config({DZ23_STATE_DIR: dir, DZ23_MAX_CHECKPOINT_LIST_ITEMS: '10', DZ23_MAX_STATE_BYTES: '300000'});
  const wired = new ProjectMemory(dir, cfg);
  assert.deepEqual([wired.maxListItems, wired.maxStateBytes], [10, 300000]);

  const f = await routerFixture(t);
  const outcome = await createMcpHandler(f.router, f.memory).executeTool('memory_checkpoint',
    {project_id: 'p', mission_id: 'm', decisions: ['decision-text-that-must-not-be-echoed'], status: 'active', next_action: 'continue'}, {transport: 'stdio', requestId: 'r1', identity: 'stdio'});
  assert.equal(outcome.ok, true);
  assert.deepEqual([outcome.value.counts.decisions, outcome.value.status, outcome.value.next_action], [1, 'active', 'continue']);
  assert.equal(JSON.stringify(outcome.value).includes('decision-text-that-must-not-be-echoed'), false);
});

test('identifiers differing only by letter case are refused', async t => {
  const memory = new ProjectMemory(await tempDir(t));
  memory.caseProbe = Promise.resolve(true); // exercise the case-insensitive rules on every platform
  await memory.initProject('CaseProj');
  await assert.rejects(memory.initProject('caseproj'), error => error.code === 'invalid_request' && error.details === undefined);
  await memory.startMission('CaseProj', 'Mission1', {goal: 'g'});
  await assert.rejects(memory.startMission('CaseProj', 'mission1', {goal: 'g'}), error => error.code === 'invalid_request');
});

test('delegate and swarm keep harness-owned status, next_action and goal', async t => {
  const f = await routerFixture(t, {maxConcurrency: 2});
  await f.memory.recordCheckpoint('p', 'm', {status: 'blocked', next_action: 'human step', goal: 'human goal'});
  await f.router.delegate({project_id: 'p', mission_id: 'm', prompt: 'hello'});
  let mission = await f.memory.getMission('p', 'm');
  assert.deepEqual([mission.status, mission.next_action, mission.goal, mission.last_tool_handoff.tool], ['blocked', 'human step', 'human goal', 'delegate']);
  const swarm = await f.router.swarmRun({project_id: 'p', mission_id: 'm', goal: 'other goal'});
  mission = await f.memory.getMission('p', 'm');
  assert.equal(swarm.workers.length, 2, 'swarm defaults to DZ23_MAX_CONCURRENCY workers');
  assert.deepEqual([mission.status, mission.next_action, mission.goal, mission.last_tool_handoff.tool, mission.swarm_last_run.count, mission.swarm_run],
    ['blocked', 'human step', 'human goal', 'swarm_run', 2, null]);
});

test('independent delegates (consensus reviewers) do not see earlier agent outputs', async t => {
  let reply = 'FIRST-OUTPUT-MARKER';
  const f = await routerFixture(t, {}, async () => ({content: reply}));
  await f.router.delegate({project_id: 'p', mission_id: 'm', prompt: 'first'});
  reply = 'later';
  await f.router.delegate({project_id: 'p', mission_id: 'm', prompt: 'independent', independent: true});
  await f.router.delegate({project_id: 'p', mission_id: 'm', prompt: 'shared'});
  assert.equal(f.seen[1].includes('FIRST-OUTPUT-MARKER'), false);
  assert.equal(f.seen[2].includes('FIRST-OUTPUT-MARKER'), true);
});

test('explicit targets report why they are refused; non-default models need a rotation or DZ23_ALLOW_PAID', async t => {
  const reason = expected => error => error instanceof ToolError && error.code === 'target_not_allowed' && error.details.reason === expected;
  const open = await routerFixture(t, {rotation: []});
  assert.throws(() => open.router.resolvePreferred('ghost:x'), reason('unknown_provider'));
  assert.throws(() => open.router.resolvePreferred('cloud:other'), reason('model_not_allowed'));
  assert.equal(open.router.resolvePreferred('cloud:d').length, 1);
  await assert.rejects(open.router.verifyModel({target: 'cloud:other'}), reason('model_not_allowed'));
  assert.equal(open.seen.length, 0);
  const paid = await routerFixture(t, {rotation: [], allowPaid: true});
  assert.equal(paid.router.resolvePreferred('cloud:other').length, 1);
  const rotated = await routerFixture(t, {rotation: ['cloud:d']});
  assert.throws(() => rotated.router.resolvePreferred('cloud:other'), reason('not_in_rotation'));
  assert.equal(modelAllowed({...CLOUD, model: 'other'}, {rotation: ['cloud:d']}), true);
  assert.equal(modelAllowed({...LOCAL, baseURL: 'http://127.0.0.1:11434/v1', model: 'anything'}, {rotation: []}), true);
  assert.equal(modelAllowed({...LOCAL, baseURL: 'https://api.openai.com/v1', model: 'anything'}, {rotation: []}), false);
});

test('local providers are enabled only when explicitly configured', t => {
  const saved = Object.fromEntries(['CUSTOM_BASE_URL', 'CUSTOM_API_KEY', 'CUSTOM_MODEL', 'CUSTOM_API_KEY_FILE'].map(key => [key, process.env[key]]));
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  for (const key of Object.keys(saved)) delete process.env[key];
  assert.equal(providerRegistry().custom.enabled, false);
  process.env.CUSTOM_MODEL = 'qwen3-coder';
  assert.equal(providerRegistry().custom.enabled, true);
});

test('HTTP: auth failures are throttled without locking out valid tokens; one error envelope', async t => {
  const s = await serve(t, {rateLimit: {enabled: true, windowMs: 60_000, points: 10, toolPoints: 10, maxConcurrent: 2}});
  const bad = () => fetch(`${s.url}/healthz`, {headers: auth('wrong-token-wrong-token-wrong-token-00')});
  const first = await bad();
  assert.equal(first.status, 401);
  assert.equal((await first.json()).error.code, 'unauthorized');
  await (await bad()).text();
  const throttled = await bad();
  assert.equal(throttled.status, 429);
  assert.ok(Number(throttled.headers.get('retry-after')) >= 1);
  await throttled.text();
  assert.equal((await fetch(`${s.url}/healthz`, {headers: auth()})).status, 200);
  const missing = await fetch(`${s.url}/nope`, {headers: auth()});
  const body = await missing.json();
  assert.deepEqual([missing.status, body.error.code, typeof body.error.request_id], [404, 'not_found', 'string']);
});

test('HTTP: Host header is authoritative and cross-site browser requests are refused', async t => {
  const s = await serve(t);
  const evil = await s.raw({path: '/healthz', headers: {...auth(), host: 'evil.example'}});
  assert.deepEqual([evil.status, evil.body.error.code], [403, 'host_not_allowed']);
  const absolute = await s.raw({path: 'http://127.0.0.1/healthz', headers: {...auth(), host: 'evil.example'}});
  assert.deepEqual([absolute.status, absolute.body.error.code], [403, 'host_not_allowed']);
  const crossSite = await s.raw({path: '/healthz', headers: {...auth(), 'sec-fetch-site': 'cross-site'}});
  assert.deepEqual([crossSite.status, crossSite.body.error.code], [403, 'cross_site_request_blocked']);
  assert.equal((await s.raw({path: '/healthz', headers: {...auth(), 'sec-fetch-site': 'same-origin'}})).status, 200);
});

test('HTTP: billable health check requires POST with confirm_billable', async t => {
  const s = await serve(t);
  const get = await fetch(`${s.url}/api/health`, {headers: auth()});
  assert.deepEqual([get.status, get.headers.get('allow'), (await get.json()).error.code], [405, 'POST', 'method_not_allowed']);
  const post = body => fetch(`${s.url}/api/health`, {method: 'POST', body: JSON.stringify(body), headers: {...auth(), 'content-type': 'application/json'}});
  const unconfirmed = await post({});
  assert.deepEqual([unconfirmed.status, (await unconfirmed.json()).error.details.field], [400, 'confirm_billable']);
  assert.equal(s.seen.length, 0);
  const confirmed = await post({confirm_billable: true});
  assert.equal(confirmed.status, 200);
  await confirmed.text();
  assert.ok(s.seen.length >= 1);
});

test('stale lock removal never deletes a recreated lock; owners from before boot are removable', async t => {
  const dir = await tempDir(t);
  const lockPath = path.join(dir, '.lock');
  fs.mkdirSync(lockPath);
  assert.equal(await removeStaleLock(lockPath, {exists: true, owner: null, stale_ms: 30_000}), false);
  assert.equal(fs.existsSync(lockPath), true);
  const old = '2000-01-01T00:00:00.000Z';
  fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({pid: process.pid, hostname: os.hostname(), created_at: old, updated_at: old, lock_version: 1}));
  const inspection = await inspectLock(lockPath);
  assert.deepEqual([inspection.removable, inspection.reason], [true, 'owner_before_system_boot']);
  assert.equal(await removeStaleLock(lockPath, inspection), true);
  assert.equal(fs.existsSync(lockPath), false);
});

test('stdio discards oversized frames without buffering them and keeps processing', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const written = [];
  output.on('data', chunk => written.push(...String(chunk).split('\n').filter(Boolean).map(line => JSON.parse(line))));
  const received = [];
  const stdio = startStdio({maxFrameBytes: 100, input, output, processMessage: async message => { received.push(message); return {response: {jsonrpc: '2.0', id: message.id, result: {}}}; }});
  input.write('x'.repeat(80));
  input.write('x'.repeat(80));
  await new Promise(setImmediate);
  assert.equal(stdio.bufferedBytes(), 0);
  input.write('x'.repeat(5000));
  await new Promise(setImmediate);
  assert.equal(stdio.bufferedBytes(), 0);
  input.end('tail\n{"jsonrpc":"2.0","id":7,"method":"ping"}\n');
  await stdio.finished;
  await new Promise(setImmediate);
  assert.deepEqual(received.map(message => message.id), [7]);
  assert.equal(written.filter(message => message.error?.data?.reason === 'frame too large').length, 1);
  assert.ok(written.some(message => message.id === 7 && message.result));
});

test('repair never proposes rolling back a record written by a newer schema', async t => {
  const memory = new ProjectMemory(await tempDir(t));
  await memory.recordCheckpoint('p', 'm', {goal: 'g', status: 'active'});
  const file = memory.missionFile('p', 'm');
  fs.writeFileSync(file, JSON.stringify({...JSON.parse(fs.readFileSync(file, 'utf8')), schema: 999}));
  const report = await inspectMemory(memory);
  const issue = report.issues.find(item => item.mission === 'm');
  assert.ok(issue);
  assert.equal(issue.checkpoint, undefined);
  assert.match(issue.action, /newer version/);
});

test('budget: failed usage writes are not cached; cost limits default to deny_unknown_cost', async t => {
  const memory = new ProjectMemory(await tempDir(t));
  const ledger = new BudgetLedger({}, memory);
  const target = {...LOCAL, model: 'm'};
  const admission = await ledger.admit({target, messages: [{role: 'user', content: 'hi'}], maxOutputTokens: 8, scope: 'system'});
  const original = memory.recordSystemUsage.bind(memory);
  let attempts = 0;
  memory.recordSystemUsage = async record => { attempts++; if (attempts === 1) throw new Error('disk full'); return original(record); };
  const details = {target, role: 'verify_model', status: 'success', output: {content: 'OK'}};
  await assert.rejects(ledger.settle(admission.reservation, details), /disk full/);
  assert.equal(admission.reservation.record ?? null, null, 'a failed write must not be cached as settled');
  const record = await ledger.settle(admission.reservation, details);
  assert.deepEqual([attempts, record.status], [2, 'success']);
  assert.equal(budgetConfig({DZ23_MAX_DAILY_COST_USD: '1'}).policy, 'deny_unknown_cost');
  assert.equal(budgetConfig({}).policy, 'allow_unknown_cost');
  assert.equal(budgetConfig({DZ23_MAX_DAILY_COST_USD: '1', DZ23_COST_POLICY: 'allow_unknown_cost'}).policy, 'allow_unknown_cost');
  assert.equal(new BudgetLedger({budget: {dailyCostUsd: 1}}, memory).limits.policy, 'deny_unknown_cost');
});

test('a full delegation queue is a queue_full tool error (503), not an internal error', async () => {
  const limiter = new ConcurrencyLimiter(1, 1, 1);
  let unblock;
  const gate = new Promise(resolve => { unblock = resolve; });
  const running = limiter.run('k', () => gate);
  const queued = limiter.run('k', async () => 'queued');
  await assert.rejects(limiter.run('k', async () => 'overflow'), error => error instanceof ToolError && error.code === 'queue_full' && toolErrorHttpStatus(error) === 503);
  unblock();
  assert.equal(await queued, 'queued');
  await running;
});

test('config: invalid booleans and routing policy are error issues', async t => {
  const cfg = config({DZ23_STATE_DIR: await tempDir(t), DZ23_ALLOW_PAID: 'maybe', DZ23_ROUTING_POLICY: 'cheapest'});
  const errors = cfg.configIssues.filter(issue => issue.level === 'error').map(issue => issue.variable);
  assert.ok(errors.includes('DZ23_ALLOW_PAID'));
  assert.ok(errors.includes('DZ23_ROUTING_POLICY'));
  assert.deepEqual([cfg.allowPaid, cfg.policy], [false, 'free-first']);
});

test('rate limiter keeps depleted buckets under key pressure and bounds memory', () => {
  const limiter = new RateLimiter({points: 10, maxKeys: 3});
  limiter.consume('A', {points: 10});
  for (const id of ['B', 'C', 'D', 'E']) limiter.check(id, 0);
  assert.throws(() => limiter.consume('A', {points: 1}), RateLimitError);
  for (let i = 0; i < 20; i++) limiter.consume(`z${i}`, {points: 10});
  assert.ok(limiter.buckets.size <= 6);
});

test('metrics series are bounded and dropped series are counted', () => {
  const metrics = new Metrics();
  metrics.increment('existing', {k: 'v'});
  for (let i = 0; i < MAX_SERIES + 50; i++) metrics.increment('calls_total', {model: `m${i}`});
  assert.ok(metrics.counters.size <= MAX_SERIES + 1);
  assert.equal(metrics.counter('metrics_series_dropped_total'), 51);
  metrics.increment('existing', {k: 'v'});
  assert.equal(metrics.counter('existing', {k: 'v'}), 2);
});

test('release guard rejects credential-like file names', () => {
  for (const name of ['credentials.json', 'config/secrets.prod.json', 'token.txt']) assert.equal(forbiddenPath(name), true, name);
  assert.equal(forbiddenPath('config/examples/scoped-tokens.example.json'), false);
});

async function packageCopy(t) {
  const dir = await tempDir(t, 'dz23-audit-cli-');
  fs.cpSync(path.join(source, 'src'), path.join(dir, 'pkg', 'src'), {recursive: true});
  fs.copyFileSync(path.join(source, 'package.json'), path.join(dir, 'pkg', 'package.json'));
  const env = {DZ23_STATE_DIR: path.join(dir, 'state')};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) if (process.env[key] !== undefined) env[key] = process.env[key];
  return (args, {extraEnv = {}, input = ''} = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(dir, 'pkg', 'src', 'index.js'), ...args], {cwd: dir, env: {...env, ...extraEnv}});
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`timed out: ${args.join(' ')}`)); }, 20_000);
    child.on('close', status => { clearTimeout(timer); resolve({status, stdout, stderr}); });
    child.stdin.end(input);
  });
}

test('CLI: unknown commands never start the server; JSON errors; short tokens refused; config errors exit 78', async t => {
  const run = await packageCopy(t);
  const unknown = await run(['statr']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr + unknown.stdout, /unknown command/);
  const json = await run(['statr', '--json']);
  assert.deepEqual([json.status, JSON.parse(json.stdout).error.code], [2, 'usage_error']);
  const short = await run(['token', 'hash', '--json'], {input: 'short-token'});
  assert.equal(short.status, 2);
  assert.match(JSON.parse(short.stdout).error.message, /at least 32 characters/);
  const server = await run(['--stdio'], {extraEnv: {DZ23_ALLOW_PAID: 'maybe'}});
  assert.equal(server.status, 78);
  assert.equal(server.stdout, '');
});
