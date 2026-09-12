import fs from 'node:fs';

// Capabilities implemented by THIS adapter surface, not vendor marketing claims.
const C = () => ({text:true,coding:'model-dependent',reasoning:'model-dependent',vision:false,tools:false,embeddings:false,streaming:false});

const defs = {
  openai: {baseURL:'https://api.openai.com/v1',keyName:'OPENAI_API_KEY',defaultModel:'gpt-4o',tier:'paid',protocol:'openai',location:'cloud',capabilities:C()},
  anthropic: {baseURL:'https://api.anthropic.com/v1',keyName:'ANTHROPIC_API_KEY',defaultModel:'',tier:'paid',protocol:'anthropic',location:'cloud',capabilities:C()},
  gemini: {baseURL:'https://generativelanguage.googleapis.com/v1beta/openai',keyName:'GEMINI_API_KEY',defaultModel:'',tier:'mixed',protocol:'openai',location:'cloud',capabilities:C()},
  openrouter: {baseURL:'https://openrouter.ai/api/v1',keyName:'OPENROUTER_API_KEY',defaultModel:'openrouter/auto',tier:'mixed',protocol:'openai',location:'cloud',capabilities:C()},
  deepseek: {baseURL:'https://api.deepseek.com/v1',keyName:'DEEPSEEK_API_KEY',defaultModel:'deepseek-chat',tier:'low-cost',protocol:'openai',location:'cloud',capabilities:C()},
  groq: {baseURL:'https://api.groq.com/openai/v1',keyName:'GROQ_API_KEY',defaultModel:'llama-3.3-70b-versatile',tier:'free-tier',protocol:'openai',location:'cloud',capabilities:C()},
  huggingface: {baseURL:'https://router.huggingface.co/v1',keyName:'HUGGINGFACE_TOKEN',aliases:['HF_TOKEN'],defaultModel:'deepseek-ai/DeepSeek-R1:fastest',tier:'free-tier',protocol:'openai',location:'cloud',capabilities:C()},
  together: {baseURL:'https://api.together.xyz/v1',keyName:'TOGETHER_API_KEY',aliases:['TogetherAIAPI_KEY'],defaultModel:'meta-llama/Llama-3.3-70B-Instruct-Turbo',tier:'mixed',protocol:'openai',location:'cloud',capabilities:C()},
  fireworks: {baseURL:'https://api.fireworks.ai/inference/v1',keyName:'FIREWORKS_API_KEY',defaultModel:'accounts/fireworks/models/llama-v3p3-70b-instruct',tier:'mixed',protocol:'openai',location:'cloud',capabilities:C()},
  cerebras: {baseURL:'https://api.cerebras.ai/v1',keyName:'CEREBRAS_API_KEY',defaultModel:'llama-3.3-70b',tier:'free-tier',protocol:'openai',location:'cloud',capabilities:C()},
  mistral: {baseURL:'https://api.mistral.ai/v1',keyName:'MISTRAL_API_KEY',defaultModel:'mistral-large-latest',tier:'mixed',protocol:'openai',location:'cloud',capabilities:C()},
  xai: {baseURL:'https://api.x.ai/v1',keyName:'XAI_API_KEY',defaultModel:'grok-4',tier:'paid',protocol:'openai',location:'cloud',capabilities:C()},
  perplexity: {baseURL:'https://api.perplexity.ai',keyName:'PERPLEXITY_API_KEY',defaultModel:'sonar',tier:'paid',protocol:'openai',location:'cloud',capabilities:C()},
  github: {baseURL:'https://models.inference.ai.azure.com',keyName:'GITHUB_TOKEN',defaultModel:'gpt-4o-mini',tier:'free-tier',protocol:'openai',location:'cloud',capabilities:C()},
  sambanova: {baseURL:'https://api.sambanova.ai/v1',keyName:'SAMBANOVA_API_KEY',defaultModel:'Meta-Llama-3.3-70B-Instruct',tier:'free-tier',protocol:'openai',location:'cloud',capabilities:C()},
  nvidia: {baseURL:'https://integrate.api.nvidia.com/v1',keyName:'NVIDIA_API_KEY',defaultModel:'',tier:'free-tier',protocol:'openai',location:'cloud',capabilities:C()},
  novita: {baseURL:'https://api.novita.ai/v3/openai',keyName:'NOVITA_API_KEY',defaultModel:'',tier:'mixed',protocol:'openai',location:'cloud',capabilities:C()},
  upstage: {baseURL:'https://api.upstage.ai/v1',keyName:'UPSTAGE_API_KEY',defaultModel:'solar-pro2',tier:'mixed',protocol:'openai',location:'cloud',capabilities:C()},
  ollama: {baseURL:'https://ollama.com/v1',keyName:'OLLAMA_API_KEY',defaultModel:'',tier:'mixed',protocol:'openai',location:'cloud',capabilities:C()},
  hyperbolic: {baseURL:'https://api.hyperbolic.xyz/v1',keyName:'HYPERBOLIC_API_KEY',defaultModel:'',tier:'mixed',protocol:'openai',location:'cloud',capabilities:C()},
  alibaba: {baseURL:'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',keyName:'ALIBABA_API_KEY',defaultModel:'qwen-plus',tier:'mixed',protocol:'openai',location:'cloud',capabilities:C()},
  cloudflare: {baseURL:'',keyName:'CLOUDFLARE_API_TOKEN',aliases:['CLOUDFLARE_AUTH_TOKEN'],defaultModel:'@cf/openai/gpt-oss-120b',tier:'free-tier',protocol:'openai',location:'cloud',capabilities:C()},
  custom: {baseURL:'http://127.0.0.1:11434/v1',keyName:'CUSTOM_API_KEY',defaultModel:'qwen3-coder',tier:'local',protocol:'openai',location:'local',capabilities:C()},
  lmstudio: {baseURL:'http://127.0.0.1:1234/v1',keyName:'LMSTUDIO_API_KEY',defaultModel:'local-model',tier:'local',protocol:'openai',location:'local',capabilities:C()},
  vllm: {baseURL:'http://127.0.0.1:8000/v1',keyName:'VLLM_API_KEY',defaultModel:'local-model',tier:'local',protocol:'openai',location:'local',capabilities:C()}
};

function envAny(names=[]){ for(const n of names){ if(process.env[n]) return {value:process.env[n],source:`env:${n}`}; const file=process.env[`${n}_FILE`]; if(file){try{return {value:fs.readFileSync(file,'utf8').trim(),source:`file:${n}_FILE`};}catch{throw new Error(`Cannot read configured secret file for ${n}_FILE`);}} } return {value:'',source:'none'}; }
function resolvedBase(name,d){
  const direct=process.env[`${name.toUpperCase()}_BASE_URL`]; if(direct) return direct;
  if(name==='alibaba'&&process.env.ALIBABA_BASE_URL) return process.env.ALIBABA_BASE_URL;
  if(name==='cloudflare'){
    const account=process.env.CLOUDFLARE_ACCOUNT_ID; return process.env.CLOUDFLARE_BASE_URL || (account?`https://api.cloudflare.com/client/v4/accounts/${account}/ai/v1`:'');
  }
  return d.baseURL;
}
function validateBaseURL(raw,name){
  if(!raw)return raw;
  let url;try{url=new URL(raw);}catch{throw new Error(`Invalid base URL for ${name}`);}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new Error(`Base URL for ${name} must be HTTP(S) without credentials, query or fragment`);
  return raw;
}
function resolvedModel(name,d){return process.env[`${name.toUpperCase()}_MODEL`]||d.defaultModel;}
export function providerRegistry(){
  return Object.fromEntries(Object.entries(defs).map(([name,d])=>{
    const secret=envAny([d.keyName,...(d.aliases||[])]); const local=d.location==='local'; const baseURL=validateBaseURL(resolvedBase(name,d),name);
    return [name,{name,baseURL,apiKey:local?(secret.value||'local'):secret.value,keyName:d.keyName,credentialSource:secret.source,defaultModel:resolvedModel(name,d),tier:d.tier,protocol:d.protocol,location:d.location,capabilities:{...d.capabilities},enabled:local||Boolean(secret.value),configured:Boolean(secret.value)||local}];
  }));
}
export function parseTarget(target, registry=providerRegistry()){
  const idx=target.indexOf(':'); const provider=idx<0?target:target.slice(0,idx); const model=idx<0?registry[provider]?.defaultModel:target.slice(idx+1);
  if(!registry[provider]) throw new Error(`Unknown provider: ${provider}`); return {...registry[provider],model:model||registry[provider].defaultModel};
}
export function classifyHttpFailure(status,body=''){
  const b=String(body).toLowerCase();
  if([402,429].includes(status)||b.includes('quota')||b.includes('credit')||b.includes('rate limit')||b.includes('insufficient')||b.includes('too many requests')) return 'quota_or_rate_limit';
  if([401,403].includes(status)) return 'auth_or_entitlement'; if(status===404) return 'model_or_endpoint_missing'; if(status>=500) return 'provider_unavailable'; return 'provider_error';
}
function retryAfterMs(headers){const v=headers?.get?.('retry-after');if(!v)return 0;const n=Number(v);if(Number.isFinite(n))return Math.max(0,n*1000);const d=Date.parse(v);return Number.isFinite(d)?Math.max(0,d-Date.now()):0;}
async function fetchText(url,opts,meta={}){const r=await fetch(url,opts);const text=await r.text();if(!r.ok){const e=new Error(`${meta.name||'provider'}:${meta.model||''} HTTP ${r.status}: ${classifyHttpFailure(r.status,text)}`);e.status=r.status;e.kind=classifyHttpFailure(r.status,text);e.provider=meta.name;e.model=meta.model;e.retryAfterMs=retryAfterMs(r.headers);throw e;}return {r,text};}
export async function callOpenAICompatible(target,messages,{timeoutMs=90000,signal,temperature=0.2,maxTokens=4096}={}){
  const ctl=new AbortController();const timer=setTimeout(()=>ctl.abort(new Error('provider_timeout')),timeoutMs);if(signal)signal.addEventListener('abort',()=>ctl.abort(signal.reason),{once:true});
  try{const headers={'content-type':'application/json'};if(target.apiKey&&target.apiKey!=='local')headers.authorization=`Bearer ${target.apiKey}`;const {text}=await fetchText(`${target.baseURL.replace(/\/$/,'')}/chat/completions`,{method:'POST',headers,signal:ctl.signal,body:JSON.stringify({model:target.model,messages,temperature,max_tokens:maxTokens})},target);let data;try{data=JSON.parse(text);}catch{throw new Error(`Invalid JSON from ${target.name}`);}const content=data?.choices?.[0]?.message?.content;if(typeof content!=='string')throw new Error(`No assistant content from ${target.name}`);return {content,usage:data.usage||null,raw:data};}finally{clearTimeout(timer);}
}
function anthropicMessages(messages){const system=messages.filter(m=>m.role==='system').map(m=>m.content).join('\n\n');const rest=messages.filter(m=>m.role!=='system').map(m=>({role:m.role==='assistant'?'assistant':'user',content:String(m.content??'')}));return {system,messages:rest};}
export async function callAnthropic(target,messages,{timeoutMs=90000,signal,temperature=0.2,maxTokens=4096}={}){
  const ctl=new AbortController();const timer=setTimeout(()=>ctl.abort(new Error('provider_timeout')),timeoutMs);if(signal)signal.addEventListener('abort',()=>ctl.abort(signal.reason),{once:true});
  try{const {system,messages:anthropicMsgs}=anthropicMessages(messages);const {text}=await fetchText(`${target.baseURL.replace(/\/$/,'')}/messages`,{method:'POST',headers:{'content-type':'application/json','x-api-key':target.apiKey,'anthropic-version':'2023-06-01'},signal:ctl.signal,body:JSON.stringify({model:target.model,system,messages:anthropicMsgs,temperature,max_tokens:maxTokens})},target);let data;try{data=JSON.parse(text);}catch{throw new Error(`Invalid JSON from ${target.name}`);}const content=(data?.content||[]).filter(x=>x?.type==='text').map(x=>x.text).join('\n');if(!content)throw new Error(`No assistant content from ${target.name}`);return {content,usage:data.usage||null,raw:data};}finally{clearTimeout(timer);}
}
export async function callProvider(target,messages,opts={}){if(target.protocol==='anthropic')return callAnthropic(target,messages,opts);if(!target.baseURL)throw Object.assign(new Error(`${target.name}: missing base URL`),{kind:'configuration'});if(!target.model)throw Object.assign(new Error(`${target.name}: missing model`),{kind:'configuration'});return callOpenAICompatible(target,messages,opts);}
export async function discoverModels(target,{timeoutMs=15000}={}){
  if(!target.baseURL) return {ok:false,models:[],error:'missing_base_url'};
  const ctl=new AbortController();const timer=setTimeout(()=>ctl.abort(),timeoutMs);
  try{const headers={};if(target.protocol==='anthropic'){headers['x-api-key']=target.apiKey;headers['anthropic-version']='2023-06-01';}else if(target.apiKey&&target.apiKey!=='local')headers.authorization=`Bearer ${target.apiKey}`;const {text}=await fetchText(`${target.baseURL.replace(/\/$/,'')}/models`,{headers,signal:ctl.signal},target);const data=JSON.parse(text);const arr=Array.isArray(data?.data)?data.data:Array.isArray(data?.models)?data.models:[];return {ok:true,models:arr.slice(0,500).map(m=>({id:m.id||m.name||String(m),owned_by:m.owned_by,architecture:m.architecture,providers:m.providers}))};}catch(e){return {ok:false,models:[],kind:e.kind||'error',error:e.message};}finally{clearTimeout(timer);}
}
