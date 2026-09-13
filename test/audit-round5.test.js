import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ProjectMemory} from '../src/memory.js';
import {runCli} from '../src/cli.js';

// CLI regressions for the fifth audit round (product re-verification of round 4).

async function tempDir(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dz23-round5-'));
  t.after(() => fsp.rm(dir, {recursive: true, force: true}));
  return dir;
}

function captureIo(env) {
  const out = {stdout: '', stderr: ''};
  const io = {stdout: {write: text => { out.stdout += text; }}, stderr: {write: text => { out.stderr += text; }}, stdin: {isTTY: true}, env};
  return {out, io};
}

test('doctor fails the http check when --http would refuse a short token', async t => {
  const state = path.join(await tempDir(t), 'state');
  const {out, io} = captureIo({DZ23_STATE_DIR: state, DZ23_ALLOW_HTTP: 'true', DZ23_MCP_TOKEN: 'short-token', DZ23_ROTATION: 'custom:qwen3-coder'});
  const code = await runCli(['doctor', '--json'], io);
  const http = JSON.parse(out.stdout).checks.find(check => check.name === 'http');
  assert.equal(http.status, 'fail');
  assert.match(http.detail, /32 characters/);
  assert.equal(code, 1);
  assert.equal(out.stdout.includes('short-token'), false, 'the token value is never printed');
});

test('memory repair --json separates apply_requested from applied', async t => {
  const state = path.join(await tempDir(t), 'state');
  const memory = new ProjectMemory(state);
  await memory.recordCheckpoint('p', 'm', {goal: 'g'});
  fs.writeFileSync(memory.projectFile('p'), '{broken');
  const dry = captureIo({DZ23_STATE_DIR: state});
  await runCli(['memory', 'repair', '--json'], dry.io);
  const dryReport = JSON.parse(dry.out.stdout);
  assert.deepEqual([dryReport.apply_requested, dryReport.applied], [false, false]);
  const apply = captureIo({DZ23_STATE_DIR: state});
  await runCli(['memory', 'repair', '--apply', '--yes', '--json'], apply.io);
  const applyReport = JSON.parse(apply.out.stdout);
  assert.deepEqual([applyReport.apply_requested, applyReport.applied], [true, false], 'a manual-only issue is not reported as repaired');
});
