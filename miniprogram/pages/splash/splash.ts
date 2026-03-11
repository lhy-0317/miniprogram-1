Page({
  data: {},

  onLoad() {
    wx.hideHomeButton()
  },

  handleClose() {
    this.navigateToHome()
  },

  handleCountdownEnd() {
    this.navigateToHome()
  },

  handleExplore() {
    this.navigateToHome()
  },

  navigateToHome() {
    wx.switchTab({
      url: '/pages/home/home'
    })
  }
})
