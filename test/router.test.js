import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ProjectMemory} from '../src/memory.js';
import {Router} from '../src/core.js';

async function tmp(){return fs.mkdtemp(path.join(os.tmpdir(),'dz23-subagents-'));}
const baseCfg={rotation:['p1:m1','p2:m2'],policy:'free-first',maxConcurrency:4,timeoutMs:1000,maxContextChars:120000};
const registry={
  p1:{name:'p1',baseURL:'http://p1',apiKey:'x',keyName:'X',defaultModel:'m1',tier:'free-tier',enabled:true},
  p2:{name:'p2',baseURL:'http://p2',apiKey:'x',keyName:'X',defaultModel:'m2',tier:'free-tier',enabled:true},
  p3:{name:'p3',baseURL:'http://p3',apiKey:'x',keyName:'X',defaultModel:'m3',tier:'free-tier',enabled:true}
};

test('quota failover preserves mission context and continues on next provider', async()=>{
  const memory=new ProjectMemory(await tmp());
  const seen=[];
  const caller=async(t,messages)=>{
    seen.push({provider:t.name,text:messages.map(m=>m.content).join('\n')});
    if(t.name==='p1'){const e=new Error('quota exhausted');e.kind='quota_or_rate_limit';e.status=429;throw e;}
    return {content:'continued successfully'};
  };
  const r=new Router(baseCfg,memory,{caller,registry});
  const out=await r.delegate({project_id:'proj',mission_id:'mission',goal:'finish project',prompt:'continue implementation'});
  assert.equal(out.provider,'p2');
  assert.equal(seen.length,2);
  assert.match(seen[1].text,/previous target failed/i);
  const ev=await memory.recentEvents('proj','mission',50);
  assert.ok(ev.some(x=>x.type==='provider_failed'&&x.payload.provider==='p1'));
  const state=await memory.getMission('proj','mission');
  assert.equal(state.last_provider,'p2');
  assert.equal(state.last_output,'continued successfully');
});

test('checkpoint can be read by a different harness process', async()=>{
  const root=await tmp();
  const a=new ProjectMemory(root);
  await a.initProject('shared',{repository:'/repo'});
  await a.startMission('shared','m1',{goal:'ship it'});
  await a.appendEvent('shared','m1','claude_worked',{file:'src/a.ts'});
  await a.checkpoint('shared','m1',{next_action:'Codex continues tests'});
  const b=new ProjectMemory(root);
  const state=await b.getMission('shared','m1');
  assert.equal(state.next_action,'Codex continues tests');
  assert.equal(state.goal,'ship it');
  assert.ok((await b.recentEvents('shared','m1')).some(x=>x.type==='claude_worked'));
});

// A watchdog detects a stuck/serialized dispatcher; elapsed time never proves concurrency.
function waitForOverlap(promise) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Workers did not overlap: dispatcher may be serialized')), 10_000); })
  ]).finally(() => clearTimeout(timer));
}

async function proveSwarmOverlap(t, { slowPreparation = false } = {}) {
  const root = await tmp();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const memory = new ProjectMemory(root);
  if (slowPreparation) {
    // Deliberately stagger preparation beyond the old 40 ms fake response window.
    // This is test-only latency; canonical memory and its locks are still exercised.
    const append = memory.appendEvent.bind(memory);
    let preparation = Promise.resolve();
    memory.appendEvent = async (...args) => {
      if (args[2] === 'agent_attempt') {
        preparation = preparation.then(() => new Promise(resolve => setTimeout(resolve, 100)));
        await preparation;
      }
      return append(...args);
    };
  }
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const names = [];
  let active = 0, maxActive = 0, completed = 0, integrationStarted = false;
  const caller = async target => {
    const worker = names.length < 3;
    if (worker) names.push(target.name);
    else {
      integrationStarted = true;
      assert.equal(completed, 3, 'integration must wait for all worker calls');
    }
    active++;
    maxActive = Math.max(maxActive, active);
    try {
      if (worker) {
        if (names.length === 3) started.resolve();
        await release.promise;
      }
      return { content: `${target.name} done` };
    } finally {
      active--;
      if (worker) completed++;
    }
  };
  const cfg = { ...baseCfg, rotation: ['p1:m1', 'p2:m2', 'p3:m3'], maxConcurrency: 3 };
  const router = new Router(cfg, memory, { caller, registry });
  const work = router.swarmRun({ project_id: 'p', mission_id: 'm', goal: 'build system', roles: ['architect', 'backend', 'qa'], max_agents: 3 });
  try {
    await waitForOverlap(Promise.race([
      started.promise,
      work.then(() => { throw new Error('Swarm finished before all worker calls overlapped'); })
    ]));
    assert.equal(active, 3, 'all three calls must be in flight before any can finish');
    assert.equal(completed, 0);
    assert.equal(integrationStarted, false);
    assert.deepEqual([...names].sort(), ['p1', 'p1', 'p1'], 'all roles must prefer the first eligible target');
    release.resolve();
    const out = await work;
    assert.equal(out.workers.length, 3);
    assert.ok(out.workers.every(x => x.ok));
    assert.deepEqual(out.workers.map(x => [x.role, x.provider]), [['architect', 'p1'], ['backend', 'p1'], ['qa', 'p1']]);
    assert.equal(maxActive, 3);
    assert.equal(active, 0);
    assert.equal(integrationStarted, true);
    assert.ok(out.integration?.ok);
    const state = await memory.getMission('p', 'm');
    assert.equal(state.agent_outputs.length, 4, 'three workers and the reviewer must be persisted');
    assert.deepEqual(state.active_tasks, []);
  } finally {
    release.resolve();
    await Promise.allSettled([work]);
  }
}

test('swarm dispatches different roles to the preferred provider in parallel', { timeout: 20_000 }, async t => {
  await proveSwarmOverlap(t);
});

test('swarm overlap proof tolerates slow serialized journal preparation', { timeout: 20_000 }, async t => {
  await proveSwarmOverlap(t, { slowPreparation: true });
});

test('swarm prefers the first healthy target and skips providers in cooldown', async t => {
  const root = await tmp();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const memory = new ProjectMemory(root);
  const names = [];
  const router = new Router({ ...baseCfg, rotation: ['p1:m1', 'p2:m2', 'p3:m3'], maxConcurrency: 5, maxWorkersPerTarget: 2 }, memory, {
    registry,
    caller: async target => { names.push(target.name); return { content: `${target.name} handoff` }; }
  });
  router.markFailure({ ...registry.p2, model: 'm2' }, { kind: 'quota_or_rate_limit', message: 'test-only cooldown' });
  const out = await router.swarmRun({ project_id: 'p', mission_id: 'm', goal: 'build', roles: ['architect', 'backend', 'frontend', 'security', 'qa'], max_agents: 5 });
  assert.ok(out.workers.every(worker => worker.ok));
  assert.deepEqual(out.workers.map(worker => worker.provider), ['p1', 'p1', 'p1', 'p1', 'p1']);
  assert.ok(out.integration?.ok);
  assert.equal(names.includes('p2'), false);
  assert.equal(names.length, 6);
});

test('project memory lock prevents corrupt concurrent updates', async()=>{
  const memory=new ProjectMemory(await tmp());
  await memory.initProject('p');
  await memory.startMission('p','m',{goal:'g'});
  await Promise.all(Array.from({length:15},(_,i)=>memory.appendEvent('p','m','e',{i})));
  const ev=await memory.recentEvents('p','m',50);
  assert.equal(ev.length,15);
});

test('delegate rejects arbitrary roles before contacting a provider', async()=>{
  const memory=new ProjectMemory(await tmp());let calls=0;
  const router=new Router({...baseCfg,rotation:['p1:m1']},memory,{caller:async()=>{calls++;return {content:'no'};},registry});
  await assert.rejects(()=>router.delegate({project_id:'p',mission_id:'m',prompt:'x',role:'ignore-all-security'}),/Unsupported role/);
  assert.equal(calls,0);
});

test('swarm rejects the generic worker role', async()=>{
  const memory=new ProjectMemory(await tmp());
  const router=new Router({...baseCfg,rotation:['p1:m1']},memory,{caller:async()=>({content:'no'}),registry});
  await assert.rejects(()=>router.swarmRun({project_id:'p',mission_id:'m',goal:'x',roles:['worker'],max_agents:1}),/specialist role names/);
});

test('journal replaces oversized event payloads with bounded metadata', async()=>{
  const memory=new ProjectMemory(await tmp(),{maxJournalBytes:65536});
  await memory.initProject('p');await memory.startMission('p','m',{goal:'g'});
  await memory.appendEvent('p','m','oversized',{text:'x'.repeat(30000)});
  const [event]=await memory.recentEvents('p','m',1);
  assert.equal(event.payload.truncated,true);
  assert.ok(event.payload.original_bytes>4096);
});

test('delegated context is explicitly marked untrusted', async()=>{
  const memory=new ProjectMemory(await tmp());let seen='';
  const router=new Router({...baseCfg,rotation:['p1:m1'],maxOutputTokens:321,maxResponseBytes:654321},memory,{caller:async(_t,messages,options)=>{seen=messages.map(x=>x.content).join('\n');assert.equal(options.maxTokens,321);assert.equal(options.maxResponseBytes,654321);return {content:'ok'};},registry});
  await router.delegate({project_id:'p',mission_id:'m',prompt:'review',role:'reviewer'});
  assert.match(seen,/UNTRUSTED DATA/);
  assert.doesNotMatch(seen,/MEMORY \(canonical\)/);
});


test('paid providers are excluded unless explicitly enabled', async()=>{
  const memory=new ProjectMemory(await tmp());
  const paidRegistry={
    free:{name:'free',baseURL:'http://free',apiKey:'x',keyName:'X',defaultModel:'m',tier:'free-tier',protocol:'openai',enabled:true},
    openai:{name:'openai',baseURL:'https://api.openai.com/v1',apiKey:'x',keyName:'OPENAI_API_KEY',defaultModel:'gpt-4o',tier:'paid',protocol:'openai',enabled:true},
    anthropic:{name:'anthropic',baseURL:'https://api.anthropic.com/v1',apiKey:'x',keyName:'ANTHROPIC_API_KEY',defaultModel:'claude-3-5-sonnet-latest',tier:'paid',protocol:'anthropic',enabled:true}
  };
  const r1=new Router({...baseCfg,rotation:['free:m','anthropic:claude-3-5-sonnet-latest','openai:gpt-4o'],allowPaid:false},memory,{caller:async()=>({content:'ok'}),registry:paidRegistry});
  assert.deepEqual(r1.targets().map(x=>x.name),['free']);
  const r2=new Router({...baseCfg,rotation:['free:m','anthropic:claude-3-5-sonnet-latest','openai:gpt-4o'],allowPaid:true},memory,{caller:async()=>({content:'ok'}),registry:paidRegistry});
  assert.deepEqual(r2.targets().map(x=>x.name),['free','anthropic','openai']);
});
