import {DEFAULT_COST_WEIGHTS} from './constants.js';
import {RateLimitError} from './errors.js';

/**
 * In-memory, per-process token buckets. Not distributed: every process (or container
 * replica) keeps its own counters. Buckets refill continuously over `windowMs`.
 */
export class RateLimiter {
  constructor({windowMs = 60_000, points = 120, toolPoints = 60, maxConcurrent = 4, weights = DEFAULT_COST_WEIGHTS, maxKeys = 10_000, now = Date.now} = {}) {
    this.windowMs = windowMs;
    this.points = points;
    this.toolPoints = toolPoints;
    this.maxConcurrent = maxConcurrent;
    this.weights = {...DEFAULT_COST_WEIGHTS, ...weights};
    this.maxKeys = maxKeys;
    this.now = now;
    this.buckets = new Map();
    this.active = new Map();
  }

  bucket(key, capacity) {
    const time = this.now();
    let entry = this.buckets.get(key);
    if (!entry) {
      entry = {tokens: capacity, updated: time};
      this.buckets.set(key, entry);
      if (this.buckets.size > this.maxKeys) this.buckets.delete(this.buckets.keys().next().value);
    } else {
      entry.tokens = Math.min(capacity, entry.tokens + (time - entry.updated) * capacity / this.windowMs);
      entry.updated = time;
    }
    return entry;
  }

  waitMs(entry, cost, capacity) {
    if (cost > capacity) return this.windowMs;
    return Math.ceil((cost - entry.tokens) * this.windowMs / capacity);
  }

  cost(costClass) {
    return this.weights[costClass] ?? this.weights.light;
  }

  /** Throw when `points` are not available, without consuming anything. */
  check(identity, points) {
    const entry = this.bucket(`id:${identity}`, this.points);
    if (entry.tokens < points) throw new RateLimitError(this.waitMs(entry, points, this.points), 'identity');
  }

  /** Charge `cost` points to the identity bucket and, when a tool is named, its tool bucket. */
  consume(identity, {tool, costClass = 'light', points} = {}) {
    const cost = points ?? this.cost(costClass);
    const overall = this.bucket(`id:${identity}`, this.points);
    const perTool = tool ? this.bucket(`tool:${identity}:${tool}`, this.toolPoints) : null;
    if (perTool && perTool.tokens < cost) throw new RateLimitError(this.waitMs(perTool, cost, this.toolPoints), 'tool');
    if (overall.tokens < cost) throw new RateLimitError(this.waitMs(overall, cost, this.points), 'identity');
    overall.tokens -= cost;
    if (perTool) perTool.tokens -= cost;
  }

  /** Reserve one concurrent slot for an expensive call; returns an idempotent release. */
  acquire(identity) {
    const current = this.active.get(identity) || 0;
    if (current >= this.maxConcurrent) throw new RateLimitError(1000, 'concurrency');
    this.active.set(identity, current + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.active.get(identity) || 1) - 1;
      if (remaining > 0) this.active.set(identity, remaining); else this.active.delete(identity);
    };
  }

  /** Tool admission used by HTTP: concurrency first, then points, so rejected calls cost nothing. */
  admitTool(identity, tool, costClass) {
    const release = costClass === 'light' ? () => {} : this.acquire(identity);
    try {
      this.consume(identity, {tool, costClass});
      return release;
    } catch (error) {
      release();
      throw error;
    }
  }
}
