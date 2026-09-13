import {RPC_ERRORS} from './constants.js';
import {parseJson, newRequestId} from './rpc.js';

/**
 * Newline-delimited JSON-RPC over stdio. Messages are processed in arrival order.
 * Only protocol messages are written to stdout; diagnostics go to the logger (stderr).
 * A frame larger than maxFrameBytes is reported once and dropped up to its newline without
 * being buffered, so memory stays bounded by maxFrameBytes plus one chunk.
 */
export function startStdio({processMessage, maxFrameBytes, logger, input = process.stdin, output = process.stdout}) {
  const session = {protocolVersion: null};
  let buffer = '';
  let bufferBytes = 0;
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
  const finished = new Promise(resolve => input.on('end', () => chain.then(resolve)));
  return {session, finished, idle: () => chain, bufferedBytes: () => bufferBytes};
}
