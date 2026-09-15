import fs from 'node:fs';
import {ProviderError, classifyHttpFailure, parseRetryAfter} from './provider-errors.js';
import {isPrivateEndpoint} from './endpoints.js';

export {classifyHttpFailure} from './provider-errors.js';

// Capabilities implemented by THIS adapter surface, not vendor marketing claims.
const C = () => ({text: true, coding: 'model-dependent', reasoning: 'model-dependent', vision: false, tools: false, embeddings: false, streaming: false});

const defs = {
  openai: {baseURL: 'https://api.openai.com/v1', keyName: 'OPENAI_API_KEY', defaultModel: 'gpt-4o', tier: 'paid', protocol: 'openai', location: 'cloud', capabilities: C()},
  anthropic: {baseURL: 'https://api.anthropic.com/v1', keyName: 'ANTHROPIC_API_KEY', defaultModel: '', tier: 'paid', protocol: 'anthropic', location: 'cloud', capabilities: C()},
  gemini: {baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', keyName: 'GEMINI_API_KEY', defaultModel: '', tier: 'mixed', protocol: 'openai', location: 'cloud', capabilities: C()},
  openrouter: {baseURL: 'https://openrouter.ai/api/v1', keyName: 'OPENROUTER_API_KEY', defaultModel: 'openrouter/auto', tier: 'mixed', protocol: 'openai', location: 'cloud', capabilities: C()},
  deepseek: {baseURL: 'https://api.deepseek.com/v1', keyName: 'DEEPSEEK_API_KEY', defaultModel: 'deepseek-chat', tier: 'low-cost', protocol: 'openai', location: 'cloud', capabilities: C()},
  groq: {baseURL: 'https://api.groq.com/openai/v1', keyName: 'GROQ_API_KEY', defaultModel: 'llama-3.3-70b-versatile', tier: 'free-tier', protocol: 'openai', location: 'cloud', capabilities: C()},
  huggingface: {baseURL: 'https://router.huggingface.co/v1', keyName: 'HUGGINGFACE_TOKEN', genericAliases: ['HF_TOKEN'], defaultModel: 'deepseek-ai/DeepSeek-R1:fastest', tier: 'free-tier', protocol: 'openai', location: 'cloud', capabilities: C()},
  together: {baseURL: 'https://api.together.xyz/v1', keyName: 'TOGETHER_API_KEY', aliases: ['TogetherAIAPI_KEY'], defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', tier: 'mixed', protocol: 'openai', location: 'cloud', capabilities: C()},
  fireworks: {baseURL: 'https://api.fireworks.ai/inference/v1', keyName: 'FIREWORKS_API_KEY', defaultModel: 'accounts/fireworks/models/llama-v3p3-70b-instruct', tier: 'mixed', protocol: 'openai', location: 'cloud', capabilities: C()},
  cerebras: {baseURL: 'https://api.cerebras.ai/v1', keyName: 'CEREBRAS_API_KEY', defaultModel: 'llama-3.3-70b', tier: 'free-tier', protocol: 'openai', location: 'cloud', capabilities: C()},
  mistral: {baseURL: 'https://api.mistral.ai/v1', keyName: 'MISTRAL_API_KEY', defaultModel: 'mistral-large-latest', tier: 'mixed', protocol: 'openai', location: 'cloud', capabilities: C()},
  xai: {baseURL: 'https://api.x.ai/v1', keyName: 'XAI_API_KEY', defaultModel: 'grok-4', tier: 'paid', protocol: 'openai', location: 'cloud', capabilities: C()},
  perplexity: {baseURL: 'https://api.perplexity.ai', keyName: 'PERPLEXITY_API_KEY', defaultModel: 'sonar', tier: 'paid', protocol: 'openai', location: 'cloud', capabilities: C()},
  github: {baseURL: 'https://models.inference.ai.azure.com', keyName: 'GITHUB_MODELS_TOKEN', genericAliases: ['GITHUB_TOKEN'], defaultModel: 'gpt-4o-mini', tier: 'free-tier', protocol: 'openai', location: 'cloud', capabilities: C()},
  sambanova: {baseURL: 'https://api.sambanova.ai/v1', keyName: 'SAMBANOVA_API_KEY', defaultModel: 'Meta-Llama-3.3-70B-Instruct', tier: 'free-tier', protocol: 'openai', location: 'cloud', capabilities: C()},
  nvidia: {baseURL: 'https://integrate.api.nvidia.com/v1', keyName: 'NVIDIA_API_KEY', defaultModel: '', tier: 'free-tier', protocol: 'openai', location: 'cloud', capabilities: C()},
  novita: {baseURL: 'https://api.novita.ai/v3/openai', keyName: 'NOVITA_API_KEY', defaultModel: '', tier: 'mixed', protocol: 'openai', location: 'cloud', capabilities: C()},
  upstage: {baseURL: 'https://api.upstage.ai/v1', keyName: 'UPSTAGE_API_KEY', defaultModel: 'solar-pro2', tier: 'mixed', protocol: 'openai', location: 'cloud', capabilities: C()},
  ollama: {baseURL: 'https://ollama.com/v1', keyName: 'OLLAMA_API_KEY', defaultModel: '', tier: 'mixed', protocol: 'openai', location: 'cloud', capabilities: C()},
  hyperbolic: {baseURL: 'https://api.hyperbolic.xyz/v1', keyName: 'HYPERBOLIC_API_KEY', defaultModel: '', tier: 'mixed', protocol: 'openai', location: 'cloud', capabilities: C()},
  alibaba: {baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', keyName: 'ALIBABA_API_KEY', defaultModel: 'qwen-plus', tier: 'mixed', protocol: 'openai', location: 'cloud', capabilities: C()},
  cloudflare: {baseURL: '', keyName: 'CLOUDFLARE_API_TOKEN', genericAliases: ['CLOUDFLARE_AUTH_TOKEN'], defaultModel: '@cf/openai/gpt-oss-120b', tier: 'free-tier', protocol: 'openai', location: 'cloud', capabilities: C()},
  custom: {baseURL: 'http://127.0.0.1:11434/v1', keyName: 'CUSTOM_API_KEY', defaultModel: 'qwen3-coder', tier: 'local', protocol: 'openai', location: 'local', capabilities: C()},
  lmstudio: {baseURL: 'http://127.0.0.1:1234/v1', keyName: 'LMSTUDIO_API_KEY', defaultModel: 'local-model', tier: 'local', protocol: 'openai', location: 'local', capabilities: C()},
  vllm: {baseURL: 'http://127.0.0.1:8000/v1', keyName: 'VLLM_API_KEY', defaultModel: 'local-model', tier: 'local', protocol: 'openai', location: 'local', capabilities: C()}
};

// Unprefixed OPENAI_*/ANTHROPIC_* variables are commonly set for other tools (SDKs, Claude Code, gateways);
// silently redirecting this server's keys or models through them would be unsafe. Use DZ23_OPENAI_* / DZ23_ANTHROPIC_*.
const PREFIX_ONLY = new Set(['openai', 'anthropic']);

function envAny(names = [], env = process.env) {
  for (const name of names) {
    if (env[name]) return {value: env[name], source: `env:${name}`};
    const file = env[`${name}_FILE`];
    if (file) {
      try { return {value: fs.readFileSync(file, 'utf8').trim(), source: `file:${name}_FILE`}; } catch { throw new Error(`Cannot read configured secret file for ${name}_FILE`); }
    }
  }
  return {value: '', source: 'none'};
}

/** DZ23_<PROVIDER>_<SUFFIX> first, then the legacy unprefixed name (never for PREFIX_ONLY providers). */
function providerEnv(name, suffix, env) {
  const prefix = name.toUpperCase();
  return env[`DZ23_${prefix}_${suffix}`] || (PREFIX_ONLY.has(name) ? '' : env[`${prefix}_${suffix}`]) || '';
}

/**
 * Generic tokens such as GITHUB_TOKEN or HF_TOKEN usually exist for other purposes (repository access, CLIs).
 * They enable a provider only when DZ23_ROTATION names that provider or DZ23_ALLOW_GENERIC_CREDENTIALS=true.
 */
function genericAllowed(name, env) {
  if (String(env.DZ23_ALLOW_GENERIC_CREDENTIALS || '').toLowerCase() === 'true') return true;
  return String(env.DZ23_ROTATION || '').split(',').some(entry => entry.trim().split(':')[0] === name);
}

function resolvedBase(name, d, env) {
  const direct = providerEnv(name, 'BASE_URL', env);
  if (direct) return direct;
  if (name === 'cloudflare') {
    const account = env.CLOUDFLARE_ACCOUNT_ID;
    return account ? `https://api.cloudflare.com/client/v4/accounts/${account}/ai/v1` : '';
  }
  return d.baseURL;
}

function validateBaseURL(raw, name) {
  if (!raw) return raw;
  let url;
  try { url = new URL(raw); } catch { throw new Error(`Invalid base URL for ${name}`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(`Base URL for ${name} must be HTTP(S) without credentials, query or fragment`);
  }
  // Cleartext HTTP would send provider keys and prompts readable on the network.
  if (url.protocol === 'http:' && !isPrivateEndpoint(raw)) throw new Error(`Base URL for ${name} must use HTTPS unless it points to a loopback or private-network host`);
  return raw;
}

export function providerRegistry(env = process.env) {
  return Object.fromEntries(Object.entries(defs).map(([name, d]) => {
    const specific = envAny([d.keyName, ...(d.aliases || [])], env);
    const generic = !specific.value && d.genericAliases ? envAny(d.genericAliases, env) : {value: '', source: 'none'};
    const useGeneric = Boolean(generic.value) && genericAllowed(name, env);
    const secret = specific.value ? specific : useGeneric ? generic : {value: '', source: 'none'};
    const local = d.location === 'local';
    // A local server is configured only when the operator sets its key, endpoint or model (or names it in DZ23_ROTATION).
    const explicitLocal = local && Boolean(secret.value || providerEnv(name, 'BASE_URL', env) || providerEnv(name, 'MODEL', env));
    const baseURL = validateBaseURL(resolvedBase(name, d, env), name);
    // A local adapter pointed at a public host is not local: its cost is unknown, so it is treated as mixed.
    const tier = local && baseURL && !isPrivateEndpoint(baseURL) ? 'mixed' : d.tier;
    return [name, {
      name, baseURL, apiKey: local ? (secret.value || 'local') : secret.value,
      keyName: d.keyName, credentialSource: secret.source, ...(generic.value && !useGeneric ? {ignoredCredentialSource: generic.source} : {}),
      defaultModel: providerEnv(name, 'MODEL', env) || d.defaultModel,
      tier, protocol: d.protocol, location: d.location, capabilities: {...d.capabilities},
      enabled: explicitLocal || (!local && Boolean(secret.value)), configured: explicitLocal || (!local && Boolean(secret.value))
    }];
  }));
}

export function parseTarget(target, registry = providerRegistry()) {
  const idx = target.indexOf(':');
  const provider = idx < 0 ? target : target.slice(0, idx);
  const model = idx < 0 ? registry[provider]?.defaultModel : target.slice(idx + 1);
  if (!registry[provider]) throw new Error(`Unknown provider: ${provider}`);
  return {...registry[provider], model: model || registry[provider].defaultModel};
}

async function boundedText(response, target, maxBytes) {
  const tooLarge = () => new ProviderError({kind: 'response_invalid', provider: target.name, model: target.model, detail: 'response exceeds configured limit'});
  if (Number(response.headers?.get?.('content-length') || 0) > maxBytes) throw tooLarge();
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) throw tooLarge();
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { await reader.cancel(); throw tooLarge(); }
    text += decoder.decode(value, {stream: true});
  }
  return text + decoder.decode();
}

/** Fetch JSON with timeout, size bound and classified failures. Raw bodies never leave this function. */
async function requestJson(target, url, {method = 'POST', headers = {}, body, timeoutMs = 90_000, signal, maxResponseBytes = 2 * 1024 * 1024}) {
  const meta = {provider: target.name, model: target.model};
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, {once: true});
  const transportError = () => timedOut
    ? new ProviderError({...meta, kind: 'provider_timeout'})
    : signal?.aborted ? new ProviderError({...meta, kind: 'provider_error', detail: 'request cancelled'}) : new ProviderError({...meta, kind: 'provider_unavailable', detail: 'network error'});
  try {
    let response;
    try { response = await fetch(url, {method, headers, signal: controller.signal, ...(body === undefined ? {} : {body: JSON.stringify(body)})}); } catch { throw transportError(); }
    let text;
    try { text = await boundedText(response, target, maxResponseBytes); } catch (error) { if (error instanceof ProviderError) throw error; throw transportError(); }
    if (!response.ok) throw new ProviderError({...meta, kind: classifyHttpFailure(response.status, text), status: response.status, retryAfterMs: parseRetryAfter(response.headers?.get?.('retry-after'))});
    try { return JSON.parse(text); } catch { throw new ProviderError({...meta, kind: 'response_invalid', detail: 'invalid JSON'}); }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function noContent(target) {
  return new ProviderError({provider: target.name, model: target.model, kind: 'response_invalid', detail: 'No assistant content'});
}

export async function callOpenAICompatible(target, messages, {timeoutMs = 90_000, signal, temperature = 0.2, maxTokens = 4096, maxResponseBytes = 2 * 1024 * 1024} = {}) {
  const headers = {'content-type': 'application/json'};
  if (target.apiKey && target.apiKey !== 'local') headers.authorization = `Bearer ${target.apiKey}`;
  const data = await requestJson(target, `${target.baseURL.replace(/\/$/, '')}/chat/completions`, {
    headers, timeoutMs, signal, maxResponseBytes, body: {model: target.model, messages, temperature, max_tokens: maxTokens}
  });
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw noContent(target);
  return {content, usage: data.usage || null};
}

function anthropicMessages(messages) {
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
  const rest = messages.filter(m => m.role !== 'system').map(m => ({role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content ?? '')}));
  return {system, messages: rest};
}

export async function callAnthropic(target, messages, {timeoutMs = 90_000, signal, temperature = 0.2, maxTokens = 4096, maxResponseBytes = 2 * 1024 * 1024} = {}) {
  const {system, messages: anthropic} = anthropicMessages(messages);
  const data = await requestJson(target, `${target.baseURL.replace(/\/$/, '')}/messages`, {
    headers: {'content-type': 'application/json', 'x-api-key': target.apiKey, 'anthropic-version': '2023-06-01'},
    timeoutMs, signal, maxResponseBytes, body: {model: target.model, system, messages: anthropic, temperature, max_tokens: maxTokens}
  });
  const content = (data?.content || []).filter(part => part?.type === 'text').map(part => part.text).join('\n');
  if (!content.trim()) throw noContent(target);
  return {content, usage: data.usage || null};
}

export async function callProvider(target, messages, opts = {}) {
  if (!target.baseURL) throw new ProviderError({provider: target.name, model: target.model, kind: 'configuration_error', detail: 'missing base URL'});
  if (!target.model) throw new ProviderError({provider: target.name, model: '', kind: 'configuration_error', detail: 'missing model'});
  return target.protocol === 'anthropic' ? callAnthropic(target, messages, opts) : callOpenAICompatible(target, messages, opts);
}

/**
 * Capabilities as declared by a provider catalog (OpenRouter-style fields when present).
 * Missing information stays 'unknown'; false only when the catalog lists what it supports.
 */
export function catalogCapabilities(model = {}) {
  const inputs = model?.architecture?.input_modalities;
  const outputs = model?.architecture?.output_modalities;
  const params = model?.supported_parameters;
  const listed = (list, value) => (Array.isArray(list) ? list.includes(value) : 'unknown');
  const declared = Boolean(model?.architecture) || Array.isArray(params) || Number.isFinite(model?.context_length);
  return {
    source: declared ? 'catalog' : 'unknown',
    text: listed(outputs, 'text'),
    vision: listed(inputs, 'image'),
    tools: listed(params, 'tools'),
    reasoning: Array.isArray(params) && params.includes('reasoning') ? true : 'unknown',
    embeddings: Array.isArray(outputs) && outputs.includes('embeddings') ? true : 'unknown',
    streaming: 'unknown',
    context_length: Number.isFinite(model?.context_length) ? model.context_length : 'unknown',
    max_output_tokens: Number.isFinite(model?.top_provider?.max_completion_tokens) ? model.top_provider.max_completion_tokens : 'unknown'
  };
}

export async function discoverModels(target, {timeoutMs = 15_000} = {}) {
  if (!target.baseURL) return {ok: false, models: [], kind: 'configuration_error', error: 'missing_base_url'};
  const headers = {};
  if (target.protocol === 'anthropic') { headers['x-api-key'] = target.apiKey; headers['anthropic-version'] = '2023-06-01'; }
  else if (target.apiKey && target.apiKey !== 'local') headers.authorization = `Bearer ${target.apiKey}`;
  try {
    const data = await requestJson(target, `${target.baseURL.replace(/\/$/, '')}/models`, {method: 'GET', headers, timeoutMs});
    const list = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
    return {ok: true, models: list.slice(0, 500).map(m => ({id: m.id || m.name || String(m), owned_by: m.owned_by, catalog_capabilities: catalogCapabilities(m)}))};
  } catch (error) {
    const kind = error instanceof ProviderError ? error.kind : 'provider_error';
    return {ok: false, models: [], kind, error: kind, ...(error.status ? {http_status: error.status} : {})};
  }
}
