import crypto from 'node:crypto';
import {ConcurrencyLimiter} from './concurrency.js';
import {providerRegistry, parseTarget, callProvider, discoverModels, catalogCapabilities} from './providers.js';
import {toProviderError, MAX_RETRY_AFTER_MS} from './provider-errors.js';
import {ToolError, safeText, abortError, throwIfAborted} from './errors.js';
import {COOLDOWN_MS, NO_FAILOVER_KINDS, ROLES, SHARED_COOLDOWN_KINDS, SWARM_ROLES} from './constants.js';
import {eligibleTargets, isEligible, ineligibleReason, modelAllowed, targetKey, withRotationOptIn} from './targets.js';
import {buildMessages} from './prompts.js';
import {nullLogger} from './logger.js';
import {BudgetLedger} from './budget.js';
import {runConsensus, runSwarm} from './orchestration.js';
import {createRoutingStats, taskTypeOf} from './routing-stats.js';

/** Per-target maps accept caller-chosen model names, so they are bounded (oldest entry evicted). */
const boundedSet = (map, key, value) => { if (!map.has(key) && map.size >= 512) map.delete(map.keys().next().value); map.set(key, value); };

export const rolesDefault = [...SWARM_ROLES];
const allowedRoles = new Set(ROLES);
const isoNow = () => new Date().toISOString();
// Only this server's own codes are reported; raw errno codes and messages can carry paths.
const errorCode = error => (error instanceof ToolError ? error.code : 'memory_write_failed');
// Retry backoff ends early when the call is (or already was) cancelled; the caller then checks the signal.
const realSleep = (ms, signal) => new Promise(resolve => {
  if (signal?.aborted) return resolve();
  const onAbort = () => { clearTimeout(timer); resolve(); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  signal?.addEventListener('abort', onAbort, {once: true});
});

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
  constructor(cfg, memory, {caller = callProvider, registry, discoverer = discoverModels, logger = nullLogger, metrics = null, sleep = realSleep, random = Math.random, clock = Date.now, budget, stats} = {}) {
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
    this.stats = stats === undefined ? createRoutingStats(cfg, {clock}) : stats;
    logger.addSecrets?.(Object.values(this.registry).map(provider => provider.apiKey));
    if (metrics) {
      metrics.gauge('active_calls', () => this.limiter.active);
      metrics.gauge('queue_depth', () => this.limiter.queue.length);
      metrics.gauge('provider_cooldowns', () => this.cooldowns());
    }
  }

  /** One provider call inside the shared limiter. Latency excludes queue time. */
  async callTarget(target, messages, options = {}) {
    return this.limiter.run(targetKey(target), async () => {
      const started = this.clock();
      const output = await this.caller(target, messages, options);
      this.recordLatency(target, this.clock() - started);
      return output;
    }, options.signal);
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
        ...(x.ignoredCredentialSource ? {ignored_credential_source: x.ignoredCredentialSource} : {}),
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

  /** Load persisted catalog/verification/cooldown status (written by this or another process). */
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

  /**
   * Cooldown duration depends on the failure kind; request-shaped failures never cool a target down.
   * With DZ23_SHARED_COOLDOWNS the cooldown is also persisted, so other harness processes skip the target.
   */
  async markFailure(target, error) {
    const normalized = toProviderError(error, target);
    const base = COOLDOWN_MS[normalized.kind] ?? 60_000;
    if (!base) return;
    const now = this.clock();
    const entry = {at: now, until: now + Math.min(MAX_RETRY_AFTER_MS, Math.max(base, normalized.retryAfterMs)), kind: normalized.kind};
    boundedSet(this.exhausted, targetKey(target), entry);
    if (!this.cfg.sharedCooldowns || !SHARED_COOLDOWN_KINDS.has(entry.kind) || !this.memory.updateProviderStatus) return;
    try {
      await this.recordProviderStatus(target.name, current => {
        const kept = Object.entries(current.cooldowns || {}).filter(([model, value]) => model !== target.model && value?.until > now).slice(-63);
        return {...current, cooldowns: Object.fromEntries([...kept, [target.model, {until: entry.until, kind: entry.kind}]])};
      });
    } catch (failure) {
      this.logger.warn('shared_cooldown_write_failed', {provider: target.name, code: errorCode(failure)});
    }
  }

  /** Merge unexpired cooldowns that another process sharing the state directory recorded. */
  async refreshSharedCooldowns() {
    if (!this.cfg.sharedCooldowns || !this.memory.getProviderStatus) return;
    try {
      await this.loadProviderStatus();
    } catch (failure) {
      this.logger.warn('shared_cooldown_read_failed', {code: errorCode(failure)});
      return;
    }
    const now = this.clock();
    for (const [provider, status] of Object.entries(this.providerStatus || {})) {
      for (const [model, value] of Object.entries(status?.cooldowns || {})) {
        const key = `${provider}:${model}`;
        if (SHARED_COOLDOWN_KINDS.has(value?.kind) && Number.isFinite(value.until) && value.until > now && (this.exhausted.get(key)?.until || 0) < value.until) {
          // A shared file can be stale or tampered with: never adopt more than the maximum cooldown.
          boundedSet(this.exhausted, key, {at: now, until: Math.min(value.until, now + MAX_RETRY_AFTER_MS), kind: value.kind, shared: true});
        }
      }
    }
  }

  cooldowns() {
    const now = this.clock();
    return [...this.exhausted].filter(([, entry]) => entry.until > now).map(([target, entry]) => ({target, kind: entry.kind, remaining_ms: entry.until - now}));
  }

  /** Eligible targets not cooling down, adaptively ordered inside each cost tier for the task type. */
  availableTargets(taskType = 'general') {
    const now = this.clock();
    const ready = this.targets().filter(target => { const cooldown = this.exhausted.get(targetKey(target)); return !cooldown || now > cooldown.until; });
    return this.stats ? this.stats.order(ready, this.cfg, taskType) : ready;
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

  async discover({provider, refresh = false, cache_only = false} = {}) {
    // Discovery only contacts enabled providers: naming a disabled local adapter must not probe default local ports.
    const targets = (provider ? [this.registry[provider]] : Object.values(this.registry)).filter(x => x?.enabled);
    const out = [];
    for (const base of targets) {
      const target = {...base, model: base.defaultModel};
      const cached = this.discoveryCache.get(target.name);
      // cache_only never contacts a provider or writes status (REST GET), whatever the cache age.
      if (cache_only) { if (cached) out.push({...cached.value, cached_at: new Date(cached.at).toISOString()}); continue; }
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
      await this.markFailure(resolved, error);
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
   * Bounded retries on one target for retryable kinds. Every attempt is admitted by the budget first
   * (no provider call when denied) and settled afterwards, retries included. A cancelled call is neither a
   * provider failure (no retry, cooldown or failover) nor free: it is settled as failed and rethrown.
   */
  async attemptTarget(target, messages, {project_id, mission_id, role, request_id, log, signal, task_type = taskTypeOf(role)}) {
    const attempts = [];
    const startedAt = this.clock();
    const maxTokens = this.cfg.maxOutputTokens || 4096;
    const settleDetails = {target, project_id, mission_id, role, request_id};
    for (let attempt = 1; ; attempt++) {
      throwIfAborted(signal);
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
          output = await this.callTarget(target, messages, {timeoutMs: this.cfg.timeoutMs, maxTokens, maxResponseBytes: this.cfg.maxResponseBytes || 2 * 1024 * 1024, signal});
        } catch (raw) {
          if (raw instanceof ToolError) throw raw; // local admission (queue_full, cancelled while queued): no retry, cooldown or failover
          if (signal?.aborted) {
            await this.budget.settle(admission.reservation, {...settleDetails, status: 'failed', kind: 'cancelled'}).catch(() => undefined);
            log.warn('provider_call_cancelled', {provider: target.name, model: target.model, attempt, duration_ms: this.clock() - callStarted});
            throw abortError(signal);
          }
          const error = toProviderError(raw, target);
          await this.budget.settle(admission.reservation, {...settleDetails, status: 'failed', kind: error.kind});
          attempts.push(attemptRecord(error, attempt));
          this.stats?.record(target, task_type, {ok: false, kind: error.kind});
          this.metrics?.increment('provider_failures_total', {kind: error.kind});
          log.warn('provider_call_failed', {provider: target.name, model: target.model, attempt, duration_ms: this.clock() - callStarted, status: 'failed',
            kind: error.kind, retryable: error.retryable, http_status: error.status, retry_after_ms: error.retryAfterMs || undefined});
          await this.memory.appendEvent(project_id, mission_id, 'provider_failed', {role, provider: target.name, model: target.model, attempt, kind: error.kind,
            retryable: error.retryable, http_status: error.status, retry_after_ms: error.retryAfterMs || 0, request_id, error: safeText(error.message, 300)});
          const delay = this.retryDelay(error, attempt);
          if (delay === null) return {ok: false, error, attempts, startedAt};
          this.metrics?.increment('provider_retries_total', {kind: error.kind});
          await this.sleep(delay, signal);
          continue;
        }
        const latencyMs = this.clock() - callStarted;
        this.stats?.record(target, task_type, {ok: true, latencyMs, rateLimits: output?.rate_limits});
        const memoryWarnings = [];
        let usage = null;
        // The provider already answered (and may have billed): bookkeeping failures never discard the answer.
        // Settlement is retried once (it is idempotent), because a lost record under-enforces budgets.
        for (let settleAttempt = 1; settleAttempt <= 2 && !usage; settleAttempt++) {
          try {
            usage = await this.budget.settle(admission.reservation, {...settleDetails, status: 'success', output});
          } catch (failure) {
            if (settleAttempt < 2) continue;
            memoryWarnings.push(`usage:${errorCode(failure)}`);
            this.metrics?.increment('usage_record_failures_total');
            log.warn('usage_record_failed', {provider: target.name, model: target.model, code: errorCode(failure), error_name: failure?.name});
          }
        }
        log.info('provider_call_completed', {provider: target.name, model: target.model, attempt, duration_ms: latencyMs, status: 'success',
          input_tokens: usage?.input_tokens, output_tokens: usage?.output_tokens, token_source: usage?.token_source, estimated_cost_usd: usage?.estimated_cost_usd, cost_source: usage?.cost_source});
        return {ok: true, output, usage, attempts, startedAt, latencyMs, memoryWarnings};
      } finally {
        this.budget.release(admission.reservation);
      }
    }
  }

  async delegate({project_id = 'default', mission_id = crypto.randomUUID(), goal, prompt, role = 'worker', target = 'auto', metadata = {}, request_id, independent = false, signal, task_type} = {}) {
    if (!goal && !prompt) throw new ToolError('invalid_request', 'goal or prompt is required');
    assertRole(role);
    throwIfAborted(signal);
    const preferred = this.resolvePreferred(target);
    const log = this.logger.child({request_id, project_id, mission_id, role});
    await this.ensureMission(project_id, mission_id, goal || ''); // explicit goal only; prompts never overwrite harness fields
    await this.memory.assertHeadroom(project_id, mission_id); // a full mission fails before any billable call
    await this.memory.appendEvent(project_id, mission_id, 'delegation_started', {role, target, metadata, request_id});
    await this.refreshSharedCooldowns();
    const taskType = taskTypeOf(role, task_type);
    const candidates = [...preferred, ...this.availableTargets(taskType).filter(t => !preferred.some(p => targetKey(p) === targetKey(t)))];
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
      throwIfAborted(signal);
      if (index > 0 && attempts.length) {
        this.metrics?.increment('failovers_total');
        log.info('provider_failover', {provider: candidate.name, model: candidate.model, candidate_index: index});
      }
      const messages = buildMessages(role, context, assignment, {previousTargetFailed: attempts.length > 0});
      const outcome = await this.attemptTarget(candidate, messages, {project_id, mission_id, role, request_id, log, signal, task_type: taskType});
      attempts.push(...outcome.attempts);
      if (outcome.denied) {
        denials.push(outcome.denied);
        this.metrics?.increment('budget_denials_total', {reason: outcome.denied.reason});
        continue;
      }
      if (outcome.ok) return this.completeDelegation({project_id, mission_id, role, candidate, outcome, attempts, denials, request_id, log});
      await this.markFailure(candidate, outcome.error);
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
    // Every target said the input is too large: tell the caller to shrink it instead of reporting generic outages.
    const reason = attempts.length && attempts.every(item => item.kind === 'context_length_exceeded') ? 'context_too_large' : 'all_providers_failed';
    await this.memory.appendEvent(project_id, mission_id, 'delegation_failed', {reason, failed_attempts: attempts.length, request_id});
    if (reason === 'context_too_large') {
      throw new ToolError('context_too_large', 'Every eligible target rejected the input as too large; shorten the prompt or start a new mission with less context', {attempts});
    }
    throw new ToolError('all_providers_failed', 'All eligible providers failed', {attempts, ...(denials.length ? {budget_denials: denials} : {})});
  }

  /** Persist a successful answer. Memory failures after the paid call become warnings, never a lost answer. */
  async completeDelegation({project_id, mission_id, role, candidate, outcome, attempts, denials, request_id, log}) {
    const warnings = [...(outcome.memoryWarnings || [])];
    const persist = async (step, write) => {
      try {
        await write();
      } catch (failure) {
        warnings.push(`${step}:${errorCode(failure)}`);
        log.warn('memory_persist_failed', {step, code: errorCode(failure), error_name: failure?.name});
      }
    };
    const agent = {id: crypto.randomUUID(), role, provider: candidate.name, model: candidate.model, started_at: new Date(outcome.startedAt).toISOString(), finished_at: isoNow(), status: 'completed'};
    await persist('agent_result', () => this.memory.recordAgentResult(project_id, mission_id, agent, outcome.output.content));
    await persist('event', () => this.memory.appendEvent(project_id, mission_id, 'delegation_completed', {role, provider: candidate.name, model: candidate.model, latency_ms: outcome.latencyMs, failed_attempts: attempts.length, request_id}));
    await persist('handoff', () => this.memory.recordHandoff(project_id, mission_id, {tool: 'delegate', role, provider: candidate.name, model: candidate.model, at: isoNow(),
      hint: 'Review the latest agent output and verify repository state before editing.'}));
    return {ok: true, project_id, mission_id, role, provider: candidate.name, model: candidate.model, content: outcome.output.content, usage: outcome.usage, attempts,
      ...(denials.length ? {budget_denials: denials} : {}), ...(warnings.length ? {memory_warnings: warnings} : {}), ...(request_id ? {request_id} : {})};
  }

  /** Independent reviewers on distinct targets, observed diversity and an optional synthesis. */
  consensus(args = {}) {
    return runConsensus(this, args);
  }

  /** Up to seven specialists in parallel, then one integrating reviewer. */
  swarmRun(args = {}) {
    return runSwarm(this, args);
  }
}
