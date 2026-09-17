import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {effectiveTier, targetKey, tierRank} from './targets.js';

// Adaptive routing: the server, not the harness, learns which free model answers each kind of task best.
// Observations never change cost policy: targets are only reordered inside the same effective tier.
export const TASK_TYPES = Object.freeze(['general', 'code', 'review', 'design', 'security', 'testing', 'ops', 'summary']);
const ROLE_TASK = Object.freeze({worker: 'general', architect: 'design', backend: 'code', frontend: 'code', security: 'security', qa: 'testing', devops: 'ops', reviewer: 'review'});
export const taskTypeOf = (role, explicit) => (TASK_TYPES.includes(explicit) ? explicit : ROLE_TASK[role] || 'general');

const MIN_SAMPLES = 3;
const LATENCY_SCALE_MS = 30_000;
const MAX_ENTRIES = 2000;
const SAVE_DELAY_MS = 2000;
const QUOTA_TTL_MS = 24 * 3600 * 1000;

function durationMs(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (/^\d+(\.\d+)?$/.test(text)) {
    const n = Number(text);
    return n > 1e12 ? n - Date.now() : n > 1e9 ? n * 1000 - Date.now() : n * 1000; // epoch ms, epoch s, or seconds
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) return Date.parse(text) - Date.now();
  let total = 0;
  let matched = false;
  for (const [, n, unit] of text.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    matched = true;
    total += Number(n) * {ms: 1, s: 1000, m: 60_000, h: 3_600_000}[unit];
  }
  return matched ? total : null;
}

/** Remaining requests/tokens advertised by provider headers (OpenAI, Groq, Cerebras, OpenRouter, Anthropic styles). */
export function parseRateLimits(headers, now = Date.now()) {
  if (!headers?.forEach) return null;
  const out = {};
  let resetMs = null;
  headers.forEach((value, name) => {
    const key = name.toLowerCase();
    if (!key.includes('ratelimit')) return;
    if (key.includes('reset')) { const ms = durationMs(value); if (ms !== null) resetMs = resetMs === null ? ms : Math.max(resetMs, ms); return; }
    if (!key.includes('remaining')) return;
    const n = Number(value);
    if (!Number.isFinite(n)) return;
    const field = key.includes('token') ? 'tokens_remaining' : 'requests_remaining';
    out[field] = out[field] === undefined ? n : Math.min(out[field], n);
  });
  if (!Object.keys(out).length) return null;
  return {...out, ...(resetMs !== null ? {reset_at: new Date(now + Math.max(0, resetMs)).toISOString()} : {}), observed_at: new Date(now).toISOString()};
}

export class RoutingStats {
  constructor({file = null, clock = Date.now, minSamples = MIN_SAMPLES} = {}) {
    this.file = file;
    this.clock = clock;
    this.minSamples = minSamples;
    this.entries = {};
    this.quotas = {};
    this.loaded = null;
    this.timer = null;
  }

  load() {
    if (!this.loaded) {
      this.loaded = this.file ? fs.readFile(this.file, 'utf8').then(text => {
        const data = JSON.parse(text);
        this.merge(data.entries || {}, data.quotas || {});
      }).catch(() => undefined) : Promise.resolve();
    }
    return this.loaded;
  }

  merge(entries, quotas) {
    for (const [key, entry] of Object.entries(entries)) if (!this.entries[key] || (entry.calls || 0) > (this.entries[key].calls || 0)) this.entries[key] = entry;
    for (const [key, quota] of Object.entries(quotas)) if (!this.quotas[key] || quota.observed_at > this.quotas[key].observed_at) this.quotas[key] = quota;
  }

  record(target, taskType, {ok, latencyMs, kind, rateLimits} = {}) {
    const tkey = targetKey(target);
    const key = `${tkey}|${taskType}`;
    const now = new Date(this.clock()).toISOString();
    const entry = this.entries[key] || {target: tkey, task_type: taskType, calls: 0, successes: 0, failures: {}};
    entry.calls++;
    if (ok) {
      entry.successes++;
      if (Number.isFinite(latencyMs)) entry.latency_ms = entry.latency_ms === undefined ? latencyMs : Math.round(entry.latency_ms + 0.3 * (latencyMs - entry.latency_ms));
      entry.last_success_at = now;
    } else {
      entry.failures[kind || 'provider_error'] = (entry.failures[kind || 'provider_error'] || 0) + 1;
      entry.last_failure_at = now;
    }
    this.entries[key] = entry;
    if (rateLimits) this.quotas[tkey] = rateLimits;
    const keys = Object.keys(this.entries);
    if (keys.length > MAX_ENTRIES) for (const old of keys.slice(0, keys.length - MAX_ENTRIES)) delete this.entries[old];
    this.scheduleSave();
  }

  entry(target, taskType) {
    return this.entries[`${typeof target === 'string' ? target : targetKey(target)}|${taskType}`] || null;
  }

  quota(target) {
    const quota = this.quotas[typeof target === 'string' ? target : targetKey(target)];
    if (!quota || this.clock() - Date.parse(quota.observed_at) > QUOTA_TTL_MS) return null;
    return quota;
  }

  quotaExhausted(target) {
    const quota = this.quota(target);
    if (!quota || (quota.requests_remaining !== 0 && quota.tokens_remaining !== 0)) return false;
    return !quota.reset_at || Date.parse(quota.reset_at) > this.clock();
  }

  /** Smoothed success rate times a latency factor; null until minSamples observations. */
  score(target, taskType) {
    const entry = this.entry(target, taskType);
    if (!entry || entry.calls < this.minSamples) return null;
    const success = (entry.successes + 1) / (entry.calls + 2);
    return Number((success / (1 + (entry.latency_ms ?? LATENCY_SCALE_MS) / LATENCY_SCALE_MS)).toFixed(4));
  }

  /** Reorders targets inside the same effective tier; tiers and policy order stay as the router decided. */
  order(targets, cfg = {}, taskType = 'general') {
    if (cfg.adaptiveRouting === false || (cfg.policy || 'free-first') !== 'free-first' || targets.length < 2) return targets;
    const neutral = 0.25;
    const ranked = targets.map((target, index) => ({target, index, tier: tierRank(effectiveTier(target)), exhausted: this.quotaExhausted(target), score: this.score(target, taskType) ?? neutral}));
    ranked.sort((a, b) => a.tier - b.tier || Number(a.exhausted) - Number(b.exhausted) || b.score - a.score || a.index - b.index);
    return ranked.map(item => item.target);
  }

  snapshot() {
    return {entries: Object.values(this.entries), quotas: this.quotas};
  }

  scheduleSave() {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.save().catch(() => undefined); }, SAVE_DELAY_MS);
    this.timer.unref?.();
  }

  async save() {
    if (!this.file) return;
    await this.load();
    await fs.mkdir(path.dirname(this.file), {recursive: true});
    const onDisk = await fs.readFile(this.file, 'utf8').then(JSON.parse).catch(() => ({}));
    this.merge(onDisk.entries || {}, onDisk.quotas || {});
    const tmp = `${this.file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({schema: 1, entries: this.entries, quotas: this.quotas}));
    await fs.rename(tmp, this.file);
  }

  async flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    await this.save();
  }
}

export function createRoutingStats(cfg = {}, {clock} = {}) {
  const stats = new RoutingStats({file: cfg.stateDir ? path.join(cfg.stateDir, 'providers', 'routing-stats.json') : null, clock});
  stats.load();
  return stats;
}
