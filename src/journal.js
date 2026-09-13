import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {SCHEMA_VERSIONS} from './constants.js';
import {ensureDir, keepNewestLines, readTextFile} from './fsutil.js';
import {normalizeEvent} from './memory-schema.js';

// Larger than the maximum event size, so the last complete event is always inside the tail.
const TAIL_BYTES = 262_144;

/** Last sequence number and whether the file ends in an incomplete line (crash mid-append). */
export async function readJournalTail(file) {
  let handle;
  try { handle = await fs.open(file, 'r'); } catch (error) { if (error.code === 'ENOENT') return {size: 0, lastSeq: 0, trailingIncomplete: false}; throw error; }
  try {
    const {size} = await handle.stat();
    if (!size) return {size, lastSeq: 0, trailingIncomplete: false};
    const start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.toString('utf8');
    const lines = text.split('\n');
    if (start > 0) lines.shift();
    let lastSeq = 0;
    for (let i = lines.length - 1; i >= 0 && !lastSeq; i--) {
      try { const event = JSON.parse(lines[i]); if (Number.isInteger(event?.seq)) lastSeq = event.seq; } catch { /* incomplete or invalid line */ }
    }
    return {size, lastSeq, trailingIncomplete: !text.endsWith('\n')};
  } finally {
    await handle.close();
  }
}

/**
 * Append one event with a monotonic `seq`. An incomplete trailing line is closed first and a
 * journal_recovered event records it; the partial line itself is preserved for inspection.
 * Callers must hold the project lock.
 */
export async function appendJournalEvent(file, type, payload, {maxJournalBytes, maxEventBytes, durable = true}) {
  await ensureDir(path.dirname(file));
  const tail = await readJournalTail(file);
  let seq = tail.lastSeq;
  const lines = [];
  if (tail.trailingIncomplete) {
    seq += 1;
    lines.push(JSON.stringify({schema: SCHEMA_VERSIONS.event, seq, id: crypto.randomUUID(), ts: new Date().toISOString(), type: 'journal_recovered', payload: {reason: 'incomplete_trailing_line'}}));
  }
  seq += 1;
  const event = {schema: SCHEMA_VERSIONS.event, seq, id: crypto.randomUUID(), ts: new Date().toISOString(), type, payload};
  let line = JSON.stringify(event);
  if (Buffer.byteLength(line) > maxEventBytes) {
    event.payload = {truncated: true, original_bytes: Buffer.byteLength(line)};
    line = JSON.stringify(event);
  }
  lines.push(line);
  await fs.appendFile(file, `${tail.trailingIncomplete ? '\n' : ''}${lines.join('\n')}\n`, {mode: 0o600});
  const {size} = await fs.stat(file);
  if (size > maxJournalBytes) await keepNewestLines(file, maxJournalBytes, {durable});
  return {event, recovered: tail.trailingIncomplete};
}

/** All parseable events (limited to the newest `limit`) plus integrity counters. */
export async function readJournal(file, limit = 50) {
  const text = await readTextFile(file);
  if (text === null) return {events: [], invalid_lines: 0, last_seq: 0};
  const events = [];
  let invalid = 0;
  let lastSeq = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let event = null;
    try { event = normalizeEvent(JSON.parse(line)); } catch { event = null; }
    if (!event) { invalid++; continue; }
    if (event.seq !== null && event.seq > lastSeq) lastSeq = event.seq;
    events.push(event);
  }
  return {events: events.slice(-limit), invalid_lines: invalid, last_seq: lastSeq};
}
