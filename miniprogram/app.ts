import { CLOUD_ENV_ID } from './config/env';

App<IAppOption>({
  globalData: {
    userInfo: null,
    openid: null,
    deviceId: null,
    cloudEnvId: CLOUD_ENV_ID,
  },

  onLaunch() {
    if (!wx.cloud) {
      console.error('基础库版本过低，缺少云开发能力，请升级微信后再打开');
      return;
    }

    try {
      wx.cloud.init({
        env: CLOUD_ENV_ID,
        traceUser: true,
      });
    } catch (err) {
      console.error('云开发初始化失败，请检查 CLOUD_ENV_ID 配置', err);
      wx.showModal({
        title: '初始化失败',
        content: '云环境未配置或已失效，请联系管理员',
        showCancel: false,
      });
      return;
    }

    // 身份识别由云函数 getWXContext().OPENID 完成，客户端无需保存 token。
    // 这里只恢复用于界面展示的本地资料。
    const userInfo = wx.getStorageSync('userInfo');
    if (userInfo) {
      this.globalData.userInfo = userInfo;
    }
  },
});