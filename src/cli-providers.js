import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {ConfigError} from './errors.js';
import {ProviderError} from './provider-errors.js';

// Account providers: official AI CLIs the user logged into with an account or subscription. The server runs them
// headless, without tools or MCP servers, in an empty temporary folder, with API-key variables removed so a CLI
// can never fall back to per-token API billing. A CLI is used only when its own status says it is logged in with an
// account; otherwise the call fails with authentication_failed and a login hint.
const HOME = os.homedir();
const APPDATA = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
const exe = name => (process.platform === 'win32' ? `${name}.exe` : name);
const npmBin = (...parts) => path.join(APPDATA, 'npm', 'node_modules', ...parts);
const STATUS_TTL_MS = 5 * 60 * 1000;
// Removed from the child environment: provider/API settings that would switch a CLI to per-token billing, this
// server's own settings, and anything that looks like a credential. The CLI keeps its own login files in the user profile.
const API_KEY_ENV = /^(?:ANTHROPIC_|OPENAI_|GOOGLE_GENAI|GOOGLE_API|VERTEX|DASHSCOPE_|OPENROUTER_|DZ23_|CLAUDECODE|CLAUDE_CODE_|AWS_|AZURE_)|API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY/i;

function onPath(name) {
  const dirs = String(process.env.PATH || process.env.Path || '').split(path.delimiter);
  const names = process.platform === 'win32' ? [`${name}.exe`, `${name}.cmd`] : [name];
  for (const dir of dirs) for (const candidate of names) { const full = path.join(dir, candidate); if (dir && fs.existsSync(full)) return full; }
  return null;
}

function newestCodex() {
  const root = path.join(LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
  try {
    return fs.readdirSync(root).map(dir => path.join(root, dir, exe('codex'))).filter(fs.existsSync).map(file => ({file, at: fs.statSync(file).mtimeMs})).sort((a, b) => b.at - a.at)[0]?.file || null;
  } catch { return null; }
}

const flatten = messages => messages.map(m => (m.role === 'system' ? m.content : m.role === 'assistant' ? `Assistant: ${m.content}` : m.content)).join('\n\n');
const systemOf = messages => messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
const userOf = messages => messages.filter(m => m.role !== 'system').map(m => m.content).join('\n\n');

/** Parses the whole output as JSON, or else its last JSON line (CLIs may print progress before the result). */
function jsonField(text, fields) {
  const attempts = [text.trim(), text.trim().split('\n').filter(Boolean).at(-1) || ''];
  for (const candidate of attempts) {
    try {
      const data = JSON.parse(candidate);
      for (const field of fields) if (typeof data?.[field] === 'string') return {data, text: data[field]};
      return {data, text: null};
    } catch { /* try the next form */ }
  }
  return {data: null, text: null};
}

async function fileExists(file) { return fsp.access(file).then(() => true, () => false); }

export const CLI_SPECS = Object.freeze({
  'claude-code': {
    label: 'Claude Code', tier: 'account', defaultModel: 'sonnet', models: ['sonnet', 'opus', 'haiku'], verified: true,
    login: 'claude auth login --claudeai',
    locate: env => env.DZ23_CLI_CLAUDE_CODE_PATH || [path.join(HOME, '.local', 'bin', exe('claude'))].find(fs.existsSync) || onPath('claude'),
    args: (model, messages) => ['-p', '--output-format', 'json', '--model', model, '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--setting-sources', 'project', '--no-session-persistence', '--system-prompt', systemOf(messages) || 'You are a helpful assistant.'],
    stdin: messages => userOf(messages),
    parse: out => {
      const {data, text} = jsonField(out, ['result']);
      if (data?.is_error) return {error: String(data.result || 'error')};
      return {content: text, usage: data?.usage ? {prompt_tokens: data.usage.input_tokens, completion_tokens: data.usage.output_tokens} : null};
    },
    status: async (bin, run) => {
      const out = await run(bin, ['auth', 'status']);
      const {data} = jsonField(out.stdout, []);
      if (!data?.loggedIn) return {logged_in: false, method: 'none'};
      const subscription = data.authMethod === 'claude.ai' && Boolean(data.subscriptionType);
      return {logged_in: subscription, method: subscription ? `claude.ai ${data.subscriptionType}` : 'api_key_or_no_subscription'};
    }
  },
  'codex-cli': {
    label: 'OpenAI Codex', tier: 'account', defaultModel: 'default', models: ['default'], verified: true,
    login: 'codex login',
    locate: env => env.DZ23_CLI_CODEX_PATH || newestCodex() || onPath('codex'),
    args: (model, messages, ctx) => ['exec', '--ignore-user-config', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only', '--color', 'never', '-C', ctx.cwd,
      '-o', ctx.outFile, ...(model && model !== 'default' ? ['-m', model] : []), '-'],
    stdin: messages => flatten(messages),
    parse: async (out, ctx) => ({content: (await fsp.readFile(ctx.outFile, 'utf8').catch(() => '')).trim() || null, usage: null}),
    status: async (bin, run) => {
      const out = await run(bin, ['login', 'status']);
      const text = `${out.stdout}\n${out.stderr}`;
      return /chatgpt/i.test(text) ? {logged_in: true, method: 'chatgpt'} : {logged_in: false, method: /api key/i.test(text) ? 'api_key' : 'none'};
    }
  },
  'gemini-cli': {
    label: 'Gemini CLI', tier: 'account', defaultModel: 'default', models: ['default', 'gemini-2.5-pro', 'gemini-2.5-flash'], verified: true,
    login: 'gemini  (choose "Login with Google")',
    locate: env => env.DZ23_CLI_GEMINI_PATH || [npmBin('@google', 'gemini-cli', 'bundle', 'gemini.js')].find(fs.existsSync) || onPath('gemini'),
    args: model => ['-o', 'json', ...(model && model !== 'default' ? ['-m', model] : []), '-p', ' '],
    stdin: messages => flatten(messages),
    parse: out => ({content: jsonField(out, ['response']).text, usage: null}),
    status: async () => {
      const ok = await fileExists(path.join(HOME, '.gemini', 'oauth_creds.json'));
      return {logged_in: ok, method: ok ? 'google_oauth' : 'none'};
    }
  },
  'qwen-code': {
    label: 'Qwen Code', tier: 'account', defaultModel: 'default', models: ['default'], verified: false,
    login: 'qwen  (choose Qwen OAuth)',
    locate: env => env.DZ23_CLI_QWEN_CODE_PATH || [npmBin('@qwen-code', 'qwen-code', 'cli-entry.js')].find(fs.existsSync) || onPath('qwen'),
    args: model => ['-o', 'json', '--auth-type', 'qwen-oauth', ...(model && model !== 'default' ? ['-m', model] : [])],
    stdin: messages => flatten(messages),
    parse: out => { const {text} = jsonField(out, ['response', 'result']); return {content: text ?? (out.trim() || null), usage: null}; },
    status: async () => {
      const ok = await fileExists(path.join(HOME, '.qwen', 'oauth_creds.json'));
      return {logged_in: ok, method: ok ? 'qwen_oauth' : 'none'};
    }
  },
  'copilot-cli': {
    label: 'GitHub Copilot CLI', tier: 'account', defaultModel: 'default', models: ['default'], verified: false,
    login: 'copilot  (then /login)',
    locate: env => env.DZ23_CLI_COPILOT_PATH || [npmBin('@github', 'copilot', 'npm-loader.js')].find(fs.existsSync) || onPath('copilot'),
    args: model => ['-s', '--no-color', '--stream', 'off', ...(model && model !== 'default' ? ['--model', model] : [])],
    stdin: messages => flatten(messages),
    parse: out => ({content: out.trim() || null, usage: null}),
    status: async () => {
      const file = path.join(HOME, '.copilot', 'config.json');
      const text = await fsp.readFile(file, 'utf8').catch(() => '');
      const ok = /logged_in_users|last_logged_in_user/.test(text);
      return {logged_in: ok, method: ok ? 'github_account' : 'none'};
    }
  },
  opencode: {
    label: 'OpenCode', tier: 'mixed', defaultModel: 'default', models: ['default'], verified: false,
    login: 'opencode auth login',
    locate: env => env.DZ23_CLI_OPENCODE_PATH || onPath('opencode'),
    args: (model, messages) => ['run', '--pure', ...(model && model !== 'default' ? ['-m', model] : []), flatten(messages)],
    stdin: () => null,
    parse: out => ({content: out.trim() || null, usage: null}),
    status: async (bin, run) => {
      const out = await run(bin, ['auth', 'list']);
      const ok = out.code === 0 && /\S/.test(out.stdout) && !/no credentials|0 credentials/i.test(out.stdout);
      return {logged_in: ok, method: ok ? 'opencode_auth' : 'none'};
    }
  },
  'cursor-agent': {
    label: 'Cursor Agent', tier: 'account', defaultModel: 'default', models: ['default'], verified: false,
    login: 'cursor-agent login',
    locate: env => env.DZ23_CLI_CURSOR_AGENT_PATH || onPath('cursor-agent'),
    args: (model, messages) => ['-p', '--output-format', 'text', ...(model && model !== 'default' ? ['--model', model] : []), flatten(messages)],
    stdin: () => null,
    parse: out => ({content: out.trim() || null, usage: null}),
    status: async (bin, run) => {
      const out = await run(bin, ['status']);
      const ok = /logged in/i.test(`${out.stdout}${out.stderr}`) && !/not logged in/i.test(`${out.stdout}${out.stderr}`);
      return {logged_in: ok, method: ok ? 'cursor_account' : 'none'};
    }
  }
});

function childEnv(cwd) {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) if (!API_KEY_ENV.test(name)) env[name] = value;
  env.TMP = cwd; env.TEMP = cwd; env.NO_COLOR = '1'; env.CI = '1';
  return env;
}

function spawnCli(bin, args, {cwd = os.tmpdir(), stdin = null, timeoutMs = 60_000, signal} = {}) {
  const node = /\.(?:m?js|cjs)$/i.test(bin);
  const child = spawn(node ? process.execPath : bin, node ? [bin, ...args] : args, {cwd, env: childEnv(cwd), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32'});
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  const kill = () => {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {windowsHide: true, stdio: 'ignore'});
    else try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  };
  return new Promise(resolve => {
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    const onAbort = () => kill();
    signal?.addEventListener('abort', onAbort, {once: true});
    child.stdout.on('data', d => { stdout += d; if (stdout.length > 4 * 1024 * 1024) kill(); });
    child.stderr.on('data', d => { stderr += d; if (stderr.length > 1024 * 1024) stderr = stderr.slice(-65536); });
    child.on('error', error => { clearTimeout(timer); resolve({code: null, stdout, stderr, spawnError: error.code || 'spawn_failed', timedOut}); });
    child.on('close', code => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve({code, stdout, stderr, timedOut}); });
    child.stdin.on('error', () => undefined);
    if (stdin !== null) child.stdin.end(stdin); else child.stdin.end();
  });
}

// A model id reaches the CLI argv, so it must never look like a flag or carry separators: clients can ask for
// any "provider:model" the schema allows, and "codex-cli:--dangerous" would otherwise become an extra option.
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,80}$/;

const statusCache = new Map();

/** Installed + logged-in state of one account CLI, cached for five minutes. Never reads or prints credentials. */
export async function cliAccountStatus(name, env = process.env, {refresh = false} = {}) {
  const spec = CLI_SPECS[name];
  const bin = spec.locate(env);
  if (!bin) return {provider: name, label: spec.label, installed: false, logged_in: false, method: 'none', login: spec.login, verified_adapter: spec.verified};
  const cached = statusCache.get(bin);
  if (!refresh && cached && Date.now() - cached.at < STATUS_TTL_MS) return cached.value;
  const run = (b, args) => spawnCli(b, args, {timeoutMs: 20_000});
  const state = await spec.status(bin, run).catch(() => ({logged_in: false, method: 'status_check_failed'}));
  const value = {provider: name, label: spec.label, installed: true, ...state, login: spec.login, verified_adapter: spec.verified, tier: spec.tier};
  statusCache.set(bin, {at: Date.now(), value});
  return value;
}

export function clearCliStatusCache() { statusCache.clear(); }

const slots = new Map();
async function withSlot(name, limit, fn) {
  const state = slots.get(name) || {active: 0, queue: []};
  slots.set(name, state);
  if (state.active >= limit) await new Promise(resolve => state.queue.push(resolve));
  state.active++;
  try { return await fn(); } finally { state.active--; state.queue.shift()?.(); }
}

function classify(text) {
  if (/usage limit|limit reached|rate limit|too many requests|quota/i.test(text)) return /quota|usage limit|limit reached/i.test(text) ? 'quota_exhausted' : 'rate_limited';
  if (/credit balance|billing|payment/i.test(text)) return 'billing_required';
  if (/not logged in|log ?in|login|unauthori[sz]ed|authenticat/i.test(text)) return 'authentication_failed';
  if (/model .*not (?:found|available|supported)|unknown model|invalid model/i.test(text)) return 'model_not_found';
  return 'provider_unavailable';
}

/** "try again at Sep 19th, 2026 11:02 AM" / "try again in 5 minutes" → ms from now (0 when absent; the router caps it). */
export function retryAfterFromText(text, now = Date.now()) {
  const at = /try again (?:at|after) ([^.\n]+?\d{1,2}:\d{2}(?:\s*[AP]M)?)/i.exec(text);
  if (at) {
    const when = Date.parse(at[1].replace(/(\d)(?:st|nd|rd|th)\b/g, '$1'));
    if (Number.isFinite(when) && when > now) return when - now;
  }
  const inMatch = /try again in (\d+)\s*(second|minute|hour)/i.exec(text);
  if (inMatch) return Number(inMatch[1]) * {second: 1000, minute: 60_000, hour: 3_600_000}[inMatch[2].toLowerCase()];
  return 0;
}

/** Runs one completion through an account CLI. Throws ProviderError with a classified kind. */
export async function callCli(target, messages, {timeoutMs = 90_000, signal} = {}) {
  const name = target.name;
  const spec = CLI_SPECS[name];
  const meta = {provider: name, model: target.model};
  if (!spec) throw new ProviderError({...meta, kind: 'configuration_error', detail: 'unknown CLI provider'});
  const status = await cliAccountStatus(name);
  if (!status.installed) throw new ProviderError({...meta, kind: 'configuration_error', detail: `${spec.label} is not installed`});
  if (!status.logged_in) throw new ProviderError({...meta, kind: 'authentication_failed', detail: `account_login_required: run ${spec.login}`});
  const model = target.model || spec.defaultModel;
  if (!SAFE_MODEL.test(model)) throw new ProviderError({...meta, kind: 'model_not_found', detail: 'model id must start with a letter or digit and use only letters, digits and . _ - / @ :'});
  const limit = Number(process.env.DZ23_CLI_MAX_CONCURRENCY) || 1;
  // CLIs start slowly and think longer than an API call: DZ23_CLI_TIMEOUT_MS wins, else at least five minutes.
  const cliTimeout = Number(process.env.DZ23_CLI_TIMEOUT_MS) || Math.max(timeoutMs, 300_000);
  return withSlot(name, limit, async () => {
    const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'dz23-cli-'));
    const ctx = {cwd, outFile: path.join(cwd, 'last-message.txt')};
    try {
      const bin = spec.locate(process.env);
      const out = await spawnCli(bin, spec.args(model, messages, ctx), {cwd, stdin: spec.stdin(messages), timeoutMs: cliTimeout, signal});
      if (signal?.aborted) throw new ProviderError({...meta, kind: 'provider_error', detail: 'request cancelled'});
      if (out.timedOut) throw new ProviderError({...meta, kind: 'provider_timeout'});
      if (out.spawnError) throw new ProviderError({...meta, kind: 'configuration_error', detail: `cannot start ${spec.label}`});
      const parsed = await spec.parse(out.stdout, ctx);
      const failure = (text, detail) => new ProviderError({...meta, kind: classify(text), retryAfterMs: retryAfterFromText(text), detail});
      if (parsed.error) throw failure(parsed.error, 'CLI reported an error');
      if (out.code !== 0 && !parsed.content) throw failure(`${out.stdout}\n${out.stderr}`, `${spec.label} exited with code ${out.code}`);
      if (!parsed.content || !String(parsed.content).trim()) throw new ProviderError({...meta, kind: 'response_invalid', detail: 'No assistant content'});
      return {content: String(parsed.content), usage: parsed.usage || null};
    } finally {
      await fsp.rm(cwd, {recursive: true, force: true, maxRetries: 5, retryDelay: 100}).catch(() => undefined);
    }
  });
}

/** DZ23_ACCOUNT_PROVIDERS: unset/off = none, auto = every installed CLI, or a comma list of CLI names. */
export function selectedAccountProviders(env = process.env) {
  const raw = String(env.DZ23_ACCOUNT_PROVIDERS || '').trim().toLowerCase();
  if (!raw || raw === 'off' || raw === 'none') return new Set();
  if (raw === 'auto' || raw === 'all') return new Set(Object.keys(CLI_SPECS));
  const names = raw.split(',').map(item => item.trim()).filter(Boolean);
  const unknown = names.filter(item => !CLI_SPECS[item]);
  if (unknown.length) throw new ConfigError(`DZ23_ACCOUNT_PROVIDERS has unknown entries: ${unknown.join(', ')} (known: ${Object.keys(CLI_SPECS).join(', ')}, auto, off)`);
  return new Set(names);
}

/** Registry entries for the selected account CLIs (enabled when the executable exists; login is checked at call time). */
export function cliRegistryEntries(env = process.env, capabilities) {
  const selected = selectedAccountProviders(env);
  return Object.fromEntries(Object.entries(CLI_SPECS).map(([name, spec]) => {
    const bin = selected.has(name) ? spec.locate(env) : null;
    const model = env[`DZ23_${name.toUpperCase().replace(/-/g, '_')}_MODEL`] || spec.defaultModel;
    return [name, {name, baseURL: `cli://${name}`, privateEndpoint: true, apiKey: 'account', keyName: null, credentialSource: bin ? 'cli:account' : 'none',
      defaultModel: model, tier: spec.tier, protocol: 'cli', location: 'account', capabilities: capabilities(), enabled: Boolean(bin), configured: Boolean(bin)}];
  }));
}

export async function listCliModels(name) {
  return (CLI_SPECS[name]?.models || []).map(id => ({id}));
}
