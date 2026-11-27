import { config, PRIORITY_LABEL, LEVEL_LABEL, SOURCE_LABEL } from './config.js';
import { getDownstream } from './downstreams.js';
import { SnapshotCache } from './cache.js';
import {
  BreakerRejectedError,
  LoadShedError,
  PoolQueueTimeoutError,
  withTimeout,
} from './errors.js';
import { fallbackData } from './mockData.js';
import { requestLog } from './events.js';

export const cache = new SnapshotCache(10_000);

let ridCounter = 0;
export function newRequestId(prefix = 'req') {
  ridCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${ridCounter}`;
}

export const REASON_LABEL = {
  breaker_open: '熔断器打开：真实失败已达阈值，直接降级',
  breaker_half_open: '熔断器半开：仅放行一个探测，其余请求快速降级',
  downstream_failure: '真实下游失败（5xx / 拒连），计入熔断',
  downstream_timeout: '真实下游处理超时（请求已到达下游），计入熔断',
  pool_queue_timeout: '连接池排队超时：未拿到连接、请求未到达下游，不计入熔断',
  admission_shed: '高压准入丢弃：主动牺牲非必要请求以保住必要请求',
};

function priorityBudget(priority) {
  if (priority === 0) return config.timeout.queueP0Ms;
  if (priority === 2) return config.timeout.queueP2Ms;
  return config.timeout.queueP1Ms;
}

function reasonOf(err) {
  if (!err) return null;
  if (err instanceof BreakerRejectedError) {
    return err.code === 'BREAKER_HALF_OPEN_BUSY' ? 'breaker_half_open' : 'breaker_open';
  }
  if (err instanceof PoolQueueTimeoutError) return 'pool_queue_timeout';
  if (err instanceof LoadShedError) return 'admission_shed';
  if (err.code === 'DOWNSTREAM_TIMEOUT') return 'downstream_timeout';
  if (err.failureClass === 'downstream') return 'downstream_failure';
  return err.code || 'unknown';
}

// 核心：一次“带多级降级的下游调用”。任何预期内故障都转成结构化 outcome，而不是抛异常。
export async function callWithDegradation(dsId, opts = {}) {
  const ds = getDownstream(dsId);
  if (!ds) throw new Error(`unknown downstream: ${dsId}`);

  const requestId = opts.requestId || newRequestId();
  const startedAt = Date.now();
  const priority = opts.priority ?? ds.def.priority;
  const breaker = ds.breaker;
  const pool = ds.pool;

  let queueWaitMs = null;
  let downstreamMs = null;
  let release = null;
  let ownsProbeSlot = false;
  let err = null;
  let level = 0;
  let servedBy = 'downstream';
  let data = null;
  let cacheMeta = null;
  let httpStatus = 200;

  try {
    // 1) 熔断器准入（手动探测可提前把 OPEN 推到 HALF_OPEN）
    if (opts.manualProbe && breaker.state === 'open') {
      const got = breaker.forceHalfOpen('页面手动触发立即探测');
      if (!got) throw new BreakerRejectedError('half_open');
      ownsProbeSlot = true;
    } else {
      const allowed = breaker.allow();
      if (!allowed) throw new BreakerRejectedError(breaker.state);
      // 只有本次调用自己拿到了半开探测槽，结束时才允许释放，避免误释放其他探测。
      ownsProbeSlot = breaker.state === 'half_open' && breaker.probeInFlight;
    }

    // 2) 高压准入控制：critical 压力下直接牺牲 P2 非必要请求（L3），不进入队列
    const pressureNow = ds.pressureSnapshot(pool.snapshot());
    if (priority >= 2 && pressureNow.level === 'critical' && !opts.manualProbe && opts.shed !== false) {
      throw new LoadShedError();
    }

    // 3) 连接池获取连接（可能按优先级插队 / 排队超时）
    const acquired = await pool.acquire({
      priority,
      timeoutMs: opts.queueTimeoutMs ?? priorityBudget(priority),
    });
    release = acquired.release;
    queueWaitMs = acquired.waitMs;

    // 4) 调用真实下游（拿到连接之后的超时才算真实下游慢）
    const tDown = Date.now();
    data = await withTimeout(
      () => ds.invokeDownstream(opts.payload || {}),
      opts.callTimeoutMs ?? config.timeout.downstreamCallMs,
      ds.name,
    );
    downstreamMs = Date.now() - tDown;

    breaker.recordSuccess();
    if (opts.cacheKey) cache.set(opts.cacheKey, data);
    level = 0;
    servedBy = 'downstream';
  } catch (e) {
    err = e;

    // 排队超时：记录压力信号，但【不】计入熔断器的真实失败
    if (e instanceof PoolQueueTimeoutError) ds.noteQueueTimeout();

    // 只有真实下游失败/超时才喂熔断器
    if (e.countedAsDownstreamFailure) breaker.recordFailure();

    // 降级路径选择
    const reason = reasonOf(e);
    if (reason === 'admission_shed') {
      // L3：高压下主动关闭非核心通道，不拿假数据掩盖
      level = 3;
      servedBy = 'shed';
      httpStatus = 503;
      data = null;
    } else {
      const cached = opts.cacheKey && opts.useCache !== false ? cache.get(opts.cacheKey) : null;
      if (cached) {
        level = 1;
        servedBy = 'cache';
        data = cached.data;
        cacheMeta = { savedAt: new Date(cached.savedAt).toISOString(), ageMs: cached.ageMs, stale: cached.stale };
        httpStatus = 200;
      } else if (opts.fallback !== undefined) {
        level = 2;
        servedBy = 'fallback';
        data = typeof opts.fallback === 'function' ? opts.fallback() : opts.fallback;
        httpStatus = 200;
      } else {
        level = 3;
        servedBy = 'shed';
        httpStatus = 503;
      }
    }
  } finally {
    if (release) release();
    if (ownsProbeSlot) breaker.releaseProbeSlot();
  }

  const totalMs = Date.now() - startedAt;
  const poolSnap = pool.snapshot();
  const outcome = {
    requestId,
    at: new Date().toISOString(),
    endpoint: opts.endpoint || null,
    kind: opts.kind || 'call',
    downstream: ds.id,
    downstreamName: ds.name,
    priority,
    priorityLabel: PRIORITY_LABEL[priority] || `P${priority}`,
    essential: !!ds.def.essential,
    ok: httpStatus < 400,
    httpStatus,
    level,
    levelLabel: LEVEL_LABEL[level],
    servedBy,
    sourceLabel: SOURCE_LABEL[servedBy] || servedBy,
    reason: err ? reasonOf(err) : null,
    reasonLabel: err ? REASON_LABEL[reasonOf(err)] || err.message : null,
    failureClass: err?.failureClass || 'none',
    countedAsDownstreamFailure: !!err?.countedAsDownstreamFailure,
    breakerState: breaker.state,
    timing: { totalMs, queueWaitMs, downstreamMs },
    pool: poolSnap,
    pressure: ds.pressureSnapshot(poolSnap),
    cache: cacheMeta,
    data,
    error: err ? { code: err.code || 'ERROR', message: err.message } : null,
    manualProbe: !!opts.manualProbe,
    probeSuccess: opts.manualProbe ? !err : undefined,
  };

  if (!opts.silent) requestLog.add(summarize(outcome));
  return outcome;
}

// 请求日志里只放摘要 + 完整 outcome 也保留（本地样例数据量小）。
export function summarize(o) {
  return {
    requestId: o.requestId,
    at: o.at,
    endpoint: o.endpoint,
    kind: o.kind,
    downstream: o.downstream,
    downstreamName: o.downstreamName,
    priority: o.priority,
    priorityLabel: o.priorityLabel,
    essential: o.essential,
    httpStatus: o.httpStatus,
    ok: o.ok,
    level: o.level,
    levelLabel: o.levelLabel,
    servedBy: o.servedBy,
    sourceLabel: o.sourceLabel,
    reason: o.reason,
    reasonLabel: o.reasonLabel,
    failureClass: o.failureClass,
    breakerState: o.breakerState,
    timing: o.timing,
    manualProbe: o.manualProbe,
    outcome: o,
  };
}

// ---- 具体接口定义 -------------------------------------------------------

export const ENDPOINTS = {
  user: {
    ds: 'user',
    priority: 0,
    cacheKey: (p) => `user:${p.id || 'u_1001'}`,
    payload: (p) => ({ id: p.id || 'u_1001' }),
    fallback: (p) => fallbackData('user', p),
  },
  orders: {
    ds: 'order',
    priority: 0,
    cacheKey: (p) => `order:${p.userId || 'u_1001'}`,
    payload: (p) => ({ userId: p.userId || 'u_1001' }),
    fallback: (p) => fallbackData('order', p),
  },
  product: {
    ds: 'product',
    priority: 1,
    cacheKey: (p) => `product:${p.id || 'p_88'}`,
    payload: (p) => ({ id: p.id || 'p_88' }),
    fallback: (p) => fallbackData('product', p),
  },
  inventory: {
    ds: 'inventory',
    priority: 1,
    cacheKey: (p) => `inventory:${p.sku || 'SKU-88-BLK'}`,
    payload: (p) => ({ sku: p.sku || 'SKU-88-BLK' }),
    fallback: (p) => fallbackData('inventory', p),
  },
  recommend: {
    ds: 'recommend',
    priority: 2,
    cacheKey: (p) => `recommend:${p.userId || 'u_1001'}`,
    payload: (p) => ({ userId: p.userId || 'u_1001' }),
    fallback: (p) => fallbackData('recommend', p),
  },
};

export async function callEndpoint(name, params = {}, options = {}) {
  const def = ENDPOINTS[name];
  if (!def) throw new Error(`unknown endpoint: ${name}`);
  return callWithDegradation(def.ds, {
    endpoint: options.endpointPath || `/api/${name}`,
    kind: name,
    priority: def.priority,
    cacheKey: def.cacheKey(params),
    payload: def.payload(params),
    fallback: () => def.fallback(params),
    ...options,
  });
}

// 首页聚合：三个板块互相隔离，各自走各自的降级，单下游故障不会拖垮整页。
export async function callHome(params = {}) {
  const aggregateId = newRequestId('home');
  const startedAt = Date.now();
  const userId = params.userId || 'u_1001';
  const sku = params.sku || 'SKU-88-BLK';

  const [user, inventory, recommend] = await Promise.all([
    callEndpoint('user', { id: userId }, { silent: true }),
    callEndpoint('inventory', { sku }, { silent: true }),
    callEndpoint('recommend', { userId }, { silent: true }),
  ]);

  const sections = { user, inventory, recommend };
  const level = Math.max(user.level, inventory.level, recommend.level);
  const allReal = level === 0;
  const outcome = {
    requestId: aggregateId,
    at: new Date().toISOString(),
    endpoint: '/api/home',
    kind: 'home',
    ok: true, // 聚合页始终可用（部分板块降级/关闭）
    httpStatus: 200,
    level,
    levelLabel: LEVEL_LABEL[level],
    servedBy: 'aggregate',
    sourceLabel: SOURCE_LABEL.aggregate,
    reason: allReal ? null : 'partial_degradation',
    reasonLabel: allReal ? null : '部分板块已独立降级，其他板块保持实时响应',
    failureClass: 'none',
    breakerState: 'mixed',
    timing: { totalMs: Date.now() - startedAt },
    data: { sections },
    sections,
  };
  requestLog.add(summarize(outcome));
  return outcome;
}
