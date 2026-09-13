#!/usr/bin/env node
import {loadDotEnv} from './env.js';
import {config} from './config.js';
import {ProjectMemory} from './memory.js';
import {Router} from './core.js';
import {createMcpHandler} from './mcp.js';
import {createRpcProcessor} from './rpc.js';
import {startHttp} from './http.js';
import {startStdio} from './stdio.js';

// Resolve relative to the installed package, never the host's working directory.
loadDotEnv();
const cfg = config();
const memory = new ProjectMemory(cfg.stateDir, cfg);
const router = new Router(cfg, memory);
const handler = createMcpHandler(router, memory);

if (process.argv.includes('--http')) {
  if (!cfg.allowHttp) throw new Error('HTTP mode is disabled; set DZ23_ALLOW_HTTP=true only after configuring authentication and authorization');
  const server = await startHttp(cfg, router, memory, handler);
  console.error(`DZ23 Subagents HTTP MCP listening on http://${cfg.host}:${server.address().port}`);
} else {
  startStdio({processMessage: createRpcProcessor(handler), maxFrameBytes: cfg.maxStdioFrameBytes});
}
