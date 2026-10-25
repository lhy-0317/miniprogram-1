import { api } from '../../utils/api';

const OPTION_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];
const TYPE_TEXT: Record<string, string> = { single: '单选题', judge: '判断题', multi: '多选题' };
const DIFF_TEXT: Record<string, string> = { easy: '简单', medium: '中等', hard: '困难' };

interface DetailOption {
  letter: string;
  text: string;
  /** correct=正确答案项 / wrong=选错了的项 / '' 与作答无关 */
  state: string;
  /** 是否为用户所选 */
  picked: boolean;
}

interface QuizRecord {
  id: string;
  date: string;
  question: string;
  userAnswer: string;
  correctAnswer: string;
  isCorrect: boolean;
  explanation: string;
  typeText: string;
  difficultyText: string;
  durationText: string;
  detail: {
    question: string;
    options: DetailOption[];
    userAnswer: string;
    correctAnswer: string;
    explanation: string;
    category: string;
    typeText: string;
    difficultyText: string;
    difficultyKey: string;
    timeText: string;
    durationText: string;
    isCorrect: boolean;
  };
}

Page({
  data: {
    historyList: [] as QuizRecord[],
    detailVisible: false,
    detail: null as QuizRecord['detail'] | null,
  },

  onLoad() {
    this.loadQuizHistory();
  },

  async loadQuizHistory() {
    wx.showLoading({ title: '加载中...' });

    try {
      const res = await api.get('/api/quiz/history', { pageSize: 50 });

      if (res.success) {
        // 服务端统一返回 list，兼容旧版 records 字段名
        const raw = (res.data && (res.data.list || res.data.records)) || [];
        const historyList = raw.map((item: any) => this.formatRecord(item));
        this.setData({ historyList });
      }
    } catch {
      wx.showToast({ title: '加载失败', icon: 'error' });
    } finally {
      wx.hideLoading();
    }
  },

  /**
   * 时间展示：服务端已返回 'YYYY-MM-DD HH:mm'。
   * 注意：iOS（JSCore）下 new Date('2026-10-14 20:30') 会得到 Invalid Date（要求 ISO 带 T），
   * 直接重解析会导致显示 NaN-NaN-NaN，故优先使用服务端已格式化的字符串。
   */
  normalizeDate(raw: any): string {
    if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}/.test(raw)) {
      return raw.replace('T', ' ').slice(0, 16);
    }
    const d = raw ? new Date(raw) : new Date();
    const valid = !isNaN(d.getTime()) ? d : new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${valid.getFullYear()}-${pad(valid.getMonth() + 1)}-${pad(valid.getDate())} ${pad(valid.getHours())}:${pad(valid.getMinutes())}`;
  },

  /** 作答用时：毫秒 → 可读文案 */
  formatDuration(ms: any): string {
    const n = Number(ms);
    if (!n || n <= 0) return '';
    if (n < 60000) return `${(n / 1000).toFixed(1)} 秒`;
    const min = Math.floor(n / 60000);
    const sec = Math.round((n % 60000) / 1000);
    return `${min} 分 ${sec} 秒`;
  },

  formatRecord(record: any): QuizRecord {
    // 多选题为下标数组；旧记录为单个数字——统一归一化后渲染字母
    const userIndices: number[] = Array.isArray(record.userOptionIndices) && record.userOptionIndices.length
      ? record.userOptionIndices
      : (record.userOptionIndex !== undefined && record.userOptionIndex !== null ? [record.userOptionIndex] : []);
    const correctIndices: number[] = Array.isArray(record.correctOptionIndices) && record.correctOptionIndices.length
      ? record.correctOptionIndices
      : (record.correctOptionIndex !== undefined && record.correctOptionIndex !== null ? [record.correctOptionIndex] : []);

    const toLetters = (arr: number[]) => arr.map((i: number) => OPTION_LETTERS[i] || '?').join('、');

    const options: string[] = Array.isArray(record.options) ? record.options : [];
    const detailOptions: DetailOption[] = options.map((text: string, i: number) => {
      const isCorrect = correctIndices.indexOf(i) !== -1;
      const picked = userIndices.indexOf(i) !== -1;
      let state = '';
      if (isCorrect) state = 'correct';
      else if (picked) state = 'wrong';
      return { letter: OPTION_LETTERS[i] || '?', text, state, picked };
    });

    const typeKey = record.type || 'single';
    const diffKey = record.difficulty || 'medium';
    const userAnswer = userIndices.length ? toLetters(userIndices) : '未作答';
    const correctAnswer = toLetters(correctIndices);
    const timeText = this.normalizeDate(record.createTime);
    const durationText = this.formatDuration(record.answerTime);
    const typeText = TYPE_TEXT[typeKey] || '单选题';
    const difficultyText = DIFF_TEXT[diffKey] || '中等';

    return {
      id: record._id || record.id,
      date: timeText,
      question: record.question || '未知题目',
      userAnswer,
      correctAnswer,
      isCorrect: record.isCorrect || false,
      explanation: record.explanation || '',
      typeText,
      difficultyText,
      durationText,
      detail: {
        question: record.question || '未知题目',
        options: detailOptions,
        userAnswer,
        correctAnswer,
        explanation: record.explanation || '',
        category: record.category || '',
        typeText,
        difficultyText,
        difficultyKey: diffKey,
        timeText,
        durationText,
        isCorrect: record.isCorrect || false,
      },
    };
  },

  /** 点击列表项：打开放大的详情卡片 */
  openDetail(e: any) {
    const index = Number(e.currentTarget.dataset.index);
    const record = this.data.historyList[index];
    if (!record) return;
    this.setData({ detail: record.detail, detailVisible: true });
  },

  closeDetail() {
    this.setData({ detailVisible: false });
  },

  /** 阻止内容区点击穿透到遮罩关闭弹窗 */
  noop() {},
});
