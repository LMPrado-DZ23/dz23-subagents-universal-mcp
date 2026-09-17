#!/usr/bin/env node
// Protocol check with the official MCP Inspector CLI (a real MCP client). Development tool only: it is
// fetched by npx at a pinned version and is not a dependency of the server.
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const INSPECTOR = '@modelcontextprotocol/inspector@2.7.0';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const state = fs.mkdtempSync(path.join(os.tmpdir(), 'dz23-inspector-'));
const env = {...process.env, DZ23_STATE_DIR: state, DZ23_LOG_LEVEL: 'error', DZ23_ROTATION: 'custom:check-model', CUSTOM_BASE_URL: 'http://127.0.0.1:9/v1'};
for (const name of Object.keys(env)) if (/API_KEY|_TOKEN$/i.test(name)) delete env[name];

// npx is run through node directly: no shell, so paths with spaces and arguments are passed unchanged.
const npxCli = [path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js'),
  path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js')].find(file => fs.existsSync(file));
if (!npxCli) throw new Error('npx-cli.js was not found next to this Node.js installation');

function inspect(method, extra = []) {
  const out = spawnSync(process.execPath, [npxCli, '-y', INSPECTOR, '--cli', process.execPath, path.join(root, 'src', 'index.js'), '--stdio', '--method', method, ...extra],
    {env, encoding: 'utf8', timeout: 180_000});
  if (out.status !== 0) throw new Error(`${method} failed (exit ${out.status}): ${(out.stderr || '').slice(-500)}`);
  return JSON.parse(out.stdout);
}

const checks = [];
const check = (name, ok, detail = '') => { checks.push({name, ok}); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };
try {
  const tools = inspect('tools/list').tools.map(t => t.name);
  check('tools/list returns the core tools', ['delegate', 'swarm_run', 'mission_status', 'mission_list', 'playbook_get', 'routing_explain'].every(n => tools.includes(n)), `${tools.length} tools`);
  const call = inspect('tools/call', ['--tool-name', 'memory_checkpoint', '--tool-arg', 'project_id=inspector', '--tool-arg', 'mission_id=check', '--tool-arg', 'status=active']);
  check('tools/call memory_checkpoint', call.isError !== true);
  const resources = inspect('resources/list').resources;
  check('resources/list lists the checkpointed mission', resources.some(r => r.uri === 'dz23://mission/inspector/check'));
  check('resources/templates/list', inspect('resources/templates/list').resourceTemplates.some(r => r.uriTemplate.includes('{mission_id}')));
  const read = inspect('resources/read', ['--uri', 'dz23://mission/inspector/check']);
  check('resources/read returns mission JSON', JSON.parse(read.contents[0].text).mission_id === 'check');
  check('prompts/list', inspect('prompts/list').prompts.some(p => p.name === 'fix_bug'));
  const prompt = inspect('prompts/get', ['--prompt-name', 'fix_bug', '--prompt-args', 'bug=inspector crash']);
  check('prompts/get renders arguments', prompt.messages[0].content.text.includes('inspector crash'));
} catch (error) {
  check('inspector run', false, error.message);
} finally {
  fs.rmSync(state, {recursive: true, force: true});
}
const failed = checks.filter(c => !c.ok).length;
console.log(failed ? `INSPECTOR_CHECK=FAIL ${failed}/${checks.length}` : `INSPECTOR_CHECK=PASS ${checks.length}/${checks.length}`);
process.exitCode = failed ? 1 : 0;
