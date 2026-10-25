/// <reference path="./types/index.d.ts" />

/**
 * 项目内使用的用户资料。
 *
 * 微信原生的 UserInfo 要求 city/country/gender/language/province，
 * 但本项目资料由云函数自建，仅 nickName 与 avatarUrl 两项，
 * 因此单独定义轻量类型，避免各处as any 绕过检查。
 */
interface UserProfile {
  nickName: string;
  avatarUrl: string;
}

interface IAppOption {
  globalData: {
    userInfo?: UserProfile | null,
    /** 用户 openid，由云函数 getWXContext().OPENID 识别，客户端仅作展示 */
    openid?: string | null,
    /** 当前扫码获取的设备 ID */
    deviceId?: string | null,
    /** 生效的云开发环境 ID，与 config/env.ts 中 CLOUD_ENV_ID 一致 */
    cloudEnvId?: string,
  }
  userInfoReadyCallback?: WechatMiniprogram.GetUserInfoSuccessCallback,
}