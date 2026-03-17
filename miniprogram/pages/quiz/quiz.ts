interface Question {
  id: number
  question: string
  options: string[]
  correct: number
  explanation: string
}

Page({
  data: {
    currentIndex: 0,
    questions: [] as Question[],
    selectedIndex: -1,
    answered: false,
    isCorrect: false,
    correctCount: 0,
    totalQuestions: 5,
    showResult: false,
    couponVisible: false,
    loading: false,
    startTime: 0,
    quizStarted: false,
    showStartDialog: true,
    currentQuestion: null as Question | null,
    questionNumber: '第一题'
  },

  onLoad() {
    this.initQuestions()
  },

  initQuestions() {
    this.setData({ loading: true })
    
    this.loadLocalQuestions()
    
    wx.cloud.callFunction({
      name: 'getRandomQuestions',
      data: {
        count: 5
      },
      success: (res: any) => {
        if (res.result.success && res.result.data.length > 0) {
          this.setData({
            questions: res.result.data,
            totalQuestions: res.result.data.length
          })
          this.updateCurrentQuestion()
        }
      },
      fail: (err: any) => {
        console.log('云函数调用失败，使用本地题目', err)
      }
    })
  },

  loadLocalQuestions() {
    const allQuestions = this.getQuestionBank()
    const shuffled = this.shuffleArray([...allQuestions])
    const selectedQuestions = shuffled.slice(0, Math.min(5, shuffled.length))
    
    this.setData({
      questions: selectedQuestions,
      totalQuestions: selectedQuestions.length,
      loading: false
    })
    this.updateCurrentQuestion()
  },

  shuffleArray<T>(array: T[]): T[] {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]]
    }
    return array
  },

  updateCurrentQuestion() {
    const numbers = ['第一题', '第二题', '第三题', '第四题', '第五题']
    const currentIndex = this.data.currentIndex
    const currentQuestion = this.data.questions[currentIndex] || null
    const questionNumber = numbers[currentIndex] || '答题完成'
    
    this.setData({
      currentQuestion,
      questionNumber
    })
  },

  getQuestionBank(): Question[] {
    return [
      {
        id: 1,
        question: '四季养生的原则包括?',
        options: [
          '春夏养阳',
          '秋冬消暑',
          '春夏养阴',
          '秋冬养阳'
        ],
        correct: 0,
        explanation: '中医四季养生原则为"春夏养阳，秋冬养阴"'
      },
      {
        id: 2,
        question: '以下哪种药材有"国老"之称？',
        options: ['人参', '甘草', '枸杞', '黄芪'],
        correct: 1,
        explanation: '甘草能调和诸药，有"国老"之称'
      },
      {
        id: 3,
        question: '中医理论中，"五脏"不包括？',
        options: ['心', '肝', '胃', '肾'],
        correct: 2,
        explanation: '中医五脏为：心、肝、脾、肺、肾'
      },
      {
        id: 4,
        question: '以下哪种食物性温？',
        options: ['西瓜', '生姜', '梨', '绿豆'],
        correct: 1,
        explanation: '生姜性温，具有温中散寒的作用'
      },
      {
        id: 5,
        question: '《本草纲目》的作者是？',
        options: ['张仲景', '李时珍', '华佗', '孙思邈'],
        correct: 1,
        explanation: '《本草纲目》由明代医学家李时珍所著'
      }
    ]
  },

  startQuiz() {
    console.log('startQuiz 被调用')
    this.setData({
      quizStarted: true,
      showStartDialog: false,
      startTime: Date.now(),
      answered: false,
      selectedIndex: -1
    })
    console.log('startQuiz 完成，当前数据:', this.data)
  },

  addQuestion(question: Omit<Question, 'id'>): Question[] {
    const currentBank = this.getQuestionBank()
    const newQuestion: Question = {
      id: currentBank.length + 1,
      ...question
    }
    currentBank.push(newQuestion)
    console.log('更新后的题库:', currentBank)
    return currentBank
  },

  goBack() {
    wx.navigateBack()
  },

  selectOption(e: any) {
    console.log('selectOption 被调用', e)
    
    if (this.data.answered) {
      console.log('已答题，直接返回')
      return
    }
    
    const index = e.currentTarget.dataset.index
    console.log('选中的索引:', index)
    
    const currentQuestion = this.data.currentQuestion
    if (!currentQuestion) {
      console.log('currentQuestion 为空')
      return
    }
    
    console.log('当前题目:', currentQuestion)
    
    const isCorrect = index === currentQuestion.correct
    let correctCount = this.data.correctCount
    const answerTime = Date.now() - this.data.startTime
    
    if (isCorrect) {
      correctCount++
    }
    
    console.log('是否正确:', isCorrect, '正确数:', correctCount)
    
    this.setData({
      selectedIndex: index,
      answered: true,
      isCorrect,
      correctCount
    })
    
    this.submitQuizRecord(isCorrect, answerTime, currentQuestion.id)
    
    if (isCorrect) {
      wx.vibrateShort({ type: 'heavy' })
      
      if (correctCount % 5 === 0) {
        this.grantCoupon()
        setTimeout(() => {
          this.setData({ couponVisible: true })
        }, 500)
      }
    } else {
      wx.vibrateShort({ type: 'medium' })
    }
  },

  submitQuizRecord(isCorrect: boolean, answerTime: number, questionId: number | null = null) {
    try {
      const currentQuestion = this.data.currentQuestion
      const db = wx.cloud.database()
      
      db.collection('quiz_records').add({
        data: {
          questionId: questionId || null,
          questionIndex: this.data.currentIndex,
          question: currentQuestion?.question || '',
          options: currentQuestion?.options || [],
          userOptionIndex: this.data.selectedIndex,
          correctOptionIndex: currentQuestion?.correct,
          isCorrect,
          answerTime,
          explanation: currentQuestion?.explanation || '',
          createTime: new Date()
        },
        success: (res: any) => {
          console.log('答题记录已保存', res)
        },
        fail: (err: any) => {
          console.log('答题记录保存失败（不影响答题）', err)
        }
      })
    } catch (err) {
      console.log('保存答题记录异常', err)
    }
  },

  nextQuestion() {
    if (this.data.currentIndex < this.data.questions.length - 1) {
      this.setData({
        currentIndex: this.data.currentIndex + 1,
        selectedIndex: -1,
        answered: false,
        isCorrect: false
      })
      this.updateCurrentQuestion()
    }
  },

  showResultPage() {
    this.setData({ showResult: true })
    setTimeout(() => {
      wx.showToast({
        title: '答题完成！',
        icon: 'success'
      })
    }, 500)
  },

  closeCoupon() {
    this.setData({ couponVisible: false })
  },

  restartQuiz() {
    const allQuestions = this.getQuestionBank()
    const shuffled = this.shuffleArray([...allQuestions])
    const selectedQuestions = shuffled.slice(0, Math.min(5, shuffled.length))
    
    this.setData({
      currentIndex: 0,
      selectedIndex: -1,
      answered: false,
      isCorrect: false,
      correctCount: 0,
      showResult: false,
      couponVisible: false,
      quizStarted: false,
      showStartDialog: true,
      questions: selectedQuestions,
      totalQuestions: selectedQuestions.length
    })
    this.updateCurrentQuestion()
  },

  grantCoupon() {
    const db = wx.cloud.database()
    const openid = wx.getStorageSync('openid')
    
    if (!openid) {
      return
    }
    
    const couponTypes = [
      { amount: '免费', type: '领纸券', expireDays: 30 },
      { amount: '买2送1', type: '优惠券', expireDays: 15 },
      { amount: '8折', type: '购物券', expireDays: 7 }
    ]
    
    const randomCoupon = couponTypes[Math.floor(Math.random() * couponTypes.length)]
    const expireDate = new Date()
    expireDate.setDate(expireDate.getDate() + randomCoupon.expireDays)
    const formattedExpireDate = `${expireDate.getFullYear()}-${String(expireDate.getMonth() + 1).padStart(2, '0')}-${String(expireDate.getDate()).padStart(2, '0')}`
    
    db.collection('coupons').add({
      data: {
        amount: randomCoupon.amount,
        type: randomCoupon.type,
        expireDate: formattedExpireDate,
        status: 'unused',
        createTime: new Date()
      },
      success: (res: any) => {
        console.log('优惠券已发放', res)
      },
      fail: (err: any) => {
        console.log('优惠券发放失败', err)
      }
    })
  }
})
