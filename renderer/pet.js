import * as THREE from '../vendor/three/three.module.js';
import { GLTFLoader } from '../vendor/addons/loaders/GLTFLoader.js';
import { setupCharacterRig, updateRig } from './animation.js';

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

/* ---------------- 状态 ---------------- */
const clock = new THREE.Clock();
let t = 0;
let rigReady = false;
let modelRoot = null;

let baseY = 0;           // 模型底部基准
let jumpVel = 0;         // 跳跃速度
let jumpY = 0;           // 跳跃产生的位移
let squash = 1;          // 落地压缩
let yaw = 0;             // 手动旋转角（360° 自由转）
let yawVel = 0;          // 旋转惯性
let sitting = false;     // 待机时是否坐着
let poseTimer = 9;       // 下一次换动作的倒计时

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

async function loadModel(modelKey) {
  const info = MODELS[modelKey] || MODELS.cake;
  rigReady = false;
  if (modelRoot) {
    spinner.remove(modelRoot);
    modelRoot.traverse((o) => {
      if (o.isMesh) {
        o.geometry?.dispose?.();
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((m) => { m?.map?.dispose?.(); m?.dispose?.(); });
      }
    });
    modelRoot = null;
  }

  const url = new URL('../models/' + info.file, import.meta.url).href;
  const gltf = await loader.loadAsync(url);
  const object = gltf.scene;

  object.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = false;
      o.receiveShadow = false;
      o.frustumCulled = false;
      convertMaterial(o, { roughness: 0.68, clearcoat: 0.12 });
    }
  });

  const holderLike = new THREE.Group();
  holderLike.add(object);
  normalize(object, info.height);

  // 复用蛋岛原站的程序化骨骼系统
  setupCharacterRig(holderLike);

  spinner.add(holderLike);
  modelRoot = holderLike;
  frameCamera(info.height);
  baseY = 0;
  jumpY = 0;
  jumpVel = 0;
  rigReady = true;
  currentKey = modelKey;
  window.pet?.saveSettings({ model: modelKey });

  // 出场弹一下
  jumpVel = 1.6;
}

/* ---------------- 交互 ---------------- */
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let hovering = false;
let dragging = false;      // 左键：旋转角色
let movingWin = false;     // 右键：拖窗口
let winMoved = false;
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
  if (!modelRoot) return false;
  const hits = raycaster.intersectObjects(modelRoot.children, true);
  return hits.length > 0;
}

window.addEventListener('pointermove', (ev) => {
  if (dragging) {
    const dx = ev.clientX - lastX;
    lastX = ev.clientX;
    yaw += dx * 0.014;
    yawVel = dx * 0.014;   // 松手后带一点惯性
    return;
  }
  if (movingWin) {
    winMoved = true;
    window.pet?.dragMove();
    return;
  }
  setHover(hitTest(ev));
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
  if (!hitTest(ev)) return;
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

// 数字键快速切模型
window.addEventListener('keydown', (ev) => {
  const keys = Object.keys(MODELS);
  const n = parseInt(ev.key, 10);
  if (n >= 1 && n <= keys.length) {
    const k = keys[n - 1];
    if (k !== currentKey) loadModel(k);
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

function tap() {
  // 双击打开聊天，单击放歌
  const now = Date.now();
  if (now - lastTapAt < 330) {
    lastTapAt = 0;
    window.pet?.openChat();
    return;
  }
  lastTapAt = now;

  toggleMusic();
  jumpVel = 2.2 + Math.min(tapCount, 3) * 0.25;
  tapCount++;
  clearTimeout(tapTimer);
  tapTimer = setTimeout(() => { tapCount = 0; }, 1200);
}
let tapTimer = null;

/* ---------------- 尺寸 ---------------- */
function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
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

  // 待机小动作：站一会儿坐下、偶尔蹦一下、转头看看
  poseTimer -= dt;
  if (poseTimer <= 0) {
    const roll = Math.random();
    if (roll < 0.34) {
      sitting = !sitting;
      poseTimer = sitting ? 7 + Math.random() * 7 : 12 + Math.random() * 10;
    } else if (roll < 0.62) {
      if (jumpVel === 0 && jumpY === 0) jumpVel = 1.5 + Math.random() * 1.1;
      poseTimer = 9 + Math.random() * 8;
    } else {
      yawVel = (Math.random() - 0.5) * 3.2;
      poseTimer = 8 + Math.random() * 9;
    }
  }

  // 悬浮：呼吸式上下浮动
  const bob = Math.sin(t * 1.6) * 0.035;

  // 跳跃物理
  if (jumpVel !== 0 || jumpY > 0) {
    jumpY += jumpVel * dt;
    jumpVel -= GRAVITY * dt;
    if (jumpY <= 0) {
      jumpY = 0;
      if (jumpVel < -0.4) {
        squash = 0.86;      // 落地压缩
        jumpVel = 0;
      } else {
        jumpVel = 0;
      }
    }
  }
  squash += (1 - squash) * Math.min(1, dt * 12);

  spinner.position.y = baseY + bob + jumpY;
  spinner.scale.set(
    1 + (1 - squash) * 0.55,
    squash,
    1 + (1 - squash) * 0.55
  );

  // 朝向：手动旋转（带惯性）；没转过时轻微摇摆
  yaw += yawVel;
  yawVel *= Math.exp(-7 * dt);
  if (Math.abs(yawVel) < 1e-4) yawVel = 0;
  const idleSway = Math.abs(yaw) < 0.02 ? Math.sin(t * 0.42) * 0.16 : 0;
  spinner.rotation.y = yaw + idleSway;

  // 骨骼：待机呼吸 + 悬浮放松 + 坐姿
  if (rigReady && modelRoot) {
    updateRig(modelRoot, {
      time: t,
      dt,
      speed: 0,
      turn: 0,
      floating: 0.85,
      reclining: sitting ? 1 : 0,
      groundHeight: 0,
      lantern: false
    });
  }

  renderer.render(scene, camera);
}

/* ---------------- 启动 ---------------- */
(async () => {
  window.__pet.stage = 'imported';
  renderer.render(scene, camera);
  const s = (await window.pet?.getSettings()) || {};
  try {
    window.__pet.stage = 'loading:' + (s.model || 'cake');
    await loadModel(s.model && MODELS[s.model] ? s.model : 'cake');
    window.__pet.stage = 'ready:' + currentKey;
  } catch (err) {
    window.__pet.stage = 'failed';
    window.__pet.error = String((err && (err.stack || err.message)) || err);
  }
  tick();
})();

window.pet?.onApplySettings((s) => {
  if (s.model && MODELS[s.model] && s.model !== currentKey) loadModel(s.model);
});

window.pet?.onSwitchModel((k) => {
  if (MODELS[k] && k !== currentKey) loadModel(k);
});

window.pet?.onToggleMusic(() => { toggleMusic(); });
window.pet?.onNextTrack(() => { nextTrack(); });

// 被召唤出来时：蹦一下 + 转半圈
window.pet?.onSummon(() => {
  jumpVel = 2.6;
  yawVel = 1.9;
});
