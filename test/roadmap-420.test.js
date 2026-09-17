import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {stack, entry, waitFor} from './helpers-410.js';
import {parseRateLimits, RoutingStats} from '../src/routing-stats.js';
import {validatePlan} from '../src/mission-dag.js';

const registry = {fast: entry('fast'), slow: entry('slow'), paid: entry('paid', 'paid'), local: entry('local', 'local', 'local')};
const settled = s => ['completed', 'awaiting_acceptance', 'failed', 'failed_safe', 'cancelled', 'deadline_exceeded', 'paused'].includes(s);

test('adaptive routing learns the best free model per task type without crossing cost tiers', async t => {
  // Both free-tier models answer; slow takes much longer. The local model refuses (no cooldown for that kind).
  const s = await stack(t, {registry, cfg: {rotation: ['slow:m', 'fast:m', 'local:m'], allowPaid: false}, caller: async target => {
    if (target.name === 'local') throw Object.assign(new Error('prompt is too long'), {status: 413});
    await new Promise(resolve => setTimeout(resolve, target.name === 'slow' ? 250 : 5));
    return {content: `ok ${target.name}`};
  }});
  const first = await s.tool('routing_explain', {task_type: 'code'});
  assert.deepEqual(first.order, ['local:m', 'slow:m', 'fast:m'], 'local tier first, then rotation order before any observation');
  for (let i = 0; i < 3; i++) await s.tool('delegate', {prompt: `slow ${i}`, task_type: 'code', target: 'slow:m'});
  for (let i = 0; i < 3; i++) await s.tool('delegate', {prompt: `fast ${i}`, task_type: 'code', target: 'fast:m'});
  const learned = await s.tool('routing_explain', {task_type: 'code'});
  assert.equal(learned.order[0], 'local:m', 'the cheaper tier always stays first, whatever its record');
  assert.deepEqual(learned.order.slice(1), ['fast:m', 'slow:m'], 'inside free-tier, the faster model with the same success goes first');
  assert.deepEqual((await s.tool('routing_explain', {task_type: 'review'})).order, ['local:m', 'slow:m', 'fast:m'], 'observations are per task type');
  const out = await s.tool('delegate', {prompt: 'next', task_type: 'code'});
  assert.equal(out.provider, 'fast', 'after local refuses, delegate fails over to the learned best free model');
  const after = await s.tool('routing_explain', {task_type: 'code'});
  assert.equal(after.targets.find(x => x.target === 'local:m').observed.failures.context_length_exceeded, 1);
  const ordered = await stack(t, {registry, cfg: {rotation: ['slow:m', 'fast:m'], policy: 'rotation-order'}});
  ordered.router.stats = s.router.stats;
  assert.deepEqual((await ordered.tool('routing_explain', {task_type: 'code'})).order, ['slow:m', 'fast:m'], 'rotation-order is respected');
  assert.equal((await s.tool('routing_explain', {target: 'paid:m'})).requested.allowed, false, 'paid stays blocked');
});

test('quota headers are parsed and an exhausted target is tried last; stats persist across restarts', async t => {
  const headers = new Headers({'x-ratelimit-remaining-requests': '0', 'x-ratelimit-remaining-tokens': '5000', 'x-ratelimit-reset-requests': '6m0s', 'anthropic-ratelimit-tokens-remaining': '100'});
  const limits = parseRateLimits(headers, Date.parse('2026-09-17T00:00:00Z'));
  assert.deepEqual([limits.requests_remaining, limits.tokens_remaining, limits.reset_at], [0, 100, '2026-09-17T00:06:00.000Z']);
  const s = await stack(t, {registry, cfg: {rotation: ['fast:m', 'slow:m']}, caller: async target => ({content: 'ok', ...(target.name === 'fast' ? {rate_limits: {requests_remaining: 0, reset_at: new Date(Date.now() + 600000).toISOString(), observed_at: new Date().toISOString()}} : {})})});
  await s.tool('delegate', {prompt: 'x'});
  const explained = await s.tool('routing_explain', {});
  assert.deepEqual(explained.order, ['slow:m', 'fast:m']);
  assert.equal(explained.targets.find(x => x.target === 'fast:m').quota.requests_remaining, 0);
  await s.router.stats.flush();
  const file = path.join(s.stateDir, 'providers', 'routing-stats.json');
  const reloaded = new RoutingStats({file});
  await reloaded.load();
  assert.equal(reloaded.entry('fast:m', 'general').calls, 1);
});

test('cost_estimate sizes calls and tokens and reports unknown cost honestly', async t => {
  const s = await stack(t);
  const swarm = await s.tool('cost_estimate', {tool: 'swarm_run', prompt: 'x'.repeat(4000), roles: ['qa', 'security']});
  assert.deepEqual([swarm.calls, swarm.input_tokens_per_call, swarm.max_total_cost_usd], [3, 2500, null]);
  const consensus = await s.tool('cost_estimate', {tool: 'consensus', prompt_chars: 400, models: 2, synthesis: 'model'});
  assert.equal(consensus.calls, 3);
});

test('mission_list and playbook_get serve harnesses that have no MCP resources or prompts', async t => {
  const s = await stack(t);
  await s.tool('memory_checkpoint', {project_id: 'alpha', mission_id: 'm1', status: 'active', next_action: 'ship it', goal: 'release'});
  const list = await s.tool('mission_list', {});
  assert.deepEqual(list.missions.map(m => [m.mission_id, m.status, m.next_action, m.resource_uri]), [['m1', 'active', 'ship it', 'dz23://mission/alpha/m1']]);
  assert.ok((await s.tool('playbook_get', {})).prompts.some(p => p.name === 'audit_project'));
  assert.match((await s.tool('playbook_get', {name: 'fix_bug', arguments: {bug: 'login loop'}})).messages[0].content.text, /login loop/);
  assert.equal((await s.tool('playbook_get', {name: 'fix_bug', arguments: {}})).error.code, 'invalid_request');
});

test('plans are validated: unique ids, existing dependencies and no cycles', () => {
  assert.throws(() => validatePlan({nodes: [{id: 'a', prompt: 'x'}, {id: 'a', prompt: 'y'}]}), /unique/);
  assert.throws(() => validatePlan({nodes: [{id: 'a', prompt: 'x', depends_on: ['zzz']}]}), /existing/);
  assert.throws(() => validatePlan({nodes: [{id: 'a', prompt: 'x', depends_on: ['b']}, {id: 'b', prompt: 'y', depends_on: ['a']}]}), /cycle/);
  assert.equal(validatePlan({nodes: [{id: 'a', prompt: 'x'}, {id: 'b', prompt: 'y', depends_on: ['a']}]}).length, 2);
});

test('a mission graph runs independent nodes in parallel, passes dependency results and retries failures', async t => {
  let active = 0;
  let peak = 0;
  let flaky = 0;
  const started = new Set();
  const s = await stack(t, {caller: async (target, messages) => {
    const text = JSON.stringify(messages);
    const node = /Your task \((\w+)\)/.exec(text)?.[1];
    started.add(node);
    active++; peak = Math.max(peak, active);
    // Barrier instead of a fixed sleep: api and ui each wait (bounded) for the other to start, so a loaded
    // machine cannot make truly parallel nodes look sequential, while sequential execution still leaves peak at 1.
    for (let waited = 0; ['api', 'ui'].includes(node) && !(started.has('api') && started.has('ui')) && waited < 3000; waited += 10) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    active--;
    if (text.includes('Your task (tests)') && flaky++ < 2) throw Object.assign(new Error('prompt is too long'), {status: 413});
    const id = /Your task \((\w+)\)/.exec(text)[1];
    return {content: `RESULT-OF-${id}`};
  }});
  const plan = {nodes: [
    {id: 'api', title: 'Design API', prompt: 'design the api', role: 'architect'},
    {id: 'ui', title: 'Design UI', prompt: 'design the ui', role: 'frontend'},
    {id: 'tests', title: 'Write tests', prompt: 'write tests', role: 'qa', depends_on: ['api', 'ui']}
  ]};
  const job = await s.tool('mission_start', {project_id: 'p', mission_id: 'dag', goal: 'ship feature', plan});
  await waitFor(async () => settled((await s.tool('mission_status_job', {job_id: job.job_id})).status));
  const status = await s.tool('mission_status_job', {job_id: job.job_id});
  assert.equal(status.status, 'awaiting_acceptance');
  assert.deepEqual(status.dag, {nodes: 3, done: 3, running: 0, pending: 0, failed: 0, skipped: 0});
  assert.ok(peak >= 2, 'api and ui ran at the same time');
  const testsPrompt = s.calls.filter(c => c.text.includes('Your task (tests)')).at(-1).text;
  assert.match(testsPrompt, /RESULT-OF-api/);
  assert.match(testsPrompt, /RESULT-OF-ui/);
  const state = await s.memory.getMission('p', 'dag');
  assert.deepEqual([state.dag_state.nodes.tests.status, state.dag_state.nodes.tests.attempts], ['done', 2]);
  assert.equal(state.status, 'active', 'harness status untouched');
});

test('a failed node skips its dependents, and resume_plan after a restart only reruns what was not done', async t => {
  let failB = true;
  const calls = [];
  const caller = async (target, messages) => {
    const id = /Your task \((\w+)\)/.exec(JSON.stringify(messages))[1];
    calls.push(id);
    if (id === 'b' && failB) throw Object.assign(new Error('bad request'), {status: 400});
    return {content: `done ${id}`};
  };
  const s = await stack(t, {caller});
  const plan = {nodes: [{id: 'a', prompt: 'A'}, {id: 'b', prompt: 'B', max_attempts: 1}, {id: 'c', prompt: 'C', depends_on: ['a', 'b']}]};
  const job = await s.tool('mission_start', {project_id: 'p', mission_id: 'r', goal: 'g', plan});
  await waitFor(async () => settled((await s.tool('mission_status_job', {job_id: job.job_id})).status));
  const failed = await s.tool('mission_status_job', {job_id: job.job_id});
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.failed_nodes.map(n => [n.id, n.status]), [['b', 'failed'], ['c', 'skipped']]);
  failB = false;
  calls.length = 0;
  const again = await s.tool('mission_start', {project_id: 'p', mission_id: 'r', goal: 'g', plan, resume_plan: true});
  await waitFor(async () => settled((await s.tool('mission_status_job', {job_id: again.job_id})).status));
  assert.equal((await s.tool('mission_status_job', {job_id: again.job_id})).dag.done, 3);
  assert.deepEqual(calls.sort(), ['b', 'c'], 'node a was not repeated');
  assert.equal((await s.tool('mission_start', {goal: 'g', plan: {nodes: [{id: 'x', prompt: 'p', depends_on: ['x']}]}})).error.code, 'invalid_plan');
  await fs.access(s.stateDir);
});
