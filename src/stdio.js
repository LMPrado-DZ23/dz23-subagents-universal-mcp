import {RPC_ERRORS} from './constants.js';
import {parseJson, newRequestId} from './rpc.js';

/**
 * Newline-delimited JSON-RPC over stdio. Messages are processed in arrival order.
 * Only protocol messages are written to stdout; diagnostics go to the logger (stderr).
 */
export function startStdio({processMessage, maxFrameBytes, logger, input = process.stdin, output = process.stdout}) {
  const session = {protocolVersion: null};
  let buffer = '';
  let discarding = false;
  let chain = Promise.resolve();

  const write = message => output.write(`${JSON.stringify(message)}\n`);
  const oversized = () => {
    logger?.warn('stdio_frame_rejected', {reason: 'frame_too_large', max_bytes: maxFrameBytes});
    write({jsonrpc: '2.0', id: null, error: {code: RPC_ERRORS.INVALID_REQUEST, message: 'Invalid Request', data: {reason: 'frame too large'}}});
  };
  const handleLine = async line => {
    const ctx = {transport: 'stdio', session, requestId: newRequestId(), identity: 'stdio'};
    const {response} = await processMessage(parseJson(line), ctx);
    if (response) write(response);
  };
  const enqueue = line => { chain = chain.then(() => handleLine(line)).catch(error => logger?.error('stdio_handler_failed', {error_name: error?.name})); };

  input.setEncoding('utf8');
  input.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (discarding) { discarding = false; continue; }
      if (!line) continue;
      if (Buffer.byteLength(line) > maxFrameBytes) { oversized(); continue; }
      enqueue(line);
    }
    if (!discarding && Buffer.byteLength(buffer) > maxFrameBytes) {
      buffer = '';
      discarding = true;
      oversized();
    }
  });
  const finished = new Promise(resolve => input.on('end', () => chain.then(resolve)));
  return {session, finished, idle: () => chain};
}
