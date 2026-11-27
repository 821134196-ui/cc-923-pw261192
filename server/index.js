import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

import { config, PRIORITY_LABEL, LEVEL_LABEL } from './config.js';
import { listDownstreams, getDownstream, FAULT_PRESETS } from './downstreams.js';
import { bus, requestLog } from './events.js';
import { cache, callWithDegradation, callEndpoint, callHome, ENDPOINTS, newRequestId } from './bff.js';
import { fallbackData, seedSnapshots } from './mockData.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// 预热“上次成功快照”，让缓存降级在第一次故障时就可演示
seedSnapshots(cache);
bus.emit('system', { type2: 'start', title: '样例服务已启动', message: '所有下游初始健康，缓存快照已预热' });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
    ...extraHeaders,
  });
  res.end(payload);
}

function outcomeHeaders(o) {
  if (!o || typeof o !== 'object') return {};
  return {
    'x-request-id': o.requestId || '',
    'x-served-by': o.servedBy || '',
    'x-degradation-level': String(o.level ?? ''),
    'x-failure-reason': o.reason || '',
    'x-failure-class': o.failureClass || '',
    'x-breaker-state': o.breakerState || '',
  };
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1_000_000) reject(new Error('body too large'));
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function publicState() {
  return {
    app: config.appName,
    now: new Date().toISOString(),
    labels: { priority: PRIORITY_LABEL, level: LEVEL_LABEL },
    config: {
      breaker: config.breaker,
      timeout: config.timeout,
      pressure: config.pressure,
    },
    endpoints: [
      { method: 'GET', path: '/api/user/:id', name: 'user', priority: 0, priorityLabel: PRIORITY_LABEL[0], essential: true, desc: '用户资料（必要）' },
      { method: 'GET', path: '/api/orders?userId=', name: 'orders', priority: 0, priorityLabel: PRIORITY_LABEL[0], essential: true, desc: '订单列表（必要）' },
      { method: 'GET', path: '/api/product/:id', name: 'product', priority: 1, priorityLabel: PRIORITY_LABEL[1], essential: false, desc: '商品详情' },
      { method: 'GET', path: '/api/inventory/:sku', name: 'inventory', priority: 1, priorityLabel: PRIORITY_LABEL[1], essential: false, desc: '库存查询（缓存兜底）' },
      { method: 'GET', path: '/api/recommend?userId=', name: 'recommend', priority: 2, priorityLabel: PRIORITY_LABEL[2], essential: false, desc: '个性化推荐（非必要）' },
      { method: 'GET', path: '/api/home', name: 'home', priority: null, essential: true, desc: '首页聚合：多板块独立降级' },
    ],
    downstreams: listDownstreams().map((d) => d.snapshot()),
  };
}

function resetAll() {
  for (const d of listDownstreams()) d.resetAll();
  cache.clear();
  seedSnapshots(cache);
  requestLog.reset();
  bus.reset();
}

// 服务端混合突发：在同一时刻向同一个下游连接池压入不同优先级请求，
// 用于确定性地验证“优先级插队 + 必要请求保住”。
async function handleBurst(body) {
  const count = Number(body.count) || 0;
  let specs = [];
  if (Array.isArray(body.calls) && body.calls.length) {
    specs = body.calls;
  } else if (Array.isArray(body.mix) && body.mix.length) {
    for (const m of body.mix) {
      for (let i = 0; i < (Number(m.count) || 0); i += 1) {
        specs.push({ priority: Number(m.priority) ?? 2, queueTimeoutMs: m.queueTimeoutMs });
      }
    }
  } else {
    for (let i = 0; i < Math.max(1, count || 6); i += 1) {
      specs.push({ priority: body.priority ?? 2 });
    }
  }

  const runOne = (spec, index) => {
    const priority = spec.priority ?? body.priority ?? 1;
    const queueTimeoutMs = spec.queueTimeoutMs ?? body.queueTimeoutMs;
    const common = {
      priority,
      queueTimeoutMs,
      callTimeoutMs: body.callTimeoutMs,
      requestId: newRequestId(`burst${index}`),
    };
    if (body.endpoint && ENDPOINTS[body.endpoint]) {
      return callEndpoint(body.endpoint, body.params || {}, common);
    }
    const dsId = body.downstream || 'product';
    return callWithDegradation(dsId, {
      ...common,
      endpoint: `/api/call/${dsId}`,
      kind: 'generic',
      cacheKey: `generic:${dsId}`,
      payload: body.payload || {},
      fallback: () => fallbackData(dsId, body.params || {}),
    });
  };

  // 关键：按 specs 顺序【同步发起】，保证它们以确定顺序进入同一个优先级队列。
  const tasks = specs.map((spec, i) => {
    if (body.staggerMs && i > 0) {
      return new Promise((r) => setTimeout(() => r(runOne(spec, i)), body.staggerMs * i));
    }
    return runOne(spec, i);
  });
  const results = await Promise.all(tasks);
  const tally = { total: results.length, byServedBy: {}, byReason: {}, byLevel: {}, p0AllReal: true };
  for (const r of results) {
    tally.byServedBy[r.servedBy] = (tally.byServedBy[r.servedBy] || 0) + 1;
    if (r.reason) tally.byReason[r.reason] = (tally.byReason[r.reason] || 0) + 1;
    tally.byLevel[r.level] = (tally.byLevel[r.level] || 0) + 1;
    if (r.priority === 0 && r.servedBy !== 'downstream') tally.p0AllReal = false;
  }
  return { requestId: newRequestId('burst'), tally, results };
}

async function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  try {
    const buf = await readFile(filePath);
    res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(buf);
  } catch {
    // 非 API 路径统一回退到单页
    try {
      const html = await readFile(path.join(PUBLIC_DIR, 'index.html'));
      res.writeHead(200, { 'content-type': MIME['.html'] });
      res.end(html);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  }
}

export function createHandler() {
  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;
    const query = Object.fromEntries(url.searchParams.entries());

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': 'content-type',
      });
      return res.end();
    }

    try {
      // ---- 基础 ----
      if (pathname === '/health' || pathname === '/api/health') {
        return sendJson(res, 200, { status: 'ok', app: config.appName, now: new Date().toISOString() });
      }
      if (pathname === '/api/state' || pathname === '/api/status') {
        return sendJson(res, 200, publicState());
      }
      if (pathname === '/api/events') {
        return sendJson(res, 200, { events: bus.since(query.sinceSeq || 0), seq: bus.seq });
      }
      if (pathname === '/api/requests') {
        return sendJson(res, 200, { items: requestLog.list() });
      }
      if (pathname === '/api/presets') {
        return sendJson(res, 200, { presets: FAULT_PRESETS });
      }

      // ---- 重置 ----
      if (req.method === 'POST' && pathname === '/api/reset') {
        resetAll();
        return sendJson(res, 200, { ok: true, state: publicState() });
      }

      // ---- 故障注入 / 恢复 / 探测 ----
      let m = pathname.match(/^\/api\/downstreams?\/([\w-]+)\/(fault|recover|probe)$/);
      if (m && req.method === 'POST') {
        const [, id, action] = m;
        const ds = getDownstream(id);
        if (!ds) return sendJson(res, 404, { ok: false, error: `unknown downstream ${id}` });
        const body = await readBody(req).catch(() => ({}));

        if (action === 'fault') {
          const snap = ds.applyFaultPatch(body || {});
          bus.emit('fault_change', {
            downstream: id,
            downstreamLabel: ds.name,
            title: `${ds.name} 故障注入：${snap.preset}`,
            message: `延迟=${snap.latencyMs}ms 错误率=${snap.errorRate} 宕机=${snap.down} 池大小=${ds.pool.size}`,
            detail: snap,
          });
          return sendJson(res, 200, { ok: true, downstream: ds.snapshot() });
        }
        if (action === 'recover') {
          ds.applyFaultPatch({ preset: 'healthy' });
          bus.emit('fault_change', {
            downstream: id,
            downstreamLabel: ds.name,
            title: `${ds.name} 故障已解除（等待熔断器探测恢复）`,
            message: '下游恢复健康，但熔断器仍需连续探测成功才会关闭（防振荡）',
          });
          return sendJson(res, 200, { ok: true, downstream: ds.snapshot() });
        }
        if (action === 'probe') {
          const o = await callWithDegradation(id, {
            manualProbe: true,
            priority: 0,
            endpoint: `/api/downstreams/${id}/probe`,
            kind: 'probe',
            cacheKey: `probe:${id}`,
            payload: {},
            fallback: () => fallbackData(id),
          });
          return sendJson(res, o.httpStatus, o, outcomeHeaders(o));
        }
      }

      // ---- 服务端混合突发 ----
      if (req.method === 'POST' && pathname === '/api/burst') {
        const body = await readBody(req).catch(() => ({}));
        const result = await handleBurst(body || {});
        return sendJson(res, 200, result);
      }

      // ---- 业务接口 ----
      const respondOutcome = (o) => sendJson(res, o.httpStatus, o, outcomeHeaders(o));

      if (pathname === '/api/home' && req.method === 'GET') {
        return respondOutcome(await callHome(query));
      }

      let em = pathname.match(/^\/api\/user(?:\/([\w-]+))?$/);
      if (em && req.method === 'GET') {
        return respondOutcome(await callEndpoint('user', { id: em[1] || query.id || 'u_1001' }));
      }
      em = pathname.match(/^\/api\/orders?$/);
      if (em && req.method === 'GET') {
        return respondOutcome(await callEndpoint('orders', { userId: query.userId || 'u_1001' }));
      }
      em = pathname.match(/^\/api\/product(?:s)?(?:\/([\w-]+))?$/);
      if (em && req.method === 'GET') {
        return respondOutcome(await callEndpoint('product', { id: em[1] || query.id || 'p_88' }));
      }
      em = pathname.match(/^\/api\/inventory(?:\/([\w-]+))?$/);
      if (em && req.method === 'GET') {
        return respondOutcome(await callEndpoint('inventory', { sku: em[1] || query.sku || 'SKU-88-BLK' }));
      }
      em = pathname.match(/^\/api\/recommend(?:s)?$/);
      if (em && req.method === 'GET') {
        return respondOutcome(await callEndpoint('recommend', { userId: query.userId || 'u_1001' }));
      }

      // 通用下游调用（可显式指定优先级，供核对脚本/混合演练使用）
      em = pathname.match(/^\/api\/call\/([\w-]+)$/);
      if (em && req.method === 'GET') {
        const id = em[1];
        if (!getDownstream(id)) return sendJson(res, 404, { ok: false, error: `unknown downstream ${id}` });
        const o = await callWithDegradation(id, {
          endpoint: pathname,
          kind: 'generic',
          priority: query.priority !== undefined ? Number(query.priority) : undefined,
          queueTimeoutMs: query.queueTimeoutMs ? Number(query.queueTimeoutMs) : undefined,
          cacheKey: `generic:${id}`,
          fallback: () => fallbackData(id),
        });
        return respondOutcome(o);
      }

      if (pathname.startsWith('/api/')) {
        return sendJson(res, 404, { ok: false, error: `no such api: ${req.method} ${pathname}` });
      }

      return await serveStatic(req, res, pathname);
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e?.message || String(e), stack: e?.stack });
    }
  };
}

async function isOurApp(port) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 800);
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: ctrl.signal });
    clearTimeout(t);
    const j = await r.json();
    return j?.app === config.appName;
  } catch {
    return false;
  }
}

function start() {
  const handler = createHandler();
  const ports = config.ports;
  let listening = 0;
  let occupiedOurs = 0;

  for (const port of ports) {
    const server = http.createServer(handler);
    server.on('error', async (e) => {
      if (e.code === 'EADDRINUSE') {
        if (await isOurApp(port)) {
          occupiedOurs += 1;
          // 已有一个本应用实例在跑（例如核对程序重复执行 npm start），安静退出成功。
          if (listening === 0 && occupiedOurs === ports.length) {
            console.log(`[degradation-demo] 已有实例运行在端口 ${ports.join(', ')}，直接复用。`);
            process.exit(0);
          }
        } else {
          console.warn(`[degradation-demo] 端口 ${port} 被其他程序占用，跳过。`);
        }
      } else {
        console.error(`[degradation-demo] 端口 ${port} 启动失败:`, e);
      }
    });
    server.listen(port, config.host, () => {
      listening += 1;
      const actualPort = server.address()?.port || port;
      console.log(`[degradation-demo] 多级降级样例服务已启动 (${config.host}:${actualPort}):`);
      console.log(`  页面:  http://localhost:${actualPort}/`);
      console.log(`  状态:  http://localhost:${actualPort}/api/state`);
      console.log(`  健康:  http://localhost:${actualPort}/health`);
    });
  }

  setTimeout(() => {
    if (listening === 0 && occupiedOurs === 0) {
      console.error('[degradation-demo] 没有任何端口可用，退出。');
      process.exit(1);
    }
  }, 1500).unref();
}

// 允许被 verify 脚本 import 而不自动监听
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start();
}
