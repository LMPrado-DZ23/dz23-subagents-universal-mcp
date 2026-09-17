import crypto from 'node:crypto';
import {ToolError} from './errors.js';
import {effectiveTier} from './targets.js';

const MAX_SCHEMA_DEPTH = 32;
const BRIEF_CHARS = 2000;
const STORE_LIMIT = 500;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/** Validates the JSON Schema subset documented for output_schema: type, required, properties, items, enum. */
export function validateOutputSchema(value, schema, at = '$', depth = 0) {
  if (depth > MAX_SCHEMA_DEPTH) return `${at} exceeds the maximum schema depth`;
  if (!schema || typeof schema !== 'object') return null;
  const type = schema.type;
  if (type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return `${at} must be object`;
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) return `${at}.${key} is required`;
    for (const [key, child] of Object.entries(schema.properties || {})) {
      if (!Object.hasOwn(value, key)) continue;
      const error = validateOutputSchema(value[key], child, `${at}.${key}`, depth + 1);
      if (error) return error;
    }
  } else if (type === 'array') {
    if (!Array.isArray(value)) return `${at} must be array`;
    for (let i = 0; i < value.length; i++) {
      const error = validateOutputSchema(value[i], schema.items, `${at}[${i}]`, depth + 1);
      if (error) return error;
    }
  } else if (type === 'string' && typeof value !== 'string') return `${at} must be string`;
  else if (type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) return `${at} must be number`;
  else if (type === 'integer' && !Number.isInteger(value)) return `${at} must be integer`;
  else if (type === 'boolean' && typeof value !== 'boolean') return `${at} must be boolean`;
  if (Array.isArray(schema.enum) && !schema.enum.some(item => Object.is(item, value))) return `${at} is not an allowed value`;
  return null;
}

/** Parses model output as JSON (a single fenced block is accepted) and validates it. Throws response_invalid. */
export function parseStructured(content, schema) {
  const text = String(content ?? '').trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(text);
  let parsed;
  try { parsed = JSON.parse(fenced ? fenced[1] : text); } catch { throw new ToolError('response_invalid', 'Provider did not return valid JSON for output_schema'); }
  const error = validateOutputSchema(parsed, schema);
  if (error) throw new ToolError('response_invalid', 'Provider output did not match output_schema', {path: error});
  return parsed;
}

/** Structured output for one answer without failing the whole multi-model call. */
export function structuredField(content, schema) {
  try { return {structured_output: parseStructured(content, schema)}; } catch (error) { return {schema_error: error.details?.path || error.message}; }
}

/** brief caps text at 2000 characters; normal and full keep the 4.0.0 behavior (no cap) unless max_response_chars is set. */
export function limitText(text, {detail = 'normal', max_response_chars} = {}) {
  const limit = max_response_chars || (detail === 'brief' ? BRIEF_CHARS : null);
  const value = String(text ?? '');
  return limit && value.length > limit ? {text: value.slice(0, limit), truncated: true} : {text: value, truncated: false};
}

export function limitResult(result, options) {
  if (typeof result?.content !== 'string') return result;
  const {text, truncated} = limitText(result.content, options);
  return truncated ? {...result, content: text, truncated: true, content_chars: result.content.length} : result;
}

const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

class BoundedStore {
  constructor(limit = STORE_LIMIT) { this.limit = limit; this.map = new Map(); }
  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expires_at <= Date.now()) { this.map.delete(key); return undefined; }
    return entry;
  }
  set(key, entry) {
    this.map.delete(key);
    this.map.set(key, entry);
    while (this.map.size > this.limit) this.map.delete(this.map.keys().next().value);
  }
  delete(key) { this.map.delete(key); }
}

const idempotency = new BoundedStore();
const responses = new BoundedStore();

/**
 * Same caller + tool + key + arguments: the first result is returned (an in-flight call is awaited, not repeated).
 * The same key with different arguments is a conflict, never someone else's result.
 */
export async function withIdempotency({tool, identity, key, args}, run) {
  if (!key) return run();
  const slot = digest({identity: identity || 'local', tool, key});
  const fingerprint = digest(args);
  const existing = idempotency.get(slot);
  if (existing) {
    if (existing.fingerprint !== fingerprint) throw new ToolError('idempotency_conflict', 'idempotency_key was already used with different arguments');
    return existing.promise;
  }
  const promise = run();
  idempotency.set(slot, {fingerprint, promise, expires_at: Date.now() + IDEMPOTENCY_TTL_MS});
  promise.catch(() => idempotency.delete(slot));
  return promise;
}

export const cacheKey = (identity, input) => digest({identity: identity || 'local', prompt: input.prompt, role: input.role, target: input.target,
  project_id: input.project_id, output_schema: input.output_schema || null, privacy: input.privacy || 'auto'});
export const cacheGet = key => responses.get(key)?.value;
export const cacheSet = (key, value, ttlMs) => responses.set(key, {value, expires_at: Date.now() + ttlMs});

/** A view of the router that only routes to local, private-endpoint targets (privacy=local_only). */
export function localOnlyRouter(router) {
  const isLocal = target => effectiveTier(target) === 'local';
  const scoped = Object.create(router);
  scoped.targets = () => router.targets().filter(isLocal);
  scoped.availableTargets = () => router.availableTargets().filter(isLocal);
  scoped.resolvePreferred = target => {
    const preferred = router.resolvePreferred.call(scoped, target);
    if (preferred.some(t => !isLocal(t))) throw new ToolError('no_local_target', 'privacy=local_only allows only local targets', {target});
    return preferred;
  };
  if (!scoped.targets().length) throw new ToolError('no_local_target', 'privacy=local_only requires a local target in DZ23_ROTATION');
  return scoped;
}
