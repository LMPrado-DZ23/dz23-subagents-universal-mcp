import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Router} from '../src/core.js';
import {ProjectMemory} from '../src/memory.js';
import {providerRegistry, parseTarget} from '../src/providers.js';
import {eligibleTargets} from '../src/targets.js';
import {callCli, clearCliStatusCache, cliAccountStatus, retryAfterFromText, selectedAccountProviders} from '../src/cli-providers.js';
import {ConfigError} from '../src/errors.js';

// Fake CLIs are small node scripts selected through DZ23_CLI_<NAME>_PATH. They record what the server gave them
// (arguments, working folder, whether credentials leaked into the environment) in a JSON file next to the script.
async function fakeCli(dir, name, body) {
  const file = path.join(dir, `${name}.mjs`);
  const record = path.join(dir, `${name}.calls.json`);
  await fs.writeFile(file, `import fs from 'node:fs';
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, 'utf8');
const record = ${JSON.stringify(record)};
const calls = fs.existsSync(record) ? JSON.parse(fs.readFileSync(record, 'utf8')) : [];
calls.push({args, stdin, cwd: process.cwd(), pid: process.pid, leaked: Object.keys(process.env).filter(k => /API_KEY|^DZ23_|^CLAUDE_CODE_|^ANTHROPIC_/.test(k))});
fs.writeFileSync(record, JSON.stringify(calls));
${body}
`);
  return {file, calls: async () => JSON.parse(await fs.readFile(record, 'utf8').catch(() => '[]'))};
}

const withEnv = async (vars, fn) => {
  const saved = Object.fromEntries(Object.keys(vars).map(key => [key, process.env[key]]));
  Object.assign(process.env, vars);
  clearCliStatusCache();
  try { return await fn(); } finally {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    clearCliStatusCache();
  }
};

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'dz23-acct-'));
const leakyKey = ['sk', 'ant', 'test', 'not', 'real'].join('-');

test('account providers are off unless DZ23_ACCOUNT_PROVIDERS selects them', () => {
  assert.equal(selectedAccountProviders({}).size, 0);
  assert.equal(selectedAccountProviders({DZ23_ACCOUNT_PROVIDERS: 'off'}).size, 0);
  assert.ok(selectedAccountProviders({DZ23_ACCOUNT_PROVIDERS: 'auto'}).has('claude-code'));
  assert.deepEqual([...selectedAccountProviders({DZ23_ACCOUNT_PROVIDERS: 'codex-cli, gemini-cli'})], ['codex-cli', 'gemini-cli']);
  assert.throws(() => selectedAccountProviders({DZ23_ACCOUNT_PROVIDERS: 'chatgpt-web'}), ConfigError);
  const off = providerRegistry({DZ23_CLI_CODEX_PATH: '/fake/codex'});
  assert.equal(off['codex-cli'].enabled, false);
  const on = providerRegistry({DZ23_ACCOUNT_PROVIDERS: 'codex-cli', DZ23_CLI_CODEX_PATH: '/fake/codex', DZ23_CODEX_CLI_MODEL: 'gpt-x'});
  assert.equal(on['codex-cli'].enabled, true);
  assert.equal(on['codex-cli'].tier, 'account');
  assert.equal(on['codex-cli'].defaultModel, 'gpt-x');
  assert.equal(on['codex-cli'].credentialSource, 'cli:account');
});

test('free-first routing puts local models, then accounts, then free-tier APIs', () => {
  const registry = providerRegistry({DZ23_ACCOUNT_PROVIDERS: 'codex-cli', DZ23_CLI_CODEX_PATH: '/fake/codex', GROQ_API_KEY: 'k', OMNIROUTE_API_KEY: 'k'});
  const cfg = {rotation: ['groq:llama-3.3-70b-versatile', 'omniroute:auto', 'codex-cli:default'], allowPaid: false, freeModels: [], policy: 'free-first'};
  assert.deepEqual(eligibleTargets(cfg, registry).map(target => target.name), ['omniroute', 'codex-cli', 'groq']);
  assert.equal(parseTarget('omniroute:auto', registry).tier, 'account');
});

test('OmniRoute is an account gateway enabled only by its key or explicit settings', async () => {
  assert.equal(providerRegistry({}).omniroute.enabled, false);
  const dir = await tmp();
  const keyFile = path.join(dir, 'omniroute.key');
  await fs.writeFile(keyFile, 'test-omniroute-key\n');
  const entry = providerRegistry({OMNIROUTE_API_KEY_FILE: keyFile}).omniroute;
  assert.equal(entry.enabled, true);
  assert.equal(entry.baseURL, 'http://127.0.0.1:20128/api/v1');
  assert.equal(entry.tier, 'account');
  assert.doesNotMatch(JSON.stringify(entry.credentialSource), /test-omniroute-key/);
  await fs.rm(dir, {recursive: true, force: true});
});

test('a subscription CLI answers through the router at zero cost, without tools, MCP servers or API keys', async () => {
  const dir = await tmp();
  const claude = await fakeCli(dir, 'claude', `
if (args[0] === 'auth') { console.log(JSON.stringify({loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max'})); process.exit(0); }
console.log(JSON.stringify({type: 'result', is_error: false, result: 'pong from ' + stdin.trim().split(' ').at(-1), usage: {input_tokens: 12, output_tokens: 3}}));`);
  await withEnv({DZ23_ACCOUNT_PROVIDERS: 'claude-code', DZ23_CLI_CLAUDE_CODE_PATH: claude.file, ANTHROPIC_API_KEY: leakyKey, CLAUDE_CODE_USE_BEDROCK: '1'}, async () => {
    const memory = new ProjectMemory(dir, {durableWrites: false});
    const registry = providerRegistry(process.env);
    const router = new Router({rotation: ['claude-code:sonnet'], allowPaid: false, policy: 'free-first', maxConcurrency: 1, maxWorkersPerTarget: 1, timeoutMs: 30_000, maxContextChars: 20_000, maxRetries: 0, stateDir: dir}, memory, {registry});
    const out = await router.delegate({project_id: 'p', mission_id: 'm', prompt: 'say ping', role: 'worker'});
    assert.equal(out.content, 'pong from ping');
    const mission = await memory.getMission('p', 'm');
    assert.equal(mission.usage.cost_usd, 0);
    const calls = (await claude.calls()).filter(call => call.args[0] === '-p');
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.deepEqual(call.leaked, []);
    assert.equal(call.args[call.args.indexOf('--tools') + 1], '');
    assert.ok(call.args.includes('--strict-mcp-config'));
    assert.equal(call.args[call.args.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
    assert.equal(call.args[call.args.indexOf('--model') + 1], 'sonnet');
    assert.match(path.basename(call.cwd), /^dz23-cli-/);
    await assert.rejects(fs.access(call.cwd));
  });
  await fs.rm(dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
});

test('a CLI logged in with an API key or without a subscription is refused before any prompt is sent', async () => {
  const dir = await tmp();
  const claude = await fakeCli(dir, 'claude', `
if (args[0] === 'auth') { console.log(JSON.stringify({loggedIn: true, authMethod: 'api_key', subscriptionType: null})); process.exit(0); }
console.log(JSON.stringify({result: 'should never run'}));`);
  await withEnv({DZ23_CLI_CLAUDE_CODE_PATH: claude.file}, async () => {
    const status = await cliAccountStatus('claude-code');
    assert.equal(status.logged_in, false);
    assert.equal(status.method, 'api_key_or_no_subscription');
    await assert.rejects(callCli({name: 'claude-code', model: 'sonnet'}, [{role: 'user', content: 'hi'}]),
      error => error.kind === 'authentication_failed' && /claude auth login --claudeai/.test(error.detail || error.message));
    assert.equal((await claude.calls()).filter(call => call.args[0] === '-p').length, 0);
  });
  await fs.rm(dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
});

test('Codex answers from its output file, and a usage limit cools the target down until the reset time', async () => {
  const dir = await tmp();
  const reset = new Date(Date.now() + 2 * 24 * 3600_000);
  const month = reset.toLocaleString('en-US', {month: 'short'});
  const when = `${month} ${reset.getDate()}th, ${reset.getFullYear()} 11:02 AM`;
  const codex = await fakeCli(dir, 'codex', `
if (args[0] === 'login') { console.error('Logged in using ChatGPT'); process.exit(0); }
if (stdin.includes('limit')) { console.error("ERROR: You've hit your usage limit. Visit the usage page or try again at ${when}."); process.exit(1); }
fs.writeFileSync(args[args.indexOf('-o') + 1], 'codex says ' + stdin.trim());`);
  await withEnv({DZ23_CLI_CODEX_PATH: codex.file}, async () => {
    const ok = await callCli({name: 'codex-cli', model: 'default'}, [{role: 'user', content: 'hello'}]);
    assert.equal(ok.content, 'codex says hello');
    const [first] = await codex.calls().then(calls => calls.filter(call => call.args[0] === 'exec'));
    for (const flag of ['--ignore-user-config', '--ephemeral', '--skip-git-repo-check']) assert.ok(first.args.includes(flag), flag);
    assert.equal(first.args[first.args.indexOf('-s') + 1], 'read-only');
    assert.equal(first.args.includes('-m'), false);
    await assert.rejects(callCli({name: 'codex-cli', model: 'default'}, [{role: 'user', content: 'limit please'}]),
      error => error.kind === 'quota_exhausted' && error.retryAfterMs >= 55 * 60_000);
  });
  await fs.rm(dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
});

test('a flag-shaped model id never reaches the CLI argv', async () => {
  const dir = await tmp();
  const codex = await fakeCli(dir, 'codex', `
if (args[0] === 'login') { console.error('Logged in using ChatGPT'); process.exit(0); }
fs.writeFileSync(args[args.indexOf('-o') + 1], 'ran anyway');`);
  await withEnv({DZ23_CLI_CODEX_PATH: codex.file}, async () => {
    for (const model of ['--dangerously-skip-approvals', '-s danger-full-access', 'model;rm -rf /', '../../etc/passwd']) {
      await assert.rejects(callCli({name: 'codex-cli', model}, [{role: 'user', content: 'hi'}]), error => error.kind === 'model_not_found');
    }
    assert.equal((await codex.calls()).filter(call => call.args[0] === 'exec').length, 0);
  });
  await fs.rm(dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
});

test('a hung CLI is killed at DZ23_CLI_TIMEOUT_MS and reported as a timeout', async () => {
  const dir = await tmp();
  const agent = await fakeCli(dir, 'cursor-agent', `
if (args[0] === 'status') { console.log('Logged in as test user'); process.exit(0); }
setInterval(() => undefined, 1000);`);
  await withEnv({DZ23_CLI_CURSOR_AGENT_PATH: agent.file, DZ23_CLI_TIMEOUT_MS: '1500'}, async () => {
    const started = Date.now();
    await assert.rejects(callCli({name: 'cursor-agent', model: 'default'}, [{role: 'user', content: 'hang'}]), error => error.kind === 'provider_timeout');
    assert.ok(Date.now() - started < 15_000);
    const hung = (await agent.calls()).find(call => call.args[0] === '-p');
    let alive = true;
    for (let i = 0; i < 50 && alive; i++) {
      try { process.kill(hung.pid, 0); await new Promise(resolve => setTimeout(resolve, 100)); } catch { alive = false; }
    }
    assert.equal(alive, false, 'the timed-out CLI process was killed');
  });
  await fs.rm(dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
});

test('usage-limit reset times are read from CLI messages', () => {
  const now = Date.parse('2026-09-17T10:00:00');
  assert.equal(retryAfterFromText('try again at Sep 17th, 2026 11:00 AM', now), 3600_000);
  assert.equal(retryAfterFromText('Please try again in 5 minutes', now), 300_000);
  assert.equal(retryAfterFromText('try again at Sep 1st, 2020 11:00 AM', now), 0);
  assert.equal(retryAfterFromText('no hint', now), 0);
});
