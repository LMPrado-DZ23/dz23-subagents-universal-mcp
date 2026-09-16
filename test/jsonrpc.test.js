import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {ProjectMemory} from '../src/memory.js';
import {Router} from '../src/core.js';
import {createMcpHandler} from '../src/mcp.js';
import {createRpcProcessor, PARSE_FAILURE} from '../src/rpc.js';
import {startHttp} from '../src/http.js';
import {ToolError} from '../src/errors.js';

const source = fileURLToPath(new URL('../', import.meta.url));
const SECRET = 'synthetic-credential-value-for-tests-only';
const TOKEN = 'jsonrpc-test-token-not-a-real-secret-000';

async function fixture(t, {caller, registry} = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dz23-jsonrpc-'));
  t.after(() => fsp.rm(dir, {recursive: true, force: true}));
  const memory = new ProjectMemory(dir);
  const reg = registry || {local: {name: 'local', baseURL: 'http://fixture.invalid', apiKey: SECRET, keyName: 'LOCAL_KEY', credentialSource: 'env:LOCAL_KEY',
    defaultModel: 'm', tier: 'local', protocol: 'openai', location: 'local', capabilities: {text: true}, enabled: true, configured: true}};
  const cfg = {host: '127.0.0.1', port: 0, token: TOKEN, rotation: [], allowPaid: false, policy: 'free-first', maxConcurrency: 2, maxWorkersPerTarget: 2, timeoutMs: 1000, maxContextChars: 20000};
  const router = new Router(cfg, memory, {registry: reg, caller: caller || (async () => ({content: 'ok'}))});
  const handler = createMcpHandler(router, memory);
  return {dir, memory, cfg, router, handler, process: createRpcProcessor(handler)};
}

const call = (id, name, args) => ({jsonrpc: '2.0', id, method: 'tools/call', params: {name, arguments: args}});

test('JSON-RPC envelope errors use standard codes and never guess an id', async t => {
  const {process} = await fixture(t);
  const parse = await process(PARSE_FAILURE, {requestId: 'req-parse-0001'});
  assert.deepEqual([parse.status, parse.response.id, parse.response.error.code], [400, null, -32700]);
  const batch = await process([{jsonrpc: '2.0', id: 1, method: 'ping'}]);
  assert.deepEqual([batch.response.id, batch.response.error.code, batch.response.error.data.reason], [null, -32600, 'batch requests are not supported']);
  const nullId = await process({jsonrpc: '2.0', id: null, method: 'ping'});
  assert.deepEqual([nullId.response.id, nullId.response.error.code], [null, -32600]);
  const noVersion = await process({id: 7, method: 'ping'});
  assert.deepEqual([noVersion.response.id, noVersion.response.error.code], [7, -32600]);
  const unknown = await process({jsonrpc: '2.0', id: 'abc', method: 'resources/list'});
  assert.deepEqual([unknown.response.id, unknown.response.error.code, unknown.response.error.message], ['abc', -32601, 'Method not found']);
  const badParams = await process({jsonrpc: '2.0', id: 3, method: 'tools/list', params: []});
  assert.equal(badParams.response.error.code, -32602);
});

test('ids 0 and strings are preserved exactly; notifications get no response', async t => {
  const {process} = await fixture(t);
  const zero = await process({jsonrpc: '2.0', id: 0, method: 'ping'});
  assert.equal(zero.response.id, 0);
  assert.deepEqual(zero.response.result, {});
  const text = await process({jsonrpc: '2.0', id: 'id-with-0', method: 'ping'});
  assert.equal(text.response.id, 'id-with-0');
  const note = await process({jsonrpc: '2.0', method: 'notifications/initialized'});
  assert.deepEqual([note.status, note.response], [202, null]);
  const toolNote = await process({jsonrpc: '2.0', method: 'tools/call', params: {name: 'project_init', arguments: {project_id: 'never'}}});
  assert.deepEqual([toolNote.response, toolNote.rejected], [null, 'invalid_notification']);
});

test('initialize negotiates supported revisions and rejects malformed versions', async t => {
  const {process} = await fixture(t);
  const init = async version => (await process({jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: version}})).response;
  assert.equal((await init('2025-06-18')).result.protocolVersion, '2025-06-18');
  const latest = await init('2025-11-25');
  assert.equal(latest.result.protocolVersion, '2025-11-25');
  assert.equal(latest.result.serverInfo.version, JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8')).version);
  assert.deepEqual(latest.result.capabilities, {tools: {listChanged: false}});
  assert.equal((await init('2024-11-05')).result.protocolVersion, '2025-11-25');
  const bad = await init('future-unsupported');
  assert.equal(bad.error.code, -32602);
  assert.equal(bad.error.message, 'Unsupported protocol version');
  assert.deepEqual(bad.error.data.supported, ['2025-11-25', '2025-06-18']);
  assert.equal((await init(undefined)).error.code, -32602);
});

test('tools/call: unknown tool, invalid arguments and valid defaults', async t => {
  const {process, memory} = await fixture(t);
  const unknown = (await process(call(1, 'rm_rf', {}), {requestId: 'req-unknown-01'})).response;
  assert.deepEqual([unknown.error.code, unknown.error.message, unknown.error.data.tool], [-32602, 'Unknown tool', 'rm_rf']);
  const invalid = (await process(call(2, 'delegate', {prompt: 123}), {requestId: 'req-invalid-01'})).response;
  assert.deepEqual(invalid.error, {code: -32602, message: 'Invalid tool arguments', data: {field: 'prompt', reason: 'must be a string', request_id: 'req-invalid-01'}});
  const extra = (await process(call(3, 'list_models', {verbose: true}))).response;
  assert.deepEqual(extra.error.data, {field: 'verbose', reason: 'is not allowed'});
  const ok = (await process(call(4, 'mission_status', {project_id: 'p', mission_id: 'm'}))).response;
  assert.equal(ok.result.isError, undefined);
  assert.deepEqual(ok.result.structuredContent, {state: null, recent_events: [], journal_integrity: {invalid_lines: 0, last_seq: 0}});
  const list = (await process(call(5, 'list_models', {}))).response;
  assert.ok(Array.isArray(list.result.structuredContent.items), 'arrays are wrapped for structuredContent');
  await memory.initProject('p');
});

test('2025-11-25 sessions receive argument errors as tool execution errors', async t => {
  const {process} = await fixture(t);
  const session = {};
  await process({jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '2025-11-25'}}, {session});
  const out = (await process(call(2, 'delegate', {prompt: ''}), {session, requestId: 'req-session-001'})).response;
  assert.equal(out.error, undefined);
  assert.equal(out.result.isError, true);
  assert.deepEqual(out.result.structuredContent.error, {code: 'invalid_arguments', message: 'Invalid tool arguments', request_id: 'req-session-001', details: {field: 'prompt', reason: 'must not be empty'}});
});

test('tool failures are isError results; unexpected failures hide internals', async t => {
  const {process, router} = await fixture(t, {caller: async () => { throw Object.assign(new Error(`HTTP 500 ${SECRET}`), {kind: 'provider_unavailable'}); }});
  const failed = (await process(call(1, 'delegate', {project_id: 'p', mission_id: 'm', prompt: 'x'}), {requestId: 'req-fail-0001'})).response;
  assert.equal(failed.result.isError, true);
  assert.equal(failed.result.structuredContent.error.code, 'all_providers_failed');
  assert.equal(JSON.stringify(failed).includes(SECRET), false, 'adapter messages must not be echoed');
  router.listModels = () => { throw new TypeError(`boom ${SECRET}`); };
  const internal = (await process(call(2, 'list_models', {}), {requestId: 'req-internal-1'})).response;
  assert.deepEqual(internal.error, {code: -32603, message: 'Internal error', data: {request_id: 'req-internal-1'}});
  const inventory = JSON.stringify((await process(call(3, 'provider_inventory', {}))).response);
  assert.equal(inventory.includes(SECRET), false);
});

test('ToolError detail never echoes raw provider bodies', async t => {
  const {handler} = await fixture(t);
  const outcome = await handler.executeTool('delegate', {prompt: 'x', target: 'nope:model'}, {});
  assert.equal(outcome.ok, false);
  assert.ok(outcome.error instanceof ToolError);
  assert.equal(outcome.error.code, 'target_not_allowed');
});

function runStdio(dir, lines) {
  const root = path.join(dir, 'pkg');
  fs.cpSync(path.join(source, 'src'), path.join(root, 'src'), {recursive: true});
  fs.copyFileSync(path.join(source, 'package.json'), path.join(root, 'package.json'));
  const env = {DZ23_STATE_DIR: path.join(dir, 'state'), DZ23_ROTATION: 'custom:m'};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) if (process.env[key] !== undefined) env[key] = process.env[key];
  const result = spawnSync(process.execPath, [path.join(root, 'src', 'index.js'), '--stdio'], {cwd: dir, env, encoding: 'utf8', timeout: 15000, input: `${lines.join('\n')}\n`});
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

test('stdio and HTTP return the same validation error for the same call', async t => {
  const {dir, cfg, router, memory, handler} = await fixture(t);
  const badCall = call(9, 'swarm_run', {goal: 'x', roles: ['qa', 'hacker']});
  const stdio = runStdio(dir, [
    JSON.stringify({jsonrpc: '2.0', id: 0, method: 'initialize', params: {protocolVersion: '2025-06-18'}}),
    JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'}),
    '{not json',
    JSON.stringify(badCall)
  ]);
  assert.equal(stdio.length, 3, 'notification must not produce output');
  // stdio runs requests concurrently since 3.1.0, so responses are matched by id as JSON-RPC requires, not by position.
  const byId = id => stdio.find(message => message.id === id);
  assert.deepEqual([byId(0).id, byId(0).result.protocolVersion], [0, '2025-06-18']);
  assert.equal(byId(null).error.code, -32700);
  const server = await startHttp(cfg, router, memory, handler);
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/mcp`, {method: 'POST', body: JSON.stringify(badCall),
    headers: {authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'mcp-protocol-version': '2025-06-18'}});
  const http = await response.json();
  const strip = error => ({code: error.code, message: error.message, field: error.data.field, reason: error.data.reason});
  assert.deepEqual(strip(http.error), strip(byId(9).error));
  assert.deepEqual(strip(http.error), {code: -32602, message: 'Invalid tool arguments', field: 'roles[1]', reason: 'must be one of: architect, backend, frontend, security, qa, devops, reviewer'});
});

test('HTTP MCP endpoint contract', async t => {
  const {cfg, router, memory, handler} = await fixture(t);
  const server = await startHttp(cfg, router, memory, handler);
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const headers = {authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json'};
  const post = (body, extra = {}) => fetch(`${url}/mcp`, {method: 'POST', headers: {...headers, ...extra}, body: typeof body === 'string' ? body : JSON.stringify(body)});

  const init = await post({jsonrpc: '2.0', id: 'init-1', method: 'initialize', params: {protocolVersion: '2025-06-18'}});
  assert.equal(init.status, 200);
  assert.deepEqual((await init.json()).id, 'init-1');
  const bad = await (await post({jsonrpc: '2.0', id: 2, method: 'initialize', params: {protocolVersion: 'v1'}})).json();
  assert.equal(bad.error.code, -32602);
  const list = await (await post({jsonrpc: '2.0', id: 3, method: 'tools/list'})).json();
  assert.ok(list.result.tools.some(tool => tool.name === 'swarm_run'));
  const valid = await (await post(call(4, 'project_init', {project_id: 'http-proj'}))).json();
  assert.equal(valid.result.structuredContent.project_id, 'http-proj');
  assert.equal((await (await post(call(5, 'project_init', {}))).json()).error.data.field, 'project_id');
  assert.equal((await (await post(call(6, 'nope', {}))).json()).error.message, 'Unknown tool');
  assert.equal((await (await post({jsonrpc: '2.0', id: 7, method: 'nope/method'})).json()).error.code, -32601);
  const note = await post({jsonrpc: '2.0', method: 'notifications/cancelled', params: {requestId: 1}});
  assert.deepEqual([note.status, await note.text()], [202, '']);
  const invalid = await post({id: 8, method: 'ping'});
  assert.deepEqual([invalid.status, (await invalid.json()).error.code], [400, -32600]);
  const parse = await post('{"jsonrpc":');
  assert.deepEqual([parse.status, (await parse.json()).error.code], [400, -32700]);
  const type = await fetch(`${url}/mcp`, {method: 'POST', headers: {authorization: `Bearer ${TOKEN}`, 'content-type': 'text/plain'}, body: '{}'});
  assert.equal(type.status, 415);
  const version = await post({jsonrpc: '2.0', id: 9, method: 'ping'}, {'mcp-protocol-version': '1999-01-01'});
  assert.equal(version.status, 400);
  const correlated = await post({jsonrpc: '2.0', id: 10, method: 'ping'}, {'x-request-id': 'client-correlation-42'});
  assert.equal(correlated.headers.get('x-request-id'), 'client-correlation-42');
  const rest = await fetch(`${url}/api/delegate`, {method: 'POST', headers, body: JSON.stringify({prompt: 5})});
  assert.equal(rest.status, 400);
  const restError = (await rest.json()).error;
  assert.deepEqual([restError.code, restError.details.field, typeof restError.request_id], ['invalid_arguments', 'prompt', 'string']);
  const everything = JSON.stringify(await (await post(call(11, 'provider_inventory', {}))).json());
  assert.equal(everything.includes(SECRET), false);
  assert.equal(everything.includes(TOKEN), false);
});
