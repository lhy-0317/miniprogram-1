Page({
  data: {
    filterType: 'all',
    stats: {
      savedPaper: 128,
      quizCount: 56
    },
    coupons: [
      {
        id: 1,
        amount: '免费',
        type: '领纸券',
        expireDate: '2026-04-01',
        status: 'unused'
      },
      {
        id: 2,
        amount: '买2',
        type: '送1',
        expireDate: '2026-03-15',
        status: 'unused'
      },
      {
        id: 3,
        amount: '5折',
        type: '折扣券',
        expireDate: '2026-02-28',
        status: 'expired'
      }
    ]
  },

  get filteredCoupons() {
    const { filterType, coupons } = this.data
    if (filterType === 'all') return coupons
    return coupons.filter(c => c.status === filterType)
  },

  onLoad() {
    this.loadUserStats()
    this.loadCoupons()
  },

  onShow() {
    this.setData({
      filteredCoupons: this.filteredCoupons
    })
  },

  loadUserStats() {
    wx.request({
      url: '/api/user/stats',
      method: 'GET',
      success: (res: any) => {
        if (res.data) {
          this.setData({
            stats: res.data
          })
        }
      }
    })
  },

  loadCoupons() {
  },

  setFilter(e: any) {
    const type = e.currentTarget.dataset.type
    this.setData({ filterType: type })
    this.setData({
      filteredCoupons: this.filteredCoupons
    })
  }
})
