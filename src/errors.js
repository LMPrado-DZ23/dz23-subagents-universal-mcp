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

const TOOL_ERROR_HTTP_STATUS = {
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
  memory_integrity: 500
};

export function toolErrorHttpStatus(error) {
  return error.httpStatus || TOOL_ERROR_HTTP_STATUS[error.code] || 500;
}

/** Bounded, single-line, printable text for error messages and logs. */
export function safeText(value, max = 300) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, max);
}
