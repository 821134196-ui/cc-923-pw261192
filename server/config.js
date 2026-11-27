// 全局配置：所有关键阈值都可用 DC_* 环境变量覆盖，方便自动化核对时压缩等待时间。
const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) && v !== '' ? n : d;
};

const list = (v, d) =>
  v ? String(v).split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n)) : d;

export const config = {
  appName: 'multilevel-degradation-sample',
  host: process.env.HOST || '0.0.0.0',
  // 默认同时监听多个常见端口，便于外部核对程序发现服务；设置 PORT 后只监听指定端口。
  ports: process.env.PORT ? [Number(process.env.PORT)] : list(process.env.PORTS, [3000, 8080, 8000]),
  logRequests: process.env.DC_LOG_REQUESTS === '1',

  breaker: {
    failureThreshold: num(process.env.DC_FAILURE_THRESHOLD, 3), // 连续真实失败次数 -> OPEN
    successThreshold: num(process.env.DC_SUCCESS_THRESHOLD, 2), // HALF_OPEN 连续成功次数 -> CLOSED（迟滞）
    cooldownMs: num(process.env.DC_COOLDOWN_MS, 4000), // OPEN 后多久允许自动探测
    maxCooldownMs: num(process.env.DC_MAX_COOLDOWN_MS, 20000), // 振荡重试时指数退避上限
    backoffFactor: num(process.env.DC_BACKOFF_FACTOR, 2),
  },

  timeout: {
    downstreamCallMs: num(process.env.DC_CALL_TIMEOUT_MS, 2000), // 拿到连接后，等待真实下游响应的超时
    queueP0Ms: num(process.env.DC_QUEUE_P0_MS, 4000), // 必要请求排队预算（受保护）
    queueP1Ms: num(process.env.DC_QUEUE_P1_MS, 600), // 普通请求排队预算
    queueP2Ms: num(process.env.DC_QUEUE_P2_MS, 220), // 可降级请求排队预算（最短，优先被牺牲）
  },

  pressure: {
    criticalRecentTimeouts: num(process.env.DC_CRITICAL_RECENT_TIMEOUTS, 2),
    recentWindowMs: num(process.env.DC_PRESSURE_WINDOW_MS, 2000),
  },

  requestLogLimit: 100,
  eventLogLimit: 300,
};

// 优先级约定：数字越小越重要。
export const PRIORITY = {
  P0: 0, // 必要请求（用户、订单）—— 绝不主动丢弃，长排队预算 + 优先出队
  P1: 1, // 普通请求（商品、库存）
  P2: 2, // 可降级请求（推荐、营销）—— 高压时首先被限流丢弃
};

export const PRIORITY_LABEL = {
  0: 'P0 必要',
  1: 'P1 普通',
  2: 'P2 可降级',
};

// 降级级别：0 实时 / 1 缓存 / 2 默认兜底 / 3 限流丢弃
export const LEVEL_LABEL = {
  0: 'L0 实时响应',
  1: 'L1 缓存降级',
  2: 'L2 默认兜底',
  3: 'L3 限流丢弃',
};

export const SOURCE_LABEL = {
  downstream: '真实下游',
  cache: '缓存响应',
  fallback: '默认兜底',
  shed: '快速丢弃',
  aggregate: '聚合响应',
};
