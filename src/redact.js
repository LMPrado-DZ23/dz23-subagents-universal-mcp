/**
 * Heuristic secret detection and structured redaction for logs and release checks.
 * Not a complete DLP filter: it complements, never replaces, keeping secrets out of inputs.
 */
const SECRET_PATTERN_SOURCES = [
  'sk-(?:proj-|ant-api\\d+-|or-v\\d+-)?[A-Za-z0-9_-]{24,}',
  '(?:gh[pousr]_|github_pat_|hf_|gsk_|nvapi-|xai-|cfat_)[A-Za-z0-9_-]{20,}',
  '-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
  'AKIA[A-Z0-9]{16}',
  'AIza[A-Za-z0-9_-]{30,}'
];
const BEARER_SOURCE = 'Bearer\\s+[\\x21-\\x7e]{8,}';
const SENSITIVE_KEYS = /^(?:api[_-]?key|apikey|x-api-key|authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|client[_-]?secret|token|access[_-]?token|refresh[_-]?token|prompt|messages|content|body|raw|headers|goal|assignment|output|last_output|context)$/i;
const MAX_STRING = 500;
const MAX_DEPTH = 6;
const MAX_ARRAY = 50;

export function secretDetected(text) {
  return SECRET_PATTERN_SOURCES.some(source => new RegExp(source).test(text));
}

export function isSensitiveKey(key) {
  return SENSITIVE_KEYS.test(key);
}

export function redactString(text, secrets = []) {
  let out = text;
  for (const secret of secrets) if (secret && out.includes(secret)) out = out.split(secret).join('[REDACTED]');
  for (const source of [...SECRET_PATTERN_SOURCES, BEARER_SOURCE]) out = out.replace(new RegExp(source, 'g'), '[REDACTED]');
  return out.length > MAX_STRING ? `${out.slice(0, MAX_STRING)}...[truncated]` : out;
}

/** Deep copy with sensitive keys removed, known secrets and secret-like strings masked. */
export function redact(value, secrets = [], depth = 0) {
  if (typeof value === 'string') return redactString(value, secrets);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[depth-limit]';
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY).map(item => redact(item, secrets, depth + 1));
  if (value instanceof Error) return {name: value.name};
  const out = {};
  for (const [key, child] of Object.entries(value)) out[key] = isSensitiveKey(key) ? '[REDACTED]' : redact(child, secrets, depth + 1);
  return out;
}
