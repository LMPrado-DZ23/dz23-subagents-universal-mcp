import {
  SERVER_NAME, SERVER_VERSION, SERVER_DESCRIPTION, SUPPORTED_PROTOCOL_VERSIONS, LATEST_PROTOCOL_VERSION,
  VALIDATION_AS_TOOL_ERROR_VERSIONS, RPC_ERRORS
} from './constants.js';
import {validate, ValidationError, isPlainObject} from './schema.js';
import {buildTools, toolLimits, TOOL_POLICIES} from './tools.js';
import {RpcError, ToolError, ForbiddenError, safeText} from './errors.js';

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

function successResult(value) {
  return {
    content: [{type: 'text', text: JSON.stringify(value, null, 2)}],
    structuredContent: isPlainObject(value) ? value : {items: value}
  };
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
  return {content: [{type: 'text', text: JSON.stringify(payload, null, 2)}], structuredContent: payload, isError: true};
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

function toolRunner(router, memory) {
  const withRequest = (args, ctx) => ({...args, request_id: ctx.requestId});
  return {
    list_models: () => router.listModels(),
    provider_inventory: () => router.inventory(),
    discover_models: args => router.discover(args),
    health_check: (_args, ctx) => router.healthCheck({request_id: ctx.requestId}),
    project_init: ({project_id, ...fields}) => memory.initProject(project_id, fields),
    mission_status: async ({project_id, mission_id, events_limit}) => ({
      state: await memory.getMission(project_id, mission_id),
      recent_events: await memory.recentEvents(project_id, mission_id, events_limit)
    }),
    memory_checkpoint: ({project_id, mission_id, merge, ...fields}) => memory.recordCheckpoint(project_id, mission_id, fields, {merge}),
    delegate: (args, ctx) => router.delegate(withRequest(args, ctx)),
    consensus: (args, ctx) => router.consensus(withRequest(args, ctx)),
    swarm_run: (args, ctx) => router.swarmRun(withRequest(args, ctx))
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

  /** Validates, authorizes, rate-limits and executes one tool. Used by MCP and REST. */
  async function executeTool(name, rawArgs, ctx = {}) {
    const tool = typeof name === 'string' ? byName.get(name) : undefined;
    if (!tool) throw new RpcError(RPC_ERRORS.INVALID_PARAMS, 'Unknown tool', {tool: safeText(name, 64).replace(/[^A-Za-z0-9_.-]/g, '?')});
    let args;
    try {
      if (rawArgs !== undefined && !isPlainObject(rawArgs)) throw new ValidationError('arguments', 'must be an object');
      args = validate(tool.inputSchema, rawArgs ?? {});
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      throw new RpcError(RPC_ERRORS.INVALID_PARAMS, 'Invalid tool arguments', {field: error.field, reason: error.reason});
    }
    const policy = TOOL_POLICIES[tool.name];
    authorize(ctx, policy);
    const release = ctx.beforeToolCall ? await ctx.beforeToolCall(tool.name, policy) : undefined;
    try {
      return {ok: true, value: await runners[tool.name](args, ctx)};
    } catch (error) {
      if (error instanceof ToolError) return {ok: false, error};
      throw error;
    } finally {
      if (typeof release === 'function') release();
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
