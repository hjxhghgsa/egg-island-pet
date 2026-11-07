import * as THREE from '../vendor/three/three.module.js';
import { GLTFLoader } from '../vendor/addons/loaders/GLTFLoader.js';
import { setupCharacterRig, setupPetRig, updateRig } from './animation.js';

// 调试出口：主进程可随时读取
window.__pet = { stage: 'boot', error: null, rev: THREE.REVISION };
window.addEventListener('error', (e) => { window.__pet.error = String(e.message || e.error); });
window.addEventListener('unhandledrejection', (e) => {
  window.__pet.error = String((e.reason && (e.reason.stack || e.reason.message)) || e.reason);
});

/* ---------------- 模型清单 ---------------- */
const MODELS = {
  cake: { file: 'character-cake.glb', height: 1.35, label: '蛋糕纯' },
  jade: { file: 'character-jade.glb', height: 1.35, label: '珠玉纯' }
};

let currentKey = 'cake';

/* ---------------- 渲染器 ---------------- */
const canvas = document.getElementById('stage');
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: true,
  powerPreference: 'high-performance'
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.02;
renderer.setClearAlpha(0);
// 桌面宠物不需要阴影：省一大笔开销
renderer.shadowMap.enabled = false;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);

// 相机按模型高度自适应，人物和宠物都能占满画面约 3/4
function frameCamera(height) {
  camera.position.set(0, height * 0.6, height * 2.3);
  camera.lookAt(0, height * 0.5, 0);
  camera.updateProjectionMatrix();
}
frameCamera(1.35);

/* ---------------- 灯光 ---------------- */
const hemi = new THREE.HemisphereLight(0xfff4e2, 0xb9c8dc, 1.35);
scene.add(hemi);

const key = new THREE.DirectionalLight(0xfff1d8, 2.0);
key.position.set(3.2, 5.0, 3.6);
scene.add(key);

const fill = new THREE.DirectionalLight(0xcfe2ff, 0.85);
fill.position.set(-4.0, 2.4, -2.6);
scene.add(fill);

const rim = new THREE.DirectionalLight(0xffe6c2, 0.6);
rim.position.set(0, 1.6, -4.5);
scene.add(rim);

/* ---------------- 容器 ---------------- */
const holder = new THREE.Group();   // 承载模型，负责悬浮位移
scene.add(holder);

const spinner = new THREE.Group();  // 负责朝向摆动
holder.add(spinner);

/* ---------------- 秋千道具 ---------------- */
const swingGroup = new THREE.Group();
swingGroup.visible = false;
holder.add(swingGroup);

const woodMat = new THREE.MeshStandardMaterial({ color: 0xc08d5f, roughness: 0.82 });
const ropeMat = new THREE.MeshStandardMaterial({ color: 0xe0cbaa, roughness: 0.9 });

// 座板要对准髋部，不是脚踝。之前放在 y=0.19，人只能「站」在秋千前面。
const SEAT_Y = 0.42;   // 默认值，加载模型后按各自髋部高度重算
const BAR_Y = 1.46;
const BASE_ROPE_LEN = BAR_Y - SEAT_Y;
const swingRopes = [];

const topBar = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.024, 1.0, 10), woodMat);
topBar.rotation.z = Math.PI / 2;
topBar.position.y = BAR_Y;
swingGroup.add(topBar);

const ropeLen = BASE_ROPE_LEN;
for (const x of [-0.3, 0.3]) {
  const rope = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, ropeLen, 6), ropeMat);
  rope.position.set(x, BAR_Y - ropeLen / 2, -0.04);
  swingGroup.add(rope);
  swingRopes.push(rope);
}
// 板子往后退一点，人坐在板前沿，避免从腰里穿过去
const seat = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.05, 0.30), woodMat);
seat.position.set(0, SEAT_Y, -0.04);
swingGroup.add(seat);

// 蛋糕纯 hipY≈0.419、珠玉纯≈0.472，体型不一样；座板和绳长得跟着换，
// 否则固定高度时总有一个人是悬在板上或陷进板里。
function fitSwingToHips(hipY) {
  const y = Math.max(0.25, Math.min(0.70, hipY - 0.035));
  seat.position.y = y;
  const len = BAR_Y - y;
  for (const rope of swingRopes) {
    rope.scale.y = len / BASE_ROPE_LEN;
    rope.position.y = BAR_Y - len / 2;
  }
}

/* ---------------- 伴随小精灵 ---------------- */
function glowTexture(inner, outer) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 2, 64, 64, 62);
  grd.addColorStop(0, inner);
  grd.addColorStop(0.35, outer);
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

const fairy = new THREE.Group();
holder.add(fairy);

const fairyGlow = new THREE.Sprite(new THREE.SpriteMaterial({
  map: glowTexture('rgba(255,238,190,.95)', 'rgba(255,160,210,.28)'),
  transparent: true, depthWrite: false, depthTest: false,
  toneMapped: false
}));
fairyGlow.scale.setScalar(0.34);
fairyGlow.renderOrder = 1;
fairy.add(fairyGlow);

// 主体是蛋岛原站的 pet-egg.glb（有 82 根骨骼），下面的柔光只是衬它的灵光
let eggRoot = null;
let eggBusy = false;
let eggBounce = 0;

const fairyTrail = [];
for (let i = 0; i < 3; i++) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture('rgba(255,240,205,.9)', 'rgba(255,170,215,.3)'),
    transparent: true, depthWrite: false, depthTest: false,
    toneMapped: false
  }));
  s.renderOrder = 0;
  s.scale.setScalar(0.13 - i * 0.028);
  holder.add(s);
  fairyTrail.push(s);
}
let fairyOn = true;
window.__pet.fairy = (on) => {
  fairyOn = on === undefined ? !fairyOn : !!on;
  return fairyOn;
};

/* ---------------- DOM 特效：爱心 / 星星 / 花开 / 台词 ---------------- */
const fxLayer = document.getElementById('fx');
const bubbleEl = document.getElementById('bubble');
const X_AXIS = new THREE.Vector3(1, 0, 0);

// 骨骼俯仰必须绕「骨骼自己的局部 X 轴」，和 animation.js 的 rotate() 完全一致。
// 之前直接拿世界 (1,0,0) 硬乘 quaternion：Mixamo 大腿/手臂初始朝向各不相同，
// 于是腿被拧成 Z 字、脚尖朝天、手指整排翻起来 —— 这就是坐姿和手难看的根因。
function pitchBone(rig, bone, angle) {
  if (!rig || !bone || Math.abs(angle) < 1e-6) return;
  const data = rig.joints.get(bone);
  if (!data) return;
  bone.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(data.x, angle));
}

const BIT_SETS = {
  love:  { chars: ['♥', '♡', '★', '✦'], colors: ['#ff6f9c', '#ff9ec4', '#ffc94a', '#fff0a8'] },
  star:  { chars: ['✦', '★', '✧', '⋆'], colors: ['#ffe58a', '#ffd166', '#fff6cf', '#ffb7d5'] },
  petal: { chars: ['❀', '✿', '✾', '✽'], colors: ['#ff9ec4', '#ffc0d8', '#ffe1ec', '#ff7a9c'] },
  zzz:   { chars: ['Z', 'z', 'Z'],        colors: ['#a9b8ff', '#c4b5ff', '#b8c6ff'] }
};
const PETAL_COLORS = ['#ff8fb4', '#ffc0d8', '#ffe1a8', '#c9a7ff', '#a8e6cf'];
// 半透明色才能做出「发光」而不是「一块实色」，透明窗口上差别很明显
const SPARK_COLORS = {
  love:  ['#ff78a5', '#ffb8d4', '#ffd678', '#fff6cd'],
  star:  ['#ffe48c', '#fff6cf', '#ffbade', '#ffffff'],
  petal: ['#ff96be', '#ffcde1', '#ffe2b4', '#ceaaff'],
  zzz:   ['#afbeff', '#cebeff', '#b8c6ff']
};

// ClickSpark 式放射星尘：从一点均匀散开，带轻微上飘和随机抖动
function popBits(kind = 'love', n = 9) {
  if (!fxLayer) return;
  const isText = kind === 'zzz';
  const colors = SPARK_COLORS[kind] || SPARK_COLORS.love;
  const set = BIT_SETS[kind] || BIT_SETS.love;
  const ox = 48 + (Math.random() - 0.5) * 10;
  const oy = isText ? 30 : 44 + (Math.random() - 0.5) * 10;

  for (let i = 0; i < n; i++) {
    const el = document.createElement('span');
    if (isText) {
      el.className = 'fx-bit';
      el.textContent = set.chars[i % set.chars.length];
      el.style.color = colors[i % colors.length];
      el.style.fontSize = (13 + Math.random() * 9).toFixed(0) + 'px';
      el.style.setProperty('--dx', ((Math.random() - 0.5) * 60).toFixed(0) + 'px');
      el.style.setProperty('--dy', (-40 - Math.random() * 50).toFixed(0) + 'px');
      el.style.setProperty('--rot', ((Math.random() - 0.5) * 50).toFixed(0) + 'deg');
    } else {
      el.className = 'fx-spark';
      const a = (Math.PI * 2 * i) / n + (Math.random() - 0.5) * 0.5;
      const d = 34 + Math.random() * 46;
      el.style.setProperty('--c', colors[i % colors.length]);
      el.style.setProperty('--sz', (8 + Math.random() * 6).toFixed(1) + 'px');
      el.style.setProperty('--dx', (Math.cos(a) * d).toFixed(0) + 'px');
      el.style.setProperty('--dy', (Math.sin(a) * d - 16 - Math.random() * 14).toFixed(0) + 'px');
      el.style.setProperty('--rot', ((Math.random() - 0.5) * 120).toFixed(0) + 'deg');
    }
    el.style.left = (ox + (Math.random() - 0.5) * 12).toFixed(1) + '%';
    el.style.top = (oy + (Math.random() - 0.5) * 12).toFixed(1) + '%';
    el.style.setProperty('--dur', (0.85 + Math.random() * 0.55).toFixed(2) + 's');
    el.style.setProperty('--delay', (Math.random() * 0.16).toFixed(2) + 's');
    fxLayer.appendChild(el);
    setTimeout(() => el.remove(), 2100);
  }
}

function bloomFlower(xPct = 50, yPct = 82, color) {
  if (!fxLayer) return;
  const el = document.createElement('div');
  el.className = 'fx-flower';
  el.style.left = xPct + '%';
  el.style.top = yPct + '%';
  el.style.setProperty('--petal', color || PETAL_COLORS[Math.floor(Math.random() * PETAL_COLORS.length)]);
  el.style.setProperty('--dur', (1.1 + Math.random() * 0.5).toFixed(2) + 's');
  for (let i = 0; i < 6; i++) {
    const p = document.createElement('i');
    p.style.setProperty('--a', (i * 60) + 'deg');
    el.appendChild(p);
  }
  el.appendChild(document.createElement('b'));
  fxLayer.appendChild(el);
  setTimeout(() => el.remove(), 2200);
}

function petalFall(n = 5) {
  if (!fxLayer) return;
  for (let i = 0; i < n; i++) {
    const el = document.createElement('span');
    el.className = 'fx-flake';
    el.style.setProperty('--c', PETAL_COLORS[i % PETAL_COLORS.length]);
    el.style.left = (8 + Math.random() * 84) + '%';
    el.style.top = '-8%';
    el.style.setProperty('--s', (0.75 + Math.random() * 0.6).toFixed(2));
    el.style.setProperty('--dx', ((Math.random() - 0.5) * 80).toFixed(0) + 'px');
    el.style.setProperty('--dur', (1.8 + Math.random() * 1.1).toFixed(2) + 's');
    el.style.setProperty('--delay', (Math.random() * 0.8).toFixed(2) + 's');
    fxLayer.appendChild(el);
    setTimeout(() => el.remove(), 4300);
  }
}

let bubbleTimer = null;
function showBubble(text, ms = 4600) {
  if (!bubbleEl) return;
  const s = String(text || '');
  // 气泡别太高，不然会盖住角色的脸
  bubbleEl.textContent = s.length > 30 ? s.slice(0, 29) + '…' : s;
  bubbleEl.style.setProperty('--bdur', ms + 'ms');
  bubbleEl.classList.remove('show');
  void bubbleEl.offsetWidth;           // 强制重启动画
  bubbleEl.classList.add('show');
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => bubbleEl.classList.remove('show'), ms + 60);
}

/* ---------------- 小蛋助手：情绪价值 / 屏幕感知 / 剪贴板 ---------------- */
const EGG_LINES = [
  '我在呢，怎么啦？', '要不要我看看屏幕？', '护眼时间到啦，看看远处',
  '今天也辛苦啦', '点我一下我就开心', '复制点东西，我帮你看～', '慢慢来，别急'
];

function eggTap() {
  showBubble(EGG_LINES[Math.floor(Math.random() * EGG_LINES.length)], 3200);
  popBits('love', 6);
  bloomFlower(62, 70);
  eggBounce = 1;
}

window.pet?.onPetSay?.((d) => {
  showBubble(String((d && d.text) || ''), 4600);
  popBits('star', 3);
  eggBounce = 1;
});

window.pet?.onPetCelebrate?.((n) => {
  const count = Math.min(12, Number(n) || 6);
  for (let i = 0; i < count; i++) {
    setTimeout(() => bloomFlower(16 + Math.random() * 68, 60 + Math.random() * 26), i * 120);
  }
  petalFall(6);
  showBubble('完成啦，好棒！', 3400);
  eggBounce = 1;
});

// 看一眼屏幕，让模型说一句贴心话（手动触发，不偷偷截图、不自动烧 token）
async function lookAtScreen() {
  if (eggBusy) return;
  eggBusy = true;
  eggBounce = 1;
  showBubble('让我瞄一眼…', 2400);
  try {
    const shot = await window.pet.captureScreen();
    const reply = await window.pet.chat([
      { role: 'system', content: '你是用户桌面上的贴心小跟宠「小蛋」。看一眼屏幕，用一句不超过 30 字的中文，给主人一句关心、提醒或轻轻的鼓励。不要复述屏幕内容，不要提截图，不要说教，语气像朋友。' },
      { role: 'user', content: [
        { type: 'text', text: '看一眼我的屏幕，说句话。' },
        { type: 'image_url', image_url: { url: shot } }
      ] }
    ]);
    window.__pet.lastLook = String(reply).slice(0, 200);
    showBubble(String(reply).slice(0, 40), 5600);
    window.pet.notify('小蛋看了看你的屏幕', String(reply).slice(0, 160));
    popBits('star', 6);
  } catch (e) {
    window.__pet.lastLook = 'ERR ' + String((e && e.message) || e);
    showBubble('没看清楚，等下再试～', 3200);
  } finally { eggBusy = false; }
}

/* 智能剪贴板：先认内容类型，再给对应的动作。
   参考 GitHub 同类桌宠 Mintu / guyi-bot 的做法：复制代码就讲代码、
   复制英文就翻译、复制 JSON 就说结构，而不是一律「概括一下」。 */
function clipKind(raw) {
  const s = String(raw || '').trim();
  if (/^https?:\/\/\S+$/i.test(s)) return { key: 'url', label: '链接' };
  if (/^[{[]/.test(s)) {
    try { JSON.parse(s); return { key: 'json', label: 'JSON' }; } catch {}
  }
  if (/^\s*(def |class |import |from .+ import |function |const |let |var |public |#include|SELECT )/m.test(s) ||
      /\b(Traceback|Error:|Exception|at [\w.]+\(|=>|::|;\s*$)/m.test(s)) {
    return { key: 'code', label: '代码' };
  }
  const han = (s.match(/[\u4e00-\u9fa5]/g) || []).length;
  const ascii = (s.match(/[A-Za-z]/g) || []).length;
  if (ascii > han * 2 + 8) return { key: 'en', label: '英文' };
  return { key: 'zh', label: '文字' };
}

const CLIP_PROMPTS = {
  url:  '你在读用户复制的一条网址。用一句不超过 40 字的中文，说明它大致是什么、点开前有什么值得留意的；看不出来就直说看不出来。不要复述网址。',
  json: '你在读用户复制的一段 JSON。用一句不超过 40 字的中文说清顶层结构和用途；若字段命名或嵌套有明显问题顺手点一句。不要贴代码。',
  code: '你在读用户复制的一段代码或报错。用一句不超过 40 字的中文说清它在做什么、最可能错在哪，并给一个能立刻试的修改方向。不要贴代码。',
  en:   '你在读用户复制的一段英文。先用不超过 25 字给出中文翻译，再用一句话点出关键词或语法点，总共不超过 45 字。',
  zh:   '你是桌面小助手「小蛋」。用一句不超过 40 字的中文概括用户复制的内容，并给一个实在的建议。不要长篇大论，不要复述全文。'
};

async function explainClipboard() {
  if (eggBusy) return;
  eggBusy = true;
  eggBounce = 1;
  showBubble('我看看你复制的…', 2400);
  try {
    const txt = await window.pet.readClipboard();
    if (!txt || !String(txt).trim()) { showBubble('剪贴板是空的呀', 2800); return; }
    const kind = clipKind(txt);
    window.__pet.clipKind = kind.key;
    showBubble('是' + kind.label + '呀，我看看～', 2400);
    const reply = await window.pet.chat([
      { role: 'system', content: CLIP_PROMPTS[kind.key] },
      { role: 'user', content: String(txt).slice(0, 3000) }
    ]);
    window.__pet.lastClip = String(reply).slice(0, 200);
    showBubble(String(reply).slice(0, 44), 6000);
    window.pet.notify('小蛋读了你复制的' + kind.label, String(reply).slice(0, 180));
    popBits(kind.key === 'en' || kind.key === 'code' ? 'star' : 'love', 5);
  } catch (e) {
    window.__pet.lastClip = 'ERR ' + String((e && e.message) || e);
    showBubble('接口没连上，先看看设置～', 3400);
  } finally { eggBusy = false; }
}

window.pet?.onPetLook?.(lookAtScreen);
window.pet?.onPetClip?.(explainClipboard);

/* 手部细化：顺着原站骨骼做柔和的小动作，别把胳膊硬掰成怪角度 */
function softenHands(rig, waving, t) {
  if (!rig?.arms) return;
  for (const arm of rig.arms) {
    const right = /Right/i.test(arm.side);
    const phase = right ? 0 : Math.PI;
    const w = waving && right ? 1 : 0;
    if (arm.upper && w) pitchBone(rig, arm.upper, -0.62 + Math.sin(t * 6.2) * 0.20);
    if (arm.lower) pitchBone(rig, arm.lower, -0.16 * w + Math.sin(t * 1.1 + phase) * 0.035);
    if (arm.hand) pitchBone(rig, arm.hand,
      Math.sin(t * 1.3 + phase) * 0.05 + w * Math.sin(t * 6.2) * 0.09);
  }
  // 手指逐节收拢、幅度递减，别整排一起翻
  for (const { bone } of rig.joints.values()) {
    const m = /Hand(Index|Middle|Ring|Pinky)(\d)/i.exec(bone.name);
    if (m) pitchBone(rig, bone, 0.055 * (4 - Number(m[2])) / 3);
  }
}

/* ---------------- 状态 ---------------- */
let t = 0;
let rigReady = false;
let modelRoot = null;

let baseY = 0;           // 模型底部基准
let jumpVel = 0;         // 跳跃速度
let jumpY = 0;           // 跳跃产生的位移
let squash = 1;          // 落地压缩
let yaw = 0;             // 手动旋转角（360° 自由转）
let yawVel = 0;          // 旋转惯性
let sitBlend = 0;        // 坐姿骨骼过渡
let swingFxTimer = 0;    // 荡秋千时飘花瓣 / 星光的节奏
let seatHipY = 0.472;    // 当前角色的髋部高度，换角色后重算座板
let lastRotateAt = 0;    // 最后一次手动转的时间
const TAU = Math.PI * 2;

/* 节目单：参考 Bongo Cat 的呼吸待机 / 点击连击，
   加上 Shimeji 那种「满屏乱走 + 一堆互不重复的小动作」 */
const ACTS = [
  { name: 'idle',  min: 5,   max: 9 },
  { name: 'sit',   min: 5,   max: 8 },
  { name: 'swing', min: 9,   max: 13 },
  { name: 'spin',  min: 2.2, max: 2.2 },
  { name: 'hop',   min: 3,   max: 5 },
  { name: 'walk',  min: 6,   max: 9 },
  { name: 'bloom', min: 5,   max: 7 },
  { name: 'wave',  min: 4,   max: 6 },
  { name: 'float', min: 5,   max: 7 },
  { name: 'chase', min: 5,   max: 7 },
  { name: 'sleep', min: 5,   max: 7 }
];

let act = 'idle';
let actTimer = 7;
let lastAct = '';
let hopTimer = 0;
let bloomTimer = 0;
let zTimer = 0;
let walkTimer = 0;
let walkX = 0;
let waveTimer = 0;
let starTimer = 0;

function enterAct(name, seconds) {
  const prev = act;
  act = name;
  actTimer = seconds;
  swingGroup.visible = (name === 'swing');
  if (name === 'hop') hopTimer = 0;
  if (name === 'bloom') { bloomTimer = 0; petalFall(4); }
  if (name === 'sleep' || name === 'wave') { zTimer = 0; waveTimer = 0; }
  if (name === 'walk') { walkTimer = 0; }
  if (name === 'float') { starTimer = 0; }
  if (name === 'wave') popBits('love', 5);
  if (name !== 'swing') holder.rotation.z = 0;

  // 转完一圈自动对齐回正面
  if (name !== 'spin' && prev === 'spin') {
    yaw = Math.round(yaw / TAU) * TAU;
    yawVel = 0;
    lastRotateAt = performance.now();
  }
  window.__pet.act = name;
}

function pickAct() {
  let a;
  do { a = ACTS[Math.floor(Math.random() * ACTS.length)]; }
  while (a.name === lastAct && ACTS.length > 1);
  lastAct = a.name;
  enterAct(a.name, a.min + Math.random() * (a.max - a.min));
}

// 调试 / 控制台接口
window.__pet.setAct = (name, seconds = 8) => enterAct(name, seconds);
window.__pet.getAct = () => act;
window.__pet.yaw = () => yaw;
window.__pet.setYaw = (v) => { yaw = v; yawVel = 0; lastRotateAt = performance.now(); };
window.__pet.acts = ACTS.map((a) => a.name);
window.__pet.model = () => currentKey;
window.__pet.pop = (n = 9, kind = 'love') => popBits(kind, n);
window.__pet.bloom = (n = 4) => {
  for (let i = 0; i < n; i++) {
    setTimeout(() => bloomFlower(18 + Math.random() * 64, 62 + Math.random() * 24), i * 130);
  }
};

/* ---------------- 加载 ---------------- */
const loader = new GLTFLoader();

function convertMaterial(mesh, opts) {
  const m = mesh.material;
  if (!m) return;
  const convert = (src) => {
    const mat = new THREE.MeshPhysicalMaterial({
      color: src.color ? src.color.clone() : new THREE.Color('white'),
      map: src.map || null,
      vertexColors: !!mesh.geometry.attributes.color,
      transparent: src.transparent,
      opacity: src.opacity ?? 1,
      side: src.side,
      alphaTest: src.alphaTest || 0,
      normalMap: src.normalMap || null,
      roughness: opts.roughness,
      metalness: 0,
      clearcoat: opts.clearcoat,
      clearcoatRoughness: 0.3,
      // 一层很淡的绒光，让皮肤 / 小手看着更细腻，不像硬塑料
      sheen: 0.45,
      sheenRoughness: 0.75,
      sheenColor: new THREE.Color(0xffd9e6),
      envMapIntensity: 0.8
    });
    if (src.emissive) {
      mat.emissive.copy(src.emissive);
      mat.emissiveMap = src.emissiveMap;
      mat.emissiveIntensity = Math.min(src.emissiveIntensity || 0, 0.3);
    }
    if (mat.map) {
      mat.map.anisotropy = 8;
      mat.map.colorSpace = THREE.SRGBColorSpace;
    }
    return mat;
  };
  mesh.material = Array.isArray(m) ? m.map(convert) : convert(m);
}

function normalize(root, height) {
  // 与蛋岛原站一致的归一化：高度对齐 + 底部贴地 + 水平居中
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const scale = height / Math.max(size.y, 0.001);
  root.scale.multiplyScalar(scale);
  root.position.add(new THREE.Vector3(-center.x, -box.min.y, -center.z).multiplyScalar(scale));
  root.updateMatrixWorld(true);
}

function disposeModel(root) {
  if (!root) return;
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.geometry?.dispose?.();
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    mats.forEach((m) => { m?.map?.dispose?.(); m?.dispose?.(); });
  });
}

async function loadModel(modelKey, { announce = true } = {}) {
  const info = MODELS[modelKey] || MODELS.cake;
  // 原子切换：先把新模型完整加载 + 建好 rig，成功之后才摘掉旧的。
  // 旧写法是先 dispose 旧模型再 await 加载，任何一次加载抖动都会让角色整个消失，
  // 表现就是「另一个角色怎么没有了 / 用不了了」。
  const url = new URL('../models/' + info.file, import.meta.url).href;
  const gltf = await loader.loadAsync(url);
  const object = gltf.scene;

  object.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = false;
      o.receiveShadow = false;
      o.frustumCulled = false;
      convertMaterial(o, { roughness: 0.52, clearcoat: 0.24 });
    }
  });

  const holderLike = new THREE.Group();
  holderLike.add(object);
  normalize(object, info.height);

  // 复用蛋岛原站的程序化骨骼系统
  setupCharacterRig(holderLike);
  const rig = holderLike.userData.islandRig;
  if (rig?.hips) {
    holderLike.updateWorldMatrix(true, true);
    const hip = holderLike.worldToLocal(rig.hips.getWorldPosition(new THREE.Vector3()));
    seatHipY = +hip.y.toFixed(3);
    window.__pet.hipY = seatHipY;
    fitSwingToHips(seatHipY);
  }

  // 走到这里才算成功
  if (modelRoot) {
    spinner.remove(modelRoot);
    disposeModel(modelRoot);
  }
  spinner.add(holderLike);
  modelRoot = holderLike;
  frameCamera(info.height);
  baseY = 0;
  jumpY = 0;
  jumpVel = 0;
  sitBlend = 0;
  rigReady = true;
  currentKey = modelKey;
  window.__pet.stage = 'ready:' + modelKey;   // 切模型后也要同步，别停在启动那次
  window.pet?.saveSettings({ model: modelKey });

  // 换角色给个明确反馈：以前一点提示都没有，用户以为点了没生效
  if (announce) {
    showBubble(info.label + ' 来啦~', 2800);
    popBits('petal', 8);
    eggBounce = 1;
  }
  jumpVel = 1.6;                              // 出场弹一下
}

async function switchTo(key) {
  if (!MODELS[key] || key === currentKey) return;
  try {
    await loadModel(key);
  } catch (err) {
    window.__pet.error = 'switchModel: ' + String((err && (err.stack || err.message)) || err);
    showBubble('这个角色没加载出来，先留着原来的～', 3800);
  }
}

/* ---------------- 交互 ---------------- */
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let hovering = false;
let dragging = false;      // 左键：旋转角色
let movingWin = false;     // 右键：拖窗口
let winMoved = false;
let eggTapped = false;
let lastX = 0;

function setHover(next) {
  if (next === hovering) return;
  hovering = next;
  window.pet?.hover(next);
  canvas.style.cursor = next ? 'grab' : 'default';
}

function hitTest(ev) {
  const rect = canvas.getBoundingClientRect();
  pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  // 点小蛋 = 找它说话；点人物 = 旋转 / 放歌
  if (eggRoot && fairyOn && raycaster.intersectObjects(eggRoot.children, true).length) return 'egg';
  if (!modelRoot) return null;
  return raycaster.intersectObjects(modelRoot.children, true).length ? 'body' : null;
}

window.addEventListener('pointermove', (ev) => {
  if (dragging) {
    const dx = ev.clientX - lastX;
    lastX = ev.clientX;
    yaw += dx * 0.014;
    yawVel = dx * 0.014;   // 松手后带一点惯性
    lastRotateAt = performance.now();
    return;
  }
  if (movingWin) {
    winMoved = true;
    window.pet?.dragMove();
    return;
  }
  setHover(!!hitTest(ev));
});

window.addEventListener('pointerdown', (ev) => {
  window.pet?.touch();
  if (ev.button === 2) {
    ev.preventDefault();
    movingWin = true;
    winMoved = false;
    window.pet?.dragStart();
    return;
  }
  if (ev.button !== 0) return;
  const hit = hitTest(ev);
  if (!hit) return;
  if (hit === 'egg') { eggTapped = true; return; }
  dragging = true;
  lastX = ev.clientX;
  yawVel = 0;
  // 捕获指针，拖出窗口也能继续转
  try { canvas.setPointerCapture(ev.pointerId); } catch {}
  canvas.style.cursor = 'grabbing';
});

window.addEventListener('pointerup', (ev) => {
  if (ev.button === 2) {
    movingWin = false;
    if (winMoved) window.pet?.dragEnd();
    else window.pet?.contextMenu();
    return;
  }
  if (ev.button !== 0) return;
  if (eggTapped) { eggTapped = false; eggTap(); return; }
  const wasDragging = dragging;
  const spun = Math.abs(yawVel) > 0.0001;
  dragging = false;
  try { canvas.releasePointerCapture(ev.pointerId); } catch {}
  canvas.style.cursor = hovering ? 'grab' : 'default';
  if (wasDragging && !spun) tap();
});

// 拖窗口时指针事件稀疏，补一个定时推送
setInterval(() => {
  if (movingWin && winMoved) window.pet?.dragMove();
}, 16);

window.addEventListener('pointerleave', () => { if (!dragging && !movingWin) setHover(false); });

window.addEventListener('contextmenu', (ev) => ev.preventDefault());

const ACT_LABELS = {
  idle: '站着发呆', sit: '坐一会儿', swing: '荡秋千', spin: '转个圈',
  hop: '蹦蹦跳', walk: '散步开花', bloom: '满地开花', wave: '挥手打招呼',
  float: '飘起来', chase: '追小精灵', sleep: '打瞌睡'
};

// 右键菜单也能翻节目 / 开关小精灵
window.pet?.onSetAct?.((name) => {
  if (!ACTS.some((a) => a.name === name)) return;
  enterAct(name, 14);
  showBubble('节目：' + (ACT_LABELS[name] || name));
});
window.pet?.onNextAct?.(() => {
  pickAct();
  showBubble('节目：' + (ACT_LABELS[act] || act));
});
window.pet?.onToggleFairy?.(() => {
  const on = window.__pet.fairy();
  showBubble(on ? '小蛋来啦~' : '小蛋先睡会儿');
});

// 数字键切模型；F 开关小精灵；A 立刻换一套节目
window.addEventListener('keydown', (ev) => {
  const key = ev.key.toLowerCase();
  if (key === 'f') {
    const on = window.__pet.fairy();
    showBubble(on ? '小蛋来啦~' : '小蛋先睡会儿');
    return;
  }
  if (key === 'a') {
    pickAct();
    showBubble('节目：' + (ACT_LABELS[act] || act));
    return;
  }
  const keys = Object.keys(MODELS);
  const n = parseInt(ev.key, 10);
  if (n >= 1 && n <= keys.length) {
    const k = keys[n - 1];
    switchTo(k);
  }
});

/* ---------------- 音乐 ---------------- */
const audio = new Audio();
audio.volume = 0.55;
let tracks = [];
let trackIdx = 0;

audio.addEventListener('playing', () => { window.__pet.music = 'playing:' + (tracks[trackIdx] || ''); });
audio.addEventListener('pause', () => { window.__pet.music = 'paused'; });
audio.addEventListener('error', () => { window.__pet.music = 'error'; });

audio.addEventListener('ended', () => {
  if (!tracks.length) return;
  trackIdx = (trackIdx + 1) % tracks.length;
  audio.src = tracks[trackIdx];
  audio.play().catch(() => {});
});

async function toggleMusic() {
  if (!tracks.length) {
    tracks = (await window.pet?.listMusic()) || [];
    if (!tracks.length) {
      window.pet?.noMusic();
      return false;
    }
  }
  if (!audio.paused) {
    audio.pause();
    return false;
  }
  if (!audio.src) audio.src = tracks[trackIdx];
  try { await audio.play(); return true; } catch { return false; }
}

function nextTrack() {
  if (!tracks.length) return;
  trackIdx = (trackIdx + 1) % tracks.length;
  audio.src = tracks[trackIdx];
  audio.play().catch(() => {});
}

/* ---------------- 动作 ---------------- */
let tapCount = 0;
let lastTapAt = 0;

const TAP_LINES = ['嘿嘿~', '别戳啦', '有点痒!', '再来一下?', '呀!', '陪我玩嘛', '今天也辛苦啦', '被你发现啦'];

function tap() {
  // 双击打开聊天，单击放歌
  const wallNow = Date.now();
  if (wallNow - lastTapAt < 330) {
    lastTapAt = 0;
    window.pet?.openChat();
    return;
  }
  lastTapAt = wallNow;

  // 连击越高，反馈越夸张：爱心 → 星星 → 满地开花
  const combo = tapCount + 1;
  popBits(combo >= 4 ? 'star' : 'love', Math.min(20, 6 + combo * 2));
  if (combo >= 3) {
    for (let i = 0; i < Math.min(6, combo); i++) {
      setTimeout(() => bloomFlower(18 + Math.random() * 64, 64 + Math.random() * 22), i * 110);
    }
    showBubble(combo >= 6 ? '×' + combo + ' 连击！花开啦~' : '×' + combo + ' 连击!');
  } else {
    showBubble(TAP_LINES[Math.floor(Math.random() * TAP_LINES.length)]);
  }

  jumpVel = 2.6 + Math.min(tapCount, 3) * 0.3;
  yawVel = 1.3;
  lastRotateAt = performance.now();   // 必须与 tick 同源，否则回正永远不触发
  toggleMusic();
  tapCount++;
  clearTimeout(tapTimer);
  tapTimer = setTimeout(() => { tapCount = 0; }, 1200);
}
let tapTimer = null;

/* ---------------- 尺寸 ---------------- */
function resize() {
  // 窗口恒为正方形；异常 resize 值会把相机视野拉窄、显得角色突然巨大，
  // 所以这里钳制尺寸并把 aspect 钉死为 1（主进程那边也锁了窗口尺寸）。
  const w = Math.max(120, Math.min(window.innerWidth || 200, 400));
  const h = Math.max(120, Math.min(window.innerHeight || 200, 400));
  renderer.setSize(w, h, false);
  camera.aspect = 1;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

/* ---------------- 主循环 ---------------- */
const GRAVITY = 11.0;
let prev = performance.now();

function tick() {
  requestAnimationFrame(tick);
  const now = performance.now();
  let dt = (now - prev) / 1000;
  prev = now;
  dt = Math.min(dt, 0.05);
  t += dt;

  /* 节目轮换：不连续重复同一套 */
  actTimer -= dt;
  if (actTimer <= 0) pickAct();

  /* 小精灵：绕着角色飞，扇翅膀 + 拖尾光点 */
  fairy.visible = fairyOn;
  for (const s of fairyTrail) s.visible = fairyOn;
  if (fairyOn) {
    const spd = act === 'chase' ? 2.1 : 0.85;
    const fz = 0.44 + Math.cos(t * spd) * 0.06;
    // 飘在身侧，别趴在头顶挡脸
    fairy.position.set(Math.sin(t * spd) * 0.16 + 0.34, 0.66 + Math.sin(t * 1.9) * 0.09, fz);
    fairyGlow.material.opacity = 0.30 + Math.sin(t * 4) * 0.08;
    if (eggRoot) {
      eggBounce = Math.max(0, eggBounce - dt * 1.8);
      eggRoot.position.y = eggBounce * 0.09 + Math.sin(t * 2.3) * 0.012;
      eggRoot.rotation.z = Math.sin(t * 1.6) * 0.10 + eggBounce * Math.sin(t * 18) * 0.08;
      eggRoot.rotation.y = Math.sin(t * 0.8) * 0.22;
      updateRig(eggRoot, { time: t, dt, floating: 1, speed: 0, groundHeight: 0 });
      softenHands(eggRoot.userData.islandRig, act === 'wave', t + 0.7);
    }
    fairyTrail.forEach((s, i) => {
      const tt = t * spd - (i + 1) * 0.16;
      s.position.set(
        Math.sin(tt) * 0.16 + 0.34,
        0.66 + Math.sin(tt / spd * 1.9) * 0.09,
        0.44 + Math.cos(tt) * 0.06
      );
      s.material.opacity = 0.30 - i * 0.07;
    });
  }

  /* 各节目独有动作 */
  if (act === 'hop') {
    hopTimer -= dt;
    if (hopTimer <= 0 && jumpVel === 0 && jumpY === 0) {
      jumpVel = 1.7 + Math.random() * 0.8;
      hopTimer = 0.55 + Math.random() * 0.35;
    }
  }

  // 秋千：横杆保持水平，座板和人一起轻轻左右荡，别把整个画面转歪
  if (act === 'swing') {
    const s = Math.sin(t * 1.65);
    holder.rotation.z = s * 0.045;
    holder.position.y = Math.sin(t * 3.3) * 0.012;
    swingGroup.position.x = s * 0.055;
    spinner.position.x = s * 0.055;
    // 荡的时候身边一直有花瓣和细星光，别让秋千只是几根光秃秃的圆柱
    swingFxTimer -= dt;
    if (swingFxTimer <= 0) {
      petalFall(1);
      if (Math.random() < 0.4) popBits('star', 2);
      swingFxTimer = 1.2 + Math.random() * 1.3;
    }
  } else {
    holder.rotation.z += (0 - holder.rotation.z) * Math.min(1, dt * 5);
    holder.position.y += (0 - holder.position.y) * Math.min(1, dt * 5);
    swingGroup.position.x += (0 - swingGroup.position.x) * Math.min(1, dt * 5);
    spinner.position.x += (0 - spinner.position.x) * Math.min(1, dt * 5);
  }

  // 散步：左右走，脚下每落一步就开一朵花
  if (act === 'walk') {
    walkTimer -= dt;
    walkX = Math.sin(t * 0.75) * 0.26;
    if (walkTimer <= 0) {
      bloomFlower(50 + walkX * 60, 82);
      walkTimer = 0.42 + Math.random() * 0.18;
    }
  } else {
    walkX += (0 - walkX) * Math.min(1, dt * 4);
  }
  holder.position.x = walkX;

  // 撒花：四周依次绽开，偶尔飘落花瓣
  if (act === 'bloom') {
    bloomTimer -= dt;
    if (bloomTimer <= 0) {
      bloomFlower(16 + Math.random() * 68, 60 + Math.random() * 26);
      bloomTimer = 0.28 + Math.random() * 0.22;
      if (Math.random() < 0.35) petalFall(2);
    }
  }

  if (act === 'float') {
    starTimer -= dt;
    if (starTimer <= 0) { popBits('star', 2); starTimer = 0.5; }
  }
  if (act === 'sleep') {
    zTimer -= dt;
    if (zTimer <= 0) { popBits('zzz', 1); zTimer = 1.15; }
  }
  if (act === 'wave') {
    waveTimer -= dt;
    if (waveTimer <= 0) { popBits('love', 3); waveTimer = 1.1; }
  }

  /* 悬浮、跳跃、落地压缩 */
  const bob = Math.sin(t * 1.6) * 0.035;
  if (jumpVel !== 0 || jumpY > 0) {
    jumpY += jumpVel * dt;
    jumpVel -= GRAVITY * dt;
    if (jumpY <= 0) {
      jumpY = 0;
      if (jumpVel < -0.4) squash = 0.86;   // 落地压缩
      jumpVel = 0;
    }
  }
  squash += (1 - squash) * Math.min(1, dt * 12);

  // 坐下 / 荡秋千时把身体压低，臀部真正落在座板上，而不是站着
  const wantSit = (act === 'swing' || act === 'sit' || act === 'sleep') ? 1 : 0;
  sitBlend += (wantSit - sitBlend) * Math.min(1, dt * 5);
  const floatLift = act === 'float' ? 0.12 + Math.sin(t * 1.3) * 0.06 : 0;
  // 座板已经抬到髋部高度，人只需轻轻压实，别再把整个人往下拽 0.18
  const seatDrop = act === 'swing' ? -0.035 * sitBlend
    : ((act === 'sit' || act === 'sleep') ? -0.13 * sitBlend : 0);

  spinner.position.y = baseY + bob + jumpY + floatLift + seatDrop;
  // 坐上去时身体微微往前，落在板前沿，而不是被板子从腰里穿过
  const wantZ = act === 'swing' ? 0.08 * sitBlend : 0;
  spinner.position.z += (wantZ - spinner.position.z) * Math.min(1, dt * 5);
  spinner.scale.set(
    1 + (1 - squash) * 0.55,
    squash,
    1 + (1 - squash) * 0.55
  );

  /* 朝向：手动旋转带惯性；静置约 1.8 秒自动回正面 */
  if (act === 'chase') {
    yaw = Math.sin(t * 2.1) * 0.55;       // 追着小精灵转头
    yawVel = 0;
    lastRotateAt = now;
  } else if (act === 'spin') {
    yaw += (TAU / 2.2) * dt;              // 真转满一整圈
    yawVel = 0;
    lastRotateAt = now;
  } else {
    yaw += yawVel;
    yawVel *= Math.exp(-7 * dt);
    if (Math.abs(yawVel) < 1e-4) yawVel = 0;
  }

  if (act !== 'spin' && act !== 'chase' && !dragging &&
      now - lastRotateAt > 1800 && Math.abs(yaw) > 0.02) {
    const target = Math.round(yaw / TAU) * TAU;
    yaw += (target - yaw) * Math.min(1, dt * 3.2);
    if (Math.abs(yaw - target) < 0.008) yaw = 0;  // 整圈等价于 0，避免数值累积
    yawVel = 0;
  }
  const idleSway = Math.abs(yaw) < 0.02 && (act === 'idle' || act === 'sit' || act === 'sleep')
    ? Math.sin(t * 0.42) * 0.16 : 0;
  spinner.rotation.y = yaw + idleSway;

  /* 骨骼 */
  if (rigReady && modelRoot) {
    const floatAmt = act === 'float' ? 1 : (act === 'swing' ? 0.55 : (act === 'walk' ? 0 : 0.85));
    updateRig(modelRoot, {
      time: t,
      dt,
      speed: act === 'walk' ? 0.55 : 0,
      turn: act === 'swing' ? Math.sin(t * 1.65) * 0.12 : 0,
      floating: floatAmt,
      groundHeight: 0,
      lantern: false
    });

    const rig = modelRoot.userData.islandRig;
    // 坐姿：绕骨骼自身局部轴，大腿前伸、小腿自然垂下、脚掌放松，荡的时候跟着轻晃
    if (rig && sitBlend > 0.002) {
      const kick = act === 'swing' ? Math.sin(t * 1.65) * 0.10 : 0;
      for (const leg of rig.legs) {
        const side = leg.side === 'Left' ? 1 : -1;
        pitchBone(rig, leg.upper, (-1.32 + kick * 0.4) * sitBlend);
        pitchBone(rig, leg.lower, (1.24 - kick * 0.35) * sitBlend);
        pitchBone(rig, leg.foot, (-0.16 + kick * 0.45 + side * 0.015) * sitBlend);
      }
    }
    softenHands(rig, act === 'wave', t);
    modelRoot.updateWorldMatrix(true, true);
  }

  renderer.render(scene, camera);
}

/* ---------------- 蛋岛小蛋跟宠 ---------------- */
async function loadEgg() {
  const url = new URL('../models/pet-egg.glb', import.meta.url).href;
  const gltf = await loader.loadAsync(url);
  const object = gltf.scene;
  object.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = false;
      o.receiveShadow = false;
      o.frustumCulled = false;
      convertMaterial(o, { roughness: 0.54, clearcoat: 0.22 });
    }
  });
  const g = new THREE.Group();
  g.add(object);
  normalize(object, 0.34);
  setupPetRig(g);                 // 复用蛋岛原站的 pet 骨骼系统
  fairy.add(g);
  eggRoot = g;
  window.__pet.egg = 'ready';
}

/* ---------------- 启动 ---------------- */
(async () => {
  window.__pet.stage = 'imported';
  renderer.render(scene, camera);
  const s = (await window.pet?.getSettings()) || {};
  try {
    window.__pet.stage = 'loading:' + (s.model || 'cake');
    await loadModel(s.model && MODELS[s.model] ? s.model : 'cake', { announce: false });
    window.__pet.stage = 'ready:' + currentKey;
  } catch (err) {
    window.__pet.stage = 'failed';
    window.__pet.error = String((err && (err.stack || err.message)) || err);
  }
  tick();                          // 先把角色跑起来，小蛋异步补上
  try {
    await loadEgg();
  } catch (err) {
    window.__pet.egg = 'failed: ' + String((err && err.message) || err);
  }
})();

window.pet?.onApplySettings((s) => {
  if (s.model && MODELS[s.model] && s.model !== currentKey) switchTo(s.model);
});

window.pet?.onSwitchModel((k) => {
  if (MODELS[k] && k !== currentKey) switchTo(k);
});

window.pet?.onToggleMusic(() => { toggleMusic(); });
window.pet?.onNextTrack(() => { nextTrack(); });

// 被召唤出来时：蹦一下 + 转半圈
window.pet?.onSummon(() => {
  jumpVel = 2.6;
  yawVel = 1.9;
});
