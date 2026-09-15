import {parseTarget} from './providers.js';
import {isPrivateEndpoint} from './endpoints.js';

export {isPrivateEndpoint} from './endpoints.js';

export const targetKey = target => `${target.name}:${target.model}`;

const PAID_TIERS = Object.freeze(['paid', 'low-cost']);

export function tierRank(tier) {
  return ({local: 0, 'free-tier': 1, mixed: 2, 'low-cost': 3, paid: 4})[tier] ?? 9;
}

/**
 * Mixed-tier providers bill some models and not others, and their tier is per provider. Without
 * DZ23_ALLOW_PAID only models the operator declared free may run: an OpenRouter-style `:free` model id
 * or an exact `provider:model` entry in DZ23_FREE_MODELS.
 */
export function isDeclaredFree(target, cfg) {
  return String(target.model || '').endsWith(':free') || (cfg.freeModels || []).includes(targetKey(target));
}

function costReason(target, cfg) {
  if (cfg.allowPaid) return null;
  if (PAID_TIERS.includes(target.tier)) return 'paid_not_allowed';
  if (target.tier === 'mixed' && !isDeclaredFree(target, cfg)) return 'mixed_not_allowed';
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
  return Boolean(cfg.rotation?.length) || (target.location === 'local' && isPrivateEndpoint(target.baseURL)) || Boolean(cfg.allowPaid) || target.model === target.defaultModel;
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
  if ((cfg.policy || 'free-first') === 'free-first') eligible.sort((a, b) => tierRank(a.tier) - tierRank(b.tier));
  return eligible;
}

/** Every configured rotation entry (or enabled default model) with its eligibility reason, for diagnostics. */
export function targetReport(cfg, registry) {
  const configured = cfg.rotation?.length
    ? cfg.rotation
    : Object.values(registry).filter(x => x.enabled && x.defaultModel).map(x => `${x.name}:${x.defaultModel}`);
  return configured.map(entry => {
    const target = withRotationOptIn(parseTarget(entry, registry), cfg);
    return {target: targetKey(target), tier: target.tier, eligible: isEligible(target, cfg), reason: ineligibleReason(target, cfg)};
  });
}
