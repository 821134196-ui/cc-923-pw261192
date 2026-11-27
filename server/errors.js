// 不同失败来源用类型严格区分。
// failureClass:
//   downstream —— 已经从连接池拿到连接、请求确实到达下游后发生的失败/超时（真实下游问题）
//   pool_queue —— 请求还没拿到连接，在连接池队列里等待超时（池容量/排队问题，下游本身可能健康）
//   admission  —— 高压准入控制主动丢弃（保护核心请求）
//   breaker    —— 熔断器打开/半开期限流，请求根本没有发出去
export class DCError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'DCError';
    this.code = code;
    this.failureClass = extra.failureClass || 'unknown';
    Object.assign(this, extra);
  }
}

export class PoolQueueTimeoutError extends DCError {
  constructor(waitMs, timeoutMs) {
    super('POOL_QUEUE_TIMEOUT', `连接池排队超时：等待 ${Math.round(waitMs)}ms 超过预算 ${timeoutMs}ms（请求未到达下游）`, {
      failureClass: 'pool_queue',
      waitMs,
      timeoutMs,
      countedAsDownstreamFailure: false,
    });
    this.name = 'PoolQueueTimeoutError';
  }
}

export class LoadShedError extends DCError {
  constructor(message = '连接池压力过高，非必要请求被准入控制快速丢弃') {
    super('POOL_SHED', message, {
      failureClass: 'admission',
      countedAsDownstreamFailure: false,
    });
    this.name = 'LoadShedError';
  }
}

export class DownstreamError extends DCError {
  constructor(code, message, extra = {}) {
    super(code, message, { failureClass: 'downstream', countedAsDownstreamFailure: true, ...extra });
    this.name = 'DownstreamError';
  }
}

export class BreakerRejectedError extends DCError {
  constructor(state) {
    super(
      state === 'half_open' ? 'BREAKER_HALF_OPEN_BUSY' : 'BREAKER_OPEN',
      state === 'half_open' ? '熔断器半开：已有探测在途，本次请求直接降级' : '熔断器打开：停止调用下游，直接走降级',
      { failureClass: 'breaker', breakerState: state, countedAsDownstreamFailure: false },
    );
    this.name = 'BreakerRejectedError';
  }
}

// 给真实下游调用加超时；超时属于“请求到达下游后”的真实慢响应信号。
export function withTimeout(promiseFactory, ms, label = 'downstream') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new DownstreamError('DOWNSTREAM_TIMEOUT', `${label} 响应超时（>${ms}ms，请求已发出，属于真实下游变慢）`, {
          timeoutMs: ms,
        }),
      );
    }, ms);
  });
  return Promise.race([Promise.resolve().then(promiseFactory), timeout]).finally(() => clearTimeout(timer));
}
