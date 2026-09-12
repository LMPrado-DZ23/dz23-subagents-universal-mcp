import test from 'node:test';
import assert from 'node:assert/strict';
import {forbiddenPath,secretDetected} from '../scripts/release-check.mjs';
test('publication guard excludes private configuration, state and archive copies',()=>{
  for(const name of ['.env','.env.local','state/journal.jsonl','config/generated/host.json','secrets/key','old.zip','key.pem'])assert.equal(forbiddenPath(name),true);
  for(const name of ['.env.example','src/core.js','docs/ARCHITECTURE.md'])assert.equal(forbiddenPath(name),false);
});
test('secret pattern guard detects synthetic credentials without printing their values',()=>{
  assert.equal(secretDetected('sk-'+'x'.repeat(40)),true);
  assert.equal(secretDetected('hf_'+'y'.repeat(30)),true);
  assert.equal(secretDetected('OPENAI_API_KEY=\n'),false);
});
