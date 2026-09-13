import test from 'node:test';
import assert from 'node:assert/strict';
import {validate, ValidationError, assertSupportedSchema} from '../src/schema.js';
import {buildTools, toolLimits} from '../src/tools.js';

const tools = Object.fromEntries(buildTools().map(tool => [tool.name, tool]));
const schemaOf = name => tools[name].inputSchema;

function rejects(schema, value, field, reason) {
  assert.throws(() => validate(schema, value), error => {
    assert.ok(error instanceof ValidationError);
    assert.equal(error.field, field);
    if (reason instanceof RegExp) assert.match(error.reason, reason); else assert.equal(error.reason, reason);
    return true;
  });
}

test('missing required field is reported by name', () => {
  rejects(schemaOf('mission_status'), {project_id: 'p'}, 'mission_id', 'is required');
});

test('invalid type is rejected with a stable reason', () => {
  rejects(schemaOf('delegate'), {prompt: 42}, 'prompt', 'must be a string');
  rejects(schemaOf('swarm_run'), {goal: 'x', max_agents: 2.5}, 'max_agents', 'must be an integer');
});

test('invalid enum value lists the allowed options, never the submitted value', () => {
  rejects(schemaOf('delegate'), {prompt: 'x', role: 'ignore-all-security'}, 'role', /^must be one of: worker, architect/);
  assert.throws(() => validate(schemaOf('delegate'), {prompt: 'x', role: 'secret-looking-value'}), error => !error.message.includes('secret-looking-value'));
});

test('numeric and array limits are enforced', () => {
  rejects(schemaOf('swarm_run'), {goal: 'x', max_agents: 8}, 'max_agents', 'must be <= 7');
  rejects(schemaOf('consensus'), {prompt: 'x', models: 1}, 'models', 'must be >= 2');
  rejects(schemaOf('swarm_run'), {goal: 'x', roles: Array(8).fill('qa')}, 'roles', 'must contain at most 7 items');
  rejects(schemaOf('swarm_run'), {goal: 'x', roles: ['qa', 'worker']}, 'roles[1]', /^must be one of/);
});

test('unknown fields are refused, including prototype keys', () => {
  rejects(schemaOf('project_init'), {project_id: 'p', owner: 'x'}, 'owner', 'is not allowed');
  rejects(schemaOf('project_init'), JSON.parse('{"project_id":"p","__proto__":{"polluted":true}}'), '__proto__', 'is not allowed');
  assert.equal({}.polluted, undefined);
  rejects(schemaOf('memory_checkpoint'), {project_id: 'p', mission_id: 'm', tests: {skipped: []}}, 'tests.skipped', 'is not allowed');
});

test('empty and whitespace-only prompts are rejected', () => {
  rejects(schemaOf('delegate'), {prompt: ''}, 'prompt', 'must not be empty');
  rejects(schemaOf('delegate'), {prompt: ' \n\t '}, 'prompt', 'must contain non-whitespace text');
});

test('prompt above the configured limit is rejected and the limit is configurable', () => {
  const small = Object.fromEntries(buildTools(toolLimits({maxPromptChars: 1000, maxGoalChars: 600})).map(tool => [tool.name, tool]));
  rejects(small.delegate.inputSchema, {prompt: 'x'.repeat(1001)}, 'prompt', 'must be at most 1000 characters');
  rejects(small.swarm_run.inputSchema, {goal: 'x'.repeat(601)}, 'goal', 'must be at most 600 characters');
  assert.equal(validate(small.delegate.inputSchema, {prompt: 'x'.repeat(1000)}).prompt.length, 1000);
  assert.equal(schemaOf('delegate').properties.prompt.maxLength, 32000, 'default limit is bounded');
});

test('lengths count Unicode code points, not UTF-16 units', () => {
  const schema = {type: 'string', maxLength: 3};
  assert.equal(validate(schema, '😀😀😀'), '😀😀😀');
  assert.throws(() => validate(schema, '😀😀😀😀'), ValidationError);
});

test('valid arguments receive documented defaults without mutating the input', () => {
  const input = {prompt: 'review this'};
  const out = validate(schemaOf('delegate'), input);
  assert.deepEqual(out, {project_id: 'default', prompt: 'review this', role: 'worker', target: 'auto'});
  assert.deepEqual(input, {prompt: 'review this'});
  const swarm = validate(schemaOf('swarm_run'), {goal: 'build'});
  assert.equal(swarm.routing_strategy, 'first');
  assert.equal(swarm.avoid_reviewer_target, false);
  assert.deepEqual(swarm.roles, ['architect', 'backend', 'frontend', 'security', 'qa', 'devops', 'reviewer']);
  assert.equal(validate(schemaOf('consensus'), {prompt: 'x'}).routing_strategy, 'round_robin');
  assert.equal(validate(schemaOf('mission_status'), {project_id: 'p', mission_id: 'm'}).events_limit, 40);
});

test('identifiers, targets and nested checkpoint fields are validated', () => {
  rejects(schemaOf('project_init'), {project_id: '../escape'}, 'project_id', /letters, digits/);
  rejects(schemaOf('delegate'), {prompt: 'x', target: 'OpenAI:gpt'}, 'target', 'must be auto or provider:model');
  assert.equal(validate(schemaOf('delegate'), {prompt: 'x', target: 'ollama:deepseek-v4-flash:cloud'}).target, 'ollama:deepseek-v4-flash:cloud');
  rejects(schemaOf('memory_checkpoint'), {project_id: 'p', mission_id: 'm', tests: {passed: [1]}}, 'tests.passed[0]', 'must be a string');
  rejects(schemaOf('memory_checkpoint'), {project_id: 'p', mission_id: 'm', status: 'finished'}, 'status', /^must be one of/);
  rejects(schemaOf('project_init'), {project_id: 'p', branch: 'b'.repeat(256)}, 'branch', 'must be at most 255 characters');
});

test('every published tool schema is closed and uses only enforced keywords', () => {
  for (const tool of Object.values(tools)) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
    assert.doesNotThrow(() => assertSupportedSchema(tool.inputSchema));
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(tool)));
  }
  assert.throws(() => assertSupportedSchema({type: 'object', oneOf: []}), /Unsupported schema keyword "oneOf"/);
  assert.throws(() => assertSupportedSchema({type: 'string', default: 3}), ValidationError);
});
