import http from 'node:http';
import {SERVER_NAME, SERVER_VERSION, SUPPORTED_PROTOCOL_VERSIONS, RPC_ERRORS} from './constants.js';
import {toolErrorPayload} from './mcp.js';
import {createRpcProcessor, parseJson, PARSE_FAILURE, acceptRequestId} from './rpc.js';
import {RpcError, RateLimitError, ForbiddenError, toolErrorHttpStatus} from './errors.js';
import {createAuthenticator} from './auth.js';
import {RateLimiter} from './ratelimit.js';

const LOOPBACKS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const HTTP_DEFAULTS = Object.freeze({maxBodyBytes: 1024 * 1024, bodyTimeoutMs: 10_000, headersTimeoutMs: 10_000, maxInflight: 32, maxConnections: 128, socketTimeoutMs: 15 * 60_000});
const RATE_DEFAULTS = Object.freeze({enabled: true, windowMs: 60_000, points: 120, toolPoints: 60, maxConcurrent: 4});
const REST_TOOLS = {'/api/delegate': 'delegate', '/api/consensus': 'consensus', '/api/swarm': 'swarm_run'};

/** Returns a refusal reason when binding would expose HTTP without adequate authentication. */
export function httpSecurityProblem(cfg) {
  if (LOOPBACKS.has(cfg.host)) return null;
  const scoped = (cfg.scopedTokens || []).length > 0;
  if (!scoped && (!cfg.token || cfg.token.length < 32)) {
    return 'Non-loopback HTTP requires DZ23_MCP_TOKEN with at least 32 characters (or scoped tokens) and TLS at the reverse proxy';
  }
  if (cfg.token && cfg.token.length < 32) return 'Non-loopback HTTP requires DZ23_MCP_TOKEN with at least 32 characters';
  return null;
}

function httpError(status, code) {
  return Object.assign(new Error(code), {httpStatus: status});
}

function isJson(req) {
  return (req.headers['content-type'] || '').toLowerCase().startsWith('application/json');
}

function readBody(req, {maxBodyBytes, bodyTimeoutMs}) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBodyBytes) return Promise.reject(httpError(413, 'request_too_large'));
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const finish = (error, value) => {
      clearTimeout(timer);
      req.off('data', onData); req.off('end', onEnd); req.off('error', onError);
      if (error) reject(error); else resolve(value);
    };
    const onData = chunk => {
      size += chunk.length;
      if (size > maxBodyBytes) return finish(httpError(413, 'request_too_large'));
      chunks.push(chunk);
    };
    const onEnd = () => finish(null, Buffer.concat(chunks).toString('utf8'));
    const onError = () => finish(httpError(400, 'request_aborted'));
    const timer = setTimeout(() => finish(httpError(408, 'request_timeout')), bodyTimeoutMs);
    req.on('data', onData); req.on('end', onEnd); req.on('error', onError);
  });
}

export function startHttp(cfg, router, memory, mcpHandler, deps = {}) {
  const problem = httpSecurityProblem(cfg);
  if (problem) return Promise.reject(new Error(problem));
  const limits = {...HTTP_DEFAULTS, ...(cfg.http || {})};
  const rate = {...RATE_DEFAULTS, ...(cfg.rateLimit || {})};
  const logger = deps.logger;
  const metrics = deps.metrics;
  const authenticator = deps.authenticator || createAuthenticator({token: cfg.token, scopedTokens: cfg.scopedTokens});
  const limiter = rate.enabled ? (deps.rateLimiter || new RateLimiter(rate)) : null;
  const allowedHosts = new Set([...LOOPBACKS, ...(cfg.allowedHosts || [])]);
  if (!['0.0.0.0', '::'].includes(cfg.host)) allowedHosts.add(cfg.host);
  const allowedOrigins = new Set(cfg.allowedOrigins || []);
  const processMessage = createRpcProcessor(mcpHandler, {logger});
  const state = {inflight: 0, closing: false, closed: null};

  function send(res, status, object, extra = {}) {
    const text = JSON.stringify(object);
    const headers = {'content-type': 'application/json', 'content-length': Buffer.byteLength(text),
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra};
    if (state.closing) headers.connection = 'close';
    res.writeHead(status, headers);
    res.end(text);
  }

  function rateLimited(res, error, ctx) {
    metrics?.increment('rate_limit_rejections_total', {limit: error.limit});
    logger?.warn('rate_limited', {request_id: ctx.requestId, identity: ctx.identity, limit: error.limit, retry_after_ms: error.retryAfterMs});
    return send(res, 429, {error: 'rate_limited', limit: error.limit, retry_after_ms: error.retryAfterMs, request_id: ctx.requestId},
      {'x-request-id': ctx.requestId, 'retry-after': String(Math.max(1, Math.ceil(error.retryAfterMs / 1000)))});
  }

  async function restTool(res, name, args, ctx) {
    const headers = {'x-request-id': ctx.requestId};
    try {
      const outcome = await mcpHandler.executeTool(name, args, ctx);
      if (outcome.ok) return send(res, 200, outcome.value, headers);
      return send(res, toolErrorHttpStatus(outcome.error), toolErrorPayload(outcome.error, ctx), headers);
    } catch (error) {
      if (error instanceof RateLimitError) return rateLimited(res, error, ctx);
      if (error instanceof ForbiddenError) return send(res, 403, {error: 'forbidden', required_scopes: error.requiredScopes, request_id: ctx.requestId}, headers);
      if (error instanceof RpcError) {
        return send(res, 400, {error: {code: 'invalid_arguments', message: error.message, ...(error.data || {}), request_id: ctx.requestId}}, headers);
      }
      throw error;
    }
  }

  async function jsonBody(req, res, ctx) {
    if (!isJson(req)) { send(res, 415, {error: 'application_json_required', request_id: ctx.requestId}); return PARSE_FAILURE; }
    const parsed = parseJson(await readBody(req, limits) || '{}');
    if (parsed === PARSE_FAILURE) send(res, 400, {error: 'invalid_json', request_id: ctx.requestId});
    return parsed;
  }

  async function handleMcp(req, res, ctx) {
    const headers = {'x-request-id': ctx.requestId};
    if (!isJson(req)) return send(res, 415, {error: 'application_json_required', request_id: ctx.requestId}, headers);
    const version = req.headers['mcp-protocol-version'];
    if (version !== undefined && !SUPPORTED_PROTOCOL_VERSIONS.includes(version)) {
      return send(res, 400, {jsonrpc: '2.0', id: null, error: {code: RPC_ERRORS.INVALID_REQUEST, message: 'Unsupported protocol version',
        data: {supported: [...SUPPORTED_PROTOCOL_VERSIONS], request_id: ctx.requestId}}}, headers);
    }
    const outcome = await processMessage(parseJson(await readBody(req, limits)), {...ctx, protocolVersion: version});
    if (outcome.response === null) {
      if (outcome.rejected) {
        return send(res, 400, {jsonrpc: '2.0', id: null, error: {code: RPC_ERRORS.INVALID_REQUEST, message: 'Invalid Request',
          data: {reason: 'requests without id must be notifications', request_id: ctx.requestId}}}, headers);
      }
      res.writeHead(202, {'cache-control': 'no-store', ...headers, ...(state.closing ? {connection: 'close'} : {})});
      return res.end();
    }
    if (outcome.status === 429) metrics?.increment('rate_limit_rejections_total', {limit: 'tool'});
    const extra = outcome.retryAfterMs ? {...headers, 'retry-after': String(Math.max(1, Math.ceil(outcome.retryAfterMs / 1000)))} : headers;
    return send(res, outcome.status, outcome.response, extra);
  }

  async function route(req, res, ctx, url) {
    switch (`${req.method} ${url.pathname}`) {
      case 'GET /healthz': return send(res, 200, {ok: true, service: SERVER_NAME, version: SERVER_VERSION}, {'x-request-id': ctx.requestId});
      case 'GET /metrics':
        if (!metrics) return send(res, 404, {error: 'not_found'});
        if (!ctx.scopes.has('admin:inventory')) return send(res, 403, {error: 'forbidden', required_scopes: ['admin:inventory'], request_id: ctx.requestId});
        return send(res, 200, metrics.snapshot(), {'x-request-id': ctx.requestId});
      case 'GET /api/models': return restTool(res, 'list_models', {}, ctx);
      case 'GET /api/providers': return restTool(res, 'provider_inventory', {}, ctx);
      case 'GET /api/discover': {
        const args = {refresh: url.searchParams.get('refresh') === 'true'};
        if (url.searchParams.has('provider')) args.provider = url.searchParams.get('provider');
        return restTool(res, 'discover_models', args, ctx);
      }
      case 'GET /api/health': return restTool(res, 'health_check', {}, ctx);
      case 'POST /api/delegate':
      case 'POST /api/consensus':
      case 'POST /api/swarm': {
        const body = await jsonBody(req, res, ctx);
        return body === PARSE_FAILURE ? undefined : restTool(res, REST_TOOLS[url.pathname], body, ctx);
      }
      case 'GET /mcp/tools': return send(res, 200, {tools: mcpHandler.tools});
      case 'GET /mcp':
      case 'DELETE /mcp': return send(res, 405, {error: 'method_not_allowed'}, {allow: 'POST'});
      case 'POST /mcp': return handleMcp(req, res, ctx);
      default: return send(res, 404, {error: 'not_found'});
    }
  }

  async function handle(req, res) {
    const ctx = {transport: 'http', requestId: acceptRequestId(req.headers['x-request-id']), identity: 'unauthenticated'};
    const started = Date.now();
    res.once('close', () => metrics?.observe('http_request_duration_ms', Date.now() - started, {status: String(res.statusCode)}));
    if (state.closing) return send(res, 503, {error: 'shutting_down', request_id: ctx.requestId}, {'retry-after': '1'});
    if (state.inflight >= limits.maxInflight) {
      metrics?.increment('http_rejections_total', {reason: 'inflight'});
      return send(res, 503, {error: 'server_busy', request_id: ctx.requestId}, {'retry-after': '1'});
    }
    state.inflight++;
    res.once('close', () => { state.inflight--; });
    let url;
    try { url = new URL(req.url, `http://${req.headers.host || 'invalid'}`); } catch { return send(res, 400, {error: 'invalid_host'}); }
    if (!allowedHosts.has(url.hostname)) return send(res, 403, {error: 'host_not_allowed'});
    // Browsers must be explicitly trusted; absence of Origin is normal for MCP CLIs.
    if (req.headers.origin && !allowedOrigins.has(req.headers.origin)) return send(res, 403, {error: 'origin_not_allowed'});
    const remote = req.socket.remoteAddress || 'unknown';
    const failureKey = `authfail:${remote}`;
    try {
      limiter?.check(failureKey, limiter.cost('moderate'));
    } catch (error) {
      return rateLimited(res, error, ctx);
    }
    const principal = authenticator.authenticate(req.headers.authorization, remote);
    if (!principal) {
      try { limiter?.consume(failureKey, {costClass: 'moderate'}); } catch { /* already exhausted */ }
      logger?.warn('http_unauthorized', {request_id: ctx.requestId});
      return send(res, 401, {error: 'unauthorized'}, {'www-authenticate': 'Bearer'});
    }
    ctx.identity = principal.identity;
    ctx.scopes = principal.scopes;
    if (limiter) {
      try { limiter.consume(principal.identity, {costClass: 'light'}); } catch (error) { return rateLimited(res, error, ctx); }
      ctx.beforeToolCall = (tool, policy) => limiter.admitTool(principal.identity, tool, policy.costClass);
    }
    return route(req, res, ctx, url);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(error => {
      if (res.headersSent) return res.destroy();
      const status = error.httpStatus || 500;
      if (!error.httpStatus) logger?.error('http_request_failed', {error_name: error.name});
      send(res, status, {error: error.httpStatus ? error.message : 'request_failed'}, error.httpStatus ? {connection: 'close'} : {});
      if (error.httpStatus) res.once('finish', () => req.destroy());
    });
  });
  server.maxConnections = limits.maxConnections;
  server.headersTimeout = limits.headersTimeoutMs;
  server.requestTimeout = limits.headersTimeoutMs + limits.bodyTimeoutMs + 1000;
  server.timeout = limits.socketTimeoutMs;
  server.keepAliveTimeout = 5000;

  /** Stop accepting work, let in-flight requests finish, force-close after the grace period. */
  server.shutdown = (graceMs = cfg.shutdownGraceMs ?? 10_000) => {
    if (state.closed) return state.closed;
    state.closing = true;
    state.closed = new Promise(resolve => {
      const force = setTimeout(() => server.closeAllConnections(), graceMs);
      force.unref();
      server.close(() => { clearTimeout(force); resolve(); });
      server.closeIdleConnections();
    });
    return state.closed;
  };
  server.inflight = () => state.inflight;

  return new Promise((resolve, reject) => {
    const onError = error => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolve(server); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(cfg.port, cfg.host);
  });
}
