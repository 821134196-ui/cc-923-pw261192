import { config } from './config.js';

// 内存事件时间线：熔断状态翻转、故障变更、恢复等都落在这里，供页面轮询核对“何时恢复”。
class EventBus {
  constructor(limit = config.eventLogLimit) {
    this.seq = 0;
    this.limit = limit;
    this.events = [];
  }

  emit(type, fields = {}) {
    const event = {
      seq: ++this.seq,
      t: Date.now(),
      iso: new Date().toISOString(),
      type,
      ...fields,
    };
    this.events.push(event);
    if (this.events.length > this.limit) this.events.splice(0, this.events.length - this.limit);
    return event;
  }

  since(seq = 0) {
    const n = Number(seq) || 0;
    return this.events.filter((e) => e.seq > n);
  }

  all() {
    return this.events.slice();
  }

  reset() {
    this.seq = 0;
    this.events = [];
    this.emit('system', { title: '状态已重置', message: '所有熔断器、指标与故障注入已恢复初始状态' });
  }
}

export const bus = new EventBus();

// 最近请求记录（环形），页面刷新后仍可核对“上一次用了哪种响应”。
class RequestLog {
  constructor(limit = config.requestLogLimit) {
    this.items = [];
    this.limit = limit;
  }

  add(summary) {
    this.items.unshift(summary);
    if (this.items.length > this.limit) this.items.length = this.limit;
  }

  list() {
    return this.items;
  }

  reset() {
    this.items = [];
  }
}

export const requestLog = new RequestLog();
