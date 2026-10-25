import { api } from '../../utils/api';

Page({
  data: {
    activeTab: 'help',
    activeValues: [] as string[],
    faqList: [
      {
        id: '1',
        question: '如何扫码取纸？',
        answer: '在首页点击"扫码取纸"按钮，扫描设备上的二维码即可。首次使用需要授权登录，之后会自动识别并出纸。'
      },
      {
        id: '2',
        question: '答题可以获得什么奖励？',
        answer: '每连续答对5道题目，即可获得一张优惠券。优惠券类型包括领纸券、购物券等，可在"我的优惠券"中查看和使用。'
      },
      {
        id: '3',
        question: 'AR识别功能如何使用？',
        answer: '点击底部"AR识别"标签，将摄像头对准本草植物，系统会自动识别并展示相关信息。识别记录会保存在"AR识别记录"中。'
      },
      {
        id: '4',
        question: '优惠券如何使用？',
        answer: '在"我的"页面中点击"我的优惠券"，选择要使用的优惠券点击"立即使用"即可。部分优惠券需要在取纸时使用。'
      },
      {
        id: '5',
        question: '如何修改个人信息？',
        answer: '在"我的"页面点击头像区域，进入个人信息编辑页面，可以修改昵称和头像。'
      },
      {
        id: '6',
        question: '如何退出登录？',
        answer: '在"我的"页面右上角点击退出按钮，或在"设置"页面点击"退出登录"即可。'
      }
    ],
    feedbackTypes: [
      { label: '功能建议', value: 'suggestion' },
      { label: '问题反馈', value: 'bug' },
      { label: '使用咨询', value: 'question' },
      { label: '其他', value: 'other' }
    ],
    feedbackType: 'suggestion',
    feedbackContent: '',
    images: [] as string[],
    contactInfo: ''
  },

  onLoad(options: any) {
    if (options.type === 'privacy') {
      this.setData({ activeTab: 'help' })
    } else if (options.type === 'feedback') {
      this.setData({ activeTab: 'feedback' })
    }
  },

  switchTab(e: any) {
    this.setData({
      activeTab: e.currentTarget.dataset.tab
    })
  },

  onCollapseChange(e: any) {
    this.setData({
      activeValues: e.detail.value
    })
  },

  selectFeedbackType(e: any) {
    this.setData({
      feedbackType: e.currentTarget.dataset.value
    })
  },

  onContentChange(e: any) {
    this.setData({
      feedbackContent: e.detail.value
    })
  },

  onContactInput(e: any) {
    this.setData({
      contactInfo: e.detail.value
    })
  },

  chooseImage() {
    const remainCount = 3 - this.data.images.length
    wx.chooseMedia({
      count: remainCount,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const newImages = res.tempFiles.map((file: any) => file.tempFilePath)
        this.setData({
          images: [...this.data.images, ...newImages]
        })
      }
    })
  },

  deleteImage(e: any) {
    const index = e.currentTarget.dataset.index
    const images = this.data.images.filter((_: any, i: number) => i !== index)
    this.setData({ images })
  },

  async submitFeedback() {
    if (!this.data.feedbackContent.trim()) {
      wx.showToast({
        title: '请输入问题描述',
        icon: 'none'
      })
      return
    }

    wx.showLoading({ title: '提交中...' })

    try {
      let uploadedUrls: string[] = []

      // 图片先传云存储（客户端上传是标准做法），拿到 fileID
      if (this.data.images.length > 0) {
        const uploadPromises = this.data.images.map((filePath, index) => {
          return new Promise((resolve, reject) => {
            const rand = Math.random().toString(36).slice(2, 8)
            const cloudPath = `feedback/${Date.now()}_${index}_${rand}.jpg`
            wx.cloud.uploadFile({
              cloudPath,
              filePath,
              success: (res) => resolve(res.fileID),
              fail: reject
            })
          })
        })

        uploadedUrls = await Promise.all(uploadPromises) as string[]
      }

      /**
       * 修复：原实现用 wx.cloud.database() 直写 feedback 集合，
       * 绕过了云函数 —— 记录没有 _openid，管理端无法识别提交者，
       * 且无长度校验。现统一走 feedbackService.submit，
       * 由云函数以 getWXContext().OPENID 写入归属与校验。
       */
      await api.post('/api/feedback/submit', {
        type: this.data.feedbackType,
        content: this.data.feedbackContent,
        images: uploadedUrls,
        contact: this.data.contactInfo,
      })

      wx.hideLoading()
      wx.showToast({
        title: '提交成功',
        icon: 'success'
      })

      this.setData({
        feedbackContent: '',
        images: [],
        contactInfo: ''
      })
    } catch (err) {
      wx.hideLoading()
      wx.showToast({
        title: '提交失败',
        icon: 'error'
      })
      console.error('提交反馈失败', err)
    }
  }
})
