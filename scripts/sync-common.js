/**
 * 云函数 common 库同步脚本
 *
 * 解决的部署陷阱：云函数里 require('../common') 指向部署包之外的文件，
 * 单独上传任何函数都会失败（common 不在函数包内）。
 *
 * 方案：把 cloudfunctions/common/index.js 复制为每个业务函数目录下的
 * common.js，函数内统一 require('./common')。一条命令完成同步：
 *
 *   npm run sync:common
 *
 * 新增业务云函数时，把它加进 FUNCTIONS 数组即可。
 * 也可用 CloudBase「函数层 Layer」替代本方案，二选一。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const COMMON_SRC = path.join(ROOT, 'cloudfunctions', 'common', 'index.js');

const FUNCTIONS = [
  'userService',
  'quizService',
  'couponService',
  'orderService',
  'deviceService',
  'feedbackService',
  'adminService',
];

function main() {
  if (!fs.existsSync(COMMON_SRC)) {
    console.error(`✗ 找不到公共库: ${COMMON_SRC}`);
    process.exit(1);
  }

  const content = fs.readFileSync(COMMON_SRC, 'utf8');
  let changed = 0;

  for (const fn of FUNCTIONS) {
    const dest = path.join(ROOT, 'cloudfunctions', fn, 'common.js');

    // 内容一致则跳过，避免触碰文件 mtime 干扰增量部署
    if (fs.existsSync(dest) && fs.readFileSync(dest, 'utf8') === content) {
      continue;
    }

    fs.writeFileSync(dest, content, 'utf8');
    changed++;
    console.log(`✓ 已同步 → cloudfunctions/${fn}/common.js`);
  }

  console.log(`\n完成：${changed} 个文件更新，共 ${FUNCTIONS.length} 个函数。`);
}

main();
