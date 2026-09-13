/** Token and cost accounting helpers. Estimates are heuristics and always labeled as such. */

export const roundUsd = value => Math.round(value * 1e8) / 1e8;

/** Rough estimate (~4 characters per token). Used only when a provider reports no usage. */
export const estimateTokens = text => Math.ceil(String(text ?? '').length / 4);

export function emptyUsage() {
  return {calls: 0, failed_calls: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0, cost_usd: 0, unknown_cost_calls: 0};
}

const count = value => (Number.isFinite(value) && value >= 0 ? value : null);

/** Normalize OpenAI-compatible and Anthropic usage objects; null when nothing usable is reported. */
export function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  let input = count(raw.prompt_tokens);
  if (input === null && count(raw.input_tokens) !== null) {
    input = raw.input_tokens + (count(raw.cache_creation_input_tokens) ?? 0) + (count(raw.cache_read_input_tokens) ?? 0);
  }
  const output = count(raw.completion_tokens) ?? count(raw.output_tokens);
  if (input === null && output === null) return null;
  const inputTokens = input ?? 0;
  const outputTokens = output ?? 0;
  return {input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: count(raw.total_tokens) ?? inputTokens + outputTokens, reported_cost_usd: count(raw.cost)};
}

/** Add one usage record to running totals. Failed calls count as calls, never as unknown-cost spend. */
export function addUsage(totals, record) {
  const next = {...emptyUsage(), ...(totals || {})};
  next.calls += 1;
  if (record.status !== 'success') next.failed_calls += 1;
  next.input_tokens += record.input_tokens || 0;
  next.output_tokens += record.output_tokens || 0;
  next.total_tokens += record.total_tokens || 0;
  if (record.estimated_cost_usd === null || record.estimated_cost_usd === undefined) {
    if (record.status === 'success') next.unknown_cost_calls += 1;
  } else {
    next.cost_usd = roundUsd(next.cost_usd + record.estimated_cost_usd);
  }
  return next;
}
