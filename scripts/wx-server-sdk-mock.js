/**
 * wx-server-sdk 最小内存 mock —— 仅用于本地单测，不参与部署。
 *
 * 设计要点（前几轮踩坑后升级）：
 * 1. **按集合隔离的内存表**：db.collection('users') 与 db.collection('orders') 各持一份数据，
 *    写入互不污染，避免跨用例串味。
 * 2. **写操作真实落盘**：《doc().update() / where().update() / add() / remove()》都会修改内存行，
 *    因此"支付→确认取货"这类**多步状态流转**才能被测试覆盖（旧 mock 的 update 是空操作，
 *    导致这类流程根本无法验证）。
 * 3. **支持 command 操作符与 db.RegExp**：gte/lte/inc 与正则条件按语义求值，
 *    使日期区间筛选、原子自增等真实逻辑可测。
 * 4. 方法集用 Proxy 兜底：未实现的方法返回链式自身，避免云函数调用新 API 时直接崩。
 */

/** 各集合的初始行（每个集合一份克隆，字段兼顾用户/题目/订单/券等多种场景） */
const BASE_ROW = {
  _id: 'mock-row-id',
  _openid: 'mock-openid-1234567890abcdef',
  token: 'mock-token',
  expireAt: '2099-01-01T00:00:00Z',
  username: 'mock',
  nickName: 'mock用户',
  quizCount: 3,
  savedPaper: 2,
  createTime: '2026-10-14T10:00:00.000Z',

  // 题目场景
  question: 'mock 题目',
  options: ['选项A', '选项B', '选项C', '选项D'],
  correct: [1],
  type: 'single',
  difficulty: 'medium',
  category: '测试分类',
  explanation: 'mock 解析',

  // 答题轮次（进行中，使 submit 走真实判卷分支）
  sessionStartAt: new Date(),
  sessionCorrect: 0,
  sessionAnsweredIds: [],
  sessionCoupons: 0,

  // 订单场景
  status: 'pending',
  orderSn: 'ZHB20261015MOCK0001',
  payable: 600,
  subtotal: 600,
  discount: 0,

  // 优惠券场景
  amount: '买2送1',
  couponType: '优惠券',
  expireDate: '2099-12-31',
};

/** 调用者 openid（与初始行一致，使归属校验路径可被覆盖） */
const OPENID = BASE_ROW._openid;

function clone(v) {
  if (v instanceof Date) return new Date(v.getTime());
  if (Array.isArray(v)) return v.map(clone);
  if (v && typeof v === 'object') {
    const out = {};
    Object.keys(v).forEach((k) => { out[k] = clone(v[k]); });
    return out;
  }
  return v;
}

/**
 * 按集合微调初始行：避免"题目场景"的字段（如 type:'single'）污染订单/券，
 * 使各接口在单测里拿到的数据结构贴近真实。
 */
const COLLECTION_OVERRIDES = {
  orders: { type: 'shop', title: '本色抽纸 · 单包', fulfillment: 'pickup' },
  coupons: { status: 'unused', type: '优惠券', amount: '买2送1', desc: '买2送1券' },
  quiz_records: { isCorrect: true },
  feedback: { status: 'pending', content: 'mock 反馈内容', feedbackType: 'other' },
};

/** 集合名 → 行数组（惰性初始化） */
const store = {};
let seq = 0;

/** 这些集合默认为空（贴近真实的新集合，避免 mock 自带脏数据） */
const EMPTY_COLLECTIONS = ['products'];

function table(name) {
  if (!store[name]) {
    store[name] = EMPTY_COLLECTIONS.indexOf(name) !== -1
      ? []
      : [Object.assign(clone(BASE_ROW), clone(COLLECTION_OVERRIDES[name] || {}))];
  }
  return store[name];
}

/** 判断单个字段是否满足条件（支持等值、command 操作符、db.RegExp） */
function matchField(value, cond) {
  if (cond && typeof cond === 'object' && cond.__regexp !== undefined) {
    try {
      return new RegExp(cond.__regexp, cond.__options || '').test(String(value === undefined ? '' : value));
    } catch (e) {
      return false;
    }
  }

  if (cond && typeof cond === 'object' && cond.__op) {
    // 字段级组合：createTime: and(gte(x), lte(y))
    if (cond.__op === 'and' || cond.__op === 'or') {
      const raw = cond.args || [];
      const parts = raw.length === 1 && Array.isArray(raw[0]) ? raw[0] : raw;
      const test = (c) => matchField(value, c);
      return cond.__op === 'and' ? parts.every(test) : parts.some(test);
    }

    const target = cond.args && cond.args[0];
    if (cond.__op === 'gte') return new Date(value || 0).getTime() >= new Date(target || 0).getTime();
    if (cond.__op === 'lte') return new Date(value || 0).getTime() <= new Date(target || 0).getTime();
    if (cond.__op === 'eq') return value === target;
    if (cond.__op === 'neq') return value !== target;
    if (cond.__op === 'in' && Array.isArray(target)) return target.indexOf(value) !== -1;
    if (cond.__op === 'nin' && Array.isArray(target)) return target.indexOf(value) === -1;
    // 其余操作符（and/or/in 等）在单测场景下不做过滤
    return true;
  }

  return value === cond;
}

function matches(row, cond) {
  if (!cond) return true;
  // 顶层组合：where(or([{name: re}, {desc: re}])) / where(and([...]))
  // 注意 command.or([...]) 的参数是**嵌套数组**（args[0] 为条件数组），需先摊平
  if (cond.__op === 'and' || cond.__op === 'or') {
    const raw = cond.args || [];
    const parts = raw.length === 1 && Array.isArray(raw[0]) ? raw[0] : raw;
    return cond.__op === 'and'
      ? parts.every((c) => matches(row, c))
      : parts.some((c) => matches(row, c));
  }
  return Object.keys(cond).every((k) => matchField(row[k], cond[k]));
}

/** 应用更新数据（支持 command.inc 原子自增） */
function applyUpdate(row, data) {
  Object.keys(data || {}).forEach((k) => {
    const v = data[k];
    if (v && typeof v === 'object' && v.__op === 'inc') {
      row[k] = (Number(row[k]) || 0) + Number((v.args && v.args[0]) || 0);
    } else if (v && typeof v === 'object' && v.__op === 'push') {
      // 数组追加（云数据库 command.push 语义）
      if (!Array.isArray(row[k])) row[k] = [];
      const add = v.args && v.args[0];
      if (Array.isArray(add)) row[k] = row[k].concat(clone(add));
      else row[k].push(clone(add));
    } else if (v && typeof v === 'object' && v.__op === 'pull') {
      const target = v.args && v.args[0];
      if (Array.isArray(row[k])) row[k] = row[k].filter((x) => x !== target);
    } else {
      row[k] = clone(v);
    }
  });
}

/** 不可解析为对象时，SQL 语义上的 doc().get() 用 _id 精确命中 */
function select(name, state) {
  let rows = table(name).filter((r) => matches(r, state.cond));
  if (state.skip) rows = rows.slice(state.skip);
  if (state.limit) rows = rows.slice(0, state.limit);
  return rows;
}

function makeDoc(name, id) {
  const find = () => table(name).find((r) => r._id === id) || null;

  let api = {
    get: () => {
      const row = find();
      // 真实 SDK 的 doc().get() 查不到会 reject，这里返回 null 由调用方兜底
      return Promise.resolve({ data: row ? clone(row) : null });
    },
    update: ({ data } = {}) => {
      const row = find();
      if (!row) return Promise.resolve({ stats: { updated: 0 } });
      applyUpdate(row, data);
      return Promise.resolve({ stats: { updated: 1 } });
    },
    set: ({ data } = {}) => {
      const rows = table(name);
      const idx = rows.findIndex((r) => r._id === id);
      const next = Object.assign({ _id: id }, clone(data));
      if (idx === -1) rows.push(next); else rows[idx] = next;
      return Promise.resolve({ stats: { updated: 1 } });
    },
    remove: () => {
      const rows = table(name);
      const idx = rows.findIndex((r) => r._id === id);
      if (idx !== -1) rows.splice(idx, 1);
      return Promise.resolve({ stats: { removed: idx === -1 ? 0 : 1 } });
    },
    field: () => api,
  };

  return wrap(api);
}

/** 未实现的方法兜底为链式自身，避免云函数调用新 API 时直接崩 */
function wrap(api) {
  return new Proxy(api, {
    get(target, key) {
      if (key === 'then') return undefined; // 关键：避免 await 把链式对象当 thenable
      if (key in target) return target[key];
      return () => wrap(api);
    },
  });
}

function makeQuery(name, state = {}) {
  const api = {
    where: (cond) => makeQuery(name, Object.assign({}, state, { cond })),
    orderBy: () => wrap(api),
    skip: (n) => makeQuery(name, Object.assign({}, state, { skip: n })),
    limit: (n) => makeQuery(name, Object.assign({}, state, { limit: n })),
    field: () => wrap(api),
    get: () => Promise.resolve({ data: select(name, state).map(clone) }),
    count: () => Promise.resolve({ total: select(name, state).length }),
    add: ({ data } = {}) => {
      seq += 1;
      const row = Object.assign({ _id: `mock-${name}-${seq}` }, clone(data));
      table(name).push(row);
      return Promise.resolve({ _id: row._id });
    },
    doc: (id) => makeDoc(name, id),
    update: ({ data } = {}) => {
      const rows = select(name, state);
      rows.forEach((r) => applyUpdate(r, data));
      return Promise.resolve({ stats: { updated: rows.length } });
    },
    remove: () => {
      const rows = select(name, state);
      const ids = rows.map((r) => r._id);
      const arr = table(name);
      for (let i = arr.length - 1; i >= 0; i--) {
        if (ids.indexOf(arr[i]._id) !== -1) arr.splice(i, 1);
      }
      return Promise.resolve({ stats: { removed: ids.length } });
    },
  };

  return wrap(api);
}

/** command 操作符桩：保留操作名与参数，供 mock 求值 */
const commandStub = new Proxy(
  {},
  {
    get(_target, key) {
      if (key === 'then') return undefined;
      if (key === 'aggregate') return commandStub;
      return (...args) => ({ __op: String(key), args });
    },
  }
);

const db = {
  collection: (name) => makeQuery(name),
  command: commandStub,
  RegExp: ({ regexp, options }) => ({ __regexp: regexp, __options: options }),
};

module.exports = {
  DYNAMIC_CURRENT_ENV: Symbol('DYNAMIC_CURRENT_ENV'),
  init() {},
  database: () => db,
  getWXContext: () => ({ OPENID }),
  cloud: { Cloud() {} },
  RegExp: db.RegExp,
  command: commandStub,
  /** 仅供测试读取数据（如统计已发放的券数量） */
  __getRows: (name) => table(name).map(clone),
  /** 仅供测试预置数据：整体替换某集合的行（如把题库清空以走兜底分支） */
  __setRows: (name, rows) => {
    store[name] = Array.isArray(rows) ? rows.map(clone) : [];
  },
  /** 仅供测试复位使用 */
  __resetStore: () => {
    Object.keys(store).forEach((k) => { delete store[k]; });
    seq = 0;
  },
};
