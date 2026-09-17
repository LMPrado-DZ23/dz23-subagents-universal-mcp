import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ProjectMemory} from '../src/memory.js';
import {Router} from '../src/core.js';
import {createMcpHandler} from '../src/mcp.js';
import {createRpcProcessor} from '../src/rpc.js';

export const entry = (name, tier = 'free-tier', location = 'cloud') => ({name, baseURL: location === 'local' ? 'http://127.0.0.1:11434/v1' : `https://${name}.example/v1`,
  apiKey: 'x', keyName: 'X', credentialSource: 'env:X', defaultModel: 'm', tier, protocol: 'openai', location, capabilities: {text: true},
  enabled: true, configured: true, privateEndpoint: location === 'local'});

export async function tempDir(t, prefix = 'dz23-410-') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, {recursive: true, force: true, maxRetries: 10, retryDelay: 50}));
  return dir;
}

export const lastUserText = messages => String(messages.filter(m => m.role === 'user').at(-1)?.content ?? '');

/** MCP stack with fake providers: returns rpc(method, params, ctx) and tool(name, args, ctx). */
export async function stack(t, {caller, cfg = {}, registry} = {}) {
  const root = await tempDir(t);
  const stateDir = path.join(root, 'state');
  const memory = new ProjectMemory(stateDir, {durableWrites: false});
  const calls = [];
  const fake = caller || (async (target, messages) => ({content: `answer from ${target.name}`}));
  const recording = async (target, messages, options) => { calls.push({target: `${target.name}:${target.model}`, text: lastUserText(messages)}); return fake(target, messages, options); };
  const router = new Router({rotation: ['p1:m', 'p2:m'], policy: 'free-first', maxConcurrency: 8, maxWorkersPerTarget: 8, timeoutMs: 2000, maxContextChars: 60000,
    maxRetries: 0, stateDir, delegateDeadlineMs: 20000, workspaceRoots: [], workspaceMaxFileBytes: 256 * 1024, workspaceMaxEntries: 500, workspaceMaxFiles: 2000,
    workspaceMaxLineChars: 4000, workspaceMaxOutputChars: 256 * 1024, workspaceCommandTimeoutMs: 10000, responseCacheTtlMs: 0, maxMissionJobs: 2, ...cfg},
  memory, {registry: registry || {p1: entry('p1'), p2: entry('p2')}, caller: recording, sleep: async () => {}});
  const processor = createRpcProcessor(createMcpHandler(router, memory));
  let id = 0;
  const rpc = async (method, params, ctx = {}) => (await processor({jsonrpc: '2.0', id: ++id, method, ...(params ? {params} : {})}, {requestId: `req-${id}`, ...ctx})).response;
  const tool = async (name, args, ctx) => {
    const response = await rpc('tools/call', {name, arguments: args}, ctx);
    if (response.error) return {rpcError: response.error};
    return response.result.isError ? {error: response.result.structuredContent.error} : response.result.structuredContent;
  };
  return {root, stateDir, memory, router, rpc, tool, calls};
}

export async function waitFor(check, {attempts = 600, delay = 10} = {}) {
  for (let i = 0; i < attempts; i++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  throw new Error('condition not reached');
}
