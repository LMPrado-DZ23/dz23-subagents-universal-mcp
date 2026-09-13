import fs from 'node:fs/promises';
import path from 'node:path';
import {ToolError} from './errors.js';
import {atomicJson, readTextFile, relativePath} from './fsutil.js';
import {inspectLock, lockSummary, removeStaleLock} from './locks.js';
import {readJournalTail, readJournal} from './journal.js';
import {isPlainObject} from './schema.js';

const CHECKPOINT = /^\d{6}\.json$/;

async function latestValidCheckpoint(dir) {
  let names;
  try { names = (await fs.readdir(dir)).filter(name => CHECKPOINT.test(name)).sort().reverse(); } catch { return null; }
  for (const name of names) {
    try {
      const value = JSON.parse(await readTextFile(path.join(dir, name)));
      if (isPlainObject(value)) return {name, value};
    } catch { /* try an older checkpoint */ }
  }
  return null;
}

async function temporaryFiles(dir) {
  try { return (await fs.readdir(dir)).filter(name => name.endsWith('.tmp')).length; } catch { return 0; }
}

/** Read-only scan. Never modifies the state directory. */
export async function inspectMemory(memory, {projectId} = {}) {
  const issues = [];
  const rel = file => relativePath(memory.root, file);
  const lockDirs = [memory.usageDir(), memory.providersDir()];
  const projects = projectId ? [projectId] : await memory.listProjects();
  let missionsScanned = 0;
  for (const project of projects) {
    lockDirs.push(memory.projectDir(project));
    try { await memory.getProject(project); } catch (error) {
      if (!(error instanceof ToolError)) throw error;
      issues.push({type: 'corrupt_project', project, file: rel(memory.projectFile(project)), repairable: false, detail: error.details?.kind, action: 'manual: restore project.json from a backup'});
    }
    const tmpProject = await temporaryFiles(memory.projectDir(project));
    if (tmpProject) issues.push({type: 'temporary_files', project, count: tmpProject, repairable: false, action: 'manual: inspect and remove *.tmp after confirming no writer is active'});
    for (const mission of await memory.listMissions(project)) {
      missionsScanned++;
      try { await memory.getMission(project, mission); } catch (error) {
        if (!(error instanceof ToolError)) throw error;
        const checkpoint = await latestValidCheckpoint(memory.checkpointDir(project, mission));
        issues.push({type: 'corrupt_mission_state', project, mission, file: rel(memory.missionFile(project, mission)), detail: error.details?.kind,
          repairable: Boolean(checkpoint), ...(checkpoint ? {checkpoint: checkpoint.name} : {action: 'manual: no valid checkpoint available'})});
      }
      const tail = await readJournalTail(memory.journalFile(project, mission));
      if (tail.trailingIncomplete) issues.push({type: 'journal_incomplete_line', project, mission, file: rel(memory.journalFile(project, mission)), repairable: true});
      const journal = await readJournal(memory.journalFile(project, mission), 1);
      if (journal.invalid_lines) issues.push({type: 'journal_invalid_lines', project, mission, count: journal.invalid_lines, repairable: false, action: 'informational: invalid lines are preserved and skipped'});
      const tmpMission = await temporaryFiles(memory.missionDir(project, mission));
      if (tmpMission) issues.push({type: 'temporary_files', project, mission, count: tmpMission, repairable: false, action: 'manual: inspect and remove *.tmp after confirming no writer is active'});
    }
  }
  for (const dir of lockDirs) {
    const inspection = await inspectLock(path.join(dir, '.lock'), {staleMs: memory.lockStaleMs});
    if (inspection.exists) issues.push({type: inspection.removable ? 'stale_lock' : 'lock_present', lock: rel(path.join(dir, '.lock')), repairable: inspection.removable, ...lockSummary(inspection)});
  }
  return {state_dir_exists: await fs.stat(memory.root).then(() => true, () => false), projects_scanned: projects.length, missions_scanned: missionsScanned, issues};
}

/**
 * Apply only safe repairs: remove provably orphaned locks, restore a corrupt state.json from
 * its newest valid checkpoint (the corrupt file is renamed, never deleted), and close an
 * incomplete journal line. Without `apply` it only reports the planned actions.
 */
export async function repairMemory(memory, report, {apply = false} = {}) {
  const order = {stale_lock: 0, corrupt_mission_state: 1, journal_incomplete_line: 2};
  const repairable = report.issues.filter(issue => issue.repairable).sort((a, b) => order[a.type] - order[b.type]);
  const actions = [];
  for (const issue of repairable) {
    if (!apply) { actions.push({type: issue.type, target: issue.lock || issue.file, status: 'planned'}); continue; }
    if (issue.type === 'stale_lock') {
      const lockPath = path.join(memory.root, ...issue.lock.split('/'));
      const inspection = await inspectLock(lockPath, {staleMs: memory.lockStaleMs});
      const removed = inspection.exists && inspection.removable && await removeStaleLock(lockPath, inspection);
      actions.push({type: issue.type, target: issue.lock, status: removed ? 'removed' : 'skipped', reason: inspection.reason});
    } else if (issue.type === 'corrupt_mission_state') {
      const restored = await memory.withLock(issue.project, async () => {
        const checkpoint = await latestValidCheckpoint(memory.checkpointDir(issue.project, issue.mission));
        if (!checkpoint) return null;
        const file = memory.missionFile(issue.project, issue.mission);
        const preserved = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
        await fs.rename(file, preserved);
        await atomicJson(file, {...checkpoint.value, restored_from_checkpoint: checkpoint.name, restored_at: new Date().toISOString()});
        return {checkpoint: checkpoint.name, preserved: relativePath(memory.root, preserved)};
      });
      if (restored) await memory.appendEvent(issue.project, issue.mission, 'memory_restored', {reason: 'corrupt_state', checkpoint: restored.checkpoint});
      actions.push({type: issue.type, target: issue.file, status: restored ? 'restored' : 'skipped', ...(restored || {})});
    } else if (issue.type === 'journal_incomplete_line') {
      await memory.appendEvent(issue.project, issue.mission, 'memory_repair_checked', {reason: 'journal_incomplete_line'});
      actions.push({type: issue.type, target: issue.file, status: 'closed'});
    }
  }
  return {applied: apply, actions, unrepairable: report.issues.filter(issue => !issue.repairable)};
}
