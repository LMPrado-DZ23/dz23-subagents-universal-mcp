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
const REST_TOOLS = {'/api/delegate': 'delegate', '/api/consensus': 'consensus', '/api/swarm': 'swarm_run', '/api/health': 'health_check'};
const SAFE_FETCH_SITES = new Set(['same-origin', 'none']);
const BODY_ERRORS = {request_too_large: 'Request body is too large', request_timeout: 'Request body was not received in time', request_aborted: 'Request body was aborted'};

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

/** The single error envelope for every non-JSON-RPC HTTP response (REST and transport errors). */
export function errorBody(code, message, ctx, details) {
  return {error: {code, message, ...(ctx?.requestId ? {request_id: ctx.requestId} : {}), ...(details !== undefined ? {details} : {})}};
}

function httpError(status, code) {
  return Object.assign(new Error(code), {httpStatus: status});
}

function isJson(req) {
  return (req.headers['content-type'] || '').toLowerCase().startsWith('application/json');
}

/** Hostname from the Host header itself (never from an absolute-form request line). */
function hostnameOf(header) {
  if (!header) return null;
  try { return new URL(`http://${header}`).hostname; } catch { return null; }
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

  function fail(res, status, code, message, ctx, details, extra = {}) {
    return send(res, status, errorBody(code, message, ctx, details), {...(ctx?.requestId ? {'x-request-id': ctx.requestId} : {}), ...extra});
  }

  function rateLimited(res, error, ctx) {
    metrics?.increment('rate_limit_rejections_total', {limit: error.limit});
    logger?.warn('rate_limited', {request_id: ctx.requestId, identity: ctx.identity, limit: error.limit, retry_after_ms: error.retryAfterMs});
    return fail(res, 429, 'rate_limited', 'Rate limit exceeded', ctx, {limit: error.limit, retry_after_ms: error.retryAfterMs},
      {'retry-after': String(Math.max(1, Math.ceil(error.retryAfterMs / 1000)))});
  }

  async function restTool(res, name, args, ctx) {
    try {
      const outcome = await mcpHandler.executeTool(name, args, ctx);
      if (outcome.ok) return send(res, 200, outcome.value, {'x-request-id': ctx.requestId});
      return send(res, toolErrorHttpStatus(outcome.error), toolErrorPayload(outcome.error, ctx), {'x-request-id': ctx.requestId});
    } catch (error) {
      if (error instanceof RateLimitError) return rateLimited(res, error, ctx);
      if (error instanceof ForbiddenError) return fail(res, 403, 'forbidden', 'The token lacks the required scopes', ctx, {required_scopes: error.requiredScopes});
      if (error instanceof RpcError) {
        const {request_id: _ignored, ...details} = error.data || {};
        return fail(res, 400, error.message === 'Unknown tool' ? 'unknown_tool' : 'invalid_arguments', error.message, ctx, details);
      }
      throw error;
    }
  }

  async function jsonBody(req, res, ctx) {
    if (!isJson(req)) { fail(res, 415, 'application_json_required', 'Content-Type must be application/json', ctx); return PARSE_FAILURE; }
    const parsed = parseJson(await readBody(req, limits) || '{}');
    if (parsed === PARSE_FAILURE) fail(res, 400, 'invalid_json', 'Request body is not valid JSON', ctx);
    return parsed;
  }

  async function handleMcp(req, res, ctx) {
    const headers = {'x-request-id': ctx.requestId};
    if (!isJson(req)) return fail(res, 415, 'application_json_required', 'Content-Type must be application/json', ctx);
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
        if (!metrics) return fail(res, 404, 'not_found', 'Not found', ctx);
        if (!ctx.scopes.has('admin:inventory')) return fail(res, 403, 'forbidden', 'The token lacks the required scopes', ctx, {required_scopes: ['admin:inventory']});
        return send(res, 200, metrics.snapshot(), {'x-request-id': ctx.requestId});
      case 'GET /api/models': return restTool(res, 'list_models', {}, ctx);
      case 'GET /api/providers': return restTool(res, 'provider_inventory', {}, ctx);
      case 'GET /api/discover': {
        const args = {refresh: url.searchParams.get('refresh') === 'true'};
        if (url.searchParams.has('provider')) args.provider = url.searchParams.get('provider');
        return restTool(res, 'discover_models', args, ctx);
      }
      case 'GET /api/health':
        return fail(res, 405, 'method_not_allowed', 'health_check is billable: use POST with {"confirm_billable": true}', ctx, undefined, {allow: 'POST'});
      case 'POST /api/health':
      case 'POST /api/delegate':
      case 'POST /api/consensus':
      case 'POST /api/swarm': {
        const body = await jsonBody(req, res, ctx);
        return body === PARSE_FAILURE ? undefined : restTool(res, REST_TOOLS[url.pathname], body, ctx);
      }
      case 'GET /mcp/tools': return send(res, 200, {tools: mcpHandler.tools}, {'x-request-id': ctx.requestId});
      case 'GET /mcp':
      case 'DELETE /mcp': return fail(res, 405, 'method_not_allowed', 'Only POST is supported on /mcp (no SSE or sessions)', ctx, undefined, {allow: 'POST'});
      case 'POST /mcp': return handleMcp(req, res, ctx);
      default: return fail(res, 404, 'not_found', 'Not found', ctx);
    }
  }

  async function handle(req, res, ctx) {
    const started = Date.now();
    res.once('close', () => metrics?.observe('http_request_duration_ms', Date.now() - started, {status: String(res.statusCode)}));
    if (state.closing) return fail(res, 503, 'shutting_down', 'Server is shutting down', ctx, undefined, {'retry-after': '1'});
    if (state.inflight >= limits.maxInflight) {
      metrics?.increment('http_rejections_total', {reason: 'inflight'});
      return fail(res, 503, 'server_busy', 'Too many requests in progress', ctx, undefined, {'retry-after': '1'});
    }
    state.inflight++;
    res.once('close', () => { state.inflight--; });
    const hostname = hostnameOf(req.headers.host);
    if (!hostname) return fail(res, 400, 'invalid_host', 'Missing or invalid Host header', ctx);
    if (!allowedHosts.has(hostname)) return fail(res, 403, 'host_not_allowed', 'Host is not allowed', ctx);
    const origin = req.headers.origin;
    const trustedOrigin = Boolean(origin) && allowedOrigins.has(origin);
    if (origin && !trustedOrigin) return fail(res, 403, 'origin_not_allowed', 'Origin is not allowed', ctx);
    // Browsers label cross-site requests even when they send no Origin (images, navigations, prefetch).
    const site = req.headers['sec-fetch-site'];
    if (site && !SAFE_FETCH_SITES.has(site) && !trustedOrigin) return fail(res, 403, 'cross_site_request_blocked', 'Cross-site browser requests are not allowed', ctx);
    let url;
    try { url = new URL(req.url, 'http://request.invalid'); } catch { return fail(res, 400, 'invalid_url', 'Invalid request URL', ctx); }
    const remote = req.socket.remoteAddress || 'unknown';
    const principal = authenticator.authenticate(req.headers.authorization, remote);
    if (!principal) {
      // Only failing attempts are throttled, so a valid token is never locked out by other clients' failures.
      try {
        limiter?.consume(`authfail:${remote}`, {costClass: 'moderate'});
      } catch (error) {
        return rateLimited(res, error, ctx);
      }
      logger?.warn('http_unauthorized', {request_id: ctx.requestId});
      return fail(res, 401, 'unauthorized', 'A valid bearer token is required', ctx, undefined, {'www-authenticate': 'Bearer'});
    }
    ctx.identity = principal.identity;
    ctx.scopes = principal.scopes;
    if (limiter) {
      try { limiter.consume(principal.identity, {costClass: 'light'}); } catch (error) { return rateLimited(res, error, ctx); }
      ctx.beforeToolCall = (tool, policy) => limiter.admitTool(principal.identity, tool, policy.costClass);
    }
    return route(req, res, ctx, url);
  }

  const server = http.createServer({connectionsCheckingInterval: Math.min(limits.headersTimeoutMs, 2000)}, (req, res) => {
    const ctx = {transport: 'http', requestId: acceptRequestId(req.headers['x-request-id']), identity: 'unauthenticated'};
    handle(req, res, ctx).catch(error => {
      if (res.headersSent) return res.destroy();
      if (!error.httpStatus) logger?.error('http_request_failed', {error_name: error.name});
      const code = error.httpStatus ? error.message : 'request_failed';
      fail(res, error.httpStatus || 500, code, BODY_ERRORS[code] || 'Request failed', ctx, undefined, error.httpStatus ? {connection: 'close'} : {});
      if (error.httpStatus) res.once('finish', () => req.destroy());
    });
  });
  server.maxConnections = limits.maxConnections;
  server.headersTimeout = limits.headersTimeoutMs;
  server.requestTimeout = limits.headersTimeoutMs + limits.bodyTimeoutMs + 1000;
  server.timeout = limits.socketTimeoutMs;
  // A connection that never sends a byte is closed after headersTimeoutMs instead of holding a slot until the socket timeout.
  server.on('connection', socket => {
    const idle = setTimeout(() => { if (!socket.bytesRead) socket.destroy(); }, limits.headersTimeoutMs);
    idle.unref();
    const clear = () => clearTimeout(idle);
    socket.once('data', clear);
    socket.once('close', clear);
  });
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
