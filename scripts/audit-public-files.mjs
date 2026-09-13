#!/usr/bin/env node
/** Compare Git-tracked files with the audited PUBLIC_FILES.json allowlist. */
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {root, forbiddenPath} from './release-check.mjs';

export function auditPublicFiles(tracked, manifestPaths) {
  const listed = new Set(manifestPaths);
  const trackedSet = new Set(tracked);
  return {
    unlisted: tracked.filter(name => name !== 'PUBLIC_FILES.json' && !listed.has(name)).sort(),
    missing: manifestPaths.filter(name => !trackedSet.has(name)).sort(),
    forbidden: tracked.filter(name => forbiddenPath(name)).sort()
  };
}

function main() {
  const git = spawnSync('git', ['ls-files', '-z'], {cwd: root, encoding: 'utf8'});
  if (git.error || git.status !== 0) {
    console.error('BLOCKED_BY_EXTERNAL_DEPENDENCY: git ls-files is unavailable; run inside the Git checkout.');
    process.exit(1);
  }
  const tracked = git.stdout.split('\0').filter(Boolean);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'PUBLIC_FILES.json'), 'utf8'));
  const report = auditPublicFiles(tracked, manifest.files.map(entry => entry.path));
  const problems = [
    ...report.unlisted.map(name => `tracked but not in PUBLIC_FILES.json: ${name}`),
    ...report.missing.map(name => `listed but not tracked: ${name}`),
    ...report.forbidden.map(name => `forbidden path is tracked: ${name}`)
  ];
  if (problems.length) {
    for (const problem of problems) console.error(problem);
    process.exit(1);
  }
  console.log(`PUBLIC_FILES_AUDIT=PASS tracked=${tracked.length} listed=${manifest.files.length}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
