import {
  ID_PATTERN, PROVIDER_NAME_PATTERN, TARGET_PATTERN, ROLES, SWARM_ROLES, ROUTING_STRATEGIES,
  SYNTHESIS_MODES, MISSION_STATUSES, CHECKPOINT_MERGE_MODES, EXPLICIT_TARGET_PATTERN
} from './constants.js';
import {assertSupportedSchema} from './schema.js';

export const DEFAULT_TOOL_LIMITS = Object.freeze({maxPromptChars: 32_000, maxGoalChars: 8_000, maxListItems: 200, maxItemChars: 2_000});

export function toolLimits(cfg = {}) {
  return {
    maxPromptChars: cfg.maxPromptChars || DEFAULT_TOOL_LIMITS.maxPromptChars,
    maxGoalChars: cfg.maxGoalChars || DEFAULT_TOOL_LIMITS.maxGoalChars,
    maxListItems: DEFAULT_TOOL_LIMITS.maxListItems,
    maxItemChars: DEFAULT_TOOL_LIMITS.maxItemChars
  };
}

/** Scope, rate-limit class and billing hint per tool. Not exposed in tools/list. */
export const TOOL_POLICIES = Object.freeze({
  list_models: {scopes: ['provider:discover'], costClass: 'light', billable: false},
  provider_inventory: {scopes: ['admin:inventory'], costClass: 'light', billable: false},
  discover_models: {scopes: ['provider:discover'], costClass: 'discovery', billable: false},
  health_check: {scopes: ['health:execute'], costClass: 'billable', billable: true},
  verify_model: {scopes: ['health:execute'], costClass: 'billable', billable: true},
  project_init: {scopes: ['memory:write'], costClass: 'light', billable: false},
  mission_status: {scopes: ['memory:read'], costClass: 'light', billable: false},
  memory_checkpoint: {scopes: ['memory:write'], costClass: 'light', billable: false},
  delegate: {scopes: ['delegate:execute', 'memory:write'], costClass: 'moderate', billable: true},
  consensus: {scopes: ['delegate:execute', 'memory:write'], costClass: 'expensive', billable: true},
  swarm_run: {scopes: ['delegate:execute', 'memory:write'], costClass: 'very_expensive', billable: true}
});

const idField = description => ({
  type: 'string', minLength: 1, maxLength: 120, pattern: ID_PATTERN,
  'x-pattern-reason': 'must use 1-120 letters, digits, dots, underscores or hyphens and start with a letter or digit',
  description
});
const text = (maxLength, description) => ({
  type: 'string', minLength: 1, maxLength, pattern: '\\S', 'x-pattern-reason': 'must contain non-whitespace text', description
});
const plain = (maxLength, description) => ({type: 'string', maxLength, description});
const stringList = (limits, description) => ({
  type: 'array', maxItems: limits.maxListItems,
  items: {type: 'string', minLength: 1, maxLength: limits.maxItemChars}, description
});
const object = (properties, required) => ({type: 'object', properties, ...(required?.length ? {required} : {}), additionalProperties: false});

function routingFields(defaultStrategy) {
  return {
    routing_strategy: {type: 'string', enum: ROUTING_STRATEGIES, default: defaultStrategy,
      description: 'How workers are assigned to eligible targets. Effective strategy and observed diversity are reported.'},
    min_distinct_providers: {type: 'integer', minimum: 1, maximum: 7, description: 'Desired distinct providers; a warning is returned when unavailable.'},
    min_distinct_models: {type: 'integer', minimum: 1, maximum: 7, description: 'Desired distinct models; a warning is returned when unavailable.'},
    strict_diversity: {type: 'boolean', default: false, description: 'Fail before any provider call when the requested diversity cannot be planned.'}
  };
}

const annotations = (title, {readOnly = false, idempotent = false, openWorld = false} = {}) => ({
  title, readOnlyHint: readOnly, destructiveHint: false, idempotentHint: idempotent, openWorldHint: openWorld
});

export function buildTools(limits = toolLimits()) {
  const projectId = idField('Project memory identifier. Not an authorization boundary.');
  const missionId = idField('Mission identifier inside the project.');
  const tests = object({passed: stringList(limits), failed: stringList(limits), pending: stringList(limits)});
  const tools = [
    {name: 'list_models', title: 'List routing targets',
      description: 'List configured, policy-eligible routing targets with tier and adapter capabilities. No network calls.',
      inputSchema: object({}), annotations: annotations('List routing targets', {readOnly: true, idempotent: true})},
    {name: 'provider_inventory', title: 'Provider inventory',
      description: 'Inventory every registered provider with configuration status and credential source, never credential values. No network calls.',
      inputSchema: object({}), annotations: annotations('Provider inventory', {readOnly: true, idempotent: true})},
    {name: 'discover_models', title: 'Discover models',
      description: 'Query provider /models catalogs (cached five minutes). A catalog entry does not prove inference access.',
      inputSchema: object({
        provider: {type: 'string', pattern: PROVIDER_NAME_PATTERN, 'x-pattern-reason': 'must be a registered provider name', description: 'Limit discovery to one provider.'},
        refresh: {type: 'boolean', default: false, description: 'Bypass the five-minute catalog cache.'}
      }), annotations: annotations('Discover models', {readOnly: true, openWorld: true})},
    {name: 'health_check', title: 'Health check (billable)',
      description: 'Run a tiny real generation on every eligible target in parallel. May consume provider quota or credits.',
      inputSchema: object({}), annotations: annotations('Health check (billable)', {openWorld: true})},
    {name: 'verify_model', title: 'Verify model inference (billable)',
      description: 'Run one minimal, non-sensitive generation against provider:model to prove inference access. Requires confirm_billable=true, may consume credits, never runs automatically, never retries or fails over.',
      inputSchema: object({
        target: {type: 'string', pattern: EXPLICIT_TARGET_PATTERN, 'x-pattern-reason': 'must be provider or provider:model', description: 'provider:model to verify; it does not need to be in the rotation.'},
        confirm_billable: {type: 'boolean', const: true, description: 'Must be true: acknowledges that this call may be billed.'},
        timeout_ms: {type: 'integer', minimum: 1000, maximum: 60_000, default: 15_000, description: 'Timeout for the single generation.'},
        max_output_tokens: {type: 'integer', minimum: 1, maximum: 32, default: 8, description: 'Output token cap for the generation.'}
      }, ['target', 'confirm_billable']), annotations: annotations('Verify model inference (billable)', {openWorld: true})},
    {name: 'project_init', title: 'Initialize project memory',
      description: 'Create or update shared project metadata. Does not clone or read the repository.',
      inputSchema: object({
        project_id: projectId,
        workspace: plain(1024, 'Workspace path as recorded by the harness.'),
        repository: plain(1024, 'Repository URL or path as recorded by the harness.'),
        branch: plain(255, 'Branch name as recorded by the harness.')
      }, ['project_id']), annotations: annotations('Initialize project memory', {idempotent: true})},
    {name: 'mission_status', title: 'Mission status',
      description: 'Read mission state and recent journal events.',
      inputSchema: object({
        project_id: projectId, mission_id: missionId,
        events_limit: {type: 'integer', minimum: 1, maximum: 200, default: 40, description: 'Recent journal events to return.'}
      }, ['project_id', 'mission_id']), annotations: annotations('Mission status', {readOnly: true, idempotent: true})},
    {name: 'memory_checkpoint', title: 'Memory checkpoint',
      description: 'Persist a structured handoff checkpoint for another harness or agent. Creates the mission when absent.',
      inputSchema: object({
        project_id: projectId, mission_id: missionId,
        next_action: plain(4000, 'Concrete next step for whoever resumes.'),
        status: {type: 'string', enum: MISSION_STATUSES, description: 'Mission status. Omit to keep the current status.'},
        summary: plain(8000, 'Short factual summary of progress.'),
        goal: plain(limits.maxGoalChars, 'Mission goal.'),
        acceptance_criteria: stringList(limits, 'Objective acceptance criteria.'),
        decisions: stringList(limits, 'Decisions taken.'),
        invariants: stringList(limits, 'Constraints that must remain true.'),
        completed_tasks: stringList(limits), active_tasks: stringList(limits), blocked_tasks: stringList(limits), next_tasks: stringList(limits),
        known_failures: stringList(limits), files_read: stringList(limits), files_changed: stringList(limits), artifacts: stringList(limits),
        tests,
        merge: {type: 'string', enum: CHECKPOINT_MERGE_MODES, default: 'append', description: 'append adds new list items; replace overwrites provided lists.'}
      }, ['project_id', 'mission_id']), annotations: annotations('Memory checkpoint')},
    {name: 'delegate', title: 'Delegate advisory task',
      description: 'Delegate one advisory text task with bounded retries, failover and mission context. May consume provider credits.',
      inputSchema: object({
        project_id: {...projectId, default: 'default'}, mission_id: missionId,
        goal: plain(limits.maxGoalChars, 'Mission goal recorded when the mission is created.'),
        prompt: text(limits.maxPromptChars, 'The assignment for the subagent.'),
        role: {type: 'string', enum: ROLES, default: 'worker', description: 'Specialist role instruction.'},
        target: {type: 'string', pattern: TARGET_PATTERN, default: 'auto', 'x-pattern-reason': 'must be auto or provider:model', description: 'auto or provider:model.'}
      }, ['prompt']), annotations: annotations('Delegate advisory task', {openWorld: true})},
    {name: 'consensus', title: 'Consensus review',
      description: 'Ask 2-5 independent reviewers and return responses, observed diversity and an optional heuristic synthesis. May consume provider credits.',
      inputSchema: object({
        project_id: {...projectId, default: 'default'}, mission_id: missionId,
        prompt: text(limits.maxPromptChars, 'Question or artifact to review.'),
        models: {type: 'integer', minimum: 2, maximum: 5, default: 3, description: 'Reviewers to request.'},
        ...routingFields('round_robin'),
        synthesis: {type: 'string', enum: SYNTHESIS_MODES, default: 'heuristic', description: 'none, heuristic (no extra call) or model (one extra reviewer call).'}
      }, ['prompt']), annotations: annotations('Consensus review', {openWorld: true})},
    {name: 'swarm_run', title: 'Parallel specialist swarm',
      description: 'Run up to seven advisory specialists in parallel, then one integrating reviewer. May consume provider credits.',
      inputSchema: object({
        project_id: {...projectId, default: 'default'}, mission_id: missionId,
        goal: text(limits.maxGoalChars, 'Project goal for every specialist.'),
        roles: {type: 'array', minItems: 1, maxItems: 7, items: {type: 'string', enum: SWARM_ROLES}, default: [...SWARM_ROLES]},
        max_agents: {type: 'integer', minimum: 1, maximum: 7},
        ...routingFields('first'),
        avoid_reviewer_target: {type: 'boolean', default: false, description: 'Prefer an integrating reviewer target not used by any worker.'}
      }, ['goal']), annotations: annotations('Parallel specialist swarm', {openWorld: true})}
  ];
  for (const tool of tools) assertSupportedSchema(tool.inputSchema, tool.name);
  return tools;
}
