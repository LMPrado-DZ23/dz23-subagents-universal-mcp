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
  else {
    const alive = processAlive(owner.pid);
    removable = alive === false;
    reason = alive === false ? 'owner_process_not_running' : alive ? 'owner_process_running' : 'owner_process_unknown';
  }
  return {exists: true, owner, age_ms: Math.round(ageMs), stale, removable, reason};
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
  const same = (owner?.pid ?? null) === (inspection.owner?.pid ?? null) && (owner?.created_at ?? null) === (inspection.owner?.created_at ?? null);
  if (!same) {
    await fs.rename(parked, lockPath).catch(() => {});
    return false;
  }
  await fs.rm(parked, {recursive: true, force: true}).catch(() => {});
  return true;
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
          throw new ToolError('lock_timeout', `Memory lock timeout for ${path.basename(dir)}`,
            {lock: lockSummary(inspection), recovery: 'Verify no process still uses the lock, then follow docs/OPERATIONS.md (memory locks)'});
        }
      }
      await sleep(20 + Math.random() * 30);
    }
  }
  const createdAt = new Date().toISOString();
  const owner = {lock_version: SCHEMA_VERSIONS.lock, pid: process.pid, hostname: os.hostname(), created_at: createdAt, updated_at: createdAt, process_started_at: PROCESS_STARTED_AT};
  const writeOwner = () => fs.writeFile(path.join(lockPath, OWNER_FILE), JSON.stringify(owner), {mode: 0o600}).catch(() => {});
  await writeOwner();
  const heartbeat = setInterval(() => { owner.updated_at = new Date().toISOString(); writeOwner(); }, Math.max(1000, Math.floor(staleMs / 3)));
  heartbeat.unref();
  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    for (let i = 0; i < 20; i++) {
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
