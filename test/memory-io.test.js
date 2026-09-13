import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ProjectMemory} from '../src/memory.js';
import {Router} from '../src/core.js';

async function tempMemory(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dz23-memio-'));
  t.after(() => fsp.rm(dir, {recursive: true, force: true}));
  return {dir, memory: new ProjectMemory(dir)};
}

// Regression: on Windows, renaming state.json failed with EPERM while budget admission
// read the same file without the project lock, failing a worker after a successful call.
test('state writes survive concurrent unlocked readers', {timeout: 60_000}, async t => {
  const {memory} = await tempMemory(t);
  await memory.initProject('p');
  await memory.startMission('p', 'm', {goal: 'g'});
  let reading = true;
  const readers = Array.from({length: 4}, async () => {
    while (reading) {
      await memory.getMission('p', 'm');
      await memory.getProject('p');
    }
  });
  const usage = {status: 'success', at: new Date().toISOString(), input_tokens: 1, output_tokens: 1, total_tokens: 2, estimated_cost_usd: 0.001, cost_source: 'configured_price'};
  const writes = [];
  for (let i = 0; i < 60; i++) writes.push(memory.updateMission('p', 'm', {note: i}), memory.recordUsage('p', 'm', usage));
  try {
    await Promise.all(writes);
  } finally {
    reading = false;
    await Promise.all(readers);
  }
  const state = await memory.getMission('p', 'm');
  assert.deepEqual([state.usage.calls, state.sequence, state.usage.cost_usd], [60, 60, 0.06]);
  assert.deepEqual((await fsp.readdir(memory.missionDir('p', 'm'))).filter(name => name.endsWith('.tmp')), []);
});

test('atomic writes retry transient sharing errors and clean up after persistent failure', {timeout: 60_000}, async t => {
  const {memory} = await tempMemory(t);
  await memory.initProject('p');
  const original = fsp.rename;
  let failures = 3;
  fsp.rename = async (...args) => {
    if (failures-- > 0) throw Object.assign(new Error('busy'), {code: 'EPERM'});
    return original(...args);
  };
  try {
    await memory.initProject('p', {branch: 'main'});
  } finally {
    fsp.rename = original;
  }
  assert.equal(failures, -1, 'three transient failures, then success');
  assert.equal((await memory.getProject('p')).branch, 'main');
  fsp.rename = async () => { throw Object.assign(new Error('busy'), {code: 'EBUSY'}); };
  try {
    await assert.rejects(memory.initProject('p', {branch: 'next'}), error => error.code === 'memory_write_failed' && !error.message.includes(memory.root));
  } finally {
    fsp.rename = original;
  }
  assert.equal((await memory.getProject('p')).branch, 'main', 'a failed write keeps the previous state');
  assert.deepEqual((await fsp.readdir(memory.projectDir('p'))).filter(name => name.endsWith('.tmp')), []);
});

test('unexpected worker failures are reported generically, without paths or messages', async t => {
  const {dir, memory} = await tempMemory(t);
  const registry = {p1: {name: 'p1', baseURL: 'http://p1', apiKey: 'x', keyName: 'X', defaultModel: 'm1', tier: 'free-tier', protocol: 'openai', enabled: true}};
  const record = memory.recordAgentResult.bind(memory);
  let failures = 1;
  memory.recordAgentResult = async (...args) => {
    if (failures-- > 0) throw Object.assign(new Error(`EPERM: operation not permitted, rename '${dir}${path.sep}state.json'`), {code: 'EPERM'});
    return record(...args);
  };
  const router = new Router({rotation: ['p1:m1'], policy: 'free-first', maxConcurrency: 2, maxWorkersPerTarget: 2, timeoutMs: 1000, maxContextChars: 20000, maxRetries: 0},
    memory, {registry, caller: async () => ({content: 'ok'})});
  const out = await router.swarmRun({project_id: 'p', mission_id: 'm', goal: 'build', roles: ['architect', 'qa'], max_agents: 2});
  const failed = out.workers.filter(worker => !worker.ok);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].code, 'internal_error');
  assert.equal(JSON.stringify(out).includes(dir), false);
  assert.equal(JSON.stringify(out).includes('EPERM'), false);
});
