#!/usr/bin/env node
import {loadDotEnv} from './env.js';

const SERVER_FLAGS = new Set(['--stdio', '--http']);
const argv = process.argv.slice(2);

// Resolve relative to the installed package, never the host's working directory.
loadDotEnv();

// Only no arguments or transport flags start a server. Anything else is a CLI invocation,
// so a typo fails with a usage error instead of silently starting the stdio server.
if (argv.every(arg => SERVER_FLAGS.has(arg))) {
  const {serve} = await import('./server.js');
  await serve(argv);
} else {
  const {runCli} = await import('./cli.js');
  process.exitCode = await runCli(argv);
}
