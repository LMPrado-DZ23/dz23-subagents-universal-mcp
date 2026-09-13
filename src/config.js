import os from 'node:os';import path from 'node:path';
function expandHome(p){if(!p)return p;return p.startsWith('~/')?path.join(os.homedir(),p.slice(2)):p;}
export function intEnv(name,fallback){const n=Number.parseInt(process.env[name]??'',10);return Number.isFinite(n)?n:fallback;}
export function config(){
  const stateDir=expandHome(process.env.DZ23_STATE_DIR||'~/.dz23-subagents');
  return {
    stateDir,
    host:process.env.DZ23_HTTP_HOST||'127.0.0.1',
    port:intEnv('DZ23_HTTP_PORT',8787),
    token:process.env.DZ23_MCP_TOKEN||'',
    allowHttp:String(process.env.DZ23_ALLOW_HTTP||'false').toLowerCase()==='true',
    allowedHosts:(process.env.DZ23_ALLOWED_HOSTS||'').split(',').map(x=>x.trim()).filter(Boolean),
    allowedOrigins:(process.env.DZ23_ALLOWED_ORIGINS||'').split(',').map(x=>x.trim()).filter(Boolean),
    policy:process.env.DZ23_ROUTING_POLICY||'free-first',
    maxConcurrency:Math.max(1,Math.min(8,intEnv('DZ23_MAX_CONCURRENCY',7))),
    maxWorkersPerTarget:Math.max(1,Math.min(7,intEnv('DZ23_MAX_WORKERS_PER_TARGET',4))),
    maxQueue:Math.max(1,Math.min(128,intEnv('DZ23_MAX_QUEUE',32))),
    timeoutMs:Math.max(1000,intEnv('DZ23_PROVIDER_TIMEOUT_MS',90000)),
    healthTimeoutMs:Math.max(1000,intEnv('DZ23_HEALTH_TIMEOUT_MS',15000)),
    maxContextChars:Math.max(10000,Math.min(120000,intEnv('DZ23_MAX_CONTEXT_CHARS',60000))),
    maxOutputTokens:Math.max(64,Math.min(4096,intEnv('DZ23_MAX_OUTPUT_TOKENS',4096))),
    maxResponseBytes:Math.max(65536,Math.min(4*1024*1024,intEnv('DZ23_MAX_RESPONSE_BYTES',2*1024*1024))),
    maxStoredOutputChars:Math.max(1000,Math.min(24000,intEnv('DZ23_MAX_STORED_OUTPUT_CHARS',12000))),
    maxAgentOutputs:Math.max(1,Math.min(32,intEnv('DZ23_MAX_AGENT_OUTPUTS',16))),
    maxJournalBytes:Math.max(65536,Math.min(4*1024*1024,intEnv('DZ23_MAX_JOURNAL_BYTES',1024*1024))),
    maxCheckpoints:Math.max(1,Math.min(16,intEnv('DZ23_MAX_CHECKPOINTS',8))),
    maxStdioFrameBytes:Math.max(65536,Math.min(2*1024*1024,intEnv('DZ23_MAX_STDIO_FRAME_BYTES',512*1024))),
    maxPromptChars:Math.max(1000,Math.min(200000,intEnv('DZ23_MAX_PROMPT_CHARS',32000))),
    maxGoalChars:Math.max(500,Math.min(64000,intEnv('DZ23_MAX_GOAL_CHARS',8000))),
    toolArgumentErrors:['auto','jsonrpc','tool_result'].includes(process.env.DZ23_TOOL_ARGUMENT_ERRORS)?process.env.DZ23_TOOL_ARGUMENT_ERRORS:'auto',
    allowPaid:String(process.env.DZ23_ALLOW_PAID||'false').toLowerCase()==='true',
    rotation:(process.env.DZ23_ROTATION||'').split(',').map(s=>s.trim()).filter(Boolean)
  };
}
