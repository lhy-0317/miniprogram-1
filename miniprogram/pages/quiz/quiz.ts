Page({
  data: {
    currentIndex: 0,
    questions: [],
    selectedIndex: -1,
    answered: false,
    isCorrect: false,
    correctCount: 0,
    totalQuestions: 5,
    showResult: false,
    couponVisible: false
  },

  onLoad() {
    this.initQuestions()
  },

  initQuestions() {
    const questions = this.getQuestionBank()
    this.setData({
      questions: questions.slice(0, 5),
      totalQuestions: 5
    })
  },

  getQuestionBank() {
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
      }
    ]
  },

  addQuestion(question: any) {
    const currentBank = this.getQuestionBank()
    currentBank.push({
      id: currentBank.length + 1,
      ...question
    })
    console.log('更新后的题库:', currentBank)
    return currentBank
  },

  get currentQuestion() {
    return this.data.questions[this.data.currentIndex]
  },

  get questionNumber() {
    const numbers = ['第一题', '第二题', '第三题', '第四题', '第五题']
    return numbers[this.data.currentIndex] || '答题完成'
  },

  goBack() {
    wx.navigateBack()
  },

  selectOption(e: any) {
    if (this.data.answered) return
    
    const index = e.currentTarget.dataset.index
    const isCorrect = index === this.currentQuestion.correct
    let correctCount = this.data.correctCount
    
    if (isCorrect) {
      correctCount++
    }
    
    this.setData({
      selectedIndex: index,
      answered: true,
      isCorrect,
      correctCount
    })
    
    if (isCorrect) {
      wx.vibrateShort({ type: 'heavy' })
      setTimeout(() => {
        this.setData({ couponVisible: true })
      }, 500)
    } else {
      wx.vibrateShort({ type: 'medium' })
      setTimeout(() => {
        this.nextQuestion()
      }, 2000)
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
    } else {
      this.setData({ showResult: true })
      setTimeout(() => {
        wx.showToast({
          title: '答题完成！',
          icon: 'success'
        })
      }, 500)
    }
  },

  closeCoupon() {
    this.setData({ couponVisible: false })
    this.nextQuestion()
  },

  restartQuiz() {
    this.setData({
      currentIndex: 0,
      selectedIndex: -1,
      answered: false,
      isCorrect: false,
      correctCount: 0,
      showResult: false,
      couponVisible: false
    })
  }
})
