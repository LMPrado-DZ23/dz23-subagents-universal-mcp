import fs from 'node:fs/promises';
import path from 'node:path';
import {ToolError} from './errors.js';

const SECRET_PART = /^(?:\.env(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)|\.ssh|\.git|credentials?(?:\..*)?|secrets?(?:\..*)?|.*(?:key|token|secret|password).*\.(?:json|ya?ml|txt|pem|key))$/i;
const UNC = /^(?:\\\\|\/\/)/;

function roots(cfg) { return (cfg.workspaceRoots || []).map(x => path.resolve(x)); }
function isHiddenSecret(rel) { return rel.split(path.sep).some(part => SECRET_PART.test(part)); }
function within(file, root) { return file === root || file.startsWith(`${root}${path.sep}`); }

export async function resolveWorkspace(cfg, requested) {
  if (!requested || typeof requested !== 'string' || UNC.test(requested)) throw new ToolError('workspace_denied', 'workspace path is not allowed');
  const allowed = roots(cfg);
  if (!allowed.length) throw new ToolError('workspace_denied', 'DZ23_WORKSPACE_ROOTS is not configured');
  const requestedAbs = path.resolve(requested);
  const real = await fs.realpath(requestedAbs).catch(() => { throw new ToolError('workspace_not_found', 'workspace path was not found'); });
  const root = allowed.find(candidate => within(real, candidate));
  if (!root || isHiddenSecret(path.relative(root, real))) throw new ToolError('workspace_denied', 'path is outside the configured workspace roots or protected');
  return {root, real};
}

async function resolveChild(cfg, workspace, relative) {
  if (typeof relative !== 'string' || relative.includes('\0') || UNC.test(relative) || path.isAbsolute(relative)) throw new ToolError('workspace_denied', 'relative workspace path required');
  const base = await resolveWorkspace(cfg, workspace);
  const candidate = path.resolve(base.real, relative);
  const real = await fs.realpath(candidate).catch(() => { throw new ToolError('workspace_not_found', 'workspace path was not found'); });
  if (!within(real, base.real) || isHiddenSecret(path.relative(base.real, real))) throw new ToolError('workspace_denied', 'path is outside the workspace or protected');
  return {...base, real};
}

export async function readWorkspace(cfg, {workspace, path: relative = '.'} = {}) {
  const target = await resolveChild(cfg, workspace, relative);
  const stat = await fs.stat(target.real);
  if (stat.isDirectory()) {
    const entries = await fs.readdir(target.real, {withFileTypes: true});
    if (entries.length > cfg.workspaceMaxEntries) throw new ToolError('workspace_limit', 'directory entry limit exceeded');
    return {workspace: target.real, path: path.relative(target.root, target.real) || '.', entries: entries.map(e => ({name:e.name, type:e.isDirectory()?'directory':'file'}))};
  }
  if (stat.size > cfg.workspaceMaxFileBytes) throw new ToolError('workspace_limit', 'file size limit exceeded');
  return {workspace: target.real, path: path.relative(target.root, target.real), content: await fs.readFile(target.real, 'utf8')};
}

async function walk(dir, out, cfg, remaining) {
  if (!remaining.count) return;
  const entries = await fs.readdir(dir, {withFileTypes:true});
  for (const entry of entries) {
    if (!remaining.count || SECRET_PART.test(entry.name)) continue;
    const file = path.join(dir, entry.name);
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink()) continue;
    if (entry.isDirectory()) await walk(file, out, cfg, remaining);
    else if (entry.isFile()) {
      remaining.count--;
      if (stat.size <= cfg.workspaceMaxFileBytes) {
        const text = await fs.readFile(file, 'utf8').catch(() => '');
        out.push({path:path.relative(remaining.root, file), content:text});
      }
    }
  }
}

export async function searchWorkspace(cfg, {workspace, query, regex = false, max_results = 50} = {}) {
  if (typeof query !== 'string' || !query.trim()) throw new ToolError('invalid_request', 'query is required');
  const target = await resolveWorkspace(cfg, workspace);
  const matcher = regex ? new RegExp(query, 'i') : null;
  const files = [];
  await walk(target.real, files, cfg, {count: Math.min(max_results * 4, cfg.workspaceMaxFiles), root: target.root});
  const results = [];
  for (const file of files) {
    const lines = file.content.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (results.length >= max_results) return;
      if (matcher ? matcher.test(line) : line.toLowerCase().includes(query.toLowerCase())) results.push({path:file.path, line:index + 1, text:line.slice(0, cfg.workspaceMaxLineChars)});
    });
  }
  return {workspace: target.real, query, results};
}

export async function gitReadonly(cfg, {workspace, operation = 'status'} = {}) {
  const target = await resolveWorkspace(cfg, workspace);
  if (!['status','diff','log','show'].includes(operation)) throw new ToolError('invalid_request', 'unsupported git readonly operation');
  const args = operation === 'status' ? ['status','--short'] : operation === 'diff' ? ['diff','--no-ext-diff','--'] : operation === 'log' ? ['log','-n','20','--oneline'] : ['show','--stat','--oneline','HEAD'];
  const {spawn} = await import('node:child_process');
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {cwd:target.real, env:{PATH:process.env.PATH || ''}, stdio:['ignore','pipe','pipe']});
    let stdout='', stderr='';
    const timer=setTimeout(()=>child.kill('SIGKILL'), cfg.workspaceCommandTimeoutMs);
    child.stdout.on('data', d=>{stdout+=d; if(stdout.length>cfg.workspaceMaxOutputChars) child.kill('SIGKILL');});
    child.stderr.on('data', d=>{stderr+=d;});
    child.on('error', reject);
    child.on('close', code=>{clearTimeout(timer); if(code!==0) reject(new ToolError('git_readonly_failed','git readonly command failed',{operation, exit_code:code})); else resolve({operation, output:stdout.slice(0,cfg.workspaceMaxOutputChars), stderr:stderr.slice(0,1000)});});
  });
}
