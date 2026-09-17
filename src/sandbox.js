import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {ToolError} from './errors.js';
import {safeRepository, runGit, isProtectedName} from './workspace.js';
import {maskSecrets} from './privacy.js';

// Patch validation in a throwaway copy. The original working tree is never written: the repository is
// cloned (--shared, objects only) into a temporary folder, the diff is applied there and one command from
// the operator's allowlist runs with a minimal environment and a timeout. Off unless DZ23_SANDBOX_ENABLED.
let busy = false;
const GIT_LONG = cfg => ({...cfg, workspaceCommandTimeoutMs: Math.max(cfg.workspaceCommandTimeoutMs || 10_000, 120_000), workspaceMaxOutputChars: 1024 * 1024});

/** Paths a unified diff touches; refuses absolute paths, parent segments, .git and protected names. */
export function patchedFiles(patch) {
  const files = new Set();
  for (const line of String(patch).split(/\r?\n/)) {
    let match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    const paths = match ? [match[1], match[2]] : [];
    match = /^(?:\+\+\+|---) (?:[ab]\/)?(.+?)(?:\t.*)?$/.exec(line);
    if (match && match[1] !== '/dev/null') paths.push(match[1]);
    match = /^(?:rename|copy) (?:from|to) (.+)$/.exec(line);
    if (match) paths.push(match[1]);
    for (const file of paths) {
      const parts = file.split(/[\\/]/);
      if (path.isAbsolute(file) || /^[A-Za-z]:/.test(file) || parts.includes('..') || parts.some(part => part === '.git' || isProtectedName(part))) {
        throw new ToolError('patch_denied', 'the patch touches a protected or out-of-tree path', {path: file.slice(0, 200)});
      }
      files.add(parts.join('/'));
    }
  }
  if (!files.size) throw new ToolError('invalid_request', 'patch must be a unified diff');
  return [...files];
}

function minimalEnv(home) {
  const env = {CI: '1', HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, TEMP: home, TMP: home, TMPDIR: home};
  for (const name of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'COMSPEC', 'LANG']) if (process.env[name]) env[name] = process.env[name];
  return env;
}

function killTree(child) {
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {windowsHide: true, stdio: 'ignore'});
  else try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
}

const tail = (text, max) => maskSecrets(text.length > max ? `…${text.slice(-max)}` : text);

function run(cfg, {command, work, home, timeoutMs}) {
  const docker = cfg.sandboxMode === 'docker';
  const name = `dz23-sandbox-${crypto.randomUUID()}`;
  const child = docker
    ? spawn('docker', ['run', '--rm', '--name', name, '--network', 'none', '--cpus', '2', '--memory', '2g', '--pids-limit', '512', '-v', `${work}:/work`, '-w', '/work', cfg.sandboxImage, 'sh', '-c', command],
      {env: minimalEnv(home), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true})
    : spawn(command, {cwd: work, shell: true, env: minimalEnv(home), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32'});
  const max = cfg.sandboxMaxOutputChars || 65_536;
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  const keep = (buffer, chunk) => { const next = buffer + chunk; return next.length > max * 2 ? next.slice(-max) : next; };
  return new Promise(resolve => {
    const started = Date.now();
    const timer = setTimeout(() => {
      timedOut = true;
      if (docker) spawn('docker', ['kill', name], {stdio: 'ignore', windowsHide: true});
      killTree(child);
    }, timeoutMs);
    child.stdout.on('data', d => { stdout = keep(stdout, d); });
    child.stderr.on('data', d => { stderr = keep(stderr, d); });
    child.on('error', error => { clearTimeout(timer); resolve({exit_code: null, timed_out: false, spawn_error: error.code || 'spawn_failed', duration_ms: Date.now() - started, stdout: '', stderr: ''}); });
    child.on('close', code => { clearTimeout(timer); resolve({exit_code: code, timed_out: timedOut, duration_ms: Date.now() - started, stdout: tail(stdout, max), stderr: tail(stderr, max)}); });
  });
}

export async function patchValidate(cfg, {workspace, patch, command, timeout_ms} = {}) {
  if (!cfg.sandboxEnabled) throw new ToolError('sandbox_disabled', 'patch validation is disabled; set DZ23_SANDBOX_ENABLED=true and DZ23_SANDBOX_COMMANDS');
  if (!(cfg.sandboxCommands || []).includes(command)) throw new ToolError('command_not_allowed', 'command must match one entry of DZ23_SANDBOX_COMMANDS exactly', {allowed: cfg.sandboxCommands || []});
  const files = patchedFiles(patch);
  if (busy) throw new ToolError('sandbox_busy', 'another patch validation is running');
  busy = true;
  let tmp;
  try {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dz23-sandbox-'));
    const {toplevel} = await safeRepository(cfg, workspace);
    const head = await runGit(cfg, toplevel, ['rev-parse', 'HEAD']);
    if (head.code !== 0) throw new ToolError('git_no_commits', 'the repository has no commit to validate against');
    const work = path.join(tmp, 'work');
    const home = path.join(tmp, 'home');
    await fs.mkdir(home);
    const long = GIT_LONG(cfg);
    if ((await runGit(long, tmp, ['clone', '--shared', '--no-checkout', '--quiet', toplevel, work])).code !== 0) throw new ToolError('sandbox_setup_failed', 'could not copy the repository');
    if ((await runGit(long, work, ['checkout', '--quiet', '--detach', head.stdout.trim()])).code !== 0) throw new ToolError('sandbox_setup_failed', 'could not check out HEAD');
    const patchFile = path.join(tmp, 'change.diff');
    await fs.writeFile(patchFile, patch.endsWith('\n') ? patch : `${patch}\n`);
    const check = await runGit(long, work, ['apply', '--check', '--whitespace=nowarn', patchFile]);
    if (check.code !== 0) throw new ToolError('patch_rejected', 'the patch does not apply to HEAD', {detail: tail(check.stderr || check.stdout, 2000)});
    if ((await runGit(long, work, ['apply', '--whitespace=nowarn', patchFile])).code !== 0) throw new ToolError('patch_rejected', 'the patch could not be applied');
    const timeoutMs = Math.min(timeout_ms || cfg.sandboxTimeoutMs || 300_000, cfg.sandboxTimeoutMs || 300_000);
    const result = await run(cfg, {command, work, home, timeoutMs});
    return {mode: cfg.sandboxMode === 'docker' ? 'docker' : 'process', network: cfg.sandboxMode === 'docker' ? 'none' : 'not_isolated',
      head: head.stdout.trim().slice(0, 40), files_changed: files, applied: true, command, passed: result.exit_code === 0 && !result.timed_out, ...result,
      original_workspace_modified: false};
  } finally {
    if (tmp) await fs.rm(tmp, {recursive: true, force: true, maxRetries: 10, retryDelay: 200}).catch(() => undefined);
    busy = false;
  }
}
