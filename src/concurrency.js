/** In-process call limits, shared by delegates, swarms, retries and health checks. */
export class ConcurrencyLimiter {
  constructor(maxTotal, maxPerTarget) {
    this.maxTotal = Math.max(1, Math.floor(maxTotal));
    this.maxPerTarget = Math.max(1, Math.floor(maxPerTarget));
    this.active = 0;
    this.byTarget = new Map();
    this.queue = [];
  }
  async run(key, operation) {
    await new Promise(resolve => { this.queue.push({key, resolve}); this.drain(); });
    try { return await operation(); }
    finally {
      this.active--;
      const remaining = this.byTarget.get(key) - 1;
      if (remaining) this.byTarget.set(key, remaining); else this.byTarget.delete(key);
      this.drain();
    }
  }
  drain() {
    for (let i = 0; i < this.queue.length && this.active < this.maxTotal;) {
      const item = this.queue[i];
      if ((this.byTarget.get(item.key) || 0) >= this.maxPerTarget) { i++; continue; }
      this.queue.splice(i, 1);
      this.active++;
      this.byTarget.set(item.key, (this.byTarget.get(item.key) || 0) + 1);
      item.resolve();
    }
  }
}
