import {
  SERVER_NAME, SERVER_VERSION, SERVER_DESCRIPTION, SUPPORTED_PROTOCOL_VERSIONS, LATEST_PROTOCOL_VERSION,
  VALIDATION_AS_TOOL_ERROR_VERSIONS, RPC_ERRORS
} from './constants.js';
import {validate, ValidationError, isPlainObject} from './schema.js';
import {buildTools, toolLimits, TOOL_POLICIES} from './tools.js';
import {RpcError, ToolError, ForbiddenError, RateLimitError, safeText} from './errors.js';
import {nullLogger} from './logger.js';

const DATE_VERSION = /^\d{4}-\d{2}-\d{2}$/;

/** Echo the requested version when supported, counter-offer the latest for other dated revisions. */
export function negotiateProtocolVersion(requested) {
  if (typeof requested !== 'string' || !DATE_VERSION.test(requested)) {
    throw new RpcError(RPC_ERRORS.INVALID_PARAMS, 'Unsupported protocol version', {
      supported: [...SUPPORTED_PROTOCOL_VERSIONS],
      requested: typeof requested === 'string' ? safeText(requested, 64) : null
    });
  }
  return SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
}

export function toolDefinitions(cfg = {}) {
  return buildTools(toolLimits(cfg));
}

// Compact JSON: indentation roughly doubled every result that callers pay to read.
function successResult(value) {
  return {
    content: [{type: 'text', text: JSON.stringify(value)}],
    structuredContent: isPlainObject(value) ? value : {items: value}
  };
}

const PREVIEW_CHARS = 400;
const EXCERPT_CHARS = 600;
const shorten = (text, max) => {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max)}…` : value;
};

/** Mission state without full agent outputs, which can reach hundreds of kilobytes. */
export function compactMission(state) {
  if (!state) return state;
  const outputs = (state.agent_outputs || []).map(({content, ...rest}) => ({...rest, chars: String(content ?? '').length, preview: shorten(content, PREVIEW_CHARS)}));
  return {...state, agent_outputs: outputs,
    ...(state.last_output !== undefined ? {last_output: shorten(state.last_output, PREVIEW_CHARS), last_output_chars: String(state.last_output ?? '').length} : {})};
}

/** Swarm result for the calling harness: the integration answer in full, each worker as a short excerpt with its cost data. */
export function summarizeSwarm(result) {
  return {...result, workers: result.workers.map(worker => (worker.ok
    ? {ok: true, role: worker.role, provider: worker.provider, model: worker.model, output_chars: worker.content.length, excerpt: shorten(worker.content, EXCERPT_CHARS),
      usage: worker.usage ?? null, failed_attempts: (worker.attempts || []).length,
      ...(worker.budget_denials ? {budget_denials: worker.budget_denials} : {}), ...(worker.memory_warnings ? {memory_warnings: worker.memory_warnings} : {})}
    : worker))};
}

/** Transport cancellation combined with the overall DZ23_DELEGATE_DEADLINE_MS deadline of a billable tool call. */
function callSignal(signal, deadlineMs) {
  const signals = [signal, deadlineMs ? AbortSignal.timeout(deadlineMs) : null].filter(Boolean);
  return signals.length ? AbortSignal.any(signals) : undefined;
}

export function toolErrorPayload(error, ctx = {}) {
  return {error: {
    code: error.code || 'tool_error',
    message: safeText(error.message, 500),
    ...(ctx.requestId ? {request_id: ctx.requestId} : {}),
    ...(error.details !== undefined ? {details: error.details} : {})
  }};
}

function errorResult(error, ctx) {
  const payload = toolErrorPayload(error, ctx);
  return {content: [{type: 'text', text: JSON.stringify(payload)}], structuredContent: payload, isError: true};
}

function argumentErrorsAsToolResult(mode, ctx) {
  if (mode === 'tool_result') return true;
  if (mode === 'jsonrpc') return false;
  const version = ctx.session?.protocolVersion || ctx.protocolVersion;
  return VALIDATION_AS_TOOL_ERROR_VERSIONS.has(version);
}

function authorize(ctx, policy) {
  if (!ctx.scopes) return;
  const missing = policy.scopes.filter(scope => !ctx.scopes.has(scope));
  if (missing.length) throw new ForbiddenError(policy.scopes);
}

const SUMMARY_LISTS = ['acceptance_criteria', 'decisions', 'invariants', 'completed_tasks', 'active_tasks', 'blocked_tasks', 'next_tasks', 'known_failures', 'files_read', 'files_changed', 'artifacts'];

/** Checkpoint acknowledgement without echoing the whole (possibly large) mission state. */
function checkpointSummary(snapshot) {
  const counts = Object.fromEntries(SUMMARY_LISTS.map(key => [key, Array.isArray(snapshot[key]) ? snapshot[key].length : 0]));
  const tests = Object.fromEntries(['passed', 'failed', 'pending'].map(key => [key, snapshot.tests?.[key]?.length || 0]));
  return {project_id: snapshot.project_id, mission_id: snapshot.mission_id, sequence: snapshot.sequence, status: snapshot.status,
    next_action: snapshot.next_action || '', checkpoint_at: snapshot.checkpoint_at, goal_set: Boolean(snapshot.goal), counts, tests,
    ...(snapshot.truncated_lists ? {truncated_lists: snapshot.truncated_lists} : {})};
}

function toolRunner(router, memory) {
  const withRequest = (args, ctx) => ({...args, request_id: ctx.requestId});
  const billable = (args, ctx) => ({...args, request_id: ctx.requestId, signal: callSignal(ctx.signal, router?.cfg?.delegateDeadlineMs)});
  return {
    list_models: async () => { await router.loadProviderStatus?.(); return router.listModels(); },
    provider_inventory: async () => { await router.loadProviderStatus?.(); return router.inventory(); },
    discover_models: args => router.discover(args),
    health_check: (_args, ctx) => router.healthCheck({request_id: ctx.requestId}),
    verify_model: (args, ctx) => router.verifyModel(withRequest(args, ctx)),
    project_init: ({project_id, ...fields}) => memory.initProject(project_id, fields),
    mission_status: async ({project_id, mission_id, events_limit, include_outputs}) => {
      const journal = await memory.readJournal(project_id, mission_id, events_limit);
      const state = await memory.getMission(project_id, mission_id);
      return {state: include_outputs ? state : compactMission(state), recent_events: journal.events,
        journal_integrity: {invalid_lines: journal.invalid_lines, last_seq: journal.last_seq}};
    },
    memory_checkpoint: async ({project_id, mission_id, merge, ...fields}) => checkpointSummary(await memory.recordCheckpoint(project_id, mission_id, fields, {merge})),
    delegate: (args, ctx) => router.delegate(billable(args, ctx)),
    consensus: (args, ctx) => router.consensus(billable(args, ctx)),
    swarm_run: async ({response_mode, ...args}, ctx) => {
      const result = await router.swarmRun(billable(args, ctx));
      return response_mode === 'full' ? result : summarizeSwarm(result);
    }
  };
}

/**
 * MCP method handler shared by stdio and HTTP. Returns the JSON-RPC `result`,
 * `null` for notifications, or throws RpcError / ForbiddenError / RateLimitError.
 */
export function createMcpHandler(router, memory, options = {}) {
  const tools = buildTools(toolLimits(options.limits || router?.cfg || {}));
  const byName = new Map(tools.map(tool => [tool.name, tool]));
  const runners = toolRunner(router, memory);
  const argumentErrorMode = options.argumentErrors || router?.cfg?.toolArgumentErrors || 'auto';
  const logger = options.logger || nullLogger;
  const metrics = options.metrics || null;

  function parseArguments(tool, rawArgs) {
    try {
      if (rawArgs !== undefined && !isPlainObject(rawArgs)) throw new ValidationError('arguments', 'must be an object');
      return validate(tool.inputSchema, rawArgs ?? {});
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      throw new RpcError(RPC_ERRORS.INVALID_PARAMS, 'Invalid tool arguments', {field: error.field, reason: error.reason});
    }
  }

  /** Validates, authorizes, rate-limits and executes one tool. Used by MCP and REST. */
  async function executeTool(name, rawArgs, ctx = {}) {
    const tool = typeof name === 'string' ? byName.get(name) : undefined;
    if (!tool) throw new RpcError(RPC_ERRORS.INVALID_PARAMS, 'Unknown tool', {tool: safeText(name, 64).replace(/[^A-Za-z0-9_.-]/g, '?')});
    const started = Date.now();
    let status = 'error';
    let errorCode;
    try {
      let args;
      try { args = parseArguments(tool, rawArgs); } catch (error) { status = 'invalid_arguments'; throw error; }
      const policy = TOOL_POLICIES[tool.name];
      authorize(ctx, policy);
      const release = ctx.beforeToolCall ? await ctx.beforeToolCall(tool.name, policy) : undefined;
      try {
        const value = await runners[tool.name](args, ctx);
        status = 'ok';
        return {ok: true, value};
      } catch (error) {
        if (!(error instanceof ToolError)) throw error;
        status = 'tool_error';
        errorCode = error.code;
        return {ok: false, error};
      } finally {
        if (typeof release === 'function') release();
      }
    } catch (error) {
      if (error instanceof ForbiddenError) status = 'forbidden';
      else if (error instanceof RateLimitError) status = 'rate_limited';
      throw error;
    } finally {
      const fields = {request_id: ctx.requestId, tool: tool.name, transport: ctx.transport, identity: ctx.identity, duration_ms: Date.now() - started, status, error_code: errorCode};
      if (status === 'ok') logger.info('tool_call_completed', fields); else logger.warn('tool_call_completed', fields);
      metrics?.increment('tool_calls_total', {tool: tool.name, status});
    }
  }

  async function callTool(params, ctx) {
    if (!isPlainObject(params)) throw new RpcError(RPC_ERRORS.INVALID_PARAMS, 'Invalid params', {field: 'params', reason: 'must be an object'});
    if (typeof params.name !== 'string' || !params.name) throw new RpcError(RPC_ERRORS.INVALID_PARAMS, 'Invalid params', {field: 'name', reason: 'must be a non-empty string'});
    try {
      const outcome = await executeTool(params.name, params.arguments, ctx);
      return outcome.ok ? successResult(outcome.value) : errorResult(outcome.error, ctx);
    } catch (error) {
      const invalidArguments = error instanceof RpcError && error.message === 'Invalid tool arguments';
      if (invalidArguments && argumentErrorsAsToolResult(argumentErrorMode, ctx)) {
        return errorResult(new ToolError('invalid_arguments', 'Invalid tool arguments', error.data), ctx);
      }
      throw error;
    }
  }

  async function handler(msg, ctx = {}) {
    const method = msg?.method;
    if (method === 'initialize') {
      const params = isPlainObject(msg.params) ? msg.params : {};
      const protocolVersion = negotiateProtocolVersion(params.protocolVersion);
      if (ctx.session) ctx.session.protocolVersion = protocolVersion;
      const serverInfo = {name: SERVER_NAME, version: SERVER_VERSION};
      if (protocolVersion === '2025-11-25') serverInfo.description = SERVER_DESCRIPTION;
      return {protocolVersion, capabilities: {tools: {listChanged: false}}, serverInfo};
    }
    if (typeof method === 'string' && method.startsWith('notifications/')) return null;
    if (method === 'ping') return {};
    if (method === 'tools/list') return {tools};
    if (method === 'tools/call') return callTool(msg.params, ctx);
    throw new RpcError(RPC_ERRORS.METHOD_NOT_FOUND, 'Method not found', {method: safeText(method, 64)});
  }

  handler.tools = tools;
  handler.executeTool = executeTool;
  return handler;
}
