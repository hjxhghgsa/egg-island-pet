/*
 * 键盘钩子探针（独立于桌宠，只为验证「这台机器到底能不能收到 keydown」）
 * 只累加次数，不读取、不记录任何键位。
 * 运行：node _keyprobe.js      结果写到 _keyprobe.log，跑 10 分钟自动退出
 */
const fs = require('fs');
const path = require('path');
const out = path.join(__dirname, '_keyprobe.log');

let keys = 0;
let moves = 0;
const log = (line) => {
  try { fs.appendFileSync(out, new Date().toISOString().slice(11, 19) + ' ' + line + '\n'); } catch {}
};

try {
  const { uIOhook } = require('uiohook-napi');
  uIOhook.on('keydown', () => { keys++; });      // 注意：回调没有参数
  uIOhook.on('mousemove', () => { moves++; });
  uIOhook.start();
  log('START hook ok');
} catch (e) {
  log('FAIL ' + e.message);
  process.exit(1);
}

let ticks = 0;
setInterval(() => {
  ticks++;
  log('keys=' + keys + ' moves=' + moves);
  if (ticks >= 300) { log('DONE'); process.exit(0); }   // 10 分钟
}, 2000);
