// 各下游的模拟真实数据、缓存预热快照与 L2 默认兜底数据。

export function generateData(dsId, payload = {}) {
  switch (dsId) {
    case 'user': {
      const id = payload.id || 'u_1001';
      return {
        id,
        name: id === 'u_1001' ? '林晓' : `用户 ${id}`,
        level: 'PLUS 会员',
        city: '上海',
        unreadMessages: 3,
        source: 'user-service@v2',
      };
    }
    case 'order': {
      const userId = payload.userId || 'u_1001';
      return {
        userId,
        total: 2,
        orders: [
          { id: 'SO-20261127-0091', status: '待发货', amount: 899, item: '降噪无线耳机 Pro' },
          { id: 'SO-20261126-0317', status: '已完成', amount: 259, item: '人体工学键盘' },
        ],
        source: 'order-service@v5',
      };
    }
    case 'product': {
      const id = payload.id || 'p_88';
      return {
        id,
        title: '声阔降噪无线耳机 Pro',
        price: 899,
        originalPrice: 1099,
        tags: ['主动降噪', '40h 续航', '蓝牙 5.4'],
        rating: 4.8,
        source: 'product-service@v3',
      };
    }
    case 'inventory': {
      const sku = payload.sku || 'SKU-88-BLK';
      return {
        sku,
        stock: 137,
        saleable: true,
        warehouses: { 华东: 64, 华南: 41, 华北: 32 },
        source: 'inventory-service@v1',
      };
    }
    case 'recommend': {
      const userId = payload.userId || 'u_1001';
      return {
        userId,
        strategy: 'personalized_v3',
        items: [
          { id: 'p_101', title: '便携咖啡机', price: 329, reason: '猜你喜欢' },
          { id: 'p_102', title: '桌面补光灯', price: 149, reason: '搭配购买' },
          { id: 'p_103', title: '机械键盘手托', price: 89, reason: '热卖' },
          { id: 'p_104', title: 'USB-C 扩展坞', price: 219, reason: '同款浏览' },
        ],
        source: 'recommend-service@v4',
      };
    }
    default:
      return { ok: true, dsId };
  }
}

// L2：没有任何可用缓存时的静态默认数据（结构保持可用，并显式标注 default）。
export function fallbackData(dsId, payload = {}) {
  const base = { _fallback: true, generatedAt: new Date().toISOString() };
  switch (dsId) {
    case 'user':
      return { ...base, id: payload.id || 'u_1001', name: '尊贵的访客', level: '普通用户', city: '未知', unreadMessages: 0 };
    case 'order':
      return { ...base, userId: payload.userId || 'u_1001', total: 0, orders: [], tip: '订单暂时不可用，请稍后下拉重试' };
    case 'product':
      return { ...base, id: payload.id || 'p_88', title: '精选商品', price: null, tags: [], rating: null, tip: '商品详情加载失败，已展示默认卡片' };
    case 'inventory':
      return { ...base, sku: payload.sku || 'SKU-88-BLK', stock: null, saleable: true, stockText: '库存确认中，可先下单', warehouses: {} };
    case 'recommend':
      return {
        ...base,
        strategy: 'fallback_hot_board',
        items: [
          { id: 'h_1', title: '热销：无线充电宝', price: 129, reason: '大家都在买' },
          { id: 'h_2', title: '热销：桌面加湿器', price: 79, reason: '好评榜' },
        ],
        tip: '个性化推荐不可用，已切换为全站热门兜底',
      };
    default:
      return { ...base };
  }
}

// 启动时埋入的“上一次成功快照”，回溯一段时间使其呈现 stale 状态。
export function seedSnapshots(cache) {
  const seeds = [
    ['user:u_1001', generateData('user'), 24_000],
    ['order:u_1001', generateData('order'), 18_000],
    ['product:p_88', generateData('product'), 32_000],
    ['inventory:SKU-88-BLK', generateData('inventory'), 15_000],
    ['recommend:u_1001', generateData('recommend'), 27_000],
  ];
  for (const [k, d, age] of seeds) cache.seed(k, d, age);
}
