import fs from 'node:fs/promises';
import path from 'node:path';
import {ToolError} from './errors.js';
import {addUsage} from './usage.js';
import {SCHEMA_VERSIONS} from './constants.js';
import {atomicJson, readJson, readTextFile, appendBoundedLine, relativePath, MISSING} from './fsutil.js';
import {KeyedMutex, withDirLock} from './locks.js';
import {appendJournalEvent, readJournal} from './journal.js';
import {newProject, newMission, migrateProject, migrateMission} from './memory-schema.js';
import {buildContext} from './context.js';
import {isPlainObject} from './schema.js';
import {nullLogger} from './logger.js';

const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/;
const CHECKPOINT_LISTS = ['acceptance_criteria', 'decisions', 'invariants', 'completed_tasks', 'active_tasks', 'blocked_tasks', 'next_tasks', 'known_failures', 'files_read', 'files_changed', 'artifacts'];
const CHECKPOINT_SCALARS = ['next_action', 'status', 'summary', 'goal'];

function safe(value) {
  if (typeof value !== 'string' || !ID.test(value)) {
    throw new Error('Invalid memory identifier: use 1-120 letters, digits, dots, underscores or hyphens; start with a letter or digit');
  }
  return value;
}

export const DEFAULT_MAX_LIST_ITEMS = 500;

/** Merge a checkpoint list (dedupe on append). Capping happens in mergeCheckpointFields. */
function mergeList(current, incoming, merge) {
  if (merge === 'replace') return [...incoming];
  const out = [...(Array.isArray(current) ? current : [])];
  const seen = new Set(out.map(item => JSON.stringify(item)));
  for (const item of incoming) {
    const key = JSON.stringify(item);
    if (!seen.has(key)) { seen.add(key); out.push(item); }
  }
  return out;
}

/**
 * Only provided fields change; an omitted status keeps the current status. Lists keep the newest
 * `maxItems`; how many items each list dropped is written to `truncated` (reported, not persisted).
 */
export function mergeCheckpointFields(state, fields, merge = 'append', maxItems = DEFAULT_MAX_LIST_ITEMS, truncated = {}) {
  const capped = (name, list) => {
    if (list.length > maxItems) truncated[name] = list.length - maxItems;
    return list.slice(-maxItems);
  };
  const patch = {};
  for (const key of CHECKPOINT_SCALARS) if (fields[key] !== undefined) patch[key] = fields[key];
  for (const key of CHECKPOINT_LISTS) if (fields[key] !== undefined) patch[key] = capped(key, mergeList(state?.[key], fields[key], merge));
  if (fields.tests) {
    const current = state?.tests || {};
    patch.tests = {...current};
    for (const key of ['passed', 'failed', 'pending']) if (fields.tests[key]) patch.tests[key] = capped(`tests.${key}`, mergeList(current[key], fields.tests[key], merge));
  }
  return patch;
}

async function listIds(dir) {
  try {
    return (await fs.readdir(dir, {withFileTypes: true})).filter(entry => entry.isDirectory() && ID.test(entry.name)).map(entry => entry.name).sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * Filesystem mission memory. Layout under the state root:
 * projects/<project>/project.json, projects/<project>/missions/<mission>/{state.json,journal.jsonl,usage.jsonl,checkpoints/},
 * usage/daily/<YYYY-MM-DD>.json and providers/status.json.
 */
export class ProjectMemory {
  constructor(root, options = {}) {
    this.root = root;
    this.maxStoredOutputChars = options.maxStoredOutputChars || 12_000;
    this.maxAgentOutputs = options.maxAgentOutputs || 16;
    this.maxJournalBytes = options.maxJournalBytes || 1024 * 1024;
    this.maxEventBytes = Math.max(4096, Math.min(65_536, Math.floor(this.maxJournalBytes / 4)));
    this.maxCheckpoints = options.maxCheckpoints || 8;
    this.lockTimeoutMs = options.lockTimeoutMs || 20_000;
    this.lockStaleMs = options.lockStaleMs || 30_000;
    this.durable = options.durableWrites !== false;
    this.maxStateBytes = options.maxStateBytes || 4 * 1024 * 1024;
    this.maxListItems = options.maxListItems || DEFAULT_MAX_LIST_ITEMS;
    this.logger = options.logger || nullLogger;
    this.local = new KeyedMutex();
    this.knownIds = new Map();
  }

  projectDir(projectId) { return path.join(this.root, 'projects', safe(projectId)); }
  missionDir(projectId, missionId) { return path.join(this.projectDir(projectId), 'missions', safe(missionId)); }
  projectFile(projectId) { return path.join(this.projectDir(projectId), 'project.json'); }
  missionFile(projectId, missionId) { return path.join(this.missionDir(projectId, missionId), 'state.json'); }
  journalFile(projectId, missionId) { return path.join(this.missionDir(projectId, missionId), 'journal.jsonl'); }
  checkpointDir(projectId, missionId) { return path.join(this.missionDir(projectId, missionId), 'checkpoints'); }
  usageDir() { return path.join(this.root, 'usage', 'daily'); }
  providersDir() { return path.join(this.root, 'providers'); }

  /** Process-local serialization plus the cross-process directory lock. */
  lockAt(dir, fn) {
    return this.local.run(dir, () => withDirLock(dir, fn, {timeoutMs: this.lockTimeoutMs, staleMs: this.lockStaleMs,
      onRecovered: inspection => this.logger.warn('memory_lock_recovered', {lock: path.basename(dir), reason: inspection.reason, owner_pid: inspection.owner?.pid, age_ms: inspection.age_ms})}));
  }

  withLock(projectId, fn) { return this.lockAt(this.projectDir(projectId), fn); }
  readLocked(dir, fn) { return this.local.run(dir, fn); }
  write(file, value) { return atomicJson(file, value, {durable: this.durable}); }

  async readRecord(file, migrate) {
    const value = await readJson(file, MISSING, {root: this.root});
    if (value === MISSING) return null;
    if (!isPlainObject(value)) throw new ToolError('memory_integrity', 'Memory record has an invalid shape; run memory repair', {kind: 'corrupt_shape', file: relativePath(this.root, file)});
    return migrate(value);
  }

  /** Case-insensitive filesystems would silently alias ids that differ only by case. */
  async assertNoCaseCollision(dir, id) {
    if (!await this.isCaseInsensitive()) return;
    // On a case-insensitive filesystem an exact directory name rules out any alias, so only ids not seen yet
    // pay for a directory listing.
    if (this.knownIds.get(dir)?.has(id)) return;
    const names = await listIds(dir);
    const clash = names.find(name => name !== id && name.toLowerCase() === id.toLowerCase());
    if (clash) throw new ToolError('invalid_request', 'Identifier differs from an existing one only by letter case; reuse the existing identifier with its original letter case');
    if (!this.knownIds.has(dir) && this.knownIds.size >= 1024) this.knownIds.delete(this.knownIds.keys().next().value);
    this.knownIds.set(dir, new Set(names));
  }

  /**
   * Case aliasing only exists on case-insensitive filesystems (Windows, macOS). On case-sensitive ones
   * (Linux) `Foo` and `foo` are distinct records and stay reachable. Probed once, after the state root exists.
   */
  async isCaseInsensitive() {
    if (this.caseProbe) return this.caseProbe;
    try { await fs.access(this.root); } catch { return false; }
    this.caseProbe = (async () => {
      const name = `.case-probe-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const file = path.join(this.root, name);
      await fs.writeFile(file, '');
      try {
        await fs.stat(path.join(this.root, name.toUpperCase()));
        return true;
      } catch {
        return false;
      } finally {
        await fs.rm(file, {force: true});
      }
    })().catch(() => true);
    return this.caseProbe;
  }

  /** Checked on every read and write, not only on creation: lookups would otherwise alias silently. */
  async checkIds(projectId, missionId) {
    await this.assertNoCaseCollision(path.join(this.root, 'projects'), projectId);
    if (missionId !== undefined) await this.assertNoCaseCollision(path.join(this.projectDir(projectId), 'missions'), missionId);
  }

  async initProject(projectId, data = {}) {
    return this.withLock(projectId, async () => {
      await this.assertNoCaseCollision(path.join(this.root, 'projects'), projectId);
      const now = new Date().toISOString();
      const project = (await this.readRecord(this.projectFile(projectId), migrateProject)) || newProject(projectId, now);
      const next = {...project, ...data, updated_at: now};
      await this.write(this.projectFile(projectId), next);
      return next;
    });
  }

  async getProject(projectId) {
    await this.checkIds(projectId);
    return this.readLocked(this.projectDir(projectId), () => this.readRecord(this.projectFile(projectId), migrateProject));
  }

  async startMission(projectId, missionId, data = {}) {
    await this.initProject(projectId);
    return this.withLock(projectId, async () => {
      await this.assertNoCaseCollision(path.join(this.projectDir(projectId), 'missions'), missionId);
      const now = new Date().toISOString();
      const existing = await this.readRecord(this.missionFile(projectId, missionId), migrateMission);
      // Creation data never overwrites a mission another caller created in the meantime.
      if (existing) return existing;
      const next = {...newMission(projectId, missionId, now), ...data, updated_at: now};
      await this.write(this.missionFile(projectId, missionId), next);
      return next;
    });
  }

  async getMission(projectId, missionId) {
    await this.checkIds(projectId, missionId);
    return this.readLocked(this.projectDir(projectId), () => this.readRecord(this.missionFile(projectId, missionId), migrateMission));
  }

  async mutateMission(projectId, missionId, mutate) {
    await this.checkIds(projectId, missionId);
    return this.withLock(projectId, async () => {
      const current = await this.readRecord(this.missionFile(projectId, missionId), migrateMission);
      if (!current) throw new ToolError('mission_not_found', 'Mission not found');
      const next = mutate(current);
      await this.write(this.missionFile(projectId, missionId), next);
      return next;
    });
  }

  updateMission(projectId, missionId, patch = {}) {
    return this.mutateMission(projectId, missionId, current => ({...current, ...patch, sequence: (current.sequence || 0) + 1, updated_at: new Date().toISOString()}));
  }

  recordAgentResult(projectId, missionId, agent, output) {
    return this.mutateMission(projectId, missionId, current => {
      const content = String(output ?? '').slice(0, this.maxStoredOutputChars);
      const at = new Date().toISOString();
      return {
        ...current, sequence: (current.sequence || 0) + 1, updated_at: at,
        agents: [...(current.agents || []), {schema: SCHEMA_VERSIONS.agent, ...agent}].slice(-this.maxAgentOutputs * 2),
        agent_outputs: [...(current.agent_outputs || []), {schema: SCHEMA_VERSIONS.agent, agent_id: agent.id, role: agent.role, provider: agent.provider, model: agent.model, content, at}].slice(-this.maxAgentOutputs),
        last_output: content, last_provider: agent.provider, last_model: agent.model
      };
    });
  }

  async appendEvent(projectId, missionId, type, payload = {}) {
    await this.checkIds(projectId, missionId);
    return this.withLock(projectId, async () => {
      const {event, recovered} = await appendJournalEvent(this.journalFile(projectId, missionId), type, payload,
        {maxJournalBytes: this.maxJournalBytes, maxEventBytes: this.maxEventBytes, durable: this.durable});
      if (recovered) this.logger.warn('journal_recovered', {project_id: projectId, mission_id: missionId, reason: 'incomplete_trailing_line'});
      return event;
    });
  }

  async checkpoint(projectId, missionId, extra = {}) {
    await this.checkIds(projectId, missionId);
    return this.withLock(projectId, async () => {
      const state = await this.readRecord(this.missionFile(projectId, missionId), migrateMission);
      if (!state) throw new ToolError('mission_not_found', 'Mission not found');
      const sequence = (state.sequence || 0) + 1;
      // A function patch is computed from the state read under this lock (no lost concurrent appends).
      const patch = typeof extra === 'function' ? extra(state) : extra;
      const snapshot = {...state, ...patch, sequence, checkpoint_at: new Date().toISOString(), checkpoint_schema: SCHEMA_VERSIONS.checkpoint};
      const bytes = Buffer.byteLength(JSON.stringify(snapshot));
      if (bytes > this.maxStateBytes) throw new ToolError('memory_limit_exceeded', 'Mission state would exceed DZ23_MAX_STATE_BYTES', {bytes, max_bytes: this.maxStateBytes});
      const dir = this.checkpointDir(projectId, missionId);
      await this.write(path.join(dir, `${String(sequence).padStart(6, '0')}.json`), snapshot);
      await this.write(this.missionFile(projectId, missionId), snapshot);
      const files = (await fs.readdir(dir)).filter(name => /^\d{6}\.json$/.test(name)).sort();
      await Promise.all(files.slice(0, -this.maxCheckpoints).map(name => fs.rm(path.join(dir, name), {force: true})));
      return snapshot;
    });
  }

  /** Structured checkpoint from a harness. Creates the mission when absent. */
  async recordCheckpoint(projectId, missionId, fields = {}, {merge = 'append'} = {}) {
    if (!await this.getMission(projectId, missionId)) await this.startMission(projectId, missionId, {goal: fields.goal || ''});
    const truncated = {};
    const snapshot = await this.checkpoint(projectId, missionId, state => mergeCheckpointFields(state, fields, merge, this.maxListItems, truncated));
    return Object.keys(truncated).length ? {...snapshot, truncated_lists: truncated} : snapshot;
  }

  /** Tool handoff after a paid provider call: a state-size cap is logged, never raised. */
  async recordHandoff(projectId, missionId, handoff) {
    try {
      await this.checkpoint(projectId, missionId, {last_tool_handoff: handoff});
      return true;
    } catch (error) {
      if (error?.code !== 'memory_limit_exceeded') throw error;
      this.logger.warn('handoff_checkpoint_skipped', {project_id: projectId, mission_id: missionId, reason: error.code});
      return false;
    }
  }

  /** Refuse new work on a mission whose state already reached DZ23_MAX_STATE_BYTES, before any paid call. */
  async assertHeadroom(projectId, missionId) {
    await this.checkIds(projectId, missionId);
    const stat = await fs.stat(this.missionFile(projectId, missionId)).catch(() => null);
    if (stat && stat.size >= this.maxStateBytes) {
      throw new ToolError('memory_limit_exceeded', 'Mission state reached DZ23_MAX_STATE_BYTES; continue in a new mission', {bytes: stat.size, max_bytes: this.maxStateBytes});
    }
  }

  async readJournal(projectId, missionId, limit = 50) {
    await this.checkIds(projectId, missionId);
    return this.readLocked(this.projectDir(projectId), () => readJournal(this.journalFile(projectId, missionId), limit));
  }

  async recentEvents(projectId, missionId, limit = 50) {
    return (await this.readJournal(projectId, missionId, limit)).events;
  }

  async contextBundleDetailed(projectId, missionId, maxChars = 120_000, {exclude = []} = {}) {
    const [project, mission, journal] = await Promise.all([this.getProject(projectId), this.getMission(projectId, missionId), this.readJournal(projectId, missionId, 30)]);
    return buildContext({project, mission, events: journal.events, maxChars, exclude});
  }

  async contextBundle(projectId, missionId, maxChars = 120_000) {
    return (await this.contextBundleDetailed(projectId, missionId, maxChars)).text;
  }

  getDailyUsage(day) {
    return this.readLocked(this.usageDir(), () => readJson(path.join(this.usageDir(), `${day}.json`), null, {root: this.root}));
  }

  /** Per-call usage: mission totals, bounded usage.jsonl, project totals and the shared daily file. */
  async recordUsage(projectId, missionId, record) {
    await this.checkIds(projectId, missionId);
    await this.withLock(projectId, async () => {
      const file = this.missionFile(projectId, missionId);
      const mission = await this.readRecord(file, migrateMission);
      if (!mission) throw new ToolError('mission_not_found', 'Mission not found');
      await this.write(file, {...mission, usage: addUsage(mission.usage, record), updated_at: new Date().toISOString()});
      await appendBoundedLine(path.join(this.missionDir(projectId, missionId), 'usage.jsonl'), JSON.stringify(record), this.maxJournalBytes, {durable: this.durable});
      const project = await this.readRecord(this.projectFile(projectId), migrateProject);
      if (project) await this.write(this.projectFile(projectId), {...project, usage_totals: addUsage(project.usage_totals, record)});
    });
    return this.recordSystemUsage(record);
  }

  recordSystemUsage(record) {
    const dir = this.usageDir();
    const day = record.at.slice(0, 10);
    return this.lockAt(dir, async () => {
      const file = path.join(dir, `${day}.json`);
      const next = {...addUsage(await readJson(file, null, {root: this.root}), record), schema: SCHEMA_VERSIONS.usage, day};
      await this.write(file, next);
      return next;
    });
  }

  async usageRecords(projectId, missionId, limit = 100) {
    const text = await readTextFile(path.join(this.missionDir(projectId, missionId), 'usage.jsonl'));
    if (!text) return [];
    return text.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }).slice(-limit);
  }

  getProviderStatus() {
    const dir = this.providersDir();
    return this.readLocked(dir, () => readJson(path.join(dir, 'status.json'), {schema: 1, providers: {}}, {root: this.root}));
  }

  /** Replace one provider's persisted catalog/verification status with update(previous). */
  updateProviderStatus(provider, update) {
    const dir = this.providersDir();
    return this.lockAt(dir, async () => {
      const file = path.join(dir, 'status.json');
      const current = await readJson(file, {schema: 1, providers: {}}, {root: this.root});
      const providers = {...(current.providers || {})};
      const next = update(Object.hasOwn(providers, provider) ? providers[provider] : {});
      Object.defineProperty(providers, provider, {value: next, enumerable: true, writable: true, configurable: true});
      await this.write(file, {schema: 1, updated_at: new Date().toISOString(), providers});
      return next;
    });
  }

  listProjects() { return listIds(path.join(this.root, 'projects')); }
  listMissions(projectId) { return listIds(path.join(this.projectDir(projectId), 'missions')); }
}
