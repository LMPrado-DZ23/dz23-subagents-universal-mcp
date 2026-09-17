import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {ToolError} from './errors.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
function safe(value) { if (!ID.test(value || '')) throw new ToolError('invalid_request', 'invalid project or mission id'); return value; }
function leaseFile(root, project, mission) { return path.join(root, 'leases', safe(project), `${safe(mission)}.json`); }

export async function claimMission(cfg, {project_id, mission_id, identity, lease_ms = 300000}) {
  const file = leaseFile(cfg.stateDir, project_id, mission_id);
  await fs.mkdir(path.dirname(file), {recursive:true});
  const existing = await fs.readFile(file, 'utf8').then(JSON.parse).catch(() => null);
  if (existing && Date.parse(existing.expires_at) > Date.now() && existing.identity !== identity) throw new ToolError('mission_busy', 'mission is claimed by another harness', {expires_at:existing.expires_at});
  const token = crypto.randomUUID();
  const record = {project_id, mission_id, identity:identity || 'unknown', token, claimed_at:new Date().toISOString(), expires_at:new Date(Date.now() + Math.min(Math.max(lease_ms, 1000), 3_600_000)).toISOString()};
  await fs.writeFile(file, JSON.stringify(record), {flag:'w'});
  return record;
}

export async function releaseMission(cfg, {project_id, mission_id, identity, token}) {
  const file = leaseFile(cfg.stateDir, project_id, mission_id);
  const existing = await fs.readFile(file, 'utf8').then(JSON.parse).catch(() => null);
  if (!existing) return {released:false};
  if (existing.identity !== identity || existing.token !== token) throw new ToolError('mission_lease_denied', 'only the lease holder can release the mission');
  await fs.rm(file, {force:true});
  return {released:true, project_id, mission_id};
}

export async function exportHandoff(memory, {project_id, mission_id}) {
  const state = await memory.getMission(project_id, mission_id);
  if (!state) throw new ToolError('mission_not_found', 'mission was not found');
  return `# Mission handoff\n\n- Project: ${project_id}\n- Mission: ${mission_id}\n- Goal: ${String(state.goal || '').slice(0, 4000)}\n- Status: ${state.status}\n- Loop state: ${JSON.stringify(state.loop_state || {})}\n\n## Decisions\n${(state.decisions || []).map(x=>`- ${x}`).join('\n')}\n\n## Tests\n- Passed: ${(state.tests?.passed || []).join('; ')}\n- Failed: ${(state.tests?.failed || []).join('; ')}\n\n## Next tasks\n${(state.next_tasks || []).map(x=>`- ${x}`).join('\n')}\n\n## Risks and blockers\n${(state.blocked_tasks || []).map(x=>`- ${x}`).join('\n')}`;
}
