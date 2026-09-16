import {ToolError, abortError} from './errors.js';

/** In-process call limits, shared by delegates, swarms, retries and health checks. */
export class ConcurrencyLimiter {
  constructor(maxTotal, maxPerTarget, maxQueue = 32) {
    this.maxTotal = Math.max(1, Math.floor(maxTotal));
    this.maxPerTarget = Math.max(1, Math.floor(maxPerTarget));
    this.maxQueue = Math.max(1, Math.floor(maxQueue));
    this.active = 0;
    this.byTarget = new Map();
    this.queue = [];
  }

  /** A queued call whose signal aborts leaves the queue; an admitted call observes the signal itself. */
  async run(key, operation, signal) {
    if (signal?.aborted) throw abortError(signal);
    if (this.queue.length >= this.maxQueue) throw new ToolError('queue_full', 'Delegation queue is full; retry later');
    await new Promise((resolve, reject) => {
      const onAbort = () => {
        const index = this.queue.indexOf(item);
        if (index < 0) return;
        this.queue.splice(index, 1);
        reject(abortError(signal));
      };
      const item = {key, resolve: () => { signal?.removeEventListener('abort', onAbort); resolve(); }};
      signal?.addEventListener('abort', onAbort, {once: true});
      this.queue.push(item);
      this.drain();
    });
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
