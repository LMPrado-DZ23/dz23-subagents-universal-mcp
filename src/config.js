import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {parsePriceTable} from './budget.js';
import {DEFAULT_COST_WEIGHTS, TOOL_ARGUMENT_ERROR_MODES, LOG_LEVELS, COST_POLICIES} from './constants.js';
import {ConfigError} from './errors.js';
import {loadMcpToken, loadScopedTokens} from './auth.js';

function expandHome(p) {
  if (!p) return p;
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

export function intEnv(name, fallback, env = process.env) {
  const n = Number.parseInt(env[name] ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Bounded integer setting. Invalid or out-of-range values are clamped and reported. */
function boundedInt(env, issues, name, fallback, min, max) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    issues.push({level: 'error', variable: name, message: 'must be an integer; using default'});
    return fallback;
  }
  if (n < min || n > max) {
    issues.push({level: 'warn', variable: name, message: `must be between ${min} and ${max}; clamped`});
    return Math.max(min, Math.min(max, n));
  }
  return n;
}

function flag(env, name, fallback = false) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  return String(raw).toLowerCase() === 'true';
}

function list(env, name) {
  return (env[name] || '').split(',').map(item => item.trim()).filter(Boolean);
}

export function parseWeights(raw) {
  const weights = {...DEFAULT_COST_WEIGHTS};
  if (!raw) return weights;
  for (const pair of raw.split(',').map(item => item.trim()).filter(Boolean)) {
    const [name, value] = pair.split(':').map(item => item.trim());
    const n = Number(value);
    if (!Object.hasOwn(DEFAULT_COST_WEIGHTS, name) || !Number.isInteger(n) || n < 1 || n > 1000) {
      throw new ConfigError(`DZ23_RATE_LIMIT_WEIGHTS entries must be <class>:<1-1000> with class in ${Object.keys(DEFAULT_COST_WEIGHTS).join(', ')}`);
    }
    weights[name] = n;
  }
  return weights;
}

/** Budget amounts fail loudly: silently ignoring a spending limit would be unsafe. */
function money(env, name) {
  const raw = env[name];
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new ConfigError(`${name} must be a non-negative number of USD`);
  return n;
}

function optionalLimit(env, name, max) {
  const raw = env[name];
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new ConfigError(`${name} must be an integer between 1 and ${max}`);
  return n;
}

function loadPrices(env) {
  if (env.DZ23_PRICES && env.DZ23_PRICES_FILE) throw new ConfigError('Set only one of DZ23_PRICES or DZ23_PRICES_FILE');
  let raw = env.DZ23_PRICES;
  let label = 'DZ23_PRICES';
  if (env.DZ23_PRICES_FILE) {
    label = 'DZ23_PRICES_FILE';
    try { raw = fs.readFileSync(env.DZ23_PRICES_FILE, 'utf8'); } catch { throw new ConfigError('Cannot read DZ23_PRICES_FILE'); }
  }
  if (!raw) return {};
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new ConfigError(`${label} must contain valid JSON`); }
  return parsePriceTable(parsed, label);
}

export function budgetConfig(env = process.env) {
  const policy = env.DZ23_COST_POLICY || 'allow_unknown_cost';
  if (!COST_POLICIES.includes(policy)) throw new ConfigError(`DZ23_COST_POLICY must be one of: ${COST_POLICIES.join(', ')}`);
  return {
    missionCostUsd: money(env, 'DZ23_MAX_MISSION_COST_USD'),
    projectCostUsd: money(env, 'DZ23_MAX_PROJECT_COST_USD'),
    dailyCostUsd: money(env, 'DZ23_MAX_DAILY_COST_USD'),
    callCostUsd: money(env, 'DZ23_MAX_CALL_COST_USD'),
    missionTokens: optionalLimit(env, 'DZ23_MAX_MISSION_TOKENS', 1_000_000_000),
    missionCalls: optionalLimit(env, 'DZ23_MAX_MISSION_CALLS', 1_000_000),
    inputTokens: optionalLimit(env, 'DZ23_MAX_INPUT_TOKENS', 10_000_000),
    policy,
    prices: loadPrices(env)
  };
}

export function config(env = process.env) {
  const issues = [];
  const int = (name, fallback, min, max) => boundedInt(env, issues, name, fallback, min, max);
  const auth = loadMcpToken(env);
  const scoped = loadScopedTokens(env);
  for (const message of [...auth.warnings, ...scoped.warnings]) issues.push({level: 'warn', variable: 'auth', message});
  const toolArgumentErrors = env.DZ23_TOOL_ARGUMENT_ERRORS || 'auto';
  if (!TOOL_ARGUMENT_ERROR_MODES.includes(toolArgumentErrors)) throw new ConfigError(`DZ23_TOOL_ARGUMENT_ERRORS must be one of: ${TOOL_ARGUMENT_ERROR_MODES.join(', ')}`);
  const logLevel = env.DZ23_LOG_LEVEL || 'info';
  if (!Object.hasOwn(LOG_LEVELS, logLevel)) throw new ConfigError(`DZ23_LOG_LEVEL must be one of: ${Object.keys(LOG_LEVELS).join(', ')}`);
  const providerTimeoutMs = Math.max(1000, intEnv('DZ23_PROVIDER_TIMEOUT_MS', 90_000, env));
  const rateLimit = {
    enabled: flag(env, 'DZ23_RATE_LIMIT_ENABLED', true),
    windowMs: int('DZ23_RATE_LIMIT_WINDOW_MS', 60_000, 1000, 3_600_000),
    points: int('DZ23_RATE_LIMIT_POINTS', 120, 1, 100_000),
    toolPoints: int('DZ23_RATE_LIMIT_TOOL_POINTS', 60, 1, 100_000),
    maxConcurrent: int('DZ23_RATE_LIMIT_CONCURRENT', 4, 1, 64),
    weights: parseWeights(env.DZ23_RATE_LIMIT_WEIGHTS)
  };
  const heaviest = Math.max(...Object.values(rateLimit.weights));
  if (rateLimit.enabled && heaviest > Math.min(rateLimit.points, rateLimit.toolPoints)) {
    issues.push({level: 'error', variable: 'DZ23_RATE_LIMIT_WEIGHTS', message: `heaviest weight ${heaviest} exceeds DZ23_RATE_LIMIT_POINTS or DZ23_RATE_LIMIT_TOOL_POINTS; those tools can never run over HTTP`});
  }

  return {
    stateDir: expandHome(env.DZ23_STATE_DIR || '~/.dz23-subagents'),
    host: env.DZ23_HTTP_HOST || '127.0.0.1',
    port: int('DZ23_HTTP_PORT', 8787, 0, 65535),
    token: auth.token,
    tokenSource: auth.source,
    authMode: scoped.mode,
    scopedTokens: scoped.tokens,
    allowHttp: flag(env, 'DZ23_ALLOW_HTTP'),
    allowedHosts: list(env, 'DZ23_ALLOWED_HOSTS'),
    allowedOrigins: list(env, 'DZ23_ALLOWED_ORIGINS'),
    policy: env.DZ23_ROUTING_POLICY || 'free-first',
    maxConcurrency: int('DZ23_MAX_CONCURRENCY', 7, 1, 8),
    maxWorkersPerTarget: int('DZ23_MAX_WORKERS_PER_TARGET', 4, 1, 7),
    maxQueue: int('DZ23_MAX_QUEUE', 32, 1, 128),
    timeoutMs: providerTimeoutMs,
    healthTimeoutMs: Math.max(1000, intEnv('DZ23_HEALTH_TIMEOUT_MS', 15_000, env)),
    maxContextChars: int('DZ23_MAX_CONTEXT_CHARS', 60_000, 10_000, 120_000),
    maxOutputTokens: int('DZ23_MAX_OUTPUT_TOKENS', 4096, 64, 4096),
    maxResponseBytes: int('DZ23_MAX_RESPONSE_BYTES', 2 * 1024 * 1024, 65_536, 4 * 1024 * 1024),
    maxStoredOutputChars: int('DZ23_MAX_STORED_OUTPUT_CHARS', 12_000, 1000, 24_000),
    maxAgentOutputs: int('DZ23_MAX_AGENT_OUTPUTS', 16, 1, 32),
    maxJournalBytes: int('DZ23_MAX_JOURNAL_BYTES', 1024 * 1024, 65_536, 4 * 1024 * 1024),
    maxCheckpoints: int('DZ23_MAX_CHECKPOINTS', 8, 1, 16),
    lockTimeoutMs: int('DZ23_LOCK_TIMEOUT_MS', 20_000, 1000, 120_000),
    lockStaleMs: int('DZ23_LOCK_STALE_MS', 30_000, 5000, 3_600_000),
    durableWrites: flag(env, 'DZ23_MEMORY_FSYNC', true),
    maxStdioFrameBytes: int('DZ23_MAX_STDIO_FRAME_BYTES', 512 * 1024, 65_536, 2 * 1024 * 1024),
    maxPromptChars: int('DZ23_MAX_PROMPT_CHARS', 32_000, 1000, 200_000),
    maxGoalChars: int('DZ23_MAX_GOAL_CHARS', 8000, 500, 64_000),
    toolArgumentErrors,
    logLevel,
    maxRetries: int('DZ23_MAX_RETRIES', 1, 0, 5),
    retryBaseDelayMs: int('DZ23_RETRY_BASE_DELAY_MS', 500, 50, 60_000),
    retryAfterCapMs: int('DZ23_RETRY_AFTER_CAP_MS', 30_000, 0, 300_000),
    allowPaid: flag(env, 'DZ23_ALLOW_PAID'),
    rotation: list(env, 'DZ23_ROTATION'),
    rateLimit,
    http: {
      maxBodyBytes: int('DZ23_HTTP_MAX_BODY_BYTES', 1024 * 1024, 16_384, 8 * 1024 * 1024),
      bodyTimeoutMs: int('DZ23_HTTP_BODY_TIMEOUT_MS', 10_000, 500, 120_000),
      headersTimeoutMs: int('DZ23_HTTP_HEADERS_TIMEOUT_MS', 10_000, 1000, 60_000),
      maxInflight: int('DZ23_HTTP_MAX_INFLIGHT', 32, 1, 1024),
      maxConnections: int('DZ23_HTTP_MAX_CONNECTIONS', 128, 1, 10_000),
      socketTimeoutMs: int('DZ23_HTTP_SOCKET_TIMEOUT_MS', 15 * 60_000, 10_000, 3_600_000)
    },
    shutdownGraceMs: int('DZ23_SHUTDOWN_GRACE_MS', 10_000, 0, 120_000),
    budget: budgetConfig(env),
    configIssues: issues
  };
}
