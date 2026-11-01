import test from 'node:test';
import assert from 'node:assert/strict';
import {validateOutputSchema, limitText} from '../src/tool-extensions.js';
import {isProtectedName, readWorkspace, resolveWorkspace} from '../src/workspace.js';
import {patchedFiles} from '../src/sandbox.js';
import {providerRegistry} from '../src/providers.js';

// ─── tool-extensions: output schema is the last line of defence for structured output ───

test('output schema rejects a non-array where an array is declared', () => {
  assert.equal(validateOutputSchema({not: 'array'}, {type: 'array', items: {type: 'string'}}), '$ must be array');
});

test('output schema reports the failing array index and its path', () => {
  assert.equal(
    validateOutputSchema(['ok', 42], {type: 'array', items: {type: 'string'}}),
    '$[1] must be string',
  );
});

test('output schema walks nested objects inside arrays', () => {
  const schema = {
    type: 'array',
    items: {type: 'object', properties: {name: {type: 'string'}, count: {type: 'integer'}}},
  };
  assert.equal(
    validateOutputSchema([{name: 'a', count: 1}, {name: 'b', count: 1.5}], schema),
    '$[1].count must be integer',
  );
});

test('output schema rejects scalars outside the declared type and enum', () => {
  assert.equal(validateOutputSchema(1, {type: 'string'}), '$ must be string');
  assert.equal(validateOutputSchema('n', {type: 'number'}), '$ must be number');
  assert.equal(validateOutputSchema(Number.POSITIVE_INFINITY, {type: 'number'}), '$ must be number');
  assert.equal(validateOutputSchema('yes', {type: 'boolean'}), '$ must be boolean');
  assert.equal(validateOutputSchema('c', {type: 'string', enum: ['a', 'b']}), '$ is not an allowed value');
  assert.equal(validateOutputSchema('a', {type: 'string', enum: ['a', 'b']}), null);
});

test('limitText trims to the configured ceiling and never throws on empty input', () => {
  const trimmed = limitText('x'.repeat(500), {max_response_chars: 100});
  assert.equal(trimmed.truncated, true);
  assert.equal(trimmed.text.length, 100);
  assert.deepEqual(limitText('curto', {max_response_chars: 100}), {text: 'curto', truncated: false});
  assert.deepEqual(limitText('', {max_response_chars: 10}), {text: '', truncated: false});
});

// ─── workspace: protected names are the guard between the agent and secrets ───

test('credential-shaped names are protected', () => {
  for (const name of ['.env', 'id_rsa', 'credentials.json', 'api_key.txt', 'secrets.yaml', 'service_account.json', 'auth_token.conf']) {
    assert.equal(isProtectedName(name), true, `${name} must be protected`);
  }
});

test('ordinary source files are not protected', () => {
  for (const name of ['README.md', 'app.js', 'package.json', 'index.ts', 'CHANGELOG.md']) {
    assert.equal(isProtectedName(name), false, `${name} must remain readable`);
  }
});

test('workspace read refuses parent traversal and absolute paths', async () => {
  const root = process.cwd();
  const cfg = {workspaceRoots: [root]};
  const resolved = await resolveWorkspace(cfg, root);
  for (const attempt of ['../outside.txt', '..\\outside.txt', 'C:\\Windows\\win.ini', '/etc/passwd', 'src/../../escape.txt']) {
    await assert.rejects(
      () => readWorkspace(cfg, {workspace: resolved, path: attempt}),
      error => {
        assert.ok(error && error.code, `expected a coded refusal for ${attempt}`);
        return true;
      },
      `traversal ${attempt} must be refused`,
    );
  }
});

// ─── sandbox: the patch guard is what keeps a diff inside the tree ───

test('patchedFiles accepts a normal unified diff', () => {
  const patch = ['diff --git a/src/a.js b/src/a.js', '--- a/src/a.js', '+++ b/src/a.js', '@@ -1 +1 @@', '-a', '+b'].join('\n');
  assert.deepEqual(patchedFiles(patch), ['src/a.js']);
});

test('patchedFiles refuses absolute and drive-letter paths', () => {
  for (const target of ['/etc/passwd', 'C:\\Windows\\win.ini']) {
    const patch = ['diff --git a/x b/x', `+++ ${target}`].join('\n');
    assert.throws(() => patchedFiles(patch), error => error.code === 'patch_denied');
  }
});

test('patchedFiles refuses parent segments and .git paths', () => {
  for (const target of ['../escape.js', 'src/../../escape.js', '.git/config']) {
    const patch = ['diff --git a/x b/x', `+++ b/${target}`].join('\n');
    assert.throws(() => patchedFiles(patch), error => error.code === 'patch_denied');
  }
});

test('patchedFiles refuses protected names and symlink/submodule modes', () => {
  assert.throws(
    () => patchedFiles(['diff --git a/x b/x', '+++ b/.env'].join('\n')),
    error => error.code === 'patch_denied',
  );
  assert.throws(
    () => patchedFiles(['diff --git a/x b/x', 'new file mode 120000', '+++ b/link'].join('\n')),
    error => error.code === 'patch_denied' && /symbolic link/.test(error.message),
  );
});

test('patchedFiles refuses a payload that is not a diff', () => {
  assert.throws(() => patchedFiles('hello world'), error => error.code === 'invalid_request');
});

// ─── providers: base URL strictness protects the credential and the transport ───

function baseUrlError(baseUrl) {
  try {
    providerRegistry({DZ23_PROVIDERS: 'adv', DZ23_ADV_BASE_URL: baseUrl, DZ23_ADV_API_KEY: 'k'});
    return null;
  } catch (error) {
    return error.message;
  }
}

test('base URL refuses embedded credentials, query and fragment', () => {
  for (const bad of [
    'https://user:pass@api.example.com/v1',
    'https://api.example.com/v1?key=1',
    'https://api.example.com/v1#frag',
  ]) {
    assert.match(baseUrlError(bad) ?? '', /must be HTTP\(S\) without credentials, query or fragment/, bad);
  }
});

test('base URL refuses non-HTTP schemes and malformed URLs', () => {
  assert.match(baseUrlError('ftp://api.example.com/v1') ?? '', /must be HTTP\(S\)/);
  assert.match(baseUrlError('not a url') ?? '', /Invalid base URL/);
});

test('base URL refuses cleartext HTTP on a public host', () => {
  assert.match(baseUrlError('http://api.example.com/v1') ?? '', /must use HTTPS/);
});
