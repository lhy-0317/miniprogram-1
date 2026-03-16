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
    filteredCoupons: []
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
          this.updateUserInfo(openid, userInfo, res.data[0]._id)
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

  updateUserInfo(openid: string, userInfo: any, docId: string) {
    const db = wx.cloud.database()
    
    db.collection('users').doc(docId).update({
      data: {
        nickName: userInfo.nickName,
        avatarUrl: userInfo.avatarUrl,
        updateTime: new Date()
      },
      success: () => {
        this.completeLogin(openid, userInfo)
      },
      fail: () => {
        this.completeLogin(openid, userInfo)
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
    } else if (filterType === 'expired') {
      filtered = coupons.filter((c: any) => c.status === 'expired')
    }
    
    this.setData({
      filteredCoupons: filtered
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
            userId: ''
          })
        }
      }
    })
  }
})
