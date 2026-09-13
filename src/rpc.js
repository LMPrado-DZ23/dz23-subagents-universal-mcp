import crypto from 'node:crypto';
import {RPC_ERRORS} from './constants.js';
import {isPlainObject} from './schema.js';
import {RpcError, RateLimitError, ForbiddenError, ServerBusyError} from './errors.js';

export const PARSE_FAILURE = Symbol('parse_failure');
const REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

export function newRequestId() {
  return crypto.randomUUID();
}

/** Accept a caller-supplied correlation id only when it is short and printable. */
export function acceptRequestId(candidate) {
  return typeof candidate === 'string' && REQUEST_ID.test(candidate) ? candidate : newRequestId();
}

export function parseJson(text) {
  try { return JSON.parse(text); } catch { return PARSE_FAILURE; }
}

function validId(id) {
  return typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));
}

function errorResponse(id, code, message, data) {
  return {jsonrpc: '2.0', id, error: {code, message, ...(data !== undefined ? {data} : {})}};
}

function withRequestId(data, requestId) {
  if (!requestId) return data;
  return isPlainObject(data) ? {...data, request_id: requestId} : {request_id: requestId};
}

/**
 * Converts one decoded JSON-RPC message into {status, response}. `response` is null for
 * notifications. `status` is the HTTP status to use; stdio ignores it.
 */
export function createRpcProcessor(handler, {logger} = {}) {
  return async function processMessage(message, ctx = {}) {
    const requestId = ctx.requestId;
    if (message === PARSE_FAILURE) {
      return {status: 400, response: errorResponse(null, RPC_ERRORS.PARSE_ERROR, 'Parse error', withRequestId(undefined, requestId))};
    }
    if (!isPlainObject(message)) {
      const reason = Array.isArray(message) ? 'batch requests are not supported' : 'request must be a JSON object';
      return {status: 400, response: errorResponse(null, RPC_ERRORS.INVALID_REQUEST, 'Invalid Request', withRequestId({reason}, requestId))};
    }
    const hasId = Object.hasOwn(message, 'id');
    if (hasId && !validId(message.id)) {
      return {status: 400, response: errorResponse(null, RPC_ERRORS.INVALID_REQUEST, 'Invalid Request', withRequestId({reason: 'id must be a string or number'}, requestId))};
    }
    const id = hasId ? message.id : null;
    if (message.jsonrpc !== '2.0' || typeof message.method !== 'string' || !message.method) {
      return {status: 400, response: errorResponse(id, RPC_ERRORS.INVALID_REQUEST, 'Invalid Request', withRequestId({reason: 'jsonrpc must be "2.0" and method a non-empty string'}, requestId))};
    }
    if (!hasId) {
      // Notifications never produce a JSON-RPC response and never execute tools.
      if (!message.method.startsWith('notifications/')) {
        logger?.warn('rpc_notification_rejected', {request_id: requestId, method: message.method.slice(0, 64)});
        return {status: 400, response: null, rejected: 'invalid_notification'};
      }
      try { await handler(message, ctx); } catch (error) { logger?.warn('rpc_notification_failed', {request_id: requestId, error_name: error.name}); }
      return {status: 202, response: null};
    }
    if (Object.hasOwn(message, 'params') && !isPlainObject(message.params)) {
      return {status: 200, response: errorResponse(id, RPC_ERRORS.INVALID_PARAMS, 'Invalid params', withRequestId({field: 'params', reason: 'must be an object'}, requestId))};
    }
    try {
      return {status: 200, response: {jsonrpc: '2.0', id, result: await handler(message, ctx)}};
    } catch (error) {
      if (error instanceof RpcError) {
        return {status: 200, response: errorResponse(id, error.code, error.message, withRequestId(error.data, requestId))};
      }
      if (error instanceof RateLimitError) {
        return {status: 429, retryAfterMs: error.retryAfterMs, response: errorResponse(id, RPC_ERRORS.RATE_LIMITED, 'Rate limit exceeded',
          withRequestId({retry_after_ms: error.retryAfterMs, limit: error.limit}, requestId))};
      }
      if (error instanceof ForbiddenError) {
        return {status: 403, response: errorResponse(id, RPC_ERRORS.FORBIDDEN, 'Forbidden', withRequestId({required_scopes: error.requiredScopes}, requestId))};
      }
      if (error instanceof ServerBusyError) {
        return {status: 503, retryAfterMs: 1000, response: errorResponse(id, RPC_ERRORS.SERVER_BUSY, 'Server busy', withRequestId({reason: error.reason}, requestId))};
      }
      logger?.error('rpc_internal_error', {request_id: requestId, method: message.method.slice(0, 64), error_name: error?.name || 'Error'});
      return {status: 200, response: errorResponse(id, RPC_ERRORS.INTERNAL_ERROR, 'Internal error', withRequestId(undefined, requestId))};
    }
  };
}
