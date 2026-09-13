import {config} from './config.js';
import {ProjectMemory} from './memory.js';
import {Router} from './core.js';
import {createMcpHandler} from './mcp.js';
import {createRpcProcessor} from './rpc.js';
import {startHttp} from './http.js';
import {startStdio} from './stdio.js';
import {ConfigError} from './errors.js';
import {createLogger} from './logger.js';
import {Metrics} from './metrics.js';
import {SERVER_VERSION, SUPPORTED_PROTOCOL_VERSIONS} from './constants.js';

const EX_CONFIG = 78;

/** Start the MCP server on stdio (default) or HTTP (--http). */
export async function serve(argv = []) {
  let cfg;
  try {
    cfg = config();
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    process.stderr.write(`${JSON.stringify({ts: new Date().toISOString(), level: 'error', event: 'config_invalid', message: error.message})}\n`);
    process.exit(EX_CONFIG);
  }

  const logger = createLogger({level: cfg.logLevel});
  logger.addSecrets([cfg.token]);
  for (const issue of cfg.configIssues) logger[issue.level === 'error' ? 'error' : 'warn']('config_issue', issue);
  const metrics = new Metrics();
  const memory = new ProjectMemory(cfg.stateDir, {...cfg, logger});
  const router = new Router(cfg, memory, {logger, metrics});
  const handler = createMcpHandler(router, memory, {logger, metrics});
  let server = null;
  let stdio = null;

  if (argv.includes('--http')) {
    if (!cfg.allowHttp) {
      logger.error('http_disabled', {message: 'set DZ23_ALLOW_HTTP=true only after configuring authentication'});
      process.exit(EX_CONFIG);
    }
    server = await startHttp(cfg, router, memory, handler, {logger, metrics});
    metrics.gauge('http_inflight', () => server.inflight());
    logger.info('server_started', {transport: 'http', host: cfg.host, port: server.address().port, version: SERVER_VERSION, protocol_versions: SUPPORTED_PROTOCOL_VERSIONS, auth_mode: cfg.authMode});
  } else {
    stdio = startStdio({processMessage: createRpcProcessor(handler, {logger}), maxFrameBytes: cfg.maxStdioFrameBytes, logger});
    logger.info('server_started', {transport: 'stdio', version: SERVER_VERSION, protocol_versions: SUPPORTED_PROTOCOL_VERSIONS});
  }

  let stopping = false;
  const shutdown = async signal => {
    if (stopping) return;
    stopping = true;
    logger.info('shutdown_started', {signal, grace_ms: cfg.shutdownGraceMs});
    const hardStop = setTimeout(() => process.exit(1), cfg.shutdownGraceMs + 2000);
    hardStop.unref();
    try {
      if (server) await server.shutdown(cfg.shutdownGraceMs);
      else if (stdio) await Promise.race([stdio.idle(), new Promise(resolve => setTimeout(resolve, cfg.shutdownGraceMs).unref())]);
    } finally {
      logger.info('shutdown_completed', {signal});
      process.exit(0);
    }
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { shutdown(signal); });
}
