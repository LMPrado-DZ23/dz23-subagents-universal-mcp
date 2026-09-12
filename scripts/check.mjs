#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url));
function walk(dir) {
  return fs.readdirSync(dir, {withFileTypes:true}).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(file) : /\.m?js$/.test(entry.name) ? [file] : [];
  });
}
let count = 0;
for (const folder of ['src','scripts','test']) for (const file of walk(path.join(root, folder))) {
  const result = spawnSync(process.execPath, ['--check', file], {stdio:'inherit'});
  if (result.error || result.status !== 0) process.exit(1);
  count++;
}
console.log(`Syntax checked: ${count} JavaScript files.`);
