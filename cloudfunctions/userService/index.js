/**
 * 用户服务 · 云函数
 *
 * action:
 *   profile  GET  读取用户资料（不存在则创建）
 *   update   PUT  更新昵称与头像
 *   stats    GET  统计：已节约纸张 / 累计答题 / 券数量
 */

const {
  db,
  command,
  BizError,
  requireOpenid,
  findOrCreateUser,
  incrementUserStat,
  createHandler,
} = require('./common');

async function getProfile(event, ctx) {
  const openid = requireOpenid(ctx);
  const user = await findOrCreateUser(openid);

  return {
    id: user._id,
    nickName: user.nickName || '微信用户',
    avatarUrl: user.avatarUrl || '',
    savedPaper: user.savedPaper || 0,
    quizCount: user.quizCount || 0,
    createTime: user.createTime,
  };
}

async function updateProfile(event, ctx) {
  const openid = requireOpenid(ctx);
  const { nickName, avatarUrl } = event;

  if (nickName === undefined && avatarUrl === undefined) {
    throw new BizError('没有需要更新的字段');
  }

  if (nickName !== undefined) {
    if (typeof nickName !== 'string') throw new BizError('昵称格式不正确');
    if (nickName.trim().length > 20) throw new BizError('昵称不能超过 20 个字符');
  }

  // 头像只接受云存储 fileID 或 HTTPS 地址，防写入任意字符串/脚本
  if (avatarUrl !== undefined && avatarUrl !== '') {
    const valid =
      typeof avatarUrl === 'string' &&
      (/^cloud:\/\//.test(avatarUrl) || /^https:\/\/[a-zA-Z0-9.-]+/.test(avatarUrl));
    if (!valid) throw new BizError('头像地址格式不正确');
  }

  await findOrCreateUser(openid);

  const patch = { updateTime: new Date() };
  if (nickName !== undefined) patch.nickName = nickName.trim();
  if (avatarUrl !== undefined) patch.avatarUrl = avatarUrl;

  const result = await db
    .collection('users')
    .where({ _openid: openid })
    .update({ data: patch })
    .catch((err) => {
      throw new BizError('资料保存失败，请重试', 500);
    });

  if (result.stats && result.stats.updated === 0) {
    throw new BizError('资料保存失败，请重试', 500);
  }

  const user = await db.collection('users').where({ _openid: openid }).limit(1).get();

  return {
    id: user.data[0]._id,
    nickName: user.data[0].nickName,
    avatarUrl: user.data[0].avatarUrl,
  };
}

async function getStats(event, ctx) {
  const openid = requireOpenid(ctx);
  const user = await findOrCreateUser(openid);

  const [recordCount, couponAgg] = await Promise.all([
    db.collection('quiz_records').where({ _openid: openid }).count().catch(() => ({ total: 0 })),
    db
      .collection('coupons')
      .where({ _openid: openid, status: 'unused' })
      .count()
      .catch(() => ({ total: 0 })),
  ]);

  const savedPaper = user.savedPaper || 0;

  return {
    savedPaper,
    quizCount: user.quizCount || 0,
    totalQuizRecords: recordCount.total || 0,
    unusedCoupons: couponAgg.total || 0,
  };
}

/**
 * AR 识别记录。
 *
 * 注意：ar_records 当前无写入方（AR 页为占位实现），
 * 本接口保证将来真实写入后记录页即可用；空集时页面展示空态。
 */
async function getArRecords(event, ctx) {
  const openid = requireOpenid(ctx);

  const page = Math.max(parseInt(event.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(event.pageSize, 10) || 20, 1), 50);

  const [list, count] = await Promise.all([
    db
      .collection('ar_records')
      .where({ _openid: openid })
      .orderBy('createTime', 'desc')
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .get()
      .catch(() => ({ data: [] })),
    db
      .collection('ar_records')
      .where({ _openid: openid })
      .count()
      .catch(() => ({ total: 0 })),
  ]);

  const records = (list.data || []).map((r) => ({
    _id: r._id,
    herbName: r.herbName || '未知本草',
    herbInfo: r.herbInfo || '',
    imageUrl: r.imageUrl || '',
    confidence: r.confidence || 0,
    createTimeStr: formatDateTime(r.createTime),
  }));

  return {
    records,
    total: count.total || 0,
    page,
    hasMore: page * pageSize < (count.total || 0),
  };
}

function formatDateTime(d) {
  if (!d) return '';
  const date = new Date(d);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${hh}:${mm}`;
}

exports.main = createHandler({
  profile: getProfile,
  update: updateProfile,
  stats: getStats,
  'ar-records': getArRecords,
});