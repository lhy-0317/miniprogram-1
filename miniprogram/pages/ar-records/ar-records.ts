import { api } from '../../utils/api';

Page({
  data: {
    records: [] as any[],
    totalRecords: 0,
    uniqueHerbs: 0,
    loading: true,
  },

  onLoad() {
    this.loadRecords();
  },

  onShow() {
    this.loadRecords();
  },

  /**
   * 修复：原实现调用 stats 后把结果硬编码为空（records: []），
   * 页面恒为空。现改为读取 userService 的 ar-records action。
   *
   * 注意：ar_records 当前无写入方（AR 页为占位实现），
   * 因此正常情况下展示空态与「去识别」引导 —— 这是诚实的行为；
   * 将来 AR 页真正写入识别记录后，此页无需再改。
   */
  async loadRecords() {
    this.setData({ loading: true });

    try {
      const res = await api.get('/api/user/ar-records');

      if (res.success) {
        const records = res.data.records || [];
        const uniqueHerbs = new Set(records.map((r: any) => r.herbName)).size;

        this.setData({
          records,
          totalRecords: res.data.total || records.length,
          uniqueHerbs,
          loading: false,
        });
      }
    } catch {
      this.setData({ records: [], totalRecords: 0, uniqueHerbs: 0, loading: false });
    }
  },

  goToAr() {
    wx.switchTab({
      url: '/pages/ar/ar',
      fail: () => {
        wx.showToast({ title: '跳转失败，请点击底部AR识别', icon: 'none' });
      },
    });
  },
});