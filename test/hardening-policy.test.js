import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {providerRegistry, parseTarget} from '../src/providers.js';
import {eligibleTargets, ineligibleReason, isEligible, targetReport} from '../src/targets.js';
import {config, expandHome} from '../src/config.js';

const env = extra => ({DZ23_STATE_DIR: os.tmpdir(), ...extra});

test('mixed-tier targets need DZ23_ALLOW_PAID, a :free model id or a DZ23_FREE_MODELS entry', () => {
  const registry = providerRegistry(env({OPENROUTER_API_KEY: 'k', MISTRAL_API_KEY: 'k', GROQ_API_KEY: 'k'}));
  const base = {rotation: [], allowPaid: false, freeModels: []};
  const auto = parseTarget('openrouter:openrouter/auto', registry);
  assert.equal(auto.tier, 'mixed');
  assert.equal(isEligible(auto, base), false);
  assert.equal(ineligibleReason(auto, base), 'mixed_not_allowed');
  assert.equal(isEligible(parseTarget('openrouter:vendor/model:free', registry), base), true);
  const mistral = parseTarget('mistral:mistral-small-latest', registry);
  assert.equal(isEligible(mistral, {...base, freeModels: ['mistral:mistral-small-latest']}), true);
  assert.equal(isEligible(mistral, {...base, allowPaid: true}), true);
  // Default rotation (no DZ23_ROTATION): only the free-tier default survives.
  assert.deepEqual(eligibleTargets(base, registry).map(target => target.name), ['groq']);
  const report = targetReport(base, registry);
  assert.deepEqual(report.find(entry => entry.target.startsWith('openrouter:')), {target: 'openrouter:openrouter/auto', tier: 'mixed', eligible: false, reason: 'mixed_not_allowed'});
});

test('low-cost and paid tiers stay blocked even when named in the rotation', () => {
  const registry = providerRegistry(env({DEEPSEEK_API_KEY: 'k', GROQ_API_KEY: 'k'}));
  const cfg = {rotation: ['groq:llama-3.3-70b-versatile', 'deepseek:deepseek-chat'], allowPaid: false, freeModels: ['deepseek:deepseek-chat']};
  assert.deepEqual(eligibleTargets(cfg, registry).map(target => target.name), ['groq']);
  assert.equal(ineligibleReason(parseTarget('deepseek:deepseek-chat', registry), cfg), 'paid_not_allowed');
});

test('generic tokens enable a provider only when the rotation names it or the operator opts in', () => {
  const plain = providerRegistry(env({GITHUB_TOKEN: 'repo-token', HF_TOKEN: 'hf'}));
  assert.equal(plain.github.enabled, false);
  assert.equal(plain.github.apiKey, '');
  assert.equal(plain.github.ignoredCredentialSource, 'env:GITHUB_TOKEN');
  assert.equal(plain.huggingface.enabled, false);
  const rotation = providerRegistry(env({GITHUB_TOKEN: 'repo-token', DZ23_ROTATION: 'github:gpt-4o-mini'}));
  assert.equal(rotation.github.enabled, true);
  assert.equal(rotation.github.credentialSource, 'env:GITHUB_TOKEN');
  const optIn = providerRegistry(env({HF_TOKEN: 'hf', DZ23_ALLOW_GENERIC_CREDENTIALS: 'true'}));
  assert.equal(optIn.huggingface.enabled, true);
  const specific = providerRegistry(env({GITHUB_MODELS_TOKEN: 'models-token', GITHUB_TOKEN: 'repo-token'}));
  assert.equal(specific.github.apiKey, 'models-token');
  assert.equal(specific.github.ignoredCredentialSource, undefined);
});

test('OPENAI_* and ANTHROPIC_* set for other tools never redirect this server', () => {
  const registry = providerRegistry(env({ANTHROPIC_BASE_URL: 'https://gateway.example.com', ANTHROPIC_MODEL: 'other-tool-model', OPENAI_BASE_URL: 'https://proxy.example.com/v1'}));
  assert.equal(registry.anthropic.baseURL, 'https://api.anthropic.com/v1');
  assert.equal(registry.anthropic.defaultModel, '');
  assert.equal(registry.openai.baseURL, 'https://api.openai.com/v1');
  const prefixed = providerRegistry(env({DZ23_OPENAI_BASE_URL: 'https://proxy.example.com/v1', DZ23_ANTHROPIC_MODEL: 'claude-x'}));
  assert.equal(prefixed.openai.baseURL, 'https://proxy.example.com/v1');
  assert.equal(prefixed.anthropic.defaultModel, 'claude-x');
  // Other providers keep their legacy unprefixed names; the DZ23_ prefix wins when both exist.
  const legacy = providerRegistry(env({GROQ_BASE_URL: 'https://a.example.com/v1', DZ23_CEREBRAS_BASE_URL: 'https://b.example.com/v1', CEREBRAS_BASE_URL: 'https://c.example.com/v1'}));
  assert.equal(legacy.groq.baseURL, 'https://a.example.com/v1');
  assert.equal(legacy.cerebras.baseURL, 'https://b.example.com/v1');
});

test('cleartext HTTP is refused for public provider endpoints', () => {
  assert.throws(() => providerRegistry(env({GROQ_BASE_URL: 'http://api.example.com/v1'})), /must use HTTPS/);
  assert.equal(providerRegistry(env({CUSTOM_BASE_URL: 'http://127.0.0.1:11434/v1'})).custom.baseURL, 'http://127.0.0.1:11434/v1');
  assert.equal(providerRegistry(env({CUSTOM_BASE_URL: 'http://ollama:11434/v1'})).custom.tier, 'local');
});

test('a local adapter pointed at a public host is mixed tier, not local', () => {
  const registry = providerRegistry(env({CUSTOM_BASE_URL: 'https://api.example.com/v1', CUSTOM_API_KEY: 'k'}));
  assert.equal(registry.custom.tier, 'mixed');
  const target = parseTarget('custom:some-model', registry);
  assert.equal(ineligibleReason(target, {rotation: ['custom:some-model'], allowPaid: false}), 'mixed_not_allowed');
  assert.equal(isEligible(target, {rotation: ['custom:some-model'], allowPaid: false, freeModels: ['custom:some-model']}), true);
});

test('home expansion accepts both separators and new settings parse with safe defaults', () => {
  assert.equal(expandHome('~\\state'), path.join(os.homedir(), 'state'));
  assert.equal(expandHome('~/state'), path.join(os.homedir(), 'state'));
  assert.equal(expandHome('~'), os.homedir());
  assert.equal(expandHome('C:\\data'), 'C:\\data');
  const cfg = config(env({DZ23_FREE_MODELS: 'ollama:glm-5.3-flash, mistral:mistral-small-latest'}));
  assert.deepEqual(cfg.freeModels, ['ollama:glm-5.3-flash', 'mistral:mistral-small-latest']);
  assert.deepEqual([cfg.sharedCooldowns, cfg.stdioMaxInflight, cfg.delegateDeadlineMs, cfg.allowUnauthenticatedLocalHttp, cfg.allowGenericCredentials], [true, 8, 600_000, false, false]);
});
