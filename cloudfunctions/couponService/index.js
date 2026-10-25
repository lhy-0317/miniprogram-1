/**
 * 优惠券服务 · 云函数
 *
 * action:
 *   list  GET  券列表（含过期态计算）
 *   use   POST 使用券（仅标记，真正下单走 orderService）
 */

const { db, BizError, requireOpenid, couponTypeLabel, createHandler } = require('./common');

function isExpired(expireDate) {
  if (!expireDate) return false;
  const end = new Date(`${expireDate}T23:59:59`);
  return end.getTime() < Date.now();
}

async function listCoupons(event, ctx) {
  const openid = requireOpenid(ctx);

  const result = await db
    .collection('coupons')
    .where({ _openid: openid })
    .orderBy('createTime', 'desc')
    .limit(100)
    .get();

  const coupons = (result.data || []).map((c) => ({
    // 统一返回 _id 与 id，修复旧后端小程序拿 id、后台拿 _id 的字段冲突
    id: c._id,
    _id: c._id,
    amount: c.amount,
    // 库内可能是机器码（paper/shopping）或中文标签，统一归一为中文标签展示
    type: couponTypeLabel(c.type),
    desc: c.desc || '优惠券',
    expireDate: c.expireDate,
    createTime: c.createTime,
    // 过期为读时计算，不落库
    status: c.status === 'unused' && isExpired(c.expireDate) ? 'expired' : c.status,
    useTime: c.useTime || null,
  }));

  return {
    coupons,
    unusedCount: coupons.filter((c) => c.status === 'unused').length,
  };
}

/**
 * 标记券为已使用。
 *
 * 注意：本 action 只做「核销」，实际下单与出纸由 orderService 处理。
 * 旧的个人中心「立即使用」直接调本接口，等于白扔一张券；
 * 前端已改为携带 deviceId 走完整下单流程。
 */
async function useCoupon(event, ctx) {
  const openid = requireOpenid(ctx);
  const { couponId } = event;

  if (!couponId) throw new BizError('缺少券ID');

  // doc().get() 返回 {data: 文档对象}（非数组），查不到时 throwOnNotFound 抛错。
  // 统一兜底：异常归一为 null，形状兼容对象/数组两种形态。
  const doc = await db.collection('coupons').doc(couponId).get().catch(() => null);
  const raw = doc && doc.data;
  const coupon = Array.isArray(raw) ? (raw[0] || null) : (raw || null);

  if (!coupon) throw new BizError('优惠券不存在', 404);
  if (coupon._openid !== openid) throw new BizError('无权使用此优惠券', 403);
  if (coupon.status !== 'unused') throw new BizError('优惠券已使用或已过期');
  if (isExpired(coupon.expireDate)) throw new BizError('优惠券已过期');

  // 条件更新防止并发重复核销（旧实现是「先读后写」的 TOCTOU 双花）
  const result = await db
    .collection('coupons')
    .where({ _id: couponId, _openid: openid, status: 'unused' })
    .update({ data: { status: 'used', useTime: new Date() } });

  if (!result.stats || result.stats.updated === 0) {
    throw new BizError('优惠券状态已变更，请刷新后重试', 409);
  }

  return { couponId, useTime: new Date() };
}

exports.main = createHandler({
  list: listCoupons,
  use: useCoupon,
});