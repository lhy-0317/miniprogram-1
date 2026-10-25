import { CLOUD_FUNCTIONS } from '../config/env';

/**
 * 云函数通信层
 *
 * 迁移说明：
 *   旧实现走 wx.request + 自建 Express 后端 + JWT Bearer 鉴权。
 *   现实现改走 wx.cloud.callFunction，身份由云函数 getWXContext().OPENID 识别，
 *   因此不再需要 token 存储、401 跳登录与 request 合法域名配置。
 *
 * 兼容策略：保留 get/post/put/del 与 {success, message, data} 信封，
 * 页面层调用方式保持不变，仅 URL 路径被解析为「云函数名 + action」。
 *
 * 例：api.get('/api/quiz/random', {count:5})
 *   → callFunction({ name: 'quizService', data: { action:'random', count:5 } })
 */

export interface ApiResponse<T = any> {
  success: boolean;
  message: string;
  data: T;
}

export interface RequestOptions {
  showLoading?: boolean;
  loadingTitle?: string;
  /** 失败时不弹 toast（用于静默轮询、可降级场景） */
  silent?: boolean;
}

/** 路径 → 云函数名映射。键为 /api/xxx 的 xxx 段。 */
const PATH_TO_FUNCTION: Record<string, string> = {
  user: CLOUD_FUNCTIONS.user,
  quiz: CLOUD_FUNCTIONS.quiz,
  coupons: CLOUD_FUNCTIONS.coupon,
  coupon: CLOUD_FUNCTIONS.coupon,
  payment: CLOUD_FUNCTIONS.order,
  order: CLOUD_FUNCTIONS.order,
  device: CLOUD_FUNCTIONS.device,
  feedback: CLOUD_FUNCTIONS.feedback,
  admin: 'adminService',
};

function showToast(message: string) {
  wx.showToast({ title: message, icon: 'none', duration: 2000 });
}

/**
 * 将 REST 风格路径解析为云函数调用参数。
 *
 * /api/quiz/history      → { name:'quizService', action:'history' }
 * /api/user/profile      → { name:'userService', action:'profile' }
 * /api/coupons/ID/use    → { name:'couponService', action:'use', params:{couponId:'ID'} }
 * /api/payment/order     → { name:'orderService',  action:'create' }
 */
function resolveRoute(method: string, url: string, data?: any) {
  const segments = url.replace(/^\/api\//, '').split('/').filter(Boolean);

  if (segments.length === 0) {
    throw new Error(`非法的调用路径: ${url}`);
  }

  const domain = segments[0];
  const fnName = PATH_TO_FUNCTION[domain];

  if (!fnName) {
    throw new Error(`未映射的接口域: ${domain}`);
  }

  // 兼容单复数别名：coupons 与 coupon 归一到同一 action 命名空间
  let action = segments[1] || 'default';
  if (domain === 'coupons' || domain === 'coupon') {
    action = segments[1] || 'list';
  }
  if (domain === 'payment' && segments[1] === 'order') {
    action = method === 'POST' ? 'create' : 'status';
  }

  // 修复：/api/user/profile 按方法分发——GET 读资料，PUT 更新资料。
  // 旧实现 action 直取 segments[1]='profile'，PUT 也命中只读的 getProfile，
  // updateProfile（action='update'）从未被调用，头像昵称保存"成功"但库从未变更。
  if (domain === 'user' && segments[1] === 'profile') {
    action = method === 'GET' ? 'profile' : 'update';
  }

  const payload: Record<string, any> = { action };

  // 其余路径段作为路径参数透传（如 coupons/:id/use → couponId + action=use）
  if (domain === 'coupons' || domain === 'coupon') {
    if (segments.length >= 3 && segments[2] === 'use') {
      payload.couponId = segments[1];
      payload.action = 'use';
    } else if (segments.length === 2 && method === 'POST') {
      payload.action = 'use';
      payload.couponId = data?.couponId;
    }
  }

  if (domain === 'payment' && segments[1] === 'order' && segments[2]) {
    payload.orderId = segments[2];
  }

  // GET 查询参数与请求体合并进 payload
  const incoming = method === 'GET' ? data : { ...(payload.query || {}), ...data };
  Object.keys(incoming || {}).forEach((k) => {
    const v = incoming[k];
    if (v !== undefined && v !== null) {
      payload[k] = v;
    }
  });

  return { fnName, payload };
}

function invoke<T = any>(fnName: string, payload: Record<string, any>, options: RequestOptions): Promise<ApiResponse<T>> {
  return new Promise((resolve, reject) => {
    if (options.showLoading) {
      wx.showLoading({ title: options.loadingTitle || '加载中...', mask: true });
    }

    wx.cloud
      .callFunction({
        name: fnName,
        data: payload,
      })
      .then((res: any) => {
        if (options.showLoading) wx.hideLoading();

        const result = res?.result as ApiResponse<T>;

        // 云函数异常（未捕获抛错）时 result 可能为空
        if (!result || typeof result !== 'object') {
          const msg = '服务返回异常';
          if (!options.silent) showToast(msg);
          reject(new Error(msg));
          return;
        }

        if (result.success === false) {
          if (!options.silent) showToast(result.message || '请求失败');
          reject(new Error(result.message || '请求失败'));
          return;
        }

        resolve(result);
      })
      .catch((err: any) => {
        if (options.showLoading) wx.hideLoading();

        const raw = err?.errMsg || err?.message || '';
        // 云函数未部署是最常见的失败原因，给出可操作的提示
        const friendly = /FUNCTION_NOT_FOUND|not found|不存在/i.test(raw)
          ? '服务未部署，请检查云函数'
          : '网络异常，请稍后重试';

        if (!options.silent) showToast(friendly);
        reject(new Error(friendly));
      });
  });
}

export const api = {
  get<T = any>(url: string, params?: Record<string, any>, options?: RequestOptions) {
    const { fnName, payload } = resolveRoute('GET', url, params);
    return invoke<T>(fnName, payload, options || {});
  },

  post<T = any>(url: string, data?: any, options?: RequestOptions) {
    const { fnName, payload } = resolveRoute('POST', url, data);
    return invoke<T>(fnName, payload, options || {});
  },

  put<T = any>(url: string, data?: any, options?: RequestOptions) {
    const { fnName, payload } = resolveRoute('PUT', url, data);
    return invoke<T>(fnName, payload, options || {});
  },

  del<T = any>(url: string, data?: any, options?: RequestOptions) {
    const { fnName, payload } = resolveRoute('DELETE', url, data);
    return invoke<T>(fnName, payload, options || {});
  },

  /**
   * 兼容旧调用点。
   * 云函数架构下不再需要 token，这里返回是否已完成过身份初始化，
   * 避免页面因 token 为空而误判未登录。
   */
  getToken(): string | null {
    return 'cloud-session';
  },

  setToken(_token: string) {
    // no-op：身份由 OPENID 隐式携带
  },

  clearToken() {
    try {
      wx.removeStorageSync('token');
      wx.removeStorageSync('openid');
    } catch {
      // ignore
    }
  },
};

export default api;