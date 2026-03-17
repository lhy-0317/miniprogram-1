const app = getApp<IAppOption>()

Page({
  data: {
    notificationEnabled: true,
    couponReminderEnabled: true,
    cacheSize: '0KB',
    version: '1.0.0',
    showDialog: false,
    dialogTitle: '',
    dialogContent: '',
    dialogType: ''
  },

  onLoad() {
    this.loadSettings()
    this.calculateCacheSize()
  },

  loadSettings() {
    const settings = wx.getStorageSync('appSettings') || {}
    this.setData({
      notificationEnabled: settings.notificationEnabled !== false,
      couponReminderEnabled: settings.couponReminderEnabled !== false
    })
  },

  saveSettings() {
    const settings = {
      notificationEnabled: this.data.notificationEnabled,
      couponReminderEnabled: this.data.couponReminderEnabled
    }
    wx.setStorageSync('appSettings', settings)
  },

  toggleNotification(e: any) {
    this.setData({
      notificationEnabled: e.detail.value
    })
    this.saveSettings()
  },

  toggleCouponReminder(e: any) {
    this.setData({
      couponReminderEnabled: e.detail.value
    })
    this.saveSettings()
  },

  calculateCacheSize() {
    try {
      const res = wx.getStorageInfoSync()
      const sizeKB = res.currentSize
      let sizeStr = ''
      if (sizeKB < 1024) {
        sizeStr = sizeKB + 'KB'
      } else {
        sizeStr = (sizeKB / 1024).toFixed(2) + 'MB'
      }
      this.setData({ cacheSize: sizeStr })
    } catch (e) {
      this.setData({ cacheSize: '未知' })
    }
  },

  clearCache() {
    this.setData({
      showDialog: true,
      dialogTitle: '清除缓存',
      dialogContent: '确定要清除缓存吗？这不会影响您的账户数据。',
      dialogType: 'clearCache'
    })
  },

  showPrivacyPolicy() {
    wx.navigateTo({
      url: '/pages/feedback/feedback?type=privacy'
    })
  },

  showUserAgreement() {
    wx.navigateTo({
      url: '/pages/feedback/feedback?type=agreement'
    })
  },

  checkUpdate() {
    const updateManager = wx.getUpdateManager()

    wx.showLoading({ title: '检查中...' })

    updateManager.onCheckForUpdate((res) => {
      wx.hideLoading()
      if (res.hasUpdate) {
        wx.showToast({
          title: '发现新版本',
          icon: 'none'
        })
      } else {
        wx.showToast({
          title: '已是最新版本',
          icon: 'success'
        })
      }
    })

    updateManager.onUpdateReady(() => {
      wx.showModal({
        title: '更新提示',
        content: '新版本已准备好，是否重启应用？',
        success: (res) => {
          if (res.confirm) {
            updateManager.applyUpdate()
          }
        }
      })
    })

    updateManager.onUpdateFailed(() => {
      wx.hideLoading()
      wx.showToast({
        title: '更新失败',
        icon: 'error'
      })
    })
  },

  handleLogout() {
    this.setData({
      showDialog: true,
      dialogTitle: '退出登录',
      dialogContent: '确定要退出登录吗？',
      dialogType: 'logout'
    })
  },

  onDialogConfirm() {
    this.setData({ showDialog: false })

    if (this.data.dialogType === 'clearCache') {
      try {
        const openid = wx.getStorageSync('openid')
        const userInfo = wx.getStorageSync('userInfo')
        
        wx.clearStorageSync()
        
        if (openid) wx.setStorageSync('openid', openid)
        if (userInfo) wx.setStorageSync('userInfo', userInfo)
        
        this.calculateCacheSize()
        
        wx.showToast({
          title: '清除成功',
          icon: 'success'
        })
      } catch (e) {
        wx.showToast({
          title: '清除失败',
          icon: 'error'
        })
      }
    } else if (this.data.dialogType === 'logout') {
      wx.clearStorageSync()
      
      if (app && app.globalData) {
        app.globalData.openid = null
        app.globalData.userInfo = null
      }

      wx.showToast({
        title: '已退出登录',
        icon: 'success'
      })

      setTimeout(() => {
        wx.switchTab({
          url: '/pages/home/home'
        })
      }, 1500)
    }
  },

  onDialogCancel() {
    this.setData({ showDialog: false })
  }
})
