/**
 * adminService 题库管理接口一次性单测（本地验证用，不参与部署）。
 * 用法：node scripts/test-questions.js
 */
const path = require('path');
const fs = require('fs');
const Module = require('module');

const orig = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...args) {
  if (request === 'wx-server-sdk') return path.resolve(__dirname, 'wx-server-sdk-mock.js');
  return orig.call(this, request, parent, ...args);
};

const svc = require(path.join(__dirname, '..', 'cloudfunctions', 'adminService', 'index.js'));

const H = { Authorization: 'Bearer mock-token', 'Content-Type': 'application/json' };

async function call(method, p, body, query) {
  const r = await svc.main({
    httpMethod: method,
    path: p,
    headers: H,
    body: body ? JSON.stringify(body) : undefined,
    query: query || {},
  });
  return { code: r.statusCode, b: JSON.parse(r.body) };
}

/** 模拟平台真实投递：GET 无请求体时 body 为空字符串 */
async function rawCall(event) {
  const r = await svc.main({ headers: H, ...event });
  return { code: r.statusCode, b: JSON.parse(r.body) };
}

/** 取出 HTML 中最长的一段内联 <script>（即页面主脚本） */
function maxScript(html) {
  const scripts = html.match(/<script>([\s\S]*?)<\/script>/g) || [];
  return scripts
    .map((s) => s.replace(/^<script>/, '').replace(/<\/script>$/, ''))
    .sort((a, b) => b.length - a.length)[0] || '';
}

/** 统计失败项：任何 FAIL 输出都会计入，末尾汇总并置退出码，避免只看尾部漏掉失败 */
let FAIL_COUNT = 0;
const __origLog = console.log;
console.log = (...args) => {
  // 检查整行：FAIL 常出现在第 2 个参数（如 'xx → FAIL(...)'），只看 args[0] 会漏计
  if (args.map((a) => String(a)).join(' ').indexOf('FAIL') !== -1) FAIL_COUNT++;
  __origLog(...args);
};

async function main() {
  let r = await call('POST', '/admin/api/admin/questions', {
    question: '对或错？', options: ['正确', '错误'], correct: 0,
    type: 'judge', difficulty: 'easy', category: '常识',
  });
  console.log('8  合法判断题  →', r.code, r.b.success ? 'OK' : r.b.message);

  r = await call('POST', '/admin/api/admin/questions/batch-delete', { ids: [] });
  console.log('9  批删空ids   →', r.code, r.b.message);

  r = await call('POST', '/admin/api/admin/questions/batch-delete', { ids: new Array(201).fill('x') });
  console.log('10 批删超限    →', r.code, r.b.message);

  r = await call('POST', '/admin/api/admin/questions/batch-delete', { ids: ['a', 'b'] });
  console.log('11 批删正常    →', r.code, r.b.success ? 'OK removed=' + (r.b.data && r.b.data.removed) : r.b.message);

  r = await call('POST', '/admin/api/admin/questions/import', {
    questions: [
      { question: 'ok1', options: ['A', 'B'], correct: 0 },
      { question: '', options: ['A', 'B'], correct: 0 },
      { question: 'ok2', options: ['对', '错'], correct: 1, type: 'judge', difficulty: 'hard' },
    ],
  });
  console.log('12 导入混合    →', r.code, r.b.message, 'failed=', JSON.stringify(r.b.data && r.b.data.failed));

  r = await call('POST', '/admin/api/admin/questions/import', {});
  console.log('13 导入非数组  →', r.code, r.b.message);

  r = await call('POST', '/admin/api/admin/questions/import', {
    questions: new Array(501).fill({ question: 'x', options: ['A', 'B'], correct: 0 }),
  });
  console.log('14 导入超限    →', r.code, r.b.message);

  r = await call('GET', '/admin/api/admin/questions/export');
  console.log('15 导出路由    →', r.code, r.b.success ? 'OK' : r.b.message);

  r = await call('GET', '/admin/api/admin/questions', { keyword: '.*', type: 'judge', difficulty: 'easy' });
  console.log('16 列表带筛选  →', r.code, r.b.success ? 'OK' : r.b.message);

  r = await call('PUT', '/admin/api/admin/questions/mock-row-id', { difficulty: 'hard' });
  console.log('17 局部更新    →', r.code, r.b.success ? 'OK' : r.b.message);

  // 18. 信封回归：所有列表类接口必须返回 {success, data}，否则页面读到空列表
  const listEndpoints = [
    '/admin/api/admin/dashboard/stats',
    '/admin/api/admin/users',
    '/admin/api/admin/coupons',
    '/admin/api/admin/quiz-records',
    '/admin/api/admin/questions',
  ];
  let envelopeOk = true;
  for (const ep of listEndpoints) {
    const res = await call('GET', ep);
    const good = res.b.success === true && res.b.data !== undefined;
    if (!good) envelopeOk = false;
    console.log('18 信封', ep.replace('/admin/api/admin', '').padEnd(14), '→', good ? 'OK' : `FAIL(${JSON.stringify(res.b).slice(0, 60)})`);
  }
  console.log(envelopeOk ? '18 信封回归全部通过' : '18 信封回归存在失败');

  // ===== 多选题校验（adminService）=====
  r = await call('POST', '/admin/api/admin/questions', {
    question: '多选测试', options: ['A', 'B', 'C', 'D'], correct: [0], type: 'multi',
  });
  console.log('19 多选仅1答案 →', r.code, r.b.message);

  r = await call('POST', '/admin/api/admin/questions', {
    question: '多选测试', options: ['A', 'B', 'C', 'D'], correct: [0, 2], type: 'multi',
  });
  console.log('20 多选合法    →', r.code, r.b.success ? 'OK' : r.b.message);

  r = await call('POST', '/admin/api/admin/questions', {
    question: '单选旧格式', options: ['A', 'B', 'C', 'D'], correct: 1, type: 'single',
  });
  console.log('21 数字答案兼容→', r.code, r.b.success ? 'OK' : r.b.message);

  r = await call('POST', '/admin/api/admin/questions', {
    question: '判断多答案', options: ['正确', '错误'], correct: [0, 1], type: 'judge',
  });
  console.log('22 判断多答案  →', r.code, r.b.message);

  // ===== quizService 多选判卷（走本地兜底题库 local_1，correct=0）=====
  const qsPath = path.join(__dirname, '..', 'cloudfunctions', 'quizService', 'index.js');
  const quiz = require(qsPath);

  // P1-3 之后必须先抽题：submit 只接受本轮下发过的题号
  // 为使判卷结果确定，预置唯一题目（单选，正确答案下标 0）
  const mockSdk = require('./wx-server-sdk-mock');
  mockSdk.__setRows('quiz_question', [{
    _id: 'test_q1', question: '判卷测试题', options: ['A', 'B', 'C', 'D'],
    correct: 0, type: 'single', category: '测试', difficulty: 'medium', explanation: '测试解析',
  }]);

  async function drawAndSubmit(payload) {
    const drawn = await quiz.main({ action: 'random' });
    const qid = drawn.data && drawn.data.question ? drawn.data.question._id : null;
    const res = await quiz.main({ action: 'submit', questionId: qid, questionIndex: 0, answerTime: 1000, ...payload });
    res._drawnId = qid;
    return res;
  }

  r = await drawAndSubmit({ selectedOptionIndices: [0] });
  console.log('23 判卷全对    →', r.data && r.data.isCorrect === true ? 'OK' : `FAIL(${JSON.stringify(r).slice(0, 90)})`);

  r = await drawAndSubmit({ selectedOptionIndices: [0, 1] });
  console.log('24 多选多选了  →', r.data && r.data.isCorrect === false ? 'OK' : `FAIL(${JSON.stringify(r).slice(0, 90)})`);

  r = await drawAndSubmit({ selectedOptionIndex: 0 });
  console.log('25 旧单选格式  →', r.data && r.data.isCorrect === true ? 'OK' : `FAIL(${JSON.stringify(r).slice(0, 90)})`);

  r = await drawAndSubmit({ selectedOptionIndices: [9] });
  console.log('26 答案越界    →', r.code === 400 || r.errMsg ? 'OK' : `FAIL(${JSON.stringify(r).slice(0, 90)})`);

  // 27. common 纯函数
  const common = require(path.join(__dirname, '..', 'cloudfunctions', 'common', 'index.js'));
  const { toIndexArray: tia, sameIndexSet: sis, couponTypeLabel: ctl, advanceQuizSession: cs } = common;
  console.log('27 toIndexArray→',
    JSON.stringify(tia(2)) === '[2]' &&
    JSON.stringify(tia([2, 0, 2])) === '[0,2]' &&
    JSON.stringify(tia('x')) === '[]' ? 'OK' : 'FAIL');
  // sameIndexSet 约定入参为升序数组（调用方均先经 toIndexArray 排序）
  console.log('28 sameIndexSet→', sis([0, 1], [0, 1]) === true && sis([0], [0, 1]) === false ? 'OK' : 'FAIL');

  // ===== 29. 空请求体回归（线上 GET 曾全被 400）=====
  r = await rawCall({ httpMethod: 'GET', path: '/admin/api/admin/questions', body: '', query: { page: '1', pageSize: '20' } });
  console.log('29 GET空body   →', r.code === 200 && r.b.success ? 'OK' : `FAIL(${r.code} ${r.b.message})`);

  r = await rawCall({ httpMethod: 'GET', path: '/admin/api/admin/questions', body: undefined });
  console.log('30 GET无body   →', r.code === 200 && r.b.success ? 'OK' : `FAIL(${r.code} ${r.b.message})`);

  r = await rawCall({ httpMethod: 'GET', path: '/admin/api/admin/users', body: '   ' });
  console.log('31 GET空白body →', r.code === 200 && r.b.success ? 'OK' : `FAIL(${r.code} ${r.b.message})`);

  // 32. 非法 JSON 仍应 400（不能因修复而放宽校验）
  r = await rawCall({ httpMethod: 'POST', path: '/admin/api/admin/questions/import', body: '{bad json' });
  console.log('32 非法JSON    →', r.code === 400 ? 'OK' : `FAIL(${r.code})`);

  // 33. base64 投递的请求体也能解析
  const b64 = Buffer.from(JSON.stringify({ ids: ['a'] }), 'utf8').toString('base64');
  r = await rawCall({ httpMethod: 'POST', path: '/admin/api/admin/questions/batch-delete', body: b64, isBase64Encoded: true });
  console.log('33 base64体    →', r.code === 200 ? 'OK' : `FAIL(${r.code} ${r.b.message})`);

  // 34. 诊断接口：应返回逐条探针结果
  r = await call('GET', '/admin/api/admin/diagnostics');
  const probes = (r.b.data && r.b.data.probes) || [];
  console.log('34 诊断接口    →',
    r.code === 200 && r.b.success && probes.length > 0 && probes.every((p) => typeof p.ok === 'boolean')
      ? `OK (${probes.length} 项探针)` : `FAIL(${r.code} ${r.b.message})`);

  // 35. 列表查询不再使用「无条件 where(where) + 链式 orderBy」与 skip(0) 反模式
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'cloudfunctions', 'adminService', 'index.js'), 'utf8');
  const unguardedChain = /\.where\(where\)\s*\n\s*\.orderBy/.test(src);
  const guarded = (src.match(/\? col\.where\(where\) : col/g) || []).length;
  const badSkip = /\.skip\(\(page - 1\) \* pageSize\)/.test(src);
  console.log('35 查询反模式  →',
    !unguardedChain && !badSkip && guarded >= 2 ? 'OK' : `FAIL(unguarded=${unguardedChain} skip=${badSkip} guarded=${guarded})`);

  // 36. 静态守卫：NodeList 上误用数组方法（曾致「all.every is not a function」整页加载失败）
  const ARRAY_ONLY = ['every', 'map', 'filter', 'some', 'reduce', 'sort', 'find', 'flatMap', 'includes', 'indexOf', 'concat'];
  const badUses = [];
  for (const file of fs.readdirSync(path.join(__dirname, '..', 'admin')).filter((f) => f.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(__dirname, '..', 'admin', file), 'utf8');

    const chained = /querySelectorAll\((?:[^()]|\([^()]*\))*\)\s*\.\s*(\w+)/g;
    let m;
    while ((m = chained.exec(html)) !== null) {
      if (ARRAY_ONLY.includes(m[1])) badUses.push(`${file}: querySelectorAll().${m[1]}()`);
    }

    const assign = /(?:const|let|var)\s+(\w+)\s*=\s*document\.querySelectorAll\(/g;
    while ((m = assign.exec(html)) !== null) {
      const varName = m[1];
      const use = new RegExp('\\b' + varName + '\\s*\\.\\s*(\\w+)\\s*\\(', 'g');
      let u;
      while ((u = use.exec(html)) !== null) {
        if (ARRAY_ONLY.includes(u[1]) && u.index > m.index) {
          badUses.push(`${file}: ${varName}.${u[1]}()（变量来自 querySelectorAll）`);
        }
      }
    }
  }
  console.log('36 NodeList滥用 →', badUses.length === 0 ? 'OK' : `FAIL(${badUses.join('; ')})`);

  // ===== 发券机制（连对计算 / 券类型归一 / 历史接口字段）=====

  // 37. computeStreak：连续答对计数
  const now = Date.now();
  const rec = (minAgo, correct, qid) => ({ isCorrect: correct, createTime: new Date(now - minAgo * 60000), questionId: qid });
  // 会话推进：新会话从 0 开始
  const s1 = cs(null, { isCorrect: true, questionId: 'a', now: now, idleMs: 60000 });
  console.log('37 新会话起算  →', s1.correct === 1 && s1.isNewSession === true ? 'OK' : `FAIL(${JSON.stringify(s1)})`);

  // 关键回归：**答错不清零**（旧实现把连对显示成进度，答错就从 2/5 掉到 0/5）
  const s2 = cs(
    { correct: 2, answeredIds: ['a', 'b'], updatedAt: new Date(now - 1000) },
    { isCorrect: false, questionId: 'c', now: now, idleMs: 60000 }
  );
  console.log('38 答错不清零  →', s2.correct === 2 && s2.answeredIds.length === 3 ? 'OK' : `FAIL(${JSON.stringify(s2)})`);

  // 答对则累计 +1
  const s3 = cs(
    { correct: 4, answeredIds: ['a', 'b'], updatedAt: new Date(now - 1000) },
    { isCorrect: true, questionId: 'c', now: now, idleMs: 60000 }
  );
  console.log('39 答对累计+1  →', s3.correct === 5 ? 'OK' : `FAIL(${JSON.stringify(s3)})`);

  // 同题重复提交不再累加（防重放）
  const s4 = cs(
    { correct: 3, answeredIds: ['a', 'b'], updatedAt: new Date(now - 1000) },
    { isCorrect: true, questionId: 'a', now: now, idleMs: 60000 }
  );
  console.log('40 同题不累加  →', s4.correct === 3 && s4.duplicated === true ? 'OK' : `FAIL(${JSON.stringify(s4)})`);

  // 闲置超时视为新一轮（累计与已答列表清零）
  const s5 = cs(
    { correct: 7, answeredIds: ['a'], updatedAt: new Date(now - 40 * 60 * 1000) },
    { isCorrect: true, questionId: 'z', now: now, idleMs: 30 * 60 * 1000 }
  );
  console.log('41 超时开新轮  →', s5.isNewSession === true && s5.correct === 1 ? 'OK' : `FAIL(${JSON.stringify(s5)})`);

  // 42. 券类型归一（旧数据 'paper' 应显示为「领纸券」）
  console.log('42 券类型归一  →',
    ctl('paper') === '领纸券' && ctl('shopping') === '购物券' && ctl('领纸券') === '领纸券' && ctl(undefined) === '领纸券'
      ? 'OK' : `FAIL(${ctl('paper')}/${ctl('shopping')}/${ctl(undefined)})`);

  // 43. 答题历史接口返回 list（曾只返回 records，而页面读 list → 历史页恒为空）
  const qs2 = require(path.join(__dirname, '..', 'cloudfunctions', 'quizService', 'index.js'));
  const hist = await qs2.main({ action: 'history', pageSize: 50 });
  console.log('43 历史list字段→',
    hist.success && Array.isArray(hist.data.list) && Array.isArray(hist.data.records)
      ? `OK (list=${hist.data.list.length})` : `FAIL(${JSON.stringify(hist).slice(0, 120)})`);

  // 44. 静态检查：轮次机制关键点齐全（2 分钟限时 / 答对 5 道达标 / 自动结束 / 券池 / 进度与重置）
  const qsSrc = fs.readFileSync(path.join(__dirname, '..', 'cloudfunctions', 'quizService', 'index.js'), 'utf8');
  const checks = {
    duration: /ROUND_DURATION_MS = 3 \* 60 \* 1000/.test(qsSrc),
    target: /ROUND_TARGET_CORRECT = 5/.test(qsSrc),
    pool: /COUPON_REWARDS = \[/.test(qsSrc),
    progress: /progress: getQuizProgress/.test(qsSrc),
    reset: /reset: resetQuizSession/.test(qsSrc),
    dedupe: /answeredIds/.test(qsSrc),
    autoEnd: /roundFinished: reached/.test(qsSrc),
    expireGuard: /round\.finished\)/.test(qsSrc),
    noStreak: !/computeStreak/.test(qsSrc),
  };
  const badChecks = Object.keys(checks).filter(k => !checks[k]);
  console.log('44 轮次机制    →', badChecks.length === 0 ? 'OK' : `FAIL(缺失: ${badChecks.join(',')})`);

  // 45. 后台页面重复声明守卫（曾致 index/users/coupons/quiz-records 四页全部不可用）
  // 原理：经典 script 共享全局词法作用域，admin-api.js 与页面内联脚本若声明同名 const/let，
  // 浏览器会在解析期内联脚本时抛 SyntaxError，页面所有函数都不存在。
  // 用 vm 把「共享脚本 + 内联脚本」拼成同一程序编译，可高保真复现该错误。
  const vm = require('vm');
  const sharedSrc = fs.readFileSync(path.join(__dirname, '..', 'admin', 'js', 'admin-api.js'), 'utf8');
  const dupErrors = [];
  const pagesUsingShared = [];

  for (const file of fs.readdirSync(path.join(__dirname, '..', 'admin')).filter(f => f.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(__dirname, '..', 'admin', file), 'utf8');
    const inline = maxScript(html);
    const usesShared = html.includes('js/admin-api.js');
    if (usesShared) pagesUsingShared.push(file);

    try {
      new vm.Script((usesShared ? sharedSrc + '\n' : '') + inline, { filename: file + '.combined.js' });
    } catch (e) {
      dupErrors.push(`${file}: ${e.message}`);
    }
  }

  // 同时兜底：显式禁止在页面里出现裸的 const/let API_BASE（最易犯的一处）
  for (const file of fs.readdirSync(path.join(__dirname, '..', 'admin')).filter(f => f.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(__dirname, '..', 'admin', file), 'utf8');
    if (html.includes('js/admin-api.js') && /^\s*(const|let|var)\s+API_BASE\s*=/m.test(html)) {
      dupErrors.push(`${file}: 重复声明 API_BASE`);
    }
  }

  console.log('45 重复声明守卫→', dupErrors.length === 0
    ? `OK (${pagesUsingShared.length} 个页面共用 admin-api.js 无冲突)`
    : `FAIL(${dupErrors.join(' | ')})`);

  // 46. 全局统计接口 + 发券模式
  r = await call('GET', '/admin/api/admin/quiz-records/stats');
  console.log('46 记录统计接口→', r.code === 200 && r.b.success && 'total' in (r.b.data || {}) ? 'OK' : `FAIL(${r.code} ${r.b.message})`);

  r = await call('POST', '/admin/api/admin/coupons', { amount: '免费', type: '领纸券', expireDays: 30, all: true });
  console.log('47 全员发券    →', r.code === 200 ? `OK (${r.b.message})` : `FAIL(${r.b.message})`);

  r = await call('POST', '/admin/api/admin/coupons', { amount: '免费', type: '领纸券', expireDays: 30, openid: 'abcd1234' });
  console.log('48 末8位发券   →', r.code === 200 ? `OK (${r.b.message})` : `INFO(${r.b.message})`);

  r = await call('POST', '/admin/api/admin/coupons', { amount: '免费' });
  console.log('49 无目标拦截  →', r.b.success === false ? `OK (${r.b.message})` : 'FAIL');

  // ===== 答题会话接口（quizService）=====
  const quizSvc = require(path.join(__dirname, '..', 'cloudfunctions', 'quizService', 'index.js'));

  const prog = await quizSvc.main({ action: 'progress' });
  console.log('50 进度接口    →', prog.success && 'sessionCorrect' in prog.data && 'toNextCoupon' in prog.data
    ? `OK (答对${prog.data.sessionCorrect} 差${prog.data.toNextCoupon})` : `FAIL(${JSON.stringify(prog).slice(0, 100)})`);

  const next = await quizSvc.main({ action: 'random' });
  console.log('51 单题抽题    →', next.success && 'question' in next.data && 'toNextCoupon' in next.data
    ? 'OK' : `FAIL(${JSON.stringify(next).slice(0, 100)})`);

  const drawn2 = await quizSvc.main({ action: 'random' });
  const issuedId = drawn2.data && drawn2.data.question ? drawn2.data.question._id : null;
  const sub = await quizSvc.main({ action: 'submit', questionId: issuedId, selectedOptionIndices: [0] });
  const sd = sub.data || {};
  console.log('52 提交返回进度→', sub.success && typeof sd.sessionCorrect === 'number' && typeof sd.toNextCoupon === 'number'
    ? `OK (答对${sd.sessionCorrect} 差${sd.toNextCoupon})` : `FAIL(${JSON.stringify(sub).slice(0, 120)})`);

  const reset = await quizSvc.main({ action: 'reset' });
  console.log('53 重置会话    →', reset.success && reset.data.sessionCorrect === 0 && reset.data.active === false
    ? 'OK' : `FAIL(${JSON.stringify(reset).slice(0, 100)})`);

  // 54. 答题历史返回详情卡片所需字段（options/explanation/type/difficulty）
  const hist2 = await quizSvc.main({ action: 'history', pageSize: 50 });
  const h0 = (hist2.data && hist2.data.list && hist2.data.list[0]) || {};
  const historyOk = ['options', 'explanation', 'type', 'difficulty', 'correctOptionIndices', 'userOptionIndices']
    .every((k) => k in h0);
  console.log('54 历史详情字段→', historyOk ? 'OK' : `FAIL(缺: ${['options','explanation','type','difficulty'].filter(k => !(k in h0)).join(',')})`);

  // 55. 结束本轮接口：返回成绩卡所需字段，并清空会话
  const fin = await quizSvc.main({ action: 'finish' });
  const fk = fin.data || {};
  const finishOk = fin.success && ['answered', 'correct', 'wrong', 'rate', 'coupons', 'empty'].every((k) => k in fk);
  console.log('55 本轮成绩接口→', finishOk ? `OK (empty=${fk.empty})` : `FAIL(${JSON.stringify(fin).slice(0, 120)})`);

  const progAfter = await quizSvc.main({ action: 'progress' });
  console.log('56 成绩后会话清→', progAfter.data && progAfter.data.sessionCorrect === 0 && progAfter.data.active === false
    ? 'OK' : `FAIL(${JSON.stringify(progAfter).slice(0, 100)})`);

  // 57. 静态检查：提交时把解析/题型落库（历史详情依赖）
  const qsSrc2 = fs.readFileSync(path.join(__dirname, '..', 'cloudfunctions', 'quizService', 'index.js'), 'utf8');
  const recordOk = /explanation,\s*\n\s*type: qType/.test(qsSrc2) || (/qType = questionDoc.type/.test(qsSrc2) && /type: qType/.test(qsSrc2));
  console.log('57 记录含解析  →', recordOk ? 'OK' : 'FAIL');

  // 58. 守卫：WXML 绑定使用的变量必须在页面 data 或方法中定义
  //（这类不匹配会让页面渲染空白，此前 usage-records 页踩过）
  const pageDir = path.join(__dirname, '..', 'miniprogram', 'pages');
  const BIND_WHITELIST = new Set(['item', 'index', 'i', 'true', 'false', 'null', 'undefined', 'wx', 'log']);
  const bindProblems = [];
  let scannedPages = 0;

  for (const page of fs.readdirSync(pageDir)) {
    const wxmlPath = path.join(pageDir, page, `${page}.wxml`);
    const tsPath = path.join(pageDir, page, `${page}.ts`);
    if (!fs.existsSync(wxmlPath) || !fs.existsSync(tsPath)) continue;
    scannedPages++;

    const wxml = fs.readFileSync(wxmlPath, 'utf8');
    const ts = fs.readFileSync(tsPath, 'utf8');

    const dataStart = ts.indexOf('data: {');
    const dataEnd = ts.indexOf('  methods') !== -1 ? ts.indexOf('  methods') : ts.length;
    const dataBlock = ts.slice(dataStart, dataEnd);
    const keys = new Set((dataBlock.match(/^\s{4}([a-zA-Z_$][\w$]*)\s*:/gm) || [])
      .map((l) => l.trim().replace(/:$/, '')));
    const methods = new Set((ts.match(/^\s{2}(?:async\s+)?([a-zA-Z_$][\w$]*)\s*\(/gm) || [])
      .map((l) => l.trim().replace(/\($/, '')));

    const idents = new Set();
    for (const m of wxml.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
      const cleaned = m[1].replace(/'[^']*'|"[^"]*"/g, ' ');
      for (const id of cleaned.matchAll(/(?<![\w.$])([a-zA-Z_$][\w$]*)/g)) {
        idents.add(id[1]);
      }
    }

    const missing = [...idents].filter((i) => !keys.has(i) && !methods.has(i) && !BIND_WHITELIST.has(i));
    if (missing.length) bindProblems.push(`${page}.wxml: ${missing.join(',')}`);
  }

  console.log('58 WXML绑定守卫→', bindProblems.length === 0
    ? `OK (${scannedPages} 个页面)`
    : `FAIL(${bindProblems.join(' | ')})`);

  // ===== 奖励券池：免费券 5% / 买2送1券 15% / 8折券 80%（合计 100%）=====
  const { pickWeighted: pick } = common;

  // 从真实源码解析券池（纯字符串切分，不用正则）：测的是线上配置本身，而非测试里另抄一份
  const quizSrc3 = fs.readFileSync(path.join(__dirname, '..', 'cloudfunctions', 'quizService', 'index.js'), 'utf8');
  const orderSrc3 = fs.readFileSync(path.join(__dirname, '..', 'cloudfunctions', 'orderService', 'index.js'), 'utf8');
  const poolStart = quizSrc3.indexOf('const COUPON_REWARDS');
  const poolBlock = quizSrc3.slice(poolStart, quizSrc3.indexOf('];', poolStart));
  const realPool = poolBlock
    .split('\n')
    .filter((line) => line.indexOf('weight:') !== -1)
    .map((line) => {
      const a = line.slice(line.indexOf("amount: '") + 9, line.indexOf("',", line.indexOf("amount: '")));
      const w = line.slice(line.indexOf('weight: ') + 8).replace(',', '').trim();
      return { amount: a, weight: parseInt(w, 10) || 0, line };
    });
  const weightSum = realPool.reduce((sum, r) => sum + r.weight, 0);

  // 59. 配置与结构：三档齐全、比例 5/15/80、合计 100、免费券类型正确、走加权随机发券
  const expectMap = { '免费': 5, '买2送1': 15, '8折': 80 };
  const confOk = realPool.length === 3
    && realPool.every((r) => expectMap[r.amount] === r.weight)
    && weightSum === 100;
  const freeLine = realPool.find((r) => r.amount === '免费');
  const freeTypeOk = !!freeLine && freeLine.line.indexOf("type: '领纸券'") !== -1;
  const pickerOk = quizSrc3.indexOf('pickWeighted(COUPON_REWARDS)') !== -1;
  const orderOk = orderSrc3.indexOf('couponTypeLabel(coupon.type)') !== -1;
  console.log('59 券池配置    →', confOk && freeTypeOk && pickerOk && orderOk
    ? `OK (${realPool.map((r) => r.amount + ' ' + r.weight + '%').join(' + ')} = ${weightSum}%；免费券=领纸券类型)`
    : `FAIL(配置=${confOk} 合计=${weightSum} freeType=${freeTypeOk} picker=${pickerOk} order=${orderOk})`);

  // 60. 加权随机边界（确定性，不依赖随机性）：0~5%→免费，5~20%→买2送1，20~100%→8折
  const bounds = [
    pick(realPool, () => 0).amount === '免费',
    pick(realPool, () => 0.0499).amount === '免费',
    pick(realPool, () => 0.05).amount === '买2送1',
    pick(realPool, () => 0.1999).amount === '买2送1',
    pick(realPool, () => 0.20).amount === '8折',
    pick(realPool, () => 0.9999).amount === '8折',
    pick([], () => 0.5) === null,
  ];
  console.log('60 概率边界    →', bounds.every(Boolean)
    ? 'OK (0~5%→免费, 5~20%→买2送1, 20~100%→8折)'
    : `FAIL(${JSON.stringify(bounds)})`);

  // 61. 分布抽样：20000 次应接近 5/15/80（容差各 ±2%）
  const hit = { '免费': 0, '买2送1': 0, '8折': 0 };
  for (let i = 0; i < 20000; i++) {
    const r = pick(realPool);
    if (r) hit[r.amount] = (hit[r.amount] || 0) + 1;
  }
  const pctOf = (k) => (hit[k] / 20000) * 100;
  const distOk = Math.abs(pctOf('免费') - 5) < 2
    && Math.abs(pctOf('买2送1') - 15) < 2
    && Math.abs(pctOf('8折') - 80) < 2;
  console.log('61 分布抽样    →', distOk
    ? `OK (免费 ${pctOf('免费').toFixed(1)}% / 买2送1 ${pctOf('买2送1').toFixed(1)}% / 8折 ${pctOf('8折').toFixed(1)}%)`
    : `FAIL(免费 ${pctOf('免费')}% / 买2送1 ${pctOf('买2送1')}% / 8折 ${pctOf('8折')}%)`);

  // ===== 反馈管理模块 =====
  r = await call('GET', '/admin/api/admin/feedback?page=1&pageSize=20');
  const fbList = r.b.data || {};
  console.log('62 反馈列表    →', r.code === 200 && r.b.success && Array.isArray(fbList.list) && 'total' in fbList
    ? `OK (共${fbList.total}条)` : `FAIL(${r.code})`);

  r = await call('GET', '/admin/api/admin/feedback', null, {
    status: 'pending', type: 'bug', keyword: '登录', startDate: '2026-10-01', endDate: '2026-10-14', page: '2', pageSize: '10',
  });
  console.log('63 反馈多条件筛→', r.code === 200 && r.b.success ? 'OK' : `FAIL(${r.code} ${r.b.message})`);

  r = await call('GET', '/admin/api/admin/feedback/stats');
  const fbs = r.b.data || {};
  const statsOk = r.code === 200 && ['total', 'pending', 'processing', 'resolved'].every((k) => k in fbs);
  console.log('64 反馈统计    →', statsOk ? `OK (全部${fbs.total}/待${fbs.pending})` : `FAIL(${r.code})`);

  r = await call('GET', '/admin/api/admin/feedback/mock-row-id');
  const fbd = r.b.data || {};
  console.log('65 反馈详情    →', r.code === 200 && fbd.feedback && 'submitter' in fbd && Array.isArray(fbd.imageUrls)
    ? 'OK' : `FAIL(${r.code} ${r.b.message})`);

  r = await call('PUT', '/admin/api/admin/feedback/mock-row-id', { status: 'resolved', reply: '已修复，感谢反馈' });
  console.log('66 处理反馈    →', r.code === 200 && r.b.success ? 'OK' : `FAIL(${r.b.message})`);

  r = await call('PUT', '/admin/api/admin/feedback/mock-row-id', { status: 'not-a-status' });
  console.log('67 非法状态拦截→', r.b.success === false ? `OK (${r.b.message})` : 'FAIL');

  r = await call('DELETE', '/admin/api/admin/feedback/mock-row-id');
  console.log('68 删除反馈    →', r.code === 200 && r.b.success ? 'OK' : `FAIL(${r.b.message})`);

  // 69. 权限控制：反馈接口必须要求有效 token（无 token 应 401）
  const noAuth = await rawCall({ httpMethod: 'GET', path: '/admin/api/admin/feedback', headers: {} });
  const noAuth2 = await rawCall({ httpMethod: 'DELETE', path: '/admin/api/admin/feedback/any-id', headers: {} });
  console.log('69 反馈鉴权    →', noAuth.code === 401 && noAuth2.code === 401
    ? 'OK (无 token → 401)' : `FAIL(${noAuth.code}/${noAuth2.code})`);

  // 70. 入口配置：6 个后台页面均含问题反馈入口，且反馈页存在
  const adminDir = path.join(__dirname, '..', 'admin');
  const sidebarPages = ['index.html', 'users.html', 'coupons.html', 'quiz-records.html', 'questions.html', 'feedback.html'];
  const missingEntry = sidebarPages.filter((f) => {
    const html = fs.readFileSync(path.join(adminDir, f), 'utf8');
    return !html.includes('feedback.html');
  });
  console.log('70 入口配置    →', missingEntry.length === 0 ? `OK (${sidebarPages.length} 页均有入口)` : `FAIL(缺: ${missingEntry})`);

  // ===== 轮次机制（2 分钟限时 / 答对 5 道达标结束）=====
  const { quizRoundState: roundState } = common;
  const t0 = new Date('2026-10-14T20:00:00').getTime();
  const RS = (elapsedMs, correct) => roundState(
    { startAt: new Date(t0), correct },
    { durationMs: 120000, targetCorrect: 5, now: t0 + elapsedMs }
  );

  // 71. 限时与达标判定
  const r1 = RS(0, 0);          // 刚开局
  const r2 = RS(60000, 3);      // 进行中
  const r3 = RS(119999, 4);     // 差 1 毫秒到期
  const r4 = RS(120000, 4);     // 时间到
  const r5 = RS(30000, 5);      // 提前达标
  const r6 = roundState(null, { durationMs: 120000, targetCorrect: 5, now: t0 });
  const ok71 = r1.active && !r1.finished && r1.remainingMs === 120000
    && r2.remainingMs === 60000 && !r2.finished
    && !r3.finished && r3.expired === false
    && r4.expired === true && r4.finished === true
    && r5.reached === true && r5.finished === true && r5.expired === false
    && r6.active === false && r6.finished === false;
  console.log('71 限时/达标   →', ok71 ? 'OK (2min 到期 或 答对5道 即结束)' : `FAIL(${JSON.stringify([r1, r3, r4, r5])})`);

  // 72. 守卫：云函数「使用了 common 的导出却没导入」（本轮真踩过：pickWeighted/quizRoundState 漏导入）
  const commonPath = path.join(__dirname, '..', 'cloudfunctions', 'common', 'index.js');
  const commonSrc = fs.readFileSync(commonPath, 'utf8');
  const exportBlock = commonSrc.slice(commonSrc.lastIndexOf('module.exports = {'));
  const exportedNames = (exportBlock.match(/^\s{2}([a-zA-Z_$][\w$]*),/gm) || [])
    .map((l) => l.trim().replace(',', ''));

  const importProblems = [];
  for (const fnDir of fs.readdirSync(path.join(__dirname, '..', 'cloudfunctions'))) {
    // common 目录自身是导出方，不作为使用方检查
    if (fnDir === 'common') continue;
    const fnPath = path.join(__dirname, '..', 'cloudfunctions', fnDir, 'index.js');
    if (!fs.existsSync(fnPath)) continue;
    const src = fs.readFileSync(fnPath, 'utf8');

    const importMatch = src.match(/const\s*\{([\s\S]*?)\}\s*=\s*require\('\.\/common'\)/);
    const imported = new Set((importMatch ? importMatch[1] : '').split(',').map((x) => x.trim()).filter(Boolean));

    // 函数内自建的同名实现（如 adminService 自己定义了 ok/fail）不算缺失
    const locallyDefined = new Set();
    for (const m of src.matchAll(/(?:^|\n)\s*(?:async\s+)?function\s+([a-zA-Z_$][\w$]*)/g)) locallyDefined.add(m[1]);
    for (const m of src.matchAll(/(?:^|\n)\s*(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=/g)) locallyDefined.add(m[1]);

    // 去掉注释与字符串，避免把说明文字当成代码
    const body = src
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ')
      .replace(/'[^']*'|"[^"]*"|`[^`]*`/g, ' ');

    const missing = exportedNames.filter((name) => {
      if (imported.has(name) || locallyDefined.has(name)) return false;
      return new RegExp(`\\b${name}\\s*\\(`).test(body) || new RegExp(`\\b${name}\\s*\\.`).test(body);
    });
    if (missing.length) importProblems.push(`${fnDir}: ${missing.join(',')}`);
  }
  console.log('72 导入完整性  →', importProblems.length === 0 ? 'OK' : `FAIL(使用了但未导入 → ${importProblems.join(' | ')})`);

  // 73. 轮次接口：结束后不再出题（超时/未开局都返回明确状态）
  const qsvc = require(path.join(__dirname, '..', 'cloudfunctions', 'quizService', 'index.js'));
  const rnd = await qsvc.main({ action: 'random' });
  const hasRoundFields = rnd.success && ['active', 'finished', 'remainingMs', 'rewardTarget', 'toNextCoupon']
    .every((k) => k in rnd.data);
  console.log('73 轮次接口字段→', hasRoundFields ? `OK (剩余${rnd.data.remainingMs}ms 目标${rnd.data.rewardTarget}道)` : `FAIL(${JSON.stringify(rnd).slice(0, 120)})`);

  // ===== 首页商店：商品目录与金额计算 =====
  const { calcShopOrder } = common;
  const catalog = [
    { id: 'a', name: '单包', price: 300, unit: '包' },
    { id: 'b', name: '3包装', price: 800, unit: '提' },
  ];

  // 74. 无券：按价目表合计
  const shop1 = calcShopOrder([{ productId: 'a', qty: 3 }, { productId: 'b', qty: 1 }], catalog, '');
  const ok74 = shop1.ok && shop1.subtotal === 3 * 300 + 800 && shop1.discount === 0 && shop1.payable === 1700;
  console.log('74 无券计价    →', ok74 ? `OK (¥${(shop1.payable / 100).toFixed(2)})` : `FAIL(${JSON.stringify(shop1)})`);

  // 75. 8折券（购物券）：整单 8 折
  const shop2 = calcShopOrder([{ productId: 'b', qty: 1 }], catalog, '购物券');
  const ok75 = shop2.ok && shop2.subtotal === 800 && shop2.payable === 640 && shop2.discount === 160;
  console.log('75 8折券       →', ok75 ? `OK (800→${shop2.payable}分)` : `FAIL(${JSON.stringify(shop2)})`);

  // 76. 买2送1券（优惠券）：每满 3 件免 1 件
  const shop3 = calcShopOrder([{ productId: 'a', qty: 3 }], catalog, '优惠券');
  const shop4 = calcShopOrder([{ productId: 'a', qty: 2 }], catalog, '优惠券');
  const ok76 = shop3.freeQty === 1 && shop3.discount === 300 && shop3.payable === 600
    && shop4.freeQty === 0 && shop4.discount === 0 && shop4.payable === 600;
  console.log('76 买2送1      →', ok76 ? 'OK (3件免1件；2件不送)' : `FAIL(${JSON.stringify([shop3, shop4])})`);

  // 77. 领纸券：免单 1 件（取最低价）+ 空清单拦截 + 旧写法兼容
  const shop5 = calcShopOrder([{ productId: 'a', qty: 1 }, { productId: 'b', qty: 1 }], catalog, '领纸券');
  const shop6 = calcShopOrder([], catalog, '');
  const shop7 = calcShopOrder([{ productId: 'a', qty: 2 }], catalog, 'paper');
  const ok77 = shop5.discount === 300 && shop5.payable === 800 && shop5.freeQty === 1
    && shop6.ok === false && shop7.couponLabel === '领纸券' && shop7.payable === 300;
  console.log('77 领纸券/边界 →', ok77 ? 'OK (免最低价一件；空单拦截；paper 兼容)' : `FAIL(${JSON.stringify([shop5, shop6, shop7])})`);

  // 78. 商店接口：商品目录 / 报价 / 下单 / 我的订单
  const orderSvc = require(path.join(__dirname, '..', 'cloudfunctions', 'orderService', 'index.js'));
  const prod = await orderSvc.main({ action: 'products' });
  const prodOk = prod.success && Array.isArray(prod.data.products) && prod.data.products.length > 0
    && prod.data.products.every((p) => p.id && p.name && typeof p.price === 'number' && p.price > 0);
  console.log('78 商品目录    →', prodOk ? `OK (${prod.data.products.length} 个商品)` : `FAIL(${JSON.stringify(prod).slice(0, 120)})`);

  const quote = await orderSvc.main({ action: 'quote', items: [{ productId: prod.data.products[0].id, qty: 2 }] });
  console.log('79 报价接口    →', quote.success && quote.data.subtotal === prod.data.products[0].price * 2
    ? `OK (¥${(quote.data.payable / 100).toFixed(2)})` : `FAIL(${JSON.stringify(quote).slice(0, 120)})`);

  const placed = await orderSvc.main({
    action: 'shopOrder',
    items: [{ productId: prod.data.products[0].id, qty: 2 }],
  });
  console.log('80 自助下单    →', placed.success && placed.data.orderSn && typeof placed.data.payable === 'number'
    ? `OK (${placed.data.orderSn} ¥${(placed.data.payable / 100).toFixed(2)})` : `FAIL(${JSON.stringify(placed).slice(0, 140)})`);

  const myOrders = await orderSvc.main({ action: 'myOrders' });
  console.log('81 我的订单    →', myOrders.success && Array.isArray(myOrders.data.list)
    ? `OK (${myOrders.data.total} 条)` : `FAIL(${JSON.stringify(myOrders).slice(0, 120)})`);

  // 82. 入口配置：tabBar 首项为商店，首页已从 tabBar 与 pages 移出且无残留跳转
  const appJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'miniprogram', 'app.json'), 'utf8'));
  const tabFirst = (appJson.tabBar.list || [])[0] || {};
  const shopInPages = appJson.pages.indexOf('pages/shop/shop') !== -1;
  const homeInTab = (appJson.tabBar.list || []).some((t) => t.pagePath.indexOf('pages/home') === 0);

  const strayHomeRefs = [];
  for (const dir of fs.readdirSync(path.join(__dirname, '..', 'miniprogram', 'pages'))) {
    const tsPath = path.join(__dirname, '..', 'miniprogram', 'pages', dir, `${dir}.ts`);
    if (!fs.existsSync(tsPath)) continue;
    const src = fs.readFileSync(tsPath, 'utf8');
    if (src.indexOf("'/pages/home/home'") !== -1 || src.indexOf('"/pages/home/home"') !== -1) {
      strayHomeRefs.push(`${dir}.ts`);
    }
  }
  const ok82 = tabFirst.pagePath === 'pages/shop/shop' && tabFirst.text === '商店' && shopInPages
    && !homeInTab && strayHomeRefs.length === 0;
  // 83. 守卫：WXML 中 wx:else / wx:elif 不能与 wx:for 写在同一标签
  //（wx:for 会占主导，导致 wx:else 找不到配对的 wx:if，直接编译报错）
  const wxmlProblems = [];
  const wxmlFiles = [];
  const collectWxml = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) collectWxml(full);
      else if (entry.name.endsWith('.wxml')) wxmlFiles.push(full);
    }
  };
  collectWxml(path.join(__dirname, '..', 'miniprogram', 'pages'));

  for (const file of wxmlFiles) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    let lastChainLine = -1;

    lines.forEach((line, idx) => {
      const hasIf = /wx:if\s*=/.test(line);
      const hasElif = /wx:elif\s*=/.test(line);
      const hasElse = /wx:else(\s|>|$|=)/.test(line);
      const hasFor = /wx:for\s*=/.test(line);

      if (hasIf || hasElif) lastChainLine = idx;

      if ((hasElif || hasElse) && hasFor) {
        wxmlProblems.push(`${path.basename(file)}:${idx + 1} wx:else/elif 与 wx:for 同标签`);
      }
      if ((hasElif || hasElse) && lastChainLine === -1) {
        wxmlProblems.push(`${path.basename(file)}:${idx + 1} wx:else/elif 缺少前置 wx:if`);
      }
    });
  }
  console.log('83 WXML条件守卫→', wxmlProblems.length === 0
    ? `OK (${wxmlFiles.length} 个 wxml)`
    : `FAIL(${wxmlProblems.join(' | ')})`);

  // ===== 订单记录与状态流转（使用记录 → 订单记录改造）=====
  const { canTransitionOrder, normalizeOrder, orderStatusText } = common;

  // 84. 订单状态机：合法流转与终态拦截
  const t84 = [
    canTransitionOrder('pending', 'paid') === true,
    canTransitionOrder('pending', 'cancelled') === true,
    canTransitionOrder('pending', 'failed') === true,
    canTransitionOrder('paid', 'completed') === true,
    canTransitionOrder('completed', 'paid') === false,
    canTransitionOrder('cancelled', 'paid') === false,
    canTransitionOrder('pending', 'completed') === false,
    canTransitionOrder('unknown', 'paid') === false,
  ];
  console.log('84 订单状态机  →', t84.every(Boolean) ? 'OK (待付款→已付款/取消；已付款→完成；终态不可逆)' : `FAIL(${JSON.stringify(t84)})`);

  // 85. 订单归一化：商店订单与旧取纸机订单字段都能统一
  const n1 = normalizeOrder({
    _id: 'o1', orderSn: 'S1', type: 'shop', title: '本色抽纸 · 单包',
    items: [{ name: '本色抽纸 · 单包', price: 300, qty: 2, amount: 600 }],
    subtotal: 600, discount: 100, payable: 500, status: 'paid',
  });
  const n2 = normalizeOrder({ _id: 'o2', orderSn: 'S2', deviceId: 'dev1', amount: 50, actualPay: 0, status: 'completed' });
  const t85 = [
    n1.itemCount === 2 && n1.payable === 500 && n1.statusText === '已付款',
    n2.subtotal === 50 && n2.payable === 0 && n2.type === 'paper',
    n2.items.length === 1 && n2.fulfillment === 'device',
    n1.fulfillment === 'pickup' && n1.statusText === orderStatusText('paid'),
  ];
  console.log('85 订单归一化  →', t85.every(Boolean) ? 'OK (商店/取纸机订单统一结构)' : `FAIL(${JSON.stringify([n1, n2])})`);

  // 86. 订单记录接口：字段、状态统计、支付通道标记
  const orderSvc2 = require(path.join(__dirname, '..', 'cloudfunctions', 'orderService', 'index.js'));
  const rec1 = await orderSvc2.main({ action: 'myOrders', pageSize: 10 });
  const d86 = rec1.data || {};
  const t86 = rec1.success
    && Array.isArray(d86.list)
    && ['all', 'pending', 'paid', 'completed'].every((k) => k in (d86.stats || {}))
    && 'paymentEnabled' in d86
    && (d86.list.length === 0 || ('statusText' in d86.list[0] && 'items' in d86.list[0] && 'payable' in d86.list[0]));
  console.log('86 订单记录接口→', t86 ? `OK (共${d86.total}条，待付款${d86.stats.pending})` : `FAIL(${JSON.stringify(d86).slice(0, 140)})`);

  // 87. 支付流转：待付款 → 已付款（体验版模拟通道）
  const paidRes = await orderSvc2.main({ action: 'pay', orderId: 'mock-row-id' });
  const t87 = paidRes.success && paidRes.data.status === 'paid' && paidRes.data.sandbox === true;
  console.log('87 订单支付    →', t87 ? `OK (${paidRes.data.statusText}，通道=${paidRes.data.payChannel})` : `FAIL(${JSON.stringify(paidRes).slice(0, 140)})`);

  // 88. 重复支付幂等（已付款再支付不报错、不重复流转）
  const paidAgain = await orderSvc2.main({ action: 'pay', orderId: 'mock-row-id' });
  console.log('88 重复支付幂等→', paidAgain.success && paidAgain.data.alreadyPaid === true ? 'OK' : `FAIL(${JSON.stringify(paidAgain).slice(0, 120)})`);

  // 89. 确认取货：已付款 → 已完成
  const confirmRes = await orderSvc2.main({ action: 'confirm', orderId: 'mock-row-id' });
  console.log('89 确认取货    →', confirmRes.success && confirmRes.data.status === 'completed'
    ? `OK (${confirmRes.data.statusText})` : `FAIL(${JSON.stringify(confirmRes).slice(0, 140)})`);

  // 90. 终态拦截：已完成订单不可再支付/取消
  const payClosed = await orderSvc2.main({ action: 'pay', orderId: 'mock-row-id' });
  const cancelClosed = await orderSvc2.main({ action: 'cancel', orderId: 'mock-row-id' });
  const t90 = payClosed.success === true && payClosed.data.alreadyPaid === true
    && cancelClosed.success === false;
  console.log('90 终态拦截    →', t90 ? `OK (${cancelClosed.message})` : `FAIL(pay=${JSON.stringify(payClosed).slice(0, 80)} cancel=${JSON.stringify(cancelClosed).slice(0, 80)})`);

  // 91. 页面与入口：订单记录页存在、旧使用记录页已移除、菜单与跳转一致
  const pagesDir = path.join(__dirname, '..', 'miniprogram', 'pages');
  const orderPageFiles = ['order-records.ts', 'order-records.wxml', 'order-records.wxss', 'order-records.json'];
  const orderPageOk = orderPageFiles.every((f) => fs.existsSync(path.join(pagesDir, 'order-records', f)));
  const legacyGone = !fs.existsSync(path.join(pagesDir, 'usage-records'));

  const appJson2 = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'miniprogram', 'app.json'), 'utf8'));
  const routeOk = appJson2.pages.indexOf('pages/order-records/order-records') !== -1
    && appJson2.pages.every((p) => p.indexOf('usage-records') === -1);

  const profileWxml = fs.readFileSync(path.join(pagesDir, 'profile', 'profile.wxml'), 'utf8');
  const menuOk = profileWxml.indexOf('订单记录') !== -1 && profileWxml.indexOf('使用记录') === -1;

  const pageJson = JSON.parse(fs.readFileSync(path.join(pagesDir, 'order-records', 'order-records.json'), 'utf8'));
  const titleOk = pageJson.navigationBarTitleText === '订单记录';

  const shopTs = fs.readFileSync(path.join(pagesDir, 'shop', 'shop.ts'), 'utf8');
  const shopLinkOk = shopTs.indexOf('/pages/order-records/order-records') !== -1;

  const t91 = orderPageOk && legacyGone && routeOk && menuOk && titleOk && shopLinkOk;
  console.log('91 订单记录入口→', t91
    ? 'OK (页面/路由/菜单/标题/商店跳转齐全，旧使用记录已移除)'
    : `FAIL(page=${orderPageOk} legacyGone=${legacyGone} route=${routeOk} menu=${menuOk} title=${titleOk} shopLink=${shopLinkOk})`);

  // ===== 后台订单管理模块 =====
  // 92. 订单列表：关键字段、状态统计、本页金额小计
  r = await call('GET', '/admin/api/admin/orders?page=1&pageSize=20');
  const od = r.b.data || {};
  const o0 = (od.list || [])[0] || {};
  const t92 = r.code === 200 && r.b.success
    && ['all', 'pending', 'paid', 'completed', 'cancelled'].every((k) => k in (od.stats || {}))
    && 'pagePayableSum' in od && 'pagePaidSum' in od
    && (!o0.orderSn ? false : ['userName', 'typeText', 'items', 'payable', 'statusText', 'createTime'].every((k) => k in o0));
  console.log('92 订单列表    →', t92 ? `OK (共${od.total}条，字段齐全)` : `FAIL(${JSON.stringify(od).slice(0, 160)})`);

  // 93. 订单筛选：状态 / 类型 / 关键字 / 下单时间区间
  r = await call('GET', '/admin/api/admin/orders', null, {
    status: 'completed', type: 'shop', keyword: 'ZHB', startDate: '2026-10-01', endDate: '2026-10-15', page: '1', pageSize: '10',
  });
  console.log('93 订单多条件筛→', r.code === 200 && r.b.success ? 'OK' : `FAIL(${r.code} ${r.b.message})`);

  // 94. 订单详情：订单 + 下单用户
  r = await call('GET', '/admin/api/admin/orders/mock-row-id');
  const det = r.b.data || {};
  const t94 = r.code === 200 && det.order && 'user' in det
    && Array.isArray(det.order.items) && 'subtotal' in det.order && 'payable' in det.order;
  console.log('94 订单详情    →', t94 ? `OK (${det.order.typeText}，用户=${det.user ? det.user.nickName : '无'})` : `FAIL(${r.code} ${r.b.message})`);

  // 95. 后台状态操作：新建订单 → 确认收款（pending→paid）→ 非法流转拦截
  const fresh = await orderSvc2.main({
    action: 'shopOrder',
    items: [{ productId: prod.data.products[0].id, qty: 1 }],
  });
  const freshId = fresh.data && fresh.data.orderId;
  r = await call('PUT', '/admin/api/admin/orders/' + freshId, { status: 'paid' });
  const paidOk = r.code === 200 && r.b.success && r.b.data.status === 'paid';
  r = await call('PUT', '/admin/api/admin/orders/' + freshId, { status: 'cancelled' });
  const guardOk = r.b.success === false && r.code === 409;
  r = await call('PUT', '/admin/api/admin/orders/' + freshId, { status: 'not-a-status' });
  const badStatusOk = r.b.success === false;
  console.log('95 后台状态操作→', paidOk && guardOk && badStatusOk
    ? 'OK (确认收款成功；已付款→已取消被拦截；非法状态被拒)'
    : `FAIL(paid=${paidOk} guard=${guardOk} bad=${badStatusOk})`);

  // 96. 后台订单页与入口：页面存在、7 个页面均有入口、元素 ID 一致
  const adminDir2 = path.join(__dirname, '..', 'admin');
  const ordersPageOk = fs.existsSync(path.join(adminDir2, 'orders.html'));
  const sidebarPages2 = ['index.html', 'users.html', 'coupons.html', 'quiz-records.html', 'questions.html', 'feedback.html', 'orders.html', 'products.html'];
  const missingEntry2 = sidebarPages2.filter((f) => {
    const html = fs.readFileSync(path.join(adminDir2, f), 'utf8');
    return !html.includes('orders.html') || !html.includes('products.html');
  });

  // 元素 ID 一致性：JS 里 getElementById 引用的 ID 必须在 HTML 中存在
  const idProblems = [];
  for (const f of fs.readdirSync(adminDir2).filter((x) => x.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(adminDir2, f), 'utf8');
    const scripts2 = html.match(/<script>([\s\S]*?)<\/script>/g) || [];
    const inline = scripts2.map((x) => x.replace(/^<script>/, '').replace(/<\/script>$/, ''))
      .sort((a, b) => b.length - a.length)[0] || '';
    const ids = new Set((inline.match(/getElementById\('([\w-]+)'\)/g) || [])
      .map((x) => x.replace(/getElementById\('|'\)/g, '')));
    const have = new Set((html.match(/id="([\w-]+)"/g) || []).map((x) => x.replace(/id="|"/g, '')));
    const miss = [...ids].filter((i2) => !have.has(i2));
    if (miss.length) idProblems.push(`${f}: ${miss.join(',')}`);
  }

  const t96 = ordersPageOk && missingEntry2.length === 0 && idProblems.length === 0;
  console.log('96 订单页与入口→', t96
    ? `OK (页面存在，${sidebarPages2.length} 页均有订单/商品入口，元素 ID 一致)`
    : `FAIL(page=${ordersPageOk} 缺入口=${missingEntry2} ID问题=${idProblems})`);

  // 97. 守卫：HTML/WXML 标签属性破损检测
  // 场景：用脚本批量改页面时，若 class="..." 被提前闭合（如 class="a" flex items-center ..."），
  // 游离属性会让元素丢失 display:flex → 布局错位（订单页侧边栏与上一项贴在一起就是这么来的）。
  // 判据：标签内的双引号必须成对，奇数即为破损。
  const markupFiles = [];
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'admin'))) {
    if (f.endsWith('.html')) markupFiles.push(path.join(__dirname, '..', 'admin', f));
  }
  const collectWxmlFiles = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) collectWxmlFiles(full);
      else if (entry.name.endsWith('.wxml')) markupFiles.push(full);
    }
  };
  collectWxmlFiles(path.join(__dirname, '..', 'miniprogram', 'pages'));

  const brokenTags = [];
  for (const file of markupFiles) {
    // 先屏蔽模板表达式：WXML 里 {{a > b}} 的 '>' 会截断标签匹配，导致误报
    const src = fs.readFileSync(file, 'utf8').replace(/\{\{[\s\S]*?\}\}/g, 'EXPR');
    for (const tag of src.match(/<[a-zA-Z][^>]*>/g) || []) {
      if ((tag.match(/"/g) || []).length % 2 === 1) {
        brokenTags.push(`${path.basename(file)}: ${tag.trim().slice(0, 70)}`);
      }
    }
  }
  console.log('97 标签属性守卫→', brokenTags.length === 0
    ? `OK (${markupFiles.length} 个页面，引号均成对)`
    : `FAIL(${brokenTags.slice(0, 3).join(' | ')})`);

  // ===== 代码审查报告 2026-10-15：P0-3 / P1-1 / P1-2 / P1-3 修复回归 =====
  const quizFixes = require(path.join(__dirname, '..', 'cloudfunctions', 'quizService', 'index.js'));
  const quizFixSrc = fs.readFileSync(path.join(__dirname, '..', 'cloudfunctions', 'quizService', 'index.js'), 'utf8');
  const adminFixSrc = fs.readFileSync(path.join(__dirname, '..', 'cloudfunctions', 'adminService', 'index.js'), 'utf8');

  // 98. P1-2：后台用户搜索必须转义正则（输入非法字符不再报错）
  const fixEscOk = adminFixSrc.indexOf('regexp: escapeRegExp(search)') !== -1;
  const fixEscCall = await call('GET', '/admin/api/admin/users', null, { search: '(', page: '1', pageSize: '10' });
  console.log('98 P1-2 搜索转义→', fixEscOk && fixEscCall.code === 200
    ? 'OK (输入 "(" 仍返回 200)'
    : `FAIL(转义=${fixEscOk} code=${fixEscCall.code})`);

  // 99. P1-3：提交「真实存在但本轮未下发」的题号必须被拒
  // 对比项是本轮真实下发的题：有闸门时伪造题号被拦（400），无闸门时会正常判卷（success）
  mockSdk.__setRows('quiz_question', []);
  await quizFixes.main({ action: 'reset' });

  const fixLegit = await quizFixes.main({ action: 'random' });
  const fixLegitId = fixLegit.data && fixLegit.data.question ? fixLegit.data.question._id : null;
  const fixBankIds = ['local_1', 'local_2', 'local_3', 'local_4', 'local_5'];
  const fixNotIssued = fixBankIds.find((id) => id !== fixLegitId) || 'local_1';

  const fixForged = await quizFixes.main({
    action: 'submit', questionId: fixNotIssued, selectedOptionIndices: [0],
  });
  const fixLegitSubmit = fixLegitId
    ? await quizFixes.main({ action: 'submit', questionId: fixLegitId, selectedOptionIndices: [0] })
    : null;

  const fixGateOk = fixForged.success === false && fixForged.code === 400
    && String(fixForged.message || '').indexOf('下发') !== -1;
  console.log('99 P1-3 题号校验→', fixGateOk && fixLegitSubmit && fixLegitSubmit.success === true
    ? `OK (${fixNotIssued} 未下发被拒；已下发的 ${fixLegitId} 正常判卷)`
    : `FAIL(fixForged=${JSON.stringify(fixForged).slice(0, 90)} fixLegit=${fixLegitSubmit && fixLegitSubmit.success})`);


  // 100. P1-1：题库为空走兜底时，不得下发 correct / explanation
  mockSdk.__setRows('quiz_question', []);
  const fixFb = await quizFixes.main({ action: 'random' });
  const fixFbQ = fixFb.data && fixFb.data.question;
  const fixFbOk = !!fixFbQ && fixFb.data.fromFallback === true
    && !('correct' in fixFbQ) && !('explanation' in fixFbQ)
    && ['_id', 'question', 'options', 'category', 'type'].every((k) => k in fixFbQ);
  console.log('100 P1-1 兜底字段→', fixFbOk
    ? 'OK (仅白名单字段，无 correct/explanation)'
    : `FAIL(${JSON.stringify(fixFbQ)})`);

  // 101. P0-3：连跑两轮达标，每日上限 3 张应真的能发出 2 张（修复前第 2 轮会被 milestone=5 去重挡住）
  const FIX_ANSWER = { local_1: 0, local_2: 1, local_3: 2, local_4: 1, local_5: 1 };
  const fixQuizCoupons = () => mockSdk.__getRows('coupons').filter((c) => c.source === 'quiz').length;

  const fixRunRound = async () => {
    await quizFixes.main({ action: 'reset' });
    let last = null;
    for (let i = 0; i < 5; i++) {
      const dr = await quizFixes.main({ action: 'random' });
      const q = dr.data && dr.data.question;
      if (!q) return { ok: false, reason: 'no question' };
      last = await quizFixes.main({
        action: 'submit', questionId: q._id,
        selectedOptionIndices: [FIX_ANSWER[q._id] === undefined ? 0 : FIX_ANSWER[q._id]],
      });
      if (!last.success) return { ok: false, reason: last.message };
      if (last.data && last.data.roundFinished) break;
    }
    return { ok: !!(last && last.data && last.data.roundFinished), issued: !!(last && last.data && last.data.couponIssued) };
  };

  const fixR1 = await fixRunRound();
  const fixAfter1 = fixQuizCoupons();
  const fixR2 = await fixRunRound();
  const fixAfter2 = fixQuizCoupons();

  console.log('101 P0-3 每日上限→', fixR1.ok && fixR2.ok && fixR1.issued && fixR2.issued && fixAfter1 === 1 && fixAfter2 === 2
    ? `OK (两轮各发 1 张，累计 ${fixAfter2} 张；修复前第 2 轮会因 milestone 去重而 0 张)`
    : `FAIL(fixR1=${JSON.stringify(fixR1)} fixR2=${JSON.stringify(fixR2)} counts=${fixAfter1}->${fixAfter2})`);

  // ===== 商品管理模块 =====
  // 102. 列表（空库）→ 导入默认商品 → 列表与统计
  let pmRes = await call('GET', '/admin/api/admin/products');
  const pmEmptyOk = pmRes.b.success && pmRes.b.data.total === 0 && pmRes.b.data.categories.length === 4;

  pmRes = await call('POST', '/admin/api/admin/products/seed', {});
  const pmSeedOk = pmRes.b.success && pmRes.b.data.count === 4;

  pmRes = await call('POST', '/admin/api/admin/products/seed', {});
  const pmSeedDupOk = pmRes.b.success === false;

  pmRes = await call('GET', '/admin/api/admin/products', null, { page: '1', pageSize: '10' });
  const pmData = pmRes.b.data || {};
  const pmRow0 = (pmData.list || [])[0] || {};
  const pmListOk = pmData.total === 4 && !!pmRow0.categoryText && !!pmRow0.statusText && 'stock' in pmRow0;
  console.log('102 列表/导入   →', pmEmptyOk && pmSeedOk && pmSeedDupOk && pmListOk
    ? `OK (空库 0 条→导入 4 条，重复导入被拒)`
    : `FAIL(empty=${pmEmptyOk} seed=${pmSeedOk} dup=${pmSeedDupOk} list=${pmListOk})`);

  // 103. 字段校验：六类非法输入均被拒，合法输入通过
  const pmBadCases = [
    { name: '短', category: 'tissue', price: 100, stock: 1, unit: '包' },
    { name: '合法名称', category: 'xxx', price: 100, stock: 1, unit: '包' },
    { name: '合法名称', category: 'tissue', price: 0, stock: 1, unit: '包' },
    { name: '合法名称', category: 'tissue', price: 100, stock: -1, unit: '包' },
    { name: '合法名称', category: 'tissue', price: 100, stock: 1, unit: '' },
    { name: '合法名称', category: 'tissue', price: 100, stock: 1, unit: '包', image: 'ftp://x/y.jpg' },
  ];
  const pmBadResults = [];
  for (const c of pmBadCases) {
    const rb = await call('POST', '/admin/api/admin/products', c);
    pmBadResults.push(rb.code === 400 && rb.b.success === false);
  }
  pmRes = await call('POST', '/admin/api/admin/products', {
    name: 'TestWipe 测试湿巾', category: 'wet', price: 1234, stock: 5, unit: '包',
    desc: '测试用', tag: '新品', image: 'https://example.com/a.jpg', sort: 5, status: 'off',
  });
  const pmValidOk = pmRes.code === 200 && pmRes.b.success && !!pmRes.b.data._id;
  console.log('103 字段校验    →', pmBadResults.every(Boolean) && pmValidOk
    ? 'OK (名称/分类/价格/库存/单位/图片 六类非法输入均 400，合法输入 200)'
    : `FAIL(${JSON.stringify(pmBadResults)} valid=${pmValidOk})`);

  // 104. 编辑 + 上下架切换
  const pmNewId = pmRes.b.data && pmRes.b.data._id;
  pmRes = await call('PUT', '/admin/api/admin/products/' + pmNewId, {
    name: 'TestWipe 测试湿巾（改）', category: 'wet', price: 2000, stock: 8, unit: '包',
    desc: '改后描述', tag: '', image: '', sort: 6, status: 'off',
  });
  const pmEditOk = pmRes.code === 200 && pmRes.b.success;

  pmRes = await call('POST', '/admin/api/admin/products/' + pmNewId + '/status', { status: 'on' });
  const pmOnOk = pmRes.code === 200 && pmRes.b.data.status === 'on';

  pmRes = await call('POST', '/admin/api/admin/products/' + pmNewId + '/status', { status: 'bad' });
  const pmBadStatusOk = pmRes.b.success === false;

  pmRes = await call('GET', '/admin/api/admin/products', null, { keyword: 'TestWipe', pageSize: '10' });
  const pmSearchOk = pmRes.b.data.total === 1 && pmRes.b.data.list[0].price === 2000 && pmRes.b.data.list[0].status === 'on';
  console.log('104 编辑/上下架 →', pmEditOk && pmOnOk && pmBadStatusOk && pmSearchOk
    ? 'OK (改价 20.00、上架成功、非法状态被拒、关键字检索命中)'
    : `FAIL(edit=${pmEditOk} on=${pmOnOk} bad=${pmBadStatusOk} search=${pmSearchOk})`);

  // 105. 分类筛选 + 删除（单个/批量/上限）
  pmRes = await call('GET', '/admin/api/admin/products', null, { category: 'tissue', pageSize: '10' });
  const pmCatOk = pmRes.b.data.total === 3 && pmRes.b.data.list.every((x) => x.category === 'tissue');

  pmRes = await call('DELETE', '/admin/api/admin/products/' + pmNewId);
  const pmDelOk = pmRes.code === 200 && pmRes.b.success;

  pmRes = await call('DELETE', '/admin/api/admin/products/' + pmNewId);
  const pmDelMissingOk = pmRes.b.success === false && pmRes.code === 404;

  pmRes = await call('GET', '/admin/api/admin/products', null, { pageSize: '20' });
  const pmTwoIds = (pmRes.b.data.list || []).slice(0, 2).map((x) => x._id);
  pmRes = await call('POST', '/admin/api/admin/products/batch-delete', { ids: pmTwoIds });
  const pmBatchOk = pmRes.b.success && pmRes.b.data.removed === 2;

  const pmManyIds = [];
  for (let i = 0; i < 51; i++) pmManyIds.push('x' + i);
  pmRes = await call('POST', '/admin/api/admin/products/batch-delete', { ids: pmManyIds });
  const pmLimitOk = pmRes.b.success === false;

  console.log('105 分类/删除   →', pmCatOk && pmDelOk && pmDelMissingOk && pmBatchOk && pmLimitOk
    ? 'OK (分类筛选 3 条；单个删除；重复删除 404；批量删 2 条；51 条超限被拒)'
    : `FAIL(cat=${pmCatOk} del=${pmDelOk} miss=${pmDelMissingOk} batch=${pmBatchOk} limit=${pmLimitOk})`);

  // 106. 商店联动：只出现在售商品；下架商品下单被拒
  const pmShopList = await orderSvc2.main({ action: 'products' });
  const pmShopIds = (pmShopList.data.products || []).map((x) => x.id);
  const pmFromDb = pmShopList.data.fromDefault === false;
  const pmRemainOn = await call('GET', '/admin/api/admin/products', null, { status: 'on', pageSize: '20' });
  const pmOnIds = (pmRemainOn.b.data.list || []).map((x) => x._id);
  const pmShopMatchOk = pmOnIds.length === pmShopIds.length && pmOnIds.every((id) => pmShopIds.indexOf(id) !== -1);

  // 取一个在售商品下架后，商店不再返回它，下单也被拒
  const pmTargetId = pmOnIds[0];
  await call('POST', '/admin/api/admin/products/' + pmTargetId + '/status', { status: 'off' });
  const pmShopList2 = await orderSvc2.main({ action: 'products' });
  const pmGoneOk = (pmShopList2.data.products || []).every((x) => x.id !== pmTargetId);
  const pmBuyOff = await orderSvc2.main({ action: 'shopOrder', items: [{ productId: pmTargetId, qty: 1 }] });
  const pmRejectOk = pmBuyOff.success === false && pmBuyOff.code === 409;

  console.log('106 商店联动    →', pmFromDb && pmShopMatchOk && pmGoneOk && pmRejectOk
    ? 'OK (商店读库；下架即从商店消失且下单被 409 拒绝)'
    : `FAIL(pmFromDb=${pmFromDb} match=${pmShopMatchOk} gone=${pmGoneOk} reject=${pmRejectOk})`);

  // 107. 库存：不足被拒；正常下单扣减；取消回补
  pmRes = await call('GET', '/admin/api/admin/products', null, { status: 'on', pageSize: '20' });
  const pmStockTarget = (pmRes.b.data.list || [])[0];
  await call('PUT', '/admin/api/admin/products/' + pmStockTarget._id, {
    name: pmStockTarget.name, category: pmStockTarget.category, price: pmStockTarget.price,
    stock: 1, unit: pmStockTarget.unit, desc: pmStockTarget.desc || '', tag: pmStockTarget.tag || '',
    image: pmStockTarget.image || '', sort: pmStockTarget.sort || 0, status: 'on',
  });

  const pmOverBuy = await orderSvc2.main({ action: 'shopOrder', items: [{ productId: pmStockTarget._id, qty: 2 }] });
  const pmOverOk = pmOverBuy.success === false && pmOverBuy.code === 409;

  const pmGoodBuy = await orderSvc2.main({ action: 'shopOrder', items: [{ productId: pmStockTarget._id, qty: 1 }] });
  const pmBuyOk = pmGoodBuy.success === true;

  const pmAfterBuy = await call('GET', '/admin/api/admin/products', null, { pageSize: '20' });
  const pmStockAfterBuy = (pmAfterBuy.b.data.list || []).find((x) => x._id === pmStockTarget._id);
  const pmDeductOk = pmStockAfterBuy && Number(pmStockAfterBuy.stock) === 0;

  const pmCancelRes = await orderSvc2.main({ action: 'cancel', orderId: pmGoodBuy.data && pmGoodBuy.data.orderId });
  const pmAfterCancel = await call('GET', '/admin/api/admin/products', null, { pageSize: '20' });
  const pmStockAfterCancel = (pmAfterCancel.b.data.list || []).find((x) => x._id === pmStockTarget._id);
  const pmRestoreOk = pmCancelRes.success && pmStockAfterCancel && Number(pmStockAfterCancel.stock) === 1;

  console.log('107 库存联动    →', pmOverOk && pmBuyOk && pmDeductOk && pmRestoreOk
    ? 'OK (库存 1 时买 2 件被拒；买 1 件后为 0；取消订单回补为 1)'
    : `FAIL(over=${pmOverOk} buy=${pmBuyOk} deduct=${pmDeductOk} restore=${pmRestoreOk} stock=${pmStockAfterCancel && pmStockAfterCancel.stock})`);

  console.log('82 商店入口    →', ok82
    ? `OK (tabBar 首项=${tabFirst.text}，无残留首页跳转)`
    : `FAIL(tab=${tabFirst.pagePath}/${tabFirst.text} inPages=${shopInPages} homeInTab=${homeInTab} 残留=${strayHomeRefs})`);
}

main()
  .then(() => {
    __origLog(`\n总计完成：失败 ${FAIL_COUNT} 项`);
    process.exitCode = FAIL_COUNT > 0 ? 1 : 0;
  })
  .catch((e) => {
    __origLog('测试脚本异常终止：', e);
    process.exitCode = 1;
  });