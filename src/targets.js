import {parseTarget} from './providers.js';
import {isPrivateEndpoint} from './endpoints.js';

export {isPrivateEndpoint} from './endpoints.js';

export const targetKey = target => `${target.name}:${target.model}`;

const PAID_TIERS = Object.freeze(['paid', 'low-cost']);

export function tierRank(tier) {
  return ({local: 0, 'free-tier': 1, mixed: 2, 'low-cost': 3, paid: 4})[tier] ?? 9;
}

/**
 * Tier of one provider:model. Tiers are per provider, except that a local adapter serving an Ollama-style
 * `:cloud` / `-cloud` model runs that model remotely on someone's account, so it is mixed, not local.
 */
export function effectiveTier(target) {
  return target.location === 'local' && /[:-]cloud$/i.test(String(target.model || '')) ? 'mixed' : target.tier;
}

/**
 * Mixed-tier providers bill some models and not others. Without DZ23_ALLOW_PAID only models the operator declared
 * free may run: an exact `provider:model` entry in DZ23_FREE_MODELS, or an OpenRouter `:free` model (the suffix only
 * means "free" on OpenRouter; on other providers or gateways it is an arbitrary alias).
 */
export function isDeclaredFree(target, cfg) {
  if ((cfg.freeModels || []).includes(targetKey(target))) return true;
  return target.name === 'openrouter' && String(target.model || '').endsWith(':free');
}

function costReason(target, cfg) {
  if (cfg.allowPaid) return null;
  const tier = effectiveTier(target);
  if (PAID_TIERS.includes(tier)) return 'paid_not_allowed';
  if (tier === 'mixed' && !isDeclaredFree(target, cfg)) return 'mixed_not_allowed';
  return null;
}

/** Enabled, complete, and allowed by the paid, low-cost and mixed-tier policy. */
export function isEligible(target, cfg) {
  return Boolean(target.enabled && target.baseURL && target.model) && !costReason(target, cfg);
}

/** Stable, non-sensitive reason why a target is not eligible, or null. */
export function ineligibleReason(target, cfg) {
  if (!target.enabled) return target.location === 'local' ? 'local_endpoint_not_configured' : 'missing_credential';
  if (!target.baseURL) return 'missing_base_url';
  if (!target.model) return 'missing_model';
  return costReason(target, cfg);
}

/**
 * Without an explicit DZ23_ROTATION, only a provider's default model may be selected explicitly
 * (local servers excepted) unless paid use is enabled: tier is per provider, not per model, so an
 * arbitrary model on a mixed-tier provider could otherwise bypass the paid policy.
 */
export function modelAllowed(target, cfg) {
  const privateEndpoint = target.privateEndpoint ?? isPrivateEndpoint(target.baseURL);
  return Boolean(cfg.rotation?.length) || (target.location === 'local' && privateEndpoint) || Boolean(cfg.allowPaid) || target.model === target.defaultModel;
}

/**
 * Local default endpoints (11434, 1234, 8000) are never targets by accident. A local provider
 * counts as configured when its env is set or when DZ23_ROTATION names it explicitly.
 */
export function withRotationOptIn(target, cfg) {
  if (target.enabled || target.location !== 'local') return target;
  return (cfg.rotation || []).some(entry => entry.split(':')[0] === target.name) ? {...target, enabled: true} : target;
}

/** Rotation from DZ23_ROTATION (or every enabled default model), filtered and ordered by policy. */
export function eligibleTargets(cfg, registry) {
  const configured = cfg.rotation?.length
    ? cfg.rotation
    : Object.values(registry).filter(x => x.enabled && x.defaultModel).map(x => `${x.name}:${x.defaultModel}`);
  const eligible = configured.map(entry => withRotationOptIn(parseTarget(entry, registry), cfg)).filter(t => isEligible(t, cfg));
  if ((cfg.policy || 'free-first') === 'free-first') eligible.sort((a, b) => tierRank(effectiveTier(a)) - tierRank(effectiveTier(b)));
  return eligible;
}

/** Every configured rotation entry (or enabled default model) with its eligibility reason, for diagnostics. */
export function targetReport(cfg, registry) {
  const configured = cfg.rotation?.length
    ? cfg.rotation
    : Object.values(registry).filter(x => x.enabled && x.defaultModel).map(x => `${x.name}:${x.defaultModel}`);
  return configured.map(entry => {
    const target = withRotationOptIn(parseTarget(entry, registry), cfg);
    return {target: targetKey(target), tier: effectiveTier(target), eligible: isEligible(target, cfg), reason: ineligibleReason(target, cfg)};
  });
}
