/**
 * 云函数模块加载验证（本地）
 *
 * 用 wx-server-sdk mock 验证 7 个云函数的 common.js 与 index.js
 * 均可正常加载——模拟部署包内的模块解析。用法：
 *
 *   node scripts/verify-functions.js
 */

const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const MOCK = path.join(__dirname, 'wx-server-sdk-mock.js');

const orig = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...args) {
  if (request === 'wx-server-sdk') return MOCK;
  return orig.call(this, request, parent, ...args);
};

const FUNCTIONS = [
  'userService',
  'quizService',
  'couponService',
  'orderService',
  'deviceService',
  'feedbackService',
  'adminService',
];

let ok = 0;
for (const fn of FUNCTIONS) {
  require(path.join(ROOT, 'cloudfunctions', fn, 'common.js'));
  require(path.join(ROOT, 'cloudfunctions', fn, 'index.js'));
  ok++;
  console.log(`✓ ${fn}`);
}

console.log(`\n${ok}/${FUNCTIONS.length} 个云函数模块加载成功（含 common.js）`);
