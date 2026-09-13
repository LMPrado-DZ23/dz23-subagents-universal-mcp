#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
export const root = fileURLToPath(new URL('../', import.meta.url));

export function forbiddenPath(name) {
  const parts = name.replaceAll('\\','/').split('/');
  return parts.some(part => ['.git','node_modules','secrets','state','.dz23-state','.dz23-subagents','generated'].includes(part)) ||
    parts.some(part => /^\.env(?:\..*)?$/.test(part) && part !== '.env.example') ||
    parts.some(part => /^(?:credentials?|secrets?)(?:[._-].*)?\.json$/i.test(part) || /^token(?:[._-].*)?\.txt$/i.test(part)) ||
    /\.(?:pem|key|p12|pfx|log|tmp|bak|zip|mcpb)$/i.test(name);
}
// Heuristic release guard shared with runtime log redaction; not a complete DLP test.
import {secretDetected} from '../src/redact.js';
export {secretDetected};
export function checkRelease(base = root) {
  const manifest = JSON.parse(fs.readFileSync(path.join(base,'PUBLIC_FILES.json'),'utf8'));
  const version = JSON.parse(fs.readFileSync(path.join(base,'package.json'),'utf8')).version;
  if (manifest.version !== version) throw new Error('Manifest/package version mismatch');
  const seen = new Set();
  for (const entry of manifest.files) {
    const name = entry.path;
    if (typeof name !== 'string' || path.isAbsolute(name) || name.includes('\\') || name.split('/').some(p=>p==='..'||p==='.'||!p) || forbiddenPath(name) || seen.has(name)) throw new Error('Unsafe or duplicate manifest path');
    seen.add(name);
    const file = path.resolve(base,name);
    if (!file.startsWith(path.resolve(base)+path.sep)) throw new Error('Path outside project');
    let parent = file;
    while (parent !== path.resolve(base)) {if(fs.lstatSync(parent).isSymbolicLink())throw new Error(`Symbolic link is not publishable: ${name}`);parent=path.dirname(parent);}
    const data = fs.readFileSync(file);
    if (data.length > 5_000_000) throw new Error(`Unexpected large file: ${name}`);
    if (createHash('sha256').update(data).digest('hex') !== entry.sha256) throw new Error(`Integrity mismatch: ${name}`);
    if (secretDetected(data.toString('utf8'))) throw new Error(`Possible secret in ${name} (value not printed)`);
    if (name === '.env.example') for (const line of data.toString('utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD))\s*=\s*(.*)$/);
      if (m && m[2].trim() && !(m[1]==='CUSTOM_API_KEY'&&m[2].trim()==='local')) throw new Error('Nonempty credential in .env.example');
    }
  }
  for(const needed of ['LICENSE','README.md','.gitignore','.env.example','package.json','src/index.js','scripts/publish-github.mjs'])if(!seen.has(needed))throw new Error(`Missing required file: ${needed}`);
  return {version,files:[...seen,'PUBLIC_FILES.json'],checked:seen.size};
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { const report=checkRelease();console.log(`RELEASE_CHECK=PASS version=${report.version} files=${report.checked}; no matched secret patterns.`); }
  catch(error) { console.error(error.message); process.exitCode=1; }
}
