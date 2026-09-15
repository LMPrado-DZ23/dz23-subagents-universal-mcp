import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

// 4.0.0 diagnostics: target eligibility, cost policy, ignored generic credentials and unauthenticated HTTP.
// Child processes get an explicit environment, so provider variables of the test host never leak in.

const source = fileURLToPath(new URL('../', import.meta.url));
const FAKE = 'diagnostics-fake-credential-value-0000';
const TOKEN = 'diagnostics-http-token-value-000000000';

async function fixture(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dz23-diag-'));
  t.after(() => fsp.rm(dir, {recursive: true, force: true}));
  const root = path.join(dir, 'pkg');
  fs.cpSync(path.join(source, 'src'), path.join(root, 'src'), {recursive: true});
  fs.copyFileSync(path.join(source, 'package.json'), path.join(root, 'package.json'));
  const env = {DZ23_STATE_DIR: path.join(dir, 'state'), DZ23_ROTATION: 'custom:test-model', CUSTOM_BASE_URL: 'http://127.0.0.1:9/v1'};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) if (process.env[key] !== undefined) env[key] = process.env[key];
  return {dir, root, env};
}

function cli(f, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(f.root, 'src', 'index.js'), ...args], {cwd: f.dir, env: {...f.env, ...env}});
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`CLI timed out: ${args.join(' ')}`)); }, 30_000);
    child.on('close', status => { clearTimeout(timer); resolve({status, stdout, stderr, json: () => JSON.parse(stdout)}); });
    child.stdin.end();
  });
}

const check = (result, name) => result.json().checks.find(entry => entry.name === name);

test('doctor reports every configured target with tier and eligibility, and warns about cost-policy skips', async t => {
  const f = await fixture(t);
  const env = {DZ23_ROTATION: 'custom:test-model,ollama:gpt-oss:120b,openai:gpt-4o', OLLAMA_API_KEY: FAKE, OPENAI_API_KEY: FAKE};
  const blocked = await cli(f, ['doctor', '--json'], env);
  assert.equal(blocked.status, 0, 'warnings never fail doctor');
  assert.equal(blocked.stdout.includes(FAKE), false);
  const targets = check(blocked, 'targets');
  assert.equal(targets.status, 'pass');
  assert.equal(targets.detail, 'custom:test-model local eligible; ollama:gpt-oss:120b mixed skipped(mixed_not_allowed); openai:gpt-4o paid skipped(paid_not_allowed)');
  const cost = check(blocked, 'cost_policy');
  assert.equal(cost.status, 'warn');
  assert.match(cost.detail, /^skipped by cost policy: ollama:gpt-oss:120b \(mixed_not_allowed\), openai:gpt-4o \(paid_not_allowed\); /);
  assert.match(cost.detail, /DZ23_FREE_MODELS only if it is really free/);
  assert.match(cost.detail, /DZ23_ALLOW_PAID=true/);

  const declared = await cli(f, ['doctor', '--json'], {...env, DZ23_ROTATION: 'custom:test-model,ollama:gpt-oss:120b', DZ23_FREE_MODELS: 'ollama:gpt-oss:120b'});
  assert.equal(check(declared, 'targets').detail, 'custom:test-model local eligible; ollama:gpt-oss:120b mixed eligible');
  assert.equal(check(declared, 'cost_policy').status, 'pass');

  const paid = await cli(f, ['doctor', '--json'], {...env, DZ23_ALLOW_PAID: 'true'});
  assert.deepEqual([check(paid, 'cost_policy').status, check(paid, 'cost_policy').detail], ['pass', 'DZ23_ALLOW_PAID=true; paid, low-cost and mixed targets may be billed']);

  const human = await cli(f, ['doctor'], env);
  assert.match(human.stdout, /^WARN  cost_policy: skipped by cost policy/m);
  assert.match(human.stdout, /^PASS  targets: custom:test-model local eligible;/m);
});

test('doctor fails the targets check when every configured target is skipped', async t => {
  const f = await fixture(t);
  const result = await cli(f, ['doctor', '--json'], {DZ23_ROTATION: 'openrouter:openrouter/auto', CUSTOM_BASE_URL: '', OPENROUTER_API_KEY: FAKE});
  assert.equal(result.status, 1);
  assert.deepEqual([check(result, 'targets').status, check(result, 'targets').detail], ['fail', 'openrouter:openrouter/auto mixed skipped(mixed_not_allowed)']);
  assert.equal(check(result, 'cost_policy').status, 'warn');
  assert.equal(result.stdout.includes(FAKE), false);
});

test('doctor warns about ignored generic credentials by variable name only', async t => {
  const f = await fixture(t);
  const ignored = await cli(f, ['doctor', '--json'], {GITHUB_TOKEN: FAKE, HF_TOKEN: FAKE});
  assert.equal(ignored.status, 0);
  const generic = check(ignored, 'generic_credentials');
  assert.equal(generic.status, 'warn');
  assert.match(generic.detail, /^ignored generic credential\(s\): huggingface \(env:HF_TOKEN\), github \(env:GITHUB_TOKEN\); /);
  assert.match(generic.detail, /GITHUB_MODELS_TOKEN/);
  assert.equal(ignored.stdout.includes(FAKE), false);
  const named = await cli(f, ['doctor', '--json'], {GITHUB_TOKEN: FAKE, DZ23_ROTATION: 'custom:test-model,github:gpt-4o-mini'});
  assert.deepEqual([check(named, 'generic_credentials').status, check(named, 'targets').detail], ['pass', 'custom:test-model local eligible; github:gpt-4o-mini free-tier eligible']);
  const allowed = await cli(f, ['doctor', '--json'], {GITHUB_TOKEN: FAKE, DZ23_ALLOW_GENERIC_CREDENTIALS: 'true'});
  assert.equal(check(allowed, 'generic_credentials').status, 'pass');
});

test('HTTP without any token fails doctor and config validate unless unauthenticated local HTTP is explicit', async t => {
  const f = await fixture(t);
  const http = {DZ23_ALLOW_HTTP: 'true'};
  const doctor = await cli(f, ['doctor', '--json'], http);
  assert.equal(doctor.status, 1);
  assert.equal(check(doctor, 'http').status, 'fail');
  assert.match(check(doctor, 'http').detail, /DZ23_MCP_TOKEN_FILE/);
  assert.match(check(doctor, 'http').detail, /DZ23_ALLOW_UNAUTHENTICATED_LOCAL_HTTP=true/);
  const validate = await cli(f, ['config', 'validate', '--json'], http);
  assert.equal(validate.status, 1);
  assert.equal(validate.json().valid, false);
  assert.deepEqual(validate.json().issues.filter(issue => issue.level === 'error').map(issue => issue.variable), ['DZ23_MCP_TOKEN']);

  const open = {...http, DZ23_ALLOW_UNAUTHENTICATED_LOCAL_HTTP: 'true'};
  const openDoctor = await cli(f, ['doctor', '--json'], open);
  assert.deepEqual([openDoctor.status, check(openDoctor, 'http').status], [0, 'warn']);
  assert.equal((await cli(f, ['config', 'validate', '--json'], open)).json().valid, true);

  const tokened = await cli(f, ['doctor', '--json'], {...http, DZ23_MCP_TOKEN: TOKEN});
  assert.deepEqual([tokened.status, check(tokened, 'http').status], [0, 'pass']);
  assert.equal(tokened.stdout.includes(TOKEN), false);

  const remote = await cli(f, ['config', 'validate', '--json'], {...http, DZ23_HTTP_HOST: '0.0.0.0'});
  assert.deepEqual(remote.json().issues.filter(issue => issue.level === 'error').map(issue => issue.variable), ['DZ23_HTTP_HOST'], 'no duplicate error off loopback');
});

test('config validate summary includes the 4.0.0 routing and runtime settings', async t => {
  const f = await fixture(t);
  const defaults = (await cli(f, ['config', 'validate', '--json'])).json().summary;
  assert.deepEqual([defaults.free_models, defaults.allow_generic_credentials, defaults.shared_cooldowns, defaults.delegate_deadline_ms, defaults.stdio_max_inflight],
    [[], false, true, 600000, 8]);
  const custom = await cli(f, ['config', 'validate', '--json'], {DZ23_FREE_MODELS: 'ollama:gpt-oss:120b, openrouter:some/model:free', DZ23_ALLOW_GENERIC_CREDENTIALS: 'true',
    DZ23_SHARED_COOLDOWNS: 'false', DZ23_DELEGATE_DEADLINE_MS: '120000', DZ23_STDIO_MAX_INFLIGHT: '4'});
  assert.equal(custom.status, 0, custom.stderr);
  const summary = custom.json().summary;
  assert.deepEqual([summary.free_models, summary.allow_generic_credentials, summary.shared_cooldowns, summary.delegate_deadline_ms, summary.stdio_max_inflight],
    [['ollama:gpt-oss:120b', 'openrouter:some/model:free'], true, false, 120000, 4]);
});

test('providers text table shows the tier of each provider', async t => {
  const f = await fixture(t);
  const out = await cli(f, ['providers']);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^PROVIDER\s+STATUS\s+TIER\s+ENABLED/m);
  assert.match(out.stdout, /^custom\s+CONFIGURED\s+local\s+yes/m);
  assert.match(out.stdout, /^openrouter\s+MISSING_API_KEY\s+mixed\s+no/m);
});

test('installer writes the Claude Code add command and Codex timeouts without touching harness config', async t => {
  const f = await fixture(t);
  fs.mkdirSync(path.join(f.root, 'scripts'));
  fs.copyFileSync(path.join(source, 'scripts', 'install-harness.mjs'), path.join(f.root, 'scripts', 'install-harness.mjs'));
  const result = spawnSync(process.execPath, [path.join(f.root, 'scripts', 'install-harness.mjs'), 'all'], {cwd: f.dir, env: f.env, encoding: 'utf8', timeout: 10_000});
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Existing harness configuration was not modified\./);
  const generated = path.join(f.root, 'config', 'generated');
  const entry = path.join(f.root, 'src', 'index.js');
  const command = fs.readFileSync(path.join(generated, 'claude_code_add_command.txt'), 'utf8').split('\n');
  assert.match(command[0], /^# .*claude mcp remove -s user dz23-subagents/);
  assert.ok(command.includes(`claude mcp add -s user dz23-subagents -- "${process.execPath}" "${entry}" --stdio`));
  const codex = fs.readFileSync(path.join(generated, 'codex_config.snippet.toml'), 'utf8');
  assert.match(codex, /^\[mcp_servers\.dz23-subagents\]$/m);
  assert.match(codex, /^startup_timeout_sec = 30$/m);
  assert.match(codex, /^tool_timeout_sec = 900$/m);
  assert.equal(codex.match(/^\[mcp_servers\./gm).length, 1);
});
