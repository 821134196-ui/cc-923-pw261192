#!/usr/bin/env node
// 端到端核对：启动真实 HTTP 服务，验证
//  1) 基础实时响应 + 响应头
//  2) 单下游故障隔离
//  3) 连接池排队超时 与 真实下游失败 的分类差异 / 熔断差异
//  4) P0/P2 优先级保护
//  5) critical 压力下 P2 被 L3 丢弃
//  6) 熔断自动半开 -> 连续成功 -> 恢复，事件含恢复时刻/故障窗口
//  7) 页面与静态资源可访问
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, evidence = '') {
  if (cond) {
    pass += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    fail += 1;
    failures.push({ name, evidence });
    console.log(`  \x1b[31m✗ ${name}\x1b[0m`);
    if (evidence) console.log(`    \x1b[90m${String(evidence).split('\n').join('\n    ')}\x1b[0m`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

const port = process.env.VERIFY_PORT ? Number(process.env.VERIFY_PORT) : await getFreePort();
const base = `http://127.0.0.1:${port}`;

const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(port),
    DC_FAILURE_THRESHOLD: '3',
    DC_SUCCESS_THRESHOLD: '2',
    DC_COOLDOWN_MS: '250',
    DC_MAX_COOLDOWN_MS: '2000',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', (d) => (serverLog += d));
child.stderr.on('data', (d) => (serverLog += d));

async function req(p, options = {}) {
  const r = await fetch(base + p, options);
  const text = await r.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: r.status, body, headers: r.headers };
}
const post = (p, body) =>
  req(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
const get = (p) => req(p);

async function waitHealthy(deadlineMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < deadlineMs) {
    try {
      const r = await get('/health');
      if (r.status === 200 && r.body?.app) return true;
    } catch {}
    await sleep(100);
  }
  return false;
}

async function stateOf(id) {
  const s = (await get('/api/state')).body;
  return s.downstreams.find((d) => d.id === id);
}

try {
  console.log(`\n启动被测服务 on ${base} ...`);
  const healthy = await waitHealthy();
  check('服务启动并通过 /health', healthy, serverLog.slice(-800));
  if (!healthy) throw new Error('server did not start');

  console.log('\n[1] 健康基线');
  {
    const r = await get('/api/user/u_1001');
    check('用户接口 200 且 L0 真实下游', r.status === 200 && r.body.servedBy === 'downstream' && r.body.level === 0);
    check(
      '响应头标明 X-Served-By / X-Degradation-Level',
      r.headers.get('x-served-by') === 'downstream' && r.headers.get('x-degradation-level') === '0',
      `x-served-by=${r.headers.get('x-served-by')}`,
    );
  }

  console.log('\n[2] 单下游真实故障：推荐降级+熔断，用户接口不受影响');
  {
    await post('/api/downstreams/recommend/fault', { preset: 'error' });
    const recs = [];
    for (let i = 0; i < 4; i += 1) recs.push((await get('/api/recommend')).body);
    const degraded = recs.filter((x) => x.servedBy === 'cache' || x.servedBy === 'fallback').length;
    check('推荐连续失败后走缓存/兜底（≥3 次）', degraded >= 3, recs.map((x) => `${x.level}:${x.servedBy}/${x.reason}`).join('  '));
    const ds = await stateOf('recommend');
    check('推荐熔断器打开', ds.breaker.state === 'open', `state=${ds.breaker.state}`);

    const users = [];
    for (let i = 0; i < 3; i += 1) users.push((await get('/api/user/u_1001')).body);
    check(
      '故障期间用户接口 3/3 仍为真实响应（隔离）',
      users.every((u) => u.servedBy === 'downstream' && u.httpStatus === 200),
      users.map((u) => u.servedBy).join(','),
    );
    const product = (await get('/api/product/p_88')).body;
    check('商品接口同样不受波及', product.servedBy === 'downstream', product.servedBy);
  }

  console.log('\n[3] 自动半开探测 -> 连续成功 -> 恢复（防振荡 + 恢复时刻）');
  {
    await post('/api/downstreams/recommend/recover', {});
    let closed = null;
    let sawHalfOpenReal = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 5000) {
      const r = (await get('/api/recommend')).body;
      if (r.breakerState === 'half_open' && r.servedBy === 'downstream') sawHalfOpenReal = true;
      if (r.breakerState === 'closed' && r.servedBy === 'downstream') {
        closed = r;
        break;
      }
      await sleep(110);
    }
    check('观察到 half_open 探测成功但未立即闭合', sawHalfOpenReal);
    check('约 2 次连续探测后自动 CLOSED 并恢复 L0', !!closed, closed ? `request ${closed.requestId}` : 'timeout');
    const ev = (await get('/api/events')).body.events;
    const recovered = [...ev].reverse().find((e) => e.type === 'breaker_recovered' && e.downstream === 'recommend');
    check(
      '时间线记录 breaker_recovered 且含恢复时刻/故障窗口',
      !!recovered && Number.isFinite(recovered.downtimeMs) && recovered.downtimeMs >= 200,
      recovered ? `at=${recovered.iso} downtimeMs=${recovered.downtimeMs}` : 'no recovered event',
    );
  }

  console.log('\n[4] 连接池排队超时 区别于 真实下游失败');
  {
    await post('/api/reset', {});
    await post('/api/downstreams/product/fault', {
      down: false,
      latencyMs: 500,
      jitterMs: 0,
      errorRate: 0,
      poolSize: 1,
    });
    const burst = (
      await post('/api/burst', { downstream: 'product', count: 5, priority: 1, queueTimeoutMs: 150 })
    ).body;
    const q = burst.tally.byReason.pool_queue_timeout || 0;
    const real = burst.tally.byServedBy.downstream || 0;
    check('5 个突发：1 个真实返回，≥3 个 pool_queue_timeout', real === 1 && q >= 3, JSON.stringify(burst.tally));
    check(
      '排队超时的失败分类是 pool_queue 且不计入真实失败',
      burst.results
        .filter((r) => r.reason === 'pool_queue_timeout')
        .every((r) => r.failureClass === 'pool_queue' && r.countedAsDownstreamFailure === false),
    );
    const ds = await stateOf('product');
    check(
      '仅排队拥塞时熔断器保持 closed、真实失败计数=0',
      ds.breaker.state === 'closed' && ds.metrics.downstreamFailures === 0 && ds.pool.queueTimeouts >= 3,
      `breaker=${ds.breaker.state} dsfail=${ds.metrics.downstreamFailures} qtimeout=${ds.pool.queueTimeouts}`,
    );

    await post('/api/downstreams/product/fault', { preset: 'error' });
    const errs = [];
    for (let i = 0; i < 3; i += 1) errs.push((await get('/api/product/p_88')).body);
    const realFail = errs.filter((x) => x.reason === 'downstream_failure' && x.countedAsDownstreamFailure).length;
    const ds2 = await stateOf('product');
    check(
      `真实报错被标记 downstream_failure 并打开熔断器（${realFail}/3，state=${ds2.breaker.state}）`,
      realFail >= 2 && ds2.breaker.state === 'open' && ds2.metrics.downstreamFailures >= 3,
    );
  }

  console.log('\n[5] 优先级：同一连接池混合突发，P0 全部保住');
  {
    await post('/api/reset', {});
    await post('/api/downstreams/order/fault', {
      down: false,
      latencyMs: 300,
      jitterMs: 0,
      errorRate: 0,
      poolSize: 1,
    });
    const burst = (
      await post('/api/burst', {
        endpoint: 'orders',
        mix: [
          { priority: 2, count: 5, queueTimeoutMs: 120 },
          { priority: 0, count: 2, queueTimeoutMs: 3000 },
        ],
      })
    ).body;
    const p0 = burst.results.filter((r) => r.priority === 0);
    const p2 = burst.results.filter((r) => r.priority === 2);
    const p2Real = p2.filter((r) => r.servedBy === 'downstream').length;
    check('2/2 P0 必要请求拿到真实下游响应', p0.length === 2 && p0.every((r) => r.servedBy === 'downstream'));
    check(
      'P2 中至多 1 个（首个抢到空闲连接者）真实返回，其余 ≥4 个被排队/缓存/丢弃接管',
      p2.length === 5 && p2Real <= 1 && p2.length - p2Real >= 4,
      JSON.stringify(burst.tally.byServedBy),
    );
    check(
      'P0 以更短排队等待插队成功（均在 ~1s 内拿到连接）',
      p0.every((r) => r.timing.queueWaitMs != null && r.timing.queueWaitMs <= 700),
      p0.map((r) => `queueWait=${r.timing.queueWaitMs}ms`).join(', '),
    );
    check('tally.p0AllReal=true', burst.tally.p0AllReal === true);
  }

  console.log('\n[6] critical 压力下 P2 非必要请求被 L3 快速丢弃');
  {
    await post('/api/reset', {});
    await post('/api/downstreams/recommend/fault', {
      down: false,
      latencyMs: 800,
      jitterMs: 0,
      errorRate: 0,
      poolSize: 1,
    });
    const burst = (await post('/api/burst', { downstream: 'recommend', count: 6, priority: 2 })).body;
    const shed = burst.tally.byReason.admission_shed || 0;
    check(
      '至少 2 个 P2 请求 admission_shed / L3 / HTTP503',
      shed >= 2 &&
        burst.results
          .filter((r) => r.reason === 'admission_shed')
          .every((r) => r.level === 3 && r.servedBy === 'shed' && r.httpStatus === 503 && r.failureClass === 'admission'),
      JSON.stringify(burst.tally),
    );
  }

  console.log('\n[7] 首页聚合部分降级 + 页面资源');
  {
    await post('/api/reset', {});
    await post('/api/downstreams/recommend/fault', { preset: 'error' });
    for (let i = 0; i < 3; i += 1) await get('/api/recommend');
    const home = (await get('/api/home?userId=u_1001')).body;
    check(
      '/api/home 始终 200，且推荐板块降级、用户板块实时（聚合内隔离）',
      home.httpStatus === 200 &&
        home.sections.user.servedBy === 'downstream' &&
        home.sections.recommend.servedBy !== 'downstream',
      `user=${home.sections.user.servedBy} recommend=${home.sections.recommend.servedBy}`,
    );
    const page = await req('/');
    check('页面 HTML 可访问且包含演练台节点', typeof page.body === 'string' && page.body.includes('ds-grid') && page.body.includes('drill-panel'));
    const appjs = await req('/app.js');
    check('/app.js 静态资源 200', appjs.status === 200);
  }
} catch (e) {
  check('核对过程未抛出异常: ' + e.message, false, e.stack);
} finally {
  child.kill('SIGTERM');
  await sleep(150);
  try {
    child.kill('SIGKILL');
  } catch {}
}

console.log(`\n结果：\x1b[32m${pass} 通过\x1b[0m，\x1b[${fail ? '31' : '90'}m${fail} 失败\x1b[0m`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log(` - ${f.name}\n   ${f.evidence}`);
  console.log('\n--- server log (tail) ---\n' + serverLog.slice(-2000));
  process.exit(1);
}
console.log('全部核对通过 ✅');
process.exit(0);
