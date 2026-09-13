import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {request} from 'node:http';
import {ProjectMemory} from '../src/memory.js';
import {Router} from '../src/core.js';
import {ConcurrencyLimiter} from '../src/concurrency.js';
import {startHttp} from '../src/http.js';
import {createMcpHandler} from '../src/mcp.js';
import {callOpenAICompatible,providerRegistry} from '../src/providers.js';

async function fixture(t, options={}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'dz23-publication-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const memory = new ProjectMemory(dir);
  const cfg = {host:'127.0.0.1',port:0,token:'',rotation:[],allowPaid:false,policy:'free-first',maxConcurrency:3,maxWorkersPerTarget:2,timeoutMs:1000,maxContextChars:50000,...options};
  const router = new Router(cfg,memory,{registry:{}});
  return {memory,cfg,router,handler:createMcpHandler(router,memory)};
}
function target(name,tier='free-tier') {
  return {name,tier,enabled:true,configured:true,baseURL:'http://fixture.invalid',defaultModel:'m',model:'m',apiKey:'synthetic-only'};
}
test('explicit paid and low-cost selection cannot bypass allowPaid=false', async t=>{
  const {memory,cfg}=await fixture(t); let calls=0;
  const registry={premium:target('premium','paid'),budget:target('budget','low-cost')};
  const router=new Router(cfg,memory,{registry,caller:async()=>{calls++;return{content:'unexpected'};}});
  for(const name of Object.keys(registry)) await assert.rejects(router.delegate({project_id:'p',mission_id:name,prompt:'hello',target:`${name}:m`}),/disallowed/);
  assert.equal(calls,0);
});
test('explicit disabled target is rejected before network activity',async t=>{
  const {memory,cfg}=await fixture(t);let calls=0;
  const router=new Router(cfg,memory,{registry:{x:{...target('x'),enabled:false}},caller:async()=>{calls++;}});
  await assert.rejects(router.delegate({prompt:'test',target:'x:m'}),/disabled/);assert.equal(calls,0);
});
test('limiter enforces global and per-target limits and releases failed calls', { timeout: 20_000 }, async () => {
  const limiter = new ConcurrencyLimiter(3, 2);
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  let total = 0, max = 0, perTargetMax = 0, entered = 0;
  const counts = new Map();
  const jobs = Array.from({ length: 14 }, (_, i) => limiter.run(i % 2 ? 'a' : 'b', async () => {
    const key = i % 2 ? 'a' : 'b';
    total++;
    entered++;
    max = Math.max(max, total);
    counts.set(key, (counts.get(key) || 0) + 1);
    perTargetMax = Math.max(perTargetMax, counts.get(key));
    try {
      if (entered === 3) started.resolve();
      await release.promise;
      if (i === 0) throw new Error('synthetic failure');
      return i;
    } finally { total--; counts.set(key, counts.get(key) - 1); }
  }));
  const all = Promise.allSettled(jobs);
  let watchdog;
  try {
    await Promise.race([
      started.promise,
      new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error('Limiter did not admit three concurrent calls')), 10_000); })
    ]);
    assert.equal(total, 3);
    assert.equal(limiter.active, 3);
    assert.equal(limiter.queue.length, 11);
    assert.ok(perTargetMax <= 2);
    release.resolve();
    const results = await all;
    assert.equal(results.filter(x => x.status === 'rejected').length, 1);
    assert.equal(max, 3);
    assert.ok(perTargetMax <= 2);
    assert.equal(limiter.active, 0);
    assert.equal(limiter.queue.length, 0);
    assert.equal(limiter.byTarget.size, 0);
  } finally {
    clearTimeout(watchdog);
    release.resolve();
    await all;
  }
});

test('memory rejects invalid IDs instead of collapsing different projects',async t=>{
  const {memory}=await fixture(t);
  for(const id of ['..','.','a/b','a b','', 'x'.repeat(121)]) {
    assert.throws(()=>memory.projectDir(id),/Invalid memory identifier/);
    assert.throws(()=>memory.missionDir('valid',id),/Invalid memory identifier/);
  }
  assert.notEqual(memory.projectDir('a_b'),memory.projectDir('a-b'));
});
test('HTTP refuses non-loopback binding without a deliberate token',async t=>{
  const {cfg,router,memory,handler}=await fixture(t);
  await assert.rejects(startHttp({...cfg,host:'0.0.0.0'},router,memory,handler),/requires DZ23_MCP_TOKEN/);
});
test('HTTP auth, origin, host, notifications, malformed JSON and methods',async t=>{
  const {cfg,router,memory,handler}=await fixture(t,{token:'test-token-not-a-real-secret'});
  const server=await startHttp(cfg,router,memory,handler);
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const base=`http://127.0.0.1:${server.address().port}`;
  const headers={authorization:`Bearer ${cfg.token}`,'content-type':'application/json'};
  assert.equal((await fetch(`${base}/healthz`)).status,401);
  assert.equal((await fetch(`${base}/healthz`,{headers})).status,200);
  assert.equal((await fetch(`${base}/healthz`,{headers:{...headers,Origin:'https://untrusted.invalid'}})).status,403);
  // node:fetch may normalize Host. Exercise the header on the actual HTTP wire.
  const hostStatus=await new Promise((resolve,reject)=>{
    const req=request(`${base}/healthz`,{headers:{...headers,Host:'untrusted.invalid'}},res=>{res.resume();resolve(res.statusCode);});
    req.on('error',reject);req.end();
  });
  assert.equal(hostStatus,403);
  assert.equal((await fetch(`${base}/mcp`,{headers})).status,405);
  assert.equal((await fetch(`${base}/mcp`,{method:'POST',headers,body:'{'})).status,400);
  assert.equal((await fetch(`${base}/mcp`,{method:'POST',headers,body:'[]'})).status,400);
  const response=await fetch(`${base}/mcp`,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})});
  assert.equal(response.status,202);assert.equal(await response.text(),'');
  // v2.3.0: dated but unsupported revisions receive the latest supported version as counter-offer.
  const init=await fetch(`${base}/mcp`,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2099-01-01'}})});
  assert.equal((await init.json()).result.protocolVersion,'2025-11-25');
});
test('raw provider error bodies are not returned or persisted as messages',async()=>{
  const original=globalThis.fetch;const echo='sensitive-placeholder-for-test';
  try{
    globalThis.fetch=async()=>new Response(JSON.stringify({error:`quota ${echo}`}),{status:429});
    await assert.rejects(callOpenAICompatible(target('test'),[{role:'user',content:'hello'}]),e=>e.kind==='quota_or_rate_limit'&&!e.message.includes(echo));
  }finally{globalThis.fetch=original;}
});
test('inventory capability flags describe the exposed text-only adapter',()=>{
  const all=Object.values(providerRegistry());
  for(const provider of all)for(const name of ['vision','tools','embeddings','streaming'])assert.equal(provider.capabilities[name],false);
});

test('explicit cloud target cannot escape an explicitly local rotation',async t=>{
  const {memory,cfg}=await fixture(t,{rotation:['local:m']});let calls=0;
  const router=new Router(cfg,memory,{registry:{local:target('local','local'),cloud:target('cloud')},caller:async()=>{calls++;return{content:'unexpected'};}});
  await assert.rejects(router.delegate({prompt:'test',target:'cloud:m'}),/rotation policy/);
  assert.equal(calls,0);
});
