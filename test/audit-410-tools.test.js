import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {stack, entry, lastUserText} from './helpers-410.js';
import {maskSensitive} from '../src/privacy.js';
import {verifyAudit} from '../src/audit-log.js';

const hasGit = spawnSync('git', ['--version']).status === 0;

async function project(root) {
  const dir = path.join(root, 'proj');
  await fs.mkdir(path.join(dir, 'src'), {recursive: true});
  await fs.writeFile(path.join(dir, 'src', 'app.js'), 'export const timeoutMs = 12345678; // 1789421559128\n');
  return dir;
}

test('4.0.0 contract: delegate returns the full answer unless the caller asks for less', async t => {
  const long = 'x'.repeat(20000);
  const s = await stack(t, {caller: async () => ({content: long})});
  assert.equal((await s.tool('delegate', {project_id: 'p', mission_id: 'm', prompt: 'go'})).content.length, 20000);
  const brief = await s.tool('delegate', {project_id: 'p', mission_id: 'm', prompt: 'go', detail: 'brief'});
  assert.equal(brief.content.length, 2000);
  assert.equal(brief.truncated, true);
});

test('output_schema keeps the swarm integration and consensus synthesis instead of erasing them', async t => {
  const s = await stack(t, {caller: async () => ({content: '```json\n{"verdict":"ok"}\n```'})});
  const schema = {type: 'object', required: ['verdict'], properties: {verdict: {type: 'string'}}};
  const swarm = await s.tool('swarm_run', {project_id: 'p', mission_id: 'm', goal: 'g', roles: ['qa'], output_schema: schema});
  assert.equal(swarm.integration.provider !== undefined, true);
  assert.deepEqual(swarm.integration.structured_output, {verdict: 'ok'});
  const consensus = await s.tool('consensus', {project_id: 'p', mission_id: 'c', prompt: 'q', models: 2, output_schema: schema});
  assert.ok(consensus.synthesis && consensus.synthesis.agreement, 'heuristic synthesis survives');
  assert.deepEqual(consensus.responses.map(r => r.structured_output), [{verdict: 'ok'}, {verdict: 'ok'}]);
});

test('idempotency keys are scoped to the caller and arguments, and a reused key cannot return another prompt', async t => {
  const s = await stack(t);
  const first = await s.tool('delegate', {project_id: 'p', mission_id: 'm', prompt: 'one', idempotency_key: 'key-000001'});
  const again = await s.tool('delegate', {project_id: 'p', mission_id: 'm', prompt: 'one', idempotency_key: 'key-000001'});
  assert.equal(s.calls.length, 1);
  assert.equal(again.content, first.content);
  const conflict = await s.tool('delegate', {project_id: 'p', mission_id: 'm', prompt: 'two', idempotency_key: 'key-000001'});
  assert.equal(conflict.error.code, 'idempotency_conflict');
  await s.tool('delegate', {project_id: 'p', mission_id: 'm', prompt: 'one', idempotency_key: 'key-000001'}, {identity: 'token:other'});
  assert.equal(s.calls.length, 2, 'another identity never receives the first caller result');
});

test('the response cache respects detail and reports when it is disabled', async t => {
  const s = await stack(t, {caller: async () => ({content: 'y'.repeat(5000)}), cfg: {responseCacheTtlMs: 60000}});
  await s.tool('delegate', {prompt: 'same', detail: 'brief', cache: true});
  const full = await s.tool('delegate', {prompt: 'same', cache: true});
  assert.equal(full.content.length, 5000);
  const off = await stack(t, {cfg: {responseCacheTtlMs: 0}});
  assert.equal((await off.tool('delegate', {prompt: 'x', cache: true})).cache_status, 'disabled');
});

test('workspace tools are listed only when DZ23_WORKSPACE_ROOTS is configured', async t => {
  const off = await stack(t);
  const names = (await off.rpc('tools/list')).result.tools.map(x => x.name);
  assert.equal(names.includes('workspace_read'), false);
  assert.ok(['delegate', 'consensus', 'swarm_run', 'mission_status', 'memory_checkpoint', 'health_check', 'verify_model', 'list_models', 'provider_inventory',
    'discover_models', 'project_init'].every(name => names.includes(name)), 'all 11 tools of 4.0.0 remain');
  const on = await stack(t, {cfg: {workspaceRoots: [off.root]}});
  assert.ok((await on.rpc('tools/list')).result.tools.some(x => x.name === 'workspace_read'));
});

test('workspace reads block credential files and mask secrets inside allowed files', async t => {
  const s0 = await stack(t);
  const dir = await project(s0.root);
  const s = await stack(t, {cfg: {workspaceRoots: [dir]}});
  for (const name of ['.npmrc', '.git-credentials', '.netrc', 'cert.pfx', 'prod.env', 'id_ed25519']) {
    await fs.writeFile(path.join(dir, name), 'token=abc');
    assert.equal((await s.tool('workspace_read', {workspace: dir, path: name})).error?.code, 'workspace_denied', name);
  }
  const key = ['sk-', 'proj', 'A'.repeat(30)].join('');
  await fs.writeFile(path.join(dir, 'src', 'config.js'), `export const key = "${key}";\n`);
  const read = await s.tool('workspace_read', {workspace: dir, path: 'src/config.js'});
  assert.doesNotMatch(read.content, new RegExp(key));
  const listing = await s.tool('workspace_read', {workspace: dir, path: '.'});
  assert.equal(listing.entries.some(e => e.name === '.npmrc'), false, 'protected names are not listed');
});

test('workspace search scans every allowed file and a catastrophic regex cannot freeze the server', async t => {
  const s0 = await stack(t);
  const dir = await project(s0.root);
  for (let i = 0; i < 300; i++) await fs.writeFile(path.join(dir, 'src', `f${String(i).padStart(3, '0')}.txt`), i === 299 ? 'needle here' : 'hay');
  const s = await stack(t, {cfg: {workspaceRoots: [dir]}});
  const found = await s.tool('workspace_search', {workspace: dir, query: 'needle', max_results: 1});
  assert.equal(found.results.length, 1);
  await fs.writeFile(path.join(dir, 'src', 'evil.txt'), `${'a'.repeat(40)}!`);
  const started = Date.now();
  const evil = await s.tool('workspace_search', {workspace: dir, query: '^(a+)+$', regex: true});
  assert.ok(Date.now() - started < 8000, 'bounded by a timeout');
  assert.equal(evil.error?.code, 'regex_timeout');
});

test('git_readonly never runs repository-configured programs and never reads a parent repository', {skip: !hasGit}, async t => {
  const s0 = await stack(t);
  const dir = await project(s0.root);
  const git = (...args) => spawnSync('git', args, {cwd: dir, encoding: 'utf8'});
  git('init', '-q'); git('-c', 'user.email=a@b.c', '-c', 'user.name=a', 'add', '.'); git('-c', 'user.email=a@b.c', '-c', 'user.name=a', 'commit', '-qm', 'init');
  await fs.writeFile(path.join(dir, 'src', 'app.js'), 'changed\n');
  const s = await stack(t, {cfg: {workspaceRoots: [dir]}});
  for (const operation of ['status', 'diff', 'log', 'show']) assert.equal((await s.tool('git_readonly', {workspace: dir, operation})).error, undefined, operation);
  assert.match((await s.tool('git_readonly', {workspace: dir, operation: 'diff'})).output, /changed/);
  const marker = path.join(s0.root, 'pwned.txt');
  const script = path.join(s0.root, process.platform === 'win32' ? 'hook.cmd' : 'hook.sh');
  await fs.writeFile(script, process.platform === 'win32' ? `@echo x> "${marker}"\r\n` : `#!/bin/sh\necho x > "${marker}"\n`, {mode: 0o755});
  git('config', 'core.fsmonitor', script.replaceAll('\\', '/'));
  git('config', 'filter.evil.clean', script.replaceAll('\\', '/'));
  for (const operation of ['status', 'diff', 'log', 'show']) assert.equal((await s.tool('git_readonly', {workspace: dir, operation})).error?.code, 'git_config_unsafe', operation);
  await assert.rejects(fs.access(marker), 'repository config must not execute programs');
  const inner = path.join(dir, 'src');
  const scoped = await stack(t, {cfg: {workspaceRoots: [inner]}});
  assert.equal((await scoped.tool('git_readonly', {workspace: inner, operation: 'status'})).error?.code, 'git_repository_outside_root');
});

test('context attachment: git_diff works, secrets are always masked and the closing marker carries the nonce', async t => {
  const s0 = await stack(t);
  const dir = await project(s0.root);
  const key = ['gsk_', 'B'.repeat(40)].join('');
  await fs.writeFile(path.join(dir, 'src', 'note.txt'), `key ${key}\n`);
  const s = await stack(t, {cfg: {workspaceRoots: [dir]}});
  await s.tool('delegate', {prompt: 'review', workspace: dir, context: {files: ['src/note.txt']}, privacy: 'allow_cloud'});
  const sent = s.calls.at(-1).text;
  assert.doesNotMatch(sent, new RegExp(key));
  const nonce = /nonce="([a-f0-9]+)"/.exec(sent)[1];
  assert.match(sent, new RegExp(`</dz23-untrusted-context nonce="${nonce}">`));
  if (hasGit) {
    spawnSync('git', ['init', '-q'], {cwd: dir});
    spawnSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=a', 'add', '.'], {cwd: dir});
    spawnSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=a', 'commit', '-qm', 'i'], {cwd: dir});
    await fs.writeFile(path.join(dir, 'src', 'app.js'), 'export const changedLine = 1;\n');
    await s.tool('delegate', {prompt: 'review diff', workspace: dir, context: {git_diff: true}});
    assert.match(s.calls.at(-1).text, /changedLine/);
  }
});

test('privacy masking keeps code numbers and masks only valid personal data', () => {
  const code = maskSensitive('const timeoutMs = 12345678; const at = 1789421559128; port 80808080').text;
  assert.match(code, /12345678/);
  assert.match(code, /1789421559128/);
  const pii = maskSensitive('CPF 529.982.247-25 cartao 4111 1111 1111 1111 tel (11) 98765-4321').text;
  assert.doesNotMatch(pii, /529\.982\.247-25|4111 1111 1111 1111|98765-4321/);
  assert.match(maskSensitive('invalid cpf 123.456.789-00').text, /123\.456\.789-00/);
});

test('privacy local_only never sends context to cloud targets', async t => {
  const cloud = await stack(t);
  assert.equal((await cloud.tool('delegate', {prompt: 'x', privacy: 'local_only'})).error?.code, 'no_local_target');
  assert.equal(cloud.calls.length, 0);
  const mixed = await stack(t, {cfg: {rotation: ['p1:m', 'local:qwen']}, registry: {p1: entry('p1'), local: entry('local', 'local', 'local')}});
  await mixed.tool('delegate', {prompt: 'x', privacy: 'local_only'});
  assert.deepEqual(mixed.calls.map(c => c.target), ['local:qwen']);
});

test('resources and prompts follow MCP: concrete resources, templates, scopes and JSON-RPC errors', async t => {
  const s = await stack(t);
  await s.tool('memory_checkpoint', {project_id: 'proj', mission_id: 'mis', status: 'active'});
  const list = (await s.rpc('resources/list')).result.resources;
  assert.ok(list.some(r => r.uri === 'dz23://mission/proj/mis'));
  assert.ok(list.every(r => !r.uri.includes('{')));
  assert.ok((await s.rpc('resources/templates/list')).result.resourceTemplates.some(r => r.uriTemplate.includes('{mission_id}')));
  assert.equal((await s.rpc('resources/read', {uri: 'dz23://mission/proj/missing'})).error.code, -32002);
  const forbidden = await s.rpc('resources/read', {uri: 'dz23://mission/proj/mis'}, {scopes: new Set(['delegate:execute'])});
  assert.ok(forbidden.error, 'memory:read is required');
  assert.equal((await s.rpc('prompts/get', {name: 'fix_bug', arguments: {}})).error.code, -32602);
  assert.equal((await s.rpc('prompts/get', {name: 'nope'})).error.code, -32602);
  const ok = await s.rpc('prompts/get', {name: 'fix_bug', arguments: {bug: 'crash'}});
  assert.match(ok.result.messages[0].content.text, /crash/);
});

test('handoff_export returns an object and the audit chain survives concurrent calls', async t => {
  const s = await stack(t);
  await s.tool('memory_checkpoint', {project_id: 'p', mission_id: 'm', status: 'active', next_action: 'continue'});
  const handoff = await s.tool('handoff_export', {project_id: 'p', mission_id: 'm'});
  assert.match(handoff.markdown, /# Mission handoff/);
  await Promise.all(Array.from({length: 20}, (_, i) => s.tool('mission_status', {project_id: 'p', mission_id: 'm'})));
  const audit = await verifyAudit(s.stateDir);
  assert.equal(audit.ok, true);
  assert.ok(audit.events >= 21);
  assert.equal(lastUserText([]), '');
});
