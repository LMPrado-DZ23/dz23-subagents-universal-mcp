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
const codex=`\n[mcp_servers.dz23-subagents]\ncommand = ${JSON.stringify(node)}\nargs = [${JSON.stringify(entry)}, "--stdio"]\n`;
if(target==='claude'||target==='all') write(path.join(root,'config','generated','claude_desktop_config.snippet.json'),JSON.stringify(claude,null,2));
if(target==='codex'||target==='all') write(path.join(root,'config','generated','codex_config.snippet.toml'),codex.trimStart());
console.log('Generated reviewable snippets only. Existing harness configuration was not modified.');
