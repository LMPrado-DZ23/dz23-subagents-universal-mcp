import http from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {toolDefinitions} from './mcp.js';

const loopbacks = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
function send(res, status, object, extra = {}) {
  const text = JSON.stringify(object);
  res.writeHead(status, {'content-type':'application/json', 'content-length':Buffer.byteLength(text),
    'cache-control':'no-store', 'x-content-type-options':'nosniff', ...extra});
  res.end(text);
}
function authorized(req, token) {
  if (!token) return true;
  const actual = Buffer.from(req.headers.authorization || '');
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
async function body(req, limit = 2_000_000) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('request_too_large'), {httpStatus:413});
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('invalid_json'), {httpStatus:400}); }
}
function rpcValid(rpc) {
  return rpc && !Array.isArray(rpc) && typeof rpc === 'object' && rpc.jsonrpc === '2.0' &&
    typeof rpc.method === 'string' && (!('id' in rpc) || typeof rpc.id === 'string' || typeof rpc.id === 'number');
}
export function startHttp(cfg, router, memory, mcpHandler) {
  if (!loopbacks.has(cfg.host) && (!cfg.token || cfg.token.length < 32)) {
    return Promise.reject(new Error('Non-loopback HTTP requires DZ23_MCP_TOKEN with at least 32 characters and TLS at the reverse proxy'));
  }
  const allowedHosts = new Set([...loopbacks, ...(cfg.allowedHosts || [])]);
  if (!['0.0.0.0','::'].includes(cfg.host)) allowedHosts.add(cfg.host);
  const allowedOrigins = new Set(cfg.allowedOrigins || []);
  const server = http.createServer(async (req, res) => {
    try {
      let url;
      try { url = new URL(req.url, `http://${req.headers.host || 'invalid'}`); }
      catch { return send(res, 400, {error:'invalid_host'}); }
      if (!allowedHosts.has(url.hostname)) return send(res, 403, {error:'host_not_allowed'});
      // Browsers must be explicitly trusted; absence of Origin is normal for MCP CLIs.
      if (req.headers.origin && !allowedOrigins.has(req.headers.origin)) return send(res, 403, {error:'origin_not_allowed'});
      if (!authorized(req, cfg.token)) return send(res, 401, {error:'unauthorized'});
      if (req.method === 'GET' && url.pathname === '/healthz') return send(res,200,{ok:true,service:'dz23-subagents-universal',version:'2.2.5'});
      if (req.method === 'GET' && url.pathname === '/api/models') return send(res,200,router.listModels());
      if (req.method === 'GET' && url.pathname === '/api/providers') return send(res,200,router.inventory());
      if (req.method === 'GET' && url.pathname === '/api/discover') return send(res,200,await router.discover({provider:url.searchParams.get('provider')||undefined,refresh:url.searchParams.get('refresh')==='true'}));
      if (req.method === 'GET' && url.pathname === '/api/health') return send(res,200,await router.healthCheck());
      if (req.method === 'POST' && url.pathname === '/api/delegate') return send(res,200,await router.delegate(await body(req)));
      if (req.method === 'POST' && url.pathname === '/api/consensus') return send(res,200,await router.consensus(await body(req)));
      if (req.method === 'POST' && url.pathname === '/api/swarm') return send(res,200,await router.swarmRun(await body(req)));
      if (req.method === 'GET' && url.pathname === '/mcp/tools') return send(res,200,{tools:toolDefinitions()});
      if (['GET','DELETE'].includes(req.method) && url.pathname === '/mcp') return send(res,405,{error:'method_not_allowed'},{allow:'POST'});
      if (req.method === 'POST' && url.pathname === '/mcp') {
        if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return send(res,415,{error:'application_json_required'});
        const rpc = await body(req);
        if (!rpcValid(rpc)) return send(res,400,{jsonrpc:'2.0',id:null,error:{code:-32600,message:'Invalid Request'}});
        if (!('id' in rpc)) {
          // Notifications have no JSON-RPC response and may not invoke mutating tools.
          if (!rpc.method.startsWith('notifications/')) return send(res,400,{error:'invalid_notification'});
          await mcpHandler(rpc);
          res.writeHead(202, {'cache-control':'no-store'}); res.end(); return;
        }
        try { return send(res,200,{jsonrpc:'2.0',id:rpc.id,result:await mcpHandler(rpc)}); }
        catch (error) { return send(res,200,{jsonrpc:'2.0',id:rpc.id,error:{code:-32000,message:error.message}}); }
      }
      return send(res,404,{error:'not_found'});
    } catch (error) { return send(res,error.httpStatus || 500,{error:error.httpStatus ? error.message : 'request_failed'}); }
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 10_000;
  return new Promise((resolve,reject) => {
    const onError = error => { server.off('listening',onListening); reject(error); };
    const onListening = () => { server.off('error',onError); resolve(server); };
    server.once('error',onError); server.once('listening',onListening);
    server.listen(cfg.port,cfg.host);
  });
}
