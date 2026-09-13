import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ProjectMemory} from '../src/memory.js';
import {Router} from '../src/core.js';
import {inspectLock, withDirLock} from '../src/locks.js';
import {config} from '../src/config.js';
import {ToolError} from '../src/errors.js';

// Regressions for the second audit round (architecture re-verification).

async function tempDir(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dz23-round2-'));
  t.after(() => fsp.rm(dir, {recursive: true, force: true}));
  return dir;
}

const LOCAL = {name: 'local', baseURL: 'http://fixture.invalid', apiKey: 'local', keyName: 'LOCAL', credentialSource: 'none', defaultModel: 'm',
  tier: 'local', protocol: 'openai', location: 'local', capabilities: {text: true}, enabled: true, configured: true};
const BASE = {rotation: ['local:m'], allowPaid: false, policy: 'free-first', maxConcurrency: 4, maxWorkersPerTarget: 4, timeoutMs: 5000, maxContextChars: 20000};
const invalid = error => error instanceof ToolError && error.code === 'invalid_request';

test('a full delegation queue fails the call without putting the target into cooldown', async t => {
  const memory = new ProjectMemory(await tempDir(t));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const router = new Router({...BASE, maxConcurrency: 1, maxWorkersPerTarget: 1, maxQueue: 1}, memory,
    {registry: {local: LOCAL}, caller: async () => { calls++; await gate; return {content: 'ok'}; }});
  const first = router.delegate({project_id: 'p', mission_id: 'm1', prompt: 'one'});
  const second = router.delegate({project_id: 'p', mission_id: 'm2', prompt: 'two'});
  for (let i = 0; i < 400 && !(calls === 1 && router.limiter.queue.length === 1); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual([calls, router.limiter.queue.length], [1, 1]);
  await assert.rejects(router.delegate({project_id: 'p', mission_id: 'm3', prompt: 'three'}), error => error instanceof ToolError && error.code === 'queue_full');
  assert.equal(router.exhausted.size, 0, 'queue_full must not mark the target as failed');
  release();
  assert.equal((await first).ok, true);
  assert.equal((await second).ok, true);
});

test('case-insensitive aliases are refused on every memory read and write path', async t => {
  const memory = new ProjectMemory(await tempDir(t));
  await memory.recordCheckpoint('proj', 'fix-login', {decisions: ['A'], goal: 'original'});
  await assert.rejects(memory.recordCheckpoint('proj', 'Fix-Login', {decisions: ['B'], goal: 'other'}), invalid);
  await assert.rejects(memory.recordCheckpoint('PROJ', 'fix-login', {decisions: ['B']}), invalid);
  await assert.rejects(memory.getMission('proj', 'FIX-LOGIN'), invalid);
  await assert.rejects(memory.appendEvent('proj', 'Fix-Login', 'note', {}), invalid);
  await assert.rejects(memory.readJournal('Proj', 'fix-login'), invalid);
  const mission = await memory.getMission('proj', 'fix-login');
  assert.deepEqual([mission.decisions, mission.goal], [['A'], 'original']);
});

test('a lock owned by an earlier process with the same PID (restarted container) is recoverable', async t => {
  const lockPath = path.join(await tempDir(t), '.lock');
  fs.mkdirSync(lockPath);
  const at = new Date(Date.now() - 120_000).toISOString();
  const owner = {pid: process.pid, hostname: os.hostname(), created_at: at, updated_at: at, lock_version: 1, process_started_at: '1999-01-01T00:00:00.000Z'};
  fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify(owner));
  const inspection = await inspectLock(lockPath);
  assert.deepEqual([inspection.removable, inspection.reason], [true, 'owner_pid_reused']);
  const {process_started_at: _unknown, ...withoutStart} = owner;
  fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify(withoutStart));
  assert.equal((await inspectLock(lockPath)).removable, false, 'without a start time the running PID is trusted');
});

test('a process releases only its own lock', async t => {
  const dir = await tempDir(t);
  const lockPath = path.join(dir, '.lock');
  const now = new Date().toISOString();
  const foreign = {pid: 999999, hostname: os.hostname(), created_at: now, updated_at: now, lock_version: 1};
  const value = await withDirLock(dir, async () => {
    fs.renameSync(lockPath, `${lockPath}.parked`);
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify(foreign));
    return 'done';
  });
  assert.equal(value, 'done');
  assert.equal(JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8')).pid, 999999);
});

test('a paid delegate result is returned even when the handoff checkpoint exceeds the state cap', async t => {
  const memory = new ProjectMemory(await tempDir(t), {maxStateBytes: 3000});
  let calls = 0;
  const router = new Router(BASE, memory, {registry: {local: LOCAL}, caller: async () => { calls++; return {content: 'y'.repeat(2500)}; }});
  const result = await router.delegate({project_id: 'p', mission_id: 'm', prompt: 'hi'});
  assert.deepEqual([result.ok, calls, result.content.length], [true, 1, 2500]);
});

test('checkpoint responses report truncated lists without persisting the report', async t => {
  const memory = new ProjectMemory(await tempDir(t), {maxListItems: 10});
  let last;
  for (let batch = 0; batch < 3; batch++) last = await memory.recordCheckpoint('p', 'm', {decisions: Array.from({length: 10}, (_, i) => `d${batch * 10 + i}`)});
  assert.deepEqual(last.truncated_lists, {decisions: 10});
  assert.equal((await memory.getMission('p', 'm')).truncated_lists, undefined);
});

test('startMission never overwrites a mission created in the meantime', async t => {
  const memory = new ProjectMemory(await tempDir(t));
  await memory.recordCheckpoint('p', 'm', {goal: 'harness goal', status: 'blocked'});
  const returned = await memory.startMission('p', 'm', {goal: ''});
  assert.equal(returned.goal, 'harness goal');
  const mission = await memory.getMission('p', 'm');
  assert.deepEqual([mission.goal, mission.status], ['harness goal', 'blocked']);
});

test('HTTP-enabled configuration refuses bearer tokens shorter than 32 characters', async t => {
  const dir = await tempDir(t);
  const errors = cfg => cfg.configIssues.filter(issue => issue.level === 'error').map(issue => issue.variable);
  assert.ok(errors(config({DZ23_STATE_DIR: dir, DZ23_ALLOW_HTTP: 'true', DZ23_MCP_TOKEN: 'short-token'})).includes('DZ23_MCP_TOKEN'));
  assert.equal(errors(config({DZ23_STATE_DIR: dir, DZ23_MCP_TOKEN: 'short-token'})).includes('DZ23_MCP_TOKEN'), false);
  assert.equal(errors(config({DZ23_STATE_DIR: dir, DZ23_ALLOW_HTTP: 'true', DZ23_MCP_TOKEN: 'x'.repeat(40)})).includes('DZ23_MCP_TOKEN'), false);
});
