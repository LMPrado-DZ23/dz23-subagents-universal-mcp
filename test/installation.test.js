import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const source = fileURLToPath(new URL('../', import.meta.url));
const version = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8')).version;

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dz23-install-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const root = path.join(dir, 'MCP folder with spaces');
  const unrelated = path.join(dir, 'other harness workspace');
  fs.mkdirSync(root); fs.mkdirSync(unrelated);
  fs.cpSync(path.join(source, 'src'), path.join(root, 'src'), {recursive: true});
  fs.copyFileSync(path.join(source, 'package.json'), path.join(root, 'package.json'));
  const state = path.join(dir, 'shared-state');
  fs.writeFileSync(path.join(root, '.env'), [
    `DZ23_STATE_DIR=${state}`,
    'CUSTOM_BASE_URL=http://127.0.0.1:17771/v1',
    'CUSTOM_API_KEY=fixture-value-not-a-real-credential',
    'DZ23_ROTATION=custom:test-model',
    'DZ23_ALLOW_PAID=false',
    ''
  ].join('\n'));
  // A harness may start the MCP from an unrelated project. Never load its secrets.
  fs.writeFileSync(path.join(unrelated, '.env'), 'CUSTOM_BASE_URL=http://127.0.0.1:17772/v1\n');
  const env = {};
  for (const key of ['PATH','Path','SystemRoot','WINDIR','ComSpec','HOME','USERPROFILE','TEMP','TMP']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return {root, unrelated, state, env};
}

function runMcp(f, overrides = {}) {
  const messages = [
    {jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18'}},
    {jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'provider_inventory',arguments:{}}},
    {jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'project_init',arguments:{project_id:'installation-test'}}}
  ];
  const result = spawnSync(process.execPath, [path.join(f.root,'src','index.js'),'--stdio'], {
    cwd: f.unrelated, env: {...f.env, ...overrides}, encoding:'utf8', timeout:10000,
    input: messages.map(m => JSON.stringify(m)).join('\n') + '\n'
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.includes('fixture-value-not-a-real-credential'), false);
  const responses = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(responses.length, 3);
  for (const response of responses) assert.equal(response.error, undefined);
  assert.equal(responses.find(r => r.id === 1).result.serverInfo.version, version);
  // v2.3.0: structuredContent is always an object; array results are wrapped as {items}.
  const inventory = responses.find(r => r.id === 2).result;
  assert.deepEqual(JSON.parse(inventory.content[0].text), inventory.structuredContent.items);
  return inventory.structuredContent.items;
}

test('installation loads the package .env from an unrelated working directory', t => {
  const f = fixture(t);
  const inventory = runMcp(f);
  assert.equal(inventory.find(p => p.provider === 'custom').base_url, 'http://127.0.0.1:17771/v1');
  assert.ok(fs.existsSync(path.join(f.state,'projects','installation-test','project.json')));
});

test('process environment keeps precedence over the packaged .env', t => {
  const f = fixture(t);
  const inventory = runMcp(f, {CUSTOM_BASE_URL:'http://127.0.0.1:17773/v1',DZ23_STATE_DIR:f.state});
  assert.equal(inventory.find(p => p.provider === 'custom').base_url, 'http://127.0.0.1:17773/v1');
});

test('harness snippets are regenerated for the actual installation path', t => {
  const f = fixture(t);
  fs.cpSync(path.join(source,'scripts'), path.join(f.root,'scripts'), {recursive:true});
  const result = spawnSync(process.execPath,[path.join(f.root,'scripts','install-harness.mjs'),'all'], {
    cwd:f.unrelated, env:f.env, encoding:'utf8', timeout:10000
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status,0,result.stderr);
  const output = path.join(f.root,'config','generated');
  const claude = JSON.parse(fs.readFileSync(path.join(output,'claude_desktop_config.snippet.json'),'utf8'));
  assert.equal(claude.mcpServers['dz23-subagents'].command,process.execPath);
  assert.deepEqual(claude.mcpServers['dz23-subagents'].args,[path.join(f.root,'src','index.js'),'--stdio']);
  const codex = fs.readFileSync(path.join(output,'codex_config.snippet.toml'),'utf8');
  assert.ok(codex.includes(JSON.stringify(process.execPath)));
  assert.ok(codex.includes(JSON.stringify(path.join(f.root,'src','index.js'))));
});
