import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {redact} from './redact.js';

export async function appendAudit(root, event, secrets = []) {
  const file = path.join(root, 'audit', 'events.jsonl');
  await fs.mkdir(path.dirname(file), {recursive:true});
  const previous = (await fs.readFile(file, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).at(-1);
  const previousHash = previous ? JSON.parse(previous).hash : 'GENESIS';
  const body = {at:new Date().toISOString(), previous_hash:previousHash, event:redact(event, secrets)};
  const hash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
  await fs.appendFile(file, `${JSON.stringify({...body, hash})}\n`);
  return {hash, previous_hash:previousHash};
}

export async function verifyAudit(root) {
  const lines = (await fs.readFile(path.join(root, 'audit', 'events.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
  let previous = 'GENESIS';
  for (const line of lines) {
    const record = JSON.parse(line);
    if (record.previous_hash !== previous) return {ok:false, reason:'chain_break'};
    const {hash, ...body} = record;
    const expected = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
    if (hash !== expected) return {ok:false, reason:'hash_mismatch'};
    previous = hash;
  }
  return {ok:true, events:lines.length, head:previous};
}
