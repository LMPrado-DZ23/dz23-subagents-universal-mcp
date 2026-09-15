import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {PassThrough} from 'node:stream';
import {ProjectMemory} from '../src/memory.js';
import {Router} from '../src/core.js';
import {createMcpHandler, summarizeSwarm} from '../src/mcp.js';
import {createRpcProcessor} from '../src/rpc.js';
import {startStdio} from '../src/stdio.js';
import {startHttp, unauthenticatedHttpProblem} from '../src/http.js';
import {ProviderError} from '../src/provider-errors.js';
import {ToolError} from '../src/errors.js';
import {heuristicSynthesis} from '../src/consensus.js';
import {buildTools} from '../src/tools.js';
import {validate, ValidationError} from '../src/schema.js';
import {ConcurrencyLimiter} from '../src/concurrency.js';

const TOKEN = 't'.repeat(40);
const entry = name => ({name, baseURL: `http://${name}`, apiKey: 'x', keyName: 'X', credentialSource: 'env:X', defaultModel: `m${name.slice(1)}`, tier: 'free-tier',
  protocol: 'openai', location: 'cloud', capabilities: {text: true}, enabled: true, configured: true});
const registry = {p1: entry('p1'), p2: entry('p2'), p3: {...entry('p3'), enabled: false, configured: false}};

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dz23-hardening-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  return dir;
}

function makeRouter(memory, caller, cfg = {}, deps = {}) {
  return new Router({rotation: ['p1:m1', 'p2:m2'], policy: 'free-first', maxConcurrency: 4, maxWorkersPerTarget: 4, timeoutMs: 1000, maxContextChars: 20000, maxRetries: 2, ...cfg},
    memory, {registry, caller, sleep: async () => {}, ...deps});
}

const cancellable = (target, _messages, {signal} = {}) => new Promise((_, reject) => {
  signal?.addEventListener('abort', () => reject(new ProviderError({kind: 'provider_error', provider: target.name, model: target.model, detail: 'request cancelled'})), {once: true});
});

async function waitFor(check, attempts = 400) {
  for (let i = 0; i < attempts; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('condition not reached');
}

test('context_length_exceeded fails over immediately, without retry or cooldown', async t => {
  const memory = new ProjectMemory(await tempDir(t), {durableWrites: false});
  const calls = [];
  const router = makeRouter(memory, async target => {
    calls.push(target.name);
    if (target.name === 'p1') throw new ProviderError({kind: 'context_length_exceeded', provider: 'p1', model: 'm1', status: 413});
    return {content: 'p2 ok'};
  });
  const out = await router.delegate({project_id: 'p', mission_id: 'm', prompt: 'x'});
  assert.deepEqual([out.provider, calls, router.cooldowns()], ['p2', ['p1', 'p2'], []]);
  assert.equal(out.attempts[0].kind, 'context_length_exceeded');
});

test('a paid answer survives memory failures that happen after the provider call', async t => {
  const memory = new ProjectMemory(await tempDir(t), {durableWrites: false});
  memory.recordUsage = async () => { throw new ToolError('lock_timeout', 'Timed out waiting for a memory lock'); };
  memory.recordAgentResult = async () => { throw new ToolError('lock_timeout', 'Timed out waiting for a memory lock'); };
  const router = makeRouter(memory, async () => ({content: 'paid answer'}));
  const out = await router.delegate({project_id: 'p', mission_id: 'm', prompt: 'x'});
  assert.equal(out.content, 'paid answer');
  assert.equal(out.usage, null);
  assert.deepEqual(out.memory_warnings, ['usage:lock_timeout', 'agent_result:lock_timeout']);
});

test('a cancelled call is not retried, failed over or cooled down', async t => {
  const memory = new ProjectMemory(await tempDir(t), {durableWrites: false});
  const calls = [];
  const router = makeRouter(memory, (target, messages, options) => { calls.push(target.name); return cancellable(target, messages, options); });
  const controller = new AbortController();
  const work = router.delegate({project_id: 'p', mission_id: 'm', prompt: 'x', signal: controller.signal});
  await waitFor(() => calls.length === 1);
  controller.abort();
  await assert.rejects(work, error => error instanceof ToolError && error.code === 'cancelled');
  assert.deepEqual([calls, router.cooldowns()], [['p1'], []]);
  const usage = await memory.usageRecords('p', 'm');
  assert.deepEqual(usage.map(record => [record.status, record.kind]), [['failed', 'cancelled']]);
});

test('a call waiting in the limiter queue leaves the queue when cancelled', async () => {
  const limiter = new ConcurrencyLimiter(1, 1);
  let release;
  const blocker = limiter.run('k', () => new Promise(resolve => { release = resolve; }));
  const controller = new AbortController();
  const queued = limiter.run('k', async () => 'never', controller.signal);
  assert.equal(limiter.queue.length, 1);
  controller.abort();
  await assert.rejects(queued, error => error.code === 'cancelled');
  assert.equal(limiter.queue.length, 0);
  release();
  await blocker;
  assert.equal(limiter.active, 0);
});

test('billable tools stop at DZ23_DELEGATE_DEADLINE_MS with deadline_exceeded', async t => {
  const memory = new ProjectMemory(await tempDir(t), {durableWrites: false});
  const router = makeRouter(memory, cancellable, {delegateDeadlineMs: 60});
  const process = createRpcProcessor(createMcpHandler(router, memory));
  const {response} = await process({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'delegate', arguments: {project_id: 'p', mission_id: 'm', prompt: 'x'}}}, {requestId: 'req-deadline-1'});
  assert.equal(response.result.isError, true);
  assert.equal(response.result.structuredContent.error.code, 'deadline_exceeded');
});

test('shared cooldowns let another process skip a target that just failed', async t => {
  const dir = await tempDir(t);
  const first = makeRouter(new ProjectMemory(dir, {durableWrites: false}), async target => {
    if (target.name === 'p1') throw new ProviderError({kind: 'rate_limited', provider: 'p1', model: 'm1', status: 429});
    return {content: 'ok'};
  }, {sharedCooldowns: true, maxRetries: 0});
  assert.equal((await first.delegate({project_id: 'p', mission_id: 'a', prompt: 'x'})).provider, 'p2');
  const calls = [];
  const second = makeRouter(new ProjectMemory(dir, {durableWrites: false}), async target => { calls.push(target.name); return {content: 'ok'}; }, {sharedCooldowns: true});
  assert.equal((await second.delegate({project_id: 'p', mission_id: 'b', prompt: 'x'})).provider, 'p2');
  assert.deepEqual(calls, ['p2']);
  assert.equal(second.cooldowns()[0].target, 'p1:m1');
  const isolated = makeRouter(new ProjectMemory(dir, {durableWrites: false}), async target => ({content: target.name}), {sharedCooldowns: false});
  assert.equal((await isolated.delegate({project_id: 'p', mission_id: 'c', prompt: 'x'})).provider, 'p1');
});

test('stdio answers quick requests while a slow one runs and suppresses a cancelled response', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const written = [];
  output.on('data', chunk => written.push(...String(chunk).split('\n').filter(Boolean).map(line => JSON.parse(line))));
  const signals = {};
  const processMessage = async (message, ctx) => {
    if (message.method === 'slow') {
      signals[message.id] = ctx.signal;
      await new Promise(resolve => ctx.signal.addEventListener('abort', resolve, {once: true}));
    }
    return {response: {jsonrpc: '2.0', id: message.id, result: {}}};
  };
  const stdio = startStdio({maxFrameBytes: 4096, maxInflight: 4, input, output, processMessage});
  input.write('{"jsonrpc":"2.0","id":"slow-1","method":"slow"}\n');
  input.write('{"jsonrpc":"2.0","id":2,"method":"ping"}\n');
  await waitFor(() => written.some(message => message.id === 2));
  assert.equal(written.some(message => message.id === 'slow-1'), false);
  input.end('{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":"slow-1","reason":"user"}}\n');
  await stdio.finished;
  assert.equal(signals['slow-1'].aborted, true);
  assert.deepEqual(written.map(message => message.id), [2]);
});

test('results are compact: text without indentation, mission previews and swarm summaries', async t => {
  const memory = new ProjectMemory(await tempDir(t), {durableWrites: false});
  let count = 0;
  const router = makeRouter(memory, async () => ({content: `answer-${++count} ${'x'.repeat(2000)}`}));
  const process = createRpcProcessor(createMcpHandler(router, memory));
  const call = async (name, args) => (await process({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name, arguments: args}}, {requestId: 'req-compact-1'})).response.result;
  const swarm = await call('swarm_run', {project_id: 'p', mission_id: 'm', goal: 'build', roles: ['architect', 'qa']});
  assert.equal(swarm.content[0].text.includes('\n  '), false);
  assert.equal(swarm.structuredContent.workers.every(worker => worker.ok && !('content' in worker) && worker.excerpt.length <= 601 && worker.output_chars > 2000), true);
  assert.ok(swarm.structuredContent.integration.content.length > 2000);
  const status = (await call('mission_status', {project_id: 'p', mission_id: 'm'})).structuredContent.state;
  assert.equal(status.agent_outputs.every(output => !('content' in output) && output.preview.length <= 401 && output.chars > 2000), true);
  assert.ok(status.last_output.length <= 401 && status.last_output_chars > 2000);
  const full = (await call('mission_status', {project_id: 'p', mission_id: 'm', include_outputs: true})).structuredContent.state;
  assert.ok(full.agent_outputs.every(output => output.content.length > 2000));
  const fullSwarm = summarizeSwarm({workers: [{ok: false, role: 'qa', code: 'all_providers_failed', error: 'x'}], integration: null});
  assert.deepEqual(fullSwarm.workers, [{ok: false, role: 'qa', code: 'all_providers_failed', error: 'x'}]);
});

test('the integrating reviewer receives this run outputs inline instead of memory context', async t => {
  const memory = new ProjectMemory(await tempDir(t), {durableWrites: false});
  const prompts = [];
  let count = 0;
  const router = makeRouter(memory, async (_target, messages) => { prompts.push(messages[1].content); return {content: `answer-${++count}`}; });
  await router.swarmRun({project_id: 'p', mission_id: 'm', goal: 'build', roles: ['architect', 'qa']});
  const reviewer = prompts.at(-1);
  assert.match(reviewer, /UNTRUSTED AGENT OUTPUTS/);
  assert.match(reviewer, /answer-1/);
  assert.match(reviewer, /answer-2/);
  assert.equal(reviewer.includes('## RECENT_OUTPUTS'), false);
});

test('REST discovery refresh needs POST, and discovery never probes disabled providers', async t => {
  const memory = new ProjectMemory(await tempDir(t), {durableWrites: false});
  const probed = [];
  const router = makeRouter(memory, async () => ({content: 'ok'}), {}, {discoverer: async target => { probed.push(target.name); return {ok: true, models: [{id: target.defaultModel}]}; }});
  assert.deepEqual(await router.discover({provider: 'p3', refresh: true}), []);
  assert.deepEqual(probed, []);
  const cfg = {host: '127.0.0.1', port: 0, token: TOKEN, scopedTokens: []};
  const server = await startHttp(cfg, router, memory, createMcpHandler(router, memory));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = {authorization: `Bearer ${TOKEN}`};
  const get = await fetch(`${base}/api/discover?refresh=true`, {headers});
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('allow'), 'POST');
  assert.deepEqual(probed, []);
  const post = await fetch(`${base}/api/discover`, {method: 'POST', headers: {...headers, 'content-type': 'application/json'}, body: JSON.stringify({provider: 'p1', refresh: true})});
  assert.equal(post.status, 200);
  assert.deepEqual(probed, ['p1']);
});

test('HTTP without any credential is refused unless explicitly allowed', () => {
  assert.match(unauthenticatedHttpProblem({token: '', scopedTokens: []}), /DZ23_ALLOW_UNAUTHENTICATED_LOCAL_HTTP/);
  assert.equal(unauthenticatedHttpProblem({token: TOKEN, scopedTokens: []}), null);
  assert.equal(unauthenticatedHttpProblem({token: '', scopedTokens: [{id: 'r'}]}), null);
  assert.equal(unauthenticatedHttpProblem({token: '', scopedTokens: [], allowUnauthenticatedLocalHttp: true}), null);
});

test('ids cannot end with a dot or use Windows device names', async t => {
  const memory = new ProjectMemory(await tempDir(t), {durableWrites: false});
  for (const id of ['proj.', 'CON', 'nul.txt', 'Com1', 'lpt9.log']) {
    await assert.rejects(memory.initProject(id), error => error instanceof ToolError && error.code === 'invalid_request', id);
  }
  assert.equal((await memory.initProject('proj.v2_final-1')).project_id, 'proj.v2_final-1');
  assert.equal((await memory.initProject('a')).project_id, 'a');
  const schema = buildTools().find(tool => tool.name === 'project_init').inputSchema;
  assert.throws(() => validate(schema, {project_id: 'abc.'}), ValidationError);
});

test('consensus flags shared wording around different key terms instead of reporting agreement', () => {
  const divergent = heuristicSynthesis([
    {provider: 'p1', model: 'm', content: 'Use Postgres for the durable job queue in production.'},
    {provider: 'p2', model: 'm', content: 'Use Redis for the durable job queue in production.'}
  ]);
  assert.equal(divergent.possible_divergences.length, 1);
  assert.deepEqual([divergent.possible_divergences[0].a.terms, divergent.possible_divergences[0].b.terms], [['postgres'], ['redis']]);
  assert.notEqual(divergent.agreement.level, 'high');
  assert.equal(divergent.agreement.method, 'lexical_overlap');
  assert.equal(divergent.common_claims.length, 0);
  const paraphrase = heuristicSynthesis([
    {provider: 'p1', model: 'm', content: 'Run database migrations before deploying the service.'},
    {provider: 'p2', model: 'm', content: 'Run database migrations before you deploy the service.'}
  ]);
  assert.equal(paraphrase.possible_divergences.length, 0);
  assert.equal(paraphrase.common_claims.length, 1);
});
