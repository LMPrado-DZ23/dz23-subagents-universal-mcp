import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {request} from 'node:http';
import {ProjectMemory} from '../src/memory.js';
import {Router} from '../src/core.js';
import {createMcpHandler} from '../src/mcp.js';
import {startHttp} from '../src/http.js';
import {isPrivateEndpoint} from '../src/targets.js';
import {forbiddenPath} from '../scripts/release-check.mjs';

// Security regressions for the fourth audit round (re-verification of round 2/3).

const LOCAL = {name: 'local', baseURL: 'http://127.0.0.1:9/v1', apiKey: 'local', keyName: 'LOCAL', credentialSource: 'none', defaultModel: 'm',
  tier: 'local', protocol: 'openai', location: 'local', capabilities: {text: true}, enabled: true, configured: true};
const TOKEN = 'round4-security-token-00000000000000000000';

async function tempDir(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dz23-round4-sec-'));
  t.after(() => fsp.rm(dir, {recursive: true, force: true}));
  return dir;
}

async function serve(t) {
  const memory = new ProjectMemory(await tempDir(t));
  const cfg = {rotation: ['local:m'], allowPaid: false, policy: 'free-first', maxConcurrency: 4, maxWorkersPerTarget: 4, timeoutMs: 5000, maxContextChars: 20000,
    host: '127.0.0.1', port: 0, token: TOKEN, http: {headersTimeoutMs: 1000}};
  const router = new Router(cfg, memory, {registry: {local: LOCAL}, caller: async () => ({content: 'ok'})});
  const server = await startHttp(cfg, router, memory, createMcpHandler(router, memory));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return server.address().port;
}

function closesWithin(socket, ms) {
  socket.resume();
  return new Promise(resolve => {
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, ms);
    const done = () => { clearTimeout(timer); resolve(true); };
    socket.once('close', done);
    socket.once('error', done);
  });
}

test('byte-trickle connections that never complete request headers are closed', async t => {
  const port = await serve(t);
  const oneByte = net.connect(port, '127.0.0.1', () => oneByte.write('G'));
  const partialHeaders = net.connect(port, '127.0.0.1', () => partialHeaders.write('GET /healthz HTTP/1.1\r\nHost: 127.0.0.1\r\n'));
  const [first, second] = await Promise.all([closesWithin(oneByte, 8000), closesWithin(partialHeaders, 8000)]);
  assert.deepEqual([first, second], [true, true]);
});

test('responses to unauthenticated requests close the connection; authenticated ones may keep it', async t => {
  const port = await serve(t);
  const get = headers => new Promise((resolve, reject) => {
    const req = request({host: '127.0.0.1', port, path: '/healthz', headers: {connection: 'keep-alive', ...headers}}, res => {
      res.resume();
      res.on('end', () => resolve({status: res.statusCode, connection: res.headers.connection}));
    });
    req.on('error', reject);
    req.end();
  });
  assert.deepEqual(await get({}), {status: 401, connection: 'close'});
  assert.deepEqual(await get({authorization: 'Bearer wrong-token-wrong-token-wrong-token-00'}), {status: 401, connection: 'close'});
  const ok = await get({authorization: `Bearer ${TOKEN}`});
  assert.equal(ok.status, 200);
  assert.notEqual(ok.connection, 'close');
});

test('private endpoint detection parses addresses instead of matching hostname text', () => {
  for (const url of ['http://127.0.0.1:11434/v1', 'http://10.1.2.3/v1', 'http://172.31.255.1/v1', 'http://192.168.0.9/v1', 'http://[::1]:8000/v1',
    'http://[fd12:3456::1]/v1', 'http://localhost:1234/v1', 'http://host.docker.internal:11434/v1', 'http://ollama:11434/v1', 'http://gpu-box.local:8000/v1']) {
    assert.equal(isPrivateEndpoint(url), true, url);
  }
  for (const url of ['http://10.0.0.1.evil.com/v1', 'http://127.0.0.1.nip.io/v1', 'http://evil.localhost/v1', 'http://172.15.0.1/v1',
    'http://192.169.0.1/v1', 'https://api.openai.com/v1', 'http://[2001:db8::1]/v1']) {
    assert.equal(isPrivateEndpoint(url), false, url);
  }
});

test('case aliases are still refused when the exact id was cached by another store instance', async t => {
  const root = await tempDir(t);
  const writer = new ProjectMemory(root);
  const reader = new ProjectMemory(root);
  for (const memory of [writer, reader]) memory.caseProbe = Promise.resolve(true);
  await writer.recordCheckpoint('proj', 'm', {decisions: ['a']});
  assert.deepEqual((await reader.getMission('proj', 'm')).decisions, ['a']);
  assert.deepEqual((await reader.getMission('proj', 'm')).decisions, ['a'], 'second lookup served from the known-id cache');
  await assert.rejects(reader.getMission('PROJ', 'm'), error => error.code === 'invalid_request');
  await assert.rejects(reader.getMission('proj', 'M'), error => error.code === 'invalid_request');
});

test('release guard covers additional credential file names', () => {
  for (const name of ['apikey.txt', 'api_keys.json', 'gcp-key.yaml', '.pgpass', '.htpasswd', 'kubeconfig', 'release.jks', 'app.keystore']) {
    assert.equal(forbiddenPath(name), true, name);
  }
  for (const name of ['config/examples/prices.example.json', 'src/targets.js', 'docs/OPERATIONS.md']) assert.equal(forbiddenPath(name), false, name);
});
