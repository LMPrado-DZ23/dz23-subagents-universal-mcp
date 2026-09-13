import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {classifyHttpFailure, ProviderError, toProviderError, parseRetryAfter} from '../src/provider-errors.js';
import {callProvider, callOpenAICompatible, discoverModels} from '../src/providers.js';
import {PROVIDER_ERROR_KINDS, RETRYABLE_KINDS} from '../src/constants.js';
import {ProjectMemory} from '../src/memory.js';
import {Router} from '../src/core.js';
import {Metrics} from '../src/metrics.js';
import {ToolError} from '../src/errors.js';

const BODY_SECRET = 'provider-echoed-body-secret-value';

test('HTTP failures map to a stable taxonomy', () => {
  const table = [
    [429, 'Rate limit reached for requests', 'rate_limited'],
    [429, 'Resource has been exhausted (e.g. check quota).', 'rate_limited'],
    [429, 'You exceeded your current quota, please check your plan and billing details.', 'quota_exhausted'],
    [402, '', 'billing_required'],
    [400, 'insufficient credit balance', 'billing_required'],
    [401, '', 'authentication_failed'],
    [403, 'Invalid API key provided', 'authentication_failed'],
    [403, 'not allowed for this organization', 'permission_denied'],
    [404, 'The model `x` does not exist or you do not have access to it.', 'model_not_found'],
    [404, 'Not Found', 'endpoint_not_found'],
    [400, 'model_not_found', 'model_not_found'],
    [408, '', 'provider_timeout'],
    [504, '', 'provider_timeout'],
    [500, '', 'provider_unavailable'],
    [502, '', 'provider_unavailable'],
    [503, '', 'provider_unavailable'],
    [501, '', 'provider_error'],
    [400, 'messages: field required', 'invalid_request'],
    [413, '', 'invalid_request'],
    [422, '', 'invalid_request'],
    [418, '', 'provider_error']
  ];
  for (const [status, body, kind] of table) assert.equal(classifyHttpFailure(status, body), kind, `${status} ${body}`);
});

test('retryability follows policy and messages never carry foreign text', () => {
  assert.deepEqual([...RETRYABLE_KINDS].sort(), ['provider_timeout', 'provider_unavailable', 'rate_limited']);
  for (const kind of PROVIDER_ERROR_KINDS) assert.equal(new ProviderError({kind, provider: 'p', model: 'm'}).retryable, RETRYABLE_KINDS.has(kind), kind);
  const wrapped = toProviderError(new Error(`upstream said ${BODY_SECRET}`), {name: 'p', model: 'm'});
  assert.equal(wrapped.kind, 'provider_error');
  assert.equal(wrapped.message.includes(BODY_SECRET), false);
  assert.equal(toProviderError({kind: 'quota_or_rate_limit', message: 'quota exhausted'}, {name: 'p', model: 'm'}).kind, 'quota_exhausted');
  assert.equal(toProviderError({kind: 'configuration'}, {name: 'p', model: 'm'}).kind, 'configuration_error');
  assert.equal(toProviderError(Object.assign(new Error('x'), {status: 503}), {name: 'p', model: 'm'}).retryable, true);
  assert.equal(parseRetryAfter('2'), 2000);
  assert.equal(parseRetryAfter(new Date(Date.now() + 5000).toUTCString()) > 3000, true);
  assert.equal(parseRetryAfter('soon'), 0);
});

async function withFetch(fake, work) {
  const original = globalThis.fetch;
  globalThis.fetch = fake;
  try { return await work(); } finally { globalThis.fetch = original; }
}

const openaiTarget = {name: 'fixture', protocol: 'openai', baseURL: 'http://127.0.0.1:9/v1', apiKey: 'local', model: 'm'};

test('adapter failures are classified without exposing provider bodies', async () => {
  await withFetch(async () => new Response(`{"error":"${BODY_SECRET}"}`, {status: 503, headers: {'retry-after': '3'}}), async () => {
    await assert.rejects(callOpenAICompatible(openaiTarget, [{role: 'user', content: 'x'}]), error =>
      error.kind === 'provider_unavailable' && error.retryable && error.retryAfterMs === 3000 && error.status === 503 && !error.message.includes(BODY_SECRET));
  });
  await withFetch((_url, {signal}) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))), async () => {
    await assert.rejects(callOpenAICompatible(openaiTarget, [{role: 'user', content: 'x'}], {timeoutMs: 30}), error => error.kind === 'provider_timeout' && error.retryable);
  });
  await withFetch(async () => { throw new TypeError(`fetch failed ${BODY_SECRET}`); }, async () => {
    await assert.rejects(callOpenAICompatible(openaiTarget, [{role: 'user', content: 'x'}]), error => error.kind === 'provider_unavailable' && !error.message.includes(BODY_SECRET));
  });
  await withFetch(async () => new Response('not json', {status: 200}), async () => {
    await assert.rejects(callOpenAICompatible(openaiTarget, [{role: 'user', content: 'x'}]), error => error.kind === 'response_invalid' && !error.retryable);
  });
  await assert.rejects(callProvider({...openaiTarget, baseURL: ''}, []), error => error.kind === 'configuration_error');
  await withFetch(async () => new Response(`{"error":"bad key ${BODY_SECRET}"}`, {status: 401}), async () => {
    const found = await discoverModels(openaiTarget);
    assert.deepEqual(found, {ok: false, models: [], kind: 'authentication_failed', error: 'authentication_failed', http_status: 401});
  });
});

const registry = {
  p1: {name: 'p1', baseURL: 'http://p1', apiKey: 'x', keyName: 'X', defaultModel: 'm1', tier: 'free-tier', protocol: 'openai', enabled: true},
  p2: {name: 'p2', baseURL: 'http://p2', apiKey: 'x', keyName: 'X', defaultModel: 'm2', tier: 'free-tier', protocol: 'openai', enabled: true}
};

async function routerFixture(t, script) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dz23-retry-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const calls = [];
  const sleeps = [];
  let now = 1_000_000;
  const metrics = new Metrics({clock: () => now});
  const caller = async target => {
    calls.push(target.name);
    const step = script[target.name]?.shift?.() ?? script[target.name];
    if (step instanceof Error) throw step;
    return {content: `${target.name} ok`};
  };
  const cfg = {rotation: ['p1:m1', 'p2:m2'], policy: 'free-first', maxConcurrency: 2, maxWorkersPerTarget: 2, timeoutMs: 1000, maxContextChars: 20000,
    maxRetries: 2, retryBaseDelayMs: 100, retryAfterCapMs: 5000};
  const router = new Router(cfg, new ProjectMemory(dir), {registry, caller, metrics, random: () => 0, clock: () => now,
    sleep: async ms => { sleeps.push(ms); now += ms; }});
  return {router, calls, sleeps, metrics, run: () => router.delegate({project_id: 'p', mission_id: 'm', prompt: 'x', request_id: 'req-retry-0001'})};
}

const fail = (kind, extra = {}) => new ProviderError({kind, provider: 'p1', model: 'm1', ...extra});

test('retryable failure is retried on the same target with exponential backoff', async t => {
  const {calls, sleeps, run} = await routerFixture(t, {p1: [fail('provider_unavailable', {status: 503})]});
  const out = await run();
  assert.deepEqual([out.provider, calls, sleeps], ['p1', ['p1', 'p1'], [100]]);
  assert.equal(out.attempts.length, 1);
});

test('exhausted retries fail over and cool the target down by kind', async t => {
  const {router, calls, sleeps, metrics, run} = await routerFixture(t, {p1: fail('provider_unavailable', {status: 503})});
  const out = await run();
  assert.deepEqual([out.provider, calls, sleeps], ['p2', ['p1', 'p1', 'p1', 'p2'], [100, 200]]);
  assert.deepEqual(out.attempts.map(a => [a.provider, a.attempt, a.kind]), [['p1', 1, 'provider_unavailable'], ['p1', 2, 'provider_unavailable'], ['p1', 3, 'provider_unavailable']]);
  assert.equal(metrics.counter('failovers_total'), 1);
  assert.equal(metrics.counter('provider_retries_total', {kind: 'provider_unavailable'}), 2);
  assert.deepEqual(router.cooldowns().map(c => [c.target, c.kind, c.remaining_ms]), [['p1:m1', 'provider_unavailable', 30_000]]);
});

test('Retry-After is honored inside the cap and triggers failover beyond it', async t => {
  const within = await routerFixture(t, {p1: [fail('rate_limited', {status: 429, retryAfterMs: 2000})]});
  assert.equal((await within.run()).provider, 'p1');
  assert.deepEqual(within.sleeps, [2000]);
  const beyond = await routerFixture(t, {p1: fail('rate_limited', {status: 429, retryAfterMs: 60_000})});
  assert.equal((await beyond.run()).provider, 'p2');
  assert.deepEqual([beyond.calls, beyond.sleeps], [['p1', 'p2'], []]);
  assert.equal(beyond.router.cooldowns()[0].remaining_ms, 60_000);
});

test('non-retryable failures fail over immediately without retry', async t => {
  const {router, calls, sleeps, run} = await routerFixture(t, {p1: fail('authentication_failed', {status: 401})});
  assert.equal((await run()).provider, 'p2');
  assert.deepEqual([calls, sleeps], [['p1', 'p2'], []]);
  assert.equal(router.cooldowns()[0].remaining_ms, 15 * 60_000);
});

test('invalid requests are neither retried nor sent to other providers', async t => {
  const {router, calls, sleeps, run} = await routerFixture(t, {p1: fail('invalid_request', {status: 400})});
  await assert.rejects(run(), error => error instanceof ToolError && error.code === 'invalid_request' && error.details.attempts[0].kind === 'invalid_request');
  assert.deepEqual([calls, sleeps, router.cooldowns()], [['p1'], [], []]);
});

test('all providers failing returns every classified attempt', async t => {
  const {calls, run} = await routerFixture(t, {p1: fail('permission_denied', {status: 403}), p2: new ProviderError({kind: 'model_not_found', provider: 'p2', model: 'm2', status: 404})});
  await assert.rejects(run(), error => error.code === 'all_providers_failed' && error.details.attempts.map(a => a.kind).join() === 'permission_denied,model_not_found');
  assert.deepEqual(calls, ['p1', 'p2']);
});
