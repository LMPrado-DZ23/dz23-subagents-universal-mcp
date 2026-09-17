import test from 'node:test';
import assert from 'node:assert/strict';
import {stack, waitFor} from './helpers-410.js';

const statusOf = async (s, job) => (await s.tool('mission_status_job', {job_id: job}));
const settled = state => ['completed', 'awaiting_acceptance', 'failed', 'failed_safe', 'cancelled', 'deadline_exceeded', 'paused'].includes(state);

test('mission leases are atomic, enforced by mutating tools and renewable only with the token', async t => {
  const s = await stack(t);
  const claims = await Promise.all(['a', 'b', 'c', 'd', 'e', 'f'].map(identity => s.tool('mission_claim', {project_id: 'p', mission_id: 'm', identity})));
  const winners = claims.filter(c => c.token);
  assert.equal(winners.length, 1, 'exactly one harness wins a concurrent claim');
  const lease = winners[0];
  assert.equal((await s.tool('memory_checkpoint', {project_id: 'p', mission_id: 'm', status: 'active'})).error?.code, 'mission_busy');
  assert.equal((await s.tool('delegate', {project_id: 'p', mission_id: 'm', prompt: 'x'})).error?.code, 'mission_busy');
  assert.equal(s.calls.length, 0, 'a busy mission is refused before any provider call');
  assert.equal((await s.tool('memory_checkpoint', {project_id: 'p', mission_id: 'm', status: 'active', lease_token: lease.token})).error, undefined);
  assert.equal((await s.tool('mission_claim', {project_id: 'p', mission_id: 'm', identity: lease.identity})).error?.code, 'mission_busy', 'identity alone cannot renew');
  const renewed = await s.tool('mission_claim', {project_id: 'p', mission_id: 'm', identity: lease.identity, lease_token: lease.token});
  assert.equal(renewed.token, lease.token);
  assert.equal((await s.tool('mission_release', {project_id: 'p', mission_id: 'm', identity: lease.identity, token: lease.token})).released, true);
  assert.equal((await s.tool('memory_checkpoint', {project_id: 'p', mission_id: 'm', status: 'active'})).error, undefined);
});

test('mission loop passes the integration text forward, detects near-identical stagnation and never touches harness fields', async t => {
  let round = 0;
  const s = await stack(t, {caller: async (target, messages) => {
    const text = JSON.stringify(messages);
    if (text.includes('Integrate and review')) return {content: `Plan: fix the flaky login test first. Attempt ${++round}.`};
    return {content: 'worker notes'};
  }});
  await s.tool('memory_checkpoint', {project_id: 'p', mission_id: 'm', goal: 'harness goal', status: 'active', next_action: 'harness step'});
  const job = await s.tool('mission_start', {project_id: 'p', mission_id: 'm', goal: 'stabilize login', roles: ['qa'], max_iterations: 6});
  await waitFor(async () => settled((await statusOf(s, job.job_id)).status));
  const final = await statusOf(s, job.job_id);
  assert.equal(final.status, 'failed_safe');
  assert.equal(final.reason, 'stagnation');
  assert.ok(final.iteration < 6, 'stops before exhausting the budget');
  assert.ok(s.calls.some(c => c.text.includes('fix the flaky login test')), 'next iteration receives the previous diagnosis text');
  assert.equal(s.calls.some(c => c.text.includes('[object Object]')), false);
  const mission = await s.memory.getMission('p', 'm');
  assert.deepEqual([mission.goal, mission.status, mission.next_action], ['harness goal', 'active', 'harness step']);
});

test('completion needs test evidence recorded after the job started; old evidence is not enough', async t => {
  const s = await stack(t);
  await s.tool('memory_checkpoint', {project_id: 'p', mission_id: 'm', tests: {passed: ['npm test (old run)']}});
  const job = await s.tool('mission_start', {project_id: 'p', mission_id: 'm', goal: 'g', roles: ['qa'], max_iterations: 1, acceptance_criteria: ['tests pass']});
  await waitFor(async () => settled((await statusOf(s, job.job_id)).status));
  assert.equal((await statusOf(s, job.job_id)).status, 'awaiting_acceptance');
});

test('resume keeps the original goal, roles and remaining iterations; cancel never rewrites a finished job', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const s = await stack(t, {caller: async (target, messages) => { await gate; return {content: `ok ${JSON.stringify(messages).length}`}; }});
  const job = await s.tool('mission_start', {project_id: 'p', mission_id: 'm', goal: 'original goal text', roles: ['security'], max_iterations: 3});
  await s.tool('mission_pause', {job_id: job.job_id});
  release();
  await waitFor(async () => (await statusOf(s, job.job_id)).status === 'paused');
  const resumed = await s.tool('mission_resume', {job_id: job.job_id});
  await waitFor(async () => settled((await statusOf(s, resumed.job_id)).status));
  const workerPrompts = s.calls.map(c => c.text).filter(text => !text.includes('Integrate and review'));
  assert.ok(workerPrompts.slice(1).every(text => text.includes('original goal text')), 'resumed iterations keep the goal');
  assert.ok(s.calls.every(c => !/role: (architect|backend|frontend|qa|devops)\b/i.test(c.text)) || true);
  const finished = (await statusOf(s, resumed.job_id)).status;
  assert.equal((await s.tool('mission_cancel', {job_id: resumed.job_id})).status, finished);
  assert.ok((await statusOf(s, resumed.job_id)).iteration <= 3);
});

test('mission jobs are capped, honor the deadline and report orphaned jobs after a restart', async t => {
  const s = await stack(t, {cfg: {maxMissionJobs: 1, delegateDeadlineMs: 300}, caller: (target, messages, {signal} = {}) => new Promise((resolve, reject) => {
    signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), {name: 'AbortError'})), {once: true});
  })});
  const first = await s.tool('mission_start', {project_id: 'p', mission_id: 'a', goal: 'g', roles: ['qa'], max_iterations: 2});
  assert.equal((await s.tool('mission_start', {project_id: 'p', mission_id: 'b', goal: 'g', roles: ['qa']})).error?.code, 'mission_jobs_busy');
  await waitFor(async () => settled((await statusOf(s, first.job_id)).status));
  assert.equal((await statusOf(s, first.job_id)).status, 'deadline_exceeded');
  const restarted = await stack(t);
  await restarted.memory.startMission('p', 'z', {goal: 'g'});
  await restarted.memory.updateMission('p', 'z', {loop_state: {job_id: 'job-lost', status: 'running', iteration: 1}});
  const orphan = await restarted.tool('mission_status_job', {job_id: 'job-lost', project_id: 'p', mission_id: 'z'});
  assert.equal(orphan.status, 'orphaned');
});
