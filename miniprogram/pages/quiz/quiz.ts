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
    startTime: 0
  },

  onLoad() {
    this.initQuestions()
  },

  initQuestions() {
    this.setData({ loading: true })
    
    wx.cloud.callFunction({
      name: 'getRandomQuestions',
      data: {
        count: 5
      },
      success: (res: any) => {
        if (res.result.success && res.result.data.length > 0) {
          this.setData({
            questions: res.result.data,
            totalQuestions: res.result.data.length,
            loading: false,
            startTime: Date.now()
          })
        } else {
          this.loadLocalQuestions()
        }
      },
      fail: () => {
        this.loadLocalQuestions()
      }
    })
  },

  loadLocalQuestions() {
    const questions = this.getQuestionBank()
    this.setData({
      questions: questions.slice(0, 5),
      totalQuestions: Math.min(questions.length, 5),
      loading: false,
      startTime: Date.now()
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
      }
    ]
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
    const answerTime = Date.now() - this.data.startTime
    
    if (isCorrect) {
      correctCount++
    }
    
    this.setData({
      selectedIndex: index,
      answered: true,
      isCorrect,
      correctCount
    })
    
    this.submitQuizRecord(isCorrect, answerTime)
    
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

  submitQuizRecord(isCorrect: boolean, answerTime: number) {
    wx.cloud.callFunction({
      name: 'submitQuizRecord',
      data: {
        questionId: this.currentQuestion?.id || null,
        questionIndex: this.data.currentIndex,
        isCorrect,
        answerTime
      },
      success: (res: any) => {
        console.log('答题记录已提交', res.result)
      },
      fail: (err: any) => {
        console.error('答题记录提交失败', err)
      }
    })
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
