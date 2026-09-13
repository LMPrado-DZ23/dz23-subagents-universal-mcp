import {ToolError} from './errors.js';
import {targetKey} from './targets.js';

const SPREAD_STRATEGIES = new Set(['round_robin', 'provider_diversity', 'model_diversity']);
const byProvider = target => target.name;
const byModel = target => target.model;

export function distinctCount(items, keyFn) {
  return new Set(items.map(keyFn)).size;
}

function firstOfEach(items, keyFn) {
  const seen = new Set();
  return items.filter(item => {
    const key = keyFn(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function interleave(targets, keyFn) {
  const groups = new Map();
  for (const target of targets) {
    const key = keyFn(target);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(target);
  }
  const lists = [...groups.values()];
  const out = [];
  for (let round = 0; out.length < targets.length; round++) {
    for (const list of lists) if (list[round]) out.push(list[round]);
  }
  return out;
}

function compare(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

const priceScore = price => (price ? price.input_per_million_usd + price.output_per_million_usd : Infinity);
const cycle = (pool, count) => Array.from({length: count}, (_, i) => pool[i % pool.length]);

/** Stable ordering for a strategy. Unknown prices or latencies keep rotation order, after known values. */
export function orderTargets(targets, strategy, {priceOf = () => null, latencyOf = () => null} = {}) {
  switch (strategy) {
    case 'provider_diversity': return interleave(targets, byProvider);
    case 'model_diversity': return interleave(targets, byModel);
    case 'cost_optimized': return [...targets].sort((a, b) => compare(priceScore(priceOf(a)), priceScore(priceOf(b))));
    case 'latency_optimized': return [...targets].sort((a, b) => compare(latencyOf(a) ?? Infinity, latencyOf(b) ?? Infinity));
    default: return [...targets];
  }
}

/**
 * Assign `count` calls to eligible targets. `distinctOnly` never repeats a target (consensus).
 * Diversity is never promised: the plan reports the requested and effective strategy,
 * planned distinct providers/models and warnings. `strict` fails before any call.
 */
export function planRouting({targets, count, strategy = 'first', minDistinctProviders, minDistinctModels, strict = false, distinctOnly = false, priceOf = () => null, latencyOf = () => null}) {
  const ordered = orderTargets(targets, strategy, {priceOf, latencyOf});
  const warnings = [];
  const problems = [];
  let effective = strategy;
  if (strategy === 'cost_optimized' && !ordered.some(target => priceOf(target))) {
    warnings.push('cost_optimized: no configured prices; rotation order used');
    effective = 'first';
  }
  if (strategy === 'latency_optimized' && !ordered.some(target => latencyOf(target) !== null && latencyOf(target) !== undefined)) {
    warnings.push('latency_optimized: no latency samples yet; rotation order used');
    effective = 'first';
  }
  const spread = distinctOnly || SPREAD_STRATEGIES.has(strategy);
  let pool = spread ? ordered : ordered.slice(0, 1);
  const initialPoolSize = pool.length;
  const size = () => (distinctOnly ? Math.min(count, pool.length) : count);
  const constraints = [[minDistinctProviders, byProvider, 'min_distinct_providers'], [minDistinctModels, byModel, 'min_distinct_models']];
  for (const [min, keyFn] of constraints) {
    if (!min || min < 2 || !pool.length) continue;
    const wanted = Math.min(min, count, distinctCount(ordered, keyFn));
    if (distinctCount(cycle(pool, size()), keyFn) >= wanted) continue;
    const representatives = firstOfEach(spread ? pool : ordered, keyFn).slice(0, wanted);
    pool = spread
      ? [...representatives, ...pool.filter(item => !representatives.includes(item))]
      : [...pool, ...representatives.filter(rep => !pool.some(item => keyFn(item) === keyFn(rep)))];
  }
  const assignments = pool.length ? cycle(pool, size()) : [];
  for (const [min, keyFn, label] of constraints) {
    if (!min || min < 2) continue;
    const planned = distinctCount(assignments, keyFn);
    if (planned < min) problems.push(`${label}: ${min} requested but only ${planned} planned (${distinctCount(ordered, keyFn)} eligible, ${assignments.length} calls)`);
  }
  const plannedTargets = distinctCount(assignments, targetKey);
  const plannedProviders = distinctCount(assignments, byProvider);
  const plannedModels = distinctCount(assignments, byModel);
  if (SPREAD_STRATEGIES.has(strategy) && plannedTargets <= 1) effective = 'first';
  else if (!SPREAD_STRATEGIES.has(strategy) && pool.length > initialPoolSize) effective = 'round_robin';
  else if (strategy === 'provider_diversity' && plannedProviders < 2) effective = 'round_robin';
  else if (strategy === 'model_diversity' && plannedModels < 2) effective = 'round_robin';
  const routing = {
    requested_strategy: strategy, effective_strategy: effective, eligible_targets: ordered.length, planned_calls: assignments.length,
    planned_distinct_providers: plannedProviders, planned_distinct_models: plannedModels, warnings: [...warnings, ...problems]
  };
  if (distinctOnly && pool.length < count) routing.warnings.push(`only ${pool.length} distinct eligible targets for ${count} requested calls`);
  if (strict && problems.length) throw new ToolError('diversity_unavailable', 'Requested routing diversity cannot be planned with the eligible targets', {routing});
  return {assignments, routing};
}

/** Add the diversity actually observed in successful results. */
export function observeRouting(routing, results) {
  const ok = results.filter(result => result.ok);
  const observed = {...routing, distinct_providers: distinctCount(ok, r => r.provider), distinct_models: distinctCount(ok, r => r.model), warnings: [...routing.warnings]};
  if (ok.length && (observed.distinct_providers < routing.planned_distinct_providers || observed.distinct_models < routing.planned_distinct_models)) {
    observed.warnings.push('failures or failover reduced the observed diversity below the plan');
  }
  return observed;
}

/** Prefer a reviewer target not used by any successful worker, in strategy order. */
export function pickReviewer(targets, usedKeys, strategy = 'first', helpers = {}) {
  const ordered = orderTargets(targets, strategy, helpers);
  const fresh = ordered.find(target => !usedKeys.has(targetKey(target)));
  if (fresh) return {target: fresh, shares_worker_target: false};
  return {target: ordered[0] || null, shares_worker_target: Boolean(ordered[0])};
}
