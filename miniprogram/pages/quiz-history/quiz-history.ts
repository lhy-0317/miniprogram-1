interface QuizRecord {
  id: string
  date: string
  question: string
  userAnswer: string
  correctAnswer: string
  isCorrect: boolean
  explanation: string
}

Page({
  data: {
    historyList: [] as QuizRecord[]
  },

  onLoad() {
    this.loadQuizHistory()
  },

  loadQuizHistory() {
    wx.showLoading({ title: '加载中...' })
    
    const db = wx.cloud.database()
    const openid = wx.getStorageSync('openid')
    
    if (!openid) {
      wx.hideLoading()
      return
    }
    
    db.collection('quiz_records')
      .where({
        _openid: openid
      })
      .orderBy('createTime', 'desc')
      .get({
        success: (res: any) => {
          const historyList = res.data.map((item: any) => this.formatRecord(item))
          this.setData({ historyList })
          wx.hideLoading()
        },
        fail: () => {
          wx.hideLoading()
          wx.showToast({
            title: '加载失败',
            icon: 'error'
          })
        }
      })
  },

  formatRecord(record: any): QuizRecord {
    const date = new Date(record.createTime)
    const formattedDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
    
    const options = ['A', 'B', 'C', 'D']
    const userAnswer = record.userOptionIndex !== undefined ? options[record.userOptionIndex] : '未作答'
    const correctAnswer = record.correctOptionIndex !== undefined ? options[record.correctOptionIndex] : ''
    
    return {
      id: record._id,
      date: formattedDate,
      question: record.question || '未知题目',
      userAnswer,
      correctAnswer,
      isCorrect: record.isCorrect || false,
      explanation: record.explanation || ''
    }
  }
})
