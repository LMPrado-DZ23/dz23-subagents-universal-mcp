import {
  ID_PATTERN, PROVIDER_NAME_PATTERN, TARGET_PATTERN, ROLES, SWARM_ROLES, ROUTING_STRATEGIES,
  SYNTHESIS_MODES, MISSION_STATUSES, CHECKPOINT_MERGE_MODES, EXPLICIT_TARGET_PATTERN, RESPONSE_MODES
} from './constants.js';
import {assertSupportedSchema} from './schema.js';
import {TASK_TYPES} from './routing-stats.js';

export const DEFAULT_TOOL_LIMITS = Object.freeze({maxPromptChars: 32_000, maxGoalChars: 8_000, maxListItems: 200, maxItemChars: 2_000});

export function toolLimits(cfg = {}) {
  return {
    maxPromptChars: cfg.maxPromptChars || DEFAULT_TOOL_LIMITS.maxPromptChars,
    maxGoalChars: cfg.maxGoalChars || DEFAULT_TOOL_LIMITS.maxGoalChars,
    maxListItems: DEFAULT_TOOL_LIMITS.maxListItems,
    maxItemChars: DEFAULT_TOOL_LIMITS.maxItemChars
  };
}

/**
 * Tool Gateway registry (not exposed in tools/list): scopes enforced per call, cost class for rate limiting,
 * billing hint, audit event name written to the hash-chained audit log, and the configuration that enables
 * the tool. Disabled tools are not listed and cannot be called.
 */
const BASE_TOOL_POLICIES = {
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
  swarm_run: {scopes: ['delegate:execute', 'memory:write'], costClass: 'very_expensive', billable: true},
  workspace_read: {scopes: ['workspace:read'], costClass: 'light', billable: false},
  workspace_search: {scopes: ['workspace:read'], costClass: 'light', billable: false},
  git_readonly: {scopes: ['git:read'], costClass: 'light', billable: false},
  mission_start: {scopes: ['mission:control', 'memory:write', 'delegate:execute'], costClass: 'very_expensive', billable: true},
  mission_status_job: {scopes: ['mission:control', 'memory:read'], costClass: 'light', billable: false},
  mission_pause: {scopes: ['mission:control', 'memory:write'], costClass: 'light', billable: false},
  mission_resume: {scopes: ['mission:control', 'memory:write', 'delegate:execute'], costClass: 'very_expensive', billable: true},
  mission_cancel: {scopes: ['mission:control', 'memory:write'], costClass: 'light', billable: false},
  mission_claim: {scopes: ['mission:lease', 'memory:write'], costClass: 'light', billable: false},
  mission_release: {scopes: ['mission:lease', 'memory:write'], costClass: 'light', billable: false},
  handoff_export: {scopes: ['memory:read'], costClass: 'light', billable: false},
  mission_list: {scopes: ['memory:read'], costClass: 'light', billable: false},
  playbook_get: {scopes: ['memory:read'], costClass: 'light', billable: false},
  routing_explain: {scopes: ['provider:discover'], costClass: 'light', billable: false},
  cost_estimate: {scopes: ['provider:discover'], costClass: 'light', billable: false}
};
const WORKSPACE_TOOLS = new Set(['workspace_read', 'workspace_search', 'git_readonly']);
export const TOOL_POLICIES = Object.freeze(Object.fromEntries(Object.entries(BASE_TOOL_POLICIES).map(([name, policy]) => [name, Object.freeze({
  ...policy, audit_event: `tool.${name}`, enabled_by: WORKSPACE_TOOLS.has(name) ? 'DZ23_WORKSPACE_ROOTS' : 'core'
})])));

/** Whether the gateway exposes a tool under this configuration. */
export function toolEnabled(name, cfg = {}) {
  const policy = TOOL_POLICIES[name];
  if (!policy) return false;
  return policy.enabled_by === 'DZ23_WORKSPACE_ROOTS' ? Boolean(cfg.workspaceRoots?.length) : true;
}

const idField = description => ({
  type: 'string', minLength: 1, maxLength: 120, pattern: ID_PATTERN,
  'x-pattern-reason': 'must use 1-120 letters, digits, dots, underscores or hyphens, start with a letter or digit and not end with a dot',
  description
});
const REUSE_IDS = 'Reuse the project_id and mission_id of the current task (from project_init / memory_checkpoint); when omitted, results go to project "default" and a new random mission that mission_status and memory_checkpoint will not find.';
const text = (maxLength, description) => ({
  type: 'string', minLength: 1, maxLength, pattern: '\\S', 'x-pattern-reason': 'must contain non-whitespace text', description
});
const plain = (maxLength, description) => ({type: 'string', maxLength, description});
const stringList = (limits, description) => ({
  type: 'array', maxItems: limits.maxListItems,
  items: {type: 'string', minLength: 1, maxLength: limits.maxItemChars}, description
});
const object = (properties, required) => ({type: 'object', properties, ...(required?.length ? {required} : {}), additionalProperties: false});
const contextField = {
  type: 'object', additionalProperties: false,
  properties: {
    files: {type: 'array', maxItems: 50, items: {type: 'string', minLength: 1, maxLength: 4096}},
    search: {type: 'object', additionalProperties: false, properties: {query: text(2000, 'Search query.'), regex: {type: 'boolean', default: false}, max_results: {type: 'integer', minimum: 1, maximum: 100, default: 50}}, required: ['query']},
    git_diff: {type: 'boolean', default: false}
  }, description: 'Workspace evidence. Requires workspace; content is untrusted data.'
};
const outputFields = {
  detail: {type: 'string', enum: ['brief', 'normal', 'full'], default: 'normal', description: 'Controls response verbosity.'},
  max_response_chars: {type: 'integer', minimum: 256, maximum: 200000, description: 'Hard cap for returned textual content.'},
  output_schema: {type: 'object', description: 'JSON Schema subset (type, required, properties, items, enum) for the answer. delegate retries once and fails with response_invalid; consensus and swarm_run add structured_output or schema_error per answer.'},
  privacy: {type: 'string', enum: ['auto', 'local_only', 'allow_cloud'], default: 'auto', description: 'Secrets in attached context are always masked. auto also masks valid CPF/CNPJ/card numbers, emails and phones; local_only additionally routes only to local private targets (no_local_target otherwise); allow_cloud keeps personal data.'},
  idempotency_key: {type: 'string', minLength: 8, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$', description: 'Caller key, valid 24 h in this process. The same key and arguments return the first result without a new provider call; different arguments fail with idempotency_conflict.'},
  lease_token: {type: 'string', maxLength: 128, description: 'Token from mission_claim. Required only while another holder has a live lease on this mission.'}
};
const cacheField = {type: 'boolean', default: false, description: 'Reuse an identical earlier answer when DZ23_RESPONSE_CACHE_TTL_MS > 0; the result reports cache_status (hit, miss or disabled).'};

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
  const workProjectId = {...idField('Project of the current task; defaults to "default".'), default: 'default'};
  const workMissionId = idField('Mission of the current task; omitted creates a new random mission.');
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
        refresh: {type: 'boolean', default: false, description: 'Bypass the five-minute catalog cache.'},
        cache_only: {type: 'boolean', default: false, description: 'Return cached catalogs only; never contact a provider.'}
      }), annotations: annotations('Discover models', {readOnly: true, openWorld: true})},
    {name: 'health_check', title: 'Health check (billable)',
      description: 'Run a tiny real generation on every eligible target in parallel. Requires confirm_billable=true; may consume provider quota or credits.',
      inputSchema: object({
        confirm_billable: {type: 'boolean', const: true, description: 'Must be true: acknowledges one billable call per eligible target.'}
      }, ['confirm_billable']), annotations: annotations('Health check (billable)', {openWorld: true})},
    {name: 'verify_model', title: 'Verify model inference (billable)',
      description: 'Run one minimal, non-sensitive generation against provider:model to prove inference access. Requires confirm_billable=true, may consume credits, never runs automatically, never retries or fails over.',
      inputSchema: object({
        target: {type: 'string', pattern: EXPLICIT_TARGET_PATTERN, 'x-pattern-reason': 'must be provider or provider:model', description: 'provider:model to verify; it does not need to be in the rotation.'},
        confirm_billable: {type: 'boolean', const: true, description: 'Must be true: acknowledges that this call may be billed.'},
        timeout_ms: {type: 'integer', minimum: 1000, maximum: 60_000, default: 15_000, description: 'Timeout for the single generation.'},
        max_output_tokens: {type: 'integer', minimum: 1, maximum: 32, default: 8, description: 'Output token cap for the generation.'}
      }, ['target', 'confirm_billable']), annotations: annotations('Verify model inference (billable)', {openWorld: true})},
    {name: 'project_init', title: 'Initialize project memory',
      description: 'Create or update shared project metadata. Does not clone or read the repository. Use one stable project_id per repository and pass it to every later tool call.',
      inputSchema: object({
        project_id: projectId,
        workspace: plain(1024, 'Workspace path as recorded by the harness.'),
        repository: plain(1024, 'Repository URL or path as recorded by the harness.'),
        branch: plain(255, 'Branch name as recorded by the harness.')
      }, ['project_id']), annotations: annotations('Initialize project memory', {idempotent: true})},
    {name: 'mission_status', title: 'Mission status',
      description: 'Read mission state and recent journal events. Agent outputs are returned as short previews unless include_outputs=true.',
      inputSchema: object({
        project_id: projectId, mission_id: missionId,
        events_limit: {type: 'integer', minimum: 1, maximum: 200, default: 40, description: 'Recent journal events to return.'},
        include_outputs: {type: 'boolean', default: false, description: 'Return full stored agent outputs instead of previews (can be very large).'}
      }, ['project_id', 'mission_id']), annotations: annotations('Mission status', {readOnly: true, idempotent: true})},
    {name: 'memory_checkpoint', title: 'Memory checkpoint',
      description: 'Persist a structured handoff checkpoint for another harness or agent. Creates the mission when absent. Use the same project_id and mission_id the task used for delegate, consensus and swarm_run.',
      inputSchema: object({
        project_id: projectId, mission_id: missionId,
        next_action: plain(4000, 'Concrete next step for whoever resumes.'),
        lease_token: outputFields.lease_token,
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
      description: `Delegate one advisory text task with bounded retries, failover and mission context. May consume provider credits. ${REUSE_IDS}`,
      inputSchema: object({
        project_id: workProjectId, mission_id: workMissionId,
        goal: plain(limits.maxGoalChars, 'Mission goal recorded when the mission is created.'),
        prompt: text(limits.maxPromptChars, 'The assignment for the subagent.'),
        role: {type: 'string', enum: ROLES, default: 'worker', description: 'Specialist role instruction.'},
        task_type: {type: 'string', enum: TASK_TYPES, description: 'Kind of task for adaptive model choice; defaults from role (backend/frontend=code, reviewer=review, qa=testing...).'},
        target: {type: 'string', pattern: TARGET_PATTERN, default: 'auto', 'x-pattern-reason': 'must be auto or provider:model', description: 'auto or provider:model.'},
        workspace: {type: 'string', maxLength: 4096, description: 'Configured workspace root for context.'},
        context: contextField,
        ...outputFields,
        cache: cacheField
      }, ['prompt']), annotations: annotations('Delegate advisory task', {openWorld: true})},
    {name: 'consensus', title: 'Consensus review',
      description: `Ask 2-5 independent reviewers and return responses, observed diversity and an optional heuristic synthesis. May consume provider credits. ${REUSE_IDS}`,
      inputSchema: object({
        project_id: workProjectId, mission_id: workMissionId,
        prompt: text(limits.maxPromptChars, 'Question or artifact to review.'),
        models: {type: 'integer', minimum: 2, maximum: 5, default: 3, description: 'Number of independent reviewers to request (a count, not model names).'},
        ...routingFields('round_robin'),
        synthesis: {type: 'string', enum: SYNTHESIS_MODES, default: 'heuristic', description: 'none, heuristic (no extra call) or model (one extra reviewer call).'},
        workspace: {type: 'string', maxLength: 4096, description: 'Configured workspace root for context.'},
        context: contextField,
        ...outputFields
      }, ['prompt']), annotations: annotations('Consensus review', {openWorld: true})},
    {name: 'swarm_run', title: 'Parallel specialist swarm',
      description: `Run up to seven advisory specialists in parallel, then one integrating reviewer. May consume provider credits and take minutes. ${REUSE_IDS}`,
      inputSchema: object({
        project_id: workProjectId, mission_id: workMissionId,
        goal: text(limits.maxGoalChars, 'Project goal for every specialist.'),
        roles: {type: 'array', minItems: 1, maxItems: 7, items: {type: 'string', enum: SWARM_ROLES}, default: [...SWARM_ROLES],
          description: 'Specialist roles; workers cycle through this list.'},
        max_agents: {type: 'integer', minimum: 1, maximum: 7, description: 'Number of workers; defaults to one per role, capped by DZ23_MAX_CONCURRENCY.'},
        ...routingFields('first'),
        avoid_reviewer_target: {type: 'boolean', default: false, description: 'Prefer an integrating reviewer target not used by any worker.'},
        response_mode: {type: 'string', enum: RESPONSE_MODES, default: 'summary',
          description: 'summary returns the full integration plus a short excerpt per worker; full returns every worker output.'},
        workspace: {type: 'string', maxLength: 4096, description: 'Configured workspace root for context.'},
        context: contextField,
        ...outputFields
      }, ['goal']), annotations: annotations('Parallel specialist swarm', {openWorld: true})},
    {name: 'workspace_read', title: 'Read allowed workspace',
      description: 'Read a directory or bounded UTF-8 file only below DZ23_WORKSPACE_ROOTS. Protected files, .env, keys, .ssh, .git and symlink escapes are blocked.',
      inputSchema: object({workspace: text(4096, 'Absolute configured workspace root or child path.'), path: {type: 'string', maxLength: 4096, default: '.'}}, ['workspace']),
      annotations: annotations('Read allowed workspace', {readOnly: true, idempotent: true})},
    {name: 'workspace_search', title: 'Search allowed workspace',
      description: 'Search text or regular expressions in bounded files below DZ23_WORKSPACE_ROOTS. Protected files and symlinks are skipped.',
      inputSchema: object({workspace: text(4096, 'Absolute configured workspace root.'), query: text(2000, 'Text or regular expression.'), regex: {type: 'boolean', default: false}, max_results: {type: 'integer', minimum: 1, maximum: 200, default: 50}}, ['workspace', 'query']),
      annotations: annotations('Search allowed workspace', {readOnly: true, idempotent: true})},
    {name: 'git_readonly', title: 'Read Git state',
      description: 'Run only status, diff, log or show in an allowed workspace. No writes, hooks, network, commit, checkout or push.',
      inputSchema: object({workspace: text(4096, 'Absolute configured workspace root.'), operation: {type: 'string', enum: ['status', 'diff', 'log', 'show'], default: 'status'}}, ['workspace']),
      annotations: annotations('Read Git state', {readOnly: true, idempotent: true})},
    {name: 'mission_start', title: 'Start asynchronous mission',
      description: `Start a mission in the background and return a job_id immediately. With plan, runs a task graph: nodes whose depends_on are done run in parallel (dependency results passed as untrusted data), failed nodes retry up to max_attempts, nodes after a failure are skipped, progress is saved in dag_state and resume_plan: true skips nodes already done (also after a restart). Without plan, runs a loop where each iteration runs swarm_run with the previous integration as diagnosis; near-identical results switch routing strategy and then stop as failed_safe. Progress is kept in the mission loop_state, never in status, next_action or goal. The job ends completed only when the harness recorded new passing tests (memory_checkpoint) during the job; otherwise awaiting_acceptance. May consume provider credits. ${REUSE_IDS}`,
      inputSchema: object({project_id: workProjectId, mission_id: workMissionId, goal: text(limits.maxGoalChars, 'Mission goal.'),
        acceptance_criteria: stringList(limits, 'Objective criteria the harness must prove with evidence.'), roles: {type: 'array', maxItems: 7, items: {type: 'string', enum: SWARM_ROLES}},
        routing_strategy: {type: 'string', enum: ROUTING_STRATEGIES, default: 'first'}, max_iterations: {type: 'integer', minimum: 1, maximum: 20, default: 3},
        plan: {type: 'object', additionalProperties: false, required: ['nodes'], description: 'Task graph (up to 30 nodes).', properties: {nodes: {type: 'array', minItems: 1, maxItems: 30, items: {
          type: 'object', additionalProperties: false, required: ['id', 'prompt'], properties: {
            id: {type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$', description: 'Unique node id.'}, title: plain(200, 'Short title.'),
            role: {type: 'string', enum: ROLES, default: 'worker'}, prompt: text(limits.maxPromptChars, 'Task for this node.'),
            depends_on: {type: 'array', maxItems: 30, uniqueItems: true, items: {type: 'string', maxLength: 64}}, task_type: {type: 'string', enum: TASK_TYPES},
            max_attempts: {type: 'integer', minimum: 1, maximum: 3, default: 2}}}}}},
        resume_plan: {type: 'boolean', default: false, description: 'Reuse nodes already done in this mission dag_state when the plan is identical.'},
        lease_token: outputFields.lease_token}, ['goal']), annotations: annotations('Start asynchronous mission', {openWorld: true})},
    {name: 'mission_status_job', title: 'Asynchronous mission status',
      description: 'Status of a mission job. After a server restart pass project_id and mission_id: a job that was still running is reported as orphaned.',
      inputSchema: object({job_id: text(128, 'Job id.'), project_id: idField('Project of the job (for persisted status).'), mission_id: idField('Mission of the job (for persisted status).')}, ['job_id']),
      annotations: annotations('Asynchronous mission status', {readOnly: true, idempotent: true})},
    {name: 'mission_pause', title: 'Pause asynchronous mission', description: 'Request a pause; the job stops after the current iteration and can be resumed.',
      inputSchema: object({job_id: text(128, 'Job id.')}, ['job_id']), annotations: annotations('Pause asynchronous mission')},
    {name: 'mission_resume', title: 'Resume asynchronous mission', description: 'Resume a paused job as a new job_id with the same goal, roles, criteria and remaining iterations.',
      inputSchema: object({job_id: text(128, 'Paused job id.')}, ['job_id']), annotations: annotations('Resume asynchronous mission', {openWorld: true})},
    {name: 'mission_cancel', title: 'Cancel asynchronous mission', description: 'Cancel a running or paused job. A finished job keeps its final status.',
      inputSchema: object({job_id: text(128, 'Job id.')}, ['job_id']), annotations: annotations('Cancel asynchronous mission')},
    {name: 'mission_claim', title: 'Claim mission lease',
      description: 'Claim a mission for one harness with expiry. While the lease is live, memory_checkpoint, delegate, consensus, swarm_run and mission_start on that mission need its token; others receive mission_busy. Renew by claiming again with lease_token. Leases coordinate cooperating harnesses; they are not authentication.',
      inputSchema: object({project_id: projectId, mission_id: missionId, identity: text(128, 'Harness identity, e.g. claude-code or codex.'),
        lease_ms: {type: 'integer', minimum: 1000, maximum: 3600000, default: 300000}, lease_token: outputFields.lease_token}, ['project_id', 'mission_id', 'identity']),
      annotations: annotations('Claim mission lease')},
    {name: 'mission_release', title: 'Release mission lease', description: 'Release a lease with the token returned by mission_claim.',
      inputSchema: object({project_id: projectId, mission_id: missionId, identity: plain(128, 'Harness identity (informational).'), token: text(128, 'Lease token.')}, ['project_id', 'mission_id', 'token']),
      annotations: annotations('Release mission lease')},
    {name: 'handoff_export', title: 'Export mission handoff', description: 'Return a compact Markdown briefing for another harness.', inputSchema: object({project_id: projectId, mission_id: missionId}, ['project_id','mission_id']), annotations: annotations('Export mission handoff', {readOnly:true, idempotent:true})},
    {name: 'mission_list', title: 'List missions', description: 'Missions with status, goal, next action, loop/graph progress and resource URI. Same data as MCP resources, for harnesses without resources support.',
      inputSchema: object({project_id: idField('Only this project (optional).'), limit: {type: 'integer', minimum: 1, maximum: 200, default: 50}, cursor: {type: 'string', maxLength: 16, pattern: '^[0-9]+$'}}),
      annotations: annotations('List missions', {readOnly: true, idempotent: true})},
    {name: 'playbook_get', title: 'Get playbook', description: 'Without name: list the playbooks (the MCP prompts). With name and arguments: the rendered instructions. For harnesses without MCP prompts support.',
      inputSchema: object({name: {type: 'string', maxLength: 64}, arguments: {type: 'object', additionalProperties: {type: 'string', maxLength: 8000}}}),
      annotations: annotations('Get playbook', {readOnly: true, idempotent: true})},
    {name: 'routing_explain', title: 'Explain model routing', description: 'Which models the server would use for a task type right now, in order, and why others are skipped: cost tier, eligibility, cooldowns, observed success and latency, quota from provider headers. No provider calls.',
      inputSchema: object({task_type: {type: 'string', enum: TASK_TYPES}, role: {type: 'string', enum: ROLES, default: 'worker'}, target: {type: 'string', pattern: TARGET_PATTERN, default: 'auto'}}),
      annotations: annotations('Explain model routing', {readOnly: true, idempotent: true})},
    {name: 'cost_estimate', title: 'Estimate call cost', description: 'Upper bound of calls, tokens and cost (when DZ23_PRICES_FILE has prices) for delegate, consensus or swarm_run before running it. No provider calls.',
      inputSchema: object({tool: {type: 'string', enum: ['delegate', 'consensus', 'swarm_run'], default: 'delegate'}, prompt: plain(limits.maxPromptChars, 'Prompt or goal to size.'),
        prompt_chars: {type: 'integer', minimum: 0, maximum: 1000000}, models: {type: 'integer', minimum: 2, maximum: 5, default: 3}, roles: {type: 'array', maxItems: 7, items: {type: 'string', enum: SWARM_ROLES}},
        max_agents: {type: 'integer', minimum: 1, maximum: 7}, synthesis: {type: 'string', enum: SYNTHESIS_MODES, default: 'heuristic'}, task_type: {type: 'string', enum: TASK_TYPES}}),
      annotations: annotations('Estimate call cost', {readOnly: true, idempotent: true})}
  ];
  for (const tool of tools) assertSupportedSchema(tool.inputSchema, tool.name);
  return tools;
}
