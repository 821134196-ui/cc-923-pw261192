// 简单的“最后一次成功数据”缓存：允许过期后继续作为 stale 兜底（stale-on-error）。
export class SnapshotCache {
  constructor(ttlMs = 10_000) {
    this.ttlMs = ttlMs;
    this.store = new Map();
  }

  key(parts) {
    return Array.isArray(parts) ? parts.join(':') : String(parts);
  }

  set(key, data, savedAt = Date.now()) {
    this.store.set(key, { data, savedAt });
  }

  // 主动埋入“历史成功快照”，可指定回溯时间让页面直接看到 stale 缓存。
  seed(key, data, ageMs = 30_000) {
    this.set(key, data, Date.now() - ageMs);
  }

  get(key) {
    const hit = this.store.get(key);
    if (!hit) return null;
    const ageMs = Date.now() - hit.savedAt;
    return {
      data: hit.data,
      savedAt: hit.savedAt,
      ageMs,
      stale: ageMs > this.ttlMs,
      ttlMs: this.ttlMs,
    };
  }

  clear() {
    this.store.clear();
  }
}
