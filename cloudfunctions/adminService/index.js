/**
 * 管理后台服务 · 云函数（经 HTTP 访问服务暴露）
 *
 * 覆盖 admin/ 静态页面用到的 13 个接口：
 *   POST   /api/auth/admin/login
 *   GET    /api/admin/dashboard/stats
 *   GET    /api/admin/users          GET /api/admin/users/:id
 *   GET    /api/admin/coupons        POST /api/admin/coupons
 *   DELETE /api/admin/coupons/:id
 *   GET    /api/admin/quiz-records
 *   GET    /api/admin/questions      POST /api/admin/questions
 *   PUT    /api/admin/questions/:id  DELETE /api/admin/questions/:id
 *
 * ⚠️ 鉴权说明（与旧实现的关键差异）
 *
 *   旧实现靠 JWT + 可猜的默认密钥保护，且 /api/payment/callback 完全无鉴权。
 *   云函数无持久会话，无法复用 JWT 校验流程，因此改为「登录换令牌 + 令牌比对」：
 *
 *   1. POST /api/auth/admin/login 校验账号口令，返回一个不透明随机 token
 *   2. 该 token 存入云数据库 admin_token 集合并设置过期时间
 *   3. 其余接口要求 Authorization: Bearer <token>，逐次查库校验
 *
 *   这样即使 HTTP 访问服务完全公开，也无法凭构造请求访问管理数据。
 */

const crypto = require('crypto');
const {
  cloud,
  db,
  command,
  toIndexArray,
  sameIndexSet,
  couponTypeLabel,
  normalizeOrder,
  orderStatusText,
  canTransitionOrder,
} = require('./common');

/**
 * ⚠️ 上线前必须在云开发控制台配置环境变量 ADMIN_PASSWORD，
 *    留空时所有登录请求一律拒绝（fail-closed）。
 */
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const TOKEN_TTL_MS = 2 * 60 * 60 * 1000; // 2 小时

/** 防爆破：15 分钟窗口内连续失败 5 次即锁定 */
const LOCK_WINDOW_MS = 15 * 60 * 1000;
const LOCK_THRESHOLD = 5;

function ok(data = null, message = 'success') {
  return { success: true, message, data };
}

function fail(message, statusCode = 400) {
  return { success: false, message, data: null, code: statusCode };
}

/** 使用定长比较，避免时序侧信道 */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

async function login(event) {
  const { username, password } = event;

  if (!ADMIN_PASSWORD) {
    console.error('未配置 ADMIN_PASSWORD，拒绝一切登录');
    return fail('服务未初始化，请联系管理员', 503);
  }

  // 防爆破：检查近期失败次数（旧实现可无限次试密码）
  const windowStart = new Date(Date.now() - LOCK_WINDOW_MS);
  const recentFails = await db
    .collection('adm_loginf')
    .where({ createTime: command.gte(windowStart) })
    .count()
    .catch(() => ({ total: 0 }));

  if ((recentFails.total || 0) >= LOCK_THRESHOLD) {
    return fail('失败次数过多，请 15 分钟后再试', 429);
  }

  if (username !== 'admin' || !safeEqual(password || '', ADMIN_PASSWORD)) {
    await db.collection('adm_loginf').add({ data: { createTime: new Date() } }).catch(() => null);
    return fail('用户名或密码错误', 401);
  }

  // 登录成功：清空失败计数
  await db.collection('adm_loginf').where({}).remove().catch(() => null);

  const token = crypto.randomBytes(32).toString('hex');
  const expireAt = new Date(Date.now() + TOKEN_TTL_MS);

  await db.collection('admin_token').add({ data: {
    token,
    username,
    expireAt,
    createTime: new Date(),
  } });

  return ok({ token, username });
}

/** 校验 Bearer token */
async function authenticate(headers) {
  const raw = headers.authorization || headers.Authorization || '';
  const token = raw.replace(/^Bearer\s+/i, '').trim();

  if (!token) return false;

  const result = await db.collection('admin_token').where({ token }).limit(1).get();
  if (!result.data || result.data.length === 0) return false;

  const row = result.data[0];
  if (new Date(row.expireAt).getTime() < Date.now()) {
    await db.collection('admin_token').doc(row._id).remove().catch(() => null);
    return false;
  }

  return true;
}

async function getDashboardStats() {
  const [users, coupons, records, questions] = await Promise.all([
    db.collection('users').count().catch(() => ({ total: 0 })),
    db.collection('coupons').count().catch(() => ({ total: 0 })),
    db.collection('quiz_records').count().catch(() => ({ total: 0 })),
    db.collection('quiz_question').count().catch(() => ({ total: 0 })),
  ]);

  const unused = await db
    .collection('coupons')
    .where({ status: 'unused' })
    .count()
    .catch(() => ({ total: 0 }));

  const recentUsers = await db
    .collection('users')
    .orderBy('createTime', 'desc')
    .limit(5)
    .get()
    .catch(() => ({ data: [] }));

  const recentCoupons = await db
    .collection('coupons')
    .orderBy('createTime', 'desc')
    .limit(5)
    .get()
    .catch(() => ({ data: [] }));

  return ok({
    totalUsers: users.total || 0,
    totalCoupons: coupons.total || 0,
    unusedCoupons: unused.total || 0,
    totalRecords: records.total || 0,
    totalQuestions: questions.total || 0,
    recentUsers: (recentUsers.data || []).map((u) => ({
      _id: u._id,
      openid: u._openid || '',
      nickName: u.nickName || '微信用户',
      createTime: u.createTime,
    })),
    recentCoupons: (recentCoupons.data || []).map((c) => ({
      _id: c._id,
      openid: c._openid || '',
      amount: c.amount,
      status: c.status,
      createTime: c.createTime,
    })),
  });
}

function parsePaging(query) {
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(query.pageSize, 10) || 20, 1), 200);
  return { page, pageSize };
}

async function listUsers(query) {
  const { page, pageSize } = parsePaging(query);
  const search = (query.search || '').trim();

  const where = {};
  if (search) {
    // 修复：旧实现 search 在分页之后过滤，且 total 用未过滤总数
    // P1-2：必须转义，否则 '(' '[' '\' 等字符会构造出非法正则导致查询报错
    const keyword = db.RegExp({ regexp: escapeRegExp(search), options: 'i' });
    where.nickName = keyword;
  }

  const col = db.collection('users');
  // 空条件不调 where；skip 为 0 时省略（官方约定不传 skip 即从第 0 条开始）
  const base = Object.keys(where).length > 0 ? col.where(where) : col;
  const offset = (page - 1) * pageSize;
  const pageQuery = offset > 0
    ? base.orderBy('createTime', 'desc').skip(offset).limit(pageSize)
    : base.orderBy('createTime', 'desc').limit(pageSize);

  const [list, count] = await Promise.all([pageQuery.get(), base.count()]);

  const usersList = (list.data || []).map((u) => ({
    _id: u._id,
    openid: u._openid || '',
    nickName: u.nickName || '微信用户',
    avatarUrl: u.avatarUrl || '',
    savedPaper: u.savedPaper || 0,
    quizCount: u.quizCount || 0,
    createTime: u.createTime,
  }));

  // 所有后台页面统一消费 {success, data} 信封，列表类必须经 ok() 包装
  return ok({
    // list 为统一字段名（前端页面统一消费 data.data.list），users 为兼容别名
    list: usersList,
    users: usersList,
    total: count.total || 0,
    page,
  });
}

async function getUserDetail(id) {
  if (!id) return fail('缺少用户ID');

  let doc;
  try {
    doc = await db.collection('users').doc(id).get();
  } catch (err) {
    return fail('用户不存在', 404);
  }

  // doc().get() 返回 {data: 文档对象}（非数组）
  const raw = doc && doc.data;
  const user = Array.isArray(raw) ? (raw[0] || null) : (raw || null);
  if (!user) return fail('用户不存在', 404);

  const [coupons, records] = await Promise.all([
    db.collection('coupons').where({ _openid: user._openid }).limit(20).get().catch(() => ({ data: [] })),
    db.collection('quiz_records').where({ _openid: user._openid }).limit(20).get().catch(() => ({ data: [] })),
  ]);

  return {
    user: {
      _id: user._id,
      openid: user._openid || '',
      nickName: user.nickName,
      avatarUrl: user.avatarUrl || '',
      savedPaper: user.savedPaper || 0,
      quizCount: user.quizCount || 0,
      createTime: user.createTime,
    },
    coupons: coupons.data || [],
    records: records.data || [],
  };
}

async function listCoupons(query) {
  const { page, pageSize } = parsePaging(query);

  const base = db.collection('coupons');
  const offset = (page - 1) * pageSize;
  // skip 为 0 时省略（官方约定不传 skip 即从第 0 条开始）
  const pageQuery = offset > 0
    ? base.orderBy('createTime', 'desc').skip(offset).limit(pageSize)
    : base.orderBy('createTime', 'desc').limit(pageSize);

  const [list, count] = await Promise.all([pageQuery.get(), base.count()]);

  const couponsList = (list.data || []).map((c) => ({
    _id: c._id,
    id: c._id, // 统一返回两种 ID，消除旧实现的 id/_id 字段冲突
    openid: c._openid || '',
    amount: c.amount,
    // 库内可能是机器码（paper/shopping）或中文标签，统一归一
    type: couponTypeLabel(c.type),
    desc: c.desc || '',
    // 过期为读时计算（与小程序端一致），否则后台"已过期"统计恒为 0
    status: c.status === 'unused' && isCouponExpired(c.expireDate) ? 'expired' : c.status,
    expireDate: c.expireDate,
    createTime: c.createTime,
  }));

  // 所有后台页面统一消费 {success, data} 信封，列表类必须经 ok() 包装
  return ok({
    // list 为统一字段名（前端页面统一消费 data.data.list），coupons 为兼容别名
    list: couponsList,
    coupons: couponsList,
    total: count.total || 0,
    page,
  });
}

/** 券是否已过期（读时计算，与小程序端 couponService 保持一致） */
function isCouponExpired(expireDate) {
  if (!expireDate) return false;
  const end = new Date(`${expireDate}T23:59:59`);
  return end.getTime() < Date.now();
}

async function createCoupon(body) {
  const { amount, type, expireDays, all } = body;
  // 兼容两种入参：openid（新）与 targetUser（旧版页面字段名）
  const rawTarget = String(body.openid || body.targetUser || '').trim();

  if (!amount) return fail('缺少券面额');

  const days = Math.min(Math.max(parseInt(expireDays, 10) || 30, 1), 365);
  const expireDate = new Date();
  expireDate.setDate(expireDate.getDate() + days);
  const expireStr = `${expireDate.getFullYear()}-${String(expireDate.getMonth() + 1).padStart(2, '0')}-${String(expireDate.getDate()).padStart(2, '0')}`;

  const baseFields = {
    amount,
    type: couponTypeLabel(type),
    desc: '管理员发放',
    status: 'unused',
    source: 'admin',
    expireDate: expireStr,
    createTime: new Date(),
    updateTime: new Date(),
  };

  // 模式一：发放给所有用户（页面文案承诺的能力，旧实现并未支持）
  if (all) {
    const users = await db.collection('users').limit(MAX_GRANT_ALL).get().catch(() => ({ data: [] }));
    const targets = (users.data || []).map((u) => u._openid).filter(Boolean);
    if (targets.length === 0) return fail('暂无用户可发放');

    let granted = 0;
    const CONCURRENCY = 10;
    for (let i = 0; i < targets.length; i += CONCURRENCY) {
      const chunk = targets.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        chunk.map(async (oid) => {
          try {
            const r = await db.collection('coupons').add({ data: { ...baseFields, _openid: oid } });
            return !!(r && r._id);
          } catch (e) {
            return false;
          }
        })
      );
      granted += results.filter(Boolean).length;
    }
    return ok({ granted, total: targets.length }, `已向 ${granted} 位用户发放`);
  }

  if (!rawTarget) return fail('请填写用户 OpenID 或其末 8 位');

  // 模式二：定位单个用户。完整 openid 直接用；短串按末位匹配（页面提示"OpenID 后 8 位"）
  let finalOpenid = rawTarget;
  if (rawTarget.length < 28) {
    const matched = await db
      .collection('users')
      .where({ _openid: db.RegExp({ regexp: escapeRegExp(rawTarget) + '$' }) })
      .limit(2)
      .get()
      .catch(() => ({ data: [] }));

    const list = matched.data || [];
    if (list.length === 0) return fail('未找到匹配的用户，请检查 OpenID 末 8 位');
    if (list.length > 1) return fail('匹配到多个用户，请填写完整 OpenID');
    finalOpenid = list[0]._openid;
  }

  const result = await db.collection('coupons').add({ data: { ...baseFields, _openid: finalOpenid } });

  return ok({ _id: result._id, openid: finalOpenid }, '发放成功');
}

async function deleteCoupon(id) {
  if (!id) return fail('缺少券ID');
  const result = await db.collection('coupons').doc(id).remove();
  if (!result.stats || result.stats.removed === 0) {
    return fail('券不存在', 404);
  }
  return ok(null, '删除成功');
}

/**
 * 答题记录全局统计。
 *
 * 页面顶部的"总答题数/正确数/正确率"语义是全局的，
 * 而列表接口只返回当前页——旧实现用当前页记录算比例，翻页就变，属数据误导。
 */
async function getQuizRecordStats() {
  const [total, correct] = await Promise.all([
    db.collection('quiz_records').count().catch(() => ({ total: 0 })),
    db.collection('quiz_records').where({ isCorrect: true }).count().catch(() => ({ total: 0 })),
  ]);

  const totalCount = total.total || 0;
  const correctCount = correct.total || 0;

  return ok({
    total: totalCount,
    correct: correctCount,
    wrong: totalCount - correctCount,
    rate: totalCount > 0 ? Math.round((correctCount / totalCount) * 100) : null,
  });
}

async function listQuizRecords(query) {
  const { page, pageSize } = parsePaging(query);

  const base = db.collection('quiz_records');
  const offset = (page - 1) * pageSize;
  // skip 为 0 时省略（官方约定不传 skip 即从第 0 条开始）
  const pageQuery = offset > 0
    ? base.orderBy('createTime', 'desc').skip(offset).limit(pageSize)
    : base.orderBy('createTime', 'desc').limit(pageSize);

  const [list, count] = await Promise.all([pageQuery.get(), base.count()]);

  const recordsList = (list.data || []).map((r) => ({
    _id: r._id,
    openid: r._openid || '',
    question: r.question,
    isCorrect: r.isCorrect,
    // 多选题存下标数组；旧记录为单个数字，统一归一化为数组供前端渲染字母
    userOptionIndices: toIndexArray(r.userOptionIndices ?? r.userOptionIndex),
    correctOptionIndices: toIndexArray(r.correctOptionIndices ?? r.correctOptionIndex),
    // 保留旧字段（单选首项），兼容旧版页面
    userOptionIndex: r.userOptionIndex,
    correctOptionIndex: r.correctOptionIndex,
    answerTime: r.answerTime,
    createTime: r.createTime,
  }));

  // 所有后台页面统一消费 {success, data} 信封，列表类必须经 ok() 包装
  return ok({
    // list 为统一字段名（前端页面统一消费 data.data.list），records 为兼容别名
    list: recordsList,
    records: recordsList,
    total: count.total || 0,
    page,
  });
}

// ===== 题库管理 =====

const QUESTION_TYPES = { single: 1, judge: 1, multi: 1 };
const DIFFICULTIES = { easy: 1, medium: 1, hard: 1 };
const MAX_IMPORT = 500;
const MAX_BATCH_DELETE = 200;
const MAX_EXPORT = 1000;
/** 一键发放给所有用户的上限（并发 10 路，防超时） */
const MAX_GRANT_ALL = 200;

/** 关键字转义，防正则注入 */
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 题目字段校验（新增 / 编辑 / 导入共用）。
 *
 * 校验规则：
 * - question  必填，去空格后 1-200 字
 * - options   数组 2-8 个，每项非空、≤100 字
 * - correct   0 到 options.length-1 的整数
 * - type      single（单选）/ judge（判断），判断题必须恰好 2 个选项；缺省 single
 * - difficulty easy / medium / hard，缺省 medium
 * - category  可选，≤20 字；explanation 可选，≤500 字
 *
 * @param {object} body 就地规范化（trim / 默认值填充）
 * @param {object} opts { partial: true } 时全部字段视为已提供（编辑前先合并现有值）
 */
function validateQuestionPayload(body, opts = {}) {
  const partial = !!opts.partial;
  if (!partial || body.question !== undefined) {
    if (typeof body.question !== 'string' || !body.question.trim()) {
      return { ok: false, reason: '题干不能为空' };
    }
    if (body.question.trim().length > 200) return { ok: false, reason: '题干不能超过 200 字' };
    body.question = body.question.trim();
  }

  if (!partial || body.options !== undefined) {
    const opts2 = body.options;
    if (!Array.isArray(opts2) || opts2.length < 2) return { ok: false, reason: '至少需要两个选项' };
    if (opts2.length > 8) return { ok: false, reason: '选项不能超过 8 个' };
    for (let i = 0; i < opts2.length; i++) {
      if (typeof opts2[i] !== 'string' || !opts2[i].trim()) {
        return { ok: false, reason: `第 ${i + 1} 个选项不能为空` };
      }
      if (opts2[i].trim().length > 100) return { ok: false, reason: `第 ${i + 1} 个选项过长（≤100 字）` };
    }
    body.options = opts2.map((o) => o.trim());
  }

  if (!partial || body.type !== undefined) {
    const t = body.type === undefined || body.type === '' ? 'single' : body.type;
    if (!QUESTION_TYPES[t]) return { ok: false, reason: '题型不合法（single / judge / multi）' };
    body.type = t;
    if (t === 'judge' && Array.isArray(body.options) && body.options.length !== 2) {
      return { ok: false, reason: '判断题必须恰好两个选项' };
    }
    if (t === 'multi' && Array.isArray(body.options) && body.options.length < 3) {
      return { ok: false, reason: '多选题至少需要三个选项' };
    }
  }

  if (!partial || body.difficulty !== undefined) {
    const d = body.difficulty === undefined || body.difficulty === '' ? 'medium' : body.difficulty;
    if (!DIFFICULTIES[d]) return { ok: false, reason: '难度不合法（easy / medium / hard）' };
    body.difficulty = d;
  }

  if (!partial || body.correct !== undefined) {
    // 兼容旧格式（单个数字）与多选格式（下标数组），统一规范化为数组
    const indices = toIndexArray(body.correct);
    const count = Array.isArray(body.options) ? body.options.length : 0;
    if (indices.length === 0) {
      return { ok: false, reason: count ? '未提供合法的正确答案' : '缺少选项，无法校验答案' };
    }
    if (indices.some((i) => i >= count)) {
      return { ok: false, reason: count ? `正确答案位置不合法（0-${count - 1}）` : '缺少选项，无法校验答案' };
    }
    if (body.type === 'multi') {
      if (indices.length < 2) return { ok: false, reason: '多选题至少需要两个正确答案' };
    } else if (indices.length !== 1) {
      return { ok: false, reason: '单选题/判断题只能有一个正确答案' };
    }
    body.correct = indices;
  }

  if (body.explanation !== undefined && body.explanation !== '') {
    if (typeof body.explanation !== 'string' || body.explanation.length > 500) {
      return { ok: false, reason: '解析过长（≤500 字）' };
    }
  }
  if (body.category !== undefined && body.category !== '') {
    if (typeof body.category !== 'string' || body.category.trim().length > 20) {
      return { ok: false, reason: '分类标签过长（≤20 字）' };
    }
    body.category = body.category.trim();
  }

  return { ok: true };
}

/** 由查询参数构建题目过滤条件（列表与导出共用） */
function buildQuestionWhere(query) {
  const where = {};
  const keyword = String(query.keyword || '').trim();
  if (keyword) {
    where.question = db.RegExp({ regexp: escapeRegExp(keyword), options: 'i' });
  }
  if (query.type && QUESTION_TYPES[query.type]) where.type = query.type;
  if (query.difficulty && DIFFICULTIES[query.difficulty]) where.difficulty = query.difficulty;
  if (query.category) where.category = String(query.category).trim();
  return where;
}

function mapQuestion(q) {
  return {
    _id: q._id,
    question: q.question,
    options: q.options,
    // 统一返回下标数组（旧数据为单个数字，此处归一化），前端按数组渲染
    correct: toIndexArray(q.correct),
    type: q.type || 'single',
    difficulty: q.difficulty || 'medium',
    category: q.category || '',
    explanation: q.explanation || '',
    createTime: q.createTime,
    updateTime: q.updateTime,
  };
}

async function listQuestions(query) {
  const { page, pageSize } = parsePaging(query);
  const where = buildQuestionWhere(query);
  const offset = (page - 1) * pageSize;

  const col = db.collection('quiz_question');
  // 空条件时不调用 where（避免空对象条件走到不确定行为），skip 为 0 时也不调用
  const base = Object.keys(where).length > 0 ? col.where(where) : col;
  const pageQuery = offset > 0 ? base.orderBy('createTime', 'desc').skip(offset).limit(pageSize) : base.orderBy('createTime', 'desc').limit(pageSize);

  const [list, count] = await Promise.all([pageQuery.get(), base.count()]);

  const questionsList = (list.data || []).map(mapQuestion);

  // 所有后台页面统一消费 {success, data} 信封，列表类必须经 ok() 包装
  return ok({
    // list 为统一字段名（前端页面统一消费 data.data.list），questions 为兼容别名
    list: questionsList,
    questions: questionsList,
    total: count.total || 0,
    page,
    pageSize,
  });
}

async function createQuestion(body) {
  const check = validateQuestionPayload(body);
  if (!check.ok) return fail(check.reason);

  const now = new Date();
  const result = await db.collection('quiz_question').add({ data: {
    question: body.question,
    options: body.options,
    correct: body.correct,
    type: body.type,
    difficulty: body.difficulty,
    category: body.category || '',
    explanation: body.explanation || '',
    createTime: now,
    updateTime: now,
  } });

  return ok({ _id: result._id }, '创建成功');
}

async function updateQuestion(id, body) {
  if (!id) return fail('缺少题目ID');

  const existing = await db.collection('quiz_question').doc(id).get().catch(() => null);
  // doc().get() 返回 {data: 文档对象}（非数组），查不到时抛错被兜成 null
  const existRaw = existing && existing.data;
  const existDoc = Array.isArray(existRaw) ? (existRaw[0] || null) : (existRaw || null);
  if (!existDoc) {
    return fail('题目不存在', 404);
  }

  // 合并现有值后整体校验，保证「改难度不改选项」等局部更新也满足完整约束
  const merged = { ...mapQuestion(existDoc), ...body };
  const check = validateQuestionPayload(merged, { partial: true });
  if (!check.ok) return fail(check.reason);

  const patch = { updateTime: new Date() };
  patch.question = merged.question;
  patch.options = merged.options;
  patch.correct = merged.correct;
  patch.type = merged.type;
  patch.difficulty = merged.difficulty;
  if (body.category !== undefined) patch.category = merged.category;
  if (body.explanation !== undefined) patch.explanation = merged.explanation;

  const result = await db.collection('quiz_question').doc(id).update({ data: patch });

  // 修复：旧实现更新不存在的 id 也返回「更新成功」
  if (!result.stats || result.stats.updated === 0) {
    return fail('题目不存在', 404);
  }

  return ok({ _id: id }, '更新成功');
}

async function deleteQuestion(id) {
  if (!id) return fail('缺少题目ID');
  const result = await db.collection('quiz_question').doc(id).remove();
  if (!result.stats || result.stats.removed === 0) {
    return fail('题目不存在', 404);
  }
  return ok(null, '删除成功');
}

/**
 * 批量删除题目。
 *
 * body: { ids: string[] }，单次上限 200；
 * 返回实际删除数（部分 id 可能已被删除，按 removed 计）。
 */
async function batchDeleteQuestions(body) {
  const ids = Array.isArray(body && body.ids) ? body.ids.filter(Boolean) : [];
  if (ids.length === 0) return fail('未选择任何题目');
  if (ids.length > MAX_BATCH_DELETE) return fail(`单次最多删除 ${MAX_BATCH_DELETE} 条`);

  const result = await db
    .collection('quiz_question')
    .where({ _id: command.in(ids) })
    .remove();

  const removed = (result.stats && result.stats.removed) || 0;
  return ok({ removed, requested: ids.length }, `已删除 ${removed} 道题目`);
}

/**
 * 导出题目（当前筛选条件下最多 1000 条）。
 * 前端拿到列表后自行生成 JSON 文件下载。
 */
async function exportQuestions(query) {
  const where = buildQuestionWhere(query);
  const col = db.collection('quiz_question');
  // 空条件不调 where（与列表接口保持同一写法）
  const base = Object.keys(where).length > 0 ? col.where(where) : col;
  const result = await base.orderBy('createTime', 'desc').limit(MAX_EXPORT).get();

  const list = (result.data || []).map(mapQuestion);
  return ok({ list, total: list.length, exportedAt: new Date().toISOString() }, '导出成功');
}

/**
 * 批量导入题目。
 *
 * body: { questions: object[] }，单次上限 500。
 * 逐条走 validateQuestionPayload 校验，全部失败项带序号与原因返回，
 * 校验通过的逐条写入（时间戳统一为本次导入时间）。
 */
async function importQuestions(body) {
  const items = Array.isArray(body && body.questions) ? body.questions : null;
  if (!items) return fail('导入内容须为 questions 数组');
  if (items.length === 0) return fail('导入内容为空');
  if (items.length > MAX_IMPORT) return fail(`单次最多导入 ${MAX_IMPORT} 条`);

  const failed = [];
  const valid = [];
  for (let i = 0; i < items.length; i++) {
    const item = { ...items[i] };
    const check = validateQuestionPayload(item);
    if (!check.ok) {
      failed.push({ index: i + 1, question: (item && item.question ? String(item.question).slice(0, 30) : ''), reason: check.reason });
      continue;
    }
    valid.push({ index: i + 1, item });
  }

  const now = new Date();
  let imported = 0;

  // 并发写入：10 路并发，避免逐条串行导致云函数超时（HTTP 访问服务网关约 15s 上限）。
  // 注意：云函数「超时时间」默认 3s，批量导入前请在控制台把它调到 20s。
  const CONCURRENCY = 10;
  for (let i = 0; i < valid.length; i += CONCURRENCY) {
    const chunk = valid.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      chunk.map(async ({ index, item }) => {
        try {
          const r = await db.collection('quiz_question').add({ data: {
            question: item.question,
            options: item.options,
            correct: item.correct,
            type: item.type,
            difficulty: item.difficulty,
            category: item.category || '',
            explanation: item.explanation || '',
            createTime: now,
            updateTime: now,
          } });
          return { index, item, ok: !!(r && r._id) };
        } catch (e) {
          return { index, item, ok: false };
        }
      })
    );

    for (const res of results) {
      if (res.ok) {
        imported++;
      } else {
        failed.push({ index: res.index, question: String(res.item.question).slice(0, 30), reason: '写入数据库失败' });
      }
    }
  }

  return ok(
    { imported, failedCount: failed.length, failed },
    `导入完成：成功 ${imported} 条，失败 ${failed.length} 条`
  );
}

/**
 * 后端自诊断：逐条跑数据库查询变体，报出哪一条失败及真实错误。
 * 用于线上排障（管理后台列表页加载失败时，一次调用即可定位）。
 */
async function runDiagnostics() {
  const probes = [];

  async function probe(name, fn) {
    const t0 = Date.now();
    try {
      const r = await fn();
      let sample = null;
      if (r && Array.isArray(r.data)) sample = { rows: r.data.length, firstId: r.data[0] && r.data[0]._id };
      else if (r && typeof r.total === 'number') sample = { total: r.total };
      probes.push({ name, ok: true, ms: Date.now() - t0, sample });
    } catch (e) {
      probes.push({
        name,
        ok: false,
        ms: Date.now() - t0,
        error: String((e && (e.errMsg || e.message)) || e).slice(0, 300),
      });
    }
  }

  const col = () => db.collection('quiz_question');

  await probe('count:raw', () => col().count());
  await probe('count:whereEmpty', () => col().where({}).count());
  await probe('list:simpleLimit', () => col().limit(20).get());
  await probe('list:orderBy', () => col().orderBy('createTime', 'desc').limit(20).get());
  await probe('list:skip0', () => col().orderBy('createTime', 'desc').skip(0).limit(20).get());
  await probe('list:skip20', () => col().orderBy('createTime', 'desc').skip(20).limit(20).get());
  await probe('list:whereEmptyOrderBy', () =>
    col().where({}).orderBy('createTime', 'desc').skip(0).limit(20).get());
  await probe('list:parallelGetCount', () =>
    Promise.all([col().orderBy('createTime', 'desc').limit(20).get(), col().count()]));
  await probe('list:asUsedNow', () =>
    Promise.all([col().orderBy('createTime', 'desc').limit(20).get(), col().count()]));

  const failed = probes.filter((p) => !p.ok);
  return ok(
    {
      env: process.env.TCB_ENV || process.env.SCF_NAMESPACE || '(未知)',
      nodeVersion: process.version,
      probes,
      failedCount: failed.length,
    },
    failed.length === 0 ? '诊断通过：所有查询正常' : `诊断发现 ${failed.length} 项失败`
  );
}

// ===== 问题反馈管理 =====

/** 反馈状态：待处理 / 处理中 / 已解决 */
const FEEDBACK_STATUS = { pending: 1, processing: 1, resolved: 1 };
/** 与小程序 feedback 页的类型取值一一对应 */
const FEEDBACK_TYPES = { suggestion: 1, bug: 1, question: 1, other: 1 };
const MAX_REPLY_LEN = 500;

function feedbackTypeText(t) {
  return ({ suggestion: '建议', bug: '故障', question: '咨询', other: '其他' })[t] || '其他';
}

function feedbackStatusText(st) {
  return ({ pending: '待处理', processing: '处理中', resolved: '已解决' })[st] || '待处理';
}

/**
 * 按自然日构造时间区间条件（订单/反馈共用）。
 * 结束日含当天 23:59:59.999，避免"选到今天却查不到今天"的经典坑。
 */
function buildDateRange(query, field = 'createTime') {
  const start = String(query.startDate || '').trim();
  const end = String(query.endDate || '').trim();
  const startOk = /^\d{4}-\d{2}-\d{2}$/.test(start);
  const endOk = /^\d{4}-\d{2}-\d{2}$/.test(end);

  if (!startOk && !endOk) return null;
  if (startOk && endOk) {
    return { [field]: command.and(
      command.gte(new Date(`${start}T00:00:00`)),
      command.lte(new Date(`${end}T23:59:59.999`))
    ) };
  }
  if (startOk) return { [field]: command.gte(new Date(`${start}T00:00:00`)) };
  return { [field]: command.lte(new Date(`${end}T23:59:59.999`)) };
}

/** 组装反馈过滤条件（列表与统计共用口径） */
function buildFeedbackWhere(query) {
  const where = {};
  if (query.status && FEEDBACK_STATUS[query.status]) where.status = query.status;
  if (query.type && FEEDBACK_TYPES[query.type]) where.type = query.type;

  const keyword = String(query.keyword || '').trim();
  if (keyword) where.content = db.RegExp({ regexp: escapeRegExp(keyword), options: 'i' });

  const dateWhere = buildDateRange(query);
  if (dateWhere) where.createTime = dateWhere.createTime;

  return where;
}

function mapFeedback(f) {
  return {
    _id: f._id,
    openid: f._openid || '',
    type: f.type || 'other',
    typeText: feedbackTypeText(f.type),
    content: f.content || '',
    contact: f.contact || '',
    images: Array.isArray(f.images) ? f.images : [],
    imageCount: Array.isArray(f.images) ? f.images.length : 0,
    status: f.status || 'pending',
    statusText: feedbackStatusText(f.status),
    reply: f.reply || '',
    replyTime: f.replyTime || null,
    createTime: f.createTime,
    updateTime: f.updateTime,
  };
}

/** 反馈列表：支持状态 / 类型 / 关键字 / 时间区间筛选与分页 */
async function listFeedback(query) {
  const { page, pageSize } = parsePaging(query);
  const where = buildFeedbackWhere(query);
  const offset = (page - 1) * pageSize;

  const col = db.collection('feedback');
  // 空条件不调 where；skip 为 0 时省略（与其它列表接口保持同一写法）
  const base = Object.keys(where).length > 0 ? col.where(where) : col;
  const pageQuery = offset > 0
    ? base.orderBy('createTime', 'desc').skip(offset).limit(pageSize)
    : base.orderBy('createTime', 'desc').limit(pageSize);

  const [list, count] = await Promise.all([pageQuery.get(), base.count()]);
  const items = (list.data || []).map(mapFeedback);

  return ok({
    list: items,
    items,
    total: count.total || 0,
    page,
    pageSize,
  });
}

/** 反馈各状态计数（用于统计卡与侧边栏待处理徽标） */
async function getFeedbackStats() {
  const col = db.collection('feedback');
  const [all, pending, processing, resolved] = await Promise.all([
    col.count().catch(() => ({ total: 0 })),
    col.where({ status: 'pending' }).count().catch(() => ({ total: 0 })),
    col.where({ status: 'processing' }).count().catch(() => ({ total: 0 })),
    col.where({ status: 'resolved' }).count().catch(() => ({ total: 0 })),
  ]);

  return ok({
    total: all.total || 0,
    pending: pending.total || 0,
    processing: processing.total || 0,
    resolved: resolved.total || 0,
  });
}

/**
 * 反馈详情：附带提交者信息与图片的可访问链接。
 *
 * 小程序上传的是 cloud:// fileID，浏览器无法直接渲染，
 * 故在服务端用 cloud.getTempFileURL 换成临时 https 链接（默认 2 小时有效）。
 */
async function getFeedbackDetail(id) {
  if (!id) return fail('缺少反馈ID');

  const doc = await db.collection('feedback').doc(id).get().catch(() => null);
  const raw = doc && doc.data;
  const f = Array.isArray(raw) ? (raw[0] || null) : (raw || null);
  if (!f) return fail('反馈不存在', 404);

  const detail = mapFeedback(f);

  // 提交者信息（找不到用户也不影响详情展示）
  let submitter = null;
  if (f._openid) {
    const u = await db.collection('users').where({ _openid: f._openid }).limit(1).get().catch(() => ({ data: [] }));
    const user = (u.data || [])[0];
    if (user) {
      submitter = {
        _id: user._id,
        nickName: user.nickName || '微信用户',
        avatarUrl: user.avatarUrl || '',
        quizCount: user.quizCount || 0,
        savedPaper: user.savedPaper || 0,
        createTime: user.createTime,
      };
    }
  }

  // 图片临时链接
  let imageUrls = [];
  if (detail.images.length > 0) {
    // 用前缀判断而非正则，避免转义歧义
    const cloudIds = detail.images.filter((u) => String(u).indexOf('cloud://') === 0);
    const httpsIds = detail.images.filter((u) => String(u).indexOf('cloud://') !== 0);
    let resolved = [];
    if (cloudIds.length > 0) {
      const res = await cloud.getTempFileURL({ fileList: cloudIds }).catch(() => null);
      resolved = ((res && res.fileList) || [])
        .map((item) => item.tempFileURL)
        .filter(Boolean);
    }
    imageUrls = [...resolved, ...httpsIds];
  }

  return ok({ feedback: detail, submitter, imageUrls });
}

/** 处理反馈：标记状态 / 回复 */
async function updateFeedback(id, body) {
  if (!id) return fail('缺少反馈ID');

  const doc = await db.collection('feedback').doc(id).get().catch(() => null);
  const raw = doc && doc.data;
  const exist = Array.isArray(raw) ? (raw[0] || null) : (raw || null);
  if (!exist) return fail('反馈不存在', 404);

  const patch = { updateTime: new Date() };

  if (body.status !== undefined) {
    if (!FEEDBACK_STATUS[body.status]) return fail('状态不合法（pending / processing / resolved）');
    patch.status = body.status;
  }

  if (body.reply !== undefined) {
    if (typeof body.reply !== 'string') return fail('回复内容格式不正确');
    const reply = body.reply.trim();
    if (reply.length > MAX_REPLY_LEN) return fail(`回复不能超过 ${MAX_REPLY_LEN} 字`);
    patch.reply = reply;
    patch.replyTime = reply ? new Date() : null;
  }

  // 有回复但没显式改状态时，自动置为「已解决」，减少一次点击
  if (patch.reply && body.status === undefined && exist.status !== 'resolved') {
    patch.status = 'resolved';
  }

  await db.collection('feedback').doc(id).update({ data: patch });

  return ok(
    { _id: id, status: patch.status || exist.status, hasReply: !!patch.reply },
    '处理成功'
  );
}

async function deleteFeedback(id) {
  if (!id) return fail('缺少反馈ID');

  const doc = await db.collection('feedback').doc(id).get().catch(() => null);
  const raw = doc && doc.data;
  const exist = Array.isArray(raw) ? (raw[0] || null) : (raw || null);
  if (!exist) return fail('反馈不存在', 404);

  await db.collection('feedback').doc(id).remove();
  return ok({ _id: id }, '已删除');
}

// ===== 订单管理 =====

const ADMIN_ORDER_STATUS = { pending: 1, paid: 1, completed: 1, cancelled: 1, failed: 1 };
const ADMIN_ORDER_TYPES = { shop: 1, paper: 1 };
/** 后台允许手动流转的目标状态（合法性仍由订单状态机判定） */
const ADMIN_ORDER_TARGETS = ['paid', 'completed', 'cancelled'];

function orderTypeText(t) {
  return ({ shop: '商店订单', paper: '取纸订单' })[t] || '订单';
}

/**
 * 组装订单查询条件（列表与统计同口径）。
 * 支持：状态 / 类型 / 关键字（订单号·商品名·用户 openid）/ 下单时间区间。
 */
function buildOrderQuery(query) {
  const conds = [];

  if (query.status && ADMIN_ORDER_STATUS[query.status]) conds.push({ status: query.status });
  if (query.type && ADMIN_ORDER_TYPES[query.type]) conds.push({ type: query.type });

  const dateWhere = buildDateRange(query, 'createTime');
  if (dateWhere) conds.push(dateWhere);

  const keyword = String(query.keyword || '').trim();
  if (keyword) {
    const re = db.RegExp({ regexp: escapeRegExp(keyword), options: 'i' });
    // 订单号 / 商品名 / 下单用户 三路匹配
    conds.push(command.or([{ orderSn: re }, { title: re }, { _openid: re }]));
  }

  if (conds.length === 0) return null;
  if (conds.length === 1) return conds[0];
  return command.and(conds);
}

/** 订单列表：筛选 + 分页 + 各状态计数 + 本页金额小计 */
async function listOrders(query) {
  const { page, pageSize } = parsePaging(query);
  const cond = buildOrderQuery(query);

  const col = db.collection('orders');
  const base = cond ? col.where(cond) : col;
  const offset = (page - 1) * pageSize;

  const pageQuery = offset > 0
    ? base.orderBy('createTime', 'desc').skip(offset).limit(pageSize)
    : base.orderBy('createTime', 'desc').limit(pageSize);

  const [listRes, countRes, allRes, pendingRes, paidRes, completedRes, cancelledRes] = await Promise.all([
    pageQuery.get().catch(() => ({ data: [] })),
    base.count().catch(() => ({ total: 0 })),
    col.count().catch(() => ({ total: 0 })),
    col.where({ status: 'pending' }).count().catch(() => ({ total: 0 })),
    col.where({ status: 'paid' }).count().catch(() => ({ total: 0 })),
    col.where({ status: 'completed' }).count().catch(() => ({ total: 0 })),
    col.where({ status: 'cancelled' }).count().catch(() => ({ total: 0 })),
  ]);

  const rawList = listRes.data || [];

  // 批量关联下单用户昵称：单次 in 查询，避免逐条查询（N+1）
  const openids = [...new Set(rawList.map((o) => o._openid).filter(Boolean))];
  let userMap = {};
  if (openids.length > 0) {
    const users = await db
      .collection('users')
      .where({ _openid: command.in(openids) })
      .limit(openids.length)
      .get()
      .catch(() => ({ data: [] }));
    (users.data || []).forEach((u) => {
      if (u && u._openid) userMap[u._openid] = u.nickName || '微信用户';
    });
  }

  const list = rawList.map((o) => {
    const n = normalizeOrder(o);
    return {
      ...n,
      typeText: orderTypeText(n.type),
      userName: userMap[o._openid] || '微信用户',
    };
  });

  // 金额小计按「当前页」统计并明确标注，避免被误读成全量 GMV
  const pagePayableSum = list.reduce((sum, o) => sum + (o.payable || 0), 0);
  const pagePaidSum = list
    .filter((o) => o.status === 'paid' || o.status === 'completed')
    .reduce((sum, o) => sum + (o.payable || 0), 0);

  return ok({
    list,
    items: list,
    total: countRes.total || 0,
    page,
    pageSize,
    pagePayableSum,
    pagePaidSum,
    stats: {
      all: allRes.total || 0,
      pending: pendingRes.total || 0,
      paid: paidRes.total || 0,
      completed: completedRes.total || 0,
      cancelled: cancelledRes.total || 0,
    },
  });
}

/** 订单详情：附下单用户信息（找不到用户也不影响展示） */
async function getOrderDetail(id) {
  if (!id) return fail('缺少订单ID');

  const doc = await db.collection('orders').doc(id).get().catch(() => null);
  const raw = doc && doc.data;
  const o = Array.isArray(raw) ? (raw[0] || null) : (raw || null);
  if (!o) return fail('订单不存在', 404);

  const order = { ...normalizeOrder(o), typeText: orderTypeText(o.type) };

  let user = null;
  if (o._openid) {
    const res = await db.collection('users').where({ _openid: o._openid }).limit(1).get().catch(() => ({ data: [] }));
    const row = (res.data || [])[0];
    if (row) {
      user = {
        _id: row._id,
        nickName: row.nickName || '微信用户',
        avatarUrl: row.avatarUrl || '',
        quizCount: row.quizCount || 0,
        savedPaper: row.savedPaper || 0,
        createTime: row.createTime,
      };
    }
  }

  return ok({ order, user });
}

/**
 * 后台变更订单状态（确认收款 / 标记完成 / 取消）。
 *
 * 合法性由 common.canTransitionOrder 统一判定，与用户端 pay/cancel/confirm 共用同一状态机；
 * 取消订单时把已核销的券退回（与用户端取消行为一致）。
 */
async function updateOrderStatus(id, body) {
  if (!id) return fail('缺少订单ID');

  const target = String(body.status || '');
  if (ADMIN_ORDER_TARGETS.indexOf(target) === -1) {
    return fail('状态不合法（paid 确认收款 / completed 完成 / cancelled 取消）');
  }

  const doc = await db.collection('orders').doc(id).get().catch(() => null);
  const raw = doc && doc.data;
  const o = Array.isArray(raw) ? (raw[0] || null) : (raw || null);
  if (!o) return fail('订单不存在', 404);

  const current = o.status || 'pending';
  if (current === target) {
    return ok({ _id: id, status: target, statusText: orderStatusText(target) }, '状态未变化');
  }
  if (!canTransitionOrder(current, target)) {
    return fail(`订单当前为${orderStatusText(current)}，不能变更为${orderStatusText(target)}`, 409);
  }

  const now = new Date();
  const patch = { status: target, updateTime: now };
  if (target === 'paid') {
    patch.payChannel = 'admin';
    patch.payTime = now;
  }
  if (target === 'completed') patch.completeTime = now;
  if (target === 'cancelled') patch.cancelTime = now;

  await db.collection('orders').doc(id).update({ data: patch });

  // 取消订单回补库存（下单时扣减过，商品可能已删除则忽略）
  if (target === 'cancelled' && Array.isArray(o.items)) {
    for (const it of o.items) {
      const qty = Number(it && it.qty) || 0;
      if (!it || !it.productId || qty <= 0) continue;
      await db.collection('products').doc(it.productId)
        .update({ data: { stock: command.inc(qty) } })
        .catch(() => null);
    }
  }

  // 取消订单退回优惠券（与用户端一致，避免用户白丢券）
  if (target === 'cancelled' && o.couponId) {
    await db.collection('coupons').doc(o.couponId)
      .update({ data: { status: 'unused', useTime: null, updateTime: now } })
      .catch(() => null);
  }

  return ok(
    { _id: id, status: target, statusText: orderStatusText(target) },
    `已更新为${orderStatusText(target)}`
  );
}

// ===== 商品管理 =====

/** 商品分类（value 入库，label 仅用于后台展示与校验提示） */
const PRODUCT_CATEGORIES = {
  tissue: '抽纸',
  pocket: '手帕纸',
  wet: '湿巾',
  other: '其他',
};

/** 上下架状态 */
const PRODUCT_STATUS = { on: '上架', off: '下架' };

/** 批量删除单次上限（防一次请求删除过多数据） */
const PRODUCT_BATCH_LIMIT = 50;

/** 默认商品（首次导入用，与商店内置目录保持一致） */
const DEFAULT_PRODUCTS = [
  { name: '本色抽纸 · 单包', category: 'tissue', price: 300, stock: 200, unit: '包', desc: '100% 原生竹浆本色纸，3 层加厚，单包约 100 抽', tag: '热销', image: '', sort: 10, status: 'on' },
  { name: '本色抽纸 · 3 包装', category: 'tissue', price: 800, stock: 100, unit: '提', desc: '比单包更划算，日常家用首选', tag: '推荐', image: '', sort: 20, status: 'on' },
  { name: '本色抽纸 · 整提 10 包', category: 'tissue', price: 2500, stock: 60, unit: '提', desc: '囤货装，平均每包仅 2.5 元', tag: '超值', image: '', sort: 30, status: 'on' },
  { name: '手帕纸 · 10 小包', category: 'pocket', price: 500, stock: 150, unit: '条', desc: '便携随身装，无香无荧光剂', tag: '', image: '', sort: 40, status: 'on' },
];

/**
 * 商品字段校验（服务端为准，前端仅做即时提示）。
 *
 * 规则：
 * - 名称 2–40 字（必填）
 * - 分类必须是 PRODUCT_CATEGORIES 之一（必填）
 * - 价格按「分」填写，1–100000（即 0.01–1000 元，必填）
 * - 库存 0–999999 整数（必填，0 表示售罄）
 * - 单位 1–4 字（必填）
 * - 描述 ≤100 字、角标 ≤6 字、图片需 https:// 或 cloud:// 开头（均可空）
 * - 状态仅 on/off，排序 0–9999
 */
function validateProductInput(body = {}) {
  const name = String(body.name || '').trim();
  if (name.length < 2) return { ok: false, message: '商品名称至少 2 个字' };
  if (name.length > 40) return { ok: false, message: '商品名称最多 40 个字' };

  const category = String(body.category || '');
  if (!PRODUCT_CATEGORIES[category]) return { ok: false, message: '请选择有效的商品分类' };

  const price = Number(body.price);
  if (!Number.isInteger(price) || price < 1 || price > 100000) {
    return { ok: false, message: '价格需为 0.01–1000 元（按分填写，整数）' };
  }

  const stock = Number(body.stock);
  if (!Number.isInteger(stock) || stock < 0 || stock > 999999) {
    return { ok: false, message: '库存需为 0–999999 的整数' };
  }

  const unit = String(body.unit || '').trim();
  if (!unit || unit.length > 4) return { ok: false, message: '单位必填，最多 4 个字' };

  const desc = String(body.desc || '').trim();
  if (desc.length > 100) return { ok: false, message: '商品描述最多 100 个字' };

  const tag = String(body.tag || '').trim();
  if (tag.length > 6) return { ok: false, message: '角标最多 6 个字' };

  const image = String(body.image || '').trim();
  if (image && image.indexOf('https://') !== 0 && image.indexOf('cloud://') !== 0) {
    return { ok: false, message: '图片需为 https:// 或 cloud:// 开头的地址' };
  }
  if (image.length > 500) return { ok: false, message: '图片地址过长（最多 500 字符）' };

  const status = String(body.status || 'on');
  if (!PRODUCT_STATUS[status]) return { ok: false, message: '状态需为上架(on)或下架(off)' };

  const sort = body.sort === undefined || body.sort === '' ? 0 : Number(body.sort);
  if (!Number.isInteger(sort) || sort < 0 || sort > 9999) {
    return { ok: false, message: '排序需为 0–9999 的整数' };
  }

  return {
    ok: true,
    value: { name, category, price, stock, unit, desc, tag, image, status, sort },
  };
}

/** 商品列表：按名称/描述检索 + 分类/状态筛选 + 分页 + 统计 */
async function listProducts(query) {
  const { page, pageSize } = parsePaging(query);
  const conds = [];

  const keyword = String(query.keyword || '').trim();
  if (keyword) {
    const re = db.RegExp({ regexp: escapeRegExp(keyword), options: 'i' });
    conds.push(command.or([{ name: re }, { desc: re }]));
  }
  if (query.category && PRODUCT_CATEGORIES[query.category]) conds.push({ category: query.category });
  if (query.status && PRODUCT_STATUS[query.status]) conds.push({ status: query.status });

  const cond = conds.length === 0 ? null : (conds.length === 1 ? conds[0] : command.and(conds));
  const col = db.collection('products');
  const base = cond ? col.where(cond) : col;
  const offset = (page - 1) * pageSize;

  const pageQuery = offset > 0
    ? base.orderBy('sort', 'asc').orderBy('createTime', 'desc').skip(offset).limit(pageSize)
    : base.orderBy('sort', 'asc').orderBy('createTime', 'desc').limit(pageSize);

  const [listRes, countRes, allRes, onRes, offRes] = await Promise.all([
    pageQuery.get().catch(() => ({ data: [] })),
    base.count().catch(() => ({ total: 0 })),
    col.count().catch(() => ({ total: 0 })),
    col.where({ status: 'on' }).count().catch(() => ({ total: 0 })),
    col.where({ status: 'off' }).count().catch(() => ({ total: 0 })),
  ]);

  const list = (listRes.data || []).map((p) => ({
    ...p,
    categoryText: PRODUCT_CATEGORIES[p.category] || '未分类',
    statusText: PRODUCT_STATUS[p.status] || '未知',
    // 库存告警：0 为售罄，≤10 为紧张
    stockState: Number(p.stock) === 0 ? 'out' : (Number(p.stock) <= 10 ? 'low' : 'ok'),
  }));

  return ok({
    list,
    items: list,
    total: countRes.total || 0,
    page,
    pageSize,
    stats: {
      all: allRes.total || 0,
      on: onRes.total || 0,
      off: offRes.total || 0,
      lowStock: list.filter((p) => p.stockState !== 'ok').length,
    },
    categories: Object.keys(PRODUCT_CATEGORIES).map((k) => ({ value: k, label: PRODUCT_CATEGORIES[k] })),
  });
}

/** 新增商品 */
async function createProduct(body) {
  const v = validateProductInput(body);
  if (!v.ok) return fail(v.message);

  const now = new Date();
  const created = await db.collection('products').add({ data: {
    ...v.value,
    createTime: now,
    updateTime: now,
  } });

  return ok({ _id: created._id }, '商品已添加');
}

/** 编辑商品（全字段覆盖，含上下架状态） */
async function updateProduct(id, body) {
  if (!id) return fail('缺少商品ID');

  const doc = await db.collection('products').doc(id).get().catch(() => null);
  const raw = doc && doc.data;
  const exists = Array.isArray(raw) ? (raw[0] || null) : (raw || null);
  if (!exists) return fail('商品不存在', 404);

  const v = validateProductInput(body);
  if (!v.ok) return fail(v.message);

  await db.collection('products').doc(id).update({ data: { ...v.value, updateTime: new Date() } });
  return ok({ _id: id }, '商品已更新');
}

/** 上下架快捷切换 */
async function toggleProductStatus(id, body) {
  if (!id) return fail('缺少商品ID');

  const status = String((body && body.status) || '');
  if (!PRODUCT_STATUS[status]) return fail('状态需为上架(on)或下架(off)');

  const doc = await db.collection('products').doc(id).get().catch(() => null);
  const raw = doc && doc.data;
  const exists = Array.isArray(raw) ? (raw[0] || null) : (raw || null);
  if (!exists) return fail('商品不存在', 404);

  await db.collection('products').doc(id).update({ data: { status, updateTime: new Date() } });
  return ok({ _id: id, status }, status === 'on' ? '已上架' : '已下架');
}

/** 删除单个商品 */
async function deleteProduct(id) {
  if (!id) return fail('缺少商品ID');

  const doc = await db.collection('products').doc(id).get().catch(() => null);
  const raw = doc && doc.data;
  const exists = Array.isArray(raw) ? (raw[0] || null) : (raw || null);
  if (!exists) return fail('商品不存在', 404);

  await db.collection('products').doc(id).remove();
  return ok({ _id: id }, '商品已删除');
}

/** 批量删除（上限 50，自动去重） */
async function batchDeleteProducts(body) {
  const input = Array.isArray(body && body.ids) ? body.ids : [];
  const ids = [...new Set(input.map((x) => String(x || '').trim()).filter(Boolean))];

  if (ids.length === 0) return fail('请先选择要删除的商品');
  if (ids.length > PRODUCT_BATCH_LIMIT) return fail(`单次最多删除 ${PRODUCT_BATCH_LIMIT} 个商品`);

  const removed = await db.collection('products')
    .where({ _id: command.in(ids) })
    .remove()
    .catch(() => ({ stats: { removed: 0 } }));

  const count = (removed && removed.stats && removed.stats.removed) || 0;
  if (count === 0) return fail('所选商品不存在或已被删除', 404);

  return ok({ removed: count }, `已删除 ${count} 个商品`);
}

/** 首次导入默认商品（已有商品时拒绝，避免重复导入） */
async function seedProducts() {
  const existing = await db.collection('products').count().catch(() => ({ total: 0 }));
  if ((existing.total || 0) > 0) {
    return fail('商品库已有数据，无需导入默认商品');
  }

  const now = new Date();
  for (const p of DEFAULT_PRODUCTS) {
    await db.collection('products').add({ data: { ...p, createTime: now, updateTime: now } });
  }
  return ok({ count: DEFAULT_PRODUCTS.length }, `已导入 ${DEFAULT_PRODUCTS.length} 个默认商品`);
}

/** 路由表：METHOD PATH → handler */
const ROUTES = [
  ['POST', /^\/api\/auth\/admin\/login$/, (ctx) => login(ctx.body)],
  ['GET', /^\/api\/admin\/dashboard\/stats$/, () => getDashboardStats()],
  ['GET', /^\/api\/admin\/users$/, (ctx) => listUsers(ctx.query)],
  ['GET', /^\/api\/admin\/users\/([^/]+)$/, (ctx) => getUserDetail(ctx.params[0])],
  ['GET', /^\/api\/admin\/coupons$/, (ctx) => listCoupons(ctx.query)],
  ['POST', /^\/api\/admin\/coupons$/, (ctx) => createCoupon(ctx.body)],
  ['DELETE', /^\/api\/admin\/coupons\/([^/]+)$/, (ctx) => deleteCoupon(ctx.params[0])],
  ['GET', /^\/api\/admin\/products$/, (ctx) => listProducts(ctx.query)],
  ['POST', /^\/api\/admin\/products$/, (ctx) => createProduct(ctx.body)],
  ['POST', /^\/api\/admin\/products\/seed$/, () => seedProducts()],
  ['POST', /^\/api\/admin\/products\/batch-delete$/, (ctx) => batchDeleteProducts(ctx.body)],
  ['PUT', /^\/api\/admin\/products\/([^/]+)$/, (ctx) => updateProduct(ctx.params[0], ctx.body)],
  ['POST', /^\/api\/admin\/products\/([^/]+)\/status$/, (ctx) => toggleProductStatus(ctx.params[0], ctx.body)],
  ['DELETE', /^\/api\/admin\/products\/([^/]+)$/, (ctx) => deleteProduct(ctx.params[0])],
  ['GET', /^\/api\/admin\/quiz-records$/, (ctx) => listQuizRecords(ctx.query)],
  ['GET', /^\/api\/admin\/quiz-records\/stats$/, () => getQuizRecordStats()],
  ['GET', /^\/api\/admin\/orders$/, (ctx) => listOrders(ctx.query)],
  ['GET', /^\/api\/admin\/orders\/([^/]+)$/, (ctx) => getOrderDetail(ctx.params[0])],
  ['PUT', /^\/api\/admin\/orders\/([^/]+)$/, (ctx) => updateOrderStatus(ctx.params[0], ctx.body)],
  ['GET', /^\/api\/admin\/feedback$/, (ctx) => listFeedback(ctx.query)],
  // 统计路由必须放在 /feedback/:id 之前，否则会被 ([^/]+) 当成 id 吞掉
  ['GET', /^\/api\/admin\/feedback\/stats$/, () => getFeedbackStats()],
  ['GET', /^\/api\/admin\/feedback\/([^/]+)$/, (ctx) => getFeedbackDetail(ctx.params[0])],
  ['PUT', /^\/api\/admin\/feedback\/([^/]+)$/, (ctx) => updateFeedback(ctx.params[0], ctx.body)],
  ['DELETE', /^\/api\/admin\/feedback\/([^/]+)$/, (ctx) => deleteFeedback(ctx.params[0])],
  ['GET', /^\/api\/admin\/questions$/, (ctx) => listQuestions(ctx.query)],
  ['GET', /^\/api\/admin\/diagnostics$/, () => runDiagnostics()],
  ['POST', /^\/api\/admin\/questions$/, (ctx) => createQuestion(ctx.body)],
  // 批量/导出路由放在通用 id 路由之前，避免被 ([^/]+) 吞掉
  ['GET', /^\/api\/admin\/questions\/export$/, (ctx) => exportQuestions(ctx.query)],
  ['POST', /^\/api\/admin\/questions\/batch-delete$/, (ctx) => batchDeleteQuestions(ctx.body)],
  ['POST', /^\/api\/admin\/questions\/import$/, (ctx) => importQuestions(ctx.body)],
  ['PUT', /^\/api\/admin\/questions\/([^/]+)$/, (ctx) => updateQuestion(ctx.params[0], ctx.body)],
  ['DELETE', /^\/api\/admin\/questions\/([^/]+)$/, (ctx) => deleteQuestion(ctx.params[0])],
];

/** CORS 响应头：管理后台为静态页面，浏览器跨域调用必需 */
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

/**
 * HTTP 访问服务入口。
 *
 * 平台会传入 event.httpMethod / event.path / event.headers / event.body，
 * 不同版本字段略有差异，这里做兼容。
 */

/**
 * 构造 HTTP 集成响应。
 *
 * 关键修复：HTTP 访问服务的集成响应要求 body 必须是「字符串」。
 * 此前直接把信封对象展开在返回值里（{statusCode, success, message, data}），
 * 平台无法将其序列化为响应体——实测所有响应 body 均为空（content-length: 0），
 * 前端 res.json() 解析空串抛异常，页面全部显示「网络错误」。
 * 现统一走 { statusCode, headers, body: JSON.stringify(...) } 标准格式。
 */
function httpResponse(statusCode, payload) {
  return {
    statusCode,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload),
  };
}

exports.main = async (event = {}) => {
  const method = (event.httpMethod || event.requestContext?.http?.method || 'GET').toUpperCase();
  let path = event.path || event.requestContext?.http?.path || event.rawPath || '/';

  // 防御：个别网关会把查询串拼进 path，先剥离再匹配路由
  if (path.indexOf('?') !== -1) {
    path = path.slice(0, path.indexOf('?'));
  }

  // HTTP 访问服务配置了 /admin 路由前缀：剥掉前缀再匹配内部路由表。
  // 兼容平台是否把前缀传进 event——有则剥，无则原样。
  const ROUTE_PREFIX = '/admin';
  if (path.startsWith(ROUTE_PREFIX)) {
    path = path.slice(ROUTE_PREFIX.length) || '/';
  }

  // 浏览器预检请求直接放行
  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS };
  }

  let query = event.query || event.queryStringParameters || {};
  if (typeof query === 'string') {
    query = Object.fromEntries(new URLSearchParams(query));
  }

  let body = event.body;
  if (typeof body === 'string') {
    // HTTP 访问服务可能以 base64 投递请求体
    if (event.isBase64Encoded) {
      body = Buffer.from(body, 'base64').toString('utf8');
    }
    const raw = body.trim();
    // 关键修复：GET 等无请求体的请求，平台传空字符串 ""——
    // 旧实现直接 JSON.parse('') 抛错，导致所有 GET 接口一律 400「请求体不是合法 JSON」。
    if (raw === '') {
      body = {};
    } else {
      try {
        body = JSON.parse(raw);
      } catch (err) {
        return httpResponse(400, fail('请求体不是合法 JSON'));
      }
    }
  }
  body = body || {};

  // 登录接口免鉴权
  if (path === '/api/auth/admin/login' && method === 'POST') {
    const result = await login(body);
    return httpResponse(result.success ? 200 : 401, result);
  }

  const authorized = await authenticate(event.headers || {});
  if (!authorized) {
    return httpResponse(401, fail('未授权或登录已过期', 401));
  }

  for (const [m, pattern, handler] of ROUTES) {
    if (m !== method) continue;
    const matched = path.match(pattern);
    if (!matched) continue;

    try {
      const result = await handler({ body, query, params: matched.slice(1) });
      return httpResponse(result.success === false ? (result.code || 400) : 200, result);
    } catch (err) {
      console.error(`[${method} ${path}] 处理异常`, err);
      return httpResponse(500, fail('服务器内部错误', 500));
    }
  }

  return httpResponse(404, fail('接口不存在', 404));
};