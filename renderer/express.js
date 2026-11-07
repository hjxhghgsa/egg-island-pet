/* renderer/express.js
 * 不依赖源文件的「表情 / 口型 / 精细手势」层。
 *
 * 背景：站里的三个 GLB 都是 Tripo 生成的，零 animation clip、零 morph target，
 * 上次据此得出「要做表情口型必须换一份带 blendshape 的新模型」——这个结论太绝对了。
 * 事实上有两条完全不需要源文件的路：
 *   1) 模型自带 42 根手部骨骼（左右各 5 指 x 4 节 + 手掌），以前只用来做「轻轻收拢」，
 *      其实足够演真正的手势；
 *   2) 表情/口型用一层很薄的 3D 面部片挂在 head 骨骼上，随转头一起动，
 *      平时整层隐藏（保住原贴图里那双精致的手绘大眼睛），只在眨眼 / 说话的
 *      那零点几秒显形。位置由顶点自动探测，两个角色、热导入模型、新生成模型都能用。
 *
 * 全部叠加在 updateRig() + softenHands() 之后，不改任何既有动画、不引入依赖。
 */
import * as THREE from '../vendor/three/three.module.js';

const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const smooth = (t) => t * t * (3 - 2 * t);

/* ==================== A. 精细手势 ==================== */

export const GESTURES = ['heart', 'wave', 'count', 'cheek', 'piano', 'open', 'fist'];

export const GESTURE_LINES = {
  heart: '给你一颗心', wave: '嗨，这边', count: '数一下', cheek: '想事情呢',
  piano: '随手弹两句', open: '摊手，没办法', fist: '加油'
};

/** pitchFn(bone, angle, axis) 由 pet.js 的 pitchBone 包装后传入，避免循环依赖。 */
export function createGestureDriver() {
  let rig = null;
  let pitch = null;
  let fingers = {};
  let arms = { L: null, R: null };
  let cur = null;
  let left = 0;
  let total = 1;
  let seq = 0;

  function rebind() {
    fingers = {};
    arms = { L: null, R: null };
    if (!rig) return;
    // rig.joints 里已登记的手指骨（1~3 节；第 4 节是末梢，弯不弯看不出来）
    for (const { bone } of rig.joints.values()) {
      const m = /Hand(Index|Middle|Ring|Pinky|Thumb)(\d)/i.exec(bone.name);
      if (m) fingers[(/Right/i.test(bone.name) ? 'R' : 'L') + m[1] + m[2]] = bone;
    }
    for (const a of (rig.arms || [])) arms[a.side === 'Left' ? 'L' : 'R'] = a;
  }

  const P = (b, a, axis = 'z') => { if (b && pitch) pitch(b, a, axis); };
  const F = (side, name, seg) => fingers[side + name + seg];
  /** 一根手指三节一起弯，幅度递减，像真的卷起来而不是整排翻 */
  const curl = (side, name, a) => {
    const w = [0.75, 1, 0.7];
    for (let i = 1; i <= 3; i++) P(F(side, name, i), a * w[i - 1]);
  };
  const curlFour = (side, a) => {
    for (const n of ['Index', 'Middle', 'Ring', 'Pinky']) curl(side, n, a);
  };
  const arm = (side, up, low, hand, axis = 'x') => {
    const a = arms[side];
    if (!a) return;
    P(a.upper, up, axis);
    P(a.lower, low, axis);
    if (hand) P(a.hand, hand, 'y');
  };

  function apply(name, t, k) {
    switch (name) {
      case 'wave': {                       // 招手：抬右臂、手掌摆、五指张开
        const sw = Math.sin(t * 7.2);
        arm('R', -0.95 + sw * 0.10, -0.22, sw * 0.22);
        curlFour('R', -0.05 * k);
        break;
      }
      case 'heart': {                     // 比心：双手捧到胸前，拇指食指相扣
        for (const s of ['L', 'R']) {
          const sign = s === 'L' ? 1 : -1;
          arm(s, -0.52, -0.78, 0);
          P(arms[s]?.hand, sign * 0.18, 'z');
          curl(s, 'Thumb', -0.42);
          curl(s, 'Index', -0.30);
          curl(s, 'Middle', -0.52);
          curl(s, 'Ring', -0.58);
          curl(s, 'Pinky', -0.60);
        }
        break;
      }
      case 'count': {                     // 数数：只伸食指，跟着节奏点
        const n = Math.floor((total - left) * 2.2) % 4;
        arm('R', -0.72, -0.70, 0);
        curlFour('R', -0.58);
        curl('R', 'Index', 0.06 * k + (n === 0 ? 0.10 : 0));
        P(arms.R?.hand, Math.sin(t * 4.6) * 0.14, 'z');
        break;
      }
      case 'cheek': {                     // 托腮：手抬到脸侧，指节微曲
        arm('R', -0.88, -1.02, 0);
        curlFour('R', -0.24);
        P(arms.R?.hand, 0.22, 'z');
        break;
      }
      case 'piano': {                     // 弹琴：双手前伸，八根手指依次起落
        for (const s of ['L', 'R']) {
          arm(s, -0.46, -0.52, 0);
          const names = ['Index', 'Middle', 'Ring', 'Pinky'];
          names.forEach((n, i) => {
            const off = s === 'R' ? 0 : 1.7;
            curl(s, n, -0.18 + Math.sin(t * 9.2 + i * 1.15 + off) * 0.30);
          });
        }
        break;
      }
      case 'open': {                      // 摊手：五指全伸，手心朝上
        for (const s of ['L', 'R']) {
          arm(s, -0.50, -0.34, 0);
          P(arms[s]?.hand, (s === 'L' ? 1 : -1) * 0.34, 'z');
          curlFour(s, -0.045 * k);
        }
        break;
      }
      case 'fist': {                      // 握拳加油：小幅上下
        const b = Math.sin(t * 5.4) * 0.12;
        for (const s of ['L', 'R']) {
          arm(s, -0.62 + b, -0.66, 0);
          curlFour(s, -0.62);
          curl(s, 'Thumb', -0.34);
        }
        break;
      }
      default: break;
    }
  }

  return {
    bind(r, pitchFn) { rig = r; pitch = pitchFn; rebind(); },
    play(name, seconds = 3.2) {
      if (!GESTURES.includes(name) || !rig) return false;
      cur = name; total = seconds; left = seconds; seq++;
      return true;
    },
    stop() { cur = null; left = 0; },
    update(t, dt) {
      if (!cur || !rig || left <= 0) { cur = null; return; }
      // 首尾 0.35 秒淡入淡出，避免手势「啪」地跳出来
      const inK = smooth(clamp((total - left) / 0.35));
      const outK = smooth(clamp(left / 0.35));
      apply(cur, t, Math.min(inK, outK));
      left -= dt;
      if (left <= 0) cur = null;
    },
    state() {
      return {
        current: cur, remaining: +Math.max(0, left).toFixed(2),
        played: seq, available: GESTURES.length,
        fingerBones: Object.keys(fingers).length, arms: (rig?.arms || []).length
      };
    }
  };
}

/* ==================== B. 3D 面部层（眨眼 / 口型） ==================== */

/** 闭眼图案：肤色底 + 一根深色弯睫毛，边缘羽化，盖住原眼睛不会留硬边补丁。 */
function eyelidTexture(THREE) {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 96;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 48, 8, 64, 48, 60);
  grd.addColorStop(0, 'rgba(249,222,209,1)');
  grd.addColorStop(0.60, 'rgba(249,222,209,0.98)');
  grd.addColorStop(1, 'rgba(249,222,209,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 96);
  g.strokeStyle = 'rgba(74,48,44,0.92)';
  g.lineWidth = 6;
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(22, 48);
  g.quadraticCurveTo(64, 70, 106, 46);
  g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** 嘴：一张透明底的小画布，按开口大小重绘，几个离散口型就够说话用。 */
function mouthTexture(THREE) {
  const c = document.createElement('canvas');
  c.width = 96; c.height = 96;
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return { canvas: c, tex: t };
}

function drawMouth(m, open, wide) {
  const g = m.canvas.getContext('2d');
  g.clearRect(0, 0, 96, 96);
  const w = 20 + wide * 14;
  const h = 3 + open * 20;
  const cy = 48;
  const grd = g.createRadialGradient(48, cy, 2, 48, cy, 40);
  grd.addColorStop(0, 'rgba(126,62,66,0.94)');
  grd.addColorStop(0.55, 'rgba(150,78,80,0.86)');
  grd.addColorStop(1, 'rgba(150,78,80,0)');
  g.fillStyle = grd;
  g.beginPath();
  g.ellipse(48, cy, w, h, 0, 0, Math.PI * 2);
  g.fill();
  if (open > 0.45) {                     // 张嘴时透一点舌头/下唇的粉
    g.fillStyle = 'rgba(238,142,148,0.55)';
    g.beginPath();
    g.ellipse(48, cy + h * 0.48, w * 0.55, h * 0.30, 0, 0, Math.PI * 2);
    g.fill();
  }
  m.tex.needsUpdate = true;
}

/**
 * 自动探测脸部：找「头部高度、法线朝前、最靠前」的那批顶点，
 * 得到一个面部包围盒。比猜固定偏移稳得多，换角色/换生成模型都不用重调。
 */
function probeFace(THREE, root, rig) {
  const head = rig?.head;
  root.updateWorldMatrix(true, true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const box = new THREE.Box3().setFromObject(root);
  const H = Math.max(0.1, box.max.y - box.min.y);
  // 有 head 骨骼就按骨骼定位（骨骼原点约在 50% 身高、脖子上方）。
  // AI 重建模型没有骨骼，退化到同一语义的 50.6% 身高——
  // 之前按 78% 估会把五官整体推到额头上，实测原角色 head 骨骼是 0.683/1.35。
  const headY = head
    ? root.worldToLocal(head.getWorldPosition(new THREE.Vector3())).y
    : box.min.y + H * 0.428;
  const v = new THREE.Vector3(), n = new THREE.Vector3();
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, maxZ = -Infinity;
  let count = 0;
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.position || !o.geometry?.attributes?.normal) return;
    const pos = o.geometry.attributes.position;
    const nor = o.geometry.attributes.normal;
    const m = new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld);
    const nm = new THREE.Matrix3().getNormalMatrix(m);
    const step = Math.max(1, Math.floor(pos.count / 12000));
    for (let i = 0; i < pos.count; i += step) {
      n.fromBufferAttribute(nor, i).applyMatrix3(nm).normalize();
      if (n.z < 0.52) continue;                       // 只要朝镜头的表面
      v.fromBufferAttribute(pos, i).applyMatrix4(m);
      if (v.y < headY - H * 0.19 || v.y > headY + H * 0.30) continue;
      if (Math.abs(v.x) > H * 0.24) continue;
      minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
      minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
      maxZ = Math.max(maxZ, v.z);
      count++;
    }
  });
  if (count < 12 || !Number.isFinite(maxZ)) return null;
  return {
    cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, z: maxZ,
    w: maxX - minX, h: maxY - minY, H, count,
    headY, hasHeadBone: !!head
  };
}

export function createFaceLayer() {
  let group = null;
  let lids = [];
  let mouth = null;
  let mouthMesh = null;
  let face = null;
  let params = null;
  let nextBlink = 2.2;
  let blinkLeft = 0;
  let blinkCount = 0;
  let talkLeft = 0;
  let talkTotal = 0;
  let viseme = 0;
  let lastDraw = -1;
  let enabled = true;
  let held = false;          // 调试：把眨眼 / 口型贴片常显，用来校准位置
  let attached = null;
  let rootRef = null;

  // 探测框会把生日帽 / 头发一起框进来，w、h 明显偏大，不能拿来当五官尺度。
  // 改用 headY + 身高比例定五官：两个原角色和重建模型都落在同一套比例上。
  // 比例来自 303px 窗口截图的像素实测：两眼 y≈123、间距≈24px。
  // 早期版本按探测框比例给，贴片会跑到额头上、还宽了一倍。
  const defaultParams = (f) => ({
    eyeX: f.H * 0.056,
    eyeY: f.headY + f.H * 0.056,
    eyeW: f.H * 0.052,
    eyeH: f.H * 0.040,
    mouthY: f.headY - f.H * 0.024,
    mouthW: f.H * 0.040,
    mouthH: f.H * 0.032,
    z: f.z + f.H * 0.008
  });

  function dispose() {
    if (group && attached) attached.remove(group);
    group?.traverse((o) => { if (o.isMesh) { o.geometry?.dispose?.(); o.material?.map?.dispose?.(); o.material?.dispose?.(); } });
    group = null; attached = null; lids = []; mouthMesh = null; mouth = null;
  }

  /** 在模型加载完成后调用：root = holderLike，rig = 它的 islandRig */
  function bind(THREE, root, rig) {
    dispose();
    rootRef = root;
    face = probeFace(THREE, root, rig);
    if (!face) return false;
    params = defaultParams(face);

    const parent = rig?.head || root;
    group = new THREE.Group();
    // 有骨骼就抵消 head 的世界旋转，让面部层贴在脸上；
    // 无骨骼（AI 重建模型）直接挂 root，四元数自然退化成单位。
    const pq = parent.getWorldQuaternion(new THREE.Quaternion());
    const rq = root.getWorldQuaternion(new THREE.Quaternion());
    group.quaternion.copy(pq.invert().multiply(rq));
    parent.add(group);
    attached = parent;

    const lidTex = eyelidTexture(THREE);
    const lidMat = new THREE.MeshBasicMaterial({
      map: lidTex, transparent: true, depthWrite: false,
      side: THREE.DoubleSide, toneMapped: false
    });
    for (const s of [-1, 1]) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), lidMat);
      m.renderOrder = 6;
      m.visible = false;
      group.add(m);
      lids.push(m);
    }
    mouth = mouthTexture(THREE);
    mouthMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: mouth.tex, transparent: true, depthWrite: false,
                                   side: THREE.DoubleSide, toneMapped: false })
    );
    mouthMesh.renderOrder = 7;
    mouthMesh.visible = false;
    group.add(mouthMesh);

    layout();
    return true;
  }

  function layout() {
    if (!group || !params || !face || !rootRef || !attached) return;
    // 面部层挂在 head 骨骼下，骨骼有自己的旋转和缩放。最稳的做法是：
    // 先算出目标点在 root 空间的世界坐标，再用 group.worldToLocal 反解，
    // 不手推骨骼矩阵。换角色 / 换热导入模型 / 头转过去都不会飘。
    rootRef.updateWorldMatrix(true, true);
    group.updateWorldMatrix(true, false);
    const s = attached.getWorldScale(new THREE.Vector3());
    const sx = 1 / Math.max(Math.abs(s.x), 1e-4);
    const sy = 1 / Math.max(Math.abs(s.y), 1e-4);
    const put = (mesh, x, y, w, h) => {
      if (!mesh) return;
      const p = rootRef.localToWorld(new THREE.Vector3(x, y, params.z));
      mesh.position.copy(group.worldToLocal(p));
      mesh.scale.set(w * sx, h * sy, 1);
    };
    put(lids[0], face.cx - params.eyeX, params.eyeY, params.eyeW, params.eyeH);
    put(lids[1], face.cx + params.eyeX, params.eyeY, params.eyeW, params.eyeH);
    put(mouthMesh, face.cx, params.mouthY, params.mouthW, params.mouthH);
  }

  return {
    bind,
    dispose,
    calibrate(patch) {
      if (!params) return false;
      Object.assign(params, patch || {});
      layout();
      return true;
    },
    blink() { blinkLeft = 0.14; blinkCount++; },
    /** 说话 / 朗读 / 哼歌：给一段时长，嘴按音节节奏张合 */
    speak(seconds = 2.4) { talkLeft = seconds; talkTotal = seconds; },
    stopSpeak() { talkLeft = 0; },
    setEnabled(on) { enabled = !!on; if (!enabled && group) group.visible = false; },
    hold(on) { held = !!on; },
    update(t, dt) {
      if (!group) return;
      group.visible = enabled;
      // 眨眼：平均 3~5 秒一次，双闪偶尔来一下
      nextBlink -= dt;
      if (nextBlink <= 0) { blinkLeft = 0.14; blinkCount++; nextBlink = 2.6 + Math.random() * 3.2; }
      if (blinkLeft > 0) blinkLeft -= dt;
      const blinking = blinkLeft > 0;
      lids.forEach((m) => { m.visible = enabled && (blinking || held); });

      if (talkLeft > 0) talkLeft -= dt;
      const talking = talkLeft > 0;
      mouthMesh.visible = enabled && (talking || held);
      if (mouthMesh.visible) {
        // 5~7Hz 音节 + 一点慢速包络，别像电动门一样匀速开合
        const syl = Math.abs(Math.sin(t * 19.5)) * (0.55 + 0.45 * Math.abs(Math.sin(t * 3.1)));
        const fade = clamp(talkLeft / 0.25);
        const open = talking ? clamp(syl * fade) : 0.55;
        const wide = talking ? 0.35 + 0.45 * Math.abs(Math.sin(t * 6.3)) : 0.5;
        const key = talking ? Math.round(open * 10) * 100 + Math.round(wide * 10) : 99999;
        if (key !== lastDraw) { drawMouth(mouth, open, wide); lastDraw = key; }
        viseme = open;
      }
    },
    state() {
      return {
        ready: !!group, enabled, face, params,
        blinks: blinkCount, blinking: blinkLeft > 0, held,
        talking: talkLeft > 0, viseme: +viseme.toFixed(2)
      };
    }
  };
}
