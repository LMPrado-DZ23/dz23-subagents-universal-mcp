import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {ToolError} from './errors.js';
import {withDirLock} from './locks.js';
import {ID_PATTERN} from './constants.js';

// Leases coordinate cooperating harnesses; they are not authentication. The token proves who
// claimed the lease, so only the holder renews or releases it and passes it to mutating tools.
const ID = new RegExp(ID_PATTERN);
const safe = value => { if (!ID.test(value || '')) throw new ToolError('invalid_request', 'invalid project or mission id'); return value; };
const leaseDir = (root, project) => path.join(root, 'leases', safe(project));
const leaseFile = (root, project, mission) => path.join(leaseDir(root, project), `${safe(mission)}.json`);
const live = lease => lease && Date.parse(lease.expires_at) > Date.now();

async function readLease(file) {
  return fs.readFile(file, 'utf8').then(JSON.parse).catch(() => null);
}

async function writeAtomic(file, value) {
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value));
  await fs.rename(tmp, file);
}

export async function activeLease(cfg, project_id, mission_id) {
  const lease = await readLease(leaseFile(cfg.stateDir, project_id, mission_id));
  return live(lease) ? lease : null;
}

/** Throws mission_busy when another holder has a live lease and the caller did not present its token. */
export async function assertLease(cfg, {project_id = 'default', mission_id, lease_token} = {}) {
  if (!cfg?.stateDir || !mission_id) return;
  const lease = await activeLease(cfg, project_id, mission_id);
  if (lease && lease.token !== lease_token) throw new ToolError('mission_busy', 'mission is claimed by another harness', {identity: lease.identity, expires_at: lease.expires_at});
}

export async function claimMission(cfg, {project_id, mission_id, identity, lease_ms = 300000, lease_token}) {
  const dir = leaseDir(cfg.stateDir, project_id);
  const file = leaseFile(cfg.stateDir, project_id, mission_id);
  await fs.mkdir(dir, {recursive: true});
  return withDirLock(dir, async () => {
    const existing = await readLease(file);
    const renewing = live(existing) && lease_token && existing.token === lease_token;
    if (live(existing) && !renewing) throw new ToolError('mission_busy', 'mission is claimed by another harness', {identity: existing.identity, expires_at: existing.expires_at});
    const now = Date.now();
    const record = {project_id, mission_id, identity: identity || 'unknown', token: renewing ? existing.token : crypto.randomUUID(),
      claimed_at: renewing ? existing.claimed_at : new Date(now).toISOString(), expires_at: new Date(now + Math.min(Math.max(lease_ms, 1000), 3_600_000)).toISOString()};
    await writeAtomic(file, record);
    return record;
  }, {timeoutMs: 10_000});
}

export async function releaseMission(cfg, {project_id, mission_id, token}) {
  const dir = leaseDir(cfg.stateDir, project_id);
  const file = leaseFile(cfg.stateDir, project_id, mission_id);
  await fs.mkdir(dir, {recursive: true});
  return withDirLock(dir, async () => {
    const existing = await readLease(file);
    if (!existing) return {released: false, project_id, mission_id};
    if (existing.token !== token) throw new ToolError('mission_lease_denied', 'only the lease holder can release the mission');
    await fs.rm(file, {force: true});
    return {released: true, project_id, mission_id};
  }, {timeoutMs: 10_000});
}

const bullets = items => (items?.length ? items.map(x => `- ${typeof x === 'string' ? x : JSON.stringify(x)}`).join('\n') : '- none');

export async function exportHandoff(memory, {project_id, mission_id}) {
  const state = await memory.getMission(project_id, mission_id);
  if (!state) throw new ToolError('mission_not_found', 'mission was not found');
  const markdown = [
    '# Mission handoff', '', `- Project: ${project_id}`, `- Mission: ${mission_id}`, `- Goal: ${String(state.goal || '').slice(0, 4000)}`,
    `- Status: ${state.status}`, `- Next action: ${String(state.next_action || '').slice(0, 2000)}`, `- Loop state: ${JSON.stringify(state.loop_state || {})}`,
    '', '## Acceptance criteria', bullets(state.acceptance_criteria), '', '## Decisions', bullets(state.decisions),
    '', '## Tests', `- Passed: ${(state.tests?.passed || []).join('; ') || 'none'}`, `- Failed: ${(state.tests?.failed || []).join('; ') || 'none'}`,
    '', '## Next tasks', bullets(state.next_tasks), '', '## Blocked', bullets(state.blocked_tasks), '', '## Known failures', bullets(state.known_failures)
  ].join('\n');
  return {project_id, mission_id, markdown};
}
