import fs from 'node:fs';

/**
 * Load KEY=VALUE pairs from the installation's .env (never the harness working
 * directory). Existing process variables always take precedence.
 */
export function loadDotEnv(file = new URL('../.env', import.meta.url), env = process.env) {
  if (!fs.existsSync(file)) return false;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1] in env) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    env[match[1]] = value;
  }
  return true;
}
