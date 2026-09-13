import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {SCHEMA_VERSIONS} from './constants.js';
import {ToolError} from './errors.js';
import {sleep, ensureDir} from './fsutil.js';

const TRANSIENT = new Set(['EEXIST', 'EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES']);
const PROCESS_STARTED_AT = new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString();
export const OWNER_FILE = 'owner.json';

/**
 * In-process serialization per key. Readers and writers of one process never overlap, so
 * Windows cannot refuse a rename because this process holds the same file open.
 * Not reentrant: code inside a locked section must not take the same key again.
 */
export class KeyedMutex {
  constructor() { this.tails = new Map(); }
  async run(key, fn) {
    const previous = this.tails.get(key) || Promise.resolve();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const tail = previous.then(() => gate);
    this.tails.set(key, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

/** true = running, false = provably not running on this host, null = cannot tell. */
export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    return null;
  }
}

/**
 * A lock is removable only when it is stale AND either its owner process is provably dead on
 * this host, or it has no owner metadata and is older than twice the stale threshold.
 * Locks owned by other hosts are never removed automatically.
 */
export async function inspectLock(lockPath, {staleMs = 30_000, now = Date.now(), hostname = os.hostname()} = {}) {
  let stat;
  try { stat = await fs.stat(lockPath); } catch (error) { if (error.code === 'ENOENT') return {exists: false}; throw error; }
  let owner = null;
  try { owner = JSON.parse(await fs.readFile(path.join(lockPath, OWNER_FILE), 'utf8')); } catch { owner = null; }
  const updated = owner?.updated_at ? Date.parse(owner.updated_at) : stat.mtimeMs;
  const ageMs = Math.max(0, now - (Number.isFinite(updated) ? updated : stat.mtimeMs));
  const stale = ageMs > staleMs;
  let removable = false;
  let reason;
  if (!stale) reason = 'recent';
  else if (!owner) { removable = ageMs > staleMs * 2; reason = removable ? 'no_owner_metadata_and_old' : 'no_owner_metadata'; }
  else if (owner.hostname !== hostname) reason = 'owner_on_other_host';
  else if (Date.parse(owner.created_at) < now - os.uptime() * 1000 - 5000) {
    // Created before this host last booted: the owner is gone even if its PID was reused.
    removable = true;
    reason = 'owner_before_system_boot';
  } else if (owner.pid === process.pid && owner.process_started_at && owner.process_started_at !== PROCESS_STARTED_AT) {
    // Our PID but another start time: an earlier process, e.g. PID 1 of a restarted container.
    removable = true;
    reason = 'owner_pid_reused';
  } else {
    const alive = processAlive(owner.pid);
    removable = alive === false;
    reason = alive === false ? 'owner_process_not_running' : alive ? 'owner_process_running' : 'owner_process_unknown';
  }
  return {exists: true, owner, age_ms: Math.round(ageMs), stale, removable, reason, stale_ms: staleMs};
}

export function lockSummary(inspection) {
  if (!inspection?.exists) return {exists: false};
  const {owner} = inspection;
  return {exists: true, age_ms: inspection.age_ms, stale: inspection.stale, removable: inspection.removable, reason: inspection.reason,
    owner: owner ? {pid: owner.pid, hostname: owner.hostname, updated_at: owner.updated_at, lock_version: owner.lock_version} : null};
}

/** Park the lock, confirm it is the one inspected, then delete it; otherwise put it back. */
export async function removeStaleLock(lockPath, inspection) {
  const parked = `${lockPath}.stale-${crypto.randomUUID()}`;
  try { await fs.rename(lockPath, parked); } catch { return false; }
  let owner = null;
  try { owner = JSON.parse(await fs.readFile(path.join(parked, OWNER_FILE), 'utf8')); } catch { owner = null; }
  let same;
  if (inspection.owner) {
    same = Boolean(owner) && owner.pid === inspection.owner.pid && owner.created_at === inspection.owner.created_at;
  } else {
    // Owner-less: only the same old directory qualifies. A lock recreated after inspection has a fresh
    // mtime (or metadata), so it is put back instead of being deleted.
    const stat = await fs.stat(parked).catch(() => null);
    same = !owner && Boolean(stat) && Date.now() - stat.mtimeMs > (inspection.stale_ms ?? 30_000) * 2;
  }
  if (!same) {
    await fs.rename(parked, lockPath).catch(() => {});
    return false;
  }
  await fs.rm(parked, {recursive: true, force: true}).catch(() => {});
  return true;
}

/**
 * Whether the lock directory still belongs to this holder. The lock is left alone only when owner.json was
 * read successfully and names someone else, or when our metadata vanished (the directory was replaced).
 * Transient read errors are retried; an unreadable owner file is treated as ours, because leaving our own
 * lock behind would block the project until this process exits.
 */
async function ownsLock(lockPath, owner, ownerWritten) {
  for (let attempt = 1; ; attempt++) {
    try {
      const current = JSON.parse(await fs.readFile(path.join(lockPath, OWNER_FILE), 'utf8'));
      return current?.pid === owner.pid && current?.created_at === owner.created_at;
    } catch (error) {
      if (error?.code === 'ENOENT') return !ownerWritten;
      if (!TRANSIENT.has(error?.code) || attempt >= 5) return true;
      await sleep(20 + Math.random() * 30);
    }
  }
}

/** Cross-process lock using an exclusive directory plus owner metadata refreshed by a heartbeat. */
export async function withDirLock(dir, fn, {timeoutMs = 20_000, staleMs = 30_000, onRecovered} = {}) {
  await ensureDir(dir);
  const lockPath = path.join(dir, '.lock');
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 1; ; attempt++) {
    try {
      await fs.mkdir(lockPath, {mode: 0o700});
      break;
    } catch (error) {
      if (!TRANSIENT.has(error.code)) throw error;
      const expired = Date.now() > deadline;
      if (attempt % 10 === 0 || expired) {
        const inspection = await inspectLock(lockPath, {staleMs});
        if (inspection.exists && inspection.removable && await removeStaleLock(lockPath, inspection)) {
          onRecovered?.(inspection);
          continue;
        }
        if (expired) {
          // Owner pid/hostname stay out of client-visible errors; `memory repair` shows them to operators.
          const {owner: _owner, ...lock} = lockSummary(inspection);
          throw new ToolError('lock_timeout', `Memory lock timeout for ${path.basename(dir)}`,
            {lock, recovery: 'Run dz23-subagents memory repair to inspect the owner, then follow docs/OPERATIONS.md (memory locks)'});
        }
      }
      await sleep(20 + Math.random() * 30);
    }
  }
  const createdAt = new Date().toISOString();
  const owner = {lock_version: SCHEMA_VERSIONS.lock, pid: process.pid, hostname: os.hostname(), created_at: createdAt, updated_at: createdAt, process_started_at: PROCESS_STARTED_AT};
  // Atomic owner writes: readers never see a torn owner.json, and each rename refreshes the lock directory mtime.
  let ownerWritten = false;
  const writeOwner = async () => {
    const tmp = path.join(lockPath, `${OWNER_FILE}.${crypto.randomUUID()}.tmp`);
    try {
      await fs.writeFile(tmp, JSON.stringify(owner), {mode: 0o600});
      await fs.rename(tmp, path.join(lockPath, OWNER_FILE));
      ownerWritten = true;
    } catch {
      await fs.rm(tmp, {force: true}).catch(() => {});
    }
  };
  await writeOwner();
  let pendingOwnerWrite = Promise.resolve();
  const heartbeat = setInterval(() => { owner.updated_at = new Date().toISOString(); pendingOwnerWrite = writeOwner(); }, Math.max(1000, Math.floor(staleMs / 3)));
  heartbeat.unref();
  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    await pendingOwnerWrite; // never write owner.json into a lock directory after deciding to release it
    const ours = await ownsLock(lockPath, owner, ownerWritten);
    for (let i = 0; ours && i < 20; i++) {
      try {
        await fs.rm(lockPath, {recursive: true, force: true});
        break;
      } catch (error) {
        if (!TRANSIENT.has(error.code) || i === 19) throw error;
        await sleep(20 + Math.random() * 30);
      }
    }
  }
}
