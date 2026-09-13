import {parseTarget} from './providers.js';

export const targetKey = target => `${target.name}:${target.model}`;

export function tierRank(tier) {
  return ({local: 0, 'free-tier': 1, mixed: 2, 'low-cost': 3, paid: 4})[tier] ?? 9;
}

/** Enabled, complete, and allowed by the paid/low-cost policy. */
export function isEligible(target, cfg) {
  return Boolean(target.enabled && target.baseURL && target.model) && (cfg.allowPaid || !['paid', 'low-cost'].includes(target.tier));
}

/** Rotation from DZ23_ROTATION (or every enabled default model), filtered and ordered by policy. */
export function eligibleTargets(cfg, registry) {
  const configured = cfg.rotation?.length
    ? cfg.rotation
    : Object.values(registry).filter(x => x.enabled && x.defaultModel).map(x => `${x.name}:${x.defaultModel}`);
  const eligible = configured.map(entry => parseTarget(entry, registry)).filter(t => isEligible(t, cfg));
  if ((cfg.policy || 'free-first') === 'free-first') eligible.sort((a, b) => tierRank(a.tier) - tierRank(b.tier));
  return eligible;
}
