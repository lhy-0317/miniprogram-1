import { api } from '../../utils/api';

interface Calc {
  lines: any[];
  subtotal: number;
  discount: number;
  payable: number;
  freeQty: number;
  couponLabel: string;
}

/** 分 → 元（两位小数） */
function fen2yuan(fen: any): string {
  return (Number(fen || 0) / 100).toFixed(2);
}

Page({
  data: {
    loading: true,
    loadError: '',

    products: [] as any[],
    /** productId → 数量 */
    qtyMap: {} as Record<string, number>,
    totalQty: 0,

    couponList: [] as any[],
    selectedCouponId: '',
    selectedCouponDesc: '',

    subtotalText: '0.00',
    discountText: '0.00',
    payableText: '0.00',
    freeQty: 0,

    couponVisible: false,
    ordersVisible: false,
    orders: [] as any[],
    ordersLoading: false,

    placing: false,
    paymentEnabled: false,
    fulfillmentTip: '',
  },

  onLoad() {
    this.loadProducts();
    this.loadCoupons();
  },

  /** 从「我的」等页面切回来时刷新券与订单，避免用到已核销的券 */
  onShow() {
    this.loadCoupons();
  },

  // ===== 数据加载 =====

  async loadProducts() {
    this.setData({ loading: true, loadError: '' });
    try {
      const res = await api.get('/api/order/products');
      if (!res.success) throw new Error(res.message || '商品加载失败');

      const products = (res.data.products || []).map((p: any) => ({
        ...p,
        priceText: fen2yuan(p.price),
        // 库存为 null 表示不限；0 为售罄
        stock: p.stock === null || p.stock === undefined ? null : Number(p.stock),
        soldOut: !!p.soldOut || (p.stock !== null && p.stock !== undefined && Number(p.stock) <= 0),
        stockText: p.stock === null || p.stock === undefined
          ? ''
          : (Number(p.stock) <= 0 ? '已售罄' : (Number(p.stock) <= 10 ? '仅剩 ' + p.stock + ' 件' : '')),
      }));

      this.setData({
        products,
        loading: false,
        paymentEnabled: !!res.data.paymentEnabled,
        fulfillmentTip: res.data.paymentEnabled
          ? '下单后在线支付'
          : '下单后请凭订单号到服务台付款取货',
      });
    } catch (err: any) {
      this.setData({
        loading: false,
        loadError: (err && err.message) || '商品加载失败，请稍后重试',
      });
    }
  },

  async loadCoupons() {
    try {
      const res = await api.get('/api/coupons', undefined, { silent: true });
      if (!res.success) return;

      const couponList = (res.data.coupons || []).filter((c: any) => c.status === 'unused');

      // 选中的券可能已被核销/过期：此时清空选择
      const stillValid = couponList.some((c: any) => c.id === this.data.selectedCouponId);
      const patch: any = { couponList };
      if (!stillValid && this.data.selectedCouponId) {
        patch.selectedCouponId = '';
        patch.selectedCouponDesc = '';
      }
      this.setData(patch);

      if (!stillValid) await this.refreshQuote();
    } catch {
      // 券加载失败不阻塞购物
    }
  },

  async loadOrders() {
    this.setData({ ordersLoading: true });
    try {
      const res = await api.get('/api/order/myOrders', { pageSize: 20 });
      if (res.success) {
        this.setData({
          orders: (res.data.list || []).map((o: any) => ({
            ...o,
            payableText: fen2yuan(o.payable),
            createTimeText: this.formatTime(o.createTime),
            itemsText: (o.items || []).map((i: any) => `${i.name}×${i.qty}`).join('、'),
          })),
        });
      }
    } catch {
      // 静默失败
    } finally {
      this.setData({ ordersLoading: false });
    }
  },

  formatTime(v: any): string {
    if (!v) return '';
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.replace('T', ' ').slice(0, 16);
    const d = new Date(v);
    if (isNaN(d.getTime())) return '';
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  },

  // ===== 购物车与金额 =====

  /** 组装下单参数（只含数量 > 0 的商品） */
  buildItems() {
    const map = this.data.qtyMap;
    return Object.keys(map)
      .filter((id) => map[id] > 0)
      .map((id) => ({ productId: id, qty: map[id] }));
  },

  changeQty(e: any) {
    const id = e.currentTarget.dataset.id;
    const delta = Number(e.currentTarget.dataset.delta);
    const current = this.data.qtyMap[id] || 0;
    const product = this.data.products.find((p: any) => p.id === id);
    const stock = product && product.stock !== null ? product.stock : null;

    // 有库存的商品：加购数量不得超过剩余库存
    const upper = stock === null ? 99 : Math.min(stock, 99);
    const next = Math.max(Math.min(current + delta, upper), 0);

    if (delta > 0 && next === current && stock !== null && current >= stock) {
      wx.showToast({ title: '库存仅剩 ' + stock + ' 件', icon: 'none' });
      return;
    }

    // 显式标注类型：dataset 取到的 id 为 any，展开后 TS 会推断成 {} 导致索引报错
    const qtyMap: Record<string, number> = { ...this.data.qtyMap, [id]: next };
    const totalQty = Object.keys(qtyMap).reduce((sum, k) => sum + (qtyMap[k] || 0), 0);

    this.setData({ qtyMap, totalQty });
    this.refreshQuote();
  },

  clearCart() {
    this.setData({ qtyMap: {}, totalQty: 0 });
    this.refreshQuote();
  },

  /** 向服务端询价：金额与优惠一律以服务端计算为准 */
  async refreshQuote() {
    const items = this.buildItems();
    if (items.length === 0) {
      this.setData({
        subtotalText: '0.00', discountText: '0.00', payableText: '0.00', freeQty: 0,
      });
      return;
    }

    try {
      const res = await api.post('/api/order/quote', {
        items,
        couponId: this.data.selectedCouponId || undefined,
      });
      if (!res.success) throw new Error(res.message || '询价失败');

      const calc = res.data as Calc;
      this.setData({
        subtotalText: fen2yuan(calc.subtotal),
        discountText: fen2yuan(calc.discount),
        payableText: fen2yuan(calc.payable),
        freeQty: calc.freeQty || 0,
      });
    } catch (err: any) {
      wx.showToast({ title: (err && err.message) || '金额计算失败', icon: 'none' });
    }
  },

  // ===== 优惠券选择 =====

  openCoupons() {
    if (this.data.couponList.length === 0) {
      wx.showToast({ title: '暂无可用优惠券', icon: 'none' });
      return;
    }
    this.setData({ couponVisible: true });
  },

  closeCoupons() {
    this.setData({ couponVisible: false });
  },

  chooseCoupon(e: any) {
    const id = e.currentTarget.dataset.id || '';
    const coupon = this.data.couponList.find((c: any) => c.id === id);

    this.setData({
      selectedCouponId: id,
      selectedCouponDesc: coupon ? (coupon.desc || coupon.type) : '',
      couponVisible: false,
    });
    this.refreshQuote();
  },

  clearCoupon() {
    this.setData({ selectedCouponId: '', selectedCouponDesc: '', couponVisible: false });
    this.refreshQuote();
  },

  // ===== 下单 =====

  submitOrder() {
    const items = this.buildItems();
    if (items.length === 0) {
      wx.showToast({ title: '请先选择商品', icon: 'none' });
      return;
    }

    wx.showModal({
      title: '确认下单',
      content: `应付 ¥${this.data.payableText}（共 ${this.data.totalQty} 件）${this.data.paymentEnabled ? '' : '\n下单后请凭订单号到服务台付款取货'}`,
      confirmText: '确认下单',
      success: (r) => {
        if (r.confirm) this.doSubmit(items);
      },
    });
  },

  async doSubmit(items: any[]) {
    if (this.data.placing) return;
    this.setData({ placing: true });
    wx.showLoading({ title: '提交中...' });

    try {
      const res = await api.post('/api/order/shopOrder', {
        items,
        couponId: this.data.selectedCouponId || undefined,
      });

      wx.hideLoading();

      if (!res.success) {
        wx.showModal({ title: '下单失败', content: res.message || '请稍后重试', showCancel: false });
        // 券可能已被占用，刷新券列表
        await this.loadCoupons();
        return;
      }

      const d = res.data;
      wx.showModal({
        title: d.status === 'completed' ? '下单成功（免单）' : '下单成功',
        content: `订单号：${d.orderSn}\n应付：¥${fen2yuan(d.payable)}\n\n${d.tip || ''}`,
        confirmText: '查看订单',
        cancelText: '继续选购',
        success: (r) => {
          // 引导到订单记录完成后续支付 / 取货，形成闭环
          if (r.confirm) wx.navigateTo({ url: '/pages/order-records/order-records' });
        },
      });

      // 清空购物车与用掉的券
      this.setData({ qtyMap: {}, totalQty: 0, selectedCouponId: '', selectedCouponDesc: '' });
      await Promise.all([this.loadCoupons(), this.loadOrders()]);
      this.refreshQuote();
    } catch (err: any) {
      wx.hideLoading();
      wx.showModal({ title: '下单失败', content: (err && err.message) || '请稍后重试', showCancel: false });
    } finally {
      this.setData({ placing: false });
    }
  },

  // ===== 我的订单 =====

  openOrders() {
    this.setData({ ordersVisible: true });
    this.loadOrders();
  },

  closeOrders() {
    this.setData({ ordersVisible: false });
  },

  goProfile() {
    wx.switchTab({ url: '/pages/profile/profile' });
  },
});
