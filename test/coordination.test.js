import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {claimMission, releaseMission} from '../src/coordination.js';
import {appendAudit, verifyAudit} from '../src/audit-log.js';

test('mission lease blocks a different harness and releases by token', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dz23-lease-'));
  const cfg = {stateDir:root};
  const lease = await claimMission(cfg, {project_id:'p', mission_id:'m', identity:'claude', lease_ms:5000});
  await assert.rejects(() => claimMission(cfg, {project_id:'p', mission_id:'m', identity:'codex'}), /claimed by another harness/);
  assert.equal((await releaseMission(cfg, {project_id:'p', mission_id:'m', identity:'claude', token:lease.token})).released, true);
});

test('audit log is redacted and tamper evident', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dz23-audit-'));
  await appendAudit(root, {tool:'delegate', prompt:'secret'}, ['secret']);
  await appendAudit(root, {tool:'workspace_read'}, []);
  assert.equal((await verifyAudit(root)).ok, true);
  const file = path.join(root, 'audit', 'events.jsonl');
  const text = await fs.readFile(file, 'utf8');
  assert.doesNotMatch(text, /secret/);
  await fs.appendFile(file, '{"tampered":true}\n');
  assert.equal((await verifyAudit(root)).ok, false);
});
