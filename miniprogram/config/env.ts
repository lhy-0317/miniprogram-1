/**
 * 智惠本草 · 统一配置源
 *
 * 全项目唯一允许硬编码环境信息的地方。
 * 新建环境时只需修改本文件，app.ts / utils/api.ts 均从此引用。
 */

/**
 * 云开发环境 ID
 *
 * 2026-10-13 已开通新体验版环境并填入。
 * 旧环境 cloud1-d7geimrfs008f978c 已过期，勿再使用。
 */
export const CLOUD_ENV_ID = 'cloud1-d4g66lt423bd8978a';

/** 是否为开发态（仅影响日志与提示文案，不影响请求地址） */
export const IS_DEV = true;

/**
 * 管理后台 HTTP 访问服务地址
 *
 * 2026-10-14 已开通并填入（路由前缀 /admin → adminService）。
 * admin/ 目录下的静态页面经此域名调用后台接口。
 */
export const ADMIN_HTTP_BASE = 'https://cloud1-d4g66lt423bd8978a-1407294908.ap-shanghai.app.tcloudbase.com/admin';

/**
 * 云函数路由表
 *
 * 每个业务域一个云函数，云函数内部再按 action 分发。
 * 与 utils/api.ts 的调用一一对应。
 */
export const CLOUD_FUNCTIONS = {
  user: 'userService',
  quiz: 'quizService',
  coupon: 'couponService',
  order: 'orderService',
  device: 'deviceService',
  feedback: 'feedbackService',
} as const;

/** 出纸轮询配置 */
export const DISPENSE_POLL_INTERVAL = 2000; // 2 秒
export const DISPENSE_POLL_TIMEOUT = 30000; // 30 秒上限