import test from 'node:test';
import assert from 'node:assert/strict';
import {callProvider,classifyHttpFailure} from '../src/providers.js';

test('Anthropic native Messages API adapter maps system/user and output', async()=>{
  const old=globalThis.fetch; let request;
  globalThis.fetch=async(url,opts)=>{ request={url,opts,body:JSON.parse(opts.body)}; return new Response(JSON.stringify({content:[{type:'text',text:'anthropic-ok'}],usage:{input_tokens:3,output_tokens:2}}),{status:200,headers:{'content-type':'application/json'}}); };
  try{
    const out=await callProvider({name:'anthropic',protocol:'anthropic',baseURL:'https://api.anthropic.com/v1',apiKey:'secret',model:'claude-test'},[{role:'system',content:'sys'},{role:'user',content:'hello'}],{timeoutMs:1000});
    assert.equal(out.content,'anthropic-ok');
    assert.equal(request.url,'https://api.anthropic.com/v1/messages');
    assert.equal(request.opts.headers['x-api-key'],'secret');
    assert.equal(request.body.system,'sys');
    assert.equal(request.body.messages[0].content,'hello');
  } finally { globalThis.fetch=old; }
});

test('quota classification handles rate and credit exhaustion',()=>{
  // v2.3.0 taxonomy: rate limits are retryable, credit/billing problems are not.
  assert.equal(classifyHttpFailure(429,'rate limit'),'rate_limited');
  assert.equal(classifyHttpFailure(400,'insufficient credit'),'billing_required');
});

test('provider response body is bounded', async()=>{
  const old=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify({choices:[{message:{content:'x'.repeat(1000)}}]}),{status:200});
  try{
    await assert.rejects(()=>callProvider({name:'custom',protocol:'openai',baseURL:'http://127.0.0.1:11434/v1',apiKey:'local',model:'m'},[{role:'user',content:'x'}],{timeoutMs:1000,maxResponseBytes:128}),/exceeds configured limit/);
  } finally { globalThis.fetch=old; }
});

test('provider empty assistant content is rejected for failover', async()=>{
  const old=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify({choices:[{message:{content:'   '}}]}),{status:200});
  try{
    await assert.rejects(()=>callProvider({name:'custom',protocol:'openai',baseURL:'http://127.0.0.1:11434/v1',apiKey:'local',model:'m'},[{role:'user',content:'x'}],{timeoutMs:1000}),/No assistant content/);
  } finally { globalThis.fetch=old; }
});
