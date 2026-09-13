#!/usr/bin/env node
/** Container healthcheck: authenticated GET /healthz on loopback. Never prints the token. */
import fs from 'node:fs';

const port = process.env.DZ23_HTTP_PORT || '8787';
let token = process.env.DZ23_MCP_TOKEN || '';
if (!token && process.env.DZ23_MCP_TOKEN_FILE) {
  try {
    token = fs.readFileSync(process.env.DZ23_MCP_TOKEN_FILE, 'utf8').replace(/\s+$/u, '');
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
