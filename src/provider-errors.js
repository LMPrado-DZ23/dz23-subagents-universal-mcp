import {PROVIDER_ERROR_KINDS, RETRYABLE_KINDS} from './constants.js';

const BILLING = /billing|payment required|insufficient[ _](?:balance|funds|credits?)|credit balance is too low|add a payment method/;
// Bare "quota" is not enough: some providers mention quota on ordinary per-minute rate limits.
const QUOTA = /insufficient_quota|exceeded your current quota|quota (?:exceeded|exhausted|has been (?:exceeded|exhausted))|credits? (?:exhausted|depleted)|out of credits/;
const AUTH = /invalid[ _-]?(?:api[ _-]?key|token|credentials?)|incorrect api key|unauthori[sz]ed|authentication/;
const MODEL = /model[^.]{0,80}(?:not[ _-]?found|does not exist|unknown|not available|unsupported|decommissioned|deprecated)|no such model|model_not_found|invalid model|unknown model/;
const LEGACY_KINDS = {quota_or_rate_limit: 429, auth_or_entitlement: 401, model_or_endpoint_missing: 404};
// Size wording must name the context, the prompt/input or tokens: "temperature exceeds the maximum" or a
// "max_tokens exceeds the maximum allowed" parameter error is a request error, not a per-target size limit.
const CONTEXT = /maximum context length|context[ _-]?(?:length|window)[^.]{0,60}(?:exceed|too (?:long|large)|limit)|(?:prompt|input|messages?) (?:is |are )?too (?:long|large)|reduce the length of the (?:messages?|prompt|input)|(?:too many|exceeds?[^.]{0,40}) (?:input )?\btokens?\b[^.]{0,40}(?:context|limit|maximum|allowed)|input token count/;
const RATE = /rate[ _-]?limit|tokens? per minute|requests? per minute|\b[tr]pm\b/;
// A size complaint wins over a rate wording: Groq answers "Request too large ... tokens per minute (TPM)" when one
// request exceeds the per-minute budget, and retrying the same target can never succeed.
const TOO_LARGE = /too large|too long|requested \d+/;

/** Map an HTTP failure to a stable kind. The body is inspected, never stored or returned. */
export function classifyHttpFailure(status, body = '') {
  const text = String(body).slice(0, 8192).toLowerCase();
  if (status === 413) return RATE.test(text) && !TOO_LARGE.test(text) ? 'rate_limited' : 'context_length_exceeded';
  if (status === 402) return 'billing_required';
  if ([400, 403, 429].includes(status) && QUOTA.test(text)) return 'quota_exhausted';
  if (BILLING.test(text)) return 'billing_required';
  if (status === 429) return 'rate_limited';
  if (status === 401) return 'authentication_failed';
  if (status === 403) return AUTH.test(text) ? 'authentication_failed' : 'permission_denied';
  if (status === 404) return MODEL.test(text) ? 'model_not_found' : 'endpoint_not_found';
  if ((status === 400 || status === 422) && MODEL.test(text)) return 'model_not_found';
  if ((status === 400 || status === 422) && CONTEXT.test(text)) return 'context_length_exceeded';
  if (status === 408 || status === 504) return 'provider_timeout';
  if ([500, 502, 503, 529].includes(status)) return 'provider_unavailable';
  if (status >= 500) return 'provider_error';
  if ([400, 422].includes(status)) return 'invalid_request';
  return 'provider_error';
}

// A provider (or anything in front of it) must not be able to disable a target for days with one header.
export const MAX_RETRY_AFTER_MS = 60 * 60_000;

export function parseRetryAfter(value, now = Date.now()) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, Math.round(seconds * 1000)));
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(MAX_RETRY_AFTER_MS, Math.max(0, date - now)) : 0;
}

/**
 * Normalized provider failure. The message is built only from server-side facts
 * (provider, model, kind, status and a fixed detail) so raw bodies can never leak.
 */
export class ProviderError extends Error {
  constructor({kind, provider = 'provider', model = '', status, retryAfterMs = 0, detail}) {
    const safeKind = PROVIDER_ERROR_KINDS.includes(kind) ? kind : 'provider_error';
    super(`${provider}:${model} ${safeKind}${status ? ` HTTP ${status}` : ''}${detail ? `: ${detail}` : ''}`);
    this.name = 'ProviderError';
    this.kind = safeKind;
    this.retryable = RETRYABLE_KINDS.has(safeKind);
    this.retryAfterMs = Math.min(MAX_RETRY_AFTER_MS, Math.max(0, retryAfterMs || 0));
    this.provider = provider;
    this.model = model;
    if (status) this.status = status;
  }

  toJSON() {
    return {kind: this.kind, retryable: this.retryable, provider: this.provider, model: this.model,
      ...(this.status ? {http_status: this.status} : {}), ...(this.retryAfterMs ? {retry_after_ms: this.retryAfterMs} : {})};
  }
}

/** Normalize anything thrown by an adapter or injected caller into a ProviderError. */
export function toProviderError(error, target = {}) {
  if (error instanceof ProviderError) return error;
  const provider = target.name || error?.provider || 'provider';
  const model = target.model || error?.model || '';
  const status = Number.isInteger(error?.status) ? error.status : undefined;
  const retryAfterMs = error?.retryAfterMs || 0;
  if (PROVIDER_ERROR_KINDS.includes(error?.kind)) return new ProviderError({kind: error.kind, provider, model, status, retryAfterMs});
  if (error?.kind === 'configuration') return new ProviderError({kind: 'configuration_error', provider, model});
  const legacyStatus = status ?? LEGACY_KINDS[error?.kind];
  if (legacyStatus) return new ProviderError({kind: classifyHttpFailure(legacyStatus, error?.message), provider, model, status, retryAfterMs});
  return new ProviderError({kind: 'provider_error', provider, model});
}
