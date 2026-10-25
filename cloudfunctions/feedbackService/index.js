/**
 * 反馈服务 · 云函数
 *
 * action:
 *   submit  POST 提交用户反馈
 *
 * 旧实现由小程序直接 wx.cloud.database().collection('feedback').add() 写入，
 * 而后端全仓库无任何引用该集合 —— 反馈成了黑洞，提交后无人能读。
 * 现统一走云函数，并预留管理端读取入口。
 */

const { db, BizError, requireOpenid, createHandler } = require('./common');

/** 与 feedback 页 feedbackTypes 的取值一一对应 */
const VALID_TYPES = ['suggestion', 'bug', 'question', 'other'];
const MAX_CONTENT = 500;

async function submitFeedback(event, ctx) {
  const openid = requireOpenid(ctx);
  const { type, content, contact, images } = event;

  if (!content || typeof content !== 'string' || !content.trim()) {
    throw new BizError('请填写反馈内容');
  }
  if (content.trim().length > MAX_CONTENT) {
    throw new BizError(`反馈内容不能超过 ${MAX_CONTENT} 字`);
  }

  const feedbackType = VALID_TYPES.includes(type) ? type : 'other';
  const now = new Date();

  // 收敛可选输入：联系方式限长，图片必须是数组且每项为合法 fileID/URL
  const safeContact = typeof contact === 'string' ? contact.trim().slice(0, 100) : '';
  const safeImages = Array.isArray(images)
    ? images
        .filter((u) => typeof u === 'string' && (/^cloud:\/\//.test(u) || /^https:\/\//.test(u)))
        .slice(0, 5)
    : [];

  const result = await db.collection('feedback').add({ data: {
    _openid: openid,
    type: feedbackType,
    content: content.trim(),
    contact: safeContact,
    images: safeImages,
    status: 'pending',
    createTime: now,
    updateTime: now,
  } });

  return { id: result._id, status: 'pending' };
}

exports.main = createHandler({
  submit: submitFeedback,
});