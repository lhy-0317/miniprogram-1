Page({
  data: {
    notificationEnabled: true,
    couponReminderEnabled: true,
    cacheSize: '0KB',
    version: '1.0.0',
    showDialog: false,
    dialogTitle: '',
    dialogContent: '',
    dialogType: '',
    showPrivacyPopup: false,
    privacyTitle: '',
    privacyContent: '',
    userAgreementContent: `用户服务协议

欢迎使用智惠本草小程序！

一、服务说明
本小程序为用户提供扫码取纸、趣味答题、AR本草识别等服务。

二、用户信息
为了提供更好的服务，我们会收集必要的用户信息，包括但不限于：
1. 微信昵称和头像（可选）
2. 答题记录和订单记录
3. 优惠券领取和订单记录

三、用户责任
用户在使用本小程序时，应当遵守相关法律法规，不得从事违法活动。

四、免责声明
我们会尽力保护用户信息安全，但不对因不可抗力导致的信息泄露承担责任。

五、协议修改
我们有权根据需要修改本协议，修改后的协议一经公布即生效。`,
    privacyPolicyContent: `隐私政策

智惠本草非常重视用户的隐私保护。

一、信息收集
我们收集以下信息以提供服务：
1. 用户基本信息：微信昵称、头像（用户自愿提供）
2. 使用信息：答题记录、取纸记录、AR识别记录
3. 设备信息：为了优化服务体验，我们会收集设备相关信息

二、信息使用
我们将收集的信息用于：
1. 提供和优化小程序服务
2. 发放和管理优惠券
3. 统计用户数据以改进产品

三、信息保护
我们采取严格的安全措施保护用户信息：
1. 使用加密技术传输数据
2. 限制信息访问权限
3. 定期进行安全检查

四、信息共享
除以下情况外，我们不会向第三方共享用户信息：
1. 获得用户明确同意
2. 法律法规要求
3. 为完成服务所必需（如支付服务）

五、用户权利
用户有权：
1. 访问和修改自己的个人信息
2. 注销账户
3. 撤回同意

六、未成年人保护
我们非常重视未成年人的隐私保护，建议未成年人在监护人指导下使用本服务。

七、政策更新
我们可能会适时更新本隐私政策，更新后的政策将在小程序内公布。

如有疑问，请通过小程序内的反馈渠道联系我们。`
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
    } catch {
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
    this.setData({
      showPrivacyPopup: true,
      privacyTitle: '隐私政策',
      privacyContent: this.data.privacyPolicyContent
    })
  },

  showUserAgreement() {
    this.setData({
      showPrivacyPopup: true,
      privacyTitle: '用户服务协议',
      privacyContent: this.data.userAgreementContent
    })
  },

  closePrivacyPopup() {
    this.setData({
      showPrivacyPopup: false
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
      } catch {
        wx.showToast({
          title: '清除失败',
          icon: 'error'
        })
      }
    } else if (this.data.dialogType === 'logout') {
      wx.clearStorageSync()

      wx.showToast({
        title: '已退出登录',
        icon: 'success'
      })

      setTimeout(() => {
        wx.switchTab({
          url: '/pages/shop/shop'
        })
      }, 1500)
    }
  },

  onDialogCancel() {
    this.setData({ showDialog: false })
  }
})
