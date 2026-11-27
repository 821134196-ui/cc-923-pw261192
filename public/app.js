/* 多级降级演练台前端逻辑：零依赖原生 JS */
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

async function api(path, options = {}) {
  const opts = { headers: {}, ...options };
  if (opts.body && typeof opts.body !== 'string') {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  const r = await fetch(path, opts);
  let json = null;
  try {
    json = await r.json();
  } catch {
    /* ignore */
  }
  if (!r.ok) {
    const err = new Error(json?.error || `HTTP ${r.status}`);
    err.status = r.status;
    err.body = json;
    throw err;
  }
  return json;
}

const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function fmtTime(iso) {
  const d = new Date(iso);
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

const BREAKER_TEXT = { closed: '闭合 · 正常', open: '打开 · 熔断', half_open: '半开 · 探测' };
const PRESSURE_TEXT = { normal: '连接池压力正常', contention: '存在排队 / 近期排队超时', critical: '严重拥塞：P2 请求将被直接丢弃(L3)' };
const PRESETS = [
  ['healthy', '正常'],
  ['slow', '变慢'],
  ['timeout', '严重超时'],
  ['error', '报错'],
  ['down', '宕机'],
  ['pressure', '极限高压'],
];

let state = null;
let lastSeq = 0;
let lastOutcome = null;
let gridInteracting = false;
let drillRunning = false;

/* ============================ 下游卡片 ============================ */

function dsCardHtml(d) {
  const b = d.breaker;
  const p = d.pressure;
  const cardCls = [
    'ds-card',
    b.state === 'open' ? 'is-open' : '',
    b.state === 'half_open' ? 'is-half' : '',
    p.level === 'critical' ? 'is-critical' : '',
  ].join(' ');

  const priorityTag = d.essential
    ? '<span class="tag p0">必要 P0</span>'
    : d.defaultPriority === 2
      ? '<span class="tag p2">可降级 P2</span>'
      : '<span class="tag p1">普通 P1</span>';

  const presetBtns = PRESETS.map(
    ([key, label]) =>
      `<button class="btn btn-mini ${d.fault.preset === key ? 'active' : ''}"
        data-action="preset" data-id="${d.id}" data-preset="${key}"
        data-testid="fault-${d.id}-${key}">${label}</button>`,
  ).join('');

  const cooldownHint =
    b.state === 'open'
      ? b.retryAfterMs > 0
        ? `自动探测倒计时 ${(b.retryAfterMs / 1000).toFixed(1)}s · 第 ${b.openEpisode} 轮`
        : '冷却结束，下一次请求将成为探测'
      : b.state === 'half_open'
        ? `探测成功 ${b.successStreak}/${b.successThreshold}，单次成功不会完全恢复`
        : `连续失败 ${b.failureStreak}/${b.failureThreshold} 后熔断 · 连续成功 ${b.successThreshold} 次后恢复`;

  return `
  <div class="${cardCls}" data-testid="ds-card-${d.id}">
    <div class="ds-top">
      <div>
        <div class="ds-name">${esc(d.name)} <code>${esc(d.id)}</code> ${priorityTag}</div>
        <div class="ds-desc">${esc(d.desc)}</div>
      </div>
      <span class="badge ${b.state}" data-testid="ds-breaker-${d.id}">${BREAKER_TEXT[b.state] || b.state}</span>
    </div>

    <div class="metrics">
      <div class="metric ${d.pool.active >= d.pool.size ? 'warn' : ''}" title="正在调用下游、占用连接池连接的请求数 / 池大小">
        <b data-testid="metric-active-${d.id}">${d.pool.active}/${d.pool.size}</b><span>在途 / 池容</span>
      </div>
      <div class="metric ${d.pool.queued > 0 ? 'warn' : ''}" title="已进入优先级队列、等待连接的请求数">
        <b data-testid="metric-queued-${d.id}">${d.pool.queued}</b><span>排队请求</span>
      </div>
      <div class="metric ${d.pool.queueTimeouts > 0 ? 'bad' : ''}" title="连接池排队超时累计：请求未到达下游，不计入熔断失败">
        <b data-testid="metric-qtimeout-${d.id}">${d.pool.queueTimeouts}</b><span>排队超时</span>
      </div>
      <div class="metric ${d.metrics.downstreamFailures > 0 ? 'bad' : 'ok'}" title="真实下游失败/超时累计：会计入熔断器">
        <b data-testid="metric-dsfail-${d.id}">${d.metrics.downstreamFailures}</b><span>真实失败</span>
      </div>
      <div class="metric" title="成功调用真实下游的平均耗时（毫秒）">
        <b>${d.metrics.avgLatencyMs}<i>ms</i></b><span>平均耗时</span>
      </div>
    </div>

    <div class="pressure-row ${p.level}" data-testid="ds-pressure-${d.id}">
      <span class="pressure-dot"></span>
      <span class="ptext">${PRESSURE_TEXT[p.level]} · 近 3s 排队超时 ${p.recentQueueTimeouts} 次</span>
    </div>

    <div class="reason-box" style="margin:0" data-testid="ds-breaker-hint-${d.id}">${esc(cooldownHint)}<br/>
      <span style="color:var(--muted)">打开冷却 ${b.baseCooldownMs}ms，振荡退避当前 ${b.cooldownMs}ms</span>
    </div>

    <div class="fault-presets">${presetBtns}</div>

    <div class="slider-row">
      <span>延迟 ms</span>
      <input type="range" min="0" max="3000" step="20" value="${Math.round(d.fault.latencyMs || 0)}"
        data-action="patch" data-key="latencyMs" data-id="${d.id}" data-testid="latency-${d.id}" />
      <output>${Math.round(d.fault.latencyMs || 0)}</output>
    </div>
    <div class="slider-row">
      <span>错误率</span>
      <input type="range" min="0" max="100" step="5" value="${Math.round((d.fault.errorRate || 0) * 100)}"
        data-action="patch-rate" data-id="${d.id}" data-testid="error-${d.id}" />
      <output>${Math.round((d.fault.errorRate || 0) * 100)}%</output>
    </div>
    <div class="slider-row">
      <span>连接池</span>
      <input type="range" min="1" max="8" step="1" value="${d.pool.size}"
        data-action="patch" data-key="poolSize" data-id="${d.id}" data-testid="pool-${d.id}" />
      <output>${d.pool.size}</output>
    </div>

    <div class="ds-actions">
      <button class="btn btn-ok btn-mini" data-action="recover" data-id="${d.id}" data-testid="recover-${d.id}">解除故障</button>
      <button class="btn btn-warn btn-mini" data-action="probe" data-id="${d.id}" data-testid="probe-${d.id}">立即探测恢复</button>
    </div>
  </div>`;
}

function renderDsGrid() {
  if (!state) return;
  $('#ds-grid').innerHTML = state.downstreams.map(dsCardHtml).join('');
}

/* 卡片区域交互时暂停整体重绘，避免拖动滑块被打断 */
const grid = $('#ds-grid');
grid.addEventListener('pointerdown', (e) => {
  if (e.target.closest('input')) gridInteracting = true;
});
window.addEventListener('pointerup', () => {
  if (gridInteracting) {
    gridInteracting = false;
    renderDsGrid();
  }
});
grid.addEventListener('focusin', (e) => {
  if (e.target.matches('input,select')) gridInteracting = true;
});
grid.addEventListener('focusout', () => {
  gridInteracting = false;
  renderDsGrid();
});
grid.addEventListener('input', (e) => {
  const input = e.target;
  if (input.matches('input[type=range]')) {
    const out = input.closest('.slider-row')?.querySelector('output');
    if (out) out.textContent = input.dataset.action === 'patch-rate' ? `${input.value}%` : input.value;
  }
});
grid.addEventListener('change', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const id = el.dataset.id;
  try {
    if (el.dataset.action === 'patch') {
      await api(`/api/downstreams/${id}/fault`, { method: 'POST', body: { [el.dataset.key]: Number(el.value) } });
    } else if (el.dataset.action === 'patch-rate') {
      await api(`/api/downstreams/${id}/fault`, { method: 'POST', body: { errorRate: Number(el.value) / 100 } });
    }
    await refreshAll();
  } catch (err) {
    alert(`操作失败：${err.message}`);
  }
});
grid.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const { action, id, preset } = btn.dataset;
  btn.disabled = true;
  try {
    if (action === 'preset') await api(`/api/downstreams/${id}/fault`, { method: 'POST', body: { preset } });
    else if (action === 'recover') await api(`/api/downstreams/${id}/recover`, { method: 'POST' });
    else if (action === 'probe') {
      const o = await api(`/api/downstreams/${id}/probe`, { method: 'POST' });
      renderOutcome(o);
    }
    await refreshAll();
  } catch (err) {
    alert(`操作失败：${err.message}`);
  } finally {
    btn.disabled = false;
  }
});

/* ============================ 响应渲染 ============================ */

const SOURCE_GLYPH = {
  downstream: ['实', 'g-real'],
  cache: ['缓', 'g-cache'],
  fallback: ['兜', 'g-fallback'],
  shed: ['弃', 'g-shed'],
  aggregate: ['聚', 'g-agg'],
};
function sourceBadge(servedBy) {
  const [ch, cls] = SOURCE_GLYPH[servedBy] || ['?', 'g-agg'];
  return `<span class="source-glyph ${cls}" aria-hidden="true">${ch}</span>`;
}

function outcomeMetaHtml(o) {
  const items = [
    ['请求 ID', o.requestId],
    ['下游', `${o.downstreamName || ''} (${o.downstream || '-'})`],
    ['优先级', o.priorityLabel],
    ['HTTP 状态', o.httpStatus],
    ['熔断器', o.breakerState],
    ['失败分类', o.failureClass],
    ['排队等待', o.timing?.queueWaitMs == null ? '-' : `${o.timing.queueWaitMs} ms`],
    ['下游耗时', o.timing?.downstreamMs == null ? '-' : `${o.timing.downstreamMs} ms`],
    ['总耗时', `${o.timing?.totalMs ?? '-'} ms`],
  ];
  if (o.cache) items.push(['缓存年龄', `${(o.cache.ageMs / 1000).toFixed(1)}s · ${o.cache.stale ? '已过期 stale' : '新鲜'}`]);
  return `<div class="outcome-meta">${items
    .map(([k, v]) => `<div class="meta-item"><span>${esc(k)}</span><b>${esc(v)}</b></div>`)
    .join('')}</div>`;
}

function reasonHtml(o) {
  if (!o.reason) {
    return `<div class="reason-box"><span class="kv-class none">none</span>
      本次请求拿到连接并获得真实下游响应（L0）。${o.countedAsDownstreamFailure ? '' : ''}</div>`;
  }
  const cls = o.failureClass === 'none' ? 'breaker' : o.failureClass;
  return `<div class="reason-box ${esc(o.failureClass)}" data-testid="last-reason">
    <span class="kv-class ${esc(cls)}">${esc(o.failureClass)}</span>
    <code>${esc(o.reason)}</code><br/>${esc(o.reasonLabel || '')}
    ${o.error?.message ? `<div style="color:var(--muted);margin-top:4px">${esc(o.error.message)}</div>` : ''}
  </div>`;
}

function homeSectionsHtml(o) {
  const sec = o.sections || o.data?.sections || {};
  const nameMap = { user: '用户板块', inventory: '库存板块', recommend: '推荐板块' };
  return `<div class="home-sections">${['user', 'inventory', 'recommend']
    .map((k) => {
      const s = sec[k];
      if (!s) return '';
      return `<div class="home-sec" data-testid="home-sec-${k}" data-served-by="${s.servedBy}">
        <h4>${nameMap[k]} <span class="mini-source ${s.servedBy}">${s.level}·${esc(s.sourceLabel)}</span></h4>
        <p>原因：${s.reason ? esc(s.reason) : '无（实时）'}</p>
        <p>熔断：${esc(s.breakerState)} ｜ 耗时：${s.timing?.totalMs}ms</p>
        <p>${s.data?._fallback ? '使用默认兜底数据' : s.servedBy === 'cache' ? `缓存 ${(s.cache?.ageMs / 1000).toFixed(1)}s` : s.servedBy === 'shed' ? '板块已被关闭/丢弃' : '真实数据'}</p>
      </div>`;
    })
    .join('')}</div>`;
}

function renderOutcome(o) {
  lastOutcome = o;
  const box = $('#last-response');
  box.dataset.servedBy = o.servedBy;
  box.dataset.level = String(o.level);
  box.dataset.reason = o.reason || '';
  box.dataset.breakerState = o.breakerState || '';
  $('#response-hint').textContent = `最近一次请求 ${o.requestId} · ${fmtTime(o.at)}`;

  const isHome = o.kind === 'home' || o.endpoint === '/api/home';
  box.innerHTML = `
    <div class="outcome" data-testid="outcome-card">
      <div class="outcome-hero l${o.level}">
        <div class="source-big" data-testid="last-served-by" data-served-by="${o.servedBy}">
          ${sourceBadge(o.servedBy)}
          <span>${esc(o.sourceLabel)}</span>
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <span class="level-pill" data-testid="last-level">${esc(o.levelLabel)}</span>
          <span class="badge ${o.breakerState === 'mixed' ? 'closed' : esc(o.breakerState)}" data-testid="last-breaker">熔断:${esc(o.breakerState)}</span>
          <span class="level-pill HTTP ${o.httpStatus < 400 ? 'http-2' : 'http-5'}">HTTP ${o.httpStatus}</span>
        </div>
      </div>
      ${outcomeMetaHtml(o)}
      ${reasonHtml(o)}
      ${isHome ? homeSectionsHtml(o) : ''}
      ${
        o.data !== null && o.data !== undefined
          ? `<pre class="data">${esc(JSON.stringify(o.data, null, 2))}</pre>`
          : `<pre class="data" style="color:#ffb3bb">（无响应数据：请求被快速丢弃 / 拒绝）</pre>`
      }
      <details style="padding:8px 16px 14px">
        <summary style="cursor:pointer;color:var(--muted);font-size:12px">完整核对 JSON（含所有判定字段）</summary>
        <pre class="data" style="max-height:340px">${esc(JSON.stringify(o, null, 2))}</pre>
      </details>
    </div>`;
}

/* ============================ 请求按钮 / 突发 ============================ */

const REQ_PATH = {
  user: '/api/user/u_1001',
  orders: '/api/orders?userId=u_1001',
  product: '/api/product/p_88',
  inventory: '/api/inventory/SKU-88-BLK',
  recommend: '/api/recommend?userId=u_1001',
  home: '/api/home?userId=u_1001',
};

$('#req-buttons').addEventListener('click', async (e) => {
  const btn = e.target.closest('.req-btn');
  if (!btn || btn.disabled) return;
  const name = btn.dataset.req;
  btn.classList.add('loading');
  try {
    const o = await api(REQ_PATH[name]);
    renderOutcome(o);
    await refreshAll();
  } catch (err) {
    if (err.body) renderOutcome(err.body);
    else alert(`请求失败：${err.message}`);
  } finally {
    btn.classList.remove('loading');
  }
});

const DS_TO_ENDPOINT = { user: 'user', order: 'orders', product: 'product', inventory: 'inventory', recommend: 'recommend' };

function renderBurstResult(result) {
  const t = result.tally;
  const chips = [
    [`共 ${t.total}`, ''],
    [`L0 实时 ${t.byLevel[0] || 0}`, 'good'],
    [`L1 缓存 ${t.byLevel[1] || 0}`, 'warn'],
    [`L2 兜底 ${t.byLevel[2] || 0}`, 'warn'],
    [`L3 丢弃 ${t.byLevel[3] || 0}`, 'bad'],
    [`真实下游 ${t.byServedBy.downstream || 0}`, 'good'],
    [`排队超时 ${t.byReason.pool_queue_timeout || 0}`, 'warn'],
    [`准入丢弃 ${t.byReason.admission_shed || 0}`, 'bad'],
    [`真实失败 ${(t.byReason.downstream_failure || 0) + (t.byReason.downstream_timeout || 0)}`, 'bad'],
    [`P0 全部保住: ${t.p0AllReal ? '是 ✅' : '否 ❌'}`, t.p0AllReal ? 'good' : 'bad'],
  ];
  const rows = result.results
    .map(
      (r, i) => `<tr>
        <td>#${i + 1}</td><td>${esc(r.priorityLabel)}</td>
        <td class="lvl l${r.level}">L${r.level}</td>
        <td>${esc(r.servedBy)}</td>
        <td class="reason-cell" title="${esc(r.reason || '')}">${esc(r.reason || '-')}</td>
        <td>${r.timing?.queueWaitMs ?? '-'} / ${r.timing?.totalMs}ms</td>
        <td>${esc(r.breakerState)}</td>
      </tr>`,
    )
    .join('');
  $('#burst-tally').innerHTML = `
    <div style="display:flex;flex-wrap:wrap;gap:7px;width:100%" data-testid="burst-summary"
      data-p0-all-real="${t.p0AllReal}" data-queue-timeouts="${t.byReason.pool_queue_timeout || 0}">
      ${chips.map(([txt, cls]) => `<span class="tally-chip ${cls}">${esc(txt)}</span>`).join('')}
    </div>
    <div class="table-wrap" style="width:100%;max-height:260px;margin-top:8px" data-testid="burst-results">
      <table class="history-table">
        <thead><tr><th>#</th><th>优先级</th><th>级别</th><th>来源</th><th>原因</th><th>排队/总耗时</th><th>熔断</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  const firstInteresting = result.results.find((r) => r.servedBy !== 'downstream') || result.results[0];
  if (firstInteresting) renderOutcome(firstInteresting);
}

$('#btn-burst').addEventListener('click', async () => {
  const downstream = $('#burst-ds').value;
  const count = Number($('#burst-count').value) || 8;
  const priority = Number($('#burst-priority').value);
  const endpoint = DS_TO_ENDPOINT[downstream];
  const body = endpoint ? { endpoint, count, priority } : { downstream, count, priority };
  const btn = $('#btn-burst');
  btn.disabled = true;
  btn.textContent = '突发中…';
  try {
    renderBurstResult(await api('/api/burst', { method: 'POST', body }));
    await refreshAll();
  } catch (err) {
    alert(`突发失败：${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = '并发发送';
  }
});

$('#btn-mixed-burst').addEventListener('click', async () => {
  const downstream = $('#burst-ds').value;
  const endpoint = DS_TO_ENDPOINT[downstream];
  // P2 给极短排队预算（快速被牺牲），P0 给长预算并优先出队
  const body = {
    mix: [
      { priority: 2, count: 6, queueTimeoutMs: 130 },
      { priority: 0, count: 2, queueTimeoutMs: 4000 },
    ],
  };
  if (endpoint) body.endpoint = endpoint;
  else body.downstream = downstream;
  const btn = $('#btn-mixed-burst');
  btn.disabled = true;
  btn.textContent = '混合突发中（约 1s）…';
  try {
    renderBurstResult(await api('/api/burst', { method: 'POST', body }));
    await refreshAll();
  } catch (err) {
    alert(`混合突发失败：${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = '6×P2 + 2×P0';
  }
});

/* ============================ 历史 / 时间线 ============================ */

function renderHistory(items) {
  $('#history-body').innerHTML = items
    .slice(0, 40)
    .map(
      (it) => `<tr data-testid="history-row" data-served-by="${it.servedBy}" data-reason="${it.reason || ''}">
      <td>${fmtTime(it.at)}</td>
      <td><code>${esc(it.endpoint || it.kind || '-')}</code></td>
      <td>${esc(it.priorityLabel || '-')}</td>
      <td class="${it.httpStatus < 400 ? 'http-2' : 'http-5'}">${it.httpStatus}</td>
      <td><span class="lvl l${it.level}">L${it.level}</span></td>
      <td>${esc(it.sourceLabel)}</td>
      <td class="reason-cell" title="${esc(it.reasonLabel || it.reason || '')}">${esc(it.reason || '-')}</td>
      <td>${it.timing?.queueWaitMs ?? '-'} / ${it.timing?.totalMs ?? '-'}ms</td>
      <td>${esc(it.breakerState)}</td>
    </tr>`,
    )
    .join('');
}

function eventHtml(ev) {
  const downtime =
    ev.downtimeMs != null ? `<div class="tl-downtime">故障窗口：${ev.downtimeMs} ms（${(ev.downtimeMs / 1000).toFixed(2)}s）</div>` : '';
  return `<li class="t-${esc(ev.type)}" data-testid="event-item" data-event-type="${esc(ev.type)}" data-downstream="${esc(ev.downstream || '')}">
    <div class="tl-time">#${ev.seq} · ${fmtTime(ev.t)}</div>
    <div class="tl-title">${esc(ev.title || ev.type)}</div>
    ${ev.message ? `<div class="tl-msg">${esc(ev.message)}</div>` : ''}
    ${downtime}
  </li>`;
}

async function pollEvents() {
  const { events } = await api(`/api/events?sinceSeq=${lastSeq}`);
  if (!events.length) return;
  lastSeq = events[events.length - 1].seq;
  const tl = $('#timeline');
  const atBottom = tl.scrollTop + tl.clientHeight >= tl.scrollHeight - 30;
  for (const ev of events) tl.insertAdjacentHTML('beforeend', eventHtml(ev));
  while (tl.children.length > 80) tl.removeChild(tl.firstElementChild);
  if (atBottom) tl.scrollTop = tl.scrollHeight;
}

/* ============================ 顶部操作 ============================ */

$('#btn-recover-all').addEventListener('click', async () => {
  await Promise.all(state.downstreams.map((d) => api(`/api/downstreams/${d.id}/recover`, { method: 'POST' })));
  await refreshAll();
});
$('#btn-reset').addEventListener('click', async () => {
  if (!confirm('确定重置全部故障、熔断器、指标与请求记录？')) return;
  await api('/api/reset', { method: 'POST' });
  lastSeq = 0;
  $('#timeline').innerHTML = '';
  $('#history-body').innerHTML = '';
  $('#burst-tally').innerHTML = '';
  await refreshAll();
});
$('#auto-refresh').addEventListener('change', (e) => {
  if (e.target.checked) timer = setInterval(tick, 1000);
  else clearInterval(timer);
});

/* ============================ 四大自动核对剧本 ============================ */

function reporter(title) {
  const box = $('#drill-report');
  const empty = box.querySelector('.drill-report-empty');
  if (empty) empty.remove();
  const block = document.createElement('div');
  block.className = 'drill-run-block';
  block.innerHTML = `<div class="drill-title" data-testid="drill-title">${esc(title)}</div>`;
  const list = document.createElement('div');
  block.appendChild(list);
  box.appendChild(block);
  let pass = 0;
  let fail = 0;
  const add = (kind, text, evidence) => {
    if (kind === 'pass') pass += 1;
    if (kind === 'fail') fail += 1;
    const ICON = {
      pass: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M3 8.6 6.4 12 13 4.2" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      fail: '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"/></svg>',
      run: '<span class="run-dot"></span>',
    };
    const icon = ICON[kind] || '<span class="run-dot"></span>';
    const div = document.createElement('div');
    div.className = `drill-item ${kind}`;
    div.dataset.testid = 'drill-item';
    div.dataset.pass = kind === 'pass' ? 'true' : kind === 'fail' ? 'false' : 'running';
    div.innerHTML = `<span class="drill-mark">${icon}</span>
      <div><div>${esc(text)}</div>${evidence ? `<div class="drill-evidence">${esc(evidence)}</div>` : ''}</div>`;
    list.appendChild(div);
    box.scrollTop = box.scrollHeight;
    return div;
  };
  const finish = () => {
    const sum = document.createElement('div');
    sum.className = `drill-summary ${fail ? 'has-fail' : 'all-pass'}`;
    sum.dataset.testid = 'drill-summary';
    sum.dataset.pass = fail === 0 ? 'true' : 'false';
    sum.textContent = fail ? `核对未通过：${pass} 通过 / ${fail} 失败` : `全部核对通过：${pass} 项断言成立`;
    block.appendChild(sum);
    return { pass, fail };
  };
  return { add, finish };
}

function clearReport() {
  $('#drill-report').innerHTML = '<div class="drill-report-empty">剧本运行中…</div>';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getDsState(id) {
  const s = await api('/api/state');
  return s.downstreams.find((d) => d.id === id);
}

async function drillIsolation() {
  const r = reporter('剧本①：单下游故障隔离 + 恢复核对');
  drillRunning = true;
  try {
    await api('/api/reset', { method: 'POST' });
    lastSeq = 0;
    $('#timeline').innerHTML = '';
    r.add('run', '已重置，向 recommend 注入 100% 真实报错…');
    await api('/api/downstreams/recommend/fault', { method: 'POST', body: { preset: 'error' } });

    const recs = [];
    for (let i = 0; i < 4; i += 1) {
      recs.push(await api('/api/recommend').catch((e) => e.body));
      await sleep(60);
    }
    const recDegraded = recs.filter((x) => x && x.servedBy !== 'downstream').length;
    const ds = await getDsState('recommend');
    r.add(
      recDegraded >= 3 && ds.breaker.state === 'open' ? 'pass' : 'fail',
      `推荐接口被降级 ${recDegraded}/4 次，熔断器状态=${ds.breaker.state}`,
      recs.map((x, i) => `#${i + 1} L${x.level} ${x.servedBy} reason=${x.reason} breaker=${x.breakerState}`).join('\n'),
    );

    const users = [];
    for (let i = 0; i < 3; i += 1) users.push(await api('/api/user/u_1001'));
    const userAllReal = users.every((u) => u.servedBy === 'downstream' && u.httpStatus === 200);
    r.add(
      userAllReal ? 'pass' : 'fail',
      userAllReal ? '推荐服务故障期间，用户接口 3/3 仍是 L0 真实响应（没有被一起关掉）' : '用户接口受到波及！',
      users.map((u, i) => `user#${i + 1} L${u.level} ${u.servedBy} ${u.timing.totalMs}ms breaker=${u.breakerState}`).join('\n'),
    );

    r.add('run', '解除推荐故障，连续手动探测 2 次（防振荡阈值）…');
    await api('/api/downstreams/recommend/recover', { method: 'POST' });
    const p1 = await api('/api/downstreams/recommend/probe', { method: 'POST' });
    const after1 = await getDsState('recommend');
    r.add(
      p1.servedBy === 'downstream' && after1.breaker.state === 'half_open' && after1.breaker.successStreak === 1
        ? 'pass'
        : 'fail',
      `第 1 次探测成功但熔断器保持 half_open（${after1.breaker.successStreak}/${after1.breaker.successThreshold}），单次成功不恢复`,
      `probe: L${p1.level} ${p1.servedBy}; breaker=${after1.breaker.state}`,
    );
    const p2 = await api('/api/downstreams/recommend/probe', { method: 'POST' });
    const after2 = await getDsState('recommend');
    const ev = await api('/api/events');
    const recovered = [...ev.events].reverse().find((e) => e.type === 'breaker_recovered' && e.downstream === 'recommend');
    r.add(
      after2.breaker.state === 'closed' && p2.servedBy === 'downstream' && recovered ? 'pass' : 'fail',
      `第 2 次探测成功后熔断器关闭，推荐恢复 L0；恢复事件已记录`,
      `breaker=${after2.breaker.state}; 故障窗口=${recovered?.downtimeMs ?? '?'}ms; 恢复时刻=${recovered ? fmtTime(recovered.recoveredAt) : '未找到事件'}`,
    );
    renderOutcome(p2);
    r.finish();
  } finally {
    drillRunning = false;
    await refreshAll();
  }
}

async function drillQueue() {
  const r = reporter('剧本②：连接池排队超时 vs 真实下游失败');
  drillRunning = true;
  try {
    await api('/api/reset', { method: 'POST' });
    lastSeq = 0;
    $('#timeline').innerHTML = '';
    r.add('run', '商品服务：连接池=1、延迟 700ms、错误率=0；服务端突发 5 个 P1，排队预算 180ms…');
    await api('/api/downstreams/product/fault', {
      method: 'POST',
      body: { down: false, latencyMs: 700, jitterMs: 0, errorRate: 0, poolSize: 1 },
    });
    const burst = await api('/api/burst', {
      method: 'POST',
      body: { downstream: 'product', count: 5, priority: 1, queueTimeoutMs: 180 },
    });
    renderBurstResult(burst);
    const qCount = burst.tally.byReason.pool_queue_timeout || 0;
    const realCount = burst.tally.byServedBy.downstream || 0;
    const ds = await getDsState('product');
    r.add(
      qCount >= 3 && realCount === 1 ? 'pass' : 'fail',
      `1 个请求拿到连接真实返回，${qCount} 个在队列中超时（pool_queue_timeout）`,
      burst.results.map((x, i) => `#${i + 1} ${x.servedBy} reason=${x.reason} queueWait=${x.timing.queueWaitMs}ms`).join('\n'),
    );
    r.add(
      ds.breaker.state === 'closed' && ds.metrics.downstreamFailures === 0
        ? 'pass'
        : 'fail',
      `排队超时没有被当成下游失败：熔断器=${ds.breaker.state}，真实下游失败计数=${ds.metrics.downstreamFailures}`,
      `pool.queueTimeouts=${ds.pool.queueTimeouts}; breakerFailureStreak=${ds.breaker.failureStreak}`,
    );

    r.add('run', '对比：切换为 100% 真实报错，连续调用 3 次…');
    await api('/api/downstreams/product/fault', { method: 'POST', body: { preset: 'error' } });
    const errs = [];
    for (let i = 0; i < 3; i += 1) errs.push(await api('/api/product/p_88').catch((e) => e.body));
    const ds2 = await getDsState('product');
    const realFailReasons = errs.filter((x) => x?.reason === 'downstream_failure').length;
    r.add(
      realFailReasons >= 2 && ds2.breaker.state === 'open' && ds2.metrics.downstreamFailures >= 3 ? 'pass' : 'fail',
      `真实 5xx 被标记为 downstream_failure（${realFailReasons} 次）并累计 ${ds2.metrics.downstreamFailures} 次真实失败，熔断器打开`,
      errs.map((x, i) => `#${i + 1} reason=${x?.reason} class=${x?.failureClass} counted=${x?.countedAsDownstreamFailure} breaker=${x?.breakerState}`).join('\n'),
    );
    await api('/api/downstreams/product/recover', { method: 'POST' });
    await api('/api/downstreams/product/probe', { method: 'POST' }).catch(() => {});
    await api('/api/downstreams/product/probe', { method: 'POST' }).catch(() => {});
    r.finish();
  } finally {
    drillRunning = false;
    await refreshAll();
  }
}

async function drillPriority() {
  const r = reporter('剧本③：同一连接池内优先保住 P0 必要请求');
  drillRunning = true;
  try {
    await api('/api/reset', { method: 'POST' });
    lastSeq = 0;
    $('#timeline').innerHTML = '';
    r.add('run', '订单服务：连接池=1、延迟 350ms；同一时刻压入 6×P2(排队预算130ms) + 2×P0(预算4s)…');
    await api('/api/downstreams/order/fault', {
      method: 'POST',
      body: { down: false, latencyMs: 350, jitterMs: 0, errorRate: 0, poolSize: 1 },
    });
    const burst = await api('/api/burst', {
      method: 'POST',
      body: {
        endpoint: 'orders',
        mix: [
          { priority: 2, count: 6, queueTimeoutMs: 130 },
          { priority: 0, count: 2, queueTimeoutMs: 4000 },
        ],
      },
    });
    renderBurstResult(burst);
    const p0 = burst.results.filter((x) => x.priority === 0);
    const p2 = burst.results.filter((x) => x.priority === 2);
    const p0Real = p0.every((x) => x.servedBy === 'downstream');
    const p2Real = p2.filter((x) => x.servedBy === 'downstream').length;
    const p2Sacrificed = p2.length - p2Real >= p2.length - 1; // 至多首个抢到空闲连接的 P2 真实返回
    r.add(
      p0Real ? 'pass' : 'fail',
      `2/2 个 P0 必要请求插队成功，拿到真实订单服务响应`,
      p0.map((x, i) => `P0#${i + 1} ${x.servedBy} queueWait=${x.timing.queueWaitMs}ms total=${x.timing.totalMs}ms`).join('\n'),
    );
    r.add(
      p2Sacrificed && p2Real <= 1 ? 'pass' : 'fail',
      `6 个 P2 中仅 ${p2Real} 个（首个抢到空闲连接者）真实返回，其余 ${p2.length - p2Real} 个被排队超时/缓存/丢弃接管；P0 排队等待明显更短`,
      `P2 来源分布: ${JSON.stringify(burst.tally.byServedBy)}\n原因分布: ${JSON.stringify(burst.tally.byReason)}`,
    );
    r.add(
      burst.tally.p0AllReal ? 'pass' : 'fail',
      '服务端统计 tally.p0AllReal = true（必要请求优先成立）',
      JSON.stringify(burst.tally, null, 2),
    );
    await api('/api/downstreams/order/recover', { method: 'POST' });
    r.finish();
  } finally {
    drillRunning = false;
    await refreshAll();
  }
}

async function drillFlap() {
  const r = reporter('剧本④：半开探测 + 迟滞，防止恢复振荡');
  drillRunning = true;
  try {
    await api('/api/reset', { method: 'POST' });
    lastSeq = 0;
    $('#timeline').innerHTML = '';
    r.add('run', '用真实报错连续打开 recommend 熔断…');
    await api('/api/downstreams/recommend/fault', { method: 'POST', body: { preset: 'error' } });
    for (let i = 0; i < 3; i += 1) await api('/api/recommend').catch(() => {});
    const openDs = await getDsState('recommend');
    const baseCooldown = openDs.breaker.cooldownMs;
    r.add(openDs.breaker.state === 'open' ? 'pass' : 'fail', `熔断器已打开，当前冷却 ${baseCooldown}ms`, `state=${openDs.breaker.state} episode=${openDs.breaker.openEpisode}`);

    r.add('run', '下游仍故障时进行第 1 次探测，应当失败并重新熔断、冷却翻倍…');
    const badProbe = await api('/api/downstreams/recommend/probe', { method: 'POST' }).catch((e) => e.body);
    const reopened = await getDsState('recommend');
    r.add(
      reopened.breaker.state === 'open' && reopened.breaker.cooldownMs > baseCooldown
        ? 'pass'
        : 'fail',
      `探测失败后重新 OPEN，冷却 ${baseCooldown}ms → ${reopened.breaker.cooldownMs}ms（指数退避抑制振荡）`,
      `probeSuccess=${badProbe?.probeSuccess} servedBy=${badProbe?.servedBy} reason=${badProbe?.reason}; state=${reopened.breaker.state}`,
    );

    r.add('run', '解除故障；验证“单次成功不闭合，连续 2 次才闭合”…');
    await api('/api/downstreams/recommend/recover', { method: 'POST' });
    const p1 = await api('/api/downstreams/recommend/probe', { method: 'POST' });
    const s1 = await getDsState('recommend');
    r.add(
      p1.servedBy === 'downstream' && s1.breaker.state === 'half_open' ? 'pass' : 'fail',
      `第 1 次探测拿到真实响应，但状态仍为 half_open（成功计数 ${s1.breaker.successStreak}/${s1.breaker.successThreshold}）`,
      `servedBy=${p1.servedBy}; state=${s1.breaker.state}`,
    );
    const p2 = await api('/api/downstreams/recommend/probe', { method: 'POST' });
    const s2 = await getDsState('recommend');
    const ev = await api('/api/events');
    const openedEvt = ev.events.find((e) => e.type === 'breaker_open' && e.downstream === 'recommend');
    const recoveredEvt = [...ev.events].reverse().find((e) => e.type === 'breaker_recovered' && e.downstream === 'recommend');
    r.add(
      s2.breaker.state === 'closed' && recoveredEvt ? 'pass' : 'fail',
      `第 2 次连续探测成功才 CLOSED，恢复事件与故障窗口可核对`,
      [
        `state=${s2.breaker.state}; p2=${p2.servedBy}`,
        openedEvt ? `打开时刻 ${fmtTime(openedEvt.t)}` : '',
        recoveredEvt ? `恢复时刻 ${fmtTime(recoveredEvt.recoveredAt)}，持续 ${recoveredEvt.downtimeMs}ms` : '缺少 recovered 事件',
      ]
        .filter(Boolean)
        .join('\n'),
    );
    renderOutcome(p2);
    r.finish();
  } finally {
    drillRunning = false;
    await refreshAll();
  }
}

const DRILLS = { isolation: drillIsolation, queue: drillQueue, priority: drillPriority, flap: drillFlap };

$$('.drill-card').forEach((card) =>
  card.addEventListener('click', async () => {
    if (drillRunning) return;
    clearReport();
    $$('.drill-card').forEach((c) => c.classList.remove('running'));
    card.classList.add('running');
    try {
      await DRILLS[card.dataset.drill]();
      card.classList.add('done-pass');
    } catch (e) {
      const r = reporter(`剧本执行异常：${card.dataset.drill}`);
      r.add('fail', e.message, e.stack);
      r.finish();
      card.classList.add('done-fail');
    } finally {
      card.classList.remove('running');
    }
  }),
);

$('#btn-drill-all').addEventListener('click', async () => {
  if (drillRunning) return;
  clearReport();
  for (const key of ['isolation', 'queue', 'priority', 'flap']) {
    const card = $(`.drill-card[data-drill="${key}"]`);
    card?.classList.add('running');
    try {
      await DRILLS[key]();
      card?.classList.add('done-pass');
    } catch (e) {
      card?.classList.add('done-fail');
      const r = reporter(`剧本执行异常：${key}`);
      r.add('fail', e.message);
      r.finish();
      break;
    } finally {
      card?.classList.remove('running');
    }
  }
});

/* ============================ 轮询与启动 ============================ */

async function refreshAll() {
  try {
    state = await api('/api/state');
    if (!gridInteracting) renderDsGrid();
    const reqs = await api('/api/requests');
    renderHistory(reqs.items || []);
    await pollEvents();
  } catch (e) {
    console.error('refresh failed', e);
  }
}

async function tick() {
  if (drillRunning) return; // 剧本自己会刷新，避免轮询竞争
  await refreshAll();
}

let timer = setInterval(tick, 1000);
refreshAll();

// 便于浏览器控制台 / 外部自动化复用
window.__dc = { api, refreshAll, runDrill: (k) => DRILLS[k]?.(), get lastOutcome() { return lastOutcome; } };
