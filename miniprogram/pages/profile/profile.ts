const app = getApp<IAppOption>()

Page({
  data: {
    isLoggedIn: false,
    userInfo: {},
    userId: '',
    openid: '',
    filterType: 'all',
    stats: {
      savedPaper: 0,
      quizCount: 0
    },
    coupons: [],
    filteredCoupons: [],
    agreedToPrivacy: false,
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
2. 答题记录和使用记录
3. 优惠券领取和使用记录

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
    this.checkLoginStatus()
  },

  onShow() {
    this.refreshUserInfo()
  },

  refreshUserInfo() {
    const openid = wx.getStorageSync('openid')
    const userInfo = wx.getStorageSync('userInfo')
    
    if (openid && userInfo) {
      this.setData({
        isLoggedIn: true,
        openid,
        userInfo,
        userId: openid.slice(-8)
      })
      this.loadUserFromDatabase()
      this.loadUserStats()
      this.loadCoupons()
    }
    this.updateFilteredCoupons()
  },

  checkLoginStatus() {
    this.refreshUserInfo()
  },

  loadUserFromDatabase() {
    const db = wx.cloud.database()
    
    db.collection('users').where({
      _openid: this.data.openid
    }).get({
      success: (res: any) => {
        if (res.data.length > 0) {
          const user = res.data[0]
          const currentUserInfo = this.data.userInfo
          
          let avatarUrl = user.avatarUrl || currentUserInfo.avatarUrl
          
          const updatedUserInfo = {
            nickName: user.nickName || currentUserInfo.nickName,
            avatarUrl: avatarUrl
          }
          
          this.setData({
            userInfo: updatedUserInfo
          })
          
          wx.setStorageSync('userInfo', updatedUserInfo)
          
          if (app && app.globalData) {
            app.globalData.userInfo = updatedUserInfo
          }
          
          if (avatarUrl && avatarUrl.startsWith('cloud://')) {
            this.getAvatarTempUrl(avatarUrl)
          }
        }
      }
    })
  },

  getAvatarTempUrl(fileID: string) {
    wx.cloud.getTempFileURL({
      fileList: [fileID],
      success: (res: any) => {
        if (res.fileList && res.fileList.length > 0) {
          const tempFileURL = res.fileList[0].tempFileURL
          const currentUserInfo = this.data.userInfo
          const updatedUserInfo = {
            ...currentUserInfo,
            avatarUrl: tempFileURL
          }
          
          this.setData({
            userInfo: updatedUserInfo
          })
          
          wx.setStorageSync('userInfo', updatedUserInfo)
          
          if (app && app.globalData) {
            app.globalData.userInfo = updatedUserInfo
          }
        }
      },
      fail: () => {
        console.error('获取头像临时链接失败')
      }
    })
  },

  goToEditProfile() {
    wx.navigateTo({
      url: '/pages/edit-profile/edit-profile'
    })
  },

  goToQuizHistory() {
    wx.navigateTo({
      url: '/pages/quiz-history/quiz-history'
    })
  },

  handleLogin() {
    wx.showLoading({ title: '登录中...' })
    
    wx.cloud.callFunction({
      name: 'login',
      success: (res: any) => {
        const openid = res.result.openid
        
        const userInfo = {
          nickName: '微信用户',
          avatarUrl: ''
        }
        
        this.registerOrUpdateUser(openid, userInfo)
      },
      fail: (err) => {
        wx.hideLoading()
        console.error('登录失败', err)
        wx.showToast({
          title: '登录失败',
          icon: 'error'
        })
      }
    })
  },

  registerOrUpdateUser(openid: string, userInfo: any) {
    const db = wx.cloud.database()
    const usersCollection = db.collection('users')
    
    usersCollection.where({
      _openid: openid
    }).get({
      success: (res: any) => {
        if (res.data.length > 0) {
          const existingUser = res.data[0]
          const userToUse = {
            nickName: existingUser.nickName || userInfo.nickName,
            avatarUrl: existingUser.avatarUrl || userInfo.avatarUrl
          }
          this.completeLogin(openid, userToUse)
        } else {
          this.createNewUser(openid, userInfo)
        }
      },
      fail: () => {
        this.createNewUser(openid, userInfo)
      }
    })
  },

  createNewUser(openid: string, userInfo: any) {
    const db = wx.cloud.database()
    
    db.collection('users').add({
      data: {
        nickName: userInfo.nickName,
        avatarUrl: userInfo.avatarUrl,
        savedPaper: 0,
        quizCount: 0,
        createTime: new Date(),
        updateTime: new Date()
      },
      success: () => {
        this.completeLogin(openid, userInfo)
      },
      fail: () => {
        wx.hideLoading()
        wx.showToast({
          title: '注册失败',
          icon: 'error'
        })
      }
    })
  },

  completeLogin(openid: string, userInfo: any) {
    wx.setStorageSync('openid', openid)
    wx.setStorageSync('userInfo', userInfo)
    
    if (app && app.globalData) {
      app.globalData.openid = openid
      app.globalData.userInfo = userInfo
    }
    
    this.setData({
      isLoggedIn: true,
      openid,
      userInfo,
      userId: openid.slice(-8)
    })
    
    wx.hideLoading()
    wx.showToast({
      title: '登录成功',
      icon: 'success'
    })
    
    this.loadUserData()
  },

  loadUserData() {
    this.loadUserStats()
    this.loadCoupons()
  },

  loadUserStats() {
    const db = wx.cloud.database()
    
    db.collection('users').where({
      _openid: this.data.openid
    }).get({
      success: (res: any) => {
        if (res.data.length > 0) {
          this.setData({
            stats: {
              savedPaper: res.data[0].savedPaper || 0,
              quizCount: res.data[0].quizCount || 0
            }
          })
        }
      },
      fail: () => {
        console.error('加载用户数据失败')
      }
    })
  },

  loadCoupons() {
    const db = wx.cloud.database()
    
    db.collection('coupons').where({
      _openid: this.data.openid
    }).orderBy('createTime', 'desc').get({
      success: (res: any) => {
        this.setData({
          coupons: res.data.map((item: any) => ({
            id: item._id,
            amount: item.amount,
            type: item.type,
            expireDate: item.expireDate,
            status: item.status
          }))
        })
        this.updateFilteredCoupons()
      },
      fail: () => {
        this.setData({
          coupons: [
            {
              id: '1',
              amount: '免费',
              type: '领纸券',
              expireDate: '2026-04-01',
              status: 'unused'
            }
          ]
        })
        this.updateFilteredCoupons()
      }
    })
  },

  updateFilteredCoupons() {
    const { filterType, coupons } = this.data
    let filtered = coupons
    
    if (filterType === 'unused') {
      filtered = coupons.filter((c: any) => c.status === 'unused')
    } else if (filterType === 'used') {
      filtered = coupons.filter((c: any) => c.status === 'used')
    } else if (filterType === 'expired') {
      filtered = coupons.filter((c: any) => c.status === 'expired')
    }
    
    this.setData({
      filteredCoupons: filtered
    })
  },

  useCoupon(e: any) {
    const couponId = e.currentTarget.dataset.id
    const status = e.currentTarget.dataset.status
    
    if (status === 'expired' || status === 'used') {
      return
    }
    
    wx.showModal({
      title: '提示',
      content: '确定要使用这张优惠券吗？',
      success: (res) => {
        if (res.confirm) {
          this.confirmUseCoupon(couponId)
        }
      }
    })
  },

  confirmUseCoupon(couponId: string) {
    wx.showLoading({ title: '使用中...' })
    
    const db = wx.cloud.database()
    
    db.collection('coupons').doc(couponId).update({
      data: {
        status: 'used',
        useTime: new Date()
      },
      success: () => {
        wx.hideLoading()
        wx.showToast({
          title: '使用成功！',
          icon: 'success'
        })
        this.loadCoupons()
      },
      fail: () => {
        wx.hideLoading()
        wx.showToast({
          title: '使用失败',
          icon: 'error'
        })
      }
    })
  },

  setFilter(e: any) {
    const type = e.currentTarget.dataset.type
    this.setData({ filterType: type })
    this.updateFilteredCoupons()
  },

  handleLogout() {
    wx.showModal({
      title: '提示',
      content: '确定要退出登录吗？',
      success: (res) => {
        if (res.confirm) {
          wx.removeStorageSync('openid')
          wx.removeStorageSync('userInfo')
          
          if (app && app.globalData) {
            app.globalData.openid = null
            app.globalData.userInfo = null
          }
          
          this.setData({
            isLoggedIn: false,
            userInfo: {},
            openid: '',
            userId: '',
            agreedToPrivacy: false
          })
        }
      }
    })
  },

  toggleAgreement() {
    this.setData({
      agreedToPrivacy: !this.data.agreedToPrivacy
    })
  },

  showUserAgreement() {
    this.setData({
      showPrivacyPopup: true,
      privacyTitle: '用户服务协议',
      privacyContent: this.data.userAgreementContent
    })
  },

  showPrivacyPolicy() {
    this.setData({
      showPrivacyPopup: true,
      privacyTitle: '隐私政策',
      privacyContent: this.data.privacyPolicyContent
    })
  },

  closePrivacyPopup() {
    this.setData({
      showPrivacyPopup: false
    })
  }
})
