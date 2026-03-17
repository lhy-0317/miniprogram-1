Page({
  data: {
    records: [] as any[],
    totalRecords: 0,
    uniqueHerbs: 0,
    loading: true
  },

  onLoad() {
    this.loadRecords()
  },

  onShow() {
    this.loadRecords()
  },

  loadRecords() {
    this.setData({ loading: true })

    const db = wx.cloud.database()
    const openid = wx.getStorageSync('openid')

    if (!openid) {
      this.setData({ loading: false })
      return
    }

    db.collection('ar_records').where({
      _openid: openid
    }).orderBy('createTime', 'desc').limit(50).get({
      success: (res: any) => {
        const records = res.data.map((item: any) => ({
          ...item,
          createTimeStr: this.formatTime(item.createTime)
        }))

        const uniqueHerbsSet = new Set()
        records.forEach((item: any) => {
          if (item.herbName) {
            uniqueHerbsSet.add(item.herbName)
          }
        })

        this.setData({
          records,
          totalRecords: records.length,
          uniqueHerbs: uniqueHerbsSet.size,
          loading: false
        })
      },
      fail: () => {
        this.setData({
          records: [],
          loading: false
        })
      }
    })
  },

  formatTime(date: Date | string): string {
    if (!date) return ''
    const d = new Date(date)
    const year = d.getFullYear()
    const month = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    const hour = String(d.getHours()).padStart(2, '0')
    const minute = String(d.getMinutes()).padStart(2, '0')
    return `${year}-${month}-${day} ${hour}:${minute}`
  },

  goToAr() {
    wx.switchTab({
      url: '/pages/ar/ar'
    })
  }
})
