import crypto from 'node:crypto';
import {ConcurrencyLimiter} from './concurrency.js';
import {providerRegistry, parseTarget, callProvider, discoverModels} from './providers.js';
import {toProviderError} from './provider-errors.js';
import {ToolError, safeText} from './errors.js';
import {COOLDOWN_MS, NO_FAILOVER_KINDS, ROLES, SWARM_ROLES} from './constants.js';
import {eligibleTargets, isEligible, targetKey} from './targets.js';
import {buildMessages} from './prompts.js';
import {nullLogger} from './logger.js';

export const rolesDefault = [...SWARM_ROLES];
const allowedRoles = new Set(ROLES);
const allowedSwarmRoles = new Set(SWARM_ROLES);
const isoNow = () => new Date().toISOString();
const uniq = items => [...new Set(items)];
const realSleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const TRUNCATION_MARKER = '...[older context truncated]';

function assertRole(role) {
  if (!allowedRoles.has(role)) throw new ToolError('invalid_request', `Unsupported role: ${safeText(role, 40)}`);
  return role;
}

function attemptRecord(error, attempt) {
  return {
    provider: error.provider, model: error.model, attempt, kind: error.kind, retryable: error.retryable,
    ...(error.status ? {http_status: error.status} : {}),
    ...(error.retryAfterMs ? {retry_after_ms: error.retryAfterMs} : {}),
    error: safeText(error.message, 200)
  };
}

export class Router {
  constructor(cfg, memory, {caller = callProvider, registry, discoverer = discoverModels, logger = nullLogger, metrics = null, sleep = realSleep, random = Math.random, clock = Date.now} = {}) {
    this.cfg = cfg;
    this.memory = memory;
    this.caller = caller;
    this.registry = registry || providerRegistry();
    this.discoverer = discoverer;
    this.logger = logger;
    this.metrics = metrics;
    this.sleep = sleep;
    this.random = random;
    this.clock = clock;
    this.exhausted = new Map();
    this.discoveryCache = new Map();
    this.limiter = new ConcurrencyLimiter(cfg.maxConcurrency || 7, cfg.maxWorkersPerTarget || 4, cfg.maxQueue || 32);
    this.retry = {maxRetries: cfg.maxRetries ?? 1, baseDelayMs: cfg.retryBaseDelayMs ?? 500, capMs: cfg.retryAfterCapMs ?? 30_000};
    logger.addSecrets?.(Object.values(this.registry).map(provider => provider.apiKey));
    if (metrics) {
      metrics.gauge('active_calls', () => this.limiter.active);
      metrics.gauge('queue_depth', () => this.limiter.queue.length);
      metrics.gauge('provider_cooldowns', () => this.cooldowns());
    }
  }

  /** One provider call inside the shared limiter. Latency excludes queue time. */
  async callTarget(target, messages, options) {
    return this.limiter.run(targetKey(target), async () => {
      const started = this.clock();
      const output = await this.caller(target, messages, options);
      this.recordLatency(target, this.clock() - started);
      return output;
    });
  }

  recordLatency(target, ms) {
    this.metrics?.observe('provider_latency_ms', ms, {target: targetKey(target)});
    this.metrics?.recordLatency(targetKey(target), ms);
  }

  targets() {
    return eligibleTargets(this.cfg, this.registry);
  }

  listModels() {
    return this.targets().map(x => ({provider: x.name, model: x.model, tier: x.tier, enabled: x.enabled, base_url: x.baseURL, location: x.location, capabilities: x.capabilities, credential_source: x.credentialSource}));
  }

  inventory() {
    return Object.values(this.registry).map(x => ({
      provider: x.name, adapter: x.protocol === 'anthropic' ? 'anthropic-native' : 'openai-compatible', base_url: x.baseURL || '',
      credential_configured: x.configured, credential_source: x.credentialSource, default_model: x.defaultModel || '', tier: x.tier,
      local_or_cloud: x.location, enabled: x.enabled, capabilities: x.capabilities,
      status: !x.baseURL ? 'MISSING_BASE_URL' : !x.defaultModel ? 'MISSING_MODEL' : (!x.configured && x.location !== 'local') ? 'MISSING_API_KEY' : 'CONFIGURED'
    }));
  }

  /** Cooldown duration depends on the failure kind; invalid requests never cool a target down. */
  markFailure(target, error) {
    const normalized = toProviderError(error, target);
    const base = COOLDOWN_MS[normalized.kind] ?? 60_000;
    if (!base) return;
    const now = this.clock();
    this.exhausted.set(targetKey(target), {at: now, until: now + Math.max(base, normalized.retryAfterMs), kind: normalized.kind});
  }

  cooldowns() {
    const now = this.clock();
    return [...this.exhausted].filter(([, entry]) => entry.until > now).map(([target, entry]) => ({target, kind: entry.kind, remaining_ms: entry.until - now}));
  }

  availableTargets() {
    const now = this.clock();
    return this.targets().filter(target => {
      const cooldown = this.exhausted.get(targetKey(target));
      return !cooldown || now > cooldown.until;
    });
  }

  async healthCheck({request_id} = {}) {
    const log = this.logger.child({request_id});
    return Promise.all(this.targets().map(async target => {
      const started = this.clock();
      try {
        await this.callTarget(target, [{role: 'user', content: 'Reply only OK'}], {timeoutMs: this.cfg.healthTimeoutMs, maxTokens: 8});
        const latency = this.clock() - started;
        log.info('health_check_target', {provider: target.name, model: target.model, status: 'success', duration_ms: latency});
        return {provider: target.name, model: target.model, ok: true, latency_ms: latency};
      } catch (raw) {
        const error = toProviderError(raw, target);
        const latency = this.clock() - started;
        this.metrics?.increment('provider_failures_total', {kind: error.kind});
        log.warn('health_check_target', {provider: target.name, model: target.model, status: 'failed', kind: error.kind, http_status: error.status, duration_ms: latency});
        return {provider: target.name, model: target.model, ok: false, latency_ms: latency, kind: error.kind, retryable: error.retryable, ...(error.status ? {http_status: error.status} : {}), error: safeText(error.message, 300)};
      }
    }));
  }

  async discover({provider, refresh = false} = {}) {
    const targets = provider ? [this.registry[provider]].filter(Boolean) : Object.values(this.registry).filter(x => x.enabled);
    const out = [];
    for (const base of targets) {
      const target = {...base, model: base.defaultModel};
      const cached = this.discoveryCache.get(target.name);
      if (cached && !refresh && this.clock() - cached.at < 5 * 60_000) { out.push(cached.value); continue; }
      const found = await this.discoverer(target, {timeoutMs: this.cfg.healthTimeoutMs});
      const value = {provider: target.name, base_url: target.baseURL, ok: found.ok, models: found.models || [], count: found.models?.length || 0, kind: found.kind, error: found.error};
      this.discoveryCache.set(target.name, {at: this.clock(), value});
      out.push(value);
    }
    return out;
  }

  async ensureMission(projectId, missionId, goal = '') {
    return (await this.memory.getMission(projectId, missionId)) || this.memory.startMission(projectId, missionId, {goal});
  }

  resolvePreferred(target) {
    if (!target || target === 'auto') return [];
    let parsed;
    try { parsed = parseTarget(target, this.registry); } catch { throw new ToolError('target_not_allowed', 'Requested target is not a registered provider'); }
    const inRotation = !this.cfg.rotation?.length || this.targets().some(t => targetKey(t) === targetKey(parsed));
    if (!isEligible(parsed, this.cfg) || !inRotation) throw new ToolError('target_not_allowed', 'Requested target is disabled, incomplete or disallowed by the cost/rotation policy');
    return [parsed];
  }

  async contextFor(projectId, missionId) {
    const text = await this.memory.contextBundle(projectId, missionId, this.cfg.maxContextChars);
    if (text.startsWith(TRUNCATION_MARKER)) this.metrics?.increment('context_truncations_total');
    return text;
  }

  retryDelay(error, attempt) {
    if (!error.retryable || attempt > this.retry.maxRetries) return null;
    if (error.retryAfterMs > this.retry.capMs) return null;
    const backoff = this.retry.baseDelayMs * 2 ** (attempt - 1);
    const jitter = Math.floor(this.random() * this.retry.baseDelayMs * 0.25);
    return Math.min(this.retry.capMs, Math.max(error.retryAfterMs || 0, backoff + jitter));
  }

  /** Bounded retries on one target for retryable kinds; returns the final outcome for that target. */
  async attemptTarget(target, messages, {project_id, mission_id, role, request_id, log}) {
    const attempts = [];
    const startedAt = this.clock();
    for (let attempt = 1; ; attempt++) {
      const callStarted = this.clock();
      await this.memory.appendEvent(project_id, mission_id, 'agent_attempt', {role, provider: target.name, model: target.model, attempt, request_id});
      log.debug('provider_call_started', {provider: target.name, model: target.model, attempt});
      try {
        const output = await this.callTarget(target, messages, {timeoutMs: this.cfg.timeoutMs, maxTokens: this.cfg.maxOutputTokens || 4096, maxResponseBytes: this.cfg.maxResponseBytes || 2 * 1024 * 1024});
        const latencyMs = this.clock() - callStarted;
        log.info('provider_call_completed', {provider: target.name, model: target.model, attempt, duration_ms: latencyMs, status: 'success'});
        return {ok: true, output, attempts, startedAt, latencyMs};
      } catch (raw) {
        const error = toProviderError(raw, target);
        attempts.push(attemptRecord(error, attempt));
        this.metrics?.increment('provider_failures_total', {kind: error.kind});
        log.warn('provider_call_failed', {provider: target.name, model: target.model, attempt, duration_ms: this.clock() - callStarted, status: 'failed',
          kind: error.kind, retryable: error.retryable, http_status: error.status, retry_after_ms: error.retryAfterMs || undefined});
        await this.memory.appendEvent(project_id, mission_id, 'provider_failed', {role, provider: target.name, model: target.model, attempt, kind: error.kind,
          retryable: error.retryable, http_status: error.status, retry_after_ms: error.retryAfterMs || 0, request_id, error: safeText(error.message, 300)});
        const delay = this.retryDelay(error, attempt);
        if (delay === null) return {ok: false, error, attempts, startedAt};
        this.metrics?.increment('provider_retries_total', {kind: error.kind});
        await this.sleep(delay);
      }
    }
  }

  async delegate({project_id = 'default', mission_id = crypto.randomUUID(), goal, prompt, role = 'worker', target = 'auto', metadata = {}, request_id} = {}) {
    if (!goal && !prompt) throw new ToolError('invalid_request', 'goal or prompt is required');
    assertRole(role);
    const preferred = this.resolvePreferred(target);
    const log = this.logger.child({request_id, project_id, mission_id, role});
    await this.ensureMission(project_id, mission_id, goal || prompt);
    await this.memory.appendEvent(project_id, mission_id, 'delegation_started', {role, target, metadata, request_id});
    const candidates = [...preferred, ...this.availableTargets().filter(t => !preferred.some(p => targetKey(p) === targetKey(t)))];
    if (!candidates.length) {
      await this.memory.appendEvent(project_id, mission_id, 'delegation_failed', {reason: 'no_providers', request_id});
      throw new ToolError('no_providers', 'No eligible providers are configured or all are cooling down', {cooldowns: this.cooldowns()});
    }
    this.metrics?.increment('delegations_total', {role});
    const assignment = prompt || goal;
    const attempts = [];
    let context = await this.contextFor(project_id, mission_id);
    for (const [index, candidate] of candidates.entries()) {
      if (index > 0) {
        this.metrics?.increment('failovers_total');
        log.info('provider_failover', {provider: candidate.name, model: candidate.model, candidate_index: index});
      }
      const messages = buildMessages(role, context, assignment, {previousTargetFailed: index > 0});
      const outcome = await this.attemptTarget(candidate, messages, {project_id, mission_id, role, request_id, log});
      attempts.push(...outcome.attempts);
      if (outcome.ok) {
        const agent = {id: crypto.randomUUID(), role, provider: candidate.name, model: candidate.model, started_at: new Date(outcome.startedAt).toISOString(), finished_at: isoNow(), status: 'completed'};
        await this.memory.recordAgentResult(project_id, mission_id, agent, outcome.output.content);
        await this.memory.appendEvent(project_id, mission_id, 'delegation_completed', {role, provider: candidate.name, model: candidate.model, latency_ms: outcome.latencyMs, failed_attempts: attempts.length, request_id});
        await this.memory.checkpoint(project_id, mission_id, {next_action: 'Continue from the latest agent handoff and verify repository state before editing.'});
        return {ok: true, project_id, mission_id, role, provider: candidate.name, model: candidate.model, content: outcome.output.content, attempts, ...(request_id ? {request_id} : {})};
      }
      this.markFailure(candidate, outcome.error);
      if (NO_FAILOVER_KINDS.has(outcome.error.kind)) {
        await this.memory.appendEvent(project_id, mission_id, 'delegation_failed', {reason: outcome.error.kind, request_id});
        throw new ToolError('invalid_request', 'Provider rejected the request as invalid; it was not sent to other providers', {attempts});
      }
      context = await this.contextFor(project_id, mission_id);
    }
    await this.memory.appendEvent(project_id, mission_id, 'delegation_failed', {reason: 'all_providers_failed', failed_attempts: attempts.length, request_id});
    throw new ToolError('all_providers_failed', 'All eligible providers failed', {attempts});
  }

  async consensus({project_id = 'default', mission_id = crypto.randomUUID(), prompt, models = 3, request_id} = {}) {
    await this.ensureMission(project_id, mission_id, prompt);
    const targets = this.availableTargets().slice(0, Math.max(2, Math.min(5, models)));
    const settled = await Promise.allSettled(targets.map(t => this.delegate({project_id, mission_id, prompt, role: 'reviewer', target: targetKey(t), request_id})));
    return settled.map((s, i) => s.status === 'fulfilled' ? s.value : {ok: false, provider: targets[i]?.name, error: safeText(s.reason?.message, 300)});
  }

  async swarmRun({project_id = 'default', mission_id = crypto.randomUUID(), goal, roles = rolesDefault, max_agents, request_id} = {}) {
    if (!goal) throw new ToolError('invalid_request', 'goal is required');
    if (!Array.isArray(roles) || !roles.length || roles.some(r => typeof r !== 'string' || !allowedSwarmRoles.has(r))) {
      throw new ToolError('invalid_request', 'roles must be a nonempty array of supported specialist role names');
    }
    await this.ensureMission(project_id, mission_id, goal);
    const targets = this.availableTargets();
    if (!targets.length) throw new ToolError('no_providers', 'No configured providers');
    const log = this.logger.child({request_id, project_id, mission_id});
    const started = this.clock();
    const requested = Math.max(1, Math.min(max_agents || this.cfg.maxConcurrency, this.cfg.maxConcurrency, 7));
    const selected = Array.from({length: requested}, (_, i) => roles[i % roles.length]);
    log.info('swarm_started', {workers: selected.length});
    await this.memory.updateMission(project_id, mission_id, {active_tasks: selected.map((role, i) => ({id: `${role}-${i + 1}`, role, status: 'running'}))});
    // Every role starts on the preferred target; delegate() handles ordered failover and
    // the shared limiter enforces total and per-target in-flight call limits.
    const workers = selected.map((role, i) => this.delegate({project_id, mission_id, goal, role, request_id, target: targetKey(targets[0]), metadata: {worker_index: i + 1},
      prompt: `Work independently on this project goal from your specialization. Coordinate through shared memory. Do not overwrite another agent's unmerged work. Goal: ${goal}`}));
    const settled = await Promise.allSettled(workers);
    const outputs = settled.map((s, i) => s.status === 'fulfilled' ? s.value : {ok: false, role: selected[i], error: safeText(s.reason?.message, 300), ...(s.reason?.code ? {code: s.reason.code} : {})});
    const okRoles = outputs.filter(x => x.ok).map(x => x.role);
    const failed = outputs.filter(x => !x.ok).map(x => ({role: x.role, error: x.error}));
    const current = await this.memory.getMission(project_id, mission_id);
    await this.memory.updateMission(project_id, mission_id, {active_tasks: [], completed_tasks: uniq([...(current.completed_tasks || []), ...okRoles]),
      blocked_tasks: [...(current.blocked_tasks || []), ...failed], swarm_last_run: {at: isoNow(), roles: selected, count: selected.length}});
    let integration = null;
    if (outputs.some(x => x.ok)) {
      try {
        integration = await this.delegate({project_id, mission_id, role: 'reviewer', target: 'auto', request_id,
          prompt: `Integrate and review the parallel agent outputs now stored in mission memory. Resolve contradictions, identify what is actually proven, and produce a single prioritized continuation plan for the harness. Goal: ${goal}`});
      } catch (error) {
        integration = {ok: false, error: safeText(error.message, 300)};
      }
    }
    await this.memory.checkpoint(project_id, mission_id, {status: failed.length ? 'partial' : 'active', next_action: 'Harness should inspect working tree/tests, then execute the reviewer continuation plan.'});
    log.info('swarm_completed', {workers_ok: okRoles.length, workers_failed: failed.length, integration_ok: Boolean(integration?.ok), duration_ms: this.clock() - started});
    return {project_id, mission_id, workers: outputs, integration};
  }
}
