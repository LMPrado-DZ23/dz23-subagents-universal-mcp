const SECRET = /(?:sk-|gsk_|xai-|hf_|AIza|AIza|nvapi-|gh[pousr]_|github_pat_)[A-Za-z0-9_\-]{12,}/g;
const PII = [
  {name:'cpf', re:/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g},
  {name:'cnpj', re:/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g},
  {name:'email', re:/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi},
  {name:'phone', re:/(?:\+?55\s?)?(?:\(?\d{2}\)?\s?)?9?\d{4}[-\s]?\d{4}\b/g},
  {name:'card', re:/\b(?:\d[ -]*?){13,19}\b/g}
];
const INJECTION = /ignore\s+(?:all|any|previous)|system\s+message|developer\s+instruction|reveal\s+(?:the|your)\s+(?:secret|prompt)|jailbreak/i;

export function maskSensitive(text) {
  let value = String(text ?? '').replace(SECRET, '[SECRET_REDACTED]');
  const matches = [];
  for (const item of PII) { if (item.re.test(value)) matches.push(item.name); item.re.lastIndex = 0; value = value.replace(item.re, `[${item.name.toUpperCase()}_REDACTED]`); }
  return {text:value, categories:[...new Set(matches)]};
}
export function detectPromptInjection(text) { return INJECTION.test(String(text ?? '')); }
