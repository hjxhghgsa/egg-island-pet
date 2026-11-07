/* 开源资源适配层：把 vendor/oss 里的四个库收成一个稳定入口。
 *
 * 设计原则：
 *  1. 零 npm 依赖、零网络请求、不引入第二个渲染循环；
 *  2. 任何库没加载好都静默降级（缓动退回 smoothstep、音效直接不出声），绝不让桌宠白屏；
 *  3. 第三方源码原样放在 vendor/oss，这里只做「接进本项目」的薄薄一层胶水。
 *
 * 见 vendor/oss/README.md 里的来源与许可证。 */

import { createNoise2D } from '../vendor/oss/simplex-noise/simplex-noise.mjs';

/* ---------- bezier-easing (MIT / gre) ---------- */
// 两个 UMD 脚本用普通 <script> 先加载，挂到 window 上；ES module 里读全局即可。
const bezier = globalThis.BezierEasing;
const smoothstep = (t) => t * t * (3 - 2 * t);
const mkEase = (a, b, c, d) => (typeof bezier === 'function' ? bezier(a, b, c, d) : smoothstep);
export const easeSnap = mkEase(0.22, 1, 0.36, 1);   // 吸附：起步快、软停
export const easePeek = mkEase(0.16, 1, 0.3, 1);    // 探头：慢慢贴到屏幕边
export const easeBloom = mkEase(0.4, 0, 0.2, 1);    // 开花错峰
export const bezierReady = typeof bezier === 'function';

/* ---------- simplex-noise (MIT / jwagner) ---------- */
// 连续的二维噪声：给花瓣和吉祥物一点「风」，替代纯 Math.random 的颗粒抖动。
export const noise2D = createNoise2D();
export const noiseReady = typeof noise2D === 'function';

/* ---------- jsfxr (Unlicense / chr15m) ---------- */
// 程序化合成音效，不下载任何音频文件；用我们自己的 AudioContext，
// 不碰音乐那条 <audio> 链，所以连击/点击绝不会切歌、也不会打断播放。
const sfxr = globalThis.jsfxr && globalThis.jsfxr.sfxr;
export const sfxReady = !!sfxr;

const PRESETS = {
  tap:    ['blipSelect', { p_env_decay: 0.10, p_base_freq: 0.62, p_freq_ramp: 0.10 }],
  combo:  ['pickupCoin', { p_env_decay: 0.13, p_base_freq: 0.66, p_freq_ramp: 0.16 }],
  tier10: ['powerUp',    { p_env_decay: 0.28, p_base_freq: 0.48 }],
  tier20: ['jump',       { p_env_decay: 0.22, p_base_freq: 0.58 }],
  tier30: ['synth',      { p_env_decay: 0.30, p_base_freq: 0.52 }],
  tier40: ['powerUp',    { p_env_decay: 0.38, p_base_freq: 0.42 }],
  caught: ['hitHurt',    { p_env_decay: 0.20, p_base_freq: 0.34, p_freq_ramp: -0.12 }],
  peek:   ['blipSelect', { p_env_decay: 0.16, p_base_freq: 0.40 }],
  freed:  ['jump',       { p_env_decay: 0.18, p_base_freq: 0.70 }]
};

const defs = new Map();
let actx = null;
let sfxOn = true;
let lastAt = 0;
let lastKey = '';
let playCount = 0;

function defFor(key) {
  if (!sfxReady || defs.has(key)) return defs.get(key);
  const spec = PRESETS[key];
  if (!spec) return null;
  try {
    // 预设全部改成正弦波 + 短衰减：8-bit 方波太冲，桌宠要的是轻轻一声
    const p = sfxr.generate(spec[0], { sound_vol: 0.22, sample_rate: 22050, sample_size: 16 });
    Object.assign(p, {
      wave_type: 2, p_lpf_freq: 1, p_hpf_freq: 0,
      p_vib_strength: 0, p_pha_offset: 0, p_repeat_speed: 0
    }, spec[1]);
    defs.set(key, p);
    return p;
  } catch { return null; }
}

export function playSfx(key, { rate = 1, vol = 1, minGap = 45 } = {}) {
  if (!sfxReady || !sfxOn) return false;
  const def = defFor(key);
  if (!def) return false;
  const now = performance.now();
  if (key === lastKey && now - lastAt < minGap) return false;
  try {
    if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
    const src = sfxr.toWebAudio(def, actx);       // 返回未连接的 BufferSource
    if (!src) return false;
    const g = actx.createGain();
    g.gain.value = Math.max(0, Math.min(1, 0.45 * vol));
    src.playbackRate.value = Math.max(0.5, Math.min(2, rate));
    src.connect(g);
    g.connect(actx.destination);
    src.start();
    lastAt = now;
    lastKey = key;
    playCount++;
    return true;
  } catch { return false; }
}

export function setSfxOn(on) { sfxOn = !!on; }

export function ossState() {
  return {
    bezier: bezierReady, noise: noiseReady, jsfxr: sfxReady,
    on: sfxOn, ctx: actx ? actx.state : 'idle',
    cached: defs.size, plays: playCount, last: lastKey
  };
}
