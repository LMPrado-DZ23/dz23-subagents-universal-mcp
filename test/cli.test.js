import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {ProjectMemory} from '../src/memory.js';
import {sha256Hex} from '../src/auth.js';

const source = fileURLToPath(new URL('../', import.meta.url));
const SECRET = 'cli-provider-secret-value-0000';
const TOKEN = 'cli-http-token-value-for-tests-000000';

async function fixture(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dz23-cli-'));
  t.after(() => fsp.rm(dir, {recursive: true, force: true}));
  const root = path.join(dir, 'pkg');
  fs.cpSync(path.join(source, 'src'), path.join(root, 'src'), {recursive: true});
  fs.copyFileSync(path.join(source, 'package.json'), path.join(root, 'package.json'));
  const state = path.join(dir, 'state');
  const env = {DZ23_STATE_DIR: state, DZ23_ROTATION: 'custom:test-model', CUSTOM_BASE_URL: 'http://127.0.0.1:9/v1', CUSTOM_API_KEY: SECRET, DZ23_HEALTH_TIMEOUT_MS: '2000'};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) if (process.env[key] !== undefined) env[key] = process.env[key];
  return {dir, root, state, env};
}

function cli(f, args, {env = {}, input = ''} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(f.root, 'src', 'index.js'), ...args], {cwd: f.dir, env: {...f.env, ...env}});
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`CLI timed out: ${args.join(' ')}`)); }, 30_000);
    child.on('close', status => { clearTimeout(timer); resolve({status, stdout, stderr, json: () => JSON.parse(stdout)}); });
    child.stdin.end(input);
  });
}

test('doctor checks locally without provider calls or secrets', async t => {
  const f = await fixture(t);
  const ok = await cli(f, ['doctor', '--json']);
  assert.equal(ok.status, 0, ok.stderr);
  const report = ok.json();
  const byName = Object.fromEntries(report.checks.map(check => [check.name, check.status]));
  assert.deepEqual([byName.node_version, byName.configuration, byName.state_dir_writable, byName.providers, byName.http, byName.memory], ['pass', 'pass', 'pass', 'pass', 'pass', 'pass']);
  assert.equal(ok.stdout.includes(SECRET), false);
  const insecure = await cli(f, ['doctor', '--json'], {env: {DZ23_ALLOW_HTTP: 'true', DZ23_HTTP_HOST: '0.0.0.0'}});
  assert.equal(insecure.status, 1);
  assert.equal(insecure.json().checks.find(check => check.name === 'http').status, 'fail');
  const human = await cli(f, ['doctor']);
  assert.match(human.stdout, /^PASS  node_version/m);
});

test('config validate separates valid config, error issues and configuration errors', async t => {
  const f = await fixture(t);
  const valid = await cli(f, ['config', 'validate', '--json'], {env: {DZ23_MCP_TOKEN: TOKEN}});
  assert.equal(valid.status, 0, valid.stderr);
  assert.deepEqual([valid.json().valid, valid.json().summary.token_source], [true, 'env:DZ23_MCP_TOKEN']);
  assert.equal(valid.stdout.includes(TOKEN) || valid.stdout.includes(SECRET), false);
  const weights = await cli(f, ['config', 'validate', '--json'], {env: {DZ23_RATE_LIMIT_POINTS: '20'}});
  assert.equal(weights.status, 1);
  assert.equal(weights.json().issues[0].variable, 'DZ23_RATE_LIMIT_WEIGHTS');
  const rotation = await cli(f, ['config', 'validate', '--json'], {env: {DZ23_ROTATION: 'nobody:model'}});
  assert.deepEqual([rotation.status, rotation.json().valid], [1, false]);
  const broken = await cli(f, ['config', 'validate'], {env: {DZ23_MAX_DAILY_COST_USD: 'abc'}});
  assert.equal(broken.status, 78);
  assert.match(broken.stderr, /^Configuration error: DZ23_MAX_DAILY_COST_USD must be a non-negative number of USD/);
  assert.equal(broken.stderr.includes('at '), false, 'no stack trace');
});

test('providers prints inventory flags without secret values', async t => {
  const f = await fixture(t);
  const out = await cli(f, ['providers', '--json']);
  assert.equal(out.status, 0, out.stderr);
  const custom = out.json().find(entry => entry.provider === 'custom');
  assert.deepEqual([custom.status_flags.credential_present, custom.status_flags.inference_verified], [true, false]);
  assert.equal(out.stdout.includes(SECRET), false);
  assert.match((await cli(f, ['providers'])).stdout, /^PROVIDER\s+STATUS/m);
});

test('health requires --yes; with it, exactly one real generation per target', async t => {
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    req.resume();
    res.writeHead(200, {'content-type': 'application/json'});
    res.end(JSON.stringify({choices: [{message: {content: 'OK'}}], usage: {prompt_tokens: 4, completion_tokens: 1}}));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const f = await fixture(t);
  const env = {CUSTOM_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`};
  const refused = await cli(f, ['health'], {env});
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /may be billed; re-run with --yes/);
  assert.equal(requests, 0);
  const ran = await cli(f, ['health', '--yes', '--json'], {env});
  assert.equal(ran.status, 0, ran.stderr);
  assert.deepEqual(ran.json().map(r => [r.provider, r.ok]), [['custom', true]]);
  assert.equal(requests, 1);
  const down = await cli(f, ['health', '--yes', '--json']);
  assert.equal(down.status, 1);
  assert.equal(down.json()[0].kind, 'provider_unavailable');
});

test('missions list/show and memory repair with explicit confirmation', async t => {
  const f = await fixture(t);
  const memory = new ProjectMemory(f.state);
  await memory.recordCheckpoint('proj', 'good', {goal: 'healthy mission', status: 'active'});
  await memory.recordCheckpoint('proj', 'broken', {goal: 'restore me', status: 'blocked'});
  fs.writeFileSync(memory.missionFile('proj', 'broken'), '{oops');
  const list = await cli(f, ['missions', 'list', '--json']);
  assert.equal(list.status, 0, list.stderr);
  assert.deepEqual(list.json().map(r => [r.mission_id, r.status]), [['broken', 'unreadable'], ['good', 'active']]);
  const show = await cli(f, ['missions', 'show', 'proj', 'good', '--json']);
  assert.deepEqual([show.status, show.json().state.goal, show.json().journal_integrity.invalid_lines], [0, 'healthy mission', 0]);
  assert.equal((await cli(f, ['missions', 'show', 'proj', 'missing'])).status, 1);
  assert.equal((await cli(f, ['missions', 'show', 'proj', 'broken'])).status, 1);
  assert.equal((await cli(f, ['missions', 'show', '../x', 'y'])).status, 2);
  const dry = await cli(f, ['memory', 'repair', '--json']);
  assert.equal(dry.status, 1, 'repairable problems are reported as problems');
  assert.deepEqual([dry.json().applied, dry.json().actions.map(a => a.status)], [false, ['planned']]);
  assert.equal(fs.readFileSync(memory.missionFile('proj', 'broken'), 'utf8'), '{oops');
  const unconfirmed = await cli(f, ['memory', 'repair', '--apply']);
  assert.equal(unconfirmed.status, 2);
  assert.match(unconfirmed.stderr, /confirm with --yes/);
  const applied = await cli(f, ['memory', 'repair', '--apply', '--yes', '--json']);
  assert.equal(applied.status, 0, applied.stderr);
  assert.deepEqual(applied.json().actions.map(a => [a.type, a.status]), [['corrupt_mission_state', 'restored']]);
  const restored = await cli(f, ['missions', 'show', 'proj', 'broken', '--json']);
  assert.deepEqual([restored.status, restored.json().state.goal], [0, 'restore me']);
});

test('token hash reads stdin and prints only the digest', async t => {
  const f = await fixture(t);
  const out = await cli(f, ['token', 'hash', '--json'], {input: `${TOKEN}\n`});
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(out.json(), {sha256: sha256Hex(TOKEN)});
  assert.equal(out.stdout.includes(TOKEN), false);
  assert.equal((await cli(f, ['token', 'hash'], {input: ''})).status, 2);
});

test('usage errors, version and help', async t => {
  const f = await fixture(t);
  assert.equal((await cli(f, ['missions', 'wat'])).status, 2);
  assert.equal((await cli(f, ['doctor', '--bogus'])).status, 2);
  assert.equal((await cli(f, ['config'])).status, 2);
  const version = await cli(f, ['--version', '--json']);
  assert.deepEqual([version.status, version.json().version], [0, JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8')).version]);
  assert.match((await cli(f, ['help'])).stdout, /Exit codes: 0 ok, 1 problems found, 2 usage error, 78 configuration error/);
});
