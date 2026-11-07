'use strict';

/* 本地离线意图识别。
   两层：正则精确命中（老规矩，零开销） → Fuse.js 模糊兜底（对付 ASR 同音错字）。
   Fuse 是懒加载：没人说话就完全不 require，不拖启动速度；库缺失也只是退回纯正则。 */

const COMMANDS = [
  { action: 'look',      phrases: ['看看屏幕', '看屏幕', '看下屏幕', '看一眼屏幕', '看看我在干嘛', '瞄一眼', '屏幕上是什么', '看看屏幕内容'] },
  { action: 'pomodoro',  phrases: ['开始专注', '开启专注', '番茄钟', '开始计时', '专注计时', '专注二十五分钟', '专注模式'] },
  { action: 'clip',      phrases: ['剪贴板', '复制的内容', '复制的东西', '我复制了什么', '读剪贴板'] },
  { action: 'music',     phrases: ['放歌', '放音乐', '放首歌', '听歌', '播音乐', '来首歌', '下一首', '换首歌'] },
  { action: 'hide',      phrases: ['隐藏', '收起', '躲起来', '藏起来', '先退下'] },
  { action: 'act',       phrases: ['换个节目', '换节目', '换个动作', '换一套', '换一个节目'] },
  { action: 'translate', phrases: ['翻译', '译成英文', '用英文说', '英文怎么说'] }
];

let fuse = null;
let loadFailed = false;

function getFuse() {
  if (fuse) return fuse;
  if (loadFailed) return null;
  try {
    const Fuse = require('./vendor/oss/fuse/fuse.js');
    fuse = new Fuse(COMMANDS, {
      keys: ['phrases'],
      // 中文口语常带「帮我 / 一下 / 吧」这种衬字，放宽匹配范围再用分数严格卡住
      threshold: 0.6,
      ignoreLocation: true,
      includeScore: true,
      minMatchCharLength: 2,
      shouldSort: true
    });
  } catch (e) {
    loadFailed = true;
    fuse = null;
  }
  return fuse;
}

// 聊天里常见的疑问/寒暄词：命中就别再模糊了，免得把一句闲聊误判成指令
const CHATTY = /吗|呢|怎么|为什么|什么|谁|天气|你好|谢谢|好不好|讲个|聊|名字|笑话|累|开心|难过/;

function fuzzyIntent(t) {
  if (!t || t.length > 12 || CHATTY.test(t)) return null;
  const f = getFuse();
  if (!f) return null;
  try {
    const hit = f.search(t, { limit: 1 })[0];
    // 0.52 是实测线：能收「帮我放个音乐」(0.50)，又不会把 27 句闲聊误判成指令
    if (!hit || hit.score > 0.52) return null;
    return hit.item.action;
  } catch { return null; }
}

// 规则写得宽松一点，好容纳识别出来的同音错字（「追专住」≈「专注」）。
const RULES = [
  [/看看屏幕|看看我在干嘛|看一眼屏幕|瞄一眼|屏幕上是什么|看.{0,3}屏幕/, 'look'],
  [/开始专注|开启专注|番茄钟|开始.{0,4}(专|番|计时)|专注.{0,3}分钟/, 'pomodoro'],
  [/剪贴板|复制的内容|复制了什么|我复制|复制的东西/, 'clip'],
  [/放歌|放音乐|听歌|下一首|换首歌/, 'music'],
  [/隐藏|收起|躲起来|先退下/, 'hide'],
  [/换个节目|换个动作|换一套|换节目/, 'act'],
  [/翻译|译成|用英文说|英文怎么说/, 'translate']
];

function localIntent(raw) {
  const t = String(raw || '').replace(/[\s，。！？、,.:;]/g, '');
  for (const [re, action] of RULES) if (re.test(t)) return action;
  return fuzzyIntent(t);
}

module.exports = { localIntent, fuzzyIntent, fuseReady: () => !!getFuse(), commandCount: COMMANDS.length };
