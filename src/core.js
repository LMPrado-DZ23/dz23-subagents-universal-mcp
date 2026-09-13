import crypto from 'node:crypto';
import {ConcurrencyLimiter} from './concurrency.js';
import {providerRegistry, parseTarget, callProvider, discoverModels, catalogCapabilities} from './providers.js';
import {toProviderError} from './provider-errors.js';
import {ToolError, safeText} from './errors.js';
import {COOLDOWN_MS, NO_FAILOVER_KINDS, ROLES, SWARM_ROLES} from './constants.js';
import {eligibleTargets, isEligible, ineligibleReason, modelAllowed, targetKey, withRotationOptIn} from './targets.js';

/** Per-target maps accept caller-chosen model names, so they are bounded (oldest entry evicted). */
const boundedSet = (map, key, value) => { if (!map.has(key) && map.size >= 512) map.delete(map.keys().next().value); map.set(key, value); };
import {buildMessages} from './prompts.js';
import {nullLogger} from './logger.js';
import {BudgetLedger} from './budget.js';
import {planRouting, observeRouting, pickReviewer} from './routing.js';
import {heuristicSynthesis} from './consensus.js';

export const rolesDefault = [...SWARM_ROLES];
const allowedRoles = new Set(ROLES);
const allowedSwarmRoles = new Set(SWARM_ROLES);
const isoNow = () => new Date().toISOString();
const uniq = items => [...new Set(items)];
const realSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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

/** Expected failures keep their code; anything else is reported generically (details stay in logs). */
function failureSummary(reason) {
  if (reason instanceof ToolError) return {code: reason.code, error: safeText(reason.message, 300)};
  return {code: 'internal_error', error: 'Unexpected failure; see server logs for this request_id'};
}

export class Router {
  constructor(cfg, memory, {caller = callProvider, registry, discoverer = discoverModels, logger = nullLogger, metrics = null, sleep = realSleep, random = Math.random, clock = Date.now, budget} = {}) {
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
    this.latency = new Map();
    this.providerStatus = {};
    this.limiter = new ConcurrencyLimiter(cfg.maxConcurrency || 7, cfg.maxWorkersPerTarget || 4, cfg.maxQueue || 32);
    this.retry = {maxRetries: cfg.maxRetries ?? 1, baseDelayMs: cfg.retryBaseDelayMs ?? 500, capMs: cfg.retryAfterCapMs ?? 30_000};
    this.budget = budget || new BudgetLedger(cfg, memory, {clock, metrics});
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
    const key = targetKey(target);
    const current = this.latency.get(key);
    boundedSet(this.latency, key, current === undefined ? ms : current + 0.3 * (ms - current));
    this.metrics?.observe('provider_latency_ms', ms, {target: key});
    this.metrics?.recordLatency(key, ms);
  }

  latencyOf(target) {
    return this.latency.get(targetKey(target)) ?? null;
  }

  routingHelpers() {
    return {priceOf: target => this.budget.priceFor(target), latencyOf: target => this.latencyOf(target)};
  }

  targets() {
    return eligibleTargets(this.cfg, this.registry);
  }

  verificationOf(provider, model) {
    return (this.providerStatus[provider]?.models || []).find(entry => entry.model === model) || null;
  }

  /** capabilities = what this adapter exposes; model_capabilities = what the provider catalog declares. */
  listModels() {
    return this.targets().map(x => {
      const found = this.discoveryCache.get(x.name)?.value?.models?.find(model => model.id === x.model);
      return {provider: x.name, model: x.model, tier: x.tier, enabled: x.enabled, base_url: x.baseURL, location: x.location, capabilities: x.capabilities,
        model_capabilities: found?.catalog_capabilities || catalogCapabilities(), inference_verified: Boolean(this.verificationOf(x.name, x.model)?.inference_verified),
        credential_source: x.credentialSource};
    });
  }

  inventory() {
    return Object.values(this.registry).map(x => {
      const status = this.providerStatus[x.name] || {};
      const verification = this.verificationOf(x.name, x.defaultModel);
      return {
        provider: x.name, adapter: x.protocol === 'anthropic' ? 'anthropic-native' : 'openai-compatible', base_url: x.baseURL || '',
        credential_configured: x.configured, credential_source: x.credentialSource, default_model: x.defaultModel || '', tier: x.tier,
        local_or_cloud: x.location, enabled: x.enabled, capabilities: x.capabilities,
        status: !x.baseURL ? 'MISSING_BASE_URL' : !x.defaultModel ? 'MISSING_MODEL' : !x.configured ? (x.location === 'local' ? 'DEFAULT_ENDPOINT_NOT_CONFIGURED' : 'MISSING_API_KEY') : 'CONFIGURED',
        status_flags: {
          configured: Boolean(x.baseURL && x.defaultModel),
          credential_present: Boolean(x.credentialSource && x.credentialSource !== 'none'),
          credential_required: x.location !== 'local',
          catalog_discovered: Boolean(status.catalog?.ok),
          inference_verified: Boolean(verification?.inference_verified)
        },
        catalog: status.catalog || null,
        verification
      };
    });
  }

  /** Load persisted catalog/verification status (written by discover and verify_model, possibly by another process). */
  async loadProviderStatus() {
    const stored = await this.memory.getProviderStatus?.();
    if (stored?.providers) this.providerStatus = stored.providers;
    return this.providerStatus;
  }

  async recordProviderStatus(provider, update) {
    const next = this.memory.updateProviderStatus ? await this.memory.updateProviderStatus(provider, update) : update(this.providerStatus[provider] || {});
    this.providerStatus = {...this.providerStatus, [provider]: next};
    return next;
  }

  /** Cooldown duration depends on the failure kind; invalid requests never cool a target down. */
  markFailure(target, error) {
    const normalized = toProviderError(error, target);
    const base = COOLDOWN_MS[normalized.kind] ?? 60_000;
    if (!base) return;
    const now = this.clock();
    boundedSet(this.exhausted, targetKey(target), {at: now, until: now + Math.max(base, normalized.retryAfterMs), kind: normalized.kind});
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

  /** Tiny real generation per target. Respects the daily/call cost limits and the unknown-cost policy. */
  async healthCheck({request_id} = {}) {
    const log = this.logger.child({request_id});
    const messages = [{role: 'user', content: 'Reply only OK'}];
    return Promise.all(this.targets().map(async target => {
      const base = {provider: target.name, model: target.model};
      let admission;
      try {
        admission = await this.budget.admit({target, messages, maxOutputTokens: 8, scope: 'system'});
      } catch (error) {
        if (!(error instanceof ToolError)) throw error;
        return {...base, ok: false, latency_ms: 0, kind: 'budget_exceeded', reason: error.details?.limit || error.code};
      }
      if (admission.denied) return {...base, ok: false, latency_ms: 0, kind: 'budget_exceeded', reason: admission.denied};
      const started = this.clock();
      const settleDetails = {target, role: 'health_check', request_id};
      try {
        const output = await this.callTarget(target, messages, {timeoutMs: this.cfg.healthTimeoutMs, maxTokens: 8});
        const latency = this.clock() - started;
        const usage = await this.budget.settle(admission.reservation, {...settleDetails, status: 'success', output});
        log.info('health_check_target', {...base, status: 'success', duration_ms: latency});
        return {...base, ok: true, latency_ms: latency, usage};
      } catch (raw) {
        // Memory/budget failures while settling are not provider failures.
        if (raw instanceof ToolError) throw raw;
        const error = toProviderError(raw, target);
        const latency = this.clock() - started;
        await this.budget.settle(admission.reservation, {...settleDetails, status: 'failed', kind: error.kind});
        this.metrics?.increment('provider_failures_total', {kind: error.kind});
        log.warn('health_check_target', {...base, status: 'failed', kind: error.kind, http_status: error.status, duration_ms: latency});
        return {...base, ok: false, latency_ms: latency, kind: error.kind, retryable: error.retryable, ...(error.status ? {http_status: error.status} : {}), error: safeText(error.message, 300)};
      } finally {
        this.budget.release(admission.reservation);
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
      await this.recordProviderStatus(target.name, entry => ({...entry, catalog: {ok: found.ok, at: new Date(this.clock()).toISOString(), count: value.count, ...(found.kind ? {kind: found.kind} : {})}}));
      out.push(value);
    }
    return out;
  }

  /** One minimal billable generation against an explicit target. Never automatic, retried or failed over. */
  async verifyModel({target, timeout_ms = 15_000, max_output_tokens = 8, request_id} = {}) {
    let resolved;
    try { resolved = parseTarget(String(target || ''), this.registry); } catch { throw new ToolError('target_not_allowed', 'Requested target is not a registered provider'); }
    resolved = withRotationOptIn(resolved, this.cfg);
    if (!isEligible(resolved, this.cfg)) throw new ToolError('target_not_allowed', 'Target is disabled, incomplete or disallowed by the cost policy', {reason: ineligibleReason(resolved, this.cfg), target: targetKey(resolved)});
    const rotationTarget = this.targets().some(t => targetKey(t) === targetKey(resolved));
    if (!rotationTarget && !modelAllowed({...resolved}, {...this.cfg, rotation: []})) {
      throw new ToolError('target_not_allowed', 'Only rotation targets or provider default models can be verified unless DZ23_ALLOW_PAID=true', {reason: 'model_not_allowed', target: targetKey(resolved)});
    }
    const messages = [{role: 'user', content: 'Reply with the single word OK.'}];
    const admission = await this.budget.admit({target: resolved, messages, maxOutputTokens: max_output_tokens, scope: 'system'});
    if (admission.denied) {
      throw new ToolError('budget_exceeded', 'Verification is not allowed by the budget or cost policy', {limit: 'target_policy', denials: [{target: targetKey(resolved), reason: admission.denied}]});
    }
    const started = this.clock();
    const verifiedAt = new Date(started).toISOString();
    const settleDetails = {target: resolved, role: 'verify_model', request_id};
    let result;
    try {
      const output = await this.callTarget(resolved, messages, {timeoutMs: timeout_ms, maxTokens: max_output_tokens, maxResponseBytes: 65_536});
      const usage = await this.budget.settle(admission.reservation, {...settleDetails, status: 'success', output});
      result = {provider: resolved.name, model: resolved.model, verified_at: verifiedAt, ok: true, inference_verified: true, latency_ms: this.clock() - started,
        response_chars: output.content.length, expected_reply: /\bok\b/i.test(output.content), usage};
    } catch (raw) {
      if (raw instanceof ToolError) throw raw;
      const error = toProviderError(raw, resolved);
      await this.budget.settle(admission.reservation, {...settleDetails, status: 'failed', kind: error.kind});
      this.markFailure(resolved, error);
      result = {provider: resolved.name, model: resolved.model, verified_at: verifiedAt, ok: false, inference_verified: false, latency_ms: this.clock() - started,
        kind: error.kind, retryable: error.retryable, ...(error.status ? {http_status: error.status} : {})};
    } finally {
      this.budget.release(admission.reservation);
    }
    this.logger.child({request_id}).info('model_verification', {provider: resolved.name, model: resolved.model, status: result.ok ? 'success' : 'failed', kind: result.kind, duration_ms: result.latency_ms});
    await this.recordProviderStatus(resolved.name, entry => {
      const previous = (entry.models || []).find(item => item.model === resolved.model);
      const record = {model: resolved.model, inference_verified: result.ok, last_verified_at: verifiedAt, last_success_at: result.ok ? verifiedAt : previous?.last_success_at || null,
        latency_ms: result.latency_ms, ...(result.kind ? {last_error_kind: result.kind} : {})};
      return {...entry, models: [...(entry.models || []).filter(item => item.model !== resolved.model), record].slice(-100)};
    });
    return result;
  }

  async ensureMission(projectId, missionId, goal = '') {
    return (await this.memory.getMission(projectId, missionId)) || this.memory.startMission(projectId, missionId, {goal});
  }

  resolvePreferred(target) {
    if (!target || target === 'auto') return [];
    let parsed;
    try { parsed = withRotationOptIn(parseTarget(target, this.registry), this.cfg); } catch { throw new ToolError('target_not_allowed', 'Requested target is not a registered provider', {reason: 'unknown_provider'}); }
    const inRotation = !this.cfg.rotation?.length || this.targets().some(t => targetKey(t) === targetKey(parsed));
    const reason = ineligibleReason(parsed, this.cfg) || (inRotation ? null : 'not_in_rotation') || (modelAllowed(parsed, this.cfg) ? null : 'model_not_allowed');
    if (reason) throw new ToolError('target_not_allowed', 'Requested target is disabled, incomplete or disallowed by the cost/rotation policy', {reason, target: targetKey(parsed)});
    return [parsed];
  }

  async contextFor(projectId, missionId, options = {}) {
    const bundle = await this.memory.contextBundleDetailed(projectId, missionId, this.cfg.maxContextChars, options);
    for (const section of bundle.truncated_sections) this.metrics?.increment('context_truncations_total', {section});
    return bundle.text;
  }

  retryDelay(error, attempt) {
    if (!error.retryable || attempt > this.retry.maxRetries) return null;
    if (error.retryAfterMs > this.retry.capMs) return null;
    const backoff = this.retry.baseDelayMs * 2 ** (attempt - 1);
    const jitter = Math.floor(this.random() * this.retry.baseDelayMs * 0.25);
    return Math.min(this.retry.capMs, Math.max(error.retryAfterMs || 0, backoff + jitter));
  }

  /**
   * Bounded retries on one target for retryable kinds. Every attempt is admitted by the
   * budget first (no provider call when denied) and settled afterwards, retries included.
   */
  async attemptTarget(target, messages, {project_id, mission_id, role, request_id, log}) {
    const attempts = [];
    const startedAt = this.clock();
    const maxTokens = this.cfg.maxOutputTokens || 4096;
    const settleDetails = {target, project_id, mission_id, role, request_id};
    for (let attempt = 1; ; attempt++) {
      const admission = await this.budget.admit({project_id, mission_id, target, messages, maxOutputTokens: maxTokens});
      if (admission.denied) {
        log.warn('budget_denied', {provider: target.name, model: target.model, reason: admission.denied, estimated_cost_usd: admission.estimated_cost_usd ?? undefined});
        return {ok: false, attempts, startedAt, denied: {target: targetKey(target), reason: admission.denied, ...(admission.estimated_cost_usd != null ? {estimated_cost_usd: admission.estimated_cost_usd} : {})}};
      }
      try {
        const callStarted = this.clock();
        await this.memory.appendEvent(project_id, mission_id, 'agent_attempt', {role, provider: target.name, model: target.model, attempt, request_id});
        log.debug('provider_call_started', {provider: target.name, model: target.model, attempt});
        let output;
        try {
          output = await this.callTarget(target, messages, {timeoutMs: this.cfg.timeoutMs, maxTokens, maxResponseBytes: this.cfg.maxResponseBytes || 2 * 1024 * 1024});
        } catch (raw) {
          if (raw instanceof ToolError) throw raw; // local admission (queue_full): no retry, cooldown or failover
          const error = toProviderError(raw, target);
          await this.budget.settle(admission.reservation, {...settleDetails, status: 'failed', kind: error.kind});
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
          continue;
        }
        const latencyMs = this.clock() - callStarted;
        const usage = await this.budget.settle(admission.reservation, {...settleDetails, status: 'success', output});
        log.info('provider_call_completed', {provider: target.name, model: target.model, attempt, duration_ms: latencyMs, status: 'success',
          input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, token_source: usage.token_source, estimated_cost_usd: usage.estimated_cost_usd, cost_source: usage.cost_source});
        return {ok: true, output, usage, attempts, startedAt, latencyMs};
      } finally {
        this.budget.release(admission.reservation);
      }
    }
  }

  async delegate({project_id = 'default', mission_id = crypto.randomUUID(), goal, prompt, role = 'worker', target = 'auto', metadata = {}, request_id, independent = false} = {}) {
    if (!goal && !prompt) throw new ToolError('invalid_request', 'goal or prompt is required');
    assertRole(role);
    const preferred = this.resolvePreferred(target);
    const log = this.logger.child({request_id, project_id, mission_id, role});
    await this.ensureMission(project_id, mission_id, goal || ''); // explicit goal only; prompts never overwrite harness fields
    await this.memory.assertHeadroom(project_id, mission_id); // a full mission fails before any billable call
    await this.memory.appendEvent(project_id, mission_id, 'delegation_started', {role, target, metadata, request_id});
    const candidates = [...preferred, ...this.availableTargets().filter(t => !preferred.some(p => targetKey(p) === targetKey(t)))];
    if (!candidates.length) {
      await this.memory.appendEvent(project_id, mission_id, 'delegation_failed', {reason: 'no_providers', request_id});
      throw new ToolError('no_providers', 'No eligible providers are configured or all are cooling down', {cooldowns: this.cooldowns()});
    }
    this.metrics?.increment('delegations_total', {role});
    const assignment = prompt || goal;
    // Independent reviewers (consensus) must not read answers other reviewers stored in the same mission.
    const contextOptions = independent ? {exclude: ['recent_outputs']} : {};
    const attempts = [];
    const denials = [];
    let context = await this.contextFor(project_id, mission_id, contextOptions);
    for (const [index, candidate] of candidates.entries()) {
      if (index > 0 && attempts.length) {
        this.metrics?.increment('failovers_total');
        log.info('provider_failover', {provider: candidate.name, model: candidate.model, candidate_index: index});
      }
      const messages = buildMessages(role, context, assignment, {previousTargetFailed: attempts.length > 0});
      const outcome = await this.attemptTarget(candidate, messages, {project_id, mission_id, role, request_id, log});
      attempts.push(...outcome.attempts);
      if (outcome.denied) {
        denials.push(outcome.denied);
        this.metrics?.increment('budget_denials_total', {reason: outcome.denied.reason});
        continue;
      }
      if (outcome.ok) {
        const agent = {id: crypto.randomUUID(), role, provider: candidate.name, model: candidate.model, started_at: new Date(outcome.startedAt).toISOString(), finished_at: isoNow(), status: 'completed'};
        await this.memory.recordAgentResult(project_id, mission_id, agent, outcome.output.content);
        await this.memory.appendEvent(project_id, mission_id, 'delegation_completed', {role, provider: candidate.name, model: candidate.model, latency_ms: outcome.latencyMs, failed_attempts: attempts.length, request_id});
        await this.memory.recordHandoff(project_id, mission_id, {tool: 'delegate', role, provider: candidate.name, model: candidate.model, at: isoNow(),
          hint: 'Review the latest agent output and verify repository state before editing.'});
        return {ok: true, project_id, mission_id, role, provider: candidate.name, model: candidate.model, content: outcome.output.content, usage: outcome.usage, attempts,
          ...(denials.length ? {budget_denials: denials} : {}), ...(request_id ? {request_id} : {})};
      }
      this.markFailure(candidate, outcome.error);
      if (NO_FAILOVER_KINDS.has(outcome.error.kind)) {
        await this.memory.appendEvent(project_id, mission_id, 'delegation_failed', {reason: outcome.error.kind, request_id});
        throw new ToolError('invalid_request', 'Provider rejected the request as invalid; it was not sent to other providers', {attempts});
      }
      context = await this.contextFor(project_id, mission_id, contextOptions);
    }
    if (!attempts.length && denials.length) {
      await this.memory.appendEvent(project_id, mission_id, 'delegation_failed', {reason: 'budget_exceeded', request_id});
      throw new ToolError('budget_exceeded', 'No eligible target fits the configured budget or cost policy', {limit: 'target_policy', denials});
    }
    await this.memory.appendEvent(project_id, mission_id, 'delegation_failed', {reason: 'all_providers_failed', failed_attempts: attempts.length, request_id});
    throw new ToolError('all_providers_failed', 'All eligible providers failed', {attempts, ...(denials.length ? {budget_denials: denials} : {})});
  }

  /** Independent reviewers on distinct targets, observed diversity and an optional synthesis. */
  async consensus({project_id = 'default', mission_id = crypto.randomUUID(), prompt, models = 3, routing_strategy = 'round_robin', min_distinct_providers, min_distinct_models,
    strict_diversity = false, synthesis = 'heuristic', request_id} = {}) {
    if (!prompt) throw new ToolError('invalid_request', 'prompt is required');
    const targets = this.availableTargets();
    if (!targets.length) throw new ToolError('no_providers', 'No eligible providers are configured or all are cooling down', {cooldowns: this.cooldowns()});
    const requested = Math.max(2, Math.min(5, models));
    const helpers = this.routingHelpers();
    const plan = planRouting({targets, count: requested, strategy: routing_strategy, minDistinctProviders: min_distinct_providers, minDistinctModels: min_distinct_models,
      strict: strict_diversity, distinctOnly: true, ...helpers});
    await this.ensureMission(project_id, mission_id, '');
    const settled = await Promise.allSettled(plan.assignments.map(target => this.delegate({project_id, mission_id, prompt, role: 'reviewer', target: targetKey(target), request_id, independent: true})));
    const responses = settled.map((s, i) => s.status === 'fulfilled'
      ? {ok: true, provider: s.value.provider, model: s.value.model, content: s.value.content, usage: s.value.usage, attempts: s.value.attempts}
      : {ok: false, provider: plan.assignments[i].name, model: plan.assignments[i].model, ...failureSummary(s.reason)});
    const received = responses.filter(response => response.ok);
    let result = null;
    if (synthesis !== 'none' && received.length) {
      result = heuristicSynthesis(received);
      if (synthesis === 'model' && received.length >= 2) {
        const pick = pickReviewer(this.availableTargets(), new Set(received.map(r => `${r.provider}:${r.model}`)), routing_strategy, helpers);
        try {
          const out = await this.delegate({project_id, mission_id, role: 'reviewer', request_id, target: pick.target ? targetKey(pick.target) : 'auto',
            prompt: `Synthesize the independent reviewer answers stored in mission memory. List agreements, contradictions and claims nobody verified. Do not present agreement as objective truth. Question: ${prompt}`});
          result.model = {ok: true, provider: out.provider, model: out.model, content: out.content, usage: out.usage};
        } catch (error) {
          result.model = {ok: false, ...failureSummary(error)};
        }
      }
    }
    return {project_id, mission_id, requested, planned: plan.assignments.length, received: received.length, failed: responses.length - received.length,
      responses, routing: observeRouting(plan.routing, responses), synthesis: result};
  }

  async swarmRun({project_id = 'default', mission_id = crypto.randomUUID(), goal, roles = rolesDefault, max_agents, routing_strategy = 'first', min_distinct_providers,
    min_distinct_models, strict_diversity = false, avoid_reviewer_target = false, request_id} = {}) {
    if (!goal) throw new ToolError('invalid_request', 'goal is required');
    if (!Array.isArray(roles) || !roles.length || roles.some(r => typeof r !== 'string' || !allowedSwarmRoles.has(r))) {
      throw new ToolError('invalid_request', 'roles must be a nonempty array of supported specialist role names');
    }
    await this.ensureMission(project_id, mission_id, goal);
    const targets = this.availableTargets();
    if (!targets.length) throw new ToolError('no_providers', 'No configured providers');
    const log = this.logger.child({request_id, project_id, mission_id});
    const started = this.clock();
    // Without max_agents, run one worker per requested role (capped), not the concurrency ceiling.
    const requested = Math.max(1, Math.min(max_agents || roles.length, this.cfg.maxConcurrency || 7, 7));
    const selected = Array.from({length: requested}, (_, i) => roles[i % roles.length]);
    const helpers = this.routingHelpers();
    const plan = planRouting({targets, count: selected.length, strategy: routing_strategy, minDistinctProviders: min_distinct_providers,
      minDistinctModels: min_distinct_models, strict: strict_diversity, ...helpers});
    log.info('swarm_started', {workers: selected.length, requested_strategy: plan.routing.requested_strategy, effective_strategy: plan.routing.effective_strategy});
    // Swarm bookkeeping lives in its own fields, never in harness-authored task lists.
    await this.memory.mutateMission(project_id, mission_id, current => ({...current, sequence: (current.sequence || 0) + 1, updated_at: isoNow(),
      swarm_run: {status: 'running', started_at: isoNow(), roles: selected, ...(request_id ? {request_id} : {})}}));
    // Each worker starts on its planned target; delegate() handles ordered failover and
    // the shared limiter enforces total and per-target in-flight call limits.
    const workers = selected.map((role, i) => this.delegate({project_id, mission_id, goal, role, request_id, target: targetKey(plan.assignments[i]), metadata: {worker_index: i + 1},
      prompt: `Work independently on this project goal from your specialization. Coordinate through shared memory. Do not overwrite another agent's unmerged work. Goal: ${goal}`}));
    const settled = await Promise.allSettled(workers);
    for (const s of settled) {
      if (s.status === 'rejected' && !(s.reason instanceof ToolError)) log.error('swarm_worker_internal_error', {error_name: s.reason?.name, error_code: typeof s.reason?.code === 'string' ? s.reason.code : undefined});
    }
    const outputs = settled.map((s, i) => s.status === 'fulfilled' ? s.value : {ok: false, role: selected[i], ...failureSummary(s.reason)});
    const okRoles = outputs.filter(x => x.ok).map(x => x.role);
    const failed = outputs.filter(x => !x.ok).map(x => ({role: x.role, error: x.error}));
    await this.memory.mutateMission(project_id, mission_id, current => ({...current, sequence: (current.sequence || 0) + 1, updated_at: isoNow(), swarm_run: null,
      swarm_last_run: {at: isoNow(), roles: selected, count: selected.length, completed_roles: uniq(okRoles), failed, ...(request_id ? {request_id} : {})}}));
    let reviewerTarget = 'auto';
    let reviewer = null;
    if (avoid_reviewer_target && outputs.some(x => x.ok)) {
      const used = new Set(outputs.filter(x => x.ok).map(x => `${x.provider}:${x.model}`));
      const pick = pickReviewer(this.availableTargets(), used, routing_strategy, helpers);
      if (pick.target) {
        reviewerTarget = targetKey(pick.target);
        reviewer = {planned_target: reviewerTarget, shares_worker_target: pick.shares_worker_target};
        if (pick.shares_worker_target) plan.routing.warnings.push('avoid_reviewer_target: no eligible target outside the worker targets');
      }
    }
    let integration = null;
    if (outputs.some(x => x.ok)) {
      try {
        integration = await this.delegate({project_id, mission_id, role: 'reviewer', target: reviewerTarget, request_id,
          prompt: `Integrate and review the parallel agent outputs now stored in mission memory. Resolve contradictions, identify what is actually proven, and produce a single prioritized continuation plan for the harness. Goal: ${goal}`});
      } catch (error) {
        integration = {ok: false, ...failureSummary(error)};
      }
    }
    await this.memory.recordHandoff(project_id, mission_id, {tool: 'swarm_run', at: isoNow(), outcome: failed.length ? 'partial' : 'complete',
      hint: 'Inspect the working tree and tests, then decide whether to apply the reviewer continuation plan.'});
    log.info('swarm_completed', {workers_ok: okRoles.length, workers_failed: failed.length, integration_ok: Boolean(integration?.ok), duration_ms: this.clock() - started});
    const routing = observeRouting(plan.routing, outputs);
    if (reviewer) routing.reviewer = {...reviewer, ...(integration?.ok ? {provider: integration.provider, model: integration.model} : {})};
    return {project_id, mission_id, workers: outputs, integration, routing};
  }
}
