import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {ToolError} from './errors.js';

export const MISSING = Symbol('missing');
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Windows refuses rename/read while another handle briefly holds a file.
const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY']);
const IO_RETRIES = 40;

export async function ensureDir(dir) {
  await fs.mkdir(dir, {recursive: true, mode: 0o700});
}

/** Path relative to the state root with forward slashes, so errors never reveal absolute paths. */
export function relativePath(root, file) {
  return root ? path.relative(root, file).split(path.sep).join('/') : path.basename(file);
}

export async function readTextFile(file) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fs.readFile(file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      if (TRANSIENT.has(error.code) && attempt < IO_RETRIES) { await sleep(5 + Math.random() * 10); continue; }
      throw error;
    }
  }
}

/** Parse JSON or raise memory_integrity; a corrupt file is never treated as missing. */
export async function readJson(file, fallback, {root} = {}) {
  const text = await readTextFile(file);
  if (text === null) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    throw new ToolError('memory_integrity', 'Memory file is not valid JSON; run memory repair', {kind: 'corrupt_json', file: relativePath(root, file)});
  }
}

/** Write to a temporary file (fsync when durable), then rename over the target. */
export async function atomicWrite(file, text, {durable = true} = {}) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const handle = await fs.open(tmp, 'w', 0o600);
  try {
    await handle.writeFile(text);
    if (durable) await handle.sync();
  } finally {
    await handle.close();
  }
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(tmp, file);
      return;
    } catch (error) {
      if (!TRANSIENT.has(error.code) || attempt >= IO_RETRIES) {
        await fs.rm(tmp, {force: true}).catch(() => {});
        throw new ToolError('memory_write_failed', 'Memory file stayed busy; the write was not completed');
      }
      await sleep(5 + Math.random() * 10 * Math.min(attempt + 1, 10));
    }
  }
}

export function atomicJson(file, value, options) {
  return atomicWrite(file, JSON.stringify(value, null, 2), options);
}

/** Append one line; beyond maxBytes atomically keep only the newest 75%. */
export async function appendBoundedLine(file, line, maxBytes, options = {}) {
  await ensureDir(path.dirname(file));
  await fs.appendFile(file, `${line}\n`, {mode: 0o600});
  const {size} = await fs.stat(file);
  if (size > maxBytes) await keepNewestLines(file, maxBytes, options);
}

export async function keepNewestLines(file, maxBytes, options = {}) {
  const lines = ((await readTextFile(file)) || '').split('\n').filter(Boolean);
  const kept = [];
  let bytes = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const size = Buffer.byteLength(`${lines[i]}\n`);
    if (bytes + size > Math.floor(maxBytes * 0.75)) break;
    kept.unshift(lines[i]);
    bytes += size;
  }
  await atomicWrite(file, kept.length ? `${kept.join('\n')}\n` : '', options);
}
