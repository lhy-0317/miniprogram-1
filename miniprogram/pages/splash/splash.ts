/**
 * 开屏页。
 *
 * 修复：原实现存在双重倒计时 —— t-count-down 组件自带 5 秒倒计时，
 * 此处又用 setInterval 每秒跑一遍，且实例属性 countdownTimer 从未声明
 * （tsc 报错）。现统一以组件倒计时为唯一时序源，删除冗余 interval。
 */
Page({
  data: {
    countdownEnded: false,
  },

  onLoad() {
    wx.hideHomeButton();
  },

  handleSkip() {
    this.navigateToHome();
  },

  handleCountdownEnd() {
    if (!this.data.countdownEnded) {
      this.setData({ countdownEnded: true });
      this.navigateToHome();
    }
  },

  handleExplore() {
    this.navigateToHome();
  },

  navigateToHome() {
    wx.switchTab({
      url: '/pages/shop/shop',
      fail: () => {
        wx.showToast({ title: '跳转失败，请点击底部商店', icon: 'none' });
      },
    });
  },
});