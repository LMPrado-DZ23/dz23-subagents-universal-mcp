import {RPC_ERRORS} from './constants.js';
import {parseJson, newRequestId} from './rpc.js';
import {isPlainObject} from './schema.js';

const idKey = id => (typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id)) ? `${typeof id}:${id}` : null);

/**
 * Newline-delimited JSON-RPC over stdio. Up to `maxInflight` requests run concurrently, so `ping`, a quick
 * `mission_status` or a cancellation is never stuck behind a long `swarm_run`; responses are written as they
 * complete (JSON-RPC matches them by id). Notifications run immediately. `notifications/cancelled` aborts the
 * named in-flight request, whose response is then suppressed as the MCP cancellation rules require.
 * Only protocol messages are written to stdout; diagnostics go to the logger (stderr).
 * A frame larger than maxFrameBytes is reported once and dropped up to its newline without
 * being buffered, so memory stays bounded by maxFrameBytes plus one chunk.
 */
export function startStdio({processMessage, maxFrameBytes, logger, maxInflight = 8, maxQueued = 256, input = process.stdin, output = process.stdout}) {
  const session = {protocolVersion: null};
  const limit = Math.max(1, Math.floor(maxInflight));
  const queueLimit = Math.max(1, Math.floor(maxQueued));
  const pending = new Set();
  const waiting = [];
  const controllers = new Map();
  let active = 0;
  let buffer = '';
  let bufferBytes = 0;
  let discarding = false;

  const write = message => output.write(`${JSON.stringify(message)}\n`);
  const oversized = () => {
    logger?.warn('stdio_frame_rejected', {reason: 'frame_too_large', max_bytes: maxFrameBytes});
    write({jsonrpc: '2.0', id: null, error: {code: RPC_ERRORS.INVALID_REQUEST, message: 'Invalid Request', data: {reason: 'frame too large'}}});
  };
  const acquire = () => (active < limit ? (active++, Promise.resolve()) : new Promise(resolve => waiting.push(resolve)));
  const release = () => { const next = waiting.shift(); if (next) next(); else active--; };

  const handleLine = async line => {
    const message = parseJson(line);
    const notification = isPlainObject(message) && !Object.hasOwn(message, 'id');
    if (notification && message.method === 'notifications/cancelled') {
      const key = idKey(message.params?.requestId);
      const controller = key && controllers.get(key);
      if (controller) {
        controller.abort();
        logger?.info('stdio_request_cancelled', {reason_present: typeof message.params?.reason === 'string'});
      }
      return;
    }
    const key = !notification && isPlainObject(message) ? idKey(message.id) : null;
    if (!notification && active >= limit && waiting.length >= queueLimit) {
      // Bounded backlog: a client flooding requests gets a busy error instead of growing memory without limit.
      logger?.warn('stdio_request_rejected', {reason: 'queue_full', max_queued: queueLimit});
      if (key !== null) write({jsonrpc: '2.0', id: message.id, error: {code: RPC_ERRORS.SERVER_BUSY, message: 'Server busy', data: {reason: 'stdio_queue_full'}}});
      return;
    }
    if (key !== null && controllers.has(key)) {
      // A reused in-flight id would make responses and cancellations ambiguous (and uncancellable).
      write({jsonrpc: '2.0', id: message.id, error: {code: RPC_ERRORS.INVALID_REQUEST, message: 'Invalid Request', data: {reason: 'duplicate in-flight id'}}});
      return;
    }
    const controller = new AbortController();
    const registered = key !== null;
    if (registered) controllers.set(key, controller);
    const ctx = {transport: 'stdio', session, requestId: newRequestId(), identity: 'stdio', signal: controller.signal};
    if (!notification) await acquire();
    try {
      // Cancelled while waiting for a slot: never run it (non-billable tools such as memory_checkpoint ignore signals).
      if (controller.signal.aborted) return;
      const {response} = await processMessage(message, ctx);
      if (response && !controller.signal.aborted) write(response);
    } finally {
      if (!notification) release();
      if (registered) controllers.delete(key);
    }
  };
  const enqueue = line => {
    const task = handleLine(line).catch(error => logger?.error('stdio_handler_failed', {error_name: error?.name}));
    pending.add(task);
    task.finally(() => pending.delete(task));
  };
  const idle = async () => { while (pending.size) await Promise.allSettled([...pending]); };

  input.setEncoding('utf8');
  input.on('data', chunk => {
    let text = chunk;
    while (text.length) {
      const end = text.indexOf('\n');
      if (discarding) {
        if (end < 0) return;
        text = text.slice(end + 1);
        discarding = false;
        continue;
      }
      const piece = end < 0 ? text : text.slice(0, end);
      bufferBytes += Buffer.byteLength(piece);
      if (bufferBytes > maxFrameBytes) {
        buffer = '';
        bufferBytes = 0;
        oversized();
        if (end < 0) { discarding = true; return; }
        text = text.slice(end + 1);
        continue;
      }
      buffer += piece;
      if (end < 0) return;
      const line = buffer.trim();
      buffer = '';
      bufferBytes = 0;
      text = text.slice(end + 1);
      if (line) enqueue(line);
    }
  });
  // End of input still lets pending requests finish and answer (pipes close stdin right after writing requests).
  const finished = new Promise(resolve => input.on('end', () => idle().then(resolve)));
  /** Shutdown: abort every in-flight and queued request so paid work stops and usage is settled as cancelled. */
  const abortAll = () => { for (const controller of controllers.values()) controller.abort(); };
  return {session, finished, idle, abortAll, bufferedBytes: () => bufferBytes, inflight: () => active};
}
