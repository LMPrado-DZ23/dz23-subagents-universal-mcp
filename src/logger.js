import {LOG_LEVELS} from './constants.js';
import {redact} from './redact.js';

const MIN_SECRET_LENGTH = 8;

/**
 * JSON Lines logger. Defaults to stderr so stdio MCP output stays protocol-only.
 * Every entry passes through redaction; callers should still avoid passing prompts or outputs.
 */
export function createLogger({level = 'info', sink = line => process.stderr.write(`${line}\n`), secrets = new Set(), base = {}, now = () => new Date().toISOString()} = {}) {
  const threshold = LOG_LEVELS[level] ?? LOG_LEVELS.info;
  const secretSet = secrets instanceof Set ? secrets : new Set(secrets);

  function emit(entryLevel, event, fields = {}) {
    if (LOG_LEVELS[entryLevel] > threshold) return;
    const safe = redact({...base, ...fields}, [...secretSet]);
    try { sink(JSON.stringify({ts: now(), level: entryLevel, event, ...safe})); } catch { /* logging must never break a request */ }
  }

  return {
    level,
    error: (event, fields) => emit('error', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    info: (event, fields) => emit('info', event, fields),
    debug: (event, fields) => emit('debug', event, fields),
    child: fields => createLogger({level, sink, secrets: secretSet, base: {...base, ...fields}, now}),
    /** Register literal secret values (API keys, tokens) to mask wherever they appear. */
    addSecrets: values => { for (const value of values) if (typeof value === 'string' && value.length >= MIN_SECRET_LENGTH && value !== 'local') secretSet.add(value); }
  };
}

export const nullLogger = Object.freeze({
  level: 'silent', error() {}, warn() {}, info() {}, debug() {}, child() { return nullLogger; }, addSecrets() {}
});
