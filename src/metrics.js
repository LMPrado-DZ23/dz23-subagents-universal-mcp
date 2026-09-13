const EWMA_ALPHA = 0.3;

function seriesKey(name, labels) {
  const entries = Object.entries(labels || {}).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b));
  return entries.length ? `${name}{${entries.map(([k, v]) => `${k}="${String(v).replace(/["\\\n]/g, '_')}"`).join(',')}}` : name;
}

/**
 * Process-local metrics. Label values must have bounded cardinality (tool, kind,
 * provider:model, status); never use prompts, ids or free text as labels.
 */
export class Metrics {
  constructor({clock = Date.now} = {}) {
    this.clock = clock;
    this.startedAt = clock();
    this.counters = new Map();
    this.summaries = new Map();
    this.gauges = new Map();
    this.latency = new Map();
  }

  increment(name, labels, amount = 1) {
    const key = seriesKey(name, labels);
    this.counters.set(key, (this.counters.get(key) || 0) + amount);
  }

  observe(name, value, labels) {
    if (!Number.isFinite(value)) return;
    const key = seriesKey(name, labels);
    const s = this.summaries.get(key) || {count: 0, sum: 0, min: Infinity, max: -Infinity};
    s.count++; s.sum += value; s.min = Math.min(s.min, value); s.max = Math.max(s.max, value);
    this.summaries.set(key, s);
  }

  gauge(name, read) {
    this.gauges.set(name, read);
  }

  /** Exponentially weighted latency per routing target, used by latency_optimized routing. */
  recordLatency(target, ms) {
    const current = this.latency.get(target);
    this.latency.set(target, current ? {ewma: current.ewma + EWMA_ALPHA * (ms - current.ewma), samples: current.samples + 1} : {ewma: ms, samples: 1});
  }

  latencyOf(target) {
    return this.latency.get(target)?.ewma ?? null;
  }

  counter(name, labels) {
    return this.counters.get(seriesKey(name, labels)) || 0;
  }

  snapshot() {
    const gauges = {};
    for (const [name, read] of this.gauges) {
      try { gauges[name] = read(); } catch { gauges[name] = null; }
    }
    const summaries = {};
    for (const [key, s] of this.summaries) summaries[key] = {count: s.count, sum: s.sum, min: s.min, max: s.max, avg: s.count ? s.sum / s.count : 0};
    const latency = {};
    for (const [target, value] of this.latency) latency[target] = {ewma_ms: Math.round(value.ewma), samples: value.samples};
    return {scope: 'process', uptime_ms: this.clock() - this.startedAt, counters: Object.fromEntries(this.counters), summaries, gauges, latency_ewma: latency};
  }
}
