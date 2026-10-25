/**
 * 智惠本草管理后台 · 共享 API 客户端
 *
 * ⚠️ 重要约定（曾导致 4 个页面全部不可用）：
 *   本文件**不得声明任何裸全局变量**（如 `const API_BASE = ...`）。
 *   经典 <script> 共享同一全局词法作用域，页面内联脚本若再次声明同名 const，
 *   会抛 "Identifier 'X' has already been declared"，且语法错误发生在**解析阶段**，
 *   导致该页面所有函数都不存在、初始化不执行 —— 整个页面表现为完全不可用。
 *   因此这里的所有变量都包在 IIFE 闭包内，只通过 window.AdminAPI 暴露能力。
 */
(function () {
  const API_BASE = 'https://cloud1-d4g66lt423bd8978a-1407294908.ap-shanghai.app.tcloudbase.com/admin';

  function getToken() {
    return sessionStorage.getItem('adminToken');
  }

  function logout() {
    sessionStorage.removeItem('adminToken');
    sessionStorage.removeItem('adminUsername');
    window.location.href = 'login.html';
  }

  function checkAuth() {
    if (!getToken()) {
      window.location.href = 'login.html';
    }
  }

  /**
   * 统一请求。返回解析后的 JSON 体（包含 success:false 的业务失败响应）。
   * 仅在「网络异常 / 响应不是合法 JSON」时抛错，并把 HTTP 状态与响应片段带在 message 里，
   * 便于页面直接把真实原因显示出来（而非笼统的"加载失败"）。
   */
  async function request(method, url, data) {
    const fullUrl = url.startsWith('http') ? url : API_BASE + url;
    const token = getToken();

    const options = { method, headers: {} };
    if (token) options.headers.Authorization = 'Bearer ' + token;
    if (data !== undefined && data !== null && method !== 'GET') {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(data);
    }

    let response;
    try {
      response = await fetch(fullUrl, options);
    } catch (err) {
      throw new Error('网络请求失败：' + (err && err.message ? err.message : err));
    }

    if (response.status === 401) {
      logout();
      return null;
    }

    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (e) {
      json = null;
    }

    if (!json) {
      throw new Error(`HTTP ${response.status} · 响应不是合法 JSON：${(text || '（空响应，可能是云函数超时或未部署）').slice(0, 160)}`);
    }
    return json;
  }

  /** HTML 转义，防止昵称/题干里的特殊字符破坏表格渲染 */
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  /** 兼容 ISO 字符串与时间戳；非法值返回 null 而非 Invalid Date */
  function toDate(v) {
    if (!v) return null;
    const d = v instanceof Date ? v : new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }

  function formatDate(v) {
    const d = toDate(v);
    if (!d) return '-';
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function formatDateTime(v) {
    const d = toDate(v);
    if (!d) return '-';
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  /** 把真实错误渲染进指定表格容器，避免页面停在"加载中..." */
  function renderError(tbodyId, err, colspan) {
    const el = document.getElementById(tbodyId);
    if (!el) return;
    el.innerHTML = `<tr><td colspan="${colspan || 6}" class="px-6 py-8 text-center text-red-600 text-sm">加载失败：${escapeHtml(err && err.message ? err.message : err)}</td></tr>`;
  }

  window.AdminAPI = {
    base: API_BASE,
    get: (url) => request('GET', url),
    post: (url, data) => request('POST', url, data),
    put: (url, data) => request('PUT', url, data),
    del: (url, data) => request('DELETE', url, data),
    checkAuth,
    logout,
    escapeHtml,
    formatDate,
    formatDateTime,
    renderError,
  };

  // 除登录页外，进入页面即校验登录态
  if (!window.location.pathname.endsWith('login.html')) {
    checkAuth();
  }
})();
