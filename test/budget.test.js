import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ProjectMemory} from '../src/memory.js';
import {Router} from '../src/core.js';
import {ProviderError} from '../src/provider-errors.js';
import {normalizeUsage, addUsage, estimateTokens} from '../src/usage.js';
import {budgetConfig} from '../src/config.js';
import {ConfigError, ToolError} from '../src/errors.js';

const PRICES = {'p1:m1': {input_per_million_usd: 1, output_per_million_usd: 2}};
const USAGE = {prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500};

async function budgetRouter(t, {budget = {}, caller, rotation = ['p1:m1'], cfg = {}} = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dz23-budget-'));
  t.after(() => fsp.rm(dir, {recursive: true, force: true}));
  const memory = new ProjectMemory(dir);
  const registry = {
    p1: {name: 'p1', baseURL: 'http://p1', apiKey: 'x', keyName: 'X', defaultModel: 'm1', tier: 'free-tier', protocol: 'openai', enabled: true},
    p2: {name: 'p2', baseURL: 'http://p2', apiKey: 'x', keyName: 'X', defaultModel: 'm2', tier: 'free-tier', protocol: 'openai', enabled: true}
  };
  const calls = [];
  const router = new Router({rotation, policy: 'free-first', maxConcurrency: 5, maxWorkersPerTarget: 5, timeoutMs: 1000, maxContextChars: 20000,
    maxOutputTokens: 100, maxRetries: 0, budget, ...cfg}, memory, {registry, sleep: async () => {},
    caller: async (target, messages) => { calls.push(target.name); return caller ? caller(target, messages) : {content: 'ok answer', usage: USAGE}; }});
  return {router, memory, calls, dir};
}

const delegate = (router, extra = {}) => router.delegate({project_id: 'proj', mission_id: 'm1', prompt: 'review', ...extra});
const budgetError = limit => error => error instanceof ToolError && error.code === 'budget_exceeded' && error.details.limit === limit;

test('available budget: provider usage is recorded and priced from the configured table', async t => {
  const {router, memory, dir} = await budgetRouter(t, {budget: {missionCostUsd: 1, prices: PRICES}});
  const out = await delegate(router, {request_id: 'req-budget-0001'});
  assert.deepEqual(
    [out.usage.input_tokens, out.usage.output_tokens, out.usage.total_tokens, out.usage.token_source, out.usage.estimated_cost_usd, out.usage.cost_source, out.usage.request_id],
    [1000, 500, 1500, 'provider', 0.002, 'configured_price', 'req-budget-0001']);
  const mission = await memory.getMission('proj', 'm1');
  assert.deepEqual([mission.usage.calls, mission.usage.cost_usd, mission.usage.total_tokens], [1, 0.002, 1500]);
  assert.equal((await memory.getProject('proj')).usage_totals.cost_usd, 0.002);
  const day = new Date().toISOString().slice(0, 10);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'usage', 'daily', `${day}.json`), 'utf8')).cost_usd, 0.002);
  const records = await memory.usageRecords('proj', 'm1');
  assert.equal(records.length, 1);
  assert.deepEqual(Object.keys(records[0]).sort(), ['at', 'cost_source', 'estimated_cost_usd', 'input_tokens', 'model', 'output_tokens', 'provider', 'request_id', 'role', 'schema', 'status', 'token_source', 'total_tokens']);
});

test('provider-reported cost wins; missing usage is estimated; unknown price stays null', async t => {
  const reported = await budgetRouter(t, {budget: {prices: PRICES}, caller: async () => ({content: 'x', usage: {prompt_tokens: 10, completion_tokens: 5, cost: 0.0123}})});
  const a = (await delegate(reported.router)).usage;
  assert.deepEqual([a.cost_source, a.estimated_cost_usd], ['provider_usage', 0.0123]);
  const bare = await budgetRouter(t, {caller: async () => ({content: 'y'.repeat(40)})});
  const b = (await delegate(bare.router)).usage;
  assert.deepEqual([b.token_source, b.output_tokens, b.estimated_cost_usd, b.cost_source], ['estimated', 10, null, 'unknown']);
  assert.equal((await bare.memory.getMission('proj', 'm1')).usage.unknown_cost_calls, 1);
});

test('deny_unknown_cost skips unpriced targets and blocks when no target is priced', async t => {
  const mixed = await budgetRouter(t, {rotation: ['p1:m1', 'p2:m2'], budget: {policy: 'deny_unknown_cost', prices: {'p2:*': {input_per_million_usd: 0, output_per_million_usd: 0}}}});
  const out = await delegate(mixed.router);
  assert.deepEqual([out.provider, mixed.calls, out.budget_denials], ['p2', ['p2'], [{target: 'p1:m1', reason: 'unknown_cost'}]]);
  const none = await budgetRouter(t, {budget: {policy: 'deny_unknown_cost'}});
  await assert.rejects(delegate(none.router), error => budgetError('target_policy')(error) && error.details.denials[0].reason === 'unknown_cost');
  assert.deepEqual(none.calls, []);
});

test('limits are enforced before any provider call', async t => {
  const call = await budgetRouter(t, {budget: {callCostUsd: 0.000001, prices: PRICES}});
  await assert.rejects(delegate(call.router), error => error.details.denials[0].reason === 'call_cost_limit');
  assert.deepEqual(call.calls, []);

  // Each call reports 0.002 USD; the pre-call estimate stays well below that for this small context.
  const mission = await budgetRouter(t, {budget: {missionCostUsd: 0.004, prices: PRICES}});
  await delegate(mission.router);
  await delegate(mission.router);
  await assert.rejects(delegate(mission.router), budgetError('mission_cost'));
  assert.equal(mission.calls.length, 2, 'the third call is blocked once persisted spend reaches the limit');

  const calls = await budgetRouter(t, {budget: {missionCalls: 1}});
  await delegate(calls.router);
  await assert.rejects(delegate(calls.router), budgetError('mission_calls'));
  assert.equal(calls.calls.length, 1);

  const tokens = await budgetRouter(t, {budget: {missionTokens: 1700}});
  await delegate(tokens.router);
  await assert.rejects(delegate(tokens.router), budgetError('mission_tokens'));

  const input = await budgetRouter(t, {budget: {inputTokens: 5}});
  await assert.rejects(delegate(input.router), error => error instanceof ToolError && error.code === 'input_too_large');
  assert.deepEqual(input.calls, []);
});

test('daily cost limit is shared across projects', async t => {
  const {router, calls} = await budgetRouter(t, {budget: {dailyCostUsd: 0.002, prices: PRICES}});
  await router.delegate({project_id: 'a', mission_id: 'm', prompt: 'x'});
  await assert.rejects(router.delegate({project_id: 'b', mission_id: 'm', prompt: 'x'}), budgetError('daily_cost'));
  assert.equal(calls.length, 1);
});

test('retry attempts count as calls while only successful usage adds tokens', async t => {
  let failures = 1;
  const {router, memory, calls} = await budgetRouter(t, {cfg: {maxRetries: 1}, budget: {prices: PRICES}, caller: async target => {
    if (failures-- > 0) throw new ProviderError({kind: 'provider_unavailable', provider: target.name, model: target.model, status: 503});
    return {content: 'ok', usage: USAGE};
  }});
  await delegate(router);
  assert.equal(calls.length, 2);
  const usage = (await memory.getMission('proj', 'm1')).usage;
  assert.deepEqual([usage.calls, usage.failed_calls, usage.total_tokens, usage.cost_usd, usage.unknown_cost_calls], [2, 1, 1500, 0.002, 0]);
  assert.deepEqual((await memory.usageRecords('proj', 'm1')).map(r => [r.status, r.kind, r.cost_source]), [['failed', 'provider_unavailable', 'unknown'], ['success', undefined, 'configured_price']]);
});

test('concurrent swarm workers cannot overrun the mission call budget', async t => {
  const {router, memory, calls} = await budgetRouter(t, {budget: {missionCalls: 3}, caller: async () => {
    await new Promise(resolve => setTimeout(resolve, 5));
    return {content: 'worker', usage: USAGE};
  }});
  const out = await router.swarmRun({project_id: 'proj', mission_id: 'm1', goal: 'build', roles: ['architect', 'backend', 'frontend', 'security', 'qa'], max_agents: 5});
  assert.equal(calls.length, 3);
  assert.equal(out.workers.filter(w => w.ok).length, 3);
  assert.ok(out.workers.filter(w => !w.ok).every(w => w.code === 'budget_exceeded'));
  assert.equal(out.integration.ok, false, 'the integrating reviewer is budgeted too');
  assert.equal((await memory.getMission('proj', 'm1')).usage.calls, 3);
});

test('the integrating reviewer call is budgeted and recorded', async t => {
  const {router, memory, calls} = await budgetRouter(t, {budget: {prices: PRICES, missionCostUsd: 1}});
  const out = await router.swarmRun({project_id: 'proj', mission_id: 'm1', goal: 'build', roles: ['architect', 'qa'], max_agents: 2});
  assert.equal(out.integration.ok, true);
  assert.equal(calls.length, 3);
  const records = await memory.usageRecords('proj', 'm1');
  assert.deepEqual(records.map(r => r.role).sort(), ['architect', 'qa', 'reviewer']);
  assert.equal((await memory.getMission('proj', 'm1')).usage.cost_usd, 0.006);
});

test('health_check respects the unknown-cost policy and records system usage', async t => {
  const denied = await budgetRouter(t, {budget: {policy: 'deny_unknown_cost'}});
  assert.deepEqual(await denied.router.healthCheck(), [{provider: 'p1', model: 'm1', ok: false, latency_ms: 0, kind: 'budget_exceeded', reason: 'unknown_cost'}]);
  assert.deepEqual(denied.calls, []);
  const allowed = await budgetRouter(t, {budget: {prices: PRICES, dailyCostUsd: 1}});
  const [result] = await allowed.router.healthCheck({request_id: 'req-health-0001'});
  assert.deepEqual([result.ok, result.usage.role, result.usage.cost_source], [true, 'health_check', 'configured_price']);
  const day = new Date().toISOString().slice(0, 10);
  assert.equal((await allowed.memory.getDailyUsage(day)).calls, 1);
});

test('usage normalization covers OpenAI, Anthropic and malformed payloads', () => {
  assert.deepEqual(normalizeUsage(USAGE), {input_tokens: 1000, output_tokens: 500, total_tokens: 1500, reported_cost_usd: null});
  assert.deepEqual(normalizeUsage({input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 90}), {input_tokens: 100, output_tokens: 4, total_tokens: 104, reported_cost_usd: null});
  assert.equal(normalizeUsage({prompt_tokens: -1, completion_tokens: 'x'}), null);
  assert.equal(normalizeUsage(null), null);
  assert.equal(estimateTokens('abcdefgh'), 2);
  assert.deepEqual(addUsage(null, {status: 'failed', input_tokens: 0, output_tokens: 0, total_tokens: 0, estimated_cost_usd: null}),
    {calls: 1, failed_calls: 1, input_tokens: 0, output_tokens: 0, total_tokens: 0, cost_usd: 0, unknown_cost_calls: 0});
});

test('budget configuration fails loudly on invalid values', async t => {
  assert.equal(budgetConfig({}).policy, 'allow_unknown_cost');
  assert.throws(() => budgetConfig({DZ23_MAX_MISSION_COST_USD: 'ten'}), ConfigError);
  assert.throws(() => budgetConfig({DZ23_MAX_DAILY_COST_USD: '-1'}), /non-negative/);
  assert.throws(() => budgetConfig({DZ23_MAX_MISSION_CALLS: '1.5'}), /integer/);
  assert.throws(() => budgetConfig({DZ23_COST_POLICY: 'yolo'}), /DZ23_COST_POLICY/);
  assert.throws(() => budgetConfig({DZ23_PRICES: '{"OpenAI:gpt": {"input_per_million_usd": 1, "output_per_million_usd": 1}}'}), /provider:model/);
  assert.throws(() => budgetConfig({DZ23_PRICES: '{"p:m": {"input_per_million_usd": 1}}'}), /output_per_million_usd/);
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dz23-prices-'));
  t.after(() => fsp.rm(dir, {recursive: true, force: true}));
  const file = path.join(dir, 'prices.json');
  fs.writeFileSync(file, JSON.stringify({prices: PRICES}));
  assert.deepEqual(budgetConfig({DZ23_PRICES_FILE: file, DZ23_MAX_CALL_COST_USD: '0.5'}).prices, PRICES);
  assert.throws(() => budgetConfig({DZ23_PRICES_FILE: file, DZ23_PRICES: '{}'}), /Set only one/);
  assert.throws(() => budgetConfig({DZ23_PRICES_FILE: path.join(dir, 'missing.json')}), /Cannot read DZ23_PRICES_FILE/);
});
