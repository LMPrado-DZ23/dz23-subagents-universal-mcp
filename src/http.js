import http from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {SERVER_NAME, SERVER_VERSION, SUPPORTED_PROTOCOL_VERSIONS, RPC_ERRORS} from './constants.js';
import {toolDefinitions, toolErrorPayload} from './mcp.js';
import {createRpcProcessor, parseJson, PARSE_FAILURE, acceptRequestId} from './rpc.js';
import {RpcError, toolErrorHttpStatus} from './errors.js';

const loopbacks = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function send(res, status, object, extra = {}) {
  const text = JSON.stringify(object);
  res.writeHead(status, {'content-type': 'application/json', 'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra});
  res.end(text);
}

function authorized(req, token) {
  if (!token) return true;
  const actual = Buffer.from(req.headers.authorization || '');
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readBody(req, limit = 2_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('request_too_large'), {httpStatus: 413});
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function isJson(req) {
  return (req.headers['content-type'] || '').toLowerCase().startsWith('application/json');
}

async function restTool(res, handler, name, args, ctx) {
  const headers = {'x-request-id': ctx.requestId};
  try {
    const outcome = await handler.executeTool(name, args, ctx);
    if (outcome.ok) return send(res, 200, outcome.value, headers);
    return send(res, toolErrorHttpStatus(outcome.error), toolErrorPayload(outcome.error, ctx), headers);
  } catch (error) {
    if (error instanceof RpcError) {
      return send(res, 400, {error: {code: 'invalid_arguments', message: error.message, ...(error.data || {}), request_id: ctx.requestId}}, headers);
    }
    throw error;
  }
}

async function restJsonBody(req, res, ctx) {
  if (!isJson(req)) { send(res, 415, {error: 'application_json_required', request_id: ctx.requestId}); return PARSE_FAILURE; }
  const parsed = parseJson(await readBody(req) || '{}');
  if (parsed === PARSE_FAILURE) send(res, 400, {error: 'invalid_json', request_id: ctx.requestId});
  return parsed;
}

async function handleMcp(req, res, processMessage, ctx) {
  const headers = {'x-request-id': ctx.requestId};
  if (!isJson(req)) return send(res, 415, {error: 'application_json_required', request_id: ctx.requestId}, headers);
  const version = req.headers['mcp-protocol-version'];
  if (version !== undefined && !SUPPORTED_PROTOCOL_VERSIONS.includes(version)) {
    return send(res, 400, {jsonrpc: '2.0', id: null, error: {code: RPC_ERRORS.INVALID_REQUEST, message: 'Unsupported protocol version',
      data: {supported: [...SUPPORTED_PROTOCOL_VERSIONS], request_id: ctx.requestId}}}, headers);
  }
  const outcome = await processMessage(parseJson(await readBody(req)), {...ctx, protocolVersion: version});
  if (outcome.response === null) {
    if (outcome.rejected) {
      return send(res, 400, {jsonrpc: '2.0', id: null, error: {code: RPC_ERRORS.INVALID_REQUEST, message: 'Invalid Request',
        data: {reason: 'requests without id must be notifications', request_id: ctx.requestId}}}, headers);
    }
    res.writeHead(202, {'cache-control': 'no-store', ...headers});
    return res.end();
  }
  const extra = outcome.retryAfterMs ? {...headers, 'retry-after': String(Math.ceil(outcome.retryAfterMs / 1000))} : headers;
  return send(res, outcome.status, outcome.response, extra);
}

export function startHttp(cfg, router, memory, mcpHandler) {
  if (!loopbacks.has(cfg.host) && (!cfg.token || cfg.token.length < 32)) {
    return Promise.reject(new Error('Non-loopback HTTP requires DZ23_MCP_TOKEN with at least 32 characters and TLS at the reverse proxy'));
  }
  const allowedHosts = new Set([...loopbacks, ...(cfg.allowedHosts || [])]);
  if (!['0.0.0.0', '::'].includes(cfg.host)) allowedHosts.add(cfg.host);
  const allowedOrigins = new Set(cfg.allowedOrigins || []);
  const processMessage = createRpcProcessor(mcpHandler);

  const server = http.createServer(async (req, res) => {
    const ctx = {transport: 'http', requestId: acceptRequestId(req.headers['x-request-id']), identity: 'http'};
    try {
      let url;
      try { url = new URL(req.url, `http://${req.headers.host || 'invalid'}`); } catch { return send(res, 400, {error: 'invalid_host'}); }
      if (!allowedHosts.has(url.hostname)) return send(res, 403, {error: 'host_not_allowed'});
      // Browsers must be explicitly trusted; absence of Origin is normal for MCP CLIs.
      if (req.headers.origin && !allowedOrigins.has(req.headers.origin)) return send(res, 403, {error: 'origin_not_allowed'});
      if (!authorized(req, cfg.token)) return send(res, 401, {error: 'unauthorized'});
      const route = `${req.method} ${url.pathname}`;
      switch (route) {
        case 'GET /healthz': return send(res, 200, {ok: true, service: SERVER_NAME, version: SERVER_VERSION});
        case 'GET /api/models': return restTool(res, mcpHandler, 'list_models', {}, ctx);
        case 'GET /api/providers': return restTool(res, mcpHandler, 'provider_inventory', {}, ctx);
        case 'GET /api/discover': {
          const args = {refresh: url.searchParams.get('refresh') === 'true'};
          if (url.searchParams.has('provider')) args.provider = url.searchParams.get('provider');
          return restTool(res, mcpHandler, 'discover_models', args, ctx);
        }
        case 'GET /api/health': return restTool(res, mcpHandler, 'health_check', {}, ctx);
        case 'POST /api/delegate':
        case 'POST /api/consensus':
        case 'POST /api/swarm': {
          const body = await restJsonBody(req, res, ctx);
          if (body === PARSE_FAILURE) return undefined;
          const name = {'/api/delegate': 'delegate', '/api/consensus': 'consensus', '/api/swarm': 'swarm_run'}[url.pathname];
          return restTool(res, mcpHandler, name, body, ctx);
        }
        case 'GET /mcp/tools': return send(res, 200, {tools: mcpHandler.tools || toolDefinitions(cfg)});
        case 'GET /mcp':
        case 'DELETE /mcp': return send(res, 405, {error: 'method_not_allowed'}, {allow: 'POST'});
        case 'POST /mcp': return handleMcp(req, res, processMessage, ctx);
        default: return send(res, 404, {error: 'not_found'});
      }
    } catch (error) {
      if (res.headersSent) return res.destroy();
      return send(res, error.httpStatus || 500, {error: error.httpStatus ? error.message : 'request_failed', request_id: ctx.requestId});
    }
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 10_000;
  return new Promise((resolve, reject) => {
    const onError = error => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolve(server); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(cfg.port, cfg.host);
  });
}
