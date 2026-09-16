import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createLogger} from '../src/logger.js';
import {redact} from '../src/redact.js';
import {Metrics} from '../src/metrics.js';
import {ProjectMemory} from '../src/memory.js';
import {Router} from '../src/core.js';
import {createMcpHandler} from '../src/mcp.js';
import {startHttp} from '../src/http.js';
import {ProviderError} from '../src/provider-errors.js';
import {sha256Hex} from '../src/auth.js';

const source = fileURLToPath(new URL('../', import.meta.url));
const API_KEY = 'observability-api-key-secret-0000';
const TOKEN = 'observability-http-token-for-tests-00000';

function capture(level = 'debug') {
  const lines = [];
  const logger = createLogger({level, sink: line => lines.push(line)});
  return {logger, lines, entries: () => lines.map(line => JSON.parse(line))};
}

test('logger writes JSON lines, filters by level and redacts sensitive data', () => {
  const {logger, entries, lines} = capture('info');
  logger.addSecrets([API_KEY, 'local', 'short']);
  logger.debug('hidden', {x: 1});
  logger.info('provider_call_completed', {request_id: 'r1', provider: 'p', apiKey: API_KEY, prompt: 'do the thing', headers: {authorization: 'Bearer abc'},
    error: `upstream echoed ${API_KEY} and Bearer ${TOKEN} and sk-${'a'.repeat(30)}`, long: 'z'.repeat(900)});
  logger.child({project_id: 'proj'}).warn('child_event', {status: 'failed'});
  const [first, second] = entries();
  assert.equal(lines.length, 2);
  assert.deepEqual([first.level, first.event, first.request_id, first.provider], ['info', 'provider_call_completed', 'r1', 'p']);
  assert.deepEqual([first.apiKey, first.prompt, first.headers], ['[REDACTED]', '[REDACTED]', '[REDACTED]']);
  assert.equal(first.error.includes(API_KEY) || first.error.includes(TOKEN) || first.error.includes('sk-aaa'), false);
  assert.ok(first.long.length < 600);
  assert.deepEqual([second.project_id, second.status], ['proj', 'failed']);
  assert.ok(Date.parse(first.ts));
  assert.deepEqual(redact({nested: [{token: 't', ok: 1}], err: new Error(API_KEY)}), {nested: [{token: '[REDACTED]', ok: 1}], err: {name: 'Error'}});
});

async function observedRouter(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dz23-observe-'));
  t.after(() => fsp.rm(dir, {recursive: true, force: true}));
  const registry = {
    p1: {name: 'p1', baseURL: 'http://p1', apiKey: API_KEY, keyName: 'X', credentialSource: 'env:X', defaultModel: 'm1', tier: 'free-tier', protocol: 'openai', enabled: true, configured: true},
    p2: {name: 'p2', baseURL: 'http://p2', apiKey: API_KEY, keyName: 'X', credentialSource: 'env:X', defaultModel: 'm2', tier: 'free-tier', protocol: 'openai', enabled: true, configured: true}
  };
  const {logger, lines, entries} = capture('debug');
  const metrics = new Metrics();
  const memory = new ProjectMemory(dir);
  const caller = async target => {
    if (target.name === 'p1') throw new ProviderError({kind: 'rate_limited', provider: 'p1', model: 'm1', status: 429});
    return {content: 'OUTPUT-MARKER-5512'};
  };
  const cfg = {rotation: ['p1:m1', 'p2:m2'], policy: 'free-first', maxConcurrency: 2, maxWorkersPerTarget: 2, timeoutMs: 1000, maxContextChars: 20000, maxRetries: 0, host: '127.0.0.1', port: 0, token: TOKEN};
  const router = new Router(cfg, memory, {registry, caller, logger, metrics});
  const handler = createMcpHandler(router, memory, {logger, metrics});
  return {cfg, router, memory, handler, metrics, logger, lines, entries};
}

test('request_id propagates to logs, journal and results without prompts, outputs or keys', async t => {
  const {handler, memory, metrics, lines, entries} = await observedRouter(t);
  const outcome = await handler.executeTool('delegate', {project_id: 'p', mission_id: 'm', prompt: 'PROMPT-MARKER-7781'}, {requestId: 'req-observe-0001', transport: 'test', identity: 'tester'});
  assert.equal(outcome.ok, true);
  assert.deepEqual([outcome.value.provider, outcome.value.request_id], ['p2', 'req-observe-0001']);
  const text = lines.join('\n');
  for (const marker of ['PROMPT-MARKER-7781', 'OUTPUT-MARKER-5512', API_KEY]) assert.equal(text.includes(marker), false, marker);
  const byEvent = name => entries().filter(entry => entry.event === name);
  assert.equal(byEvent('provider_call_failed')[0].kind, 'rate_limited');
  for (const name of ['provider_call_failed', 'provider_call_completed', 'provider_failover', 'tool_call_completed']) {
    assert.ok(byEvent(name).length, name);
    assert.ok(byEvent(name).every(entry => entry.request_id === 'req-observe-0001'), name);
  }
  const done = byEvent('tool_call_completed')[0];
  assert.deepEqual([done.tool, done.status, done.identity, done.transport], ['delegate', 'ok', 'tester', 'test']);
  assert.equal(typeof done.duration_ms, 'number');
  const journal = await memory.recentEvents('p', 'm', 50);
  for (const type of ['delegation_started', 'agent_attempt', 'provider_failed', 'delegation_completed']) {
    assert.ok(journal.some(event => event.type === type && event.payload.request_id === 'req-observe-0001'), type);
  }
  const snapshot = metrics.snapshot();
  assert.equal(metrics.counter('failovers_total'), 1);
  assert.equal(metrics.counter('provider_failures_total', {kind: 'rate_limited'}), 1);
  assert.equal(metrics.counter('delegations_total', {role: 'worker'}), 1);
  assert.equal(metrics.counter('tool_calls_total', {tool: 'delegate', status: 'ok'}), 1);
  assert.equal(snapshot.gauges.active_calls, 0);
  assert.equal(snapshot.gauges.queue_depth, 0);
  assert.deepEqual(snapshot.gauges.provider_cooldowns.map(c => [c.target, c.kind]), [['p1:m1', 'rate_limited']]);
  assert.equal(snapshot.latency_ewma['p2:m2'].samples, 1);
  assert.equal(JSON.stringify(snapshot).includes(API_KEY), false);
});

test('tool failures and rejections are logged with status and error code only', async t => {
  const {handler, entries} = await observedRouter(t);
  const failed = await handler.executeTool('delegate', {prompt: 'x', target: 'unknown:model'}, {requestId: 'req-observe-0002'});
  assert.equal(failed.ok, false);
  await assert.rejects(handler.executeTool('delegate', {prompt: 1}, {requestId: 'req-observe-0003'}));
  const logged = entries().filter(entry => entry.event === 'tool_call_completed');
  assert.deepEqual(logged.map(entry => [entry.request_id, entry.level, entry.status, entry.error_code]), [
    ['req-observe-0002', 'warn', 'tool_error', 'target_not_allowed'],
    ['req-observe-0003', 'warn', 'invalid_arguments', undefined]
  ]);
});

test('/metrics requires admin:inventory and returns the process snapshot', async t => {
  const {cfg, router, memory, handler, metrics, logger} = await observedRouter(t);
  const reader = 'observability-reader-token-for-tests-0000';
  const server = await startHttp({...cfg, scopedTokens: [{id: 'reader', sha256: sha256Hex(reader), scopes: ['memory:read']}]}, router, memory, handler, {metrics, logger});
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const url = `http://127.0.0.1:${server.address().port}/metrics`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, {headers: {authorization: `Bearer ${reader}`}})).status, 403);
  const response = await fetch(url, {headers: {authorization: `Bearer ${TOKEN}`, 'x-request-id': 'req-metrics-0001'}});
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-request-id'), 'req-metrics-0001');
  const body = await response.json();
  assert.equal(body.scope, 'process');
  assert.ok('active_calls' in body.gauges);
  assert.equal(JSON.stringify(body).includes(TOKEN), false);
});

test('stdio assigns a distinct request_id per message and keeps stdout protocol-only', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dz23-observe-stdio-'));
  t.after(() => fsp.rm(dir, {recursive: true, force: true}));
  const root = path.join(dir, 'pkg');
  fs.cpSync(path.join(source, 'src'), path.join(root, 'src'), {recursive: true});
  fs.copyFileSync(path.join(source, 'package.json'), path.join(root, 'package.json'));
  const env = {DZ23_STATE_DIR: path.join(dir, 'state'), DZ23_LOG_LEVEL: 'info', CUSTOM_API_KEY: API_KEY};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) if (process.env[key] !== undefined) env[key] = process.env[key];
  const messages = [
    {jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '2025-06-18'}},
    {jsonrpc: '2.0', id: 2, method: 'tools/call', params: {name: 'project_init', arguments: {project_id: 'a'}}},
    {jsonrpc: '2.0', id: 3, method: 'tools/call', params: {name: 'provider_inventory', arguments: {}}}
  ];
  const result = spawnSync(process.execPath, [path.join(root, 'src', 'index.js'), '--stdio'], {cwd: dir, env, encoding: 'utf8', timeout: 15000, input: `${messages.map(m => JSON.stringify(m)).join('\n')}\n`});
  assert.equal(result.status, 0, result.stderr);
  const stdout = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  // Concurrent stdio (3.1.0) writes responses as they complete; every request is still answered exactly once.
  assert.deepEqual(stdout.map(r => r.id).sort(), [1, 2, 3]);
  const logs = result.stderr.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const calls = logs.filter(entry => entry.event === 'tool_call_completed');
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].request_id, calls[1].request_id);
  assert.ok(logs.some(entry => entry.event === 'server_started' && entry.transport === 'stdio'));
  assert.equal(result.stderr.includes(API_KEY), false);
  assert.equal(result.stdout.includes(API_KEY), false);
});
