import test from 'node:test';
import assert from 'node:assert/strict';
import {lintSource, MAX_SOURCE_LINES} from '../scripts/check.mjs';
import {auditPublicFiles} from '../scripts/audit-public-files.mjs';

test('lint flags dynamic code, stdout logging, markers, whitespace and oversized runtime files', () => {
  const runtime = ['const a = eval("1");', 'console.log(a);', '// TODO later', 'const b = 1; ', '\tconst c = 2;'].join('\n');
  const problems = lintSource('src/x.js', runtime, {runtime: true});
  for (const expected of ['dynamic code evaluation', 'console.log in runtime code', 'unresolved marker', 'trailing whitespace', 'tab character']) {
    assert.ok(problems.some(problem => problem.includes(expected)), expected);
  }
  assert.deepEqual(lintSource('scripts/x.mjs', 'console.log("script output is fine");', {runtime: false}), []);
  assert.match(lintSource('src/big.js', 'x\n'.repeat(MAX_SOURCE_LINES + 1), {runtime: true}).at(-1), /max 500/);
});

test('public file audit detects unlisted, missing and forbidden tracked files', () => {
  const report = auditPublicFiles(['README.md', 'PUBLIC_FILES.json', 'src/new.js', '.env'], ['README.md', 'docs/gone.md']);
  assert.deepEqual(report, {unlisted: ['.env', 'src/new.js'], missing: ['docs/gone.md'], forbidden: ['.env']});
  assert.deepEqual(auditPublicFiles(['a.md', 'PUBLIC_FILES.json'], ['a.md']), {unlisted: [], missing: [], forbidden: []});
});
