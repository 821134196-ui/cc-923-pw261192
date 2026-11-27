# 多级降级样例服务 · multilevel-degradation-sample

一个**零外部依赖**的本地 Node.js 样例：用 5 个可注入故障的模拟下游，完整演示

- **多级降级**：真实下游 → 缓存 → 默认兜底 → 限流丢弃（L0–L3）；
- **优先保住必要请求**：P0/P1/P2 优先级 + 优先级连接池队列 + 分级排队预算 + 高压只牺牲 P2；
- **下游隔离**：每个下游独立连接池（舱壁）、熔断器、缓存，一个变慢/报错不会拖垮其他接口；
- **区分「连接池排队超时」与「真实下游失败」**：不同 `failureClass`、不同指标、不同熔断处理；
- **防止恢复振荡**：熔断器半开单探测 + 连续成功迟滞 + 失败指数退避冷却；
- **可视化核对**：网页注入故障、发不同请求，直接看到用了哪种响应、判定字段、恢复时间与故障持续时长，并内置 4 个一键自检演练。

只需要 Node.js ≥ 18（开发环境为 v24），**不需要 `npm install`**。

---

## 1. 30 秒跑起来

```bash
npm start
# 或 node server/index.js
```

默认同时监听 **http://localhost:3000**、8080、8000（设置 `PORT=4000 npm start` 则只监听 4000）。
浏览器打开 <http://localhost:3000> 即可。

> 重复执行 `npm start` 是安全的：若端口上已经是本应用的实例，新进程会探测 `/health` 确认后直接复用并退出，不会报 `EADDRINUSE`。

一键自检（单元测试 + 22 项端到端断言，脚本会自己拉起隔离端口的服务，不影响正在运行的演示实例）：

```bash
npm run check     # = node --test && node scripts/verify.mjs
npm test          # 仅 7 个核心单元测试
npm run verify    # 仅端到端核对脚本
```

---

## 2. 页面怎么用（推荐核对路径）

页面自上而下：**一键演练 → 下游舱壁卡片 → 请求/突发台 → 本次响应 → 请求历史 → 事件时间线**。

### 方式 A：点「一键自检演练」（最快，自带断言与证据）

演练区有 4 张卡片，也可点 `全部演练` 顺序执行。每条断言都会显示 ✓ / ✕ 和实测字段，全部通过时卡片底部出现绿色「全部核对通过」。

| 演练 | 对应题目要求 | 它证明了什么 |
| --- | --- | --- |
| **下游隔离** `drill-isolation` | 单个下游变慢不要关掉其他接口 | 只让「推荐」持续报错 → 推荐熔断并降级；连打 3 次「用户」全部仍是 `downstream` 真实响应 |
| **排队 ≠ 真实失败** `drill-queue` | 区分连接池排队和真实下游失败 | 把商品延迟调到 700ms、池容 1，突发 5 个短排队预算请求：多数是 `pool_queue_timeout`，**只有 1 个真实调用**；此时熔断器仍 `closed`、真实失败数为 0。随后注入真实 5xx，熔断器才打开 |
| **优先级保护** `drill-priority` | 优先保住必要请求 | 订单池容 1、延迟 350ms，混入 6 个 P2（排队预算 130ms）和 2 个 P0（预算 4000ms）：**2 个 P0 全部拿到真实响应**，P2 至多 1 个抢到连接，其余被排队超时/降级/丢弃 |
| **防振荡恢复** `drill-flap` | 防止恢复振荡、核对何时恢复 | 3 次真实失败 → OPEN（冷却 4000ms）；故障中探测失败 → 重新 OPEN 且冷却翻倍到 8000ms；解除故障后第 1 次探测停在 `half_open (1/2)`，第 2 次连续成功才 CLOSED。时间线给出打开时刻、恢复时刻与持续毫秒数 |

### 方式 B：手动注入故障、发请求、看响应来源

1. 在任一下游卡片点故障预设：`健康 / 慢 / 超时 / 报错 / 宕机 / 高压`，或拖动延迟、错误率、连接池大小滑块。
2. 点上方请求按钮：`用户(P0)`、`订单(P0)`、`商品(P1)`、`库存(P1)`、`推荐(P2)`、`聚合首页`。
3. 在「本次响应」面板核对：
   - 左上角大字来源徽章：**实**（真实下游）/ **缓**（缓存）/ **兜**（默认兜底）/ **弃**（丢弃）/ **聚**（聚合）；
   - 级别 pill：`L0 实时响应` … `L3 限流丢弃`；
   - `熔断: closed/open/half_open`、`HTTP 200/503`；
   - 明细字段：请求 ID、下游、优先级、失败分类、排队等待 ms、下游耗时 ms、总耗时、缓存年龄；
   - 展开「完整核对 JSON」可看到所有判定字段；响应头里也有 `X-Served-By`、`X-Degradation-Level`、`X-Failure-Reason`、`X-Failure-Class`、`X-Breaker-State` 等，方便脚本/抓包核对。
4. 「事件时间线」记录 `breaker_open / breaker_half_open / breaker_reopen / breaker_recovered / fault_change / system`。
   `breaker_recovered` 事件带 `recoveredAt` 与 `downtimeMs`（从打开到真正关闭的故障窗口），用于回答「**何时恢复**」。
5. 顶部 `恢复全部` 会把所有下游拨回 healthy（熔断器状态保留，仍按探测迟滞自行恢复）；`重置` 清空故障、指标、日志与熔断器。

---

## 3. 需求 → 机制 → 代码位置 对照

| 题目原话 | 落地机制 | 关键位置 |
| --- | --- | --- |
| 多级降级 | `L0 downstream → L1 cache(stale-on-error) → L2 fallback → L3 shed(503)`，每级都写进响应与指标 | `server/bff.js` `callWithDegradation()` |
| 优先保住必要请求 | P0/P1/P2；等待队列按优先级插队（同级 FIFO）；排队预算 P0 4s / P1 600ms / P2 220ms；critical 压力下只立即丢弃 P2 | `server/pool.js`、`server/config.js`、`server/bff.js` |
| 单个下游变慢不关掉其他接口 | 5 个下游各自独立的 bulkhead 池 + 熔断器 + 缓存；`/api/home` 用 `Promise.all` 聚合，各 section 独立降级、互不影响 | `server/downstreams.js`、`server/bff.js` `callHome()` |
| 区分连接池排队 vs 真实失败 | `failureClass ∈ none/downstream/pool_queue/admission/breaker`；只有真实下游错误/拿到连接后的超时才 `countedAsDownstreamFailure:true` 并计入熔断；排队超时**不接触下游、不触发熔断** | `server/errors.js`、`server/pool.js`、`server/bff.js` |
| 压力分级 | `normal / contention / critical`；2s 窗口内 ≥2 次排队超时，或排队数 ≥ 池容+1 → critical | `server/downstreams.js` `pressureSnapshot()` |
| 防止恢复振荡 | 连续 3 次真实失败 OPEN；冷却后只放 1 个探测槽进入 HALF_OPEN；连续 2 次成功才 CLOSED；半开期间任一失败立即重新 OPEN 且冷却 ×2（上限 20s）；只有真正 CLOSED 才重置退避 | `server/circuitBreaker.js` |
| 核对哪种响应 / 何时恢复 | 来源徽章 + 级别 + 全字段 JSON + `X-*` 头 + 请求历史 + 带恢复时间/持续时长的事件时间线 + 4 个自检演练 | `public/`、`server/events.js` |

### 失败分类速查（重点）

| `failureClass` | 典型 `reason` | 含义 | 是否计真实下游失败 / 触发熔断 |
| --- | --- | --- | --- |
| `pool_queue` | `pool_queue_timeout` | 一直没拿到连接，在舱壁队列里等到超时；**请求根本没发到下游** | 否（`countedAsDownstreamFailure:false`） |
| `admission` | `POOL_SHED` / `admission_shed` | critical 压力下 P2 在入队前被主动丢弃 | 否 |
| `downstream` | `DOWNSTREAM_TIMEOUT` / `DOWNSTREAM_ERROR` / `DOWNSTREAM_UNAVAILABLE` | 已拿到连接，真实调用超时 / 5xx 风格错误 / 连接拒绝 | **是** |
| `breaker` | `breaker_open` | 熔断器 OPEN 或无可用半开探测槽，直接快速失败 | 否（是熔断结果而非新故障） |
| `none` | — | 成功 | — |

---

## 4. HTTP API 速览

业务接口（均返回判定 JSON，并带 `X-*` 核对响应头）：

```
GET  /api/user/:id?          # P0，下游 user
GET  /api/orders?userId=      # P0，下游 order
GET  /api/product/:id?        # P1，下游 product
GET  /api/inventory/:sku?     # P1，下游 inventory
GET  /api/recommend           # P2，下游 recommend
GET  /api/home                # 聚合：user + inventory + recommend，分区独立降级
GET  /api/call/:downstream?priority=0|1|2&queueTimeoutMs=   # 通用调用，可显式指定优先级
```

控制/观测接口：

```
GET  /health                  # { ok, app }，探活/端口复用识别
GET  /api/state               # 全部下游故障、池、熔断、压力快照 + 配置 + 标签
GET  /api/events?since=<seq>  # 事件时间线（增量轮询）
GET  /api/requests            # 最近请求判定记录（环形 100 条）
GET  /api/presets             # 故障预设定义
POST /api/reset               # 重置所有故障/指标/日志/熔断器

POST /api/downstreams/:id/fault     # 注入故障，body 见下
POST /api/downstreams/:id/recover   # 解除故障（熔断器仍走探测迟滞）
POST /api/downstreams/:id/probe     # 手动发起一次半开探测（P0）

POST /api/burst               # 服务端确定性突发，返回逐条结果与 tally
```

`:id` ∈ `user | order | product | inventory | recommend`。

故障注入 body（全部字段可选，可先给 `preset` 再用任意键覆盖）：

```json
{ "preset": "slow", "latencyMs": 900, "jitterMs": 100,
  "errorRate": 0, "down": false, "poolSize": 2 }
```

`preset` ∈ `healthy | slow | timeout | error | down | pressure`。

突发 body 的三种写法：

```jsonc
// 1) 同一优先级 N 个
{ "downstream": "order", "count": 8, "priority": 2, "queueTimeoutMs": 130 }

// 2) 混合优先级（页面「混合突发」使用）
{ "downstream": "order",
  "mix": [
    { "count": 6, "priority": 2, "queueTimeoutMs": 130 },
    { "count": 2, "priority": 0, "queueTimeoutMs": 4000 }
  ] }

// 3) 完全自定义每条调用
{ "calls": [ { "priority": 0, "queueTimeoutMs": 4000 } ] }
```

`/api/burst` 的 `tally` 含 `byServedBy / byReason / byLevel` 以及 `p0AllReal`（所有 P0 是否都拿到了真实响应）。

### curl 示例

```bash
# 只让推荐报错，连打 4 次观察 真实->熔断->缓存/兜底
curl -s -X POST localhost:3000/api/downstreams/recommend/fault \
  -H 'content-type: application/json' -d '{"preset":"error"}' >/dev/null
for i in 1 2 3 4; do curl -s localhost:3000/api/recommend | jq '{servedBy,level,reason,failureClass,breakerState}'; done

# 商品池容 1 + 高延迟，制造纯排队超时（熔断不应打开）
curl -s -X POST localhost:3000/api/downstreams/product/fault \
  -H 'content-type: application/json' -d '{"latencyMs":700,"jitterMs":0,"poolSize":1}' >/dev/null
curl -s -X POST localhost:3000/api/burst -H 'content-type: application/json' \
  -d '{"downstream":"product","count":5,"priority":1,"queueTimeoutMs":180}' | jq '.tally'

# 恢复并手动探测
curl -s -X POST localhost:3000/api/downstreams/product/recover >/dev/null
curl -s -X POST localhost:3000/api/downstreams/product/probe | jq '{breakerState,servedBy}'
curl -s -X POST localhost:3000/api/reset >/dev/null
```

---

## 5. 主要 `data-testid`（自动化/评分定位用）

- 全局：`btn-recover-all`、`btn-reset`、`drill-report`、`last-response`、`last-served-by`、`last-level`、`last-reason`、`last-breaker`、`burst-tally`、`burst-summary`
- 演练：`drill-isolation`、`drill-queue`、`drill-priority`、`drill-flap`、`btn-drill-all`、`drill-all`；报告内每条为 `drill-item`（带 `data-pass="true|false|running"`），每个演练汇总为 `drill-summary`（带 `data-pass`）
- 请求：`req-user`、`req-orders`、`req-product`、`req-inventory`、`req-recommend`、`req-home`、`btn-burst`、`btn-mixed-burst`
- 下游卡片（`:id` 为下游 id）：`ds-card-<id>`、`ds-breaker-<id>`、`ds-pressure-<id>`、`fault-<id>-<preset>`、`latency-<id>`、`error-<id>`、`pool-<id>`、`recover-<id>`、`probe-<id>`、`metric-active-<id>`、`metric-queued-<id>`、`metric-qtimeout-<id>`、`metric-dsfail-<id>`

`#last-response` 根节点还带 `data-served-by / data-level / data-reason / data-breaker-state`，`#burst-summary` 带 `data-p0-all-real / data-queue-timeouts`，便于无文本依赖的断言。

---

## 6. 可调环境变量（压缩时间以便自动化核对）

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `PORT` | 空 | 设置后只监听该端口；不设则监听 `PORTS` 或 3000,8080,8000 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DC_FAILURE_THRESHOLD` | `3` | 连续真实失败几次后熔断 OPEN |
| `DC_SUCCESS_THRESHOLD` | `2` | HALF_OPEN 连续成功几次才 CLOSED |
| `DC_COOLDOWN_MS` | `4000` | OPEN 后多久允许自动/手动探测 |
| `DC_MAX_COOLDOWN_MS` | `20000` | 反复失败时指数退避冷却上限 |
| `DC_BACKOFF_FACTOR` | `2` | 冷却退避倍数 |
| `DC_CALL_TIMEOUT_MS` | `2000` | 拿到连接后等待真实下游的超时（算真实失败） |
| `DC_QUEUE_P0_MS / P1 / P2` | `4000 / 600 / 220` | 各优先级连接池排队预算 |
| `DC_CRITICAL_RECENT_TIMEOUTS` | `2` | 压力窗口内几次排队超时判为 critical |
| `DC_PRESSURE_WINDOW_MS` | `2000` | 压力统计窗口 |
| `DC_LOG_REQUESTS` | `0` | 设 `1` 在服务端打印每条判定日志 |

`scripts/verify.mjs` 会用 `PORT=<空闲端口>` 与压缩后的 `DC_COOLDOWN_MS=250` 等参数自启一个隔离实例，跑完即关。

---

## 7. 目录结构

```
server/
  index.js            HTTP 服务、路由、静态托管、多端口安全复用、/api/burst
  config.js           阈值/端口/标签，全部支持环境变量覆盖
  priority 定义
  pool.js             BulkheadPool：信号量 + 优先级 FIFO 等待队列 + 排队超时
  circuitBreaker.js   CLOSED/OPEN/HALF_OPEN + 探测槽 + 迟滞 + 指数退避 + 恢复事件
  errors.js           带 failureClass / countedAsDownstreamFailure 的错误类型
  bff.js              callWithDegradation：L0→L1→L2→L3 决策与完整 outcome；callHome 聚合
  downstreams.js      5 个下游定义、故障预设、指标、压力快照、模拟调用
  cache.js            快照缓存（支持 stale-on-error 与回填时间）
  mockData.js         中文拟真数据与兜底数据、启动时预置过期快照
  events.js           事件环形总线(300) + 请求环形日志(100)
public/
  index.html styles.css app.js   零依赖原生前端（无 CDN/外链字体）
test/core.test.mjs    优先级插队/FIFO、排队超时分类、熔断阈值、半开迟滞、退避
scripts/verify.mjs    自启隔离服务的 22 项端到端核对
```

---

## 8. 建议的评分演示脚本（约 2 分钟）

1. `npm start` → 打开 <http://localhost:3000>，确认 5 张卡片都是 `healthy / closed`。
2. 点 `drill-isolation`：看到推荐熔断降级，而用户请求始终真实 —— **隔离性**。
3. 点 `drill-queue`：看到一堆 `pool_queue_timeout` 但熔断不开、真实失败为 0，随后真实报错才开熔断 —— **两类失败分开**。
4. 点 `drill-priority`：看到 `p0AllReal=true`、P2 被牺牲 —— **保必要请求**。
5. 点 `drill-flap`：看到失败探测让冷却 4s→8s，恢复后需两次连续探测成功，时间线给出恢复时刻与持续时长 —— **防振荡 + 何时恢复**。
6. 回到页面手动点任意请求按钮，在「本次响应」与「完整核对 JSON」里复核来源与全部判定字段。
