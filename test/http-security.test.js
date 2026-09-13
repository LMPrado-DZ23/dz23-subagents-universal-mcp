import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {request} from 'node:http';
import {ProjectMemory} from '../src/memory.js';
import {Router} from '../src/core.js';
import {createMcpHandler} from '../src/mcp.js';
import {startHttp, httpSecurityProblem} from '../src/http.js';
import {RateLimiter} from '../src/ratelimit.js';
import {loadMcpToken, loadScopedTokens, createAuthenticator, sha256Hex} from '../src/auth.js';
import {config, parseWeights} from '../src/config.js';
import {ConfigError, RateLimitError} from '../src/errors.js';

const TOKEN = 'http-security-primary-token-for-tests-0000';
const READER_TOKEN = 'http-security-reader-token-for-tests-1111';

async function tempDir(t, prefix = 'dz23-httpsec-') {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fsp.rm(dir, {recursive: true, force: true}));
  return dir;
}

async function serve(t, {cfg = {}, caller} = {}) {
  const dir = await tempDir(t);
  const memory = new ProjectMemory(dir);
  const registry = {local: {name: 'local', baseURL: 'http://fixture.invalid', apiKey: 'local', keyName: 'LOCAL', credentialSource: 'none', defaultModel: 'm',
    tier: 'local', protocol: 'openai', location: 'local', capabilities: {text: true}, enabled: true, configured: true}};
  const full = {host: '127.0.0.1', port: 0, token: TOKEN, rotation: ['local:m'], allowPaid: false, policy: 'free-first', maxConcurrency: 4,
    maxWorkersPerTarget: 4, timeoutMs: 5000, maxContextChars: 20000, ...cfg};
  const calls = {count: 0};
  const router = new Router(full, memory, {registry, caller: async (...args) => { calls.count++; return caller ? caller(...args) : {content: 'ok'}; }});
  const server = await startHttp(full, router, memory, createMcpHandler(router, memory));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const rpc = (body, token = TOKEN) => fetch(`${url}/mcp`, {method: 'POST', body: JSON.stringify(body),
    headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'}});
  return {url, server, calls, memory, rpc};
}

const toolCall = (id, name, args) => ({jsonrpc: '2.0', id, method: 'tools/call', params: {name, arguments: args}});

test('DZ23_MCP_TOKEN_FILE: trailing whitespace trimmed, ambiguity and unreadable files refused', async t => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'token');
  fs.writeFileSync(file, `${TOKEN}\r\n\n`, {mode: 0o600});
  assert.deepEqual(loadMcpToken({DZ23_MCP_TOKEN_FILE: file}), {token: TOKEN, source: 'file:DZ23_MCP_TOKEN_FILE', warnings: []});
  assert.equal(loadMcpToken({DZ23_MCP_TOKEN: TOKEN}).source, 'env:DZ23_MCP_TOKEN');
  assert.throws(() => loadMcpToken({DZ23_MCP_TOKEN: TOKEN, DZ23_MCP_TOKEN_FILE: file}), error => error instanceof ConfigError && /Set only one/.test(error.message) && !error.message.includes(TOKEN));
  assert.throws(() => loadMcpToken({DZ23_MCP_TOKEN_FILE: path.join(dir, 'missing')}), /Cannot read DZ23_MCP_TOKEN_FILE/);
  fs.writeFileSync(path.join(dir, 'blank'), ' \n\t\n');
  assert.throws(() => loadMcpToken({DZ23_MCP_TOKEN_FILE: path.join(dir, 'blank')}), /DZ23_MCP_TOKEN_FILE is empty/);
  fs.writeFileSync(path.join(dir, 'spaced'), 'two words');
  assert.throws(() => loadMcpToken({DZ23_MCP_TOKEN_FILE: path.join(dir, 'spaced')}), /printable ASCII/);
  const cfg = config({DZ23_MCP_TOKEN_FILE: file, DZ23_STATE_DIR: dir});
  assert.equal(cfg.token, TOKEN);
  assert.equal(JSON.stringify(cfg.configIssues).includes(TOKEN), false);
  if (process.platform !== 'win32') {
    fs.chmodSync(file, 0o644);
    assert.match(loadMcpToken({DZ23_MCP_TOKEN_FILE: file}).warnings[0], /chmod 600/);
  }
});

test('scoped token files store digests and are validated strictly', async t => {
  const dir = await tempDir(t);
  const write = content => { const f = path.join(dir, `tokens-${Math.random()}.json`); fs.writeFileSync(f, JSON.stringify(content)); return f; };
  const good = write({tokens: [{id: 'reader', sha256: sha256Hex(READER_TOKEN), scopes: ['memory:read']}]});
  assert.deepEqual(loadScopedTokens({DZ23_AUTH_MODE: 'scoped', DZ23_MCP_TOKENS_FILE: good}).tokens, [{id: 'reader', sha256: sha256Hex(READER_TOKEN), scopes: ['memory:read']}]);
  assert.throws(() => loadScopedTokens({DZ23_AUTH_MODE: 'multi'}), /DZ23_AUTH_MODE must be one of/);
  assert.throws(() => loadScopedTokens({DZ23_AUTH_MODE: 'scoped'}), /requires DZ23_MCP_TOKENS_FILE/);
  assert.throws(() => loadScopedTokens({DZ23_AUTH_MODE: 'scoped', DZ23_MCP_TOKENS_FILE: write({tokens: [{id: 'x', sha256: READER_TOKEN, scopes: ['memory:read']}]})}), /64 lowercase hex/);
  assert.throws(() => loadScopedTokens({DZ23_AUTH_MODE: 'scoped', DZ23_MCP_TOKENS_FILE: write({tokens: [{id: 'x', sha256: sha256Hex('a'), scopes: ['root']}]})}), /subset of/);
  const dup = {id: 'x', sha256: sha256Hex('a'), scopes: ['memory:read']};
  assert.throws(() => loadScopedTokens({DZ23_AUTH_MODE: 'scoped', DZ23_MCP_TOKENS_FILE: write({tokens: [dup, {...dup, id: 'y'}]})}), /duplicates/);
  assert.match(loadScopedTokens({DZ23_MCP_TOKENS_FILE: good}).warnings[0], /ignored/);
});

test('authenticator derives identity and scopes from the token, never from project ids', () => {
  const auth = createAuthenticator({token: TOKEN, scopedTokens: [{id: 'reader', sha256: sha256Hex(READER_TOKEN), scopes: ['memory:read']}]});
  assert.equal(auth.authenticate(`Bearer ${TOKEN}`).identity, 'token:primary');
  assert.equal(auth.authenticate(`Bearer ${TOKEN}`).scopes.has('delegate:execute'), true);
  const reader = auth.authenticate(`Bearer ${READER_TOKEN}`);
  assert.deepEqual([reader.identity, [...reader.scopes]], ['token:reader', ['memory:read']]);
  assert.equal(auth.authenticate('Bearer wrong-token'), null);
  assert.equal(auth.authenticate(TOKEN), null);
  assert.equal(auth.authenticate(undefined), null);
  const open = createAuthenticator({});
  assert.deepEqual([open.required, open.authenticate(undefined, '127.0.0.1').identity], [false, 'ip:127.0.0.1']);
});

test('insecure HTTP binds are refused', () => {
  assert.match(httpSecurityProblem({host: '0.0.0.0'}), /requires DZ23_MCP_TOKEN/);
  assert.match(httpSecurityProblem({host: '0.0.0.0', token: 'short'}), /at least 32/);
  assert.equal(httpSecurityProblem({host: '0.0.0.0', token: TOKEN}), null);
  assert.equal(httpSecurityProblem({host: '0.0.0.0', scopedTokens: [{id: 'a'}]}), null);
  assert.equal(httpSecurityProblem({host: '127.0.0.1'}), null);
  assert.throws(() => parseWeights('delegate:5'), /DZ23_RATE_LIMIT_WEIGHTS/);
  assert.equal(parseWeights('moderate:9').moderate, 9);
});

test('rate limiter: identity and tool buckets refill over the window; concurrency slots release once', () => {
  let now = 0;
  const limiter = new RateLimiter({windowMs: 60_000, points: 20, toolPoints: 10, maxConcurrent: 2, now: () => now});
  limiter.consume('a', {tool: 'delegate', costClass: 'moderate'});
  limiter.consume('a', {tool: 'delegate', costClass: 'moderate'});
  assert.throws(() => limiter.consume('a', {tool: 'delegate', costClass: 'moderate'}), error => error instanceof RateLimitError && error.limit === 'tool' && error.retryAfterMs === 30_000);
  limiter.consume('a', {tool: 'consensus', costClass: 'moderate'});
  limiter.consume('a', {tool: 'swarm_run', costClass: 'moderate'});
  assert.throws(() => limiter.consume('a', {tool: 'other', costClass: 'moderate'}), error => error.limit === 'identity');
  limiter.consume('b', {tool: 'delegate', costClass: 'moderate'});
  now = 30_000;
  limiter.consume('a', {tool: 'delegate', costClass: 'moderate'});
  const first = limiter.acquire('a');
  limiter.acquire('a');
  assert.throws(() => limiter.acquire('a'), error => error.limit === 'concurrency');
  first();
  first();
  assert.equal(limiter.active.get('a'), 1);
  assert.throws(() => limiter.check('b', 100), RateLimitError);
  now = 10 * 60_000;
  const release = limiter.admitTool('c', 'delegate', 'moderate');
  assert.equal(limiter.active.get('c'), 1);
  release();
  assert.equal(limiter.active.has('c'), false);
  // A class heavier than the bucket can never be admitted; its slot is released immediately.
  assert.throws(() => limiter.admitTool('c', 'swarm_run', 'very_expensive'), error => error.retryAfterMs === 60_000);
  assert.equal(limiter.active.has('c'), false);
  const cfg = config({DZ23_RATE_LIMIT_POINTS: '20', DZ23_STATE_DIR: os.tmpdir()});
  assert.ok(cfg.configIssues.some(issue => issue.variable === 'DZ23_RATE_LIMIT_WEIGHTS' && issue.level === 'error'));
});

test('HTTP rate limit returns 429 with Retry-After before any provider call', async t => {
  const {url, calls, rpc} = await serve(t, {cfg: {rateLimit: {enabled: true, windowMs: 60_000, points: 100, toolPoints: 5, maxConcurrent: 4}}});
  const first = await rpc(toolCall(1, 'delegate', {project_id: 'p', mission_id: 'm', prompt: 'x'}));
  assert.equal(first.status, 200);
  assert.equal(calls.count, 1);
  const second = await rpc(toolCall(2, 'delegate', {project_id: 'p', mission_id: 'm', prompt: 'x'}));
  assert.equal(second.status, 429);
  assert.ok(Number(second.headers.get('retry-after')) >= 1);
  const body = await second.json();
  assert.deepEqual([body.id, body.error.code, body.error.data.limit], [2, -32001, 'tool']);
  const rest = await fetch(`${url}/api/delegate`, {method: 'POST', headers: {authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json'}, body: JSON.stringify({prompt: 'x'})});
  assert.equal(rest.status, 429);
  assert.equal(calls.count, 1, 'rejected calls must not reach the provider');
  assert.equal((await rpc(toolCall(3, 'list_models', {}))).status, 200, 'other tools keep their own budget');
});

test('scoped tokens: forbidden tools return 403 before execution; project_id grants nothing', async t => {
  const scopedTokens = [{id: 'reader', sha256: sha256Hex(READER_TOKEN), scopes: ['memory:read']}];
  const {calls, rpc, url} = await serve(t, {cfg: {scopedTokens}});
  const status = await rpc(toolCall(1, 'mission_status', {project_id: 'p', mission_id: 'm'}), READER_TOKEN);
  assert.equal(status.status, 200);
  const denied = await rpc(toolCall(2, 'delegate', {project_id: 'p', mission_id: 'm', prompt: 'x'}), READER_TOKEN);
  assert.equal(denied.status, 403);
  const body = await denied.json();
  assert.deepEqual([body.error.code, body.error.data.required_scopes], [-32002, ['delegate:execute', 'memory:write']]);
  assert.equal((await rpc(toolCall(3, 'project_init', {project_id: 'reader'}), READER_TOKEN)).status, 403);
  assert.equal((await fetch(`${url}/metrics`, {headers: {authorization: `Bearer ${READER_TOKEN}`}})).status, 404);
  assert.equal(calls.count, 0);
  assert.equal((await rpc(toolCall(4, 'delegate', {project_id: 'p', mission_id: 'm', prompt: 'x'}))).status, 200);
  assert.equal(calls.count, 1);
  assert.equal((await rpc(toolCall(5, 'list_models', {}), 'unknown-token-value')).status, 401);
});

test('repeated authentication failures from one address are throttled', async t => {
  const {rpc} = await serve(t, {cfg: {rateLimit: {enabled: true, windowMs: 60_000, points: 10, toolPoints: 10, maxConcurrent: 2}}});
  assert.equal((await rpc({jsonrpc: '2.0', id: 1, method: 'ping'}, 'bad-1')).status, 401);
  assert.equal((await rpc({jsonrpc: '2.0', id: 2, method: 'ping'}, 'bad-2')).status, 401);
  const third = await rpc({jsonrpc: '2.0', id: 3, method: 'ping'}, 'bad-3');
  assert.equal(third.status, 429);
  assert.ok(third.headers.get('retry-after'));
  // Only failing attempts are throttled: a valid token from the same address is never locked out.
  assert.equal((await rpc({jsonrpc: '2.0', id: 4, method: 'ping'})).status, 200);
});

test('in-flight cap answers 503 and releases the slot afterwards', async t => {
  const gate = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const {url, rpc} = await serve(t, {cfg: {http: {maxInflight: 1}}, caller: async () => { entered.resolve(); await gate.promise; return {content: 'late'}; }});
  const slow = rpc(toolCall(1, 'delegate', {project_id: 'p', mission_id: 'm', prompt: 'x'}));
  await entered.promise;
  const busy = await fetch(`${url}/healthz`, {headers: {authorization: `Bearer ${TOKEN}`}});
  assert.deepEqual([busy.status, busy.headers.get('retry-after')], [503, '1']);
  gate.resolve();
  assert.equal((await slow).status, 200);
  assert.equal((await fetch(`${url}/healthz`, {headers: {authorization: `Bearer ${TOKEN}`}})).status, 200);
});

function rawPost(url, {declaredLength, bodyPart}) {
  return new Promise((resolve, reject) => {
    const req = request(`${url}/mcp`, {method: 'POST', headers: {authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'content-length': declaredLength}}, res => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', error => (error.code === 'ECONNRESET' || error.code === 'EPIPE') ? undefined : reject(error));
    if (bodyPart) req.write(bodyPart); else req.flushHeaders();
  });
}

test('oversized and slow request bodies are rejected', async t => {
  const {url} = await serve(t, {cfg: {http: {maxBodyBytes: 16_384, bodyTimeoutMs: 300}}});
  assert.equal(await rawPost(url, {declaredLength: 2_000_000}), 413);
  assert.equal(await rawPost(url, {declaredLength: 100, bodyPart: '{"jsonrpc"'}), 408);
  const type = await fetch(`${url}/api/swarm`, {method: 'POST', headers: {authorization: `Bearer ${TOKEN}`, 'content-type': 'text/plain'}, body: 'goal'});
  assert.equal(type.status, 415);
});

test('graceful shutdown finishes in-flight work and refuses new requests', async t => {
  const gate = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const {url, server, rpc} = await serve(t, {caller: async () => { entered.resolve(); await gate.promise; return {content: 'done'}; }});
  const inflight = rpc(toolCall(1, 'delegate', {project_id: 'p', mission_id: 'm', prompt: 'x'}));
  await entered.promise;
  const closed = server.shutdown(5000);
  const late = await fetch(`${url}/healthz`, {headers: {authorization: `Bearer ${TOKEN}`}}).then(r => r.status, () => 'refused');
  assert.ok(late === 503 || late === 'refused', `unexpected ${late}`);
  gate.resolve();
  const response = await inflight;
  assert.equal(response.status, 200);
  assert.equal((await response.json()).result.isError, undefined);
  await closed;
  assert.equal(server.listening, false);
});
