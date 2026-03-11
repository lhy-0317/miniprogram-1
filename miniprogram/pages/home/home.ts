Page({
  data: {
    deviceStatus: 'online',
    statusText: '设备在线 · 纸张充足',
    loadingVisible: false
  },

  onLoad() {},

  handleScan() {
    wx.scanCode({
      success: (res) => {
        this.checkDeviceStatus(res.result)
      },
      fail: () => {
        wx.showToast({
          title: '扫码失败',
          icon: 'error'
        })
      }
    })
  },

  checkDeviceStatus(deviceId: string) {
    wx.showLoading({ title: '检查设备状态...' })
    
    setTimeout(() => {
      wx.hideLoading()
      
      const isOnline = Math.random() > 0.1
      
      if (isOnline) {
        this.setData({
          deviceStatus: 'online',
          statusText: '设备在线 · 纸张充足'
        })
        this.triggerPayment()
      } else {
        this.setData({
          deviceStatus: 'offline',
          statusText: '设备维护中'
        })
        wx.showToast({
          title: '设备维护中',
          icon: 'none'
        })
      }
    }, 500)
  },

  triggerPayment() {
    wx.showModal({
      title: '确认领纸',
      content: '确认领取一份纸巾？',
      success: (res) => {
        if (res.confirm) {
          this.showLoading()
        }
      }
    })
  },

  showLoading() {
    this.setData({ loadingVisible: true })
    
    setTimeout(() => {
      this.setData({ loadingVisible: false })
      wx.showToast({
        title: '出纸成功！',
        icon: 'success'
      })
      
      setTimeout(() => {
        wx.navigateTo({
          url: '/pages/quiz/quiz'
        })
      }, 1500)
    }, 2000)
  }
})
