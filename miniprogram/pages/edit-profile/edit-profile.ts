const app = getApp<IAppOption>()

Page({
  data: {
    avatarUrl: '',
    avatarFileId: '',
    nickName: '',
    originalNickName: '',
    originalAvatarUrl: '',
    originalAvatarFileId: '',
    savePopupVisible: false,
    openid: '',
    userDocId: ''
  },

  onLoad() {
    this.loadUserInfo()
  },

  loadUserInfo() {
    const openid = wx.getStorageSync('openid')
    const userInfo = wx.getStorageSync('userInfo')
    
    if (openid) {
      this.setData({ openid })
    }
    
    if (userInfo) {
      this.setData({
        nickName: userInfo.nickName || '微信用户',
        originalNickName: userInfo.nickName || '微信用户',
        avatarUrl: userInfo.avatarUrl || '',
        originalAvatarUrl: userInfo.avatarUrl || ''
      })
    }
    
    this.loadUserFromDatabase()
  },

  loadUserFromDatabase() {
    const db = wx.cloud.database()
    
    db.collection('users').where({
      _openid: this.data.openid
    }).get({
      success: (res: any) => {
        if (res.data.length > 0) {
          const user = res.data[0]
          this.setData({
            userDocId: user._id,
            nickName: user.nickName || this.data.nickName,
            originalNickName: user.nickName || this.data.nickName,
            avatarUrl: user.avatarUrl || this.data.avatarUrl,
            originalAvatarUrl: user.avatarUrl || this.data.avatarUrl,
            avatarFileId: user.avatarUrl || '',
            originalAvatarFileId: user.avatarUrl || ''
          })
          
          if (user.avatarUrl && user.avatarUrl.startsWith('cloud://')) {
            this.getTempFileURL(user.avatarUrl)
          }
        }
      },
      fail: () => {
        console.error('加载用户信息失败')
      }
    })
  },

  chooseAvatar() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res: any) => {
        const tempFilePath = res.tempFiles[0].tempFilePath
        this.uploadAvatar(tempFilePath)
      }
    })
  },

  uploadAvatar(filePath: string) {
    wx.showLoading({ title: '上传中...' })
    
    const cloudPath = `avatars/${this.data.openid}_${Date.now()}.jpg`
    
    wx.cloud.uploadFile({
      cloudPath,
      filePath,
      success: (res: any) => {
        const fileID = res.fileID
        this.setData({
          avatarFileId: fileID
        })
        this.getTempFileURL(fileID)
      },
      fail: () => {
        wx.hideLoading()
        wx.showToast({
          title: '上传失败',
          icon: 'error'
        })
      }
    })
  },

  getTempFileURL(fileID: string) {
    wx.cloud.getTempFileURL({
      fileList: [fileID],
      success: (res: any) => {
        const tempFileURL = res.fileList[0].tempFileURL
        this.setData({
          avatarUrl: tempFileURL
        })
        wx.hideLoading()
      },
      fail: () => {
        wx.hideLoading()
        this.setData({
          avatarUrl: fileID
        })
      }
    })
  },

  onNickNameChange(e: any) {
    this.setData({
      nickName: e.detail.value
    })
  },

  handleSave() {
    if (!this.data.nickName.trim()) {
      wx.showToast({
        title: '昵称不能为空',
        icon: 'none'
      })
      return
    }
    
    const hasChanged = 
      this.data.nickName !== this.data.originalNickName || 
      this.data.avatarUrl !== this.data.originalAvatarUrl
    
    if (!hasChanged) {
      wx.showToast({
        title: '没有修改',
        icon: 'none'
      })
      return
    }
    
    this.saveToDatabase()
  },

  saveToDatabase() {
    wx.showLoading({ title: '保存中...' })
    
    const db = wx.cloud.database()
    
    const avatarToSave = this.data.avatarFileId || this.data.avatarUrl
    
    const updateData = {
      nickName: this.data.nickName,
      avatarUrl: avatarToSave,
      updateTime: new Date()
    }
    
    if (this.data.userDocId) {
      db.collection('users').doc(this.data.userDocId).update({
        data: updateData,
        success: () => {
          this.onSaveSuccess(avatarToSave)
        },
        fail: () => {
          wx.hideLoading()
          wx.showToast({
            title: '保存失败',
            icon: 'error'
          })
        }
      })
    } else {
      db.collection('users').add({
        data: {
          ...updateData,
          savedPaper: 0,
          quizCount: 0,
          createTime: new Date()
        },
        success: (res: any) => {
          this.setData({
            userDocId: res._id
          })
          this.onSaveSuccess(avatarToSave)
        },
        fail: () => {
          wx.hideLoading()
          wx.showToast({
            title: '保存失败',
            icon: 'error'
          })
        }
      })
    }
  },

  onSaveSuccess(avatarToSave: string) {
    const userInfo = {
      nickName: this.data.nickName,
      avatarUrl: avatarToSave
    }
    
    wx.setStorageSync('userInfo', userInfo)
    
    if (app && app.globalData) {
      app.globalData.userInfo = userInfo
    }
    
    this.setData({
      originalNickName: this.data.nickName,
      originalAvatarUrl: this.data.avatarUrl,
      originalAvatarFileId: avatarToSave,
      savePopupVisible: true
    })
    
    wx.hideLoading()
    
    setTimeout(() => {
      this.setData({
        savePopupVisible: false
      })
      wx.navigateBack()
    }, 1500)
  },

  goBack() {
    const hasChanged = 
      this.data.nickName !== this.data.originalNickName || 
      this.data.avatarUrl !== this.data.originalAvatarUrl
    
    if (hasChanged) {
      wx.showModal({
        title: '提示',
        content: '您有未保存的修改，确定要离开吗？',
        success: (res) => {
          if (res.confirm) {
            wx.navigateBack()
          }
        }
      })
    } else {
      wx.navigateBack()
    }
  }
})
