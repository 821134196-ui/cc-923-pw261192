import { PoolQueueTimeoutError } from './errors.js';

// 每个下游一个独立连接池（舱壁隔离）：
//  - 最多 size 个“在途连接”，模拟下游客户端连接数限制；
//  - 连接占满后进入按优先级排序的等待队列（P0 必要请求插队靠前）；
//  - 排队超过该请求的 queueTimeoutMs -> PoolQueueTimeoutError。
//    此时请求从未到达下游，因此这是“连接池排队”信号，不是真实下游失败。
export class BulkheadPool {
  constructor(id, { size = 4 } = {}) {
    this.id = id;
    this.size = size;
    this.active = 0;
    this.waiters = [];
    this.metrics = {
      acquired: 0,
      queueTimeouts: 0,
      maxQueueWaitMs: 0,
      totalQueueWaitMs: 0,
      queueWaitSamples: 0,
    };
  }

  setSize(size) {
    this.size = Math.max(1, Math.floor(size));
    this._pump(); // 调大并发后立刻放行排队者
  }

  get queued() {
    return this.waiters.length;
  }

  // 返回到期 release()；排队超时会 reject PoolQueueTimeoutError。
  acquire({ priority = 1, timeoutMs = 600 } = {}) {
    return new Promise((resolve, reject) => {
      const enqueuedAt = Date.now();
      const waiter = { priority, enqueuedAt, timeoutMs, timer: null, settled: false };

      const cleanup = () => {
        if (waiter.timer) clearTimeout(waiter.timer);
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
      };

      waiter.timer = setTimeout(() => {
        if (waiter.settled) return;
        waiter.settled = true;
        cleanup();
        this.metrics.queueTimeouts += 1;
        reject(new PoolQueueTimeoutError(Date.now() - enqueuedAt, timeoutMs));
      }, timeoutMs);

      waiter.grant = () => {
        if (waiter.settled) return;
        waiter.settled = true;
        if (waiter.timer) clearTimeout(waiter.timer);
        const waitMs = Date.now() - enqueuedAt;
        this.metrics.totalQueueWaitMs += waitMs;
        this.metrics.queueWaitSamples += 1;
        this.metrics.maxQueueWaitMs = Math.max(this.metrics.maxQueueWaitMs, waitMs);
        this.active += 1;
        this.metrics.acquired += 1;
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          this.active -= 1;
          this._pump();
        };
        resolve({ release, waitMs });
      };

      // 数字小 = 优先级高；同优先级 FIFO（按入队顺序，数组顺序即顺序）。
      let insertAt = this.waiters.length;
      for (let i = 0; i < this.waiters.length; i += 1) {
        if (priority < this.waiters[i].priority) {
          insertAt = i;
          break;
        }
      }
      this.waiters.splice(insertAt, 0, waiter);
      this._pump();
    });
  }

  _pump() {
    while (this.active < this.size && this.waiters.length > 0) {
      const next = this.waiters.shift();
      if (!next || next.settled) continue;
      next.grant();
    }
  }

  snapshot() {
    return {
      size: this.size,
      active: this.active,
      queued: this.queued,
      available: Math.max(0, this.size - this.active),
      acquired: this.metrics.acquired,
      queueTimeouts: this.metrics.queueTimeouts,
      maxQueueWaitMs: this.metrics.maxQueueWaitMs,
      avgQueueWaitMs: this.metrics.queueWaitSamples
        ? Math.round(this.metrics.totalQueueWaitMs / this.metrics.queueWaitSamples)
        : 0,
    };
  }
}
