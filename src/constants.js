import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export const SERVER_NAME = 'dz23-subagents-universal';
export const SERVER_VERSION = pkg.version;
export const SERVER_DESCRIPTION = 'Self-hosted MCP text delegation router with shared mission memory';

// Newest first. Only revisions whose tools-only server requirements are implemented.
export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze(['2025-11-25', '2025-06-18']);
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];
// SEP-1303 (2025-11-25): input validation errors are tool execution errors.
export const VALIDATION_AS_TOOL_ERROR_VERSIONS = new Set(['2025-11-25']);
export const TOOL_ARGUMENT_ERROR_MODES = Object.freeze(['auto', 'jsonrpc', 'tool_result']);

export const ROLES = Object.freeze(['worker', 'architect', 'backend', 'frontend', 'security', 'qa', 'devops', 'reviewer']);
export const SWARM_ROLES = Object.freeze(ROLES.filter(role => role !== 'worker'));
export const ROUTING_STRATEGIES = Object.freeze(['first', 'round_robin', 'provider_diversity', 'model_diversity', 'cost_optimized', 'latency_optimized']);
export const SYNTHESIS_MODES = Object.freeze(['none', 'heuristic', 'model']);
export const MISSION_STATUSES = Object.freeze(['active', 'partial', 'blocked', 'paused', 'done', 'completed', 'failed', 'cancelled']);
export const CHECKPOINT_MERGE_MODES = Object.freeze(['append', 'replace']);

export const SCOPES = Object.freeze(['memory:read', 'memory:write', 'delegate:execute', 'health:execute', 'provider:discover', 'admin:inventory', 'workspace:read', 'git:read', 'mission:control', 'mission:lease', 'sandbox:execute']);
export const AUTH_MODES = Object.freeze(['single-user', 'scoped']);

// Relative operational weight used by the HTTP rate limiter (overridable by env).
export const DEFAULT_COST_WEIGHTS = Object.freeze({light: 1, discovery: 3, moderate: 5, billable: 10, expensive: 15, very_expensive: 30});

// Windows strips trailing dots from file names, so `proj.` and `proj` would alias the same record.
export const ID_PATTERN = '^[a-zA-Z0-9](?:[a-zA-Z0-9._-]{0,118}[a-zA-Z0-9_-])?$';
export const RESPONSE_MODES = Object.freeze(['summary', 'full']);
export const PROVIDER_NAME_PATTERN = '^[a-z0-9][a-z0-9_-]{0,39}$';
export const TARGET_PATTERN = '^(?:auto|[a-z0-9][a-z0-9_-]{0,39}(?::\\S{1,200})?)$';
// Explicit targets never accept the routing keyword "auto".
export const EXPLICIT_TARGET_PATTERN = '^(?!auto(?::|$))[a-z0-9][a-z0-9_-]{0,39}(?::\\S{1,200})?$';

export const RPC_ERRORS = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  RATE_LIMITED: -32001,
  FORBIDDEN: -32002,
  SERVER_BUSY: -32003
});

export const PROVIDER_ERROR_KINDS = Object.freeze([
  'rate_limited', 'quota_exhausted', 'billing_required', 'authentication_failed', 'permission_denied',
  'model_not_found', 'endpoint_not_found', 'provider_timeout', 'provider_unavailable', 'invalid_request',
  'context_length_exceeded', 'response_invalid', 'provider_error', 'configuration_error'
]);
export const RETRYABLE_KINDS = new Set(['rate_limited', 'provider_timeout', 'provider_unavailable']);
// Kinds that describe the request itself: trying other providers would repeat the failure.
// context_length_exceeded is a per-target limit, so it fails over (to a larger context window) instead.
export const NO_FAILOVER_KINDS = new Set(['invalid_request']);
// Only failures about the provider's shared state cross processes. Credentials, entitlements and model names come
// from each harness's own environment, so an auth or model failure in one harness must not block the others.
export const SHARED_COOLDOWN_KINDS = new Set(['rate_limited', 'quota_exhausted', 'provider_unavailable', 'provider_timeout']);
export const COOLDOWN_MS = Object.freeze({
  context_length_exceeded: 0,
  rate_limited: 60_000,
  quota_exhausted: 15 * 60_000,
  billing_required: 15 * 60_000,
  authentication_failed: 15 * 60_000,
  permission_denied: 15 * 60_000,
  model_not_found: 15 * 60_000,
  endpoint_not_found: 15 * 60_000,
  configuration_error: 15 * 60_000,
  provider_timeout: 30_000,
  provider_unavailable: 30_000,
  response_invalid: 60_000,
  provider_error: 60_000,
  invalid_request: 0
});

export const COST_POLICIES = Object.freeze(['allow_unknown_cost', 'deny_unknown_cost']);

export const LOG_LEVELS = Object.freeze({error: 0, warn: 1, info: 2, debug: 3});

export const SCHEMA_VERSIONS = Object.freeze({project: 2, mission: 2, event: 2, checkpoint: 2, usage: 1, agent: 1, lock: 2});
