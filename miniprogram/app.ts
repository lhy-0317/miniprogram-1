// app.ts
App<IAppOption>({
  globalData: {
    userInfo: null,
    openid: null,
    deviceId: null
  },
  onLaunch() {
    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上的基础库以使用云能力')
    } else {
      wx.cloud.init({
        env: 'cloud1-6gqgdhv6f2059125',
        traceUser: true
      })
    }
  }
})