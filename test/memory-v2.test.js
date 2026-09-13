import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {ProjectMemory} from '../src/memory.js';
import {inspectLock} from '../src/locks.js';
import {buildContext} from '../src/context.js';
import {inspectMemory, repairMemory} from '../src/memory-repair.js';
import {createLogger} from '../src/logger.js';
import {ToolError} from '../src/errors.js';

async function temp(t, options = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dz23-memv2-'));
  t.after(() => fsp.rm(dir, {recursive: true, force: true}));
  const lines = [];
  const logger = createLogger({level: 'debug', sink: line => lines.push(JSON.parse(line))});
  return {dir, lines, memory: new ProjectMemory(dir, {logger, ...options})};
}

const writeJson = (file, value) => { fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
const integrity = kind => error => error instanceof ToolError && error.code === 'memory_integrity' && error.details.kind === kind;

test('legacy v1 records migrate on read and are persisted as v2 on the next write', async t => {
  const {memory} = await temp(t);
  writeJson(memory.projectFile('p'), {schema: 1, project_id: 'p', created_at: '2026-09-01T00:00:00.000Z', decisions: ['keep MIT'], facts: [], artifacts: [], agents: []});
  writeJson(memory.missionFile('p', 'm'), {schema: 1, project_id: 'p', mission_id: 'm', sequence: 3, status: 'active', goal: 'legacy goal', acceptance_criteria: [], completed_tasks: [],
    active_tasks: [], blocked_tasks: [], next_tasks: [], decisions: [], known_failures: [], files_read: [], files_changed: [], artifacts: [], tests: {passed: ['old']}, agents: [], agent_outputs: [{content: 'kept'}]});
  const project = await memory.getProject('p');
  assert.deepEqual([project.schema, project.migrated_from, project.decisions, project.usage_totals.calls], [2, 1, ['keep MIT'], 0]);
  assert.equal(JSON.parse(fs.readFileSync(memory.projectFile('p'), 'utf8')).schema, 1, 'reads never rewrite files');
  const mission = await memory.getMission('p', 'm');
  assert.deepEqual([mission.schema, mission.invariants, mission.summary, mission.tests, mission.usage.calls], [2, [], '', {passed: ['old'], failed: [], pending: []}, 0]);
  await memory.updateMission('p', 'm', {status: 'blocked'});
  const disk = JSON.parse(fs.readFileSync(memory.missionFile('p', 'm'), 'utf8'));
  assert.deepEqual([disk.schema, disk.migrated_from, disk.sequence, disk.status, disk.goal, disk.agent_outputs], [2, 1, 4, 'blocked', 'legacy goal', [{content: 'kept'}]]);
});

test('future schemas and corrupt JSON are refused without being overwritten', async t => {
  const {dir, memory} = await temp(t);
  writeJson(memory.missionFile('p', 'future'), {schema: 99, mission_id: 'future'});
  await assert.rejects(memory.getMission('p', 'future'), integrity('unsupported_schema'));
  await assert.rejects(memory.updateMission('p', 'future', {status: 'done'}), integrity('unsupported_schema'));
  assert.equal(JSON.parse(fs.readFileSync(memory.missionFile('p', 'future'), 'utf8')).schema, 99);
  writeJson(memory.missionFile('p', 'broken'), '{"schema":');
  await assert.rejects(memory.getMission('p', 'broken'), error => integrity('corrupt_json')(error) && error.details.file === 'projects/p/missions/broken/state.json' && !error.message.includes(dir));
  await assert.rejects(memory.startMission('p', 'broken', {goal: 'overwrite?'}), integrity('corrupt_json'));
  assert.equal(fs.readFileSync(memory.missionFile('p', 'broken'), 'utf8'), '{"schema":');
  writeJson(memory.missionFile('p', 'shape'), 'null');
  await assert.rejects(memory.getMission('p', 'shape'), integrity('corrupt_shape'));
});

test('journal sequence stays monotonic across rotation and incomplete-line recovery', async t => {
  const {memory, lines} = await temp(t, {maxJournalBytes: 65_536, durableWrites: false});
  await memory.startMission('p', 'm', {goal: 'g'});
  for (let i = 1; i <= 200; i++) await memory.appendEvent('p', 'm', 'step', {i, note: 'x'.repeat(500)});
  const rotated = await memory.readJournal('p', 'm', 1000);
  const seqs = rotated.events.map(event => event.seq);
  assert.ok(seqs.length < 200, 'rotation dropped the oldest events');
  assert.equal(seqs.at(-1), 200);
  assert.ok(seqs.every((seq, i) => i === 0 || seq === seqs[i - 1] + 1));
  fs.appendFileSync(memory.journalFile('p', 'm'), '{"seq":999,"type":"half');
  await memory.appendEvent('p', 'm', 'after_crash', {});
  const recovered = await memory.readJournal('p', 'm', 3);
  assert.deepEqual(recovered.events.slice(-2).map(e => [e.seq, e.type]), [[201, 'journal_recovered'], [202, 'after_crash']]);
  assert.deepEqual([recovered.invalid_lines, recovered.last_seq], [1, 202]);
  assert.ok(lines.some(entry => entry.event === 'journal_recovered'));
});

test('locks carry owner metadata and disappear on release', async t => {
  const {memory} = await temp(t);
  await memory.initProject('p');
  const owner = await memory.withLock('p', async () => JSON.parse(fs.readFileSync(path.join(memory.projectDir('p'), '.lock', 'owner.json'), 'utf8')));
  assert.deepEqual([owner.lock_version, owner.pid, owner.hostname], [2, process.pid, os.hostname()]);
  assert.ok(Date.parse(owner.created_at) && Date.parse(owner.updated_at) && Date.parse(owner.process_started_at));
  assert.equal(fs.existsSync(path.join(memory.projectDir('p'), '.lock')), false);
});

function plantLock(dir, owner, ageMs = 0) {
  const lock = path.join(dir, '.lock');
  fs.mkdirSync(lock, {recursive: true});
  const at = new Date(Date.now() - ageMs).toISOString();
  // created_at stays after this host's boot (CI runners may have booted minutes ago); staleness comes from updated_at.
  const createdAt = new Date(Date.now() - Math.min(ageMs, 1000)).toISOString();
  if (owner) fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({lock_version: 2, created_at: createdAt, updated_at: at, ...owner}));
  else fs.utimesSync(lock, new Date(Date.now() - ageMs), new Date(Date.now() - ageMs));
  return lock;
}

test('orphan detection only removes locks whose owner is provably gone', async t => {
  const {memory, lines} = await temp(t, {lockTimeoutMs: 400, lockStaleMs: 30_000});
  const deadPid = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;
  const dirOf = name => { const dir = path.join(memory.root, name); fs.mkdirSync(dir, {recursive: true}); return dir; };
  const old = 10 * 60_000;
  const cases = [
    ['dead', {pid: deadPid, hostname: os.hostname()}, old, true, 'owner_process_not_running'],
    ['recent', {pid: deadPid, hostname: os.hostname()}, 0, false, 'recent'],
    ['alive', {pid: process.pid, hostname: os.hostname()}, old, false, 'owner_process_running'],
    ['remote', {pid: deadPid, hostname: 'another-host.invalid'}, old, false, 'owner_on_other_host'],
    ['legacy', null, old, true, 'no_owner_metadata_and_old'],
    ['fresh-legacy', null, 40_000, false, 'no_owner_metadata']
  ];
  for (const [name, owner, age, removable, reason] of cases) {
    const inspection = await inspectLock(plantLock(dirOf(name), owner, age), {staleMs: 30_000});
    assert.deepEqual([inspection.removable, inspection.reason], [removable, reason], name);
  }
  plantLock(memory.projectDir('dead-owner'), {pid: deadPid, hostname: os.hostname()}, old);
  await memory.initProject('dead-owner');
  assert.ok(lines.some(entry => entry.event === 'memory_lock_recovered' && entry.reason === 'owner_process_not_running'));
  plantLock(memory.projectDir('busy'), {pid: process.pid, hostname: os.hostname()}, old);
  await assert.rejects(memory.initProject('busy'), error => error.code === 'lock_timeout' && error.details.lock.reason === 'owner_process_running' && error.details.lock.owner === undefined);
  assert.ok(fs.existsSync(path.join(memory.projectDir('busy'), '.lock')), 'a live owner lock is never removed');
});

test('layered context keeps priorities and reports truncated sections', async t => {
  const mission = {status: 'active', goal: 'GOAL-MARKER build the router', acceptance_criteria: ['AC-1 all tests pass', 'AC-2 no secrets'], invariants: ['INV-1 never break stdio'],
    decisions: Array.from({length: 60}, (_, i) => `decision ${i} ${'d'.repeat(80)}`).concat(['NEWEST-DECISION']), active_tasks: ['task A'], known_failures: ['flaky test'],
    next_action: 'NEXT-ACTION', sequence: 9, agent_outputs: Array.from({length: 8}, (_, i) => ({role: 'qa', provider: 'p', model: 'm', at: 't', content: `OUTPUT-${i} ${'o'.repeat(2000)}`}))};
  const events = Array.from({length: 30}, (_, i) => ({seq: i + 1, ts: 't', type: 'agent_attempt', payload: {provider: 'p', prompt: 'SECRET-PROMPT'}}));
  const small = buildContext({project: {project_id: 'p', decisions: []}, mission, events, maxChars: 3000});
  assert.ok(small.text.length <= 3000);
  for (const marker of ['GOAL-MARKER', 'AC-1', 'AC-2', 'INV-1', 'NEWEST-DECISION']) assert.ok(small.text.includes(marker), marker);
  assert.ok(small.truncated_sections.includes('recent_outputs'));
  assert.ok(small.text.startsWith('CONTEXT TRUNCATED SECTIONS:'));
  assert.equal(small.text.includes('SECRET-PROMPT'), false, 'event payloads are summarized, not dumped');
  assert.equal(small.sections.find(s => s.name === 'decisions').truncated, true);
  const full = buildContext({project: {project_id: 'p'}, mission, events, maxChars: 200_000});
  assert.deepEqual([full.truncated_sections, full.text.startsWith('CONTEXT COMPLETE')], [[], true]);
  // A huge goal is clipped, yet it cannot starve the small acceptance criteria and invariants after it.
  const tiny = buildContext({mission: {...mission, goal: 'G'.repeat(5000)}, events: [], maxChars: 1200});
  assert.ok(tiny.text.length <= 1200);
  assert.ok(tiny.truncated_sections.includes('goal'));
  assert.equal(tiny.truncated_sections.includes('acceptance_criteria'), false);
  assert.ok(tiny.text.includes('AC-1') && tiny.text.includes('INV-1'));
  const {memory} = await temp(t);
  await memory.recordCheckpoint('p', 'm', {goal: 'checkpointed goal', acceptance_criteria: ['criterion'], invariants: ['invariant'], status: 'active'});
  const bundle = await memory.contextBundleDetailed('p', 'm', 60_000);
  assert.ok(bundle.text.includes('## ACCEPTANCE_CRITERIA\ncriterion') && bundle.text.includes('## INVARIANTS\ninvariant'));
});

test('memory repair inspects, dry-runs, then restores without deleting data', async t => {
  const {memory} = await temp(t, {lockStaleMs: 30_000});
  await memory.recordCheckpoint('p', 'm', {goal: 'recover me', decisions: ['d1'], status: 'active'});
  fs.writeFileSync(memory.missionFile('p', 'm'), '{corrupt');
  fs.appendFileSync(memory.journalFile('p', 'm'), '{"seq":5,"type":"half');
  const deadPid = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;
  plantLock(memory.projectDir('p'), {pid: deadPid, hostname: os.hostname()}, 10 * 60_000);
  const report = await inspectMemory(memory);
  assert.deepEqual(report.issues.filter(i => i.repairable).map(i => i.type).sort(), ['corrupt_mission_state', 'journal_incomplete_line', 'stale_lock']);
  const dry = await repairMemory(memory, report);
  assert.deepEqual([dry.applied, dry.actions.every(a => a.status === 'planned')], [false, true]);
  assert.equal(fs.readFileSync(memory.missionFile('p', 'm'), 'utf8'), '{corrupt', 'dry run changes nothing');
  const applied = await repairMemory(memory, report, {apply: true});
  assert.deepEqual(applied.actions.map(a => [a.type, a.status]), [['stale_lock', 'removed'], ['corrupt_mission_state', 'restored'], ['journal_incomplete_line', 'closed']]);
  const restored = await memory.getMission('p', 'm');
  assert.deepEqual([restored.goal, restored.decisions, restored.restored_from_checkpoint], ['recover me', ['d1'], '000001.json']);
  const preserved = fs.readdirSync(memory.missionDir('p', 'm')).filter(name => name.startsWith('state.json.corrupt-'));
  assert.equal(preserved.length, 1);
  assert.equal(fs.readFileSync(path.join(memory.missionDir('p', 'm'), preserved[0]), 'utf8'), '{corrupt');
  const types = (await memory.readJournal('p', 'm', 10)).events.map(e => e.type);
  assert.ok(types.includes('journal_recovered') && types.includes('memory_restored'));
  const after = await inspectMemory(memory);
  assert.deepEqual(after.issues.filter(i => i.repairable), []);
  assert.deepEqual(after.issues.map(i => i.type), ['journal_invalid_lines']);
});
