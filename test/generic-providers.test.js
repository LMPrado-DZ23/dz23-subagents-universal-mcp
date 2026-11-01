import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {genericProviderDefs} from '../src/generic-providers.js';
import {providerRegistry, parseTarget} from '../src/providers.js';

function env(extra = {}) {
  return {...extra};
}

test('no DZ23_PROVIDERS means no generic provider', () => {
  assert.deepEqual(genericProviderDefs(env()), {});
});

test('a declared provider is registered with defaults', () => {
  const defs = genericProviderDefs(env({
    DZ23_PROVIDERS: 'myapi',
    DZ23_MYAPI_BASE_URL: 'https://api.example.com/v1',
    DZ23_MYAPI_API_KEY: 'secret',
    DZ23_MYAPI_MODEL: 'fast-model',
  }));
  assert.deepEqual(Object.keys(defs), ['myapi']);
  const d = defs.myapi;
  assert.equal(d.baseURL, 'https://api.example.com/v1');
  assert.equal(d.keyName, 'DZ23_MYAPI_API_KEY');
  assert.equal(d.defaultModel, 'fast-model');
  assert.equal(d.protocol, 'openai');
  assert.equal(d.tier, 'mixed');
  assert.equal(d.location, 'cloud');
  assert.equal(d.generic, true);
});

test('provider names are normalized to lowercase and duplicates collapse', () => {
  const defs = genericProviderDefs(env({
    DZ23_PROVIDERS: 'MyApi, myapi ,,',
    DZ23_MYAPI_BASE_URL: 'https://api.example.com/v1',
  }));
  assert.deepEqual(Object.keys(defs), ['myapi']);
});

test('anthropic protocol is honored', () => {
  const defs = genericProviderDefs(env({
    DZ23_PROVIDERS: 'claudelike',
    DZ23_CLAUDELIKE_BASE_URL: 'https://api.example.com',
    DZ23_CLAUDELIKE_PROTOCOL: 'anthropic',
  }));
  assert.equal(defs.claudelike.protocol, 'anthropic');
});

test('local tier keeps the endpoint local and needs no key', () => {
  const registry = providerRegistry(env({
    DZ23_PROVIDERS: 'mygateway',
    DZ23_MYGATEWAY_BASE_URL: 'http://127.0.0.1:9000/v1',
    DZ23_MYGATEWAY_TIER: 'local',
  }));
  assert.equal(registry.mygateway.tier, 'local');
  assert.equal(registry.mygateway.location, 'local');
  assert.equal(registry.mygateway.enabled, true);
  assert.equal(registry.mygateway.apiKey, 'local');
});

test('a cloud provider is only enabled when a key is present', () => {
  const without = providerRegistry(env({
    DZ23_PROVIDERS: 'myapi',
    DZ23_MYAPI_BASE_URL: 'https://api.example.com/v1',
  }));
  assert.equal(without.myapi.enabled, false);

  const withKey = providerRegistry(env({
    DZ23_PROVIDERS: 'myapi',
    DZ23_MYAPI_BASE_URL: 'https://api.example.com/v1',
    DZ23_MYAPI_API_KEY: 'secret',
  }));
  assert.equal(withKey.myapi.enabled, true);
  assert.equal(withKey.myapi.apiKey, 'secret');
});

test('the key may come from a file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dz23-generic-'));
  const file = join(dir, 'key.txt');
  writeFileSync(file, 'secret-from-file\n');
  const registry = providerRegistry(env({
    DZ23_PROVIDERS: 'myapi',
    DZ23_MYAPI_BASE_URL: 'https://api.example.com/v1',
    DZ23_MYAPI_API_KEY_FILE: file,
  }));
  assert.equal(registry.myapi.apiKey, 'secret-from-file');
  assert.equal(registry.myapi.credentialSource, 'file:DZ23_MYAPI_API_KEY_FILE');
});

test('missing base URL fails loudly', () => {
  assert.throws(
    () => genericProviderDefs(env({DZ23_PROVIDERS: 'myapi'})),
    /needs DZ23_MYAPI_BASE_URL/,
  );
});

test('invalid provider name fails loudly', () => {
  assert.throws(
    () => genericProviderDefs(env({DZ23_PROVIDERS: 'minha-api', DZ23_MINHA_API_BASE_URL: 'https://x.dev/v1'})),
    /Invalid provider name "minha-api"/,
  );
});

test('unknown protocol and tier fail loudly', () => {
  assert.throws(
    () => genericProviderDefs(env({DZ23_PROVIDERS: 'myapi', DZ23_MYAPI_BASE_URL: 'https://x.dev/v1', DZ23_MYAPI_PROTOCOL: 'grpc'})),
    /unsupported DZ23_MYAPI_PROTOCOL "grpc"/,
  );
  assert.throws(
    () => genericProviderDefs(env({DZ23_PROVIDERS: 'myapi', DZ23_MYAPI_BASE_URL: 'https://x.dev/v1', DZ23_MYAPI_TIER: 'cheap'})),
    /unsupported DZ23_MYAPI_TIER "cheap"/,
  );
});

test('plain HTTP on a public host is refused', () => {
  assert.throws(
    () => providerRegistry(env({
      DZ23_PROVIDERS: 'myapi',
      DZ23_MYAPI_BASE_URL: 'http://api.example.com/v1',
      DZ23_MYAPI_API_KEY: 'secret',
    })),
    /must use HTTPS/,
  );
});

test('generic providers coexist with the built-in catalog', () => {
  const registry = providerRegistry(env({
    DZ23_PROVIDERS: 'myapi',
    DZ23_MYAPI_BASE_URL: 'https://api.example.com/v1',
    DZ23_MYAPI_API_KEY: 'secret',
    DZ23_MYAPI_MODEL: 'fast-model',
  }));
  assert.ok(registry.openai, 'built-in provider still present');
  assert.ok(registry.myapi, 'generic provider present');
  const target = parseTarget('myapi:fast-model', registry);
  assert.equal(target.model, 'fast-model');
  assert.equal(target.protocol, 'openai');
});
