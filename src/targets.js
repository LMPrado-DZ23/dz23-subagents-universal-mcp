import net from 'node:net';
import {parseTarget} from './providers.js';

export const targetKey = target => `${target.name}:${target.model}`;

export function tierRank(tier) {
  return ({local: 0, 'free-tier': 1, mixed: 2, 'low-cost': 3, paid: 4})[tier] ?? 9;
}

/** Enabled, complete, and allowed by the paid/low-cost policy. */
export function isEligible(target, cfg) {
  return Boolean(target.enabled && target.baseURL && target.model) && (cfg.allowPaid || !['paid', 'low-cost'].includes(target.tier));
}

/** Stable, non-sensitive reason why a target is not eligible, or null. */
export function ineligibleReason(target, cfg) {
  if (!target.enabled) return target.location === 'local' ? 'local_endpoint_not_configured' : 'missing_credential';
  if (!target.baseURL) return 'missing_base_url';
  if (!target.model) return 'missing_model';
  if (!cfg.allowPaid && ['paid', 'low-cost'].includes(target.tier)) return 'paid_not_allowed';
  return null;
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
 * The local exemption follows the endpoint, not the provider name: CUSTOM_BASE_URL pointing at a public
 * API is not local. A loopback or private-network gateway that forwards to paid clouds still counts as
 * local, so such gateways should be used with DZ23_ROTATION.
 */
export function isPrivateEndpoint(baseURL) {
  let host;
  try { host = new URL(baseURL).hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch { return false; }
  if (!host) return false;
  const version = net.isIP(host);
  if (version === 4) {
    const [a, b] = host.split('.').map(Number);
    return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
  }
  if (version === 6) return host === '::1' || /^f[cd][0-9a-f]{2}:/.test(host);
  // Names: loopback, Docker's host alias, single-label LAN or compose service names (e.g. `ollama`) and mDNS `.local`.
  // Dotted public-looking names such as `10.0.0.1.evil.com` or `127.0.0.1.nip.io` are not private.
  return host === 'localhost' || host === 'host.docker.internal' || !host.includes('.') || host.endsWith('.local');
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
