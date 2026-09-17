// Heuristic masking for text that leaves the machine. Secrets are always masked; personal data is
// masked only when its check digits are valid, so numbers in source code (ports, timestamps, ids)
// are not corrupted.

const SECRET_PATTERNS = [
  /\b(?:sk|pk|rk)-(?:ant-|proj-|or-v1-|live-|test-)?[A-Za-z0-9_-]{20,}/g,
  /\b(?:gsk|xai|hf|nvapi|glpat|ghp|gho|ghu|ghs|ghr|github_pat|xox[abprs])[_-][A-Za-z0-9_-]{16,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  // Environment-style assignments (UPPER_CASE names) and quoted credential fields in JSON/YAML/code.
  /\b([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*\s*[=:]\s*)["']?[^\s"']{8,}/g,
  /(["']?(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|secret|password)["']?\s*[:=]\s*)["'][^"'\s]{8,}["']/gi
];

const digits = value => value.replace(/\D/g, '');

function validCpf(value) {
  const d = digits(value);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  for (const size of [9, 10]) {
    let sum = 0;
    for (let i = 0; i < size; i++) sum += Number(d[i]) * (size + 1 - i);
    if (((sum * 10) % 11) % 10 !== Number(d[size])) return false;
  }
  return true;
}

function validCnpj(value) {
  const d = digits(value);
  if (d.length !== 14 || /^(\d)\1{13}$/.test(d)) return false;
  for (const size of [12, 13]) {
    let sum = 0;
    let weight = size - 7;
    for (let i = 0; i < size; i++) { sum += Number(d[i]) * weight--; if (weight < 2) weight = 9; }
    if ((sum % 11 < 2 ? 0 : 11 - (sum % 11)) !== Number(d[size])) return false;
  }
  return true;
}

function validLuhn(value) {
  const d = digits(value);
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
  }
  return sum % 10 === 0;
}

const PII = [
  {name: 'cpf', re: /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b|\b\d{11}\b/g, valid: validCpf},
  {name: 'cnpj', re: /\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b|\b\d{14}\b/g, valid: validCnpj},
  // Bare 13-digit numbers are usually millisecond timestamps: only grouped or 16-digit card numbers.
  {name: 'card', re: /\b\d{4}(?:[ -]\d{4}){2}[ -]\d{1,7}\b|\b\d{16}\b/g, valid: validLuhn},
  {name: 'email', re: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, valid: () => true},
  // Brazilian phones only when written as phones: (11) 98765-4321, +55 11 98765-4321, 11 98765-4321.
  {name: 'phone', re: /(?:\+55\s?)?\(\d{2}\)\s?9?\d{4}-?\d{4}\b|\+55\s?\d{2}\s?9?\d{4}-?\d{4}\b|\b\d{2}\s9\d{4}-\d{4}\b/g, valid: () => true}
];

const INJECTION = /ignore\s+(?:all\s+|any\s+)?(?:previous|prior|above)\s+(?:instructions|prompts?)|disregard\s+(?:the\s+)?(?:previous|above)|system\s+prompt|developer\s+(?:message|instruction)|reveal\s+(?:the|your)\s+(?:secret|system\s+prompt|prompt)|you\s+are\s+now\s+(?:dan|in\s+developer\s+mode)|jailbreak/i;

export function maskSecrets(text) {
  let value = String(text ?? '');
  for (const re of SECRET_PATTERNS) value = value.replace(re, (match, prefix) => (typeof prefix === 'string' && prefix && match.startsWith(prefix) ? `${prefix}[SECRET_REDACTED]` : '[SECRET_REDACTED]'));
  return value;
}

/** Secrets always; personal data (valid CPF/CNPJ/card, email, formatted phone) when requested. */
export function maskSensitive(text, {pii = true} = {}) {
  let value = maskSecrets(text);
  const categories = new Set();
  if (pii) {
    for (const item of PII) {
      value = value.replace(item.re, match => {
        if (!item.valid(match)) return match;
        categories.add(item.name);
        return `[${item.name.toUpperCase()}_REDACTED]`;
      });
    }
  }
  return {text: value, categories: [...categories]};
}

export function detectPromptInjection(text) { return INJECTION.test(String(text ?? '')); }
