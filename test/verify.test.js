import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ProjectMemory} from '../src/memory.js';
import {Router} from '../src/core.js';
import {createMcpHandler} from '../src/mcp.js';
import {createRpcProcessor} from '../src/rpc.js';
import {ProviderError} from '../src/provider-errors.js';
import {catalogCapabilities} from '../src/providers.js';

const API_KEY = 'verify-provider-secret-key-0000';
const CATALOG_MODEL = {id: 'm1', architecture: {input_modalities: ['text', 'image'], output_modalities: ['text']}, supported_parameters: ['temperature', 'max_tokens'],
  context_length: 128_000, top_provider: {max_completion_tokens: 8192}};

async function fixture(t, {caller, cfg = {}} = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dz23-verify-'));
  t.after(() => fsp.rm(dir, {recursive: true, force: true}));
  const memory = new ProjectMemory(dir);
  const cloud = (name, tier) => ({name, baseURL: `http://${name}`, apiKey: API_KEY, keyName: 'KEY', credentialSource: 'env:KEY', defaultModel: 'm1', tier, protocol: 'openai',
    location: 'cloud', capabilities: {text: true, vision: false}, enabled: true, configured: true});
  const registry = {p1: cloud('p1', 'free-tier'), paid: cloud('paid', 'paid'),
    local: {name: 'local', baseURL: 'http://127.0.0.1:1/v1', apiKey: 'local', keyName: 'LOCAL', credentialSource: 'none', defaultModel: 'qwen', tier: 'local', protocol: 'openai',
      location: 'local', capabilities: {text: true}, enabled: true, configured: true}};
  const calls = [];
  const discoveries = [];
  const router = new Router({rotation: ['p1:m1'], policy: 'free-first', maxConcurrency: 2, maxWorkersPerTarget: 2, timeoutMs: 1000, healthTimeoutMs: 1000, maxContextChars: 20000,
    maxRetries: 0, allowPaid: false, ...cfg}, memory, {registry,
    caller: async (target, messages, options) => {
      calls.push({target: `${target.name}:${target.model}`, messages, options});
      return caller ? caller(target) : {content: 'OK', usage: {prompt_tokens: 6, completion_tokens: 1}};
    },
    discoverer: async target => { discoveries.push(target.name); return {ok: true, models: [{id: 'm1', catalog_capabilities: catalogCapabilities(CATALOG_MODEL)}]}; }});
  const handler = createMcpHandler(router, memory);
  return {dir, memory, router, handler, rpc: createRpcProcessor(handler), calls, discoveries};
}

const call = (id, name, args) => ({jsonrpc: '2.0', id, method: 'tools/call', params: {name, arguments: args}});

test('verify_model requires explicit billable confirmation before any call', async t => {
  const {rpc, calls} = await fixture(t);
  const missing = (await rpc(call(1, 'verify_model', {target: 'p1:m1'}))).response.error;
  assert.deepEqual([missing.code, missing.data.field, missing.data.reason], [-32602, 'confirm_billable', 'is required']);
  assert.equal((await rpc(call(2, 'verify_model', {target: 'p1:m1', confirm_billable: false}))).response.error.data.reason, 'must be true');
  assert.equal((await rpc(call(3, 'verify_model', {target: 'auto', confirm_billable: true}))).response.error.data.field, 'target');
  const listed = (await rpc({jsonrpc: '2.0', id: 4, method: 'tools/list'})).response.result.tools.find(tool => tool.name === 'verify_model');
  assert.deepEqual([listed.inputSchema.properties.confirm_billable.const, listed.inputSchema.required], [true, ['target', 'confirm_billable']]);
  assert.equal(calls.length, 0);
});

test('successful verification is minimal, persisted and visible in the inventory', async t => {
  const {dir, handler, calls} = await fixture(t);
  const out = await handler.executeTool('verify_model', {target: 'p1:m1', confirm_billable: true, timeout_ms: 2000, max_output_tokens: 4}, {requestId: 'req-verify-0001'});
  assert.equal(out.ok, true);
  assert.deepEqual([out.value.ok, out.value.inference_verified, out.value.expected_reply, out.value.usage.role, out.value.usage.request_id], [true, true, true, 'verify_model', 'req-verify-0001']);
  assert.deepEqual(calls[0].options, {timeoutMs: 2000, maxTokens: 4, maxResponseBytes: 65_536});
  assert.deepEqual(calls[0].messages, [{role: 'user', content: 'Reply with the single word OK.'}]);
  const stored = (await new ProjectMemory(dir).getProviderStatus()).providers.p1.models[0];
  assert.deepEqual([stored.model, stored.inference_verified, stored.last_success_at], ['m1', true, out.value.verified_at]);
  const inventory = (await handler.executeTool('provider_inventory', {})).value.find(entry => entry.provider === 'p1');
  assert.deepEqual(inventory.status_flags, {configured: true, credential_present: true, credential_required: true, catalog_discovered: false, inference_verified: true});
  assert.equal(inventory.verification.last_verified_at, out.value.verified_at);
  assert.equal(JSON.stringify(inventory).includes(API_KEY), false);
  const localEntry = (await handler.executeTool('provider_inventory', {})).value.find(entry => entry.provider === 'local');
  assert.deepEqual([localEntry.status_flags.credential_present, localEntry.status_flags.credential_required], [false, false]);
});

test('failed verification keeps the last success and returns only classified facts', async t => {
  let fail = false;
  const {router, memory} = await fixture(t, {caller: async target => {
    if (fail) throw new ProviderError({kind: 'authentication_failed', provider: target.name, model: target.model, status: 401});
    return {content: 'OK'};
  }});
  const first = await router.verifyModel({target: 'p1:m1'});
  fail = true;
  const second = await router.verifyModel({target: 'p1:m1'});
  assert.deepEqual([second.ok, second.inference_verified, second.kind, second.retryable, second.http_status], [false, false, 'authentication_failed', false, 401]);
  const record = (await memory.getProviderStatus()).providers.p1.models.find(entry => entry.model === 'm1');
  assert.deepEqual([record.inference_verified, record.last_success_at, record.last_error_kind], [false, first.verified_at, 'authentication_failed']);
  assert.equal(JSON.stringify(second).includes(API_KEY), false);
  assert.equal(router.cooldowns()[0].kind, 'authentication_failed');
});

test('verification respects cost policy and target validity, not rotation membership', async t => {
  const {handler, calls} = await fixture(t);
  const paid = await handler.executeTool('verify_model', {target: 'paid:m1', confirm_billable: true});
  const unknown = await handler.executeTool('verify_model', {target: 'nobody:m', confirm_billable: true});
  assert.deepEqual([paid.error.code, unknown.error.code], ['target_not_allowed', 'target_not_allowed']);
  const local = await handler.executeTool('verify_model', {target: 'local:qwen', confirm_billable: true});
  assert.equal(local.value.ok, true, 'models outside the rotation can be verified before being added');
  const denied = await fixture(t, {cfg: {budget: {policy: 'deny_unknown_cost'}}});
  const blocked = await denied.handler.executeTool('verify_model', {target: 'p1:m1', confirm_billable: true});
  assert.deepEqual([blocked.error.code, blocked.error.details.denials[0].reason], ['budget_exceeded', 'unknown_cost']);
  assert.deepEqual(calls.map(c => c.target), ['local:qwen']);
  assert.equal(denied.calls.length, 0);
});

test('discovery persists catalog status; unknown capabilities stay unknown', async t => {
  const {router, handler, discoveries} = await fixture(t);
  const [p1] = await router.discover({provider: 'p1'});
  const caps = p1.models[0].catalog_capabilities;
  assert.deepEqual([caps.source, caps.text, caps.vision, caps.tools, caps.reasoning, caps.streaming, caps.context_length, caps.max_output_tokens],
    ['catalog', true, true, false, 'unknown', 'unknown', 128_000, 8192]);
  const inventory = (await handler.executeTool('provider_inventory', {})).value.find(entry => entry.provider === 'p1');
  assert.deepEqual([inventory.status_flags.catalog_discovered, inventory.status_flags.inference_verified, inventory.catalog.count], [true, false, 1]);
  const listed = (await handler.executeTool('list_models', {})).value.find(entry => entry.model === 'm1');
  assert.deepEqual([listed.model_capabilities.vision, listed.capabilities.vision, listed.inference_verified], [true, false, false]);
  const blank = catalogCapabilities({id: 'x'});
  assert.deepEqual(Object.values(blank), ['unknown', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown']);
  assert.deepEqual(discoveries, ['p1']);
});

test('nothing billable or networked runs at startup or on read-only tools', async t => {
  const {rpc, calls, discoveries} = await fixture(t);
  await rpc({jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '2025-11-25'}});
  await rpc({jsonrpc: '2.0', id: 2, method: 'tools/list'});
  await rpc(call(3, 'provider_inventory', {}));
  await rpc(call(4, 'list_models', {}));
  assert.deepEqual([calls.length, discoveries.length], [0, 0]);
});
