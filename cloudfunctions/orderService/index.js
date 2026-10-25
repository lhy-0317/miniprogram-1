/**
 * 订单服务 · 云函数
 *
 * action:
 *   create  POST 创建订单（券模式直接完成；付费模式走微信支付预下单）
 *   status  GET  轮询订单状态
 *   notify  POST 微信支付回调（需由 HTTP 访问服务转发）
 *
 * 相对旧后端的关键修复：
 *   1. 免费券路径不再「只置 paid 就返回」，而是完整推进到 completed
 *   2. 支付回调实现真实验签 + AES-256-GCM 解密 + 金额比对
 *   3. 券核销与订单创建绑定，失败时回滚券
 *   4. savedPaper 增量只在出纸完成时写入一次，不在 GET 轮询里累加
 *
 * ⚠️ 云函数之间无法互相 require，扣库存逻辑在本地实现一份。
 *    接入真实硬件后，由云托管 MQTT 网关统一扣减。
 */

const crypto = require('crypto');
const https = require('https');
const {
  db,
  command,
  BizError,
  couponTypeLabel,
  calcShopOrder,
  ORDER_STATUS_TEXT,
  orderStatusText,
  canTransitionOrder,
  normalizeOrder,
  requireOpenid,
  findOrCreateUser,
  incrementUserStat,
  createHandler,
} = require('./common');

/** 单份纸巾价格，单位：分 */
const PAPER_PRICE = 50;

/**
 * 商店商品目录（自营纸巾）。
 *
 * 价格单位为「分」，与服务端 PAPER_PRICE 保持一致。
 * 现阶段为常量配置（改动需重新部署）；后续要支持后台维护可迁到 products 集合。
 * 「首页商店」改造前，取纸机扫码流程用的是 PAPER_PRICE 单规格，这里独立成目录。
 */
const SHOP_PRODUCTS = [
  { id: 'tissue-natural-1', name: '本色抽纸 · 单包', unit: '包', price: 300, desc: '100% 原生竹浆本色纸，3 层加厚，单包约 100 抽', tag: '热销' },
  { id: 'tissue-natural-3', name: '本色抽纸 · 3 包装', unit: '提', price: 800, desc: '比单包更划算，日常家用首选', tag: '推荐' },
  { id: 'tissue-natural-10', name: '本色抽纸 · 整提 10 包', unit: '提', price: 2500, desc: '囤货装，平均每包仅 2.5 元', tag: '超值' },
  { id: 'tissue-pocket-10', name: '手帕纸 · 10 小包', unit: '条', price: 500, desc: '便携随身装，无香无荧光剂', tag: '' },
];

/**
 * 支付配置。
 * ⚠️ 上线前在云开发控制台配置环境变量，勿将密钥写入代码。
 */
const PAY = {
  appId: process.env.WECHAT_APPID || 'wx935c1756480d5f27',
  mchId: process.env.WECHAT_PAY_MCHID || '',
  apiV3Key: process.env.WECHAT_PAY_API_V3_KEY || '',
  serialNo: process.env.WECHAT_PAY_SERIAL_NO || '',
  privateKey: process.env.WECHAT_PAY_PRIVATE_KEY || '',
  platformCert: process.env.WECHAT_PAY_PLATFORM_CERT || '',
  notifyUrl: process.env.WECHAT_PAY_NOTIFY_URL || '',
};

const IS_PAY_ENABLED = Boolean(PAY.mchId && PAY.apiV3Key && PAY.privateKey);

function generateOrderSn() {
  const now = new Date();
  const d = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  // 修复：旧实现仅 4 位十进制（每天 1 万种可能）且 % 10000 有模偏差。
  // 回调按 orderSn 查单，撞号会把支付记到别人订单上。改为 8 位 hex（每天约 42.9 亿种），取自密码学随机源。
  return `ZHB${d}${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

function nonceStr(len = 32) {
  return crypto.randomBytes(len).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, len);
}

function isExpired(expireDate) {
  if (!expireDate) return false;
  return new Date(`${expireDate}T23:59:59`).getTime() < Date.now();
}

/**
 * 扣减设备余纸量，不足返回 false。
 *
 * 修复：旧实现是「读-算-写回」，两个并发订单都读到库存 1 便都扣成功（超卖）。
 * 改为单条原子条件更新：仅当 paperStock >= qty 时扣减才生效，由数据库裁决，无竞态。
 */
async function consumePaper(deviceId, qty = 1) {
  const result = await db.collection('devices').where({ deviceId }).limit(1).get();
  if (!result.data || result.data.length === 0) return true; // 未登记设备不阻断演示

  const updateResult = await db
    .collection('devices')
    .where({ deviceId, paperStock: command.gte(qty) })
    .update({ data: { paperStock: command.inc(-qty), updateTime: new Date() } });

  return Boolean(updateResult.stats && updateResult.stats.updated > 0);
}

/** 下单频控：单用户每分钟最多 5 单（防脚本刷写） */
async function checkOrderRateLimit(openid) {
  const oneMinuteAgo = new Date(Date.now() - 60 * 1000);
  const recent = await db
    .collection('orders')
    .where({ _openid: openid, createTime: command.gte(oneMinuteAgo) })
    .count()
    .catch(() => ({ total: 0 }));

  if ((recent.total || 0) >= 5) {
    throw new BizError('操作过于频繁，请稍后再试', 429);
  }
}

async function createOrder(event, ctx) {
  const openid = requireOpenid(ctx);
  const { deviceId, couponId } = event;

  if (!deviceId) throw new BizError('缺少设备ID');

  await checkOrderRateLimit(openid);
  await findOrCreateUser(openid);

  let actualPay = PAPER_PRICE;

  if (couponId) {
    // doc().get() 返回 {data: 文档对象}（非数组），查不到时抛错——统一兜底
    const doc = await db.collection('coupons').doc(couponId).get().catch(() => null);
    const raw = doc && doc.data;
    const coupon = Array.isArray(raw) ? (raw[0] || null) : (raw || null);

    if (!coupon) throw new BizError('优惠券不存在', 404);
    if (coupon._openid !== openid) throw new BizError('无权使用此优惠券', 403);
    if (coupon.status !== 'unused') throw new BizError('优惠券已使用或已过期');

    // 修复①：旧实现只判断「有没有券」，买2送1/8折 也一律免单
    // 修复②：库内券类型有 'paper'（旧）与中文标签（题库/后台发放）两种写法，
    //        直接比对 'paper' 会认不出中文标签，导致答题获得的免费券无法取纸。
    if (couponTypeLabel(coupon.type) !== '领纸券') {
      throw new BizError('该券不适用于本次取纸');
    }
    if (isExpired(coupon.expireDate)) throw new BizError('优惠券已过期');

    // 条件更新防双花：仅当 status 仍为 unused 才核销
    const claimed = await db
      .collection('coupons')
      .where({ _id: couponId, _openid: openid, status: 'unused' })
      .update({ data: { status: 'used', useTime: new Date() } });

    if (!claimed.stats || claimed.stats.updated === 0) {
      throw new BizError('优惠券已被使用，请刷新后重试', 409);
    }

    actualPay = 0;
  }

  const orderSn = generateOrderSn();
  const created = await db.collection('orders').add({ data: {
    orderSn,
    _openid: openid,
    // ===== 统一订单模型（与商店订单同构）=====
    type: 'paper',
    title: couponId ? '免费领纸 · 答题得券' : '自助扫码取纸',
    items: [{ name: '本色抽纸 · 单包', unit: '包', price: PAPER_PRICE, qty: 1, amount: PAPER_PRICE }],
    subtotal: PAPER_PRICE,
    discount: PAPER_PRICE - actualPay,
    payable: actualPay,
    couponLabel: couponId ? couponTypeLabel(couponType) : '',
    fulfillment: 'device',
    deviceId,
    couponId: couponId || null,
    // 兼容既有字段命名
    amount: PAPER_PRICE,
    actualPay,
    status: 'pending',
    createTime: new Date(),
    updateTime: new Date(),
  } });
  const orderId = created._id;

  // 券模式：完整走完出纸，不再停在 paid
  if (actualPay === 0) {
    const result = await completeDispense(orderId, orderSn, openid, deviceId, 0);

    // 修复：旧实现缺纸失败时不退券——订单 failed、券已核销，用户白丢一张券。
    // 出纸失败即恢复券为未使用（订单保留 failed 记录便于对账）。
    if (result.status === 'failed') {
      await restoreCoupon(couponId);
    }

    // 失败原因透出给前端，客户端可即时提示，无需进入轮询
    return {
      orderId,
      orderSn,
      amount: PAPER_PRICE,
      actualPay: 0,
      free: true,
      status: result.status,
      failReason: result.reason || '',
    };
  }

  if (!IS_PAY_ENABLED) {
    await rollback(orderId, couponId);
    throw new BizError('支付功能尚未启用，请使用免费领纸券（可联系管理员发放）', 503);
  }

  try {
    const prepay = await createPrepay(orderSn, actualPay, openid);
    await db.collection('orders').doc(orderId).update({ data: { wechatPrepayId: prepay.prepayId } });
    return { orderId, orderSn, amount: PAPER_PRICE, actualPay, free: false, status: 'pending', prepayParams: prepay };
  } catch (err) {
    console.error('预下单失败', err);
    await rollback(orderId, couponId);
    throw new BizError('支付下单失败，请稍后重试', 500);
  }
}

/**
 * 完成出纸。
 *
 * 本期未接硬件：扣减库存后直接置 completed 并写使用记录。
 * 接入硬件后改为写入 dispense_tasks 队列，由云托管 MQTT 网关消费，
 * 并等待设备 ACK 后再置终态。
 */
async function completeDispense(orderId, orderSn, openid, deviceId, amount) {
  const hasStock = await consumePaper(deviceId, 1);

  if (!hasStock) {
    await db.collection('orders').doc(orderId).update({ data: {
      status: 'failed',
      failReason: '设备纸张不足，请联系管理员',
      completeTime: new Date(),
    } });
    return { status: 'failed', reason: '设备纸张不足，请联系管理员' };
  }

  const now = new Date();

  await db.collection('orders').doc(orderId).update({ data: {
    status: 'completed',
    payTime: now,
    completeTime: now,
  } });

  await db.collection('usage_records').add({ data: {
    _openid: openid,
    deviceId,
    orderSn,
    isFree: amount === 0,
    paperCount: 1,
    createTime: now,
  } });

  // 修复：savedPaper 只在此处原子 +1 一次。
  // 旧实现在 GET 轮询读到 completed 时自增，重复请求即重复累加，且该路由无限流。
  await incrementUserStat(openid, 'savedPaper', 1);

  return { status: 'completed' };
}

/** 失败回滚：恢复券为未使用（供订单内复用；restoreCoupon 只处理券本身） */
async function restoreCoupon(couponId) {
  if (!couponId) return;
  await db
    .collection('coupons')
    .doc(couponId)
    .update({ data: { status: 'unused', useTime: null } })
    .catch(() => null);
}

async function rollback(orderId, couponId) {
  await db
    .collection('orders')
    .doc(orderId)
    .update({ data: { status: 'failed', failReason: '下单失败，券已退回', completeTime: new Date() } })
    .catch(() => null);

  await restoreCoupon(couponId);
}

async function getOrderStatus(event, ctx) {
  const openid = requireOpenid(ctx);
  const { orderId } = event;

  if (!orderId) throw new BizError('缺少订单ID');

  // doc().get() 返回 {data: 文档对象}（非数组），查不到时抛错——统一兜底
  const doc = await db.collection('orders').doc(orderId).get().catch(() => null);
  const raw = doc && doc.data;
  const order = Array.isArray(raw) ? (raw[0] || null) : (raw || null);

  if (!order) throw new BizError('订单不存在', 404);
  if (order._openid !== openid) throw new BizError('无权查看此订单', 403);

  // 纯只读，绝不产生副作用
  return {
    orderId,
    orderSn: order.orderSn,
    status: order.status,
    actualPay: order.actualPay,
    failReason: order.failReason || '',
  };
}

/** 微信支付 v3 JSAPI 预下单 */
async function createPrepay(orderSn, amount, openid) {
  const url = '/v3/pay/transactions/jsapi';
  const method = 'POST';
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = nonceStr();

  const body = JSON.stringify({
    appid: PAY.appId,
    mchid: PAY.mchId,
    description: '智惠本草-取纸',
    out_trade_no: orderSn,
    notify_url: PAY.notifyUrl,
    amount: { total: amount, currency: 'CNY' },
    payer: { openid },
  });

  const authorization =
    `WECHATPAY2-SHA256-RSA2048 mchid="${PAY.mchId}",nonce_str="${nonce}",` +
    `signature="${sign(`${method}\n${url}\n${timestamp}\n${nonce}\n${body}\n`)}",` +
    `timestamp="${timestamp}",serial_no="${PAY.serialNo}"`;

  const data = await request('POST', `https://api.mch.weixin.qq.com${url}`, body, {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: authorization,
  });

  const prepayId = data.prepay_id;
  const timeStamp = String(Math.floor(Date.now() / 1000));
  const payNonce = nonceStr();
  const pkg = `prepay_id=${prepayId}`;

  return { prepayId, timeStamp, nonceStr: payNonce, package: pkg, signType: 'RSA', paySign: sign(`${PAY.appId}\n${timeStamp}\n${payNonce}\n${pkg}\n`) };
}

function sign(message) {
  const s = crypto.createSign('RSA-SHA256');
  s.update({ data: message });
  return s.sign(PAY.privateKey, 'base64');
}

/**
 * 支付回调：验签 + 解密 + 金额比对。
 *
 * ⚠️ 旧实现此函数为空壳 TODO，四个 wechatpay-* 请求头传进来从不读取，
 * 且直接读顶层 body.out_trade_no / body.trade_state。
 * 微信支付 v3 通知的交易信息在 resource 密文内，必须 AES-256-GCM 解密后取得。
 */
async function handleNotify(event) {
  const headers = event.headers || {};
  const body = event.body || {};

  const signature = headers['wechatpay-signature'] || headers.Wechatpay-Signature;
  const timestamp = headers['wechatpay-timestamp'] || headers.Wechatpay-Timestamp;
  const nonce = headers['wechatpay-nonce'] || headers.Wechatpay-Nonce;
  const serial = headers['wechatpay-serial'] || headers.Wechatpay-Serial;

  if (!signature || !timestamp || !nonce) {
    return { success: false, message: '缺少验签请求头', data: null };
  }

  if (!verifyPlatformSignature(`${timestamp}\n${nonce}\n${event.rawBody || ''}\n`, signature, serial)) {
    console.error('支付回调验签失败', { serial });
    return { success: false, message: '验签失败', data: null };
  }

  const resource = body.resource || body;
  if (!resource.ciphertext || !resource.nonce) {
    return { success: false, message: '通知体缺少 resource', data: null };
  }

  let payload;
  try {
    // 修复：authTag 必须从「解码后的 Buffer」取末 16 字节。
    // 旧实现在 base64 字符串上 slice(-16)，边界错位导致解密永远失败；
    // 且微信 v3 回调必须以 associated_data 作为 AAD 参与认证，旧实现完全未设置。
    const ciphertextBuf = Buffer.from(resource.ciphertext, 'base64');
    const authTag = ciphertextBuf.subarray(ciphertextBuf.length - 16);
    const dataBuf = ciphertextBuf.subarray(0, ciphertextBuf.length - 16);

    const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(PAY.apiV3Key), resource.nonce);
    decipher.setAAD(Buffer.from(resource.associated_data || '', 'utf8'));
    decipher.setAuthTag(authTag);

    payload = JSON.parse(Buffer.concat([decipher.update({ data: dataBuf }), decipher.final()]).toString('utf8'));
  } catch (err) {
    console.error('通知解密失败', err);
    return { success: false, message: '解密失败', data: null };
  }

  const {
    out_trade_no: orderSn,
    trade_state: tradeState,
    transaction_id: transactionId,
    amount,
    appid,
    mchid,
  } = payload;

  // 修复：解密得到的 appid/mchid 也必须与配置一致，防止其它商户/应用的通知串单
  if (appid && PAY.appId && appid !== PAY.appId) {
    console.error('回调 appid 不匹配', { orderSn, appid });
    return { success: false, message: 'appid 校验失败', data: null };
  }
  if (mchid && PAY.mchId && mchid !== PAY.mchId) {
    console.error('回调 mchid 不匹配', { orderSn, mchid });
    return { success: false, message: 'mchid 校验失败', data: null };
  }

  if (tradeState !== 'SUCCESS') {
    return { success: true, message: '支付未完成', data: null };
  }

  const result = await db.collection('orders').where({ orderSn }).limit(1).get();
  if (!result.data || result.data.length === 0) {
    console.error('回调订单不存在', { orderSn });
    return { success: false, message: '订单不存在', data: null };
  }

  const order = result.data[0];

  if (order.status !== 'pending') {
    return { success: true, message: '订单已处理', data: null };
  }

  if (amount && amount.total !== order.actualPay) {
    console.error('回调金额不匹配', { orderSn, expected: order.actualPay, got: amount.total });
    return { success: false, message: '金额校验失败', data: null };
  }

  // 修复：金额必检——actualPay 为 0 的订单不应出现在付费回调里；total 缺失即拒绝
  if (!amount || typeof amount.total !== 'number') {
    console.error('回调缺少金额信息', { orderSn });
    return { success: false, message: '金额信息缺失', data: null };
  }

  await db.collection('orders').doc(order._id).update({ data: { status: 'paid', wechatTransactionId: transactionId, payTime: new Date() } });
  await completeDispense(order._id, order.orderSn, order._openid, order.deviceId, order.actualPay);

  return { success: true, message: '处理完成', data: null };
}

function verifyPlatformSignature(message, signature, serial) {
  if (!PAY.platformCert) {
    console.error('未配置平台证书，无法验签');
    return false;
  }
  try {
    const v = crypto.createVerify('RSA-SHA256');
    v.update({ data: message });
    return v.verify(PAY.platformCert, signature, 'base64');
  } catch (err) {
    console.error('验签异常', err);
    return false;
  }
}

function request(method, url, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        method,
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: { ...headers, 'Content-Length': Buffer.byteLength(body || '') },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(raw);
            if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
            else reject(new Error(`微信支付返回 ${res.statusCode}: ${parsed.message || raw.slice(0, 200)}`));
          } catch (err) {
            reject(new Error(`响应解析失败: ${raw.slice(0, 200)}`));
          }
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * 双入口分发：
 *   - callFunction 调用（event.action 存在）→ 业务 action
 *   - HTTP 访问服务转发支付回调（event.action 不存在且有 rawBody/body.resource）→ handleNotify
 *
 * 修复：旧实现注册了空壳 notify action（永远返回成功、什么都不做），
 * 而带验签的 handleNotify 从未接线——回调入口形同虚设且易误导接线人。
 */
// ===== 首页商店：自助购买纸巾（无出纸机场景）=====

/**
 * 取券并校验可核销；未传券返回 null。
 * 与 createOrder 内的校验口径保持一致（归属 / 未使用 / 未过期）。
 */
async function resolveUsableCoupon(couponId, openid) {
  if (!couponId) return null;

  const doc = await db.collection('coupons').doc(couponId).get().catch(() => null);
  const raw = doc && doc.data;
  const coupon = Array.isArray(raw) ? (raw[0] || null) : (raw || null);

  if (!coupon) throw new BizError('优惠券不存在', 404);
  if (coupon._openid !== openid) throw new BizError('无权使用此优惠券', 403);
  if (coupon.status !== 'unused') throw new BizError('优惠券已使用或已过期');
  if (isExpired(coupon.expireDate)) throw new BizError('优惠券已过期');

  return coupon;
}

/**
 * 读取在售商品目录（商店唯一取数入口）。
 *
 * 优先读 products 集合（后台商品管理维护，status='on' 才会出现在商店）；
 * 集合为空时回退内置 SHOP_PRODUCTS，保证商品库未初始化时商店仍可用。
 * stock 为 null 表示不限库存（内置目录即如此）。
 */
async function loadShopCatalog() {
  const res = await db
    .collection('products')
    .where({ status: 'on' })
    .orderBy('sort', 'asc')
    .limit(100)
    .get()
    .catch(() => ({ data: [] }));

  const rows = res.data || [];
  if (rows.length === 0) {
    // 回退内置目录：统一补齐 stock=null（表示不限库存），避免上层把它当成 0 库存
    return {
      catalog: SHOP_PRODUCTS.map((p) => ({ ...p, image: p.image || '', stock: null })),
      fromDefault: true,
    };
  }

  const catalog = rows.map((p) => ({
    id: p._id,
    name: p.name,
    unit: p.unit || '件',
    price: Number(p.price) || 0,
    desc: p.desc || '',
    tag: p.tag || '',
    image: p.image || '',
    stock: p.stock === undefined || p.stock === null ? null : Number(p.stock),
  }));

  return { catalog, fromDefault: false };
}

/**
 * 校验下单商品是否可购买：必须仍在售（上架）且库存充足。
 * 与 calcShopOrder 的区别：calc 只按目录计价，这里负责给出明确的可购买性错误。
 */
function checkPurchasable(items, catalog) {
  const map = {};
  catalog.forEach((p) => { map[p.id] = p; });

  for (const it of Array.isArray(items) ? items : []) {
    const product = map[it && it.productId];
    if (!product) return { ok: false, message: '购物车中有商品已下架，请刷新后重新选择' };

    const qty = parseInt(it.qty, 10) || 0;
    if (qty > 0 && product.stock != null && product.stock < qty) {
      return { ok: false, message: `${product.name} 库存不足（剩余 ${product.stock} 件）` };
    }
  }

  return { ok: true };
}

/**
 * 扣减库存：按件条件更新（stock >= qty）防超卖，任一失败则回滚已扣部分。
 * 库存为 null 的商品（内置目录）直接跳过。
 */
async function deductStock(lines, catalog) {
  const map = {};
  catalog.forEach((p) => { map[p.id] = p; });

  const deducted = [];
  for (const line of lines) {
    const product = map[line.productId];
    if (!product || product.stock == null) continue;

    const res = await db
      .collection('products')
      .where({ _id: line.productId, stock: command.gte(line.qty) })
      .update({ data: { stock: command.inc(-line.qty), updateTime: new Date() } })
      .catch(() => ({ stats: { updated: 0 } }));

    if (!res.stats || res.stats.updated === 0) {
      // 并发下被别人抢走：回滚本次已扣的库存，避免少卖
      for (const d of deducted) {
        await db.collection('products').doc(d.productId)
          .update({ data: { stock: command.inc(d.qty) } })
          .catch(() => null);
      }
      return { ok: false, message: `${line.name} 库存不足，请调整数量后重试` };
    }

    deducted.push({ productId: line.productId, qty: line.qty });
  }

  return { ok: true, deducted };
}

/** 取消订单时回补库存（商品可能已被删除，失败忽略） */
async function restoreStock(items) {
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || !it.productId) continue;
    const qty = Number(it.qty) || 0;
    if (qty <= 0) continue;
    await db.collection('products').doc(it.productId)
      .update({ data: { stock: command.inc(qty) } })
      .catch(() => null);
  }
}

/** 商品列表（价格与优惠规则均以服务端为准） */
async function listProducts(event, ctx) {
  requireOpenid(ctx);
  const { catalog, fromDefault } = await loadShopCatalog();

  return {
    products: catalog.map((p) => ({
      ...p,
      // 售罄标记：库存为 0 时前端禁止继续加购
      soldOut: p.stock !== null && p.stock <= 0,
    })),
    // 支付尚未接入：下单后凭订单号到服务台付款取货
    paymentEnabled: false,
    fulfillment: 'pickup',
    // 商品库未初始化时为 true（前端可提示"先导入默认商品"）
    fromDefault,
  };
}

/** 下单前金额预览（选券后可实时看到优惠与应付） */
async function quoteShopOrder(event, ctx) {
  const openid = requireOpenid(ctx);

  const { catalog } = await loadShopCatalog();
  const availability = checkPurchasable(event.items, catalog);
  if (!availability.ok) throw new BizError(availability.message, 409);

  const coupon = await resolveUsableCoupon(event.couponId, openid);
  const calc = calcShopOrder(event.items, catalog, coupon && coupon.type);
  if (!calc.ok) throw new BizError(calc.reason);

  return {
    ...calc,
    couponId: coupon ? coupon._id : null,
    couponDesc: coupon ? (coupon.desc || couponTypeLabel(coupon.type)) : '',
  };
}

/** 提交商店订单：核销券（若有）→ 落库 */
async function createShopOrder(event, ctx) {
  const openid = requireOpenid(ctx);
  await findOrCreateUser(openid);

  const { catalog } = await loadShopCatalog();
  const availability = checkPurchasable(event.items, catalog);
  if (!availability.ok) throw new BizError(availability.message, 409);

  const coupon = await resolveUsableCoupon(event.couponId, openid);
  const calc = calcShopOrder(event.items, catalog, coupon && coupon.type);
  if (!calc.ok) throw new BizError(calc.reason);

  // 扣库存（条件更新防超卖；失败时已自动回滚本次已扣部分）
  const stockRes = await deductStock(calc.lines, catalog);
  if (!stockRes.ok) throw new BizError(stockRes.message, 409);

  // 用券即核销（券是自提凭证），条件更新防并发双花
  if (coupon) {
    const claimed = await db
      .collection('coupons')
      .where({ _id: coupon._id, _openid: openid, status: 'unused' })
      .update({ data: { status: 'used', useTime: new Date() } });

    if (!claimed.stats || claimed.stats.updated === 0) {
      // 券抢不到则整单失败，已扣的库存要回补
      await restoreStock(calc.lines);
      throw new BizError('优惠券状态已变更，请刷新后重试', 409);
    }
  }

  const orderSn = generateOrderSn();
  const now = new Date();
  // 免单（应付 0）直接完成；否则挂起等待线下付款/自提
  const status = calc.payable === 0 ? 'completed' : 'pending';

  const created = await db.collection('orders').add({ data: {
    orderSn,
    _openid: openid,
    type: 'shop',
    title: calc.lines.length === 1 ? calc.lines[0].name : `共 ${calc.lines.length} 种商品`,
    deviceId: null,
    fulfillment: 'pickup',
    items: calc.lines,
    subtotal: calc.subtotal,
    discount: calc.discount,
    payable: calc.payable,
    // 兼容既有订单字段命名
    amount: calc.subtotal,
    actualPay: calc.payable,
    couponId: coupon ? coupon._id : null,
    couponLabel: calc.couponLabel || '',
    status,
    createTime: now,
    updateTime: now,
  } });

  // 节约纸张统计：按购买件数累计
  const totalQty = calc.lines.reduce((sum, l) => sum + l.qty, 0);
  await incrementUserStat(openid, 'savedPaper', totalQty).catch(() => null);

  return {
    orderId: created._id,
    orderSn,
    status,
    statusText: status === 'completed' ? '免单成功' : '待付款取货',
    paymentEnabled: false,
    fulfillment: 'pickup',
    tip: calc.payable === 0
      ? '免单成功！请凭订单号到服务台取货'
      : '订单已提交，请凭订单号到服务台付款取货',
    ...calc,
  };
}

// ===== 订单状态流转：支付 / 取消 / 确认取货 =====

/** 按 _id 或订单号取本用户的订单（两条路径都校验归属） */
async function fetchOwnOrder(key, openid) {
  const idOrSn = key ? String(key) : '';
  if (!idOrSn) return null;

  const byId = await db.collection('orders').doc(idOrSn).get().catch(() => null);
  const raw = byId && byId.data;
  const doc = Array.isArray(raw) ? (raw[0] || null) : (raw || null);
  if (doc && doc._openid === openid) return doc;

  const bySn = await db
    .collection('orders')
    .where({ orderSn: idOrSn, _openid: openid })
    .limit(1)
    .get()
    .catch(() => ({ data: [] }));

  return (bySn.data || [])[0] || null;
}

/**
 * 支付订单：pending → paid。
 *
 * 微信支付已配置时走预付单 + 回调推进；未配置（当前状态）走**体验版模拟支付**，
 * 直接置为已付款并标记 payChannel='sandbox'，前端会明确提示"未真实扣款"。
 * 两条路径共用同一状态机，将来接入真实支付只需补齐环境变量。
 */
async function payOrder(event, ctx) {
  const openid = requireOpenid(ctx);
  const order = await fetchOwnOrder(event.orderId || event.orderSn, openid);
  if (!order) throw new BizError('订单不存在', 404);

  if (order.status === 'paid' || order.status === 'completed') {
    return { ...normalizeOrder(order), alreadyPaid: true };
  }
  if (!canTransitionOrder(order.status, 'paid')) {
    throw new BizError(`订单当前为${orderStatusText(order.status)}，无法支付`, 409);
  }

  const amount = Number(order.payable !== undefined ? order.payable : order.actualPay) || 0;

  if (IS_PAY_ENABLED) {
    const prepay = await createPrepay(order.orderSn, amount, openid);
    await db.collection('orders').doc(order._id).update({ data: {
      wechatPrepayId: prepay.prepayId,
      updateTime: new Date(),
    } });
    return { orderId: order._id, orderSn: order.orderSn, prepayParams: prepay, needWxPay: true, sandbox: false };
  }

  const now = new Date();
  await db.collection('orders').doc(order._id).update({ data: {
    status: 'paid',
    payChannel: 'sandbox',
    payTime: now,
    updateTime: now,
  } });

  return {
    ...normalizeOrder({ ...order, status: 'paid', payChannel: 'sandbox', payTime: now }),
    sandbox: true,
    tip: '体验版模拟支付已完成（未真实扣款），请凭订单号到服务台取货',
  };
}

/** 取消订单：pending → cancelled；已核销的券一并退回 */
async function cancelOrder(event, ctx) {
  const openid = requireOpenid(ctx);
  const order = await fetchOwnOrder(event.orderId, openid);
  if (!order) throw new BizError('订单不存在', 404);

  if (order.status === 'cancelled') {
    return { ...normalizeOrder(order), alreadyCancelled: true };
  }
  if (!canTransitionOrder(order.status, 'cancelled')) {
    throw new BizError(`订单当前为${orderStatusText(order.status)}，无法取消`, 409);
  }

  const now = new Date();
  await db.collection('orders').doc(order._id).update({ data: {
    status: 'cancelled',
    cancelTime: now,
    updateTime: now,
  } });

  // 库存回补：下单时已扣减，取消后要还回去
  await restoreStock(order.items);

  // 券在下单时已核销：取消订单要退回，否则用户白丢一张券
  if (order.couponId) await restoreCoupon(order.couponId);

  return {
    ...normalizeOrder({ ...order, status: 'cancelled', cancelTime: now }),
    tip: order.couponId ? '订单已取消，优惠券已退回' : '订单已取消',
  };
}

/** 确认取货：paid → completed（自提场景由用户确认已拿到商品） */
async function confirmOrder(event, ctx) {
  const openid = requireOpenid(ctx);
  const order = await fetchOwnOrder(event.orderId, openid);
  if (!order) throw new BizError('订单不存在', 404);

  if (order.status === 'completed') {
    return { ...normalizeOrder(order), alreadyCompleted: true };
  }
  if (!canTransitionOrder(order.status, 'completed')) {
    throw new BizError(`订单当前为${orderStatusText(order.status)}，无法确认取货`, 409);
  }

  const now = new Date();
  await db.collection('orders').doc(order._id).update({ data: {
    status: 'completed',
    completeTime: now,
    updateTime: now,
  } });

  return { ...normalizeOrder({ ...order, status: 'completed', completeTime: now }), tip: '已确认取货，订单完成' };
}

/**
 * 订单记录（下单 / 支付 / 完成全流程的查询入口）。
 *
 * 取纸机订单与商店订单同构返回（common.normalizeOrder 归一），
 * 支持按状态筛选与分页，并附带各状态计数供页面筛选标签使用。
 */
async function listMyOrders(event, ctx) {
  const openid = requireOpenid(ctx);
  const page = Math.max(parseInt(event.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(event.pageSize, 10) || 20, 1), 50);

  const where = { _openid: openid };
  if (event.status && ORDER_STATUS_TEXT[event.status]) where.status = event.status;

  const col = db.collection('orders');
  const base = Object.keys(where).length > 1 ? col.where(where) : col.where({ _openid: openid });
  const offset = (page - 1) * pageSize;

  const pageQuery = offset > 0
    ? base.orderBy('createTime', 'desc').skip(offset).limit(pageSize)
    : base.orderBy('createTime', 'desc').limit(pageSize);

  const [listRes, countRes, allRes, pendingRes, paidRes, completedRes] = await Promise.all([
    pageQuery.get().catch(() => ({ data: [] })),
    base.count().catch(() => ({ total: 0 })),
    col.where({ _openid: openid }).count().catch(() => ({ total: 0 })),
    col.where({ _openid: openid, status: 'pending' }).count().catch(() => ({ total: 0 })),
    col.where({ _openid: openid, status: 'paid' }).count().catch(() => ({ total: 0 })),
    col.where({ _openid: openid, status: 'completed' }).count().catch(() => ({ total: 0 })),
  ]);

  const list = (listRes.data || []).map(normalizeOrder);

  return {
    list,
    items: list,
    total: countRes.total || 0,
    page,
    pageSize,
    hasMore: page * pageSize < (countRes.total || 0),
    stats: {
      all: allRes.total || 0,
      pending: pendingRes.total || 0,
      paid: paidRes.total || 0,
      completed: completedRes.total || 0,
    },
    // 支付通道状态：false 时前端提示为体验版模拟支付
    paymentEnabled: IS_PAY_ENABLED,
    fulfillment: 'pickup',
  };
}

exports.main = async (event = {}) => {
  if (event.action) {
    const handler = createHandler({
      create: createOrder,
      status: getOrderStatus,
      products: listProducts,
      quote: quoteShopOrder,
      shopOrder: createShopOrder,
      myOrders: listMyOrders,
      pay: payOrder,
      cancel: cancelOrder,
      confirm: confirmOrder,
    });
    return handler(event);
  }

  // HTTP 访问服务转发的微信支付回调：无 action，带原始请求体
  if (event.rawBody || event.body || event.headers) {
    return handleNotify(event);
  }

  return { success: false, message: '未知操作: (空)', code: -1 };
};

/** 供 HTTP 访问服务直接挂载支付回调时使用（与 main 中的分发等效） */
exports.handleNotify = handleNotify;