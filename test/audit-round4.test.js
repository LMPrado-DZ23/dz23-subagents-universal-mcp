import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ProjectMemory} from '../src/memory.js';
import {withDirLock} from '../src/locks.js';

// Regressions for the fourth audit round (architecture re-verification of round 2/3).

async function tempDir(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dz23-round4-'));
  t.after(() => fsp.rm(dir, {recursive: true, force: true}));
  return dir;
}

test('a transient owner.json read failure at release does not leave the lock behind', async t => {
  const dir = await tempDir(t);
  const lockPath = path.join(dir, '.lock');
  const original = fsp.readFile;
  let injected = 0;
  fsp.readFile = async (file, ...rest) => {
    if (String(file).endsWith('owner.json') && injected < 2) {
      injected++;
      throw Object.assign(new Error('busy'), {code: 'EBUSY'});
    }
    return original(file, ...rest);
  };
  try {
    assert.equal(await withDirLock(dir, async () => 'first'), 'first');
  } finally {
    fsp.readFile = original;
  }
  assert.equal(injected, 2, 'the release read failed twice before succeeding');
  assert.equal(fs.existsSync(lockPath), false);
  assert.equal(await withDirLock(dir, async () => 'second', {timeoutMs: 2000}), 'second');
});

test('a persistently unreadable owner.json of our own lock is still released', async t => {
  const dir = await tempDir(t);
  const original = fsp.readFile;
  fsp.readFile = async (file, ...rest) => {
    if (String(file).endsWith('owner.json')) throw Object.assign(new Error('denied'), {code: 'EACCES'});
    return original(file, ...rest);
  };
  try {
    await withDirLock(dir, async () => undefined);
  } finally {
    fsp.readFile = original;
  }
  assert.equal(fs.existsSync(path.join(dir, '.lock')), false);
});

test('case probe matches the platform; case-sensitive filesystems keep distinct ids reachable', async t => {
  const memory = new ProjectMemory(path.join(await tempDir(t), 'state'));
  assert.equal(await memory.isCaseInsensitive(), false, 'no probe (and no directory creation) before the state root exists');
  await memory.recordCheckpoint('Proj', 'Mission', {decisions: ['upper']});
  const insensitive = await memory.isCaseInsensitive();
  if (process.platform === 'win32') assert.equal(insensitive, true);
  if (process.platform === 'linux') assert.equal(insensitive, false);
  assert.deepEqual(fs.readdirSync(memory.root).filter(name => name.startsWith('.case-probe')), [], 'probe file removed');
  if (!insensitive) {
    await memory.recordCheckpoint('proj', 'mission', {decisions: ['lower']});
    assert.deepEqual((await memory.getMission('Proj', 'Mission')).decisions, ['upper']);
    assert.deepEqual((await memory.getMission('proj', 'mission')).decisions, ['lower']);
  } else {
    await assert.rejects(memory.getMission('proj', 'Mission'), error => error.code === 'invalid_request');
  }
});
