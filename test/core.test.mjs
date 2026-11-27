import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BulkheadPool } from '../server/pool.js';
import { CircuitBreaker } from '../server/circuitBreaker.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('连接池：P0 必要请求在优先级队列中先于 P2 出队', async () => {
  const pool = new BulkheadPool('order', { size: 1 });
  const holder = await pool.acquire({ priority: 1, timeoutMs: 2000 });

  const order = [];
  const p2 = pool.acquire({ priority: 2, timeoutMs: 2000 }).then((h) => {
    order.push('p2');
    return h;
  });
  // acquire 的执行器同步完成入队，因此下一行再放入 P0 也能插队到 P2 前面
  const p0 = pool.acquire({ priority: 0, timeoutMs: 2000 }).then((h) => {
    order.push('p0');
    return h;
  });

  holder.release();
  const h0 = await p0;
  assert.deepEqual(order, ['p0'], 'P0 应先被授予连接');
  h0.release();

  const h2 = await p2;
  assert.deepEqual(order, ['p0', 'p2']);
  h2.release();
  assert.equal(pool.active, 0);
});

test('连接池：同优先级保持 FIFO', async () => {
  const pool = new BulkheadPool('x', { size: 1 });
  const holder = await pool.acquire({});
  const order = [];
  const a = pool.acquire({ priority: 1 }).then((h) => {
    order.push('a');
    return h;
  });
  const b = pool.acquire({ priority: 1 }).then((h) => {
    order.push('b');
    return h;
  });
  holder.release();
  const ha = await a;
  ha.release();
  const hb = await b;
  hb.release();
  assert.deepEqual(order, ['a', 'b']);
});

test('连接池：排队超时抛 pool_queue 分类，且不占用连接', async () => {
  const pool = new BulkheadPool('x', { size: 1 });
  const holder = await pool.acquire({ timeoutMs: 5000 });
  await assert.rejects(
    () => pool.acquire({ priority: 2, timeoutMs: 40 }),
    (e) => e.code === 'POOL_QUEUE_TIMEOUT' && e.failureClass === 'pool_queue' && e.countedAsDownstreamFailure === false,
  );
  assert.equal(pool.queued, 0);
  assert.equal(pool.metrics.queueTimeouts, 1);
  holder.release();
  assert.equal(pool.active, 0);
});

test('熔断器：连续真实失败达到阈值才 OPEN，OPEN 后直接拒绝', () => {
  const b = new CircuitBreaker('x', 'X', { failureThreshold: 3, successThreshold: 2, cooldownMs: 1000 });
  b.recordFailure();
  b.recordFailure();
  assert.equal(b.state, 'closed');
  b.recordFailure();
  assert.equal(b.state, 'open');
  assert.equal(b.allow(), false);
  assert.equal(b.snapshot().failureStreak >= 3, true);
});

test('熔断器防振荡：半开后单次成功不闭合，连续 successThreshold 次才 CLOSED', async () => {
  const b = new CircuitBreaker('x', 'X', { failureThreshold: 1, successThreshold: 2, cooldownMs: 20 });
  b.recordFailure();
  assert.equal(b.state, 'open');

  await sleep(30);
  assert.equal(b.allow(), true); // 冷却结束 -> HALF_OPEN，拿到唯一探测槽
  assert.equal(b.state, 'half_open');
  assert.equal(b.allow(), false, '探测在途时其他请求必须被快速降级');

  b.recordSuccess();
  assert.equal(b.state, 'half_open', '单次成功不能恢复');
  b.releaseProbeSlot();

  assert.equal(b.allow(), true);
  b.recordSuccess();
  assert.equal(b.state, 'closed', '连续 2 次探测成功才闭合');
});

test('熔断器防振荡：半开探测失败立即重开且冷却指数加倍', async () => {
  const b = new CircuitBreaker('x', 'X', {
    failureThreshold: 1,
    successThreshold: 2,
    cooldownMs: 40,
    maxCooldownMs: 5000,
    backoffFactor: 2,
  });
  b.recordFailure();
  assert.equal(b.state, 'open');
  const firstCooldown = b.currentCooldownMs;

  await sleep(50);
  assert.equal(b.allow(), true);
  b.recordFailure(); // 探测失败 -> reopen
  assert.equal(b.state, 'open');
  assert.ok(b.currentCooldownMs > firstCooldown, `冷却应加倍：${firstCooldown} -> ${b.currentCooldownMs}`);
  assert.equal(b.currentCooldownMs, firstCooldown * 2);
});

test('熔断器：CLOSED 下成功会清零失败连击', () => {
  const b = new CircuitBreaker('x', 'X', { failureThreshold: 3 });
  b.recordFailure();
  b.recordFailure();
  b.recordSuccess();
  b.recordFailure();
  b.recordFailure();
  assert.equal(b.state, 'closed', '成功清零后，2 次新失败不应打开');
  b.recordFailure();
  assert.equal(b.state, 'open');
});
