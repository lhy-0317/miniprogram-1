const app = getApp<IAppOption>();
import { api } from '../../utils/api';

Page({
  data: {
    avatarUrl: '',
    avatarFileId: '',
    nickName: '',
    originalNickName: '',
    originalAvatarUrl: '',
    originalAvatarFileId: '',
    savePopupVisible: false,
  },

  onLoad() {
    this.loadUserInfo();
  },

  async loadUserInfo() {
    const userInfo = wx.getStorageSync('userInfo');

    if (userInfo) {
      this.setData({
        nickName: userInfo.nickName || '微信用户',
        originalNickName: userInfo.nickName || '微信用户',
        avatarUrl: userInfo.avatarUrl || '',
        originalAvatarUrl: userInfo.avatarUrl || '',
      });
    }

    // Try server-side profile
    try {
      const res = await api.get('/api/user/profile');
      if (res.success) {
        const { nickName, avatarUrl } = res.data;
        this.setData({
          nickName: nickName || this.data.nickName,
          originalNickName: nickName || this.data.originalNickName,
          avatarUrl: avatarUrl || this.data.avatarUrl,
          originalAvatarUrl: avatarUrl || this.data.originalAvatarUrl,
          avatarFileId: (avatarUrl && avatarUrl.startsWith('cloud://')) ? avatarUrl : '',
        });

        if (avatarUrl && avatarUrl.startsWith('cloud://')) {
          this.getTempFileURL(avatarUrl);
        }
      }
    } catch {
      // Use local data
    }
  },

  chooseAvatar() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res: any) => {
        const tempFilePath = res.tempFiles[0].tempFilePath;
        this.uploadAvatar(tempFilePath);
      },
    });
  },

  uploadAvatar(filePath: string) {
    wx.showLoading({ title: '上传中...' });

    /**
     * 修复：原实现拼 avatars/${openid}_${ts}.jpg，
     * 迁移云开发后客户端不再缓存 openid，该值恒为空串，
     * 导致所有用户头像写入同一路径互相覆盖。
     * 改用 时间戳+随机串 保证唯一，路径里不携带任何身份信息——
     * 归属关系由云函数层的 _openid 字段表达，不由文件路径表达。
     */
    const rand = Math.random().toString(36).slice(2, 10);
    const cloudPath = `avatars/${Date.now()}_${rand}.jpg`;

    wx.cloud.uploadFile({
      cloudPath,
      filePath,
      success: (res: any) => {
        const fileID = res.fileID;
        this.setData({ avatarFileId: fileID });
        this.getTempFileURL(fileID);
      },
      fail: () => {
        wx.hideLoading();
        wx.showToast({ title: '上传失败', icon: 'error' });
      },
    });
  },

  getTempFileURL(fileID: string) {
    wx.cloud.getTempFileURL({
      fileList: [fileID],
      success: (res: any) => {
        const tempFileURL = res.fileList[0].tempFileURL;
        this.setData({ avatarUrl: tempFileURL });
        wx.hideLoading();
      },
      fail: () => {
        wx.hideLoading();
        this.setData({ avatarUrl: fileID });
      },
    });
  },

  onNickNameChange(e: any) {
    this.setData({ nickName: e.detail.value });
  },

  async handleSave() {
    if (!this.data.nickName.trim()) {
      wx.showToast({ title: '昵称不能为空', icon: 'none' });
      return;
    }

    const hasChanged =
      this.data.nickName !== this.data.originalNickName ||
      this.data.avatarUrl !== this.data.originalAvatarUrl;

    if (!hasChanged) {
      wx.showToast({ title: '没有修改', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '保存中...' });

    try {
      const avatarToSave = this.data.avatarFileId || this.data.avatarUrl;
      await api.put('/api/user/profile', {
        nickName: this.data.nickName,
        avatarUrl: avatarToSave,
      });

      // Update local storage
      const userInfo = {
        nickName: this.data.nickName,
        avatarUrl: avatarToSave,
      };
      wx.setStorageSync('userInfo', userInfo);

      if (app && app.globalData) {
        app.globalData.userInfo = userInfo;
      }

      this.setData({
        originalNickName: this.data.nickName,
        originalAvatarUrl: this.data.avatarUrl,
        originalAvatarFileId: avatarToSave,
        savePopupVisible: true,
      });

      wx.hideLoading();

      setTimeout(() => {
        this.setData({ savePopupVisible: false });
        wx.navigateBack();
      }, 1500);
    } catch {
      wx.hideLoading();
      wx.showToast({ title: '保存失败', icon: 'error' });
    }
  },

  goBack() {
    const hasChanged =
      this.data.nickName !== this.data.originalNickName ||
      this.data.avatarUrl !== this.data.originalAvatarUrl;

    if (hasChanged) {
      wx.showModal({
        title: '提示',
        content: '您有未保存的修改，确定要离开吗？',
        success: (res) => {
          if (res.confirm) {
            wx.navigateBack();
          }
        },
      });
    } else {
      wx.navigateBack();
    }
  },
});
