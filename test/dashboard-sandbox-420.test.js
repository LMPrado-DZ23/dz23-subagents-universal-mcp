import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {spawnSync} from 'node:child_process';
import {stack} from './helpers-410.js';
import {startDashboard} from '../src/dashboard.js';
import {patchedFiles} from '../src/sandbox.js';

const hasGit = spawnSync('git', ['--version']).status === 0;
const hasDocker = spawnSync('docker', ['info'], {timeout: 15000}).status === 0;

function request(port, {pathname = '/', method = 'GET', headers = {}} = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({host: '127.0.0.1', port, path: pathname, method, headers: {host: `127.0.0.1:${port}`, ...headers}}, res => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body}));
    });
    req.on('error', reject);
    req.end();
  });
}

test('dashboard is read-only, loopback-only, token-protected and never exposes secrets', async t => {
  const s = await stack(t);
  await s.tool('memory_checkpoint', {project_id: 'p', mission_id: 'm', status: 'active', next_action: 'continue'});
  const lease = await s.tool('mission_claim', {project_id: 'p', mission_id: 'm', identity: 'claude-code'});
  await s.tool('memory_checkpoint', {project_id: 'p', mission_id: 'm', status: 'active', lease_token: lease.token});
  const {server, token, url} = await startDashboard({cfg: s.router.cfg, memory: s.memory, router: s.router});
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const port = server.address().port;
  assert.match(url, new RegExp(`^http://127\\.0\\.0\\.1:${port}/#token=`));
  const page = await request(port);
  assert.equal(page.status, 200);
  assert.match(page.headers['content-security-policy'], /default-src 'none'; script-src 'nonce-/);
  assert.equal(page.headers['x-frame-options'], 'DENY');
  assert.doesNotMatch(page.body, /https?:\/\/(?!127)/, 'no external resources');
  assert.doesNotMatch(page.body, /innerHTML/, 'data is rendered with textContent');
  assert.equal((await request(port, {pathname: '/api/overview'})).status, 401);
  assert.equal((await request(port, {pathname: '/api/overview', headers: {authorization: 'Bearer wrong'}})).status, 401);
  assert.equal((await request(port, {headers: {host: 'evil.example'}})).status, 403);
  assert.equal((await request(port, {method: 'POST'})).status, 405);
  const api = await request(port, {pathname: '/api/overview', headers: {authorization: `Bearer ${token}`}});
  assert.equal(api.status, 200);
  const data = JSON.parse(api.body);
  assert.equal(data.missions[0].mission_id, 'm');
  assert.equal(data.leases[0].identity, 'claude-code');
  assert.ok(data.audit.length >= 3);
  assert.equal(api.body.includes(lease.token), false, 'lease tokens are never shown');
  assert.equal(api.body.includes('"apiKey"'), false);
});

async function repo(root) {
  const dir = path.join(root, 'repo');
  await fs.mkdir(dir, {recursive: true});
  await fs.writeFile(path.join(dir, 'value.txt'), 'broken\n');
  await fs.writeFile(path.join(dir, 'check.js'), "const fs = require('fs'); process.exit(fs.readFileSync('value.txt', 'utf8').includes('fixed') ? 0 : 1);\n");
  const git = (...args) => spawnSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=a', ...args], {cwd: dir, encoding: 'utf8'});
  git('init', '-q'); git('add', '.'); git('commit', '-qm', 'init');
  await fs.writeFile(path.join(dir, 'value.txt'), 'fixed\n');
  const fix = git('diff').stdout;
  await fs.writeFile(path.join(dir, 'value.txt'), 'still broken\n');
  const wrong = git('diff').stdout;
  git('checkout', '--', '.');
  return {dir, fix, wrong, git};
}

test('patch paths are checked before anything runs', () => {
  assert.deepEqual(patchedFiles('diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n'), ['src/a.js']);
  for (const bad of ['--- a/.env\n+++ b/.env\n', '--- a/../x\n+++ b/../x\n', 'diff --git a/.git/config b/.git/config\n', '+++ b/C:/Windows/x\n', 'rename to secrets.json\n']) {
    assert.throws(() => patchedFiles(bad), /protected or out-of-tree/, bad);
  }
});

test('patch_validate runs an allowlisted command on a copy and never touches the original tree', {skip: !hasGit}, async t => {
  const s0 = await stack(t);
  const {dir, fix, wrong, git} = await repo(s0.root);
  const commands = ['node check.js', 'node -e "setTimeout(()=>{},60000)"', 'node -e "console.log(process.env.OPENAI_API_KEY||String.fromCharCode(110,111,110,101))"'];
  const off = await stack(t, {cfg: {workspaceRoots: [dir], sandboxEnabled: false, sandboxCommands: commands}});
  assert.equal((await off.rpc('tools/list')).result.tools.some(x => x.name === 'patch_validate'), false, 'disabled by default');
  const s = await stack(t, {cfg: {workspaceRoots: [dir], sandboxEnabled: true, sandboxCommands: commands, sandboxTimeoutMs: 60000, sandboxMode: 'process'}});
  const passed = await s.tool('patch_validate', {workspace: dir, patch: fix, command: 'node check.js'});
  assert.deepEqual([passed.applied, passed.exit_code, passed.passed, passed.files_changed], [true, 0, true, ['value.txt']]);
  assert.equal((await fs.readFile(path.join(dir, 'value.txt'), 'utf8')).trim(), 'broken', 'original file unchanged');
  assert.equal(git('status', '--porcelain').stdout.trim(), '', 'original repository clean');
  const failed = await s.tool('patch_validate', {workspace: dir, patch: wrong, command: 'node check.js'});
  assert.deepEqual([failed.exit_code, failed.passed], [1, false]);
  assert.equal((await s.tool('patch_validate', {workspace: dir, patch: fix, command: 'rm -rf /'})).error.code, 'command_not_allowed');
  assert.equal((await s.tool('patch_validate', {workspace: dir, patch: '--- a/.env\n+++ b/.env\n@@ -0,0 +1 @@\n+X=1\n', command: 'node check.js'})).error.code, 'patch_denied');
  assert.equal((await s.tool('patch_validate', {workspace: dir, patch: fix.replace('broken', 'nonexistent line'), command: 'node check.js'})).error.code, 'patch_rejected');
  process.env.OPENAI_API_KEY = ['sk', 'sandbox', 'leak', 'check', '0'.repeat(12)].join('-');
  t.after(() => { delete process.env.OPENAI_API_KEY; });
  const env = await s.tool('patch_validate', {workspace: dir, patch: fix, command: commands[2]});
  assert.match(env.stdout, /none/, 'provider keys of the server never reach the command');
  const started = Date.now();
  const slow = await s.tool('patch_validate', {workspace: dir, patch: fix, command: commands[1], timeout_ms: 5000});
  assert.equal(slow.timed_out, true);
  assert.ok(Date.now() - started < 30000);
  assert.equal((await fs.readdir(path.dirname(dir))).length >= 1, true);
});

test('patch_validate docker mode runs without network', {skip: !hasGit || !hasDocker}, async t => {
  const image = 'node:22-bookworm-slim';
  const ready = spawnSync('docker', ['image', 'inspect', image], {timeout: 30000}).status === 0 || spawnSync('docker', ['pull', image], {timeout: 240000}).status === 0;
  if (!ready) { t.skip('docker image could not be obtained on this machine'); return; }
  const s0 = await stack(t);
  const {dir, fix} = await repo(s0.root);
  const s = await stack(t, {cfg: {workspaceRoots: [dir], sandboxEnabled: true, sandboxCommands: ['node check.js'], sandboxTimeoutMs: 300000, sandboxMode: 'docker', sandboxImage: 'node:22-bookworm-slim'}});
  const out = await s.tool('patch_validate', {workspace: dir, patch: fix, command: 'node check.js'});
  assert.deepEqual([out.mode, out.network, out.exit_code], ['docker', 'none', 0], out.stderr);
  const offline = await stack(t, {cfg: {workspaceRoots: [dir], sandboxEnabled: true, sandboxCommands: ['node -e "fetch(\'https://example.com\').then(()=>process.exit(0),()=>process.exit(3))"'], sandboxTimeoutMs: 120000, sandboxMode: 'docker', sandboxImage: image}});
  const net = await offline.tool('patch_validate', {workspace: dir, patch: fix, command: 'node -e "fetch(\'https://example.com\').then(()=>process.exit(0),()=>process.exit(3))"'});
  assert.equal(net.exit_code, 3, 'the container has no network');
});
