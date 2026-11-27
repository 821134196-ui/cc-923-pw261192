import { config } from './config.js';
import { bus } from './events.js';

export const BREAKER_STATE = { CLOSED: 'closed', OPEN: 'open', HALF_OPEN: 'half_open' };

// 带迟滞（hysteresis）的熔断器，防止恢复振荡：
//  - 连续 failureThreshold 次【真实下游失败】才 OPEN；
//  - OPEN 后等待 cooldown（反复振荡时指数退避）才允许探测；
//  - HALF_OPEN 下只放行单个探测，必须连续 successThreshold 次成功才 CLOSED；
//  - 探测期间任意一次失败立即重新 OPEN 并加倍冷却时间。
// 注意：连接池排队超时 / 主动丢弃不会调用 recordFailure，因此不会把熔断器顶开。
export class CircuitBreaker {
  constructor(id, label, opts = {}) {
    this.id = id;
    this.label = label;
    this.failureThreshold = opts.failureThreshold ?? config.breaker.failureThreshold;
    this.successThreshold = opts.successThreshold ?? config.breaker.successThreshold;
    this.cooldownMs = opts.cooldownMs ?? config.breaker.cooldownMs;
    this.maxCooldownMs = opts.maxCooldownMs ?? config.breaker.maxCooldownMs;
    this.backoffFactor = opts.backoffFactor ?? config.breaker.backoffFactor;
    this.resetState();
  }

  resetState() {
    this.state = BREAKER_STATE.CLOSED;
    this.failureStreak = 0;
    this.successStreak = 0;
    this.openedAt = null;
    this.closedAt = null;
    this.currentCooldownMs = this.cooldownMs;
    this.openEpisode = 0; // 连续“打开 episode”次数，用于指数退避
    this.probeInFlight = false;
    this.lastTransitionAt = Date.now();
  }

  // 返回是否允许本次调用（含 HALF_OPEN 探测槽控制）。
  allow(now = Date.now()) {
    if (this.state === BREAKER_STATE.CLOSED) return true;

    if (this.state === BREAKER_STATE.OPEN) {
      if (this.openedAt != null && now - this.openedAt >= this.currentCooldownMs) {
        this.toHalfOpen('冷却时间到，放行探测');
        return this.acquireProbeSlot();
      }
      return false;
    }

    // HALF_OPEN：只允许一个在途探测，其余请求直接降级，避免恢复期被流量打爆。
    return this.acquireProbeSlot();
  }

  acquireProbeSlot() {
    if (this.probeInFlight) return false;
    this.probeInFlight = true;
    return true;
  }

  releaseProbeSlot() {
    this.probeInFlight = false;
  }

  // 运维“立即探测”：不等冷却，手动把 OPEN 推到 HALF_OPEN。仍然受成功阈值约束。
  forceHalfOpen(reason = '手动触发立即探测') {
    if (this.state === BREAKER_STATE.OPEN) this.toHalfOpen(reason);
    return this.acquireProbeSlot();
  }

  recordSuccess() {
    if (this.state === BREAKER_STATE.HALF_OPEN) {
      this.successStreak += 1;
      if (this.successStreak >= this.successThreshold) {
        this.toClosed();
      }
      return;
    }
    // CLOSED 下成功调用逐渐清零失败连击（这里直接清零，连续阈值语义）。
    this.failureStreak = 0;
  }

  recordFailure() {
    if (this.state === BREAKER_STATE.HALF_OPEN) {
      // 探测失败 -> 立即重新打开，并延长冷却（防振荡退避）。
      this.toOpen('半开探测失败，重新熔断', true);
      return;
    }
    if (this.state === BREAKER_STATE.CLOSED) {
      this.failureStreak += 1;
      if (this.failureStreak >= this.failureThreshold) {
        this.toOpen(`连续 ${this.failureStreak} 次真实下游失败达到阈值`, false);
      }
    }
  }

  toHalfOpen(reason) {
    this.state = BREAKER_STATE.HALF_OPEN;
    this.successStreak = 0;
    this.lastTransitionAt = Date.now();
    bus.emit('breaker_half_open', {
      downstream: this.id,
      downstreamLabel: this.label,
      title: `${this.label} 熔断器进入半开（探测中）`,
      message: reason,
      detail: { successThreshold: this.successThreshold },
    });
  }

  toOpen(reason, reopen = false) {
    // reopen=true 表示 HALF_OPEN 探测失败 -> 同一轮故障的振荡，冷却翻倍。
    if (reopen) {
      this.openEpisode += 1;
      this.currentCooldownMs = Math.min(
        this.maxCooldownMs,
        Math.round(this.currentCooldownMs * this.backoffFactor),
      );
    } else {
      this.openEpisode = 1;
    }
    this.state = BREAKER_STATE.OPEN;
    this.openedAt = Date.now();
    this.lastTransitionAt = this.openedAt;
    this.successStreak = 0;
    this.probeInFlight = false;
    bus.emit(reopen ? 'breaker_reopen' : 'breaker_open', {
      downstream: this.id,
      downstreamLabel: this.label,
      title: reopen
        ? `${this.label} 探测失败，重新熔断（冷却延长至 ${this.currentCooldownMs}ms）`
        : `${this.label} 熔断器打开`,
      message: reason,
      detail: {
        failureStreak: this.failureStreak,
        cooldownMs: this.currentCooldownMs,
        openEpisode: this.openEpisode,
      },
    });
  }

  toClosed() {
    const openedAt = this.openedAt;
    const downtimeMs = openedAt ? Date.now() - openedAt : null;
    this.state = BREAKER_STATE.CLOSED;
    this.closedAt = Date.now();
    this.lastTransitionAt = this.closedAt;
    this.failureStreak = 0;
    this.successStreak = 0;
    this.probeInFlight = false;
    this.openedAt = null;
    this.currentCooldownMs = this.cooldownMs; // 确认真正恢复后才重置退避
    this.openEpisode = 0;
    bus.emit('breaker_recovered', {
      downstream: this.id,
      downstreamLabel: this.label,
      title: `${this.label} 已恢复（熔断器关闭）`,
      message: `连续 ${this.successThreshold} 次探测成功，恢复实时响应`,
      recoveredAt: this.closedAt,
      downtimeMs,
    });
  }

  snapshot(now = Date.now()) {
    let retryAfterMs = 0;
    if (this.state === BREAKER_STATE.OPEN && this.openedAt != null) {
      retryAfterMs = Math.max(0, this.currentCooldownMs - (now - this.openedAt));
    }
    return {
      state: this.state,
      failureStreak: this.failureStreak,
      successStreak: this.successStreak,
      failureThreshold: this.failureThreshold,
      successThreshold: this.successThreshold,
      cooldownMs: this.currentCooldownMs,
      baseCooldownMs: this.cooldownMs,
      retryAfterMs,
      openEpisode: this.openEpisode,
      probeInFlight: this.probeInFlight,
      openedAt: this.openedAt ? new Date(this.openedAt).toISOString() : null,
      lastTransitionAt: new Date(this.lastTransitionAt).toISOString(),
    };
  }
}
