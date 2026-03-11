Page({
  data: {
    recognized: false,
    herbInfo: {
      name: '人参',
      latin: 'Panax ginseng',
      desc: '大补元气，复脉固脱，补脾益肺，生津，安神。用于体虚欲脱，肢冷脉微，脾虚食少，肺虚喘咳，津伤口渴，内热消渴，久病虚羸，惊悸失眠，阳痿宫冷。',
      property: '甘、微苦',
      meridian: '脾、肺、心经'
    }
  },

  onLoad() {
    this.requestCameraPermission()
  },

  requestCameraPermission() {
    wx.getSetting({
      success: (res) => {
        if (!res.authSetting['scope.camera']) {
          wx.authorize({
            scope: 'scope.camera',
            success: () => {
              console.log('相机权限已获取')
            },
            fail: () => {
              wx.showModal({
                title: '提示',
                content: '需要相机权限进行AR识别',
                showCancel: false
              })
            }
          })
        }
      }
    })
  },

  goBack() {
    wx.navigateBack()
  },

  handleRecognize() {
    wx.showLoading({ title: '识别中...' })
    
    setTimeout(() => {
      wx.hideLoading()
      this.setData({ recognized: true })
      wx.vibrateShort({ type: 'heavy' })
    }, 1500)
  }
})
