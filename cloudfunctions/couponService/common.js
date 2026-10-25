/**
 * 智惠本草 · 云函数公共库
 *
 * 所有业务云函数共用。解决自建后端时期的三个遗留问题：
 *   1. _openid 从不写入 → 用户数据全线失效
 *   2. success 与 HTTP 状态码不一致 → 客户端误判
 *   3. 客户端传入的 correctCount 可伪造 → 发券被绕过
 */

const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const command = db.command;

/** 统一响应信封 */
function ok(data = null, message = 'success') {
  return { success: true, message, data };
}

function fail(message, code = -1) {
  return { success: false, message, data: null, code };
}

/**
 * 获取当前调用者的 OPENID。
 *
 * 云函数中 getWXContext().OPENID 由微信服务端注入，客户端无法伪造，
 * 因此不再需要 JWT 登录态，也彻底解决了 _openid 写入问题。
 */
function requireOpenid(ctx) {
  const openid = ctx?.OPENID;
  if (!openid) {
    throw new BizError('无法获取用户身份', 401);
  }
  return openid;
}

/** 业务异常 */
class BizError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

/**
 * 按 OPENID 查询用户，不存在则创建。
 *
 * 关键修复：显式写入 _openid。
 * 旧实现建用户时漏写该字段，导致后续所有 where({_openid}) 查询失效、
 * 每次登录都插入重复行、统计恒为 0、资料页直接报错。
 */
async function findOrCreateUser(openid, defaults = {}) {
  const collection = db.collection('users');

  const existing = await collection.where({ _openid: openid }).limit(1).get();

  if (existing.data && existing.data.length > 0) {
    return existing.data[0];
  }

  const now = new Date();
  const newUser = {
    _openid: openid,               // ← 修复：显式写入，旧实现缺失
    nickName: defaults.nickName || '微信用户',
    avatarUrl: defaults.avatarUrl || '',
    savedPaper: 0,
    quizCount: 0,
    createTime: now,
    updateTime: now,
  };

  const result = await collection.add({ data: newUser });
  return { _id: result._id, ...newUser };
}

/** 原子自增，避免旧实现的「读-改-写」竞态 */
async function incrementUserStat(openid, field, delta = 1) {
  const result = await db
    .collection('users')
    .where({ _openid: openid })
    .update({ data: { [field]: command.inc(delta), updateTime: new Date() } })
    .catch(() => null);

  // 用户行不存在时补建后再自增，避免静默失败
  if (!result || result.stats?.updated === 0) {
    await findOrCreateUser(openid);
    await db
      .collection('users')
      .where({ _openid: openid })
      .update({ data: { [field]: command.inc(delta), updateTime: new Date() } });
  }
}

/**
 * 统一入口包装：把 action 分发与异常处理收在一处，
 * 避免每个云函数重复写 try/catch。
 */
function createHandler(actionMap) {
  return async (event = {}) => {
    const { action } = event;

    try {
      const ctx = cloud.getWXContext();
      const handler = actionMap[action];

      if (!handler) {
        return fail(`未知操作: ${action || '(空)'}`);
      }

      const data = await handler(event, ctx);
      return ok(data);
    } catch (err) {
      if (err instanceof BizError) {
        return fail(err.message, err.statusCode);
      }

      console.error(`[${action}] 执行异常`, err);
      return fail('服务异常，请稍后重试', -500);
    }
  };
}

/**
 * 答案下标规范化：兼容旧数据（单个数字）与多选题（下标数组）。
 *
 * 返回去重、升序的非负整数数组；输入非法时返回空数组。
 * 下标上限 99，防构造超大数组刷写入。
 */
function toIndexArray(value) {
  const MAX_INDEX = 99;
  if (Array.isArray(value)) {
    return [...new Set(
      value
        .map((n) => Number(n))
        .filter((n) => Number.isInteger(n) && n >= 0 && n <= MAX_INDEX)
    )].sort((a, b) => a - b);
  }
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= MAX_INDEX ? [n] : [];
}

/** 集合相等比较（用于多选题判卷）：长度一致且逐项相同 */
function sameIndexSet(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((v, i) => Number(v) === Number(b[i]));
}

/** 券类型：库内可能存机器码（paper/shopping）或中文标签，统一归一为中文标签展示 */
const COUPON_TYPE_LABELS = {
  paper: '领纸券',
  shopping: '购物券',
  shop: '购物券',
  discount: '优惠券',
};
function couponTypeLabel(type) {
  if (!type) return '领纸券';
  return COUPON_TYPE_LABELS[type] || type;
}

/**
 * 答题会话推进（纯函数，便于单测）。
 *
 * 会话状态挂在用户文档上，用于支持「切到首页/我的再回来继续答题」：
 * - 距上次答题超过 idleMs 视为新一轮，累计答对数与已答题目列表清零
 * - 同一题重复提交不再累加（防重放 / 重复点击）
 * - **答错不清零**：本机制按「本次累计答对」计数，与旧的「连续答对」不同
 *
 * prev: { correct, answeredIds, updatedAt }
 * 返回 { correct, answeredIds, updatedAt, isNewSession, duplicated }
 */
function advanceQuizSession(prev, opts = {}) {
  const idleMs = opts.idleMs || 30 * 60 * 1000;
  const maxIds = opts.maxIds || 500;
  const now = opts.now || Date.now();
  const isCorrect = !!opts.isCorrect;
  const questionId = opts.questionId ? String(opts.questionId) : '';

  const prevUpdated = prev && prev.updatedAt ? new Date(prev.updatedAt).getTime() : 0;
  const isNewSession = !prevUpdated || (now - prevUpdated) > idleMs;

  let correct = isNewSession ? 0 : Number(prev.correct) || 0;
  let answeredIds = isNewSession
    ? []
    : (Array.isArray(prev.answeredIds) ? prev.answeredIds.slice() : []);

  let duplicated = false;
  if (questionId && answeredIds.indexOf(questionId) !== -1) {
    duplicated = true;
  } else {
    if (isCorrect) correct += 1;
    if (questionId) {
      answeredIds.push(questionId);
      // 长会话下限制列表长度，避免文档无限膨胀
      if (answeredIds.length > maxIds) answeredIds = answeredIds.slice(-maxIds);
    }
  }

  return { correct, answeredIds, updatedAt: new Date(now), isNewSession, duplicated };
}

/**
 * 按权重随机取一项（纯函数，便于单测）。
 *
 * items: [{ weight, ... }]，权重需为正数；
 * rand: 可选的随机源（返回 0~1），默认 Math.random——单测可传固定值验证边界。
 */
function pickWeighted(items, rand) {
  const list = Array.isArray(items)
    ? items.filter((i) => i && Number(i.weight) > 0)
    : [];
  if (list.length === 0) return null;

  const total = list.reduce((sum, i) => sum + Number(i.weight), 0);
  const r = typeof rand === 'function' ? Number(rand()) : Math.random();
  let roll = (isNaN(r) ? 0 : Math.min(Math.max(r, 0), 0.999999)) * total;

  for (const item of list) {
    roll -= Number(item.weight);
    if (roll < 0) return item;
  }
  return list[list.length - 1];
}

/**
 * 答题轮次状态（纯函数，便于单测）。
 *
 * 规则：每轮限时 durationMs，期间持续出题；答对达到 targetCorrect 即达标结束。
 * 两种结束条件：时间到（expired）或答对达标（reached）。
 *
 * session: { startAt, correct }；now 可注入便于测试。
 * 返回 { active, expired, reached, finished, remainingMs, correct, targetCorrect }
 */
function quizRoundState(session, opts = {}) {
  const durationMs = opts.durationMs || 2 * 60 * 1000;
  const targetCorrect = opts.targetCorrect || 5;
  const now = opts.now || Date.now();

  const src = session || {};
  const startedAt = src.startAt ? new Date(src.startAt).getTime() : 0;
  const active = !!startedAt && !isNaN(startedAt);
  const correct = Number(src.correct) || 0;

  const elapsed = active ? Math.max(now - startedAt, 0) : 0;
  const remainingMs = active ? Math.max(durationMs - elapsed, 0) : durationMs;
  const expired = active && elapsed >= durationMs;
  const reached = correct >= targetCorrect;

  return {
    active,
    expired,
    reached,
    finished: active && (expired || reached),
    remainingMs,
    correct,
    targetCorrect,
  };
}

/**
 * 商店订单金额计算（纯函数，便于单测）。
 *
 * items: [{ productId, qty }]
 * catalog: [{ id, name, price(分), unit }]
 * couponType: 券类型（兼容 paper/领纸券 等写法，经 couponTypeLabel 归一）
 *
 * 优惠规则：
 * - 领纸券（免费券）：免单 1 件（取单价最低的一件）
 * - 优惠券（买2送1）：每满 3 件免 1 件
 * - 购物券（8折）：整单 8 折
 * 金额单位统一为「分」。
 */
function calcShopOrder(items, catalog, couponType) {
  const list = Array.isArray(catalog) ? catalog : [];
  const priceMap = {};
  list.forEach((p) => { if (p && p.id) priceMap[p.id] = p; });

  const lines = [];
  let subtotal = 0;
  for (const item of (Array.isArray(items) ? items : [])) {
    const product = priceMap[item && item.productId];
    const qty = Math.max(parseInt(item && item.qty, 10) || 0, 0);
    if (!product || qty <= 0) continue;
    const amount = Number(product.price) * qty;
    subtotal += amount;
    lines.push({
      productId: product.id,
      name: product.name,
      unit: product.unit || '件',
      price: Number(product.price),
      qty,
      amount,
    });
  }

  if (lines.length === 0) {
    return { ok: false, reason: '请先选择商品', lines: [], subtotal: 0, discount: 0, payable: 0, freeQty: 0, couponLabel: '' };
  }

  const label = couponType ? couponTypeLabel(couponType) : '';
  let discount = 0;
  let freeQty = 0;

  if (label === '领纸券') {
    const cheapest = lines.reduce((min, l) => (l.price < min.price ? l : min), lines[0]);
    discount = cheapest.price;
    freeQty = 1;
  } else if (label === '优惠券') {
    // 买2送1：每满 3 件免 1 件
    for (const l of lines) {
      const free = Math.floor(l.qty / 3);
      freeQty += free;
      discount += free * l.price;
    }
  } else if (label === '购物券') {
    // 8 折：优惠 20%
    discount = Math.round(subtotal * 0.2);
  }

  discount = Math.min(discount, subtotal);

  return {
    ok: true,
    lines,
    subtotal,
    discount,
    payable: subtotal - discount,
    freeQty,
    couponLabel: label,
  };
}

/**
 * 订单状态机（纯函数，便于单测）。
 *
 * 状态流转：
 *   pending(待付款)  → paid(已付款) / cancelled(已取消)
 *   paid(已付款)     → completed(已完成)          ← 确认取货
 *   pending          → failed(取纸失败)            ← 仅取纸机
 *   completed / cancelled / failed 为终态
 *
 * 免单订单（应付 0）下单即 completed，不经过 pending。
 */
const ORDER_STATUS_TEXT = {
  pending: '待付款',
  paid: '已付款',
  completed: '已完成',
  cancelled: '已取消',
  failed: '已失败',
};

const ORDER_STATUS_FLOW = {
  pending: ['paid', 'cancelled', 'failed'],
  paid: ['completed'],
  completed: [],
  cancelled: [],
  failed: [],
};

function orderStatusText(status) {
  return ORDER_STATUS_TEXT[status] || '未知状态';
}

/** 是否允许从 from 流转到 to */
function canTransitionOrder(from, to) {
  const allowed = ORDER_STATUS_FLOW[from];
  return Array.isArray(allowed) && allowed.indexOf(to) !== -1;
}

/** 订单是否处于终态（不可再流转） */
function isOrderClosed(status) {
  return ['completed', 'cancelled', 'failed'].indexOf(status) !== -1;
}

/**
 * 订单归一化：把库内两种形态（取纸机订单 / 商店订单）统一成同一结构返回给前端。
 * 金额单位统一为「分」，时间统一为 ISO 字符串（前端负责格式化）。
 */
function normalizeOrder(o) {
  const order = o || {};
  const payable = Number(order.payable !== undefined ? order.payable : (order.actualPay || 0));
  const subtotal = Number(order.subtotal !== undefined ? order.subtotal : (order.amount || 0));
  const items = Array.isArray(order.items) && order.items.length > 0
    ? order.items
    : [{ name: order.title || '自助取纸', unit: '件', price: subtotal, qty: 1, amount: subtotal }];

  return {
    _id: order._id,
    orderSn: order.orderSn || '',
    type: order.type || 'paper',
    title: order.title || items[0].name || '订单',
    items,
    itemCount: items.reduce((sum, it) => sum + (Number(it.qty) || 0), 0),
    subtotal,
    discount: Number(order.discount || 0),
    payable,
    couponId: order.couponId || null,
    couponLabel: order.couponLabel || '',
    status: order.status || 'pending',
    statusText: orderStatusText(order.status),
    payChannel: order.payChannel || '',
    paidAt: order.payTime || null,
    completedAt: order.completeTime || null,
    cancelledAt: order.cancelTime || null,
    failReason: order.failReason || '',
    fulfillment: order.fulfillment || (order.deviceId ? 'device' : 'pickup'),
    deviceId: order.deviceId || null,
    createTime: order.createTime || null,
    updateTime: order.updateTime || null,
  };
}

module.exports = {
  cloud,
  db,
  command,
  ok,
  fail,
  BizError,
  requireOpenid,
  toIndexArray,
  sameIndexSet,
  couponTypeLabel,
  pickWeighted,
  advanceQuizSession,
  quizRoundState,
  calcShopOrder,
  ORDER_STATUS_TEXT,
  orderStatusText,
  canTransitionOrder,
  isOrderClosed,
  normalizeOrder,
  findOrCreateUser,
  incrementUserStat,
  createHandler,
};