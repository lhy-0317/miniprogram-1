/**
 * 答题服务 · 云函数
 *
 * action:
 *   random    GET  随机抽题（不下发正确答案）
 *   submit    POST 提交单题作答，服务端判卷并按需发券
 *   history   GET  答题历史
 *
 * 相对旧后端的两处关键修复：
 *   1. 抽题时剔除 correct / explanation，不再把答案下发到客户端
 *   2. 发券计数由服务端从 quiz_records 推导，不再信任客户端上报的 correctCount
 */

const {
  db,
  command,
  BizError,
  requireOpenid,
  toIndexArray,
  sameIndexSet,
  advanceQuizSession,
  quizRoundState,
  pickWeighted,
  findOrCreateUser,
  incrementUserStat,
  createHandler,
} = require('./common');

const DAILY_COUPON_LIMIT = 3;
const COUPON_VALID_DAYS = 30;
/** 每轮答题限时（毫秒）：3 分钟内持续出题，时间到即结束 */
const ROUND_DURATION_MS = 3 * 60 * 1000;
/** 本轮答对达到该数量：随机发一张券并**自动结束**本轮 */
const ROUND_TARGET_CORRECT = 5;
/** 单轮内已答题目列表上限（防用户文档无限膨胀） */
const MAX_SESSION_IDS = 500;
/** 单轮内已下发题号上限（P1-3）：超过即重置，防恶意刷题把用户文档撑大 */
const MAX_ISSUED_IDS = 60;
/** 抽题池上限 */
const MAX_POOL = 200;
/**
 * 答题奖励券池：**按权重随机**发放一种（weight 即百分比，**合计必须为 100**）。
 *
 * 当前规则：免费领纸券 5% / 买2送1券 15% / 8折券 80%。
 * 调整概率只需改这里的 weight，无需改动发券逻辑；
 * test 59-61 会校验边界、实际分布与「三档权重合计 = 100」。
 *
 * 注意：免费券的 type 必须写 '领纸券'——取纸机核销与商店免单都按该类型判定。
 */
const COUPON_REWARDS = [
  { amount: '免费', type: '领纸券', desc: '免费领纸券', weight: 5 },
  { amount: '买2送1', type: '优惠券', desc: '买2送1券', weight: 15 },
  { amount: '8折', type: '购物券', desc: '8折券', weight: 80 },
];

/** 券池权重合计（供自检/测试断言用，正常应为 100） */
const REWARD_WEIGHT_TOTAL = COUPON_REWARDS.reduce((sum, r) => sum + r.weight, 0);
/** 提交频控：单用户每分钟最多 30 次提交（防脚本灌库/刷券） */
const SUBMIT_RATE_LIMIT = 30;

/** 读取用户文档上的本轮答题状态（含限时判定） */
function readRound(user) {
  const round = quizRoundState(
    { startAt: user && user.sessionStartAt, correct: user && user.sessionCorrect },
    { durationMs: ROUND_DURATION_MS, targetCorrect: ROUND_TARGET_CORRECT }
  );
  return {
    ...round,
    answeredIds: round.active && Array.isArray(user.sessionAnsweredIds) ? user.sessionAnsweredIds : [],
    // P1-3：本轮已下发的题号（提交时校验是否为本轮真实下发的题）
    issuedIds: round.active && Array.isArray(user.sessionIssuedIds) ? user.sessionIssuedIds : [],
    // P0-3：本轮是否已发过券（原子闸门标记）
    rewarded: !!(user && user.sessionRewarded),
    coupons: Number(user && user.sessionCoupons) || 0,
  };
}

/** 统一组装返回给客户端的轮次进度 */
function sessionProgress(round) {
  const correct = round.correct || 0;
  return {
    active: !!round.active,
    finished: !!round.finished,
    expired: !!round.expired,
    reached: !!round.reached,
    sessionCorrect: correct,
    answeredCount: (round.answeredIds || []).length,
    // 还差几道达标（达标即结束本轮）
    toNextCoupon: Math.max(ROUND_TARGET_CORRECT - correct, 0),
    rewardEvery: ROUND_TARGET_CORRECT,
    rewardTarget: ROUND_TARGET_CORRECT,
    roundDurationMs: ROUND_DURATION_MS,
    remainingMs: typeof round.remainingMs === 'number' ? round.remainingMs : ROUND_DURATION_MS,
  };
}

/** 本轮成绩（在清空会话前后都可调用，纯计算） */
function buildRoundSummary(round) {
  const answered = (round.answeredIds || []).length;
  const correct = round.correct || 0;
  return {
    answered,
    correct,
    wrong: Math.max(answered - correct, 0),
    rate: answered > 0 ? Math.round((correct / answered) * 100) : null,
    coupons: round.coupons || 0,
    rewardEvery: ROUND_TARGET_CORRECT,
    // 本轮没有任何作答时，页面提示"本轮还没有答题记录"，不展示空成绩卡
    empty: answered === 0,
  };
}

/** 结束本轮：清空会话状态 */
async function clearRound(userId) {
  await db.collection('users').doc(userId).update({ data: {
    sessionStartAt: null,
    sessionCorrect: 0,
    sessionAnsweredIds: [],
    // P0-3 / P1-3：结算即重置本轮的发券闸门与下发题号
    sessionIssuedIds: [],
    sessionRewarded: false,
    sessionCoupons: 0,
    sessionUpdatedAt: null,
    updateTime: new Date(),
  } });
}

/**
 * 原子领取本轮发券资格（P0-3 修复）。
 *
 * 旧实现按「coupon.milestone + 当日」去重，而每轮「答对 5 题即达标结束」，
 * milestone 恒为 5 —— 当天第 2、3 轮达标都会被去重查询命中，导致
 * DAILY_COUPON_LIMIT = 3 实际只发得出 1 张。
 *
 * 现改为用户文档上的标记位 + 条件更新：只有把 sessionRewarded 由「非 true」改为 true
 * 的那一个请求才继续发券，天然防住客户端重试与并发重复，也不再依赖任何固定数字。
 */
async function claimRoundReward(userId) {
  const res = await db
    .collection('users')
    .where({ _id: userId, sessionRewarded: command.neq(true) })
    .update({ data: { sessionRewarded: true } });
  return !!(res && res.stats && res.stats.updated > 0);
}

/**
 * 记录本轮下发的题号（P1-3）。
 *
 * 用 command.push 原子追加，避免并发抽题互相覆盖；超过上限则重置为新的一批
 * （正常一轮 3 分钟内不可能抽这么多题，触发即说明被脚本刷题）。
 */
async function markQuestionIssued(userId, questionId, issuedIds) {
  if (!questionId) return;
  const current = Array.isArray(issuedIds) ? issuedIds : [];

  if (current.length >= MAX_ISSUED_IDS) {
    await db.collection('users').doc(userId)
      .update({ data: { sessionIssuedIds: [questionId] } })
      .catch(() => null);
    return;
  }

  await db.collection('users').doc(userId)
    .update({ data: { sessionIssuedIds: command.push(questionId) } })
    .catch(() => null);
}

function shuffle(list) {
  const arr = [...list];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * 抽题：一次一道，且**不重复本次会话已答过的题**。
 *
 * 会话状态由服务端从用户文档读取（客户端无法伪造），
 * 因此切到首页/我的再回来仍能接着答、且不会重复出题。
 * 题库全部答完时开启新一轮（清空排除条件）。
 */
async function getRandomQuestions(event, ctx) {
  const openid = requireOpenid(ctx);
  const user = await findOrCreateUser(openid);
  const round = readRound(user);

  // 时间到：本轮不再出题，直接结算（返回成绩供页面展示）
  if (round.finished) {
    const summary = buildRoundSummary(round);
    await clearRound(user._id);
    return {
      question: null,
      roundFinished: true,
      expired: round.expired,
      reached: round.reached,
      summary,
      ...sessionProgress({ ...round, active: false, finished: true }),
    };
  }

  // 首次抽题即开局（计时从此开始）
  if (!round.active) {
    await db.collection('users').doc(user._id).update({ data: {
      sessionStartAt: new Date(),
      sessionCorrect: 0,
      sessionAnsweredIds: [],
      // P0-3 / P1-3：新一轮开局，重置发券闸门与下发题号
      sessionIssuedIds: [],
      sessionRewarded: false,
      sessionCoupons: 0,
      sessionUpdatedAt: new Date(),
      updateTime: new Date(),
    } });
    round.active = true;
    round.remainingMs = ROUND_DURATION_MS;
    round.issuedIds = [];
  }

  const session = round;

  const result = await db.collection('quiz_question').limit(MAX_POOL).get().catch(() => ({ data: [] }));
  const pool = result.data || [];

  // 服务端无题时用兜底题库（同样排除本次已答过的题）
  if (pool.length === 0) {
    const bank = getFallbackBank();
    let candidates = bank.filter((q) => session.answeredIds.indexOf(q._id) === -1);
    const reset = candidates.length === 0;
    if (reset) candidates = bank;
    const pick = shuffle(candidates)[0] || null;
    if (pick) await markQuestionIssued(user._id, pick._id, session.issuedIds);

    return {
      // P1-1：兜底分支同样只回传白名单字段，避免 correct / explanation 随题目下发
      question: pick ? {
        _id: pick._id,
        question: pick.question,
        options: pick.options,
        category: pick.category || '',
        type: pick.type || 'single',
      } : null,
      ...sessionProgress(session),
      fromFallback: true,
      poolReset: reset,
    };
  }

  let candidates = pool.filter((q) => session.answeredIds.indexOf(q._id) === -1);
  const poolReset = candidates.length === 0;
  if (poolReset) candidates = pool;

  const q = shuffle(candidates)[0] || null;
  if (q) await markQuestionIssued(user._id, q._id, session.issuedIds);

  return {
    // 显式剔除答案字段（防作弊）
    question: q ? {
      _id: q._id,
      question: q.question,
      options: q.options,
      category: q.category || '',
      type: q.type || 'single',
    } : null,
    ...sessionProgress(session),
    fromFallback: false,
    poolReset,
  };
}

async function submitAnswer(event, ctx) {
  const openid = requireOpenid(ctx);
  const { questionId, questionIndex, answerTime } = event;

  // 兼容两种作答形态：单选（selectedOptionIndex 数字）与多选（selectedOptionIndices 数组）
  const selected = toIndexArray(
    event.selectedOptionIndices !== undefined ? event.selectedOptionIndices : event.selectedOptionIndex
  );
  if (selected.length === 0) {
    throw new BizError('未选择答案');
  }

  // 收敛答题时长：客户端上报值仅作记录，上限 10 分钟，防写入垃圾数据
  const safeAnswerTime = Math.min(Math.max(Number(answerTime) || 0, 0), 10 * 60 * 1000);

  // 频控：1 分钟内超过 30 次提交即拒绝（人工答题不可能达到）
  const oneMinuteAgo = new Date(Date.now() - 60 * 1000);
  const recent = await db
    .collection('quiz_records')
    .where({ _openid: openid, createTime: command.gte(oneMinuteAgo) })
    .count()
    .catch(() => ({ total: 0 }));
  if ((recent.total || 0) >= SUBMIT_RATE_LIMIT) {
    throw new BizError('操作过于频繁，请稍后再试', 429);
  }

  const user = await findOrCreateUser(openid);

  // 本轮已结束（时间到 / 已达标）时不再计分，直接结算告知页面
  const current = readRound(user);
  if (!current.active || current.finished) {
    const summary = buildRoundSummary(current);
    if (current.active) await clearRound(user._id);
    return {
      expired: current.expired,
      reached: current.reached,
      roundFinished: true,
      summary,
      couponIssued: null,
      ...sessionProgress({ ...current, active: false, finished: true }),
    };
  }

  // P1-3：只接受本轮由服务端下发过的题号。
  // 否则可枚举题库 _id 直接提交正确答案，把 sessionCorrect 刷到 5 换券
  // （30 次/分钟频控与每轮 5 题上限只能降速，挡不住）。
  if (!questionId || (current.issuedIds || []).indexOf(questionId) === -1) {
    throw new BizError('该题目不在本轮下发的题目中，请从答题页面作答', 400);
  }

  // 服务端判卷：兜底题库走本地匹配
  let questionDoc = null;
  if (questionId && !String(questionId).startsWith('local_')) {
    try {
      // doc().get() 返回 {data: 文档对象}（非数组），查不到时抛错——统一兜底
      const doc = await db.collection('quiz_question').doc(questionId).get().catch(() => null);
      const raw = doc && doc.data;
      questionDoc = Array.isArray(raw) ? (raw[0] || null) : (raw || null);
    } catch (err) {
      console.error('题目查询失败', err);
      throw new BizError('题目查询失败，请刷新后重试', 500);
    }
  }

  let correctOptionIndices = [];
  let explanation = '';
  let questionText = '';
  let options = [];
  let qType = 'single';
  let qDifficulty = 'medium';
  let qCategory = '';

  if (questionDoc) {
    correctOptionIndices = toIndexArray(questionDoc.correct);
    explanation = questionDoc.explanation || '';
    questionText = questionDoc.question || '';
    options = questionDoc.options || [];
    qType = questionDoc.type || 'single';
    qDifficulty = questionDoc.difficulty || 'medium';
    qCategory = questionDoc.category || '';
  } else {
    const local = getFallbackBank().find((q) => q._id === questionId);
    if (!local) throw new BizError('题目不存在');
    correctOptionIndices = toIndexArray(local.correct);
    explanation = local.explanation;
    questionText = local.question;
    options = local.options;
  }

  if (selected.some((i) => i >= options.length)) {
    throw new BizError('答案选项不合法');
  }

  // 多选题：作答集合与正确集合完全一致才算对；单选/判断即两集合各含一个下标
  const isCorrect = sameIndexSet(selected, correctOptionIndices);

  await db.collection('quiz_records').add({ data: {
    _openid: openid,
    questionId: questionId || null,
    questionIndex: questionIndex ?? null,
    question: questionText,
    options,
    // 快照式存下解析/题型/难度/分类，供答题历史详情卡片直接展示
    explanation,
    type: qType,
    difficulty: qDifficulty,
    category: qCategory,
    // 多选记录完整下标数组；userOptionIndex/correctOptionIndex 保留首项，兼容旧版查询
    userOptionIndices: selected,
    correctOptionIndices,
    userOptionIndex: selected[0],
    correctOptionIndex: correctOptionIndices[0],
    isCorrect,
    answerTime: safeAnswerTime,
    createTime: new Date(),
  } });

  // ===== 轮次推进：累计答对（答错不清零）+ 已答题目列表（用于同轮不重复出题）=====
  // 轮次生命周期由限时（ROUND_DURATION_MS）控制，不依赖闲置重置：
  // 已结束的轮次在上方就已被拦截，故这里的 idleMs 用默认值也不会触发。
  const next = advanceQuizSession(
    { correct: current.correct, answeredIds: user.sessionAnsweredIds, updatedAt: user.sessionUpdatedAt },
    { questionId, isCorrect, now: Date.now(), maxIds: MAX_SESSION_IDS }
  );

  const reached = next.correct >= ROUND_TARGET_CORRECT;

  // P1-3：该题号一次性消费，出文档（同题重复提交由 duplicated 兜底）
  const nextIssued = (current.issuedIds || []).filter((id) => id !== questionId);

  await db.collection('users').doc(user._id).update({ data: {
    sessionCorrect: next.correct,
    sessionAnsweredIds: next.answeredIds,
    sessionIssuedIds: nextIssued,
    sessionUpdatedAt: next.updatedAt,
    updateTime: new Date(),
  } });

  // 统计口径：累计答题包含答错的题；重复提交不计入
  if (!next.duplicated) {
    await incrementUserStat(openid, 'quizCount', 1);
  }

  // 达标即随机发一张券，并**自动结束本轮**
  let couponIssued = null;
  if (!next.duplicated && reached) {
    // P0-3：原子闸门——同一轮只有抢到闸门的请求才发券，
    // 既防客户端重试/并发重复发放，也不再依赖 milestone 数字去重
    const canReward = await claimRoundReward(user._id);
    if (canReward) couponIssued = await tryIssueCoupon(openid, next.correct);
    if (couponIssued) {
      await db.collection('users').doc(user._id)
        .update({ data: { sessionCoupons: command.inc(1), updateTime: new Date() } })
        .catch(() => null);
    }
  }

  const roundAfter = {
    ...current,
    correct: next.correct,
    answeredIds: next.answeredIds,
    reached,
    expired: false,
    finished: reached,
    coupons: (current.coupons || 0) + (couponIssued ? 1 : 0),
  };

  // 达标 → 结算并清空会话（页面据此弹出券与成绩卡）
  let summary = null;
  if (reached) {
    summary = buildRoundSummary(roundAfter);
    await clearRound(user._id);
  }

  return {
    isCorrect,
    correctOptionIndices,
    correctOptionIndex: correctOptionIndices[0],
    explanation,
    duplicated: next.duplicated,
    couponIssued,
    roundFinished: reached,
    summary,
    ...sessionProgress(roundAfter),
  };
}

/**
 * 查询本轮进度（页面重新进入时恢复；切到首页/我的再回来时钟继续走）。
 *
 * 若本轮已结束（时间到/已达标），一并结算并清空，把成绩返回给页面展示。
 */
async function getQuizProgress(event, ctx) {
  const openid = requireOpenid(ctx);
  const user = await findOrCreateUser(openid);
  const round = readRound(user);

  if (round.finished) {
    const summary = buildRoundSummary(round);
    await clearRound(user._id);
    return {
      roundFinished: true,
      expired: round.expired,
      reached: round.reached,
      summary,
      ...sessionProgress({ ...round, active: false, finished: true }),
    };
  }

  return sessionProgress(round);
}

/**
 * 重开本轮：清空会话状态，下次抽题即开启新的一轮（重新计时）。
 */
async function resetQuizSession(event, ctx) {
  const openid = requireOpenid(ctx);
  const user = await findOrCreateUser(openid);

  await clearRound(user._id);

  return sessionProgress({ active: false, correct: 0, answeredIds: [], remainingMs: ROUND_DURATION_MS });
}

/**
 * 发券：校验每日配额后插入。
 *
 * 每日上限只统计「答题奖励」券（source: 'quiz'），
 * 避免管理员补偿发放的券占用用户的答题奖励额度。
 * 券类型统一写中文标签，与后台发放的券保持一致（旧数据 'paper' 在读取时归一）。
 */
async function tryIssueCoupon(openid, milestone) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const todayCount = await db
    .collection('coupons')
    .where({ _openid: openid, source: 'quiz', createTime: command.gte(today) })
    .count()
    .catch(() => ({ total: 0 }));

  if ((todayCount.total || 0) >= DAILY_COUPON_LIMIT) {
    return null;
  }

  // 注：旧实现按「milestone + 当日」去重，而每轮达标时 milestone 恒为 5，
  // 当天第 2、3 轮达标都会被误判为重复发放 —— 每日上限 3 张实际只发得出 1 张。
  // 现已改由 claimRoundReward 的原子闸门防重复（同轮只发一次），这里只保留每日配额校验。
  // milestone 仍作为流水字段写入券记录，便于对账，但不再参与判重。

  const expireDate = new Date();
  expireDate.setDate(expireDate.getDate() + COUPON_VALID_DAYS);

  // 按权重随机发放一种券（免费 5% / 买2送1 15% / 8折 80%）
  const reward = pickWeighted(COUPON_REWARDS) || COUPON_REWARDS[0];

  const coupon = {
    _openid: openid,
    amount: reward.amount,
    // 与后台发放的券统一用中文标签（旧数据 'paper' 在读取时归一为「领纸券」）
    type: reward.type,
    desc: reward.desc,
    status: 'unused',
    source: 'quiz',
    milestone: milestone || null,
    expireDate: formatDate(expireDate),
    createTime: new Date(),
  };

  const result = await db.collection('coupons').add({ data: coupon });

  // 返回真实券信息，供前端弹窗直接使用（修复写死的有效期）
  return {
    id: result._id,
    amount: coupon.amount,
    type: coupon.type,
    desc: coupon.desc,
    expireDate: coupon.expireDate,
  };
}

/**
 * 结束本轮并返回成绩（用户主动点「结束本轮」或时间到后页面兜底调用）。
 *
 * 成绩在清空会话之前计算；reason 由服务端判定：
 * reached=答对达标 / expired=时间到 / manual=用户手动结束。
 */
async function finishQuizSession(event, ctx) {
  const openid = requireOpenid(ctx);
  const user = await findOrCreateUser(openid);
  const round = readRound(user);

  const summary = buildRoundSummary(round);
  const reason = round.reached ? 'reached' : (round.expired ? 'expired' : 'manual');

  await clearRound(user._id);

  return { ...summary, reason };
}

async function getHistory(event, ctx) {
  const openid = requireOpenid(ctx);
  const page = Math.max(parseInt(event.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(event.pageSize, 10) || 20, 1), 50);

  const [listResult, countResult] = await Promise.all([
    db
      .collection('quiz_records')
      .where({ _openid: openid })
      .orderBy('createTime', 'desc')
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .get(),
    db.collection('quiz_records').where({ _openid: openid }).count(),
  ]);

  const rawRecords = listResult.data || [];

  // 旧记录没存 explanation/type/difficulty —— 按 questionId 一次性批量回填（单次查询，非 N 次）
  const qIds = [...new Set(rawRecords.map((r) => r.questionId).filter((id) => id && !String(id).startsWith('local_')))];
  let questionMap = {};
  if (qIds.length > 0) {
    const qs = await db
      .collection('quiz_question')
      .where({ _id: command.in(qIds) })
      .limit(50)
      .get()
      .catch(() => ({ data: [] }));
    (qs.data || []).forEach((q) => { questionMap[q._id] = q; });
  }

  const records = rawRecords.map((r) => {
    const q = r.questionId ? questionMap[r.questionId] : null;
    return {
      questionId: r.questionId,
      question: r.question || (q && q.question) || '',
      // 选项取记录里的快照（题目后被编辑也不影响历史还原），缺失时回落到题库
      options: r.options || (q && q.options) || [],
      isCorrect: r.isCorrect,
      // 多选存数组，旧记录为单个数字——归一化后历史页统一按数组渲染字母
      userOptionIndices: toIndexArray(r.userOptionIndices ?? r.userOptionIndex),
      correctOptionIndices: toIndexArray(r.correctOptionIndices ?? r.correctOptionIndex),
      userOptionIndex: r.userOptionIndex,
      correctOptionIndex: r.correctOptionIndex,
      explanation: r.explanation || (q && q.explanation) || '',
      type: r.type || (q && q.type) || 'single',
      difficulty: r.difficulty || (q && q.difficulty) || 'medium',
      category: r.category || (q && q.category) || '',
      answerTime: r.answerTime,
      createTime: formatDateTime(r.createTime),
    };
  });

  return {
    // list 为统一字段名（小程序页面统一消费 data.list），records 为兼容别名
    list: records,
    records,
    total: countResult.total || 0,
    page,
    hasMore: page * pageSize < (countResult.total || 0),
  };
}

function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatDateTime(d) {
  if (!d) return '';
  const date = new Date(d);
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${formatDate(date)} ${hh}:${mm}`;
}

/** 客户端兜底题库，与旧 miniprogram 内置题库保持一致 */
function getFallbackBank() {
  return [
    {
      _id: 'local_1',
      question: '四季养生的原则包括?',
      options: ['春夏养阳', '秋冬消暑', '春夏养阴', '秋冬养阳'],
      correct: 0,
      explanation: '中医四季养生原则为"春夏养阳，秋冬养阴"',
    },
    {
      _id: 'local_2',
      question: '以下哪种药材有"国老"之称？',
      options: ['人参', '甘草', '枸杞', '黄芪'],
      correct: 1,
      explanation: '甘草能调和诸药，有"国老"之称',
    },
    {
      _id: 'local_3',
      question: '中医理论中，"五脏"不包括？',
      options: ['心', '肝', '胃', '肾'],
      correct: 2,
      explanation: '中医五脏为：心、肝、脾、肺、肾',
    },
    {
      _id: 'local_4',
      question: '以下哪种食物性温？',
      options: ['西瓜', '生姜', '梨', '绿豆'],
      correct: 1,
      explanation: '生姜性温，具有温中散寒的作用',
    },
    {
      _id: 'local_5',
      question: '《本草纲目》的作者是？',
      options: ['张仲景', '李时珍', '华佗', '孙思邈'],
      correct: 1,
      explanation: '《本草纲目》由明代医学家李时珍所著',
    },
  ];
}

exports.main = createHandler({
  random: getRandomQuestions,
  submit: submitAnswer,
  progress: getQuizProgress,
  reset: resetQuizSession,
  finish: finishQuizSession,
  history: getHistory,
});