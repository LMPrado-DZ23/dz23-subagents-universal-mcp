#!/usr/bin/env node
import {loadDotEnv} from './env.js';
import {config} from './config.js';
import {ProjectMemory} from './memory.js';
import {Router} from './core.js';
import {createMcpHandler} from './mcp.js';
import {createRpcProcessor} from './rpc.js';
import {startHttp} from './http.js';
import {startStdio} from './stdio.js';
import {ConfigError} from './errors.js';

const EX_CONFIG = 78;

// Resolve relative to the installed package, never the host's working directory.
loadDotEnv();
let cfg;
try {
  cfg = config();
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(`Configuration error: ${error.message}`);
  process.exit(EX_CONFIG);
}
for (const issue of cfg.configIssues) console.error(`Configuration ${issue.level}: ${issue.variable} ${issue.message}`);

const memory = new ProjectMemory(cfg.stateDir, cfg);
const router = new Router(cfg, memory);
const handler = createMcpHandler(router, memory);
let server = null;
let stdio = null;

if (process.argv.includes('--http')) {
  if (!cfg.allowHttp) {
    console.error('HTTP mode is disabled; set DZ23_ALLOW_HTTP=true only after configuring authentication');
    process.exit(EX_CONFIG);
  }
  server = await startHttp(cfg, router, memory, handler);
  console.error(`DZ23 Subagents HTTP MCP listening on http://${cfg.host}:${server.address().port}`);
} else {
  stdio = startStdio({processMessage: createRpcProcessor(handler), maxFrameBytes: cfg.maxStdioFrameBytes});
}

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.error(`DZ23 Subagents received ${signal}; finishing in-flight work (grace ${cfg.shutdownGraceMs} ms)`);
  const hardStop = setTimeout(() => process.exit(1), cfg.shutdownGraceMs + 2000);
  hardStop.unref();
  try {
    if (server) await server.shutdown(cfg.shutdownGraceMs);
    else if (stdio) await Promise.race([stdio.idle(), new Promise(resolve => setTimeout(resolve, cfg.shutdownGraceMs).unref())]);
  } finally {
    process.exit(0);
  }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { shutdown(signal); });
