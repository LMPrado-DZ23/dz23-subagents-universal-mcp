import fs from 'node:fs';
import crypto from 'node:crypto';
import {SCOPES, AUTH_MODES} from './constants.js';
import {ConfigError} from './errors.js';

const TOKEN_CHARS = /^[\x21-\x7e]+$/;
const TOKEN_ID = /^[A-Za-z0-9._-]{1,64}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
export const ALL_SCOPES = Object.freeze(new Set(SCOPES));

export function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Read a secret file, removing only trailing whitespace/newlines. */
export function readSecretFile(file, label) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { throw new ConfigError(`Cannot read ${label}`); }
  const value = raw.replace(/\s+$/u, '');
  if (!value) throw new ConfigError(`${label} is empty`);
  return value;
}

export function permissionWarning(file, label) {
  if (process.platform === 'win32') return null;
  try {
    if (fs.statSync(file).mode & 0o077) return `${label} is accessible by group or other users; restrict it with chmod 600`;
  } catch { return null; }
  return null;
}

/**
 * HTTP bearer token from DZ23_MCP_TOKEN or DZ23_MCP_TOKEN_FILE.
 * Setting both is refused, so rotating the file can never be silently shadowed.
 */
export function loadMcpToken(env = process.env) {
  const direct = env.DZ23_MCP_TOKEN || '';
  const file = env.DZ23_MCP_TOKEN_FILE || '';
  if (direct && file) throw new ConfigError('Set only one of DZ23_MCP_TOKEN or DZ23_MCP_TOKEN_FILE');
  const warnings = [];
  let token = direct;
  let source = direct ? 'env:DZ23_MCP_TOKEN' : 'none';
  if (file) {
    token = readSecretFile(file, 'DZ23_MCP_TOKEN_FILE');
    source = 'file:DZ23_MCP_TOKEN_FILE';
    const warning = permissionWarning(file, 'DZ23_MCP_TOKEN_FILE');
    if (warning) warnings.push(warning);
  }
  if (token && !TOKEN_CHARS.test(token)) throw new ConfigError('The HTTP token must contain printable ASCII characters without spaces');
  return {token, source, warnings};
}

/**
 * Scoped tokens: a JSON file listing SHA-256 digests (never plaintext tokens).
 * {"tokens":[{"id":"ci-reader","sha256":"<64 hex>","scopes":["memory:read"]}]}
 */
export function loadScopedTokens(env = process.env) {
  const mode = env.DZ23_AUTH_MODE || 'single-user';
  if (!AUTH_MODES.includes(mode)) throw new ConfigError(`DZ23_AUTH_MODE must be one of: ${AUTH_MODES.join(', ')}`);
  const file = env.DZ23_MCP_TOKENS_FILE || '';
  const warnings = [];
  if (mode === 'single-user') {
    if (file) warnings.push('DZ23_MCP_TOKENS_FILE is ignored unless DZ23_AUTH_MODE=scoped');
    return {mode, tokens: [], warnings};
  }
  if (!file) throw new ConfigError('DZ23_AUTH_MODE=scoped requires DZ23_MCP_TOKENS_FILE');
  let parsed;
  try { parsed = JSON.parse(readSecretFile(file, 'DZ23_MCP_TOKENS_FILE')); } catch (error) {
    throw error instanceof ConfigError ? error : new ConfigError('DZ23_MCP_TOKENS_FILE must contain valid JSON');
  }
  if (!Array.isArray(parsed?.tokens) || !parsed.tokens.length) throw new ConfigError('DZ23_MCP_TOKENS_FILE must define a non-empty "tokens" array');
  const ids = new Set();
  const digests = new Set();
  const tokens = parsed.tokens.map((entry, index) => {
    const where = `DZ23_MCP_TOKENS_FILE tokens[${index}]`;
    if (!TOKEN_ID.test(entry?.id || '')) throw new ConfigError(`${where}.id must use 1-64 letters, digits, dots, underscores or hyphens`);
    if (!SHA256_HEX.test(entry.sha256 || '')) throw new ConfigError(`${where}.sha256 must be 64 lowercase hex characters`);
    if (!Array.isArray(entry.scopes) || !entry.scopes.length || entry.scopes.some(scope => !SCOPES.includes(scope))) {
      throw new ConfigError(`${where}.scopes must be a non-empty subset of: ${SCOPES.join(', ')}`);
    }
    if (ids.has(entry.id) || digests.has(entry.sha256)) throw new ConfigError(`${where} duplicates another token id or digest`);
    ids.add(entry.id);
    digests.add(entry.sha256);
    return {id: entry.id, sha256: entry.sha256, scopes: [...new Set(entry.scopes)]};
  });
  const warning = permissionWarning(file, 'DZ23_MCP_TOKENS_FILE');
  if (warning) warnings.push(warning);
  return {mode, tokens, warnings};
}

/**
 * Resolves an Authorization header to {identity, scopes}. Digests are compared in
 * constant time and every entry is checked, so timing does not reveal which token matched.
 * `project_id` never participates in authentication.
 */
export function createAuthenticator({token = '', scopedTokens = []} = {}) {
  const primary = token ? Buffer.from(sha256Hex(token), 'hex') : null;
  const entries = scopedTokens.map(entry => ({...entry, digest: Buffer.from(entry.sha256, 'hex')}));
  const required = Boolean(primary) || entries.length > 0;
  return {
    required,
    authenticate(header, remoteAddress = 'unknown') {
      if (!required) return {identity: `ip:${remoteAddress}`, scopes: ALL_SCOPES, authenticated: false};
      const match = /^Bearer ([\x21-\x7e]{1,4096})$/.exec(header || '');
      if (!match) return null;
      const digest = Buffer.from(sha256Hex(match[1]), 'hex');
      let found = null;
      if (primary && crypto.timingSafeEqual(digest, primary)) found = {identity: 'token:primary', scopes: ALL_SCOPES, authenticated: true};
      for (const entry of entries) {
        if (crypto.timingSafeEqual(digest, entry.digest) && !found) found = {identity: `token:${entry.id}`, scopes: new Set(entry.scopes), authenticated: true};
      }
      return found;
    }
  };
}
