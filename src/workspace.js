import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {Worker} from 'node:worker_threads';
import {ToolError} from './errors.js';
import {maskSecrets} from './privacy.js';

// Names that usually hold credentials or private keys. Checked on every path segment.
const PROTECTED = new RegExp([
  String.raw`\.env(?:\..*)?`, String.raw`.*\.env`, String.raw`\.(?:npmrc|yarnrc(?:\.yml)?|pypirc|netrc|git-credentials|htpasswd|pgpass|claude\.json)`, '_netrc',
  String.raw`\.(?:git|ssh|gnupg|aws|azure|kube|docker)`, String.raw`id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?`,
  String.raw`.*\.(?:pem|key|p12|pfx|jks|keystore|kdbx|tfstate|ppk)`, String.raw`(?:credentials?|secrets?)(?:\.(?:json|ya?ml|txt|toml|ini|conf|csv))?`,
  String.raw`.*(?:secret|password|credential|api[_-]?key|access[_-]?token|service[_-]?account).*\.(?:json|ya?ml|txt|toml|ini|conf)`
].map(p => `(?:${p})`).join('|').replace(/^/, '^(?:').concat(')$'), 'i');
const UNC = /^(?:\\\\|\/\/)/;
const SKIP_DIRS = new Set(['node_modules']);
const RISKY_GIT_CONFIG = /^(?:filter\..+\.(?:clean|smudge|process)|diff\..+\.(?:textconv|command)|diff\.external|merge\..+\.driver|core\.(?:fsmonitor|pager|sshcommand|hookspath|askpass|editor|gitproxy)|gpg\..*program|credential\..*helper|pager\..+|sequence\.editor|include\.path|includeif\..+)$/i;
const REGEX_FILE_TIMEOUT_MS = 1000;

const fold = value => (process.platform === 'win32' ? value.toLowerCase() : value);
const within = (file, root) => fold(file) === fold(root) || fold(file).startsWith(`${fold(root)}${path.sep}`);
export const isProtectedName = name => PROTECTED.test(name);
const isProtectedPath = relative => relative.split(/[\\/]/).some(part => part && PROTECTED.test(part));

async function realRoots(cfg) {
  const roots = [];
  for (const root of cfg.workspaceRoots || []) {
    const real = await fs.realpath(path.resolve(root)).catch(() => null);
    if (real) roots.push(real);
  }
  return roots;
}

export async function resolveWorkspace(cfg, requested) {
  if (!requested || typeof requested !== 'string' || UNC.test(requested) || requested.includes('\0')) throw new ToolError('workspace_denied', 'workspace path is not allowed');
  if (!(cfg.workspaceRoots || []).length) throw new ToolError('workspace_denied', 'DZ23_WORKSPACE_ROOTS is not configured');
  const real = await fs.realpath(path.resolve(requested)).catch(() => { throw new ToolError('workspace_not_found', 'workspace path was not found'); });
  const root = (await realRoots(cfg)).find(candidate => within(real, candidate));
  if (!root || isProtectedPath(path.relative(root, real))) throw new ToolError('workspace_denied', 'path is outside the configured workspace roots or protected');
  return {root, real};
}

async function resolveChild(cfg, workspace, relative) {
  if (typeof relative !== 'string' || relative.includes('\0') || UNC.test(relative) || path.isAbsolute(relative)) throw new ToolError('workspace_denied', 'relative workspace path required');
  const base = await resolveWorkspace(cfg, workspace);
  if (isProtectedPath(relative)) throw new ToolError('workspace_denied', 'path is outside the workspace or protected');
  const real = await fs.realpath(path.resolve(base.real, relative)).catch(() => { throw new ToolError('workspace_not_found', 'workspace path was not found'); });
  if (!within(real, base.real) || isProtectedPath(path.relative(base.root, real))) throw new ToolError('workspace_denied', 'path is outside the workspace or protected');
  return {...base, real};
}

export async function readWorkspace(cfg, {workspace, path: relative = '.'} = {}) {
  const target = await resolveChild(cfg, workspace, relative);
  const stat = await fs.stat(target.real);
  const shown = path.relative(target.root, target.real) || '.';
  if (stat.isDirectory()) {
    const entries = (await fs.readdir(target.real, {withFileTypes: true})).filter(e => !PROTECTED.test(e.name));
    const limited = entries.slice(0, cfg.workspaceMaxEntries);
    return {workspace: target.root, path: shown, entries: limited.map(e => ({name: e.name, type: e.isDirectory() ? 'directory' : 'file'})),
      ...(entries.length > limited.length ? {truncated: true, total_entries: entries.length} : {})};
  }
  if (!stat.isFile()) throw new ToolError('workspace_denied', 'only regular files and directories can be read');
  if (stat.size > cfg.workspaceMaxFileBytes) throw new ToolError('workspace_limit', 'file size limit exceeded', {max_bytes: cfg.workspaceMaxFileBytes});
  return {workspace: target.root, path: shown, content: maskSecrets(await fs.readFile(target.real, 'utf8'))};
}

/** Yields regular files below dir without following links or entering protected or dependency folders. */
async function* files(dir, budget) {
  const entries = await fs.readdir(dir, {withFileTypes: true}).catch(() => []);
  for (const entry of entries) {
    if (budget.remaining <= 0) return;
    if (PROTECTED.test(entry.name) || entry.isSymbolicLink()) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) yield* files(file, budget); continue; }
    if (!entry.isFile()) continue;
    budget.remaining--;
    yield file;
  }
}

const WORKER_SOURCE = `
const {parentPort, workerData} = require('node:worker_threads');
const matcher = new RegExp(workerData.pattern, 'i');
parentPort.on('message', ({id, text, limit}) => {
  const hits = [];
  const lines = text.split(/\\r?\\n/);
  for (let i = 0; i < lines.length && hits.length < limit; i++) if (matcher.test(lines[i])) hits.push(i);
  parentPort.postMessage({id, hits});
});`;

/** A user regular expression runs in a worker that is terminated when one file takes too long. */
function regexMatcher(pattern) {
  try { new RegExp(pattern, 'i'); } catch { throw new ToolError('invalid_request', 'query is not a valid regular expression'); }
  const worker = new Worker(WORKER_SOURCE, {eval: true, workerData: {pattern}});
  worker.unref();
  let next = 0;
  return {
    match(text, limit) {
      return new Promise((resolve, reject) => {
        const id = ++next;
        const timer = setTimeout(() => { worker.terminate(); reject(new ToolError('regex_timeout', 'regular expression took too long; simplify the pattern', {timeout_ms: REGEX_FILE_TIMEOUT_MS})); }, REGEX_FILE_TIMEOUT_MS);
        const onMessage = message => { if (message.id !== id) return; clearTimeout(timer); worker.off('message', onMessage); resolve(message.hits); };
        worker.on('message', onMessage);
        worker.postMessage({id, text, limit});
      });
    },
    close: () => worker.terminate()
  };
}

export async function searchWorkspace(cfg, {workspace, query, regex = false, max_results = 50} = {}) {
  if (typeof query !== 'string' || !query.trim()) throw new ToolError('invalid_request', 'query is required');
  const target = await resolveWorkspace(cfg, workspace);
  const matcher = regex ? regexMatcher(query) : null;
  const needle = query.toLowerCase();
  const results = [];
  const budget = {remaining: cfg.workspaceMaxFiles};
  let scanned = 0;
  try {
    for await (const file of files(target.real, budget)) {
      if (results.length >= max_results) break;
      const stat = await fs.stat(file).catch(() => null);
      if (!stat || stat.size > cfg.workspaceMaxFileBytes) continue;
      const text = await fs.readFile(file, 'utf8').catch(() => '');
      scanned++;
      const lines = text.split(/\r?\n/);
      const limit = max_results - results.length;
      const hits = matcher ? await matcher.match(text, limit) : lines.flatMap((line, i) => (line.toLowerCase().includes(needle) ? [i] : [])).slice(0, limit);
      for (const i of hits) results.push({path: path.relative(target.root, file), line: i + 1, text: maskSecrets(lines[i].slice(0, cfg.workspaceMaxLineChars))});
    }
  } finally {
    await matcher?.close();
  }
  return {workspace: target.root, query, results, files_scanned: scanned, ...(budget.remaining <= 0 ? {file_limit_reached: true} : {})};
}

function runGit(cfg, cwd, args) {
  // Only what git needs to run; provider keys and tokens in this process never reach the child.
  const env = {GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C'};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'TEMP', 'TMP']) if (process.env[name]) env[name] = process.env[name];
  const hardened = ['-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', '-c', 'core.hooksPath=', '-c', 'diff.external=', '-c', 'log.showSignature=false', '--no-pager'];
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...hardened, ...args], {cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true});
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), cfg.workspaceCommandTimeoutMs);
    child.stdout.on('data', d => { stdout += d; if (stdout.length > cfg.workspaceMaxOutputChars) child.kill('SIGKILL'); });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', () => { clearTimeout(timer); reject(new ToolError('git_unavailable', 'git is not installed or not on PATH')); });
    child.on('close', code => { clearTimeout(timer); resolve({code, stdout, stderr}); });
  });
}

export async function gitReadonly(cfg, {workspace, operation = 'status'} = {}) {
  if (!['status', 'diff', 'log', 'show'].includes(operation)) throw new ToolError('invalid_request', 'unsupported git readonly operation');
  const target = await resolveWorkspace(cfg, workspace);
  const top = await runGit(cfg, target.real, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0) throw new ToolError('git_not_repository', 'workspace is not inside a git repository');
  const toplevel = await fs.realpath(path.resolve(top.stdout.trim())).catch(() => '');
  if (!toplevel || !within(toplevel, target.root)) throw new ToolError('git_repository_outside_root', 'the git repository starts outside the configured workspace root');
  // Repository-local configuration is untrusted: refuse settings that make git run programs.
  const local = await runGit(cfg, target.real, ['config', '--local', '--includes', '--name-only', '--list']);
  const risky = local.stdout.split(/\r?\n/).filter(name => RISKY_GIT_CONFIG.test(name.trim()));
  if (risky.length) throw new ToolError('git_config_unsafe', 'repository configuration can execute programs; refusing to run git', {keys: [...new Set(risky)].slice(0, 20)});
  const args = {status: ['status', '--short'], diff: ['diff', '--no-ext-diff', '--no-textconv', '--'], log: ['log', '-n', '20', '--oneline'],
    show: ['show', '--stat', '--oneline', '--no-ext-diff', '--no-textconv', 'HEAD']}[operation];
  const out = await runGit(cfg, target.real, args);
  if (out.code !== 0) throw new ToolError('git_readonly_failed', 'git readonly command failed', {operation, exit_code: out.code});
  return {operation, output: maskSecrets(out.stdout.slice(0, cfg.workspaceMaxOutputChars)), ...(out.stdout.length > cfg.workspaceMaxOutputChars ? {truncated: true} : {})};
}
