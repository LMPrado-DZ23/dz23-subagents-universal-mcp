#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(here,'..');
const node=process.execPath;
const target=(process.argv[2]||'all').toLowerCase();
const supported=new Set(['all','claude','codex']);
if(!supported.has(target)){
  console.error(`Unsupported harness target: ${target}. Use all, claude, or codex.`);
  process.exit(2);
}

function ensureParent(p){fs.mkdirSync(path.dirname(p),{recursive:true});}
function write(p,s){ensureParent(p);fs.writeFileSync(p,s,{mode:0o600});console.log(`WROTE ${p}`);}

const entry=path.join(root,'src','index.js');
if(!fs.existsSync(entry)){
  console.error(`MCP entrypoint not found: ${entry}`);
  process.exit(1);
}

const claude={mcpServers:{'dz23-subagents':{command:node,args:[entry,'--stdio']}}};
// swarm_run and consensus can take minutes; Codex's default tool timeout would cut them off.
const codex=[
  '# Replace any existing [mcp_servers.dz23-subagents] table in ~/.codex/config.toml; never add a second one.',
  '[mcp_servers.dz23-subagents]',
  `command = ${JSON.stringify(node)}`,
  `args = [${JSON.stringify(entry)}, "--stdio"]`,
  'startup_timeout_sec = 30',
  'tool_timeout_sec = 900',
  ''
].join('\n');
// Shell quoting, not JSON: Windows paths keep single backslashes and cannot contain double quotes.
const quote=value=>`"${value.replaceAll('"','\\"')}"`;
const claudeCode=[
  '# Claude Code, user scope. When upgrading, first run: claude mcp remove -s user dz23-subagents',
  `claude mcp add -s user dz23-subagents -- ${quote(node)} ${quote(entry)} --stdio`,
  '# Check with: claude mcp get dz23-subagents',
  ''
].join('\n');
const out=path.join(root,'config','generated');
if(target==='claude'||target==='all'){
  write(path.join(out,'claude_desktop_config.snippet.json'),JSON.stringify(claude,null,2));
  write(path.join(out,'claude_code_add_command.txt'),claudeCode);
}
if(target==='codex'||target==='all') write(path.join(out,'codex_config.snippet.toml'),codex);
console.log('Generated reviewable snippets only. Existing harness configuration was not modified.');
console.log('Upgrading: replace the existing dz23-subagents entry in each harness (see docs/OPERATIONS.md); never keep two entries.');
