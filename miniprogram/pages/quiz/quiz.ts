Page({
  data: {
    currentIndex: 0,
    questions: [
      {
        question: '图中的药材是什么？',
        desc: '这是一种珍贵的中药材，具有大补元气的功效。',
        image: 'https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image?prompt=ginseng%20root%20herbal%20medicine%20illustration&image_size=square',
        options: ['人参', '党参', '黄芪', '当归'],
        correct: 0
      },
      {
        question: '以下哪种药材有"国老"之称？',
        desc: '它能调和诸药，是最常用的中药材之一。',
        image: 'https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image?prompt=licorice%20root%20glycyrrhiza%20uralensis%20herbal%20medicine&image_size=square',
        options: ['人参', '甘草', '枸杞', '黄芪'],
        correct: 1
      }
    ],
    selectedIndex: -1,
    answered: false,
    isCorrect: false,
    couponVisible: false,
    startTime: 0
  },

  onLoad() {
    this.setData({ startTime: Date.now() })
  },

  get currentQuestion() {
    return this.data.questions[this.data.currentIndex]
  },

  goBack() {
    wx.navigateBack()
  },

  selectOption(e: any) {
    if (this.data.answered) return
    
    const index = e.currentTarget.dataset.index
    const isCorrect = index === this.currentQuestion.correct
    
    this.setData({
      selectedIndex: index,
      answered: true,
      isCorrect
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
      }, 1500)
    }
    
    this.submitResult(isCorrect)
  },

  handleTimeUp() {
    if (this.data.answered) return
    
    this.setData({
      answered: true,
      selectedIndex: -1,
      isCorrect: false
    })
    
    setTimeout(() => {
      this.nextQuestion()
    }, 1500)
    
    this.submitResult(false)
  },

  submitResult(isCorrect: boolean) {
    const duration = Date.now() - this.data.startTime
    
    wx.request({
      url: '/api/quiz/submit',
      method: 'POST',
      data: {
        questionIndex: this.data.currentIndex,
        isCorrect,
        duration
      }
    })
  },

  nextQuestion() {
    if (this.data.currentIndex < this.data.questions.length - 1) {
      this.setData({
        currentIndex: this.data.currentIndex + 1,
        selectedIndex: -1,
        answered: false,
        isCorrect: false,
        startTime: Date.now()
      })
    } else {
      wx.showToast({
        title: '答题完成！',
        icon: 'success'
      })
      setTimeout(() => {
        wx.switchTab({
          url: '/pages/home/home'
        })
      }, 1500)
    }
  },

  closeCoupon() {
    this.setData({ couponVisible: false })
    this.nextQuestion()
  }
})
