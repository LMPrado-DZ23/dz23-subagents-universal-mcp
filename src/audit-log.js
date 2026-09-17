import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {redact} from './redact.js';
import {withDirLock} from './locks.js';

// Hash-chained tool-call log. Appends are serialized in this process and locked across processes
// sharing the state directory, so concurrent calls never fork the chain. It detects edits made
// through other means; an operator who controls the directory can still rewrite the whole chain.
const MAX_BYTES = 10 * 1024 * 1024;
const queues = new Map();

async function lastHash(file) {
  const handle = await fs.open(file, 'r').catch(() => null);
  if (!handle) return 'GENESIS';
  try {
    const {size} = await handle.stat();
    const length = Math.min(size, 8192);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const line = buffer.toString('utf8').trim().split('\n').at(-1);
    return line ? JSON.parse(line).hash : 'GENESIS';
  } finally {
    await handle.close();
  }
}

async function append(root, event, secrets) {
  const dir = path.join(root, 'audit');
  await fs.mkdir(dir, {recursive: true});
  return withDirLock(dir, async () => {
    const file = path.join(dir, 'events.jsonl');
    const size = (await fs.stat(file).catch(() => null))?.size || 0;
    let previousHash = await lastHash(file);
    if (size > MAX_BYTES) {
      await fs.rename(file, path.join(dir, `events-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`));
      previousHash = `ROTATED:${previousHash}`;
    }
    const body = {at: new Date().toISOString(), previous_hash: previousHash, event: redact(event, secrets)};
    const hash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
    await fs.appendFile(file, `${JSON.stringify({...body, hash})}\n`);
    return {hash, previous_hash: previousHash};
  }, {timeoutMs: 10_000});
}

export function appendAudit(root, event, secrets = []) {
  if (!root) return Promise.resolve(null);
  const previous = queues.get(root) || Promise.resolve();
  const next = previous.catch(() => undefined).then(() => append(root, event, secrets));
  queues.set(root, next);
  next.finally(() => { if (queues.get(root) === next) queues.delete(root); }).catch(() => undefined);
  return next;
}

export async function verifyAudit(root) {
  const lines = (await fs.readFile(path.join(root, 'audit', 'events.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
  let previous = null;
  for (const line of lines) {
    let record;
    try { record = JSON.parse(line); } catch { return {ok: false, reason: 'invalid_line'}; }
    const {hash, ...body} = record;
    if (previous === null ? !/^(?:GENESIS|ROTATED:)/.test(record.previous_hash || '') : record.previous_hash !== previous) return {ok: false, reason: 'chain_break'};
    if (hash !== crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex')) return {ok: false, reason: 'hash_mismatch'};
    previous = hash;
  }
  return {ok: true, events: lines.length, head: previous || 'GENESIS'};
}
