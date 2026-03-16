Page({
  data: {
    countdownEnded: false,
    countdownTime: 5
  },

  onLoad() {
    wx.hideHomeButton()
    this.startFallbackCountdown()
  },

  onUnload() {
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer)
    }
  },

  startFallbackCountdown() {
    let count = 5
    this.countdownTimer = setInterval(() => {
      count--
      if (count <= 0) {
        clearInterval(this.countdownTimer)
        this.handleCountdownEnd()
      }
    }, 1000)
  },

  handleSkip() {
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer)
    }
    this.navigateToHome()
  },

  handleCountdownEnd() {
    if (!this.data.countdownEnded) {
      this.setData({ countdownEnded: true })
      if (this.countdownTimer) {
        clearInterval(this.countdownTimer)
      }
      this.navigateToHome()
    }
  },

  handleExplore() {
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer)
    }
    this.navigateToHome()
  },

  navigateToHome() {
    wx.switchTab({
      url: '/pages/home/home'
    })
  }
})
