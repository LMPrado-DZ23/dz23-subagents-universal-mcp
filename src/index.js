#!/usr/bin/env node
import {loadDotEnv} from './env.js';

const CLI_ENTRIES = new Set(['doctor', 'config', 'providers', 'health', 'missions', 'memory', 'token', 'help', 'version', '--help', '-h', '--version']);
const argv = process.argv.slice(2);

// Resolve relative to the installed package, never the host's working directory.
loadDotEnv();

if (argv.length && CLI_ENTRIES.has(argv[0])) {
  const {runCli} = await import('./cli.js');
  process.exitCode = await runCli(argv);
} else {
  const {serve} = await import('./server.js');
  await serve(argv);
}
