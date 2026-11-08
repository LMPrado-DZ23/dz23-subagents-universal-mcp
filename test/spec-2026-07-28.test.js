import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ProjectMemory} from '../src/memory.js';
import {Router} from '../src/core.js';
import {createMcpHandler} from '../src/mcp.js';
import {createRpcProcessor} from '../src/rpc.js';

const SECRET = 'synthetic-credential-value-for-tests-only';
const TOKEN = 'cache-hint-test-token-not-a-real-secret-000';

async function fixture(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dz23-cache-hints-'));
  t.after(() => fsp.rm(dir, {recursive: true, force: true}));
  const memory = new ProjectMemory(dir);
  const registry = {local: {name: 'local', baseURL: 'http://fixture.invalid', apiKey: SECRET, keyName: 'LOCAL_KEY',
    credentialSource: 'env:LOCAL_KEY', defaultModel: 'm', tier: 'local', protocol: 'openai', location: 'local',
    capabilities: {text: true}, enabled: true, configured: true}};
  const cfg = {host: '127.0.0.1', port: 0, token: TOKEN, rotation: [], allowPaid: false, policy: 'free-first',
    maxConcurrency: 2, maxWorkersPerTarget: 2, timeoutMs: 1000, maxContextChars: 20000};
  const router = new Router(cfg, memory, {registry, caller: async () => ({content: 'ok'})});
  const process = createRpcProcessor(createMcpHandler(router, memory));
  return {memory, process};
}

/** Initialize a session and keep the context the handler mutates. */
async function openSession(process, protocolVersion) {
  const ctx = {session: {}};
  await process({jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion}}, ctx);
  return ctx;
}

async function checkpoint(process, ctx) {
  const res = await process({jsonrpc: '2.0', id: 9, method: 'tools/call',
    params: {name: 'memory_checkpoint', arguments: {project_id: 'cachehints', mission_id: 'probe', status: 'active'}}}, ctx);
  assert.equal(res.response.result.isError, undefined);
}

test('tools/list carries cache hints on 2026-07-28', async t => {
  const {process} = await fixture(t);
  const ctx = await openSession(process, '2026-07-28');
  const result = (await process({jsonrpc: '2.0', id: 2, method: 'tools/list'}, ctx)).response.result;
  assert.equal(result.ttlMs, 30_000);
  assert.equal(result.cacheScope, 'private');
  assert.ok(Array.isArray(result.tools));
});

test('resources/list carries cache hints on 2026-07-28', async t => {
  const {process} = await fixture(t);
  const ctx = await openSession(process, '2026-07-28');
  await checkpoint(process, ctx);
  const result = (await process({jsonrpc: '2.0', id: 3, method: 'resources/list'}, ctx)).response.result;
  assert.equal(result.ttlMs, 60_000);
  assert.equal(result.cacheScope, 'private');
});

test('prompts/list carries public cache hints on 2026-07-28', async t => {
  const {process} = await fixture(t);
  const ctx = await openSession(process, '2026-07-28');
  const result = (await process({jsonrpc: '2.0', id: 4, method: 'prompts/list'}, ctx)).response.result;
  assert.equal(result.ttlMs, 60_000);
  assert.equal(result.cacheScope, 'public');
});

test('resources/read carries ttlMs 0 on 2026-07-28', async t => {
  const {process} = await fixture(t);
  const ctx = await openSession(process, '2026-07-28');
  await checkpoint(process, ctx);
  const result = (await process({jsonrpc: '2.0', id: 5, method: 'resources/read',
    params: {uri: 'dz23://mission/cachehints/probe'}}, ctx)).response.result;
  assert.equal(result.ttlMs, 0);
  assert.equal(result.cacheScope, 'private');
  assert.ok(Array.isArray(result.contents));
});

test('older revisions keep the plain result without cache hints', async t => {
  const {process} = await fixture(t);
  const ctx = await openSession(process, '2025-11-25');
  const result = (await process({jsonrpc: '2.0', id: 6, method: 'tools/list'}, ctx)).response.result;
  assert.equal('ttlMs' in result, false);
  assert.equal('cacheScope' in result, false);
});

test('structured tools expose an object outputSchema', async t => {
  const {process} = await fixture(t);
  const ctx = await openSession(process, '2026-07-28');
  const {tools} = (await process({jsonrpc: '2.0', id: 7, method: 'tools/list'}, ctx)).response.result;
  const byName = new Map(tools.map(tool => [tool.name, tool]));
  for (const name of ['list_models', 'provider_inventory', 'mission_status', 'routing_explain', 'cost_estimate', 'account_status']) {
    const tool = byName.get(name);
    assert.ok(tool, `${name} is listed`);
    assert.equal(tool.outputSchema?.type, 'object', `${name} has an object outputSchema`);
    assert.ok(tool.inputSchema, `${name} kept its inputSchema`);
    assert.ok(tool.annotations, `${name} kept its annotations`);
  }
  assert.equal(tools.filter(tool => tool.outputSchema).length >= 6, true);
});
