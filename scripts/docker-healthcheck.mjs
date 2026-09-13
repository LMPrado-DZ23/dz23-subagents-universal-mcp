#!/usr/bin/env node
/** Container healthcheck: authenticated GET /healthz on loopback. Never prints the token. */
import fs from 'node:fs';

const port = process.env.DZ23_HTTP_PORT || '8787';
// With scoped tokens only, point DZ23_HEALTHCHECK_TOKEN_FILE at any scoped token: /healthz needs no scope.
let token = process.env.DZ23_MCP_TOKEN || '';
const tokenFile = token ? '' : (process.env.DZ23_HEALTHCHECK_TOKEN_FILE || process.env.DZ23_MCP_TOKEN_FILE || '');
if (tokenFile) {
  try {
    token = fs.readFileSync(tokenFile, 'utf8').replace(/\s+$/u, '');
  } catch {
    process.exit(1);
  }
}
try {
  const response = await fetch(`http://127.0.0.1:${port}/healthz`, {headers: token ? {authorization: `Bearer ${token}`} : {}, signal: AbortSignal.timeout(4000)});
  process.exit(response.ok ? 0 : 1);
} catch {
  process.exit(1);
}
