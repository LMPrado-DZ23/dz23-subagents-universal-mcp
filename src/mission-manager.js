import crypto from 'node:crypto';
import {ToolError} from './errors.js';

const jobs = new Map();
const now = () => new Date().toISOString();
const jobId = () => `job-${crypto.randomUUID()}`;

function get(id) {
  const job = jobs.get(id);
  if (!job) throw new ToolError('job_not_found', 'Mission job was not found');
  return job;
}

async function execute(job, {router, memory, goal, project_id, mission_id, max_iterations = 3, roles, routing_strategy = 'first', acceptance_criteria, signal}) {
  const fingerprints = [];
  await memory.startMission(project_id, mission_id, {goal, ...(acceptance_criteria ? {acceptance_criteria} : {}), loop_state:{job_id:job.id, status:'running', iteration:0, started_at:now()}});
  for (let iteration = 1; iteration <= max_iterations; iteration++) {
    if (job.controller.signal.aborted || signal?.aborted) throw new ToolError('cancelled', 'Mission job was cancelled');
    job.state = 'running';
    job.iteration = iteration;
    await memory.updateMission(project_id, mission_id, {loop_state:{job_id:job.id, status:'running', iteration, strategy:routing_strategy, previous_diagnosis:job.previous_diagnosis || null}});
    const previous = job.previous_diagnosis ? `\nPrevious diagnostic (untrusted evidence):\n${job.previous_diagnosis}` : '';
    const result = await router.swarmRun({project_id, mission_id, goal:`${goal}${previous}`, roles, routing_strategy, max_agents:roles?.length || 3, response_mode:'summary', signal:job.controller.signal});
    const fingerprint = JSON.stringify({integration:result.integration, workers:result.workers?.map(x=>({role:x.role,ok:x.ok,excerpt:x.excerpt}))});
    fingerprints.push(fingerprint);
    const repeated = fingerprints.length >= 2 && fingerprints.at(-1) === fingerprints.at(-2);
    job.previous_diagnosis = String(result.integration || '').slice(0, 12000);
    await memory.appendEvent(project_id, mission_id, 'mission_loop_iteration', {job_id:job.id, iteration, repeated, strategy:routing_strategy});
    await memory.updateMission(project_id, mission_id, {loop_state:{job_id:job.id, status:'iteration_completed', iteration, repeated, strategy:routing_strategy, previous_diagnosis:job.previous_diagnosis}});
    if (repeated && fingerprints.length >= 3) {
      job.state = 'failed_safe';
      await memory.updateMission(project_id, mission_id, {loop_state:{job_id:job.id, status:'failed_safe', reason:'stagnation', iteration}});
      return {status:'failed_safe', reason:'stagnation', iteration};
    }
    if (repeated) routing_strategy = routing_strategy === 'first' ? 'provider_diversity' : 'round_robin';
    if (job.pauseRequested) { job.state='paused'; await memory.updateMission(project_id, mission_id, {loop_state:{job_id:job.id, status:'paused', iteration}}); return {status:'paused', iteration}; }
  }
  const finalState = await memory.getMission(project_id, mission_id);
  const evidence = finalState?.tests?.passed?.length > 0 && (!finalState.tests.failed || finalState.tests.failed.length === 0);
  job.state = evidence ? 'completed' : 'awaiting_acceptance';
  await memory.updateMission(project_id, mission_id, {loop_state:{job_id:job.id, status:job.state, iteration:max_iterations, completed_at:evidence ? now() : undefined, evidence:evidence ? 'harness tests/checkpoint recorded' : 'objective harness evidence required before completion'}});
  return {status:job.state, iterations:max_iterations, evidence_required:!evidence};
}

export function missionStart(deps, args = {}) {
  const id = jobId();
  const job = {id, project_id:args.project_id || 'default', mission_id:args.mission_id || crypto.randomUUID(), state:'queued', iteration:0, controller:new AbortController(), pauseRequested:false};
  jobs.set(id, job);
  const deadline = setTimeout(() => job.controller.abort(new DOMException('Deadline exceeded', 'TimeoutError')), deps.router?.cfg?.delegateDeadlineMs || 600000);
  deadline.unref?.();
  execute(job, {...deps, ...args, signal:job.controller.signal}).finally(() => clearTimeout(deadline)).catch(async error => {
    job.state = error.code === 'cancelled' ? 'cancelled' : 'failed';
    await deps.memory.updateMission(job.project_id, job.mission_id, {loop_state:{job_id:id, status:job.state, reason:error.code || 'internal_error', finished_at:now()}}).catch(() => undefined);
  });
  return {job_id:id, project_id:job.project_id, mission_id:job.mission_id, status:'queued'};
}

export function missionStatus(id) {
  const job = get(id);
  return {job_id:job.id, project_id:job.project_id, mission_id:job.mission_id, status:job.state, iteration:job.iteration};
}

export function missionPause(id) {
  const job = get(id);
  if (job.state === 'running' || job.state === 'queued') job.pauseRequested = true;
  return missionStatus(id);
}

export function missionCancel(id) {
  const job = get(id);
  if (!['completed','failed','failed_safe','cancelled'].includes(job.state)) job.controller.abort(new DOMException('Cancelled', 'AbortError'));
  job.state = 'cancelled';
  return missionStatus(id);
}

export function missionResume(deps, id) {
  const old = get(id);
  if (old.state !== 'paused') throw new ToolError('job_not_paused', 'Mission job is not paused');
  return missionStart(deps, {project_id:old.project_id, mission_id:old.mission_id, goal:old.previous_diagnosis || 'Resume mission from persisted loop_state', max_iterations:3});
}
