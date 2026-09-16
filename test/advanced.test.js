import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ProjectMemory} from '../src/memory.js';
import {Router} from '../src/core.js';
import {providerRegistry} from '../src/providers.js';

test('swarm can run more workers than providers using bounded provider slots', { timeout: 20_000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dz23-adv-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  // This test measures limiter overlap, not durability: fsync on a loaded machine made setup exceed the watchdog.
  const memory = new ProjectMemory(root, { durableWrites: false });
  const registry = { one: { name: 'one', baseURL: 'http://fake', apiKey: 'x', keyName: 'X', credentialSource: 'env:X', defaultModel: 'm1', tier: 'free-tier', protocol: 'openai', location: 'cloud', capabilities: { text: true }, enabled: true, configured: true } };
  const started = Promise.withResolvers(), submitted = Promise.withResolvers(), release = Promise.withResolvers();
  let active = 0, maxActive = 0, calls = 0, completed = 0;
  const caller = async () => {
    const id = ++calls;
    active++;
    maxActive = Math.max(maxActive, active);
    try {
      if (calls === 3) started.resolve();
      await release.promise;
      return { content: `worker-${id}` };
    } finally { active--; completed++; }
  };
  const cfg = { rotation: ['one:m1'], allowPaid: false, policy: 'free-first', maxConcurrency: 5, maxWorkersPerTarget: 3, timeoutMs: 1000, healthTimeoutMs: 1000, maxContextChars: 50000 };
  const router = new Router(cfg, memory, { caller, registry });
  // Observe submission, without replacing the actual limiter or provider-call path.
  const callTarget = router.callTarget.bind(router);
  let submittedCalls = 0;
  router.callTarget = (...args) => {
    const result = callTarget(...args);
    if (++submittedCalls === 5) submitted.resolve();
    return result;
  };
  const work = router.swarmRun({ project_id: 'p', mission_id: 'm', goal: 'build', roles: ['architect', 'backend', 'frontend', 'security', 'qa'], max_agents: 5 });
  let watchdog;
  try {
    await Promise.race([
      Promise.all([started.promise, submitted.promise]),
      work.then(() => { throw new Error('Swarm ended before three worker calls overlapped'); }),
      new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error('Expected three concurrent calls to one target')), 10_000); })
    ]);
    assert.equal(active, 3, 'three provider slots must be occupied simultaneously');
    assert.equal(completed, 0);
    assert.equal(calls, 3, 'the remaining two submitted calls must be queued');
    assert.equal(router.limiter.active, 3);
    assert.equal(router.limiter.queue.length, 2);
    release.resolve();
    const out = await work;
    assert.equal(out.workers.length, 5);
    assert.ok(out.workers.every(x => x.ok));
    assert.ok(out.workers.every(x => x.provider === 'one'));
    assert.ok(out.integration?.ok);
    assert.equal(maxActive, 3, 'per-target concurrency limit must be enforced');
    assert.equal(calls, 6, 'five workers plus the integration reviewer');
    assert.equal(active, 0);
    assert.equal(router.limiter.active, 0);
    assert.equal(router.limiter.queue.length, 0);
  } finally {
    clearTimeout(watchdog);
    release.resolve();
    await Promise.allSettled([work]);
  }
});

test('model discovery is cached and inventory never exposes apiKey', async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'dz23-discovery-'));const memory=new ProjectMemory(root);
  const registry={one:{name:'one',baseURL:'http://fake',apiKey:'supersecret',keyName:'X',credentialSource:'env:X',defaultModel:'m1',tier:'free-tier',protocol:'openai',location:'cloud',capabilities:{text:true},enabled:true,configured:true}};
  let n=0;const discoverer=async()=>{n++;return {ok:true,models:[{id:'m1'},{id:'m2'}]};};
  const router=new Router({rotation:['one:m1'],allowPaid:false,policy:'free-first',maxConcurrency:2,maxWorkersPerTarget:2,timeoutMs:1000,healthTimeoutMs:1000,maxContextChars:50000},memory,{caller:async()=>({content:'ok'}),registry,discoverer});
  const a=await router.discover({});const b=await router.discover({});
  assert.equal(a[0].count,2);assert.equal(b[0].count,2);assert.equal(n,1);
  const inv=JSON.stringify(router.inventory());assert.equal(inv.includes('supersecret'),false);assert.equal(inv.includes('apiKey'),false);
});

test('provider registry accepts secret file references and aliases', async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dz23-secret-'));const f=path.join(dir,'key');await fs.writeFile(f,'file-secret\n');
  const old=process.env.GROQ_API_KEY_FILE;const old2=process.env.TogetherAIAPI_KEY;
  try{delete process.env.GROQ_API_KEY;process.env.GROQ_API_KEY_FILE=f;process.env.TogetherAIAPI_KEY='alias-secret';const reg=providerRegistry();assert.equal(reg.groq.apiKey,'file-secret');assert.match(reg.groq.credentialSource,/file:/);assert.equal(reg.together.apiKey,'alias-secret');}finally{if(old===undefined)delete process.env.GROQ_API_KEY_FILE;else process.env.GROQ_API_KEY_FILE=old;if(old2===undefined)delete process.env.TogetherAIAPI_KEY;else process.env.TogetherAIAPI_KEY=old2;}
});
