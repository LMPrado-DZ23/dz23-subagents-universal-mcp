import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ProjectMemory} from '../src/memory.js';
import {Router} from '../src/core.js';
import {createMcpHandler} from '../src/mcp.js';

test('MCP initialize and tools/list are compatible JSON-RPC payloads', async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'dz23-mcp-'));
  const memory=new ProjectMemory(root);
  const cfg={rotation:[],policy:'free-first',maxConcurrency:2,timeoutMs:1000,maxContextChars:10000};
  const router=new Router(cfg,memory,{registry:{}});
  const h=createMcpHandler(router,memory);
  const init=await h({method:'initialize',params:{protocolVersion:'2025-06-18'}});
  assert.equal(init.serverInfo.name,'dz23-subagents-universal');
  const list=await h({method:'tools/list'});
  const names=list.tools.map(t=>t.name);
  for(const n of ['delegate','swarm_run','mission_status','memory_checkpoint','health_check']) assert.ok(names.includes(n));
  const templates=await h({method:'resources/templates/list'});
  assert.equal(templates.resourceTemplates[0].uriTemplate,'dz23://mission/{project_id}/{mission_id}');
  const prompts=await h({method:'prompts/list'});
  assert.ok(prompts.prompts.some(p=>p.name==='audit_project'));
});
