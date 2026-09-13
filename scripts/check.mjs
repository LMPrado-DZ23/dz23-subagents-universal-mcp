#!/usr/bin/env node
/** Syntax check plus a small dependency-free lint for rules this project relies on. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
export const MAX_SOURCE_LINES = 500;

function walk(dir) {
  return fs.readdirSync(dir, {withFileTypes: true}).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(file) : /\.m?js$/.test(entry.name) ? [file] : [];
  });
}

/** Returns human-readable problems for one file. `runtime` marks files under src/. */
export function lintSource(name, text, {runtime = false} = {}) {
  const problems = [];
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    const at = `${name}:${index + 1}`;
    if (/[ \t]+\r?$/.test(line)) problems.push(`${at} trailing whitespace`);
    if (line.includes('\t')) problems.push(`${at} tab character`);
    if (runtime) {
      if (/\beval\s*\(|\bnew\s+Function\s*\(/.test(line)) problems.push(`${at} dynamic code evaluation`);
      if (/\bconsole\.log\s*\(/.test(line)) problems.push(`${at} console.log in runtime code (stdout is reserved for MCP stdio)`);
      if (/\b(?:TODO|FIXME|XXX)\b/.test(line)) problems.push(`${at} unresolved marker`);
    }
  });
  if (runtime && lines.length > MAX_SOURCE_LINES) problems.push(`${name} has ${lines.length} lines (max ${MAX_SOURCE_LINES})`);
  return problems;
}

function main() {
  let count = 0;
  const problems = [];
  for (const folder of ['src', 'scripts', 'test']) {
    for (const file of walk(path.join(root, folder))) {
      const result = spawnSync(process.execPath, ['--check', file], {stdio: 'inherit'});
      if (result.error || result.status !== 0) process.exit(1);
      const name = path.relative(root, file).split(path.sep).join('/');
      problems.push(...lintSource(name, fs.readFileSync(file, 'utf8'), {runtime: folder === 'src'}));
      count++;
    }
  }
  if (problems.length) {
    for (const problem of problems) console.error(`LINT ${problem}`);
    console.error(`Lint failed with ${problems.length} problem(s).`);
    process.exit(1);
  }
  console.log(`Syntax checked: ${count} JavaScript files. Lint: 0 problems.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
