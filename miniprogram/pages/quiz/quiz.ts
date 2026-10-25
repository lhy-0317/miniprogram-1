import { api } from '../../utils/api';

interface Question {
  _id: string;
  question: string;
  options: string[];
  correct?: number | number[];
  explanation?: string;
  /** single 单选 / judge 判断 / multi 多选 */
  type?: 'single' | 'judge' | 'multi';
}

/** 本地兜底判卷用：答案下标归一化为升序数组（兼容旧 number 形态） */
function normalizeIndices(v: any): number[] {
  const arr = Array.isArray(v) ? v : [v];
  return [...new Set(arr.map(Number).filter((n) => Number.isInteger(n) && n >= 0))].sort((a, b) => a - b);
}

/** 集合相等比较（多选判卷） */
function sameSet(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

Page({
  data: {
    // ===== 本次答题会话进度（服务端持久化，切页/退出后回来仍在）=====
    sessionActive: false,
    /** 本次已答对题数（累计，答错不清零） */
    sessionCorrect: 0,
    /** 还差几道得下一张券 */
    toNextCoupon: 5,
    /** 每累计答对多少道发一张券 */
    rewardEvery: 5,
    /** 本次已作答题数 */
    totalAnswered: 0,
    /** 本轮的限时时长（服务端下发，默认 3 分钟） */
    roundDurationMs: 180000,
    /** 本轮剩余毫秒（服务端下发，前端本地递减） */
    remainingMs: 180000,
    /** 倒计时展示文本 mm:ss */
    remainingText: '03:00',
    /** 剩余时间进入最后 30 秒时高亮提醒 */
    timerWarning: false,
    /** 本轮结束原因：reached=达标 / expired=时间到 / manual=手动 */
    roundReason: '',

    // ===== 当前题目与作答状态 =====
    currentQuestion: null as Question | null,
    questionLoading: false,
    selectedIndices: [] as number[],
    optionStates: [] as string[],
    isMulti: false,
    answered: false,
    isCorrect: false,
    correctOptionIndices: [] as number[],
    explanation: '',

    // ===== 页面状态 =====
    loading: true,
    quizStarted: false,
    showStartDialog: true,

    // ===== 本轮成绩卡 =====
    summaryVisible: false,
    summary: null as any,

    // ===== 动效与券 =====
    celebrating: false,
    particles: [] as any[],
    couponVisible: false,
    couponInfo: null as any,
  },

  /** 倒计时定时器句柄（Page 自定义字段，非 data） */
  timerId: null as any,
  /** 待展示的成绩（达标发券时先弹券，关闭券弹窗后再展示成绩） */
  pendingSummary: null as any,

  onLoad() {
    this.restoreSession();
  },

  /** 从其他页面切回来时刷新进度（答题不中断） */
  onShow() {
    if (this.data.quizStarted) {
      this.refreshProgress();
    }
  },

  /** 恢复本轮：进行中则继续答题（倒计时按服务端剩余时间接上）；已结束则直接展示成绩 */
  async restoreSession() {
    try {
      const res = await api.get('/api/quiz/progress');
      if (res.success && res.data) {
        // 本轮已结束（时间到/已达标）：服务端已结算，这里直接弹成绩卡
        if (res.data.roundFinished && res.data.summary && !res.data.summary.empty) {
          this.setData({
            loading: false,
            quizStarted: false,
            showStartDialog: false,
            summary: res.data.summary,
            roundReason: res.data.expired ? 'expired' : 'reached',
            summaryVisible: true,
          });
          return;
        }

        if (res.data.active) {
          this.setData({
            quizStarted: true,
            showStartDialog: false,
            loading: false,
            ...this.progressPatch(res.data),
          });
          this.startTimer(this.data.remainingMs);
          await this.loadNextQuestion();
          return;
        }
      }
    } catch {
      // 服务不可用时退回开始页
    }
    this.setData({ loading: false });
  },

  /** 只刷新进度，不动当前题目 */
  async refreshProgress() {
    try {
      const res = await api.get('/api/quiz/progress');
      if (res.success && res.data) {
        this.setData(this.progressPatch(res.data));
        // 切页回来用服务端剩余时间校正本地倒计时（时钟不因切页暂停）
        if (res.data.active) this.startTimer(this.data.remainingMs);
      }
    } catch {
      // 忽略：保持现有显示
    }
  },

  /** 把服务端进度映射到页面 data */
  progressPatch(d: any) {
    const remainingMs = typeof d.remainingMs === 'number' ? d.remainingMs : this.data.remainingMs;
    return {
      sessionActive: !!d.active,
      sessionCorrect: Number(d.sessionCorrect) || 0,
      totalAnswered: Number(d.answeredCount) || 0,
      toNextCoupon: Number(d.toNextCoupon) || this.data.rewardEvery,
      rewardEvery: Number(d.rewardEvery) || this.data.rewardEvery,
      remainingMs,
      remainingText: this.formatRemaining(remainingMs),
      roundDurationMs: Number(d.roundDurationMs) || this.data.roundDurationMs,
      timerWarning: remainingMs <= 30000,
    };
  },

  /** 毫秒 → mm:ss */
  formatRemaining(ms: number): string {
    const total = Math.max(Math.ceil(ms / 1000), 0);
    const mm = String(Math.floor(total / 60)).padStart(2, '0');
    const ss = String(total % 60).padStart(2, '0');
    return `${mm}:${ss}`;
  },

  /** 启动本地倒计时（以服务端下发的剩余时间为准；到 0 自动结算本轮） */
  startTimer(remainingMs: number) {
    this.stopTimer();
    this.setData({ remainingMs, remainingText: this.formatRemaining(remainingMs) });

    this.timerId = setInterval(() => {
      const left = Math.max(this.data.remainingMs - 1000, 0);
      this.setData({
        remainingMs: left,
        remainingText: this.formatRemaining(left),
        timerWarning: left <= 30000,
      });
      if (left <= 0) {
        this.stopTimer();
        this.finishRound('expired');
      }
    }, 1000);
  },

  stopTimer() {
    if (this.timerId) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
  },

  onUnload() {
    this.stopTimer();
  },

  /** 开始答题：若服务端已有会话则继续，否则新建 */
  async startQuiz() {
    this.setData({ quizStarted: true, showStartDialog: false });
    await this.loadNextQuestion();
  },

  /**
   * 结束本轮并展示成绩卡（服务端同时清空本轮会话）。
   * 由三个入口触发：用户点「结束本轮」、倒计时归零、服务端判定已结束。
   */
  async finishRound(reason?: string) {
    this.stopTimer();
    if (this.data.summaryVisible) return;
    if (this.data.questionLoading && !reason) return;

    wx.showLoading({ title: '统计中...' });
    try {
      const res = await api.post('/api/quiz/finish', {});
      wx.hideLoading();

      if (!res.success) {
        wx.showToast({ title: res.message || '操作失败', icon: 'none' });
        return;
      }

      if (res.data.empty) {
        wx.showToast({ title: '本轮还没有答题记录', icon: 'none' });
        this.backToStart();
        return;
      }

      this.stopCelebration();
      this.setData({
        summary: res.data,
        roundReason: reason || res.data.reason || 'manual',
        summaryVisible: true,
      });
    } catch {
      wx.hideLoading();
      wx.showToast({ title: '操作失败，请重试', icon: 'none' });
    }
  },

  /** 成绩卡：再来一轮（重新开始计时） */
  async startNewRound() {
    this.setData({
      summaryVisible: false,
      summary: null,
      roundReason: '',
      quizStarted: true,
      showStartDialog: false,
    });
    this.setData(this.progressPatch({
      active: false, sessionCorrect: 0, answeredCount: 0,
      toNextCoupon: this.data.rewardEvery, remainingMs: this.data.roundDurationMs || 180000,
    }));
    await this.loadNextQuestion();
  },

  /** 成绩卡：先歇会儿（回到开始页，本轮已结束） */
  backToStart() {
    this.stopTimer();
    this.setData({
      summaryVisible: false,
      summary: null,
      quizStarted: false,
      showStartDialog: true,
      currentQuestion: null,
      answered: false,
      selectedIndices: [],
      optionStates: [],
      correctOptionIndices: [],
      explanation: '',
      sessionCorrect: 0,
      totalAnswered: 0,
      toNextCoupon: this.data.rewardEvery,
    });
    this.stopCelebration();
  },

  /** 取下一题（服务端保证本次会话内不重复） */
  async loadNextQuestion() {
    this.stopCelebration();
    this.setData({
      questionLoading: true,
      answered: false,
      isCorrect: false,
      selectedIndices: [],
      optionStates: [],
      correctOptionIndices: [],
      explanation: '',
    });

    try {
      const res = await api.get('/api/quiz/random');

      // 本轮已结束（时间到 / 已达标）：服务端已结算，直接展示成绩
      if (res.success && res.data && res.data.roundFinished) {
        this.stopTimer();
        this.setData({ questionLoading: false });
        if (res.data.summary && !res.data.summary.empty) {
          this.setData({
            summary: res.data.summary,
            roundReason: res.data.expired ? 'expired' : 'reached',
            summaryVisible: true,
            quizStarted: false,
            showStartDialog: false,
          });
        } else {
          this.backToStart();
        }
        return;
      }

      if (res.success && res.data && res.data.question) {
        const q = res.data.question as Question;
        this.setData({
          currentQuestion: q,
          isMulti: q.type === 'multi',
          optionStates: q.options.map(() => ''),
          questionLoading: false,
          ...this.progressPatch(res.data),
        });
        // 首题即开局：按服务端剩余时间启动倒计时
        this.startTimer(this.data.remainingMs);
        return;
      }
      throw new Error((res && res.message) || '暂无题目');
    } catch {
      // 服务不可用：退回本地题库。判卷仍可提交（local_ 前缀由服务端兜底题库匹配）
      const local = this.pickLocalQuestion();
      if (local) {
        this.setData({
          currentQuestion: local,
          isMulti: local.type === 'multi',
          optionStates: local.options.map(() => ''),
          questionLoading: false,
        });
      } else {
        this.setData({ questionLoading: false });
        wx.showToast({ title: '题目加载失败，请稍后重试', icon: 'none' });
      }
    }
  },

  /** 本地兜底题库（仅在服务端不可用时使用） */
  pickLocalQuestion(): Question | null {
    const bank = this.getQuestionBank();
    const asked = this.data.currentQuestion ? [this.data.currentQuestion._id] : [];
    const candidates = bank.filter((q) => asked.indexOf(q._id) === -1);
    const pool = candidates.length > 0 ? candidates : bank;
    return pool[Math.floor(Math.random() * pool.length)] || null;
  },

  getQuestionBank(): Question[] {
    return [
      {
        _id: 'local_1',
        question: '四季养生的原则包括?',
        options: ['春夏养阳', '秋冬消暑', '春夏养阴', '秋冬养阳'],
        correct: [0],
        explanation: '中医四季养生原则为"春夏养阳，秋冬养阴"',
      },
      {
        _id: 'local_2',
        question: '以下哪种药材有"国老"之称？',
        options: ['人参', '甘草', '枸杞', '黄芪'],
        correct: [1],
        explanation: '甘草能调和诸药，有"国老"之称',
      },
      {
        _id: 'local_3',
        question: '中医理论中，"五脏"不包括？',
        options: ['心', '肝', '胃', '肾'],
        correct: [2],
        explanation: '中医五脏为：心、肝、脾、肺、肾',
      },
      {
        _id: 'local_4',
        question: '以下哪种食物性温？',
        options: ['西瓜', '生姜', '梨', '绿豆'],
        correct: [1],
        explanation: '生姜性温，具有温中散寒的作用',
      },
      {
        _id: 'local_5',
        question: '《本草纲目》的作者是？',
        options: ['张仲景', '李时珍', '华佗', '孙思邈'],
        correct: [1],
        explanation: '《本草纲目》由明代医学家李时珍所著',
      },
    ];
  },

  goBack() {
    wx.navigateBack();
  },

  /** 选项点击：多选切换选中态，单选/判断直接作答 */
  selectOption(e: any) {
    if (this.data.answered || this.data.questionLoading) return;

    const index = Number(e.currentTarget.dataset.index);
    const currentQuestion = this.data.currentQuestion;
    if (!currentQuestion) return;

    if (currentQuestion.type === 'multi') {
      const set = new Set(this.data.selectedIndices);
      if (set.has(index)) {
        set.delete(index);
      } else {
        set.add(index);
      }
      const selectedIndices = [...set].sort((a, b) => a - b);
      this.setData({
        selectedIndices,
        optionStates: this.buildOptionStates(selectedIndices, false, []),
      });
      return;
    }

    this.submitAnswer([index]);
  },

  /** 多选题确认按钮 */
  confirmMultiAnswer() {
    if (this.data.answered || this.data.questionLoading) return;
    if (this.data.selectedIndices.length === 0) {
      wx.showToast({ title: '请先选择答案', icon: 'none' });
      return;
    }
    this.submitAnswer([...this.data.selectedIndices].sort((a, b) => a - b));
  },

  buildOptionStates(selected: number[], answered: boolean, correct: number[]): string[] {
    const currentQuestion = this.data.currentQuestion;
    const count = currentQuestion ? currentQuestion.options.length : 0;
    return Array.from({ length: count }, (_, i) => {
      if (!answered) return selected.includes(i) ? 'picked' : '';
      if (correct.includes(i)) return 'correct';
      if (selected.includes(i)) return 'wrong';
      return '';
    });
  },

  async submitAnswer(indices: number[]) {
    const currentQuestion = this.data.currentQuestion;
    if (!currentQuestion) return;

    this.setData({ questionLoading: true });

    let isCorrect = false;
    let correctOptionIndices: number[] = [];
    let explanation = '';
    let couponIssued: any = null;
    let progress: any = null;
    let roundFinished = false;
    let roundSummary: any = null;
    let endReason = '';

    try {
      const res = await api.post('/api/quiz/submit', {
        questionId: currentQuestion._id,
        selectedOptionIndices: indices,
      });

      if (!res.success) throw new Error((res && res.message) || '提交失败');

      isCorrect = res.data.isCorrect;
      correctOptionIndices = Array.isArray(res.data.correctOptionIndices)
        ? res.data.correctOptionIndices
        : (res.data.correctOptionIndex !== undefined ? [res.data.correctOptionIndex] : []);
      explanation = res.data.explanation;
      couponIssued = res.data.couponIssued || null;
      progress = res.data;
      // 本轮是否结束（答对达标 → 自动结束；或服务端判定时间已到）
      roundFinished = !!res.data.roundFinished;
      roundSummary = res.data.summary || null;
      endReason = res.data.expired ? 'expired' : (res.data.reached ? 'reached' : '');
    } catch {
      // 服务不可用时本地兜底判卷（仅本地题库含答案；服务端题目不下发答案，按答错降级）
      const correct = normalizeIndices(currentQuestion.correct);
      isCorrect = sameSet(indices, correct);
      correctOptionIndices = correct;
      explanation = currentQuestion.explanation || '';
      wx.showToast({ title: '网络异常，已按本地结果判定', icon: 'none' });
    }

    const patch: any = {
      selectedIndices: indices,
      answered: true,
      isCorrect,
      explanation,
      correctOptionIndices,
      optionStates: this.buildOptionStates(indices, true, correctOptionIndices),
      questionLoading: false,
    };
    if (progress) Object.assign(patch, this.progressPatch(progress));
    this.setData(patch);

    if (isCorrect) {
      wx.vibrateShort({ type: 'heavy' });
      this.spawnFireworks();

      if (couponIssued) {
        this.setData({ couponInfo: couponIssued });
        setTimeout(() => {
          this.setData({ couponVisible: true });
        }, 500);
      }
    } else {
      wx.vibrateShort({ type: 'medium' });
    }

    // 本轮结束：达标（已发券）或时间到 → 停表并展示成绩卡
    if (roundFinished) {
      this.stopTimer();
      const reason = endReason || 'reached';

      if (couponIssued) {
        // 先让用户看到券弹窗，关闭后再展示成绩卡（避免两个弹窗叠一起）
        this.pendingSummary = { summary: roundSummary, reason };
      } else if (roundSummary && !roundSummary.empty) {
        this.setData({
          summary: roundSummary,
          roundReason: reason,
          summaryVisible: true,
          quizStarted: false,
          showStartDialog: false,
        });
      } else {
        this.backToStart();
      }
    }
  },

  closeCoupon() {
    this.setData({ couponVisible: false });

    // 达标发券后：关闭券弹窗再展示本轮成绩
    const pending = this.pendingSummary;
    if (pending) {
      this.pendingSummary = null;
      if (pending.summary && !pending.summary.empty) {
        this.setData({
          summary: pending.summary,
          roundReason: pending.reason,
          summaryVisible: true,
          quizStarted: false,
          showStartDialog: false,
        });
      } else {
        this.backToStart();
      }
    }
  },

  // ===== 答对烟花动效 =====
  spawnFireworks() {
    const colors = ['#fbbf24', '#fbbf24', '#2e7d32', '#4caf50', '#1565c0', '#ffffff'];
    const particles = [];
    for (let i = 0; i < 16; i++) {
      particles.push({
        x: Math.round(Math.random() * 560 + 20),
        y: Math.round(Math.random() * 260 + 20),
        color: colors[i % colors.length],
        delay: Math.round(Math.random() * 15) / 100,
        duration: Math.round((70 + Math.random() * 50)) / 100,
      });
    }
    this.setData({ particles, celebrating: true });
  },

  stopCelebration() {
    if (this.data.celebrating) {
      this.setData({ celebrating: false, particles: [] });
    }
  },
});
