import {RpcError, ForbiddenError} from './errors.js';
import {RPC_ERRORS} from './constants.js';
import {isPlainObject} from './schema.js';

// MCP resources and prompts. Resources expose compact mission state and need memory:read, like mission_status.
const RESOURCE_NOT_FOUND = -32002;
const PAGE_SIZE = 100;
const MISSION_URI = /^dz23:\/\/mission\/([A-Za-z0-9][A-Za-z0-9._-]{0,119})\/([A-Za-z0-9][A-Za-z0-9._-]{0,119})$/;

export const PROMPTS = Object.freeze([
  {name: 'audit_project', title: 'Audit project', description: 'Audit a project with evidence, severity and explicit unknowns.',
    arguments: [{name: 'goal', description: 'What to audit and why.', required: true}, {name: 'workspace', description: 'Configured workspace root (optional).', required: false}],
    template: a => `Audit this project: ${a.goal}.\nUse dz23-subagents: mission_status first, then swarm_run with roles architect, security and qa${a.workspace ? ` and context from workspace ${a.workspace}` : ''}. `
      + 'Report findings with file:line evidence and severity, separate verified facts from hypotheses, and record decisions with memory_checkpoint.'},
  {name: 'fix_bug', title: 'Fix bug', description: 'Diagnose a bug and propose a bounded fix without claiming it was executed.',
    arguments: [{name: 'bug', description: 'Symptom, error message or failing test.', required: true}],
    template: a => `Diagnose and fix: ${a.bug}.\nReproduce first, find the root cause, propose the smallest fix and the test that proves it. `
      + 'The harness applies and runs it; subagent answers are proposals. Record the failing and passing test in memory_checkpoint.'},
  {name: 'review_pull_request', title: 'Review change', description: 'Review a change adversarially for bugs, security and regressions.',
    arguments: [{name: 'change', description: 'Pull request, branch or diff description.', required: true}],
    template: a => `Review this change: ${a.change}.\nUse consensus with 2-3 distinct models or swarm_run with security, qa and reviewer. `
      + 'Flag correctness bugs, security issues and missing tests with evidence; possible_divergences means disagreement to resolve.'}
]);

function requireRead(ctx) {
  if (ctx.scopes && !ctx.scopes.has('memory:read')) throw new ForbiddenError(['memory:read']);
}

export async function listResources(memory, params = {}, ctx = {}) {
  requireRead(ctx);
  const all = [];
  for (const project of await memory.listProjects()) {
    for (const mission of await memory.listMissions(project)) all.push({uri: `dz23://mission/${project}/${mission}`, name: `${project}/${mission}`, mimeType: 'application/json'});
  }
  const start = Number.parseInt(params.cursor || '0', 10);
  if (!Number.isInteger(start) || start < 0) throw new RpcError(RPC_ERRORS.INVALID_PARAMS, 'Invalid cursor');
  const page = all.slice(start, start + PAGE_SIZE);
  return {resources: page, ...(start + PAGE_SIZE < all.length ? {nextCursor: String(start + PAGE_SIZE)} : {})};
}

export function listResourceTemplates(ctx = {}) {
  requireRead(ctx);
  return {resourceTemplates: [{uriTemplate: 'dz23://mission/{project_id}/{mission_id}', name: 'Mission state', description: 'Compact persisted mission state, including loop_state.', mimeType: 'application/json'}]};
}

export async function readResource(memory, params = {}, ctx = {}, compact = state => state) {
  requireRead(ctx);
  const uri = isPlainObject(params) ? params.uri : undefined;
  const match = MISSION_URI.exec(String(uri || ''));
  if (!match) throw new RpcError(RESOURCE_NOT_FOUND, 'Resource not found', {uri: String(uri || '').slice(0, 200)});
  const state = await memory.getMission(match[1], match[2]).catch(() => null);
  if (!state) throw new RpcError(RESOURCE_NOT_FOUND, 'Resource not found', {uri});
  return {contents: [{uri, mimeType: 'application/json', text: JSON.stringify(compact(state))}]};
}

export function listPrompts() {
  return {prompts: PROMPTS.map(({template, ...prompt}) => prompt)};
}

export function getPrompt(params = {}) {
  const prompt = PROMPTS.find(item => item.name === params?.name);
  if (!prompt) throw new RpcError(RPC_ERRORS.INVALID_PARAMS, 'Unknown prompt', {name: String(params?.name ?? '').slice(0, 64)});
  const args = params.arguments ?? {};
  if (!isPlainObject(args)) throw new RpcError(RPC_ERRORS.INVALID_PARAMS, 'Prompt arguments must be an object');
  const known = new Set(prompt.arguments.map(a => a.name));
  for (const [name, value] of Object.entries(args)) {
    if (!known.has(name)) throw new RpcError(RPC_ERRORS.INVALID_PARAMS, 'Unknown prompt argument', {argument: name.slice(0, 64)});
    if (typeof value !== 'string' || value.length > 8000) throw new RpcError(RPC_ERRORS.INVALID_PARAMS, 'Prompt arguments must be strings up to 8000 characters', {argument: name});
  }
  for (const arg of prompt.arguments) if (arg.required && !args[arg.name]?.trim()) throw new RpcError(RPC_ERRORS.INVALID_PARAMS, 'Missing required prompt argument', {argument: arg.name});
  return {description: prompt.description, messages: [{role: 'user', content: {type: 'text', text: prompt.template(args)}}]};
}
