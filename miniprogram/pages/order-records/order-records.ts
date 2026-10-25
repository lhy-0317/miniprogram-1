import { api } from '../../utils/api';

/** 分 → 元 */
function fen2yuan(fen: any): string {
  return (Number(fen || 0) / 100).toFixed(2);
}

const STATUS_STYLE: Record<string, { cls: string; text: string }> = {
  pending: { cls: 'pending', text: '待付款' },
  paid: { cls: 'paid', text: '已付款' },
  completed: { cls: 'completed', text: '已完成' },
  cancelled: { cls: 'cancelled', text: '已取消' },
  failed: { cls: 'failed', text: '已失败' },
};

Page({
  data: {
    loading: true,
    loadError: '',

    orders: [] as any[],
    stats: { all: 0, pending: 0, paid: 0, completed: 0 } as Record<string, number>,
    filterStatus: '',

    page: 1,
    pageSize: 10,
    total: 0,
    hasMore: false,
    loadingMore: false,

    paymentEnabled: false,
    acting: false,

    detailVisible: false,
    detail: null as any,
  },

  onLoad() {
    this.loadOrders(true);
  },

  /** 从支付/取货等操作返回时刷新，保证状态与列表一致 */
  onShow() {
    if (!this.data.loading) this.loadOrders(true);
  },

  retry() {
    this.loadOrders(true);
  },

  onPullDownRefresh() {
    this.loadOrders(true).then(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loadingMore) this.loadOrders(false);
  },

  async loadOrders(reset: boolean) {
    const page = reset ? 1 : this.data.page + 1;
    if (reset) this.setData({ loading: true, loadError: '' });
    else this.setData({ loadingMore: true });

    try {
      const params: Record<string, any> = { page, pageSize: this.data.pageSize };
      if (this.data.filterStatus) params.status = this.data.filterStatus;

      const res = await api.get('/api/order/myOrders', params);
      if (!res.success) throw new Error(res.message || '订单加载失败');

      const incoming = (res.data.list || []).map((o: any) => ({
        ...o,
        statusCls: (STATUS_STYLE[o.status] || STATUS_STYLE.pending).cls,
        payableText: fen2yuan(o.payable),
        subtotalText: fen2yuan(o.subtotal),
        discountText: fen2yuan(o.discount),
        createTimeText: this.formatTime(o.createTime),
        paidAtText: o.paidAt ? this.formatTime(o.paidAt) : '',
        itemsText: (o.items || []).map((i: any) => `${i.name}×${i.qty}`).join('、'),
        itemLines: (o.items || []).map((i: any) => ({
          ...i,
          priceText: fen2yuan(i.price),
          amountText: fen2yuan(i.amount),
        })),
        canPay: o.status === 'pending',
        canCancel: o.status === 'pending',
        canConfirm: o.status === 'paid',
        typeText: o.type === 'shop' ? '商店订单' : '取纸订单',
      }));

      this.setData({
        orders: reset ? incoming : this.data.orders.concat(incoming),
        stats: res.data.stats || this.data.stats,
        total: res.data.total || 0,
        hasMore: !!res.data.hasMore,
        page,
        paymentEnabled: !!res.data.paymentEnabled,
        loading: false,
        loadingMore: false,
      });
    } catch (err: any) {
      this.setData({
        loading: false,
        loadingMore: false,
        loadError: (err && err.message) || '订单加载失败，请稍后重试',
      });
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

  /** 顶部统计即状态筛选 */
  switchFilter(e: any) {
    const status = e.currentTarget.dataset.status || '';
    if (status === this.data.filterStatus) return;
    this.setData({ filterStatus: status });
    this.loadOrders(true);
  },

  // ===== 订单操作 =====

  /** 去支付：真实支付未接入时走体验版模拟支付 */
  async payOrder(e: any) {
    const orderId = e.currentTarget.dataset.id;
    const order = this.data.orders.find((o: any) => o._id === orderId);
    if (!order || this.data.acting) return;

    const content = this.data.paymentEnabled
      ? `需支付 ¥${order.payableText}，确认发起支付？`
      : `需支付 ¥${order.payableText}。\n当前为体验版，支付为模拟流程，不会真实扣款。确认继续？`;

    wx.showModal({
      title: '确认支付',
      content,
      confirmText: '确认支付',
      success: (r) => {
        if (r.confirm) this.doPay(orderId);
      },
    });
  },

  async doPay(orderId: string) {
    this.setData({ acting: true });
    wx.showLoading({ title: '支付中...' });

    try {
      const res = await api.post('/api/order/pay', { orderId });

      // 已配置微信支付：拉起收银台，状态由支付回调推进
      if (res.success && res.data && res.data.needWxPay && res.data.prepayParams) {
        wx.hideLoading();
        wx.requestPayment({
          ...res.data.prepayParams,
          success: () => {
            wx.showToast({ title: '支付成功', icon: 'success' });
            this.loadOrders(true);
          },
          fail: () => wx.showToast({ title: '支付已取消', icon: 'none' }),
        });
        return;
      }

      wx.hideLoading();

      if (!res.success) {
        wx.showModal({ title: '支付失败', content: res.message || '请稍后重试', showCancel: false });
        return;
      }

      wx.showModal({
        title: res.data.status === 'completed' ? '支付成功' : '支付成功',
        content: res.data.tip || '支付已完成',
        showCancel: false,
      });
      await this.loadOrders(true);
    } catch (err: any) {
      wx.hideLoading();
      wx.showModal({ title: '支付失败', content: (err && err.message) || '请稍后重试', showCancel: false });
    } finally {
      this.setData({ acting: false });
    }
  },

  /** 取消订单（仅待付款可取消，券会退回） */
  cancelOrder(e: any) {
    const orderId = e.currentTarget.dataset.id;
    if (this.data.acting) return;

    wx.showModal({
      title: '取消订单',
      content: '确定取消该订单吗？如使用了优惠券将一并退回。',
      confirmText: '取消订单',
      cancelText: '再想想',
      success: (r) => {
        if (r.confirm) this.doCancel(orderId);
      },
    });
  },

  async doCancel(orderId: string) {
    this.setData({ acting: true });
    wx.showLoading({ title: '处理中...' });
    try {
      const res = await api.post('/api/order/cancel', { orderId });
      wx.hideLoading();
      if (!res.success) {
        wx.showModal({ title: '取消失败', content: res.message || '请稍后重试', showCancel: false });
        return;
      }
      wx.showToast({ title: res.data.tip || '订单已取消', icon: 'none' });
      await this.loadOrders(true);
    } catch (err: any) {
      wx.hideLoading();
      wx.showModal({ title: '取消失败', content: (err && err.message) || '请稍后重试', showCancel: false });
    } finally {
      this.setData({ acting: false });
    }
  },

  /** 确认取货：已付款 → 已完成 */
  confirmOrder(e: any) {
    const orderId = e.currentTarget.dataset.id;
    if (this.data.acting) return;

    wx.showModal({
      title: '确认取货',
      content: '确认已取到商品？确认后订单将标记为已完成。',
      confirmText: '确认取货',
      success: (r) => {
        if (r.confirm) this.doConfirm(orderId);
      },
    });
  },

  async doConfirm(orderId: string) {
    this.setData({ acting: true });
    wx.showLoading({ title: '处理中...' });
    try {
      const res = await api.post('/api/order/confirm', { orderId });
      wx.hideLoading();
      if (!res.success) {
        wx.showModal({ title: '操作失败', content: res.message || '请稍后重试', showCancel: false });
        return;
      }
      wx.showToast({ title: res.data.tip || '已确认取货', icon: 'success' });
      await this.loadOrders(true);
    } catch (err: any) {
      wx.hideLoading();
      wx.showModal({ title: '操作失败', content: (err && err.message) || '请稍后重试', showCancel: false });
    } finally {
      this.setData({ acting: false });
    }
  },

  // ===== 详情 =====

  openDetail(e: any) {
    const orderId = e.currentTarget.dataset.id;
    const order = this.data.orders.find((o: any) => o._id === orderId);
    if (order) this.setData({ detail: order, detailVisible: true });
  },

  closeDetail() {
    this.setData({ detailVisible: false });
  },

  noop() {},

  goShop() {
    wx.switchTab({ url: '/pages/shop/shop' });
  },
});
