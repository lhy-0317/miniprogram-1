import { api } from '../../utils/api';
import { DISPENSE_POLL_INTERVAL, DISPENSE_POLL_TIMEOUT } from '../../utils/config';

Page({
  data: {
    deviceStatus: 'online' as 'online' | 'offline' | 'maintenance',
    statusText: '设备在线 · 纸张充足',
    loadingVisible: false,
    currentDeviceId: '',
    /** 可用券列表，扫码后供用户选择 */
    availableCoupons: [] as any[],
    showCouponPicker: false,
  },

  onLoad() {
    this.loadCoupons();
  },

  onShow() {
    // 从答题页返回时刷新券状态
    if (this.data.availableCoupons.length > 0) {
      this.loadCoupons();
    }
  },

  /** 拉取当前用户的可用券 */
  async loadCoupons() {
    try {
      const res = await api.get('/api/coupons', undefined, { silent: true });
      if (res.success) {
        const list = (res.data?.coupons || []).filter((c: any) => c.status === 'unused');
        this.setData({ availableCoupons: list });
      }
    } catch {
      // 券信息拉取失败不阻断扫码主流程
    }
  },

  handleScan() {
    wx.scanCode({
      success: (res) => {
        const deviceId = res.result;
        this.setData({ currentDeviceId: deviceId });
        this.checkDeviceStatus(deviceId);
      },
      fail: () => {
        wx.showToast({ title: '扫码失败', icon: 'error' });
      },
    });
  },

  async checkDeviceStatus(deviceId: string) {
    wx.showLoading({ title: '检查设备状态...' });

    try {
      const res = await api.get(`/api/device/status/${deviceId}`);
      if (res.success) {
        const { status, statusText } = res.data;
        this.setData({ deviceStatus: status, statusText });

        if (status === 'online') {
          wx.hideLoading();
          this.confirmOrder(deviceId);
        } else {
          wx.hideLoading();
          wx.showToast({ title: statusText, icon: 'none' });
        }
      }
    } catch {
      wx.hideLoading();
      wx.showToast({ title: '检查设备失败，请稍后重试', icon: 'none' });
    }
  },

  /** 有券则让用户选券，无券直接确认付费 */
  confirmOrder(deviceId: string) {
    if (this.data.availableCoupons.length > 0) {
      this.setData({ showCouponPicker: true });
      return;
    }
    this.confirmPaid(deviceId);
  },

  confirmPaid(deviceId: string) {
    this.setData({ showCouponPicker: false });
    wx.showModal({
      title: '确认领纸',
      content: '确认领取一份纸巾？',
      success: (res) => {
        if (res.confirm) {
          this.createOrder(deviceId, '');
        }
      },
    });
  },

  /** 使用指定券下单 */
  useCoupon(e: any) {
    const couponId = e.currentTarget.dataset.id;
    this.setData({ showCouponPicker: false });
    this.createOrder(this.data.currentDeviceId, couponId);
  },

  closeCouponPicker() {
    this.setData({ showCouponPicker: false });
  },

  /**
   * 创建订单。
   *
   * 修复 P1#5：原先只传 deviceId，从不传 couponId，
   * 导致答题获得的免单券永远用不上。
   */
  async createOrder(deviceId: string, couponId: string) {
    wx.showLoading({ title: '创建订单...' });

    try {
      const res = await api.post('/api/payment/order', { deviceId, couponId });

      if (!res.success) {
        wx.hideLoading();
        wx.showToast({ title: res.message || '创建订单失败', icon: 'none' });
        return;
      }

      const { orderId, status, actualPay, prepayParams, failReason } = res.data;

      // 券模式：云函数已直接完成出纸
      if (actualPay === 0 || !prepayParams) {
        wx.hideLoading();
        this.loadCoupons();

        if (status === 'completed') {
          this.onDispenseSuccess();
        } else if (status === 'failed') {
          // 修复：失败状态在创建订单响应里已确定，即时提示；
          // 旧实现仍进入轮询，空等 30 秒才报超时
          wx.showModal({
            title: '领取失败',
            content: failReason || '设备暂时无法出纸，请稍后再试',
            showCancel: false,
          });
        } else {
          // 付费但未完成，进入轮询
          this.showDispensing(orderId);
        }
        return;
      }

      wx.hideLoading();
      this.requestWechatPay(orderId, prepayParams);
    } catch {
      wx.hideLoading();
      wx.showToast({ title: '创建订单失败', icon: 'none' });
    }
  },

  requestWechatPay(orderId: string, prepayParams: any) {
    wx.requestPayment({
      timeStamp: prepayParams.timeStamp,
      nonceStr: prepayParams.nonceStr,
      package: prepayParams.package,
      signType: prepayParams.signType,
      paySign: prepayParams.paySign,
      success: () => {
        this.showDispensing(orderId);
      },
      fail: (err) => {
        if (err.errMsg.includes('cancel')) {
          wx.showToast({ title: '支付已取消', icon: 'none' });
        } else {
          wx.showToast({ title: '支付失败', icon: 'error' });
        }
      },
    });
  },

  /** 出纸成功：引导进入答题页 */
  onDispenseSuccess() {
    wx.showToast({ title: '出纸成功！', icon: 'success' });
    this.loadCoupons();

    setTimeout(() => {
      this.goToQuiz();
    }, 1500);
  },

  /**
   * 跳转答题页。
   *
   * 修复 P0#4：quiz 在 tabBar 中，必须用 switchTab，
   * 原实现用 navigateTo 会静默失败且无 fail 回调，用户只看到卡住。
   */
  goToQuiz() {
    wx.switchTab({
      url: '/pages/quiz/quiz',
      fail: () => {
        wx.showToast({ title: '跳转答题页失败，请手动点击答题', icon: 'none' });
      },
    });
  },

  showDispensing(orderId: string) {
    this.setData({ loadingVisible: true });

    const startTime = Date.now();
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const stopPolling = () => {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };

    pollTimer = setInterval(async () => {
      try {
        // 静默轮询，失败不弹 toast，避免每2 秒刷屏
        const res = await api.get(`/api/payment/order/${orderId}`, undefined, { silent: true });

        if (res.success && res.data.status === 'completed') {
          stopPolling();
          this.setData({ loadingVisible: false });
          this.onDispenseSuccess();
          return;
        }

        if (res.success && res.data.status === 'failed') {
          stopPolling();
          this.setData({ loadingVisible: false });
          wx.showToast({ title: res.data.failReason || '出纸失败，请联系管理员', icon: 'none' });
          return;
        }

        if (Date.now() - startTime > DISPENSE_POLL_TIMEOUT) {
          stopPolling();
          this.setData({ loadingVisible: false });
          wx.showToast({ title: '出纸超时，请检查设备', icon: 'none' });
        }
      } catch {
        // 网络异常继续轮询
      }
    }, DISPENSE_POLL_INTERVAL);
  },
});