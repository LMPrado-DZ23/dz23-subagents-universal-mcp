#!/usr/bin/env node
import fs from 'node:fs';
import {config} from './config.js';
import {ProjectMemory} from './memory.js';
import {Router} from './core.js';
import {createMcpHandler} from './mcp.js';
import {startHttp} from './http.js';

// Resolve relative to the installed package, never the host's working directory.
function loadDotEnv(file=new URL('../.env', import.meta.url)){
  if(!fs.existsSync(file)) return; const lines=fs.readFileSync(file,'utf8').split(/\r?\n/);
  for(const line of lines){const m=line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);if(!m||m[1] in process.env)continue;let v=m[2];if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);process.env[m[1]]=v;}
}
loadDotEnv(); const cfg=config(); const memory=new ProjectMemory(cfg.stateDir); const router=new Router(cfg,memory); const handler=createMcpHandler(router,memory);
async function stdio(){
  process.stdin.setEncoding('utf8'); let buf='';
  process.stdin.on('data',async chunk=>{buf+=chunk;let i;while((i=buf.indexOf('\n'))>=0){const line=buf.slice(0,i).trim();buf=buf.slice(i+1);if(!line)continue;let msg;try{msg=JSON.parse(line);}catch{continue;}try{const r=await handler(msg);if(msg.id!==undefined&&r!==null)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:msg.id,result:r})+'\n');}catch(e){if(msg.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:msg.id,error:{code:-32000,message:e.message}})+'\n');}}});
}
const mode=process.argv.includes('--http')?'http':'stdio';
if(mode==='http'){const server=await startHttp(cfg,router,memory,handler);const a=server.address();console.error(`DZ23 Subagents HTTP MCP listening on http://${cfg.host}:${a.port}`);}else{await stdio();}
