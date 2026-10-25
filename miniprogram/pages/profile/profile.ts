const app = getApp<IAppOption>();
import { api } from '../../utils/api';

Page({
  data: {
    isLoggedIn: false,
    userInfo: {} as any,
    userId: '',
    openid: '',
    filterType: 'all',
    stats: {
      savedPaper: 0,
      quizCount: 0,
      totalQuizRecords: 0,
      unusedCoupons: 0,
    },
    coupons: [] as any[],
    filteredCoupons: [] as any[],
    // 登录卡中独立选择的微信头像（临时路径）与昵称，登录时一并保存
    wxProfileAvatar: '',
    wxProfileNickname: '',
    agreedToPrivacy: false,
    showPrivacyPopup: false,
    privacyTitle: '',
    privacyContent: '',
    userAgreementContent: `用户服务协议

欢迎使用智惠本草小程序！

一、服务说明
本小程序为用户提供扫码取纸、趣味答题、AR本草识别等服务。

二、用户信息
为了提供更好的服务，我们会收集必要的用户信息，包括但不限于：
1. 微信昵称和头像（可选）
2. 答题记录和订单记录
3. 优惠券领取和订单记录

三、用户责任
用户在使用本小程序时，应当遵守相关法律法规，不得从事违法活动。

四、免责声明
我们会尽力保护用户信息安全，但不对因不可抗力导致的信息泄露承担责任。

五、协议修改
我们有权根据需要修改本协议，修改后的协议一经公布即生效。`,
    privacyPolicyContent: `隐私政策

智惠本草非常重视用户的隐私保护。

一、信息收集
我们收集以下信息以提供服务：
1. 用户基本信息：微信昵称、头像（用户自愿提供）
2. 使用信息：答题记录、取纸记录、AR识别记录
3. 设备信息：为了优化服务体验，我们会收集设备相关信息

二、信息使用
我们将收集的信息用于：
1. 提供和优化小程序服务
2. 发放和管理优惠券
3. 统计用户数据以改进产品

三、信息保护
我们采取严格的安全措施保护用户信息：
1. 使用加密技术传输数据
2. 限制信息访问权限
3. 定期进行安全检查

四、信息共享
除以下情况外，我们不会向第三方共享用户信息：
1. 获得用户明确同意
2. 法律法规要求
3. 为完成服务所必需（如支付服务）

五、用户权利
用户有权：
1. 访问和修改自己的个人信息
2. 注销账户
3. 撤回同意

六、未成年人保护
我们非常重视未成年人的隐私保护，建议未成年人在监护人指导下使用本服务。

七、政策更新
我们可能会适时更新本隐私政策，更新后的政策将在小程序内公布。

如有疑问，请通过小程序内的反馈渠道联系我们。`,
  },

  onLoad() {
    this.checkLoginStatus();
  },

  onShow() {
    if (this.data.isLoggedIn) {
      this.loadData();
    }
  },

  /**
 * 检查登录状态。
 *
 * 修复：原先无本地资料时会静默调用 handleLogin 直接建档登录，
 * 用户没有任何确认动作。现改为停留在登录卡（含用户协议/隐私政策
 * 勾选），用户主动点击「微信一键登录」并勾选协议后才执行登录。
 */
checkLoginStatus() {
    const userInfo = wx.getStorageSync('userInfo');

    if (userInfo && userInfo.nickName) {
      this.setData({
        isLoggedIn: true,
        userInfo,
      });
      this.loadData();
    } else {
      // 未确认授权：停留在登录卡，等待用户主动点击登录按钮
      this.setData({ isLoggedIn: false });
    }
  },

  async loadData() {
    try {
      const [profileRes, statsRes, couponsRes] = await Promise.all([
        api.get('/api/user/profile', undefined, { silent: true }),
        api.get('/api/user/stats'),
        api.get('/api/coupons'),
      ]);

      // 修复：原实现只刷 stats/coupons，编辑资料页返回后头像昵称仍是旧值。
      // 以服务端为准同步 userInfo（数据库是唯一事实源），页面立即反映最新资料。
      if (profileRes.success && profileRes.data) {
        const userInfo = {
          nickName: profileRes.data.nickName,
          avatarUrl: profileRes.data.avatarUrl,
        };
        wx.setStorageSync('userInfo', userInfo);
        if (app && app.globalData) {
          app.globalData.userInfo = userInfo;
        }
        this.setData({
          userInfo,
          userId: profileRes.data.id ? String(profileRes.data.id).slice(-8) : this.data.userId,
        });
      }

      if (statsRes.success) {
        this.setData({ stats: statsRes.data });
      }

      if (couponsRes.success) {
        this.setData({ coupons: couponsRes.data.coupons });
        this.updateFilteredCoupons();
      }
    } catch {
      // Silently fail on load
    }
  },

  /**
 * 加载用户资料与券包。
 *
 * 云开发架构下无需显式登录：云函数 getWXContext().OPENID 即身份，
 * 因此这里直接拉取资料即可，不存在 401 与「登录已过期」提示。
 */
  async handleLogin() {
    wx.showLoading({ title: '加载中...' });

    try {
      const res = await api.get('/api/user/profile');

      if (res.success) {
        const id = res.data.id;
        let { nickName, avatarUrl } = res.data;

        // 登录卡中独立选择的头像/昵称：头像先上传云存储换 fileID，再随登录一并保存。
        // 两项均为空（用户未选择）时不动原有资料。
        try {
          const patch: any = {};
          if (this.data.wxProfileNickname) patch.nickName = this.data.wxProfileNickname;
          if (this.data.wxProfileAvatar) {
            const fileId = await this.uploadWxAvatar(this.data.wxProfileAvatar);
            if (fileId) patch.avatarUrl = fileId;
          }

          if (patch.nickName || patch.avatarUrl) {
            const saved = await api.put('/api/user/profile', patch);
            if (saved.success) {
              nickName = saved.data.nickName || nickName;
              avatarUrl = saved.data.avatarUrl || avatarUrl;
              this.setData({ wxProfileAvatar: '', wxProfileNickname: '' });
            }
          }
        } catch {
          // 资料保存失败不阻塞登录，保持服务端原资料
        }

        const userInfo = { nickName, avatarUrl };

        wx.setStorageSync('userInfo', userInfo);

        if (app && app.globalData) {
          app.globalData.userInfo = userInfo;
        }

        this.setData({
          isLoggedIn: true,
          userInfo,
          userId: id ? String(id).slice(-8) : '',
        });

        wx.hideLoading();
        this.loadData();
      }
    } catch {
      wx.hideLoading();
      wx.showToast({ title: '加载失败，请重试', icon: 'none' });
    }
  },

  goToEditProfile() {
    wx.navigateTo({ url: '/pages/edit-profile/edit-profile' });
  },

  /**
   * 头像选择（官方 open-type=chooseAvatar 回调）。
   *
   * e.detail.avatarUrl 是本地临时路径，可直接用于页面展示，
   * 但不能直接入库——登录时先上传到云存储换取 fileID 再保存。
   */
  onChooseWxAvatar(e: any) {
    const { avatarUrl } = e.detail || {};
    if (avatarUrl) {
      this.setData({ wxProfileAvatar: avatarUrl });
    }
  },

  /**
   * 昵称输入失焦（官方 type=nickname）。
   *
   * 聚焦时键盘上方会展示微信昵称，用户点选即填入。
   * 基础库 2.24.4 起微信会对内容做安全检测，未通过会清空输入，
   * 因此以 blur 时的值为准，不做本地缓存覆盖。
   */
  onWxNicknameBlur(e: any) {
    const value = (e.detail && e.detail.value) || '';
    this.setData({ wxProfileNickname: value.trim() });
  },

  /** 将头像临时路径上传云存储，返回 fileID（失败返回空串） */
  uploadWxAvatar(tempPath: string): Promise<string> {
    return new Promise((resolve) => {
      const ext = (tempPath.split('.').pop() || 'png').split('?')[0];
      const rand = Math.random().toString(36).slice(2, 10);
      const cloudPath = `avatars/${Date.now()}_${rand}.${ext}`;

      wx.cloud.uploadFile({
        cloudPath,
        filePath: tempPath,
        success: (res: any) => resolve(res.fileID || ''),
        fail: () => resolve(''),
      });
    });
  },

  goToQuizHistory() {
    wx.navigateTo({ url: '/pages/quiz-history/quiz-history' });
  },

  goToOrderRecords() {
    wx.navigateTo({ url: '/pages/order-records/order-records' });
  },

  goToArRecords() {
    wx.navigateTo({ url: '/pages/ar-records/ar-records' });
  },

  goToSettings() {
    wx.navigateTo({ url: '/pages/settings/settings' });
  },

  goToFeedback() {
    wx.navigateTo({ url: '/pages/feedback/feedback' });
  },

  updateFilteredCoupons() {
    const { filterType, coupons } = this.data;
    let filtered = coupons;

    if (filterType === 'unused') {
      filtered = coupons.filter((c: any) => c.status === 'unused');
    } else if (filterType === 'used') {
      filtered = coupons.filter((c: any) => c.status === 'used');
    } else if (filterType === 'expired') {
      filtered = coupons.filter((c: any) => c.status === 'expired');
    }

    this.setData({ filteredCoupons: filtered });
  },

  async useCoupon(e: any) {
    const status = e.currentTarget.dataset.status;

    if (status === 'expired' || status === 'used') return;

    // 修复 P1#5：原先此处直接调用核销接口，只把券标记为已用，
    // 却不创建任何订单 —— 等于白扔一张券。
    // 券的实际核销应在扫码下单时由 orderService 原子完成，
    // 因此这里引导用户去首页扫码取纸。
    wx.showModal({
      title: '使用优惠券',
      content: '优惠券可在自助购纸下单时抵扣，现在去选购吗？',
      confirmText: '去商店',
      cancelText: '再想想',
      success: (res) => {
        if (res.confirm) {
          wx.switchTab({
            url: '/pages/shop/shop',
            fail: () => {
              wx.showToast({ title: '跳转失败，请手动点击底部商店', icon: 'none' });
            },
          });
        }
      },
    });
  },

  setFilter(e: any) {
    const type = e.currentTarget.dataset.type;
    this.setData({ filterType: type });
    this.updateFilteredCoupons();
  },

  handleLogout() {
    wx.showModal({
      title: '提示',
      content: '确定要退出登录吗？',
      success: (res) => {
        if (res.confirm) {
          // 云开发下身份由 OPENID 隐式携带，无 token 可清。
          // 此处仅清除本地缓存资料，账号数据与券不受影响。
          api.clearToken();
          wx.removeStorageSync('userInfo');

          if (app && app.globalData) {
            app.globalData.userInfo = null;
          }

          this.setData({
            isLoggedIn: false,
            userInfo: {},
            openid: '',
            userId: '',
            agreedToPrivacy: false,
            coupons: [],
            filteredCoupons: [],
            stats: { savedPaper: 0, quizCount: 0, totalQuizRecords: 0, unusedCoupons: 0 },
          });
          // 退出后停留在登录卡，由用户主动决定是否重新登录（不再自动重登）
        }
      },
    });
  },

  toggleAgreement() {
    this.setData({ agreedToPrivacy: !this.data.agreedToPrivacy });
  },

  showUserAgreement() {
    this.setData({
      showPrivacyPopup: true,
      privacyTitle: '用户服务协议',
      privacyContent: this.data.userAgreementContent,
    });
  },

  showPrivacyPolicy() {
    this.setData({
      showPrivacyPopup: true,
      privacyTitle: '隐私政策',
      privacyContent: this.data.privacyPolicyContent,
    });
  },

  closePrivacyPopup() {
    this.setData({ showPrivacyPopup: false });
  },
});
