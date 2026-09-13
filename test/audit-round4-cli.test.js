import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {ProjectMemory} from '../src/memory.js';
import {runCli} from '../src/cli.js';

// CLI regressions for the fourth audit round (product re-verification of round 2/3).

const source = fileURLToPath(new URL('../', import.meta.url));

async function tempDir(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dz23-round4-cli-'));
  t.after(() => fsp.rm(dir, {recursive: true, force: true}));
  return dir;
}

function captureIo(env) {
  const out = {stdout: '', stderr: ''};
  const io = {stdout: {write: text => { out.stdout += text; }}, stderr: {write: text => { out.stderr += text; }}, stdin: {isTTY: true}, env};
  return {out, io};
}

test('CLI treats a wrong-case id as a usage error, never as corrupt memory', async t => {
  const state = path.join(await tempDir(t), 'state');
  const memory = new ProjectMemory(state);
  await memory.recordCheckpoint('qa', 'm1', {next_action: 'LOWER'});
  if (!await memory.isCaseInsensitive()) {
    t.skip('case-sensitive filesystem: QA and qa are distinct ids');
    return;
  }
  for (const argv of [['missions', 'show', 'QA', 'm1', '--json'], ['missions', 'list', '--project', 'QA', '--json'], ['memory', 'repair', '--project', 'QA', '--json']]) {
    const {out, io} = captureIo({DZ23_STATE_DIR: state});
    assert.equal(await runCli(argv, io), 2, argv.join(' '));
    assert.equal(JSON.parse(out.stdout).error.code, 'usage_error', argv.join(' '));
  }
  assert.equal((await memory.getMission('qa', 'm1')).next_action, 'LOWER');
});

test('memory repair --apply says when nothing was repaired', async t => {
  const state = path.join(await tempDir(t), 'state');
  const memory = new ProjectMemory(state);
  await memory.recordCheckpoint('p', 'm', {goal: 'g'});
  fs.writeFileSync(memory.projectFile('p'), '{broken');
  const {out, io} = captureIo({DZ23_STATE_DIR: state});
  await runCli(['memory', 'repair', '--apply', '--yes'], io);
  assert.match(out.stdout, /No repairs applied\./);
  assert.doesNotMatch(out.stdout, /Repairs applied\./);
});

test('--http refuses a short token with exit 78; stdio configuration only warns', async t => {
  const dir = await tempDir(t);
  fs.cpSync(path.join(source, 'src'), path.join(dir, 'pkg', 'src'), {recursive: true});
  fs.copyFileSync(path.join(source, 'package.json'), path.join(dir, 'pkg', 'package.json'));
  const env = {DZ23_STATE_DIR: path.join(dir, 'state'), DZ23_ALLOW_HTTP: 'true', DZ23_MCP_TOKEN: 'short-token', DZ23_HTTP_PORT: '0'};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) if (process.env[key] !== undefined) env[key] = process.env[key];
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(dir, 'pkg', 'src', 'index.js'), '--http'], {cwd: dir, env});
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill(); reject(new Error('--http with a short token did not exit')); }, 20_000);
    child.on('close', status => { clearTimeout(timer); resolve({status, stderr}); });
    child.stdin.end();
  });
  assert.equal(result.status, 78);
  assert.match(result.stderr, /32 characters/);
  const {out, io} = captureIo({DZ23_STATE_DIR: path.join(dir, 'state'), DZ23_ALLOW_HTTP: 'true', DZ23_MCP_TOKEN: 'short-token'});
  await runCli(['config', 'validate', '--json'], io);
  const issues = JSON.parse(out.stdout).issues.filter(issue => issue.variable === 'DZ23_MCP_TOKEN');
  assert.deepEqual(issues.map(issue => issue.level), ['warn']);
});
