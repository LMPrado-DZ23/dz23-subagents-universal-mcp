import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {ProjectMemory} from '../src/memory.js';
import {Router} from '../src/core.js';
import {createMcpHandler} from '../src/mcp.js';
import {startHttp} from '../src/http.js';
import {isPrivateEndpoint, modelAllowed} from '../src/targets.js';
import {ToolError} from '../src/errors.js';
import {forbiddenPath} from '../scripts/release-check.mjs';

// Regressions for the third audit round (security and product re-verification).

const source = fileURLToPath(new URL('../', import.meta.url));
const LOCAL = {name: 'local', baseURL: 'http://fixture.invalid', apiKey: 'local', keyName: 'LOCAL', credentialSource: 'none', defaultModel: 'm',
  tier: 'local', protocol: 'openai', location: 'local', capabilities: {text: true}, enabled: true, configured: true};
const BASE = {rotation: ['local:m'], allowPaid: false, policy: 'free-first', maxConcurrency: 4, maxWorkersPerTarget: 4, timeoutMs: 5000, maxContextChars: 20000};

async function tempDir(t, prefix = 'dz23-round3-') {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fsp.rm(dir, {recursive: true, force: true}));
  return dir;
}

test('a mission already at the state cap is refused before any billable call', async t => {
  const memory = new ProjectMemory(await tempDir(t), {maxStateBytes: 3000});
  let calls = 0;
  const router = new Router(BASE, memory, {registry: {local: LOCAL}, caller: async () => { calls++; return {content: 'y'.repeat(2500)}; }});
  assert.equal((await router.delegate({project_id: 'p', mission_id: 'm', prompt: 'first'})).ok, true);
  await assert.rejects(router.delegate({project_id: 'p', mission_id: 'm', prompt: 'second'}), error => error instanceof ToolError && error.code === 'memory_limit_exceeded');
  assert.equal(calls, 1, 'the refused delegate must not call the provider');
});

test('the local model exemption follows the endpoint address, not the provider name', () => {
  for (const url of ['http://127.0.0.1:11434/v1', 'http://localhost:1234/v1', 'http://[::1]:8000/v1', 'http://192.168.1.20:8000/v1',
    'http://10.0.0.5/v1', 'http://172.20.0.2:4000/v1', 'http://host.docker.internal:11434/v1']) assert.equal(isPrivateEndpoint(url), true, url);
  for (const url of ['https://api.openai.com/v1', 'http://172.32.0.1/v1', 'http://8.8.8.8/v1', 'not a url', '']) assert.equal(isPrivateEndpoint(url), false, url);
  const custom = {...LOCAL, name: 'custom', defaultModel: 'qwen3-coder', model: 'gpt-4o'};
  assert.equal(modelAllowed({...custom, baseURL: 'https://api.openai.com/v1'}, {rotation: []}), false);
  assert.equal(modelAllowed({...custom, baseURL: 'http://127.0.0.1:11434/v1'}, {rotation: []}), true);
});

test('HTTP closes connections that never send a byte after the headers timeout', async t => {
  const memory = new ProjectMemory(await tempDir(t));
  const cfg = {...BASE, host: '127.0.0.1', port: 0, token: 'round3-idle-connection-token-000000000000', http: {headersTimeoutMs: 1000}};
  const router = new Router(cfg, memory, {registry: {local: LOCAL}, caller: async () => ({content: 'ok'})});
  const server = await startHttp(cfg, router, memory, createMcpHandler(router, memory));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const port = server.address().port;
  const started = Date.now();
  const socket = net.connect(port, '127.0.0.1');
  socket.resume(); // flowing mode, so the server-side close surfaces as end/close on the client
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('idle socket was not closed')); }, 8000);
    const done = () => { clearTimeout(timer); resolve(); };
    socket.once('close', done);
    socket.once('error', done);
  });
  assert.ok(Date.now() - started < 8000);
  const ok = await fetch(`http://127.0.0.1:${port}/healthz`, {headers: {authorization: `Bearer ${cfg.token}`}});
  assert.equal(ok.status, 200);
});

test('release guard rejects common credential file names', () => {
  for (const name of ['tokens.txt', 'token.json', 'api-token.txt', 'credentials.yaml', 'service-account.json', 'gcp-key.json',
    'id_rsa', '.npmrc', '.netrc', '.git-credentials', 'auth.json', 'config/mcp-tokens.json']) assert.equal(forbiddenPath(name), true, name);
  for (const name of ['config/examples/scoped-tokens.example.json', 'src/auth.js', 'docs/SECURITY_AND_SECRETS.md', 'test/audit-round3.test.js']) {
    assert.equal(forbiddenPath(name), false, name);
  }
});

async function packageCopy(t) {
  const dir = await tempDir(t, 'dz23-round3-cli-');
  fs.cpSync(path.join(source, 'src'), path.join(dir, 'pkg', 'src'), {recursive: true});
  fs.copyFileSync(path.join(source, 'package.json'), path.join(dir, 'pkg', 'package.json'));
  const env = {DZ23_STATE_DIR: path.join(dir, 'state')};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) if (process.env[key] !== undefined) env[key] = process.env[key];
  return (args, {extraEnv = {}} = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(dir, 'pkg', 'src', 'index.js'), ...args], {cwd: dir, env: {...env, ...extraEnv}});
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`timed out: ${args.join(' ')} ${JSON.stringify(extraEnv)}`)); }, 20_000);
    child.on('close', status => { clearTimeout(timer); resolve({status, stdout, stderr}); });
    child.stdin.end();
  });
}

test('startup configuration problems exit 78 without a stack trace; CLI errors stay JSON', async t => {
  const run = await packageCopy(t);
  const cases = [
    [['--stdio'], {DZ23_ROTATION: 'nosuch:model'}],
    [['--stdio'], {CUSTOM_BASE_URL: 'ftp://example.invalid'}],
    [['--http'], {DZ23_ALLOW_HTTP: 'true', DZ23_HTTP_HOST: '0.0.0.0', DZ23_MCP_TOKEN: 'short'}],
    [['--http'], {DZ23_ALLOW_HTTP: 'true', DZ23_HTTP_HOST: '0.0.0.0'}]
  ];
  for (const [args, extraEnv] of cases) {
    const result = await run(args, {extraEnv});
    assert.equal(result.status, 78, `${JSON.stringify(extraEnv)} stderr=${result.stderr.slice(0, 300)}`);
    assert.doesNotMatch(result.stderr, /\n\s+at /, 'no stack trace');
    assert.equal(result.stdout, '');
  }
  const validate = await run(['config', 'validate', '--json'], {extraEnv: {DZ23_ALLOW_HTTP: 'true', DZ23_HTTP_HOST: '0.0.0.0'}});
  assert.notEqual(validate.status, 0);
  assert.match(validate.stdout, /Non-loopback HTTP/);
  const show = await run(['missions', 'show', 'p1', 'm1', '--json']);
  assert.deepEqual([show.status, JSON.parse(show.stdout).error.code], [1, 'mission_not_found']);
});
