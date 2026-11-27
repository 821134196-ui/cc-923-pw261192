import { BulkheadPool } from './pool.js';
import { CircuitBreaker } from './circuitBreaker.js';
import { DownstreamError } from './errors.js';
import { config, PRIORITY } from './config.js';
import { generateData } from './mockData.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// id 同时作为路由 /api/... 与故障注入的 key。
export const DOWNSTREAM_DEFS = [
  {
    id: 'user',
    name: '用户服务',
    priority: PRIORITY.P0,
    essential: true,
    poolSize: 4,
    latencyMs: 55,
    jitterMs: 50,
    desc: '账户资料，必要请求，高压时最后才允许受影响',
  },
  {
    id: 'order',
    name: '订单服务',
    priority: PRIORITY.P0,
    essential: true,
    poolSize: 3,
    latencyMs: 70,
    jitterMs: 60,
    desc: '订单查询，必要请求，使用最长排队预算与优先出队',
  },
  {
    id: 'product',
    name: '商品服务',
    priority: PRIORITY.P1,
    essential: false,
    poolSize: 4,
    latencyMs: 60,
    jitterMs: 60,
    desc: '商品详情，普通请求，允许短暂排队后走缓存',
  },
  {
    id: 'inventory',
    name: '库存服务',
    priority: PRIORITY.P1,
    essential: false,
    poolSize: 3,
    latencyMs: 80,
    jitterMs: 70,
    desc: '库存查询，普通请求，典型的缓存兜底场景',
  },
  {
    id: 'recommend',
    name: '推荐服务',
    priority: PRIORITY.P2,
    essential: false,
    dispensable: true,
    poolSize: 2,
    latencyMs: 90,
    jitterMs: 80,
    desc: '个性化推荐，非必要模块，高压时最先被限流丢弃',
  },
];

export const FAULT_PRESETS = {
  healthy: { label: '正常', patch: { down: false, latencyMs: null, jitterMs: null, errorRate: 0, poolSize: null } },
  slow: { label: '变慢（排队）', patch: { down: false, latencyMs: 1000, jitterMs: 120, errorRate: 0, poolSize: 2 } },
  timeout: { label: '严重超时', patch: { down: false, latencyMs: 2600, jitterMs: 200, errorRate: 0, poolSize: 3 } },
  error: { label: '真实报错', patch: { down: false, latencyMs: 40, jitterMs: 30, errorRate: 1, poolSize: 4 } },
  down: { label: '宕机拒连', patch: { down: true, latencyMs: 0, jitterMs: 0, errorRate: 0, poolSize: 4 } },
  pressure: { label: '极限高压', patch: { down: false, latencyMs: 3000, jitterMs: 200, errorRate: 0, poolSize: 1 } },
};

class Downstream {
  constructor(def) {
    this.def = def;
    this.id = def.id;
    this.name = def.name;
    this.resetFault();
    this.pool = new BulkheadPool(def.id, { size: def.poolSize });
    this.breaker = new CircuitBreaker(def.id, def.name);
    this.metrics = {
      calls: 0, // 真正到达模拟下游的调用
      successes: 0,
      downstreamFailures: 0, // 真实下游失败/超时（喂给熔断器）
      lastLatencyMs: 0,
      maxLatencyMs: 0,
      totalLatencyMs: 0,
    };
    this.queueTimeoutAt = [];
  }

  resetFault() {
    this.fault = {
      mode: 'healthy',
      down: false,
      latencyMs: this.def.latencyMs,
      jitterMs: this.def.jitterMs,
      errorRate: 0,
      preset: 'healthy',
    };
  }

  applyFaultPatch(patch = {}) {
    if (patch.preset && FAULT_PRESETS[patch.preset]) {
      const p = FAULT_PRESETS[patch.preset].patch;
      this.fault.preset = patch.preset;
      this.fault.mode = patch.preset;
      for (const [k, v] of Object.entries(p)) {
        if (v === null) {
          // null 表示恢复为定义默认值（latency/jitter）或默认池大小
          if (k === 'latencyMs') this.fault.latencyMs = this.def.latencyMs;
          else if (k === 'jitterMs') this.fault.jitterMs = this.def.jitterMs;
          else if (k === 'poolSize') this.pool.setSize(this.def.poolSize);
        } else if (k === 'poolSize') {
          this.pool.setSize(v);
        } else {
          this.fault[k] = v;
        }
      }
    }
    // 细粒度控件 / 任意 JSON patch
    for (const k of ['down', 'latencyMs', 'jitterMs', 'errorRate', 'mode']) {
      if (patch[k] !== undefined) this.fault[k] = patch[k];
    }
    if (patch.poolSize !== undefined && !patch.preset) this.pool.setSize(patch.poolSize);
    if (!patch.preset) this.fault.preset = 'custom';
    if (this.fault.errorRate > 0 || this.fault.down) this.fault.mode = this.fault.down ? 'down' : 'error';
    else if (this.fault.latencyMs >= 900) this.fault.mode = 'slow';
    else this.fault.mode = 'healthy';
    return this.faultSnapshot();
  }

  faultSnapshot() {
    return { ...this.fault, presets: Object.fromEntries(Object.entries(FAULT_PRESETS).map(([k, v]) => [k, v.label])) };
  }

  noteQueueTimeout() {
    const now = Date.now();
    this.queueTimeoutAt.push(now);
    this.prunePressure(now);
  }

  prunePressure(now = Date.now()) {
    this.queueTimeoutAt = this.queueTimeoutAt.filter((t) => now - t < 3000);
  }

  // 压力分级（只反映连接池拥塞，不代表下游真实成败）：
  //  critical  -> 非必要 P2 请求直接准入丢弃（L3）
  //  contention -> 已有排队 / 近期排队超时，低优先级缩短等待
  //  normal
  pressureSnapshot(poolSnap, now = Date.now()) {
    this.prunePressure(now);
    const recentCritical = this.queueTimeoutAt.filter((t) => now - t <= config.pressure.recentWindowMs).length;
    let level = 'normal';
    if (recentCritical >= config.pressure.criticalRecentTimeouts || poolSnap.queued >= poolSnap.size + 1) {
      level = 'critical';
    } else if (poolSnap.queued > 0 || this.queueTimeoutAt.length > 0) {
      level = 'contention';
    }
    return {
      level,
      recentQueueTimeouts: this.queueTimeoutAt.length,
      criticalThreshold: config.pressure.criticalRecentTimeouts,
    };
  }

  // 真正调用“下游”。只有拿到连接后才会执行到这里。
  async invokeDownstream(payload = {}) {
    this.metrics.calls += 1;
    if (this.fault.down) {
      this.metrics.downstreamFailures += 1;
      throw new DownstreamError('DOWNSTREAM_UNAVAILABLE', `${this.name} 连接被拒绝（ECONNREFUSED），下游实例不可用`, {
        syscall: 'connect',
      });
    }
    const jitter = this.fault.jitterMs ? Math.random() * this.fault.jitterMs : 0;
    const delay = Math.max(0, Number(this.fault.latencyMs) + jitter);
    const t0 = Date.now();
    await sleep(delay);
    const latency = Date.now() - t0;
    this.metrics.lastLatencyMs = latency;
    this.metrics.totalLatencyMs += latency;
    this.metrics.maxLatencyMs = Math.max(this.metrics.maxLatencyMs, latency);

    if (this.fault.errorRate > 0 && Math.random() < this.fault.errorRate) {
      this.metrics.downstreamFailures += 1;
      throw new DownstreamError('DOWNSTREAM_ERROR', `${this.name} 返回 HTTP 500（注入错误率 ${this.fault.errorRate}）`, {
        httpStatus: 500,
      });
    }
    this.metrics.successes += 1;
    return generateData(this.id, payload);
  }

  resetAll() {
    this.resetFault();
    this.pool = new BulkheadPool(this.id, { size: this.def.poolSize });
    this.breaker = new CircuitBreaker(this.id, this.name);
    this.metrics = {
      calls: 0,
      successes: 0,
      downstreamFailures: 0,
      lastLatencyMs: 0,
      maxLatencyMs: 0,
      totalLatencyMs: 0,
    };
    this.queueTimeoutAt = [];
  }

  snapshot() {
    const pool = this.pool.snapshot();
    return {
      id: this.id,
      name: this.name,
      desc: this.def.desc,
      essential: !!this.def.essential,
      dispensable: !!this.def.dispensable,
      defaultPriority: this.def.priority,
      fault: this.faultSnapshot(),
      pool,
      pressure: this.pressureSnapshot(pool),
      breaker: this.breaker.snapshot(),
      metrics: {
        ...this.metrics,
        avgLatencyMs: this.metrics.successes
          ? Math.round(this.metrics.totalLatencyMs / this.metrics.successes)
          : 0,
      },
    };
  }
}

export const downstreams = new Map(DOWNSTREAM_DEFS.map((d) => [d.id, new Downstream(d)]));

export function getDownstream(id) {
  return downstreams.get(id);
}

export function listDownstreams() {
  return [...downstreams.values()];
}
