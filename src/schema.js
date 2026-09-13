/**
 * Minimal JSON Schema subset validator (no runtime dependencies).
 * Unsupported keywords are rejected when a schema is registered, so a keyword can
 * never be published in tools/list while silently not being enforced.
 */
const SUPPORTED_KEYWORDS = new Set([
  'type', 'enum', 'const', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern',
  'items', 'minItems', 'maxItems', 'uniqueItems', 'properties', 'required',
  'additionalProperties', 'default', 'description', 'title', '$comment', 'examples'
]);
const TYPE_WORDS = {string: 'a string', integer: 'an integer', number: 'a number', boolean: 'a boolean', object: 'an object', array: 'an array', null: 'null'};
const patternCache = new Map();

export class ValidationError extends Error {
  constructor(field, reason) {
    super(`${field || 'arguments'} ${reason}`);
    this.name = 'ValidationError';
    this.field = field || 'arguments';
    this.reason = reason;
  }
}

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function compiled(pattern) {
  if (!patternCache.has(pattern)) patternCache.set(pattern, new RegExp(pattern, 'u'));
  return patternCache.get(pattern);
}

export function assertSupportedSchema(schema, at = '#') {
  if (!isPlainObject(schema)) throw new Error(`Schema at ${at} must be an object`);
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(key) && !key.startsWith('x-')) throw new Error(`Unsupported schema keyword "${key}" at ${at}`);
  }
  const types = schema.type === undefined ? [] : [].concat(schema.type);
  for (const type of types) if (!TYPE_WORDS[type]) throw new Error(`Unsupported schema type "${type}" at ${at}`);
  if (schema.pattern !== undefined) compiled(schema.pattern);
  for (const [name, child] of Object.entries(schema.properties || {})) assertSupportedSchema(child, `${at}/properties/${name}`);
  if (schema.items !== undefined) assertSupportedSchema(schema.items, `${at}/items`);
  if (isPlainObject(schema.additionalProperties)) assertSupportedSchema(schema.additionalProperties, `${at}/additionalProperties`);
  if (schema.default !== undefined) validate({...schema, default: undefined}, schema.default, `${at}(default)`);
  return schema;
}

function matchesType(type, value) {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'integer': return Number.isInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'object': return isPlainObject(value);
    case 'array': return Array.isArray(value);
    case 'null': return value === null;
    default: return false;
  }
}

function sameValue(a, b) {
  if (a === b) return true;
  return typeof a === 'object' && typeof b === 'object' && JSON.stringify(a) === JSON.stringify(b);
}

function codePointLength(text) {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

// Property names come from the caller; echo only a bounded, printable form.
function safeKey(key) {
  return String(key).slice(0, 64).replace(/[^A-Za-z0-9_.-]/g, '?');
}

function join(field, key) {
  return field ? `${field}.${safeKey(key)}` : safeKey(key);
}

function fail(field, reason) {
  throw new ValidationError(field, reason);
}

function checkString(schema, value, field) {
  if (schema.maxLength !== undefined && value.length > schema.maxLength && codePointLength(value) > schema.maxLength) {
    fail(field, `must be at most ${schema.maxLength} characters`);
  }
  if (schema.minLength !== undefined && (value.length < schema.minLength || codePointLength(value) < schema.minLength)) {
    fail(field, schema.minLength === 1 ? 'must not be empty' : `must be at least ${schema.minLength} characters`);
  }
  if (schema.pattern !== undefined && !compiled(schema.pattern).test(value)) {
    fail(field, schema['x-pattern-reason'] || 'has an invalid format');
  }
  return value;
}

function checkNumber(schema, value, field) {
  if (schema.minimum !== undefined && value < schema.minimum) fail(field, `must be >= ${schema.minimum}`);
  if (schema.maximum !== undefined && value > schema.maximum) fail(field, `must be <= ${schema.maximum}`);
  return value;
}

function checkArray(schema, value, field) {
  if (schema.maxItems !== undefined && value.length > schema.maxItems) fail(field, `must contain at most ${schema.maxItems} items`);
  if (schema.minItems !== undefined && value.length < schema.minItems) fail(field, `must contain at least ${schema.minItems} items`);
  const out = value.map((item, index) => schema.items ? validate(schema.items, item, `${field}[${index}]`) : item);
  if (schema.uniqueItems) {
    const seen = new Set();
    for (const item of out) {
      const key = JSON.stringify(item);
      if (seen.has(key)) fail(field, 'must not contain duplicate items');
      seen.add(key);
    }
  }
  return out;
}

function checkObject(schema, value, field) {
  const properties = schema.properties || {};
  for (const name of schema.required || []) {
    if (!Object.hasOwn(value, name) || value[name] === undefined) fail(join(field, name), 'is required');
  }
  const out = {};
  for (const key of Object.keys(value)) {
    if (Object.hasOwn(properties, key)) continue;
    if (schema.additionalProperties === false) fail(join(field, key), 'is not allowed');
    const child = isPlainObject(schema.additionalProperties) ? validate(schema.additionalProperties, value[key], join(field, key)) : value[key];
    Object.defineProperty(out, key, {value: child, enumerable: true, writable: true, configurable: true});
  }
  for (const [key, child] of Object.entries(properties)) {
    const result = validate(child, Object.hasOwn(value, key) ? value[key] : undefined, join(field, key));
    if (result !== undefined) Object.defineProperty(out, key, {value: result, enumerable: true, writable: true, configurable: true});
  }
  return out;
}

/** Returns a new value with defaults applied, or throws ValidationError. */
export function validate(schema, value, field = '') {
  if (value === undefined) return schema.default === undefined ? undefined : structuredClone(schema.default);
  if (schema.type !== undefined) {
    const types = [].concat(schema.type);
    if (!types.some(type => matchesType(type, value))) fail(field, `must be ${types.map(type => TYPE_WORDS[type]).join(' or ')}`);
  }
  if (schema.const !== undefined && !sameValue(schema.const, value)) fail(field, `must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.some(option => sameValue(option, value))) fail(field, `must be one of: ${schema.enum.join(', ')}`);
  if (typeof value === 'string') return checkString(schema, value, field);
  if (typeof value === 'number') return checkNumber(schema, value, field);
  if (Array.isArray(value)) return checkArray(schema, value, field);
  if (isPlainObject(value)) return checkObject(schema, value, field);
  return value;
}
