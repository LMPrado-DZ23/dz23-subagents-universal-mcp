/** Invalid runtime configuration. Messages name variables, never their secret values. */
export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** JSON-RPC protocol error: code, stable message and non-sensitive data. */
export class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }
}

/**
 * Expected tool execution failure (providers, budget, memory state).
 * Returned to MCP clients as a tool result with isError:true.
 * `details` must only contain values produced by this server, never raw provider bodies.
 */
export class ToolError extends Error {
  constructor(code, message, details, options = {}) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    if (details !== undefined) this.details = details;
    if (options.httpStatus) this.httpStatus = options.httpStatus;
  }
}

export class RateLimitError extends Error {
  constructor(retryAfterMs, limit) {
    super('Rate limit exceeded');
    this.name = 'RateLimitError';
    this.retryAfterMs = Math.max(0, Math.ceil(retryAfterMs));
    this.limit = limit;
  }
}

export class ForbiddenError extends Error {
  constructor(requiredScopes) {
    super('Forbidden');
    this.name = 'ForbiddenError';
    this.requiredScopes = requiredScopes;
  }
}

export class ServerBusyError extends Error {
  constructor(reason = 'server_busy') {
    super('Server busy');
    this.name = 'ServerBusyError';
    this.reason = reason;
  }
}

/** ToolError for an aborted signal: the call deadline (TimeoutError reason) or a client cancellation. */
export function abortError(signal) {
  return signal?.reason?.name === 'TimeoutError'
    ? new ToolError('deadline_exceeded', 'The tool call exceeded DZ23_DELEGATE_DEADLINE_MS; completed work may already be in mission memory')
    : new ToolError('cancelled', 'The tool call was cancelled by the client');
}

export function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

const TOOL_ERROR_HTTP_STATUS = {
  mission_busy: 409,
  idempotency_conflict: 409,
  no_local_target: 503,
  response_invalid: 502,
  workspace_denied: 403,
  workspace_not_found: 404,
  workspace_limit: 400,
  regex_timeout: 400,
  git_config_unsafe: 400,
  git_repository_outside_root: 400,
  git_not_repository: 400,
  git_unavailable: 503,
  git_readonly_failed: 502,
  cancelled: 499,
  deadline_exceeded: 504,
  context_too_large: 413,
  invalid_arguments: 400,
  invalid_request: 400,
  input_too_large: 413,
  target_not_allowed: 403,
  mission_not_found: 404,
  diversity_unavailable: 409,
  budget_exceeded: 402,
  all_providers_failed: 502,
  no_providers: 503,
  lock_timeout: 503,
  memory_write_failed: 503,
  queue_full: 503,
  memory_limit_exceeded: 413,
  memory_integrity: 500
};

export function toolErrorHttpStatus(error) {
  return error.httpStatus || TOOL_ERROR_HTTP_STATUS[error.code] || 500;
}

/** Bounded, single-line, printable text for error messages and logs. */
export function safeText(value, max = 300) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, max);
}
