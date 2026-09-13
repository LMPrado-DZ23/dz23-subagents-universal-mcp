import {COST_POLICIES} from './constants.js';
import {ToolError, ConfigError} from './errors.js';
import {estimateTokens, normalizeUsage, emptyUsage, roundUsd} from './usage.js';

const PRICE_KEY = /^[a-z0-9][a-z0-9_-]{0,39}:(?:\*|\S{1,200})$/;
const DEFAULT_BUDGET = Object.freeze({
  missionCostUsd: null, projectCostUsd: null, dailyCostUsd: null, callCostUsd: null,
  missionTokens: null, missionCalls: null, inputTokens: null, policy: 'allow_unknown_cost', prices: {}
});

/** {"prices": {"provider:model"|"provider:*": {"input_per_million_usd": n, "output_per_million_usd": n}}} */
export function parsePriceTable(value, label = 'price table') {
  const table = value && typeof value === 'object' && 'prices' in value ? value.prices : value;
  if (!table || typeof table !== 'object' || Array.isArray(table)) throw new ConfigError(`${label} must map provider:model keys to prices`);
  const out = {};
  for (const [key, price] of Object.entries(table)) {
    if (!PRICE_KEY.test(key)) throw new ConfigError(`${label} keys must be provider:model or provider:*`);
    const input = price?.input_per_million_usd;
    const output = price?.output_per_million_usd;
    if (![input, output].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0)) {
      throw new ConfigError(`${label} entry ${key} needs non-negative input_per_million_usd and output_per_million_usd`);
    }
    out[key] = {input_per_million_usd: input, output_per_million_usd: output};
  }
  return out;
}

class Mutex {
  constructor() { this.tail = Promise.resolve(); }
  run(fn) {
    const result = this.tail.then(fn, fn);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

function budgetExceeded(limit, details) {
  return new ToolError('budget_exceeded', `Budget limit reached: ${limit}`, {limit, ...details});
}

/**
 * Pre-call admission and post-call settlement of token/cost budgets.
 * Admission and settlement run under one in-process mutex, so concurrent workers in
 * this process see each other's reservations. Separate processes sharing a state
 * directory do not share reservations and can overshoot by their in-flight calls.
 */
export class BudgetLedger {
  constructor(cfg, memory, {clock = Date.now, metrics = null} = {}) {
    const provided = cfg.budget || {};
    const costLimits = ['missionCostUsd', 'projectCostUsd', 'dailyCostUsd', 'callCostUsd'].some(key => provided[key] !== null && provided[key] !== undefined);
    // With cost limits, calls of unknown cost would escape them: fail closed unless a policy is set explicitly.
    this.limits = {...DEFAULT_BUDGET, ...provided, policy: provided.policy || (costLimits ? 'deny_unknown_cost' : 'allow_unknown_cost')};
    if (!COST_POLICIES.includes(this.limits.policy)) throw new ConfigError(`DZ23_COST_POLICY must be one of: ${COST_POLICIES.join(', ')}`);
    this.memory = memory;
    this.clock = clock;
    this.metrics = metrics;
    this.reserved = new Map();
    this.mutex = new Mutex();
  }

  priceFor(target) {
    return this.limits.prices[`${target.name}:${target.model}`] || this.limits.prices[`${target.name}:*`] || null;
  }

  estimateCost(target, inputTokens, outputTokens) {
    const price = this.priceFor(target);
    return price ? roundUsd((inputTokens * price.input_per_million_usd + outputTokens * price.output_per_million_usd) / 1e6) : null;
  }

  day() {
    return new Date(this.clock()).toISOString().slice(0, 10);
  }

  reservedFor(key) {
    return this.reserved.get(key) || {calls: 0, tokens: 0, cost: 0};
  }

  /**
   * Returns {reservation} when the call may proceed, {denied} when this target is not
   * allowed (another target might be), or throws budget_exceeded/input_too_large when
   * no target can proceed.
   */
  admit({project_id, mission_id, target, messages, maxOutputTokens, scope = 'mission'}) {
    return this.mutex.run(async () => {
      const limits = this.limits;
      const inputTokens = estimateTokens(messages.map(message => String(message.content ?? '')).join('\n'));
      if (limits.inputTokens !== null && inputTokens > limits.inputTokens) {
        throw new ToolError('input_too_large', 'Estimated input tokens exceed DZ23_MAX_INPUT_TOKENS', {estimated_input_tokens: inputTokens, limit: limits.inputTokens});
      }
      const day = this.day();
      const checks = [{name: 'daily', key: `day:${day}`, used: (await this.memory.getDailyUsage(day)) || emptyUsage(), limit: limits.dailyCostUsd}];
      const requestedTokens = inputTokens + maxOutputTokens;
      if (scope === 'mission') {
        const mission = (await this.memory.getMission(project_id, mission_id))?.usage || emptyUsage();
        const project = (await this.memory.getProject(project_id))?.usage_totals || emptyUsage();
        const missionKey = `mission:${project_id}/${mission_id}`;
        const reserved = this.reservedFor(missionKey);
        if (limits.missionCalls !== null && mission.calls + reserved.calls + 1 > limits.missionCalls) {
          throw budgetExceeded('mission_calls', {used: mission.calls, reserved: reserved.calls, max: limits.missionCalls});
        }
        if (limits.missionTokens !== null && mission.total_tokens + reserved.tokens + requestedTokens > limits.missionTokens) {
          throw budgetExceeded('mission_tokens', {used: mission.total_tokens, reserved: reserved.tokens, requested: requestedTokens, max: limits.missionTokens});
        }
        checks.push({name: 'mission', key: missionKey, used: mission, limit: limits.missionCostUsd}, {name: 'project', key: `project:${project_id}`, used: project, limit: limits.projectCostUsd});
      }
      for (const check of checks) {
        if (check.limit !== null && check.used.cost_usd + this.reservedFor(check.key).cost >= check.limit) {
          throw budgetExceeded(`${check.name}_cost`, {used_usd: check.used.cost_usd, reserved_usd: this.reservedFor(check.key).cost, max_usd: check.limit});
        }
      }
      const estimatedCost = this.estimateCost(target, inputTokens, maxOutputTokens);
      if (estimatedCost === null && limits.policy === 'deny_unknown_cost') return {denied: 'unknown_cost'};
      if (estimatedCost !== null) {
        if (limits.callCostUsd !== null && estimatedCost > limits.callCostUsd) return {denied: 'call_cost_limit', estimated_cost_usd: estimatedCost};
        const over = checks.find(check => check.limit !== null && check.used.cost_usd + this.reservedFor(check.key).cost + estimatedCost > check.limit);
        if (over) return {denied: `${over.name}_cost_limit`, estimated_cost_usd: estimatedCost};
      }
      const reservation = {keys: checks.map(check => check.key), calls: 1, tokens: requestedTokens, cost: estimatedCost || 0, inputTokens, scope, released: false, record: null};
      for (const key of reservation.keys) {
        const current = this.reservedFor(key);
        this.reserved.set(key, {calls: current.calls + 1, tokens: current.tokens + reservation.tokens, cost: roundUsd(current.cost + reservation.cost)});
      }
      return {reservation, estimated_cost_usd: estimatedCost};
    });
  }

  release(reservation) {
    if (!reservation || reservation.released) return;
    reservation.released = true;
    for (const key of reservation.keys) {
      const current = this.reservedFor(key);
      const next = {calls: current.calls - 1, tokens: current.tokens - reservation.tokens, cost: roundUsd(current.cost - reservation.cost)};
      if (next.calls <= 0) this.reserved.delete(key); else this.reserved.set(key, next);
    }
  }

  buildRecord(reservation, {status, output, kind, target, role, request_id}) {
    const base = {schema: 1, at: new Date(this.clock()).toISOString(), provider: target.name, model: target.model, role, status, ...(request_id ? {request_id} : {}), ...(kind ? {kind} : {})};
    if (status !== 'success') {
      return {...base, input_tokens: 0, output_tokens: 0, total_tokens: 0, token_source: 'none', estimated_cost_usd: null, cost_source: 'unknown'};
    }
    const usage = normalizeUsage(output?.usage);
    const input = usage ? usage.input_tokens : reservation.inputTokens;
    const out = usage ? usage.output_tokens : estimateTokens(output?.content);
    const tokens = {input_tokens: input, output_tokens: out, total_tokens: usage ? usage.total_tokens : input + out, token_source: usage ? 'provider' : 'estimated'};
    if (usage?.reported_cost_usd !== null && usage?.reported_cost_usd !== undefined) {
      return {...base, ...tokens, estimated_cost_usd: roundUsd(usage.reported_cost_usd), cost_source: 'provider_usage'};
    }
    const cost = this.estimateCost(target, input, out);
    return {...base, ...tokens, estimated_cost_usd: cost, cost_source: cost === null ? 'unknown' : 'configured_price'};
  }

  /** Persist the usage record for a finished attempt (idempotent) and release its reservation. */
  settle(reservation, details) {
    if (reservation.record) return Promise.resolve(reservation.record);
    return this.mutex.run(async () => {
      if (reservation.record) return reservation.record;
      const record = this.buildRecord(reservation, details);
      try {
        if (reservation.scope === 'mission') await this.memory.recordUsage(details.project_id, details.mission_id, record);
        else await this.memory.recordSystemUsage(record);
        // Cache only after the write succeeded, so a failed write can be retried instead of silently lost.
        reservation.record = record;
      } finally {
        this.release(reservation);
      }
      this.metrics?.increment('usage_records_total', {status: record.status, cost_source: record.cost_source});
      this.metrics?.increment('tokens_total', {direction: 'input'}, record.input_tokens);
      this.metrics?.increment('tokens_total', {direction: 'output'}, record.output_tokens);
      if (record.estimated_cost_usd !== null) this.metrics?.increment('estimated_cost_usd_total', undefined, record.estimated_cost_usd);
      else if (record.status === 'success') this.metrics?.increment('unknown_cost_calls_total');
      return record;
    });
  }
}
