import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {orderTargets, planRouting, observeRouting, pickReviewer} from '../src/routing.js';
import {extractClaims, claimTokens, heuristicSynthesis} from '../src/consensus.js';
import {ProjectMemory} from '../src/memory.js';
import {Router} from '../src/core.js';
import {ProviderError} from '../src/provider-errors.js';
import {ToolError} from '../src/errors.js';

const T = (name, model) => ({name, model, tier: 'free-tier', enabled: true, baseURL: `http://${name}`});
const keys = list => list.map(target => `${target.name}:${target.model}`);

test('orderTargets implements each strategy with stable fallbacks', () => {
  const targets = [T('p1', 'a'), T('p1', 'b'), T('p2', 'a'), T('p3', 'c')];
  assert.deepEqual(keys(orderTargets(targets, 'first')), ['p1:a', 'p1:b', 'p2:a', 'p3:c']);
  assert.deepEqual(keys(orderTargets(targets, 'round_robin')), ['p1:a', 'p1:b', 'p2:a', 'p3:c']);
  assert.deepEqual(keys(orderTargets(targets, 'provider_diversity')), ['p1:a', 'p2:a', 'p3:c', 'p1:b']);
  assert.deepEqual(keys(orderTargets(targets, 'model_diversity')), ['p1:a', 'p1:b', 'p3:c', 'p2:a']);
  const prices = {'p3:c': {input_per_million_usd: 0.05, output_per_million_usd: 0.05}, 'p2:a': {input_per_million_usd: 1, output_per_million_usd: 1}};
  assert.deepEqual(keys(orderTargets(targets, 'cost_optimized', {priceOf: t => prices[`${t.name}:${t.model}`] || null})), ['p3:c', 'p2:a', 'p1:a', 'p1:b']);
  const latency = {'p2:a': 50, 'p1:b': 20};
  assert.deepEqual(keys(orderTargets(targets, 'latency_optimized', {latencyOf: t => latency[`${t.name}:${t.model}`] ?? null})), ['p1:b', 'p2:a', 'p1:a', 'p3:c']);
});

test('planRouting reports requested and effective strategy without promising diversity', () => {
  const targets = [T('p1', 'a'), T('p1', 'b'), T('p2', 'c')];
  const rr = planRouting({targets, count: 5, strategy: 'round_robin'});
  assert.deepEqual(keys(rr.assignments), ['p1:a', 'p1:b', 'p2:c', 'p1:a', 'p1:b']);
  assert.deepEqual([rr.routing.effective_strategy, rr.routing.planned_distinct_providers, rr.routing.planned_distinct_models, rr.routing.warnings], ['round_robin', 2, 3, []]);
  assert.deepEqual(keys(planRouting({targets, count: 3, strategy: 'provider_diversity'}).assignments), ['p1:a', 'p2:c', 'p1:b']);
  const first = planRouting({targets, count: 3});
  assert.deepEqual([keys(first.assignments), first.routing.effective_strategy], [['p1:a', 'p1:a', 'p1:a'], 'first']);
  const widened = planRouting({targets, count: 3, strategy: 'first', minDistinctProviders: 2});
  assert.deepEqual([keys(widened.assignments), widened.routing.effective_strategy, widened.routing.planned_distinct_providers], [['p1:a', 'p2:c', 'p1:a'], 'round_robin', 2]);
  const sameProvider = [T('p1', 'a'), T('p1', 'b')];
  const collapsed = planRouting({targets: sameProvider, count: 2, strategy: 'provider_diversity', minDistinctProviders: 2});
  assert.equal(collapsed.routing.effective_strategy, 'round_robin');
  assert.match(collapsed.routing.warnings[0], /min_distinct_providers: 2 requested but only 1 planned/);
  assert.throws(() => planRouting({targets: sameProvider, count: 2, strategy: 'provider_diversity', minDistinctProviders: 2, strict: true}),
    error => error instanceof ToolError && error.code === 'diversity_unavailable' && error.details.routing.requested_strategy === 'provider_diversity');
  assert.equal(planRouting({targets: [T('p1', 'a')], count: 3, strategy: 'round_robin'}).routing.effective_strategy, 'first');
  const noPrices = planRouting({targets, count: 2, strategy: 'cost_optimized'});
  assert.deepEqual([noPrices.routing.effective_strategy, noPrices.routing.warnings], ['first', ['cost_optimized: no configured prices; rotation order used']]);
  const distinct = planRouting({targets, count: 5, strategy: 'round_robin', distinctOnly: true});
  assert.deepEqual([distinct.assignments.length, distinct.routing.warnings], [3, ['only 3 distinct eligible targets for 5 requested calls']]);
  const observed = observeRouting(rr.routing, [{ok: true, provider: 'p1', model: 'a'}, {ok: true, provider: 'p1', model: 'b'}, {ok: false, provider: 'p2', model: 'c'}]);
  assert.deepEqual([observed.distinct_providers, observed.distinct_models, observed.warnings.length], [1, 2, 1]);
  assert.deepEqual(keys([pickReviewer(targets, new Set(['p1:a', 'p1:b']), 'first').target]), ['p2:c']);
  assert.equal(pickReviewer([T('p1', 'a')], new Set(['p1:a'])).shares_worker_target, true);
});

async function fixture(t, {rotation, caller, cfg = {}}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dz23-routing-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const entry = (name, model) => ({name, baseURL: `http://${name}`, apiKey: 'x', keyName: 'X', defaultModel: model, tier: 'free-tier', protocol: 'openai', enabled: true});
  const registry = {p1: entry('p1', 'm1'), p2: entry('p2', 'm2'), p3: entry('p3', 'm3')};
  const calls = [];
  const router = new Router({rotation, policy: 'free-first', maxConcurrency: 7, maxWorkersPerTarget: 4, timeoutMs: 1000, maxContextChars: 20000, maxRetries: 0, ...cfg},
    new ProjectMemory(dir), {registry, sleep: async () => {}, caller: async (target, messages) => {
      calls.push(`${target.name}:${target.model}`);
      return caller ? caller(target, messages) : {content: `${target.name} answer`};
    }});
  return {router, calls};
}

test('swarm provider_diversity spreads workers and picks a reviewer outside worker targets', async t => {
  const {router} = await fixture(t, {rotation: ['p1:m1', 'p1:m1b', 'p2:m2', 'p3:m3']});
  const out = await router.swarmRun({project_id: 'p', mission_id: 'm', goal: 'build', roles: ['architect', 'backend', 'qa'], max_agents: 3,
    routing_strategy: 'provider_diversity', avoid_reviewer_target: true});
  assert.deepEqual(out.workers.map(w => `${w.provider}:${w.model}`), ['p1:m1', 'p2:m2', 'p3:m3']);
  assert.deepEqual([out.routing.requested_strategy, out.routing.effective_strategy, out.routing.distinct_providers, out.routing.distinct_models, out.routing.warnings],
    ['provider_diversity', 'provider_diversity', 3, 3, []]);
  assert.deepEqual(out.routing.reviewer, {planned_target: 'p1:m1b', shares_worker_target: false, provider: 'p1', model: 'm1b'});
  assert.equal(out.integration.model, 'm1b');
});

test('reviewer shares a worker target only when no alternative exists', async t => {
  const {router} = await fixture(t, {rotation: ['p1:m1', 'p2:m2']});
  const out = await router.swarmRun({project_id: 'p', mission_id: 'm', goal: 'build', roles: ['architect', 'qa'], max_agents: 2, routing_strategy: 'round_robin', avoid_reviewer_target: true});
  assert.equal(out.routing.reviewer.shares_worker_target, true);
  assert.ok(out.routing.warnings.includes('avoid_reviewer_target: no eligible target outside the worker targets'));
});

test('strict diversity fails before any provider call', async t => {
  const {router, calls} = await fixture(t, {rotation: ['p1:m1']});
  await assert.rejects(router.swarmRun({project_id: 'p', mission_id: 'm', goal: 'build', roles: ['qa'], max_agents: 2, routing_strategy: 'provider_diversity', min_distinct_providers: 2, strict_diversity: true}),
    error => error.code === 'diversity_unavailable');
  assert.deepEqual(calls, []);
});

test('failover that collapses diversity is reported, not hidden', async t => {
  const {router} = await fixture(t, {rotation: ['p1:m1', 'p2:m2'], caller: async target => {
    if (target.name === 'p2') throw new ProviderError({kind: 'authentication_failed', provider: 'p2', model: 'm2', status: 401});
    return {content: 'ok'};
  }});
  const out = await router.swarmRun({project_id: 'p', mission_id: 'm', goal: 'build', roles: ['architect', 'qa'], max_agents: 2, routing_strategy: 'round_robin'});
  assert.deepEqual(out.workers.map(w => w.provider), ['p1', 'p1']);
  assert.deepEqual([out.routing.planned_distinct_providers, out.routing.distinct_providers], [2, 1]);
  assert.ok(out.routing.warnings.some(w => w.includes('reduced the observed diversity')));
});

const ANSWERS = {
  p1: '- The API must validate the input token budget before each call.\n- All tests passed on CI yesterday.',
  p2: '- The API must validate the input token budget before every call.\n- The response cache should not be shared between workers.',
  p3: '- The response cache should be shared between workers.'
};

test('consensus returns responses, observed diversity and a labeled heuristic synthesis', async t => {
  const {router, calls} = await fixture(t, {rotation: ['p1:m1', 'p2:m2', 'p3:m3'], caller: async target => ({content: ANSWERS[target.name]})});
  const out = await router.consensus({project_id: 'p', mission_id: 'm', prompt: 'Review the design', models: 3});
  assert.deepEqual([out.requested, out.planned, out.received, out.failed, calls.length], [3, 3, 3, 0, 3]);
  assert.deepEqual([out.routing.requested_strategy, out.routing.distinct_providers], ['round_robin', 3]);
  const s = out.synthesis;
  assert.equal(s.method, 'heuristic_lexical_overlap');
  assert.match(s.disclaimer, /not objective truth/);
  assert.equal(s.common_claims[0].supporters, 2);
  assert.match(s.common_claims[0].text, /validate the input token budget/);
  assert.ok(s.contradictions.some(c => /cache/.test(c.a.text) && /cache/.test(c.b.text)));
  assert.deepEqual(s.unverified_claims.map(c => c.source), ['p1:m1']);
  assert.ok(['low', 'medium', 'high'].includes(s.agreement.level));
});

test('consensus synthesis modes and partial failures', async t => {
  const none = await fixture(t, {rotation: ['p1:m1', 'p2:m2']});
  assert.equal((await none.router.consensus({project_id: 'p', mission_id: 'm', prompt: 'x', synthesis: 'none'})).synthesis, null);
  const model = await fixture(t, {rotation: ['p1:m1', 'p2:m2', 'p3:m3'], caller: async (target, messages) => {
    const text = messages.map(m => m.content).join('\n');
    if (target.name === 'p3' && !text.includes('Synthesize')) throw new ProviderError({kind: 'invalid_request', provider: 'p3', model: 'm3', status: 400});
    return {content: ANSWERS[target.name] || 'synthesis'};
  }});
  const out = await model.router.consensus({project_id: 'p', mission_id: 'm', prompt: 'x', models: 3, synthesis: 'model'});
  assert.deepEqual([out.received, out.failed], [2, 1]);
  assert.deepEqual(out.responses.find(r => !r.ok), {ok: false, provider: 'p3', model: 'm3', code: 'invalid_request', error: 'Provider rejected the request as invalid; it was not sent to other providers'});
  assert.equal(out.synthesis.model.ok, true);
  assert.equal(out.synthesis.model.provider, 'p3', 'synthesis prefers a target no reviewer answered from');
  assert.equal(model.calls.length, 4);
  const single = await fixture(t, {rotation: ['p1:m1']});
  const lone = await single.router.consensus({project_id: 'p', mission_id: 'm', prompt: 'x', models: 3});
  assert.deepEqual([lone.planned, lone.routing.warnings, lone.synthesis.agreement.level], [1, ['only 1 distinct eligible targets for 3 requested calls'], 'insufficient']);
});

test('claim extraction and token heuristics', () => {
  assert.deepEqual(extractClaims('- First bullet claim here.\n2) Second numbered claim. Third sentence follows!\nshort'), ['First bullet claim here.', 'Second numbered claim.', 'Third sentence follows!']);
  assert.deepEqual([...claimTokens('The cache should NOT be shared, não compartilhe')].sort(), ['cache', 'compartilhe', 'shared']);
  assert.equal(heuristicSynthesis([{provider: 'p1', model: 'm', content: '- Only one reviewer answered this question.'}]).agreement.level, 'insufficient');
});
