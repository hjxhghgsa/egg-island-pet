/* 影视级光影：不引后处理、不破坏透明窗口，只在材质和灯光上做文章。
 *
 * 为什么不用 EffectComposer + Bloom：
 *   透明窗一旦走 RenderPass，默认会把背景清成不透明，200×200 的窗口直接变黑框；
 *   而且多一遍全屏 render pass，跟「后台休眠 / 1.3 秒启动」的约束冲突。
 *   这里改用「环境反射 + 视角边缘光 + 会呼吸的灯」，观感接近，开销几乎为零。
 *
 * 所有增强都能一键关掉（托盘 / 右键「影视级光影」），关掉后灯光回到原始数值。
 */

const RIM_UNIFORM = { value: 0.11 };
const BASE = { hemi: 1.35, key: 2.0, fill: 0.85, rim: 0.6 };

let sceneRef = null;
let lights = null;
let envTex = null;
let enabled = true;
let failed = false;

/* 程序化生成一张「摄影棚」环境贴图：暖顶光 + 冷侧光 + 背后暖轮廓。
   PMREM 预过滤后给 MeshPhysicalMaterial 当 IBL 用 —— 原来 material 写了
   envMapIntensity: 0.8 却从没设过 envMap，等于白写。这一步才让它真正生效。 */
function makeStudioEnv(THREE, renderer) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const g = c.getContext('2d');

  const sky = g.createLinearGradient(0, 0, 0, 128);
  sky.addColorStop(0.00, '#fff3e0');
  sky.addColorStop(0.42, '#efe0e6');
  sky.addColorStop(0.72, '#c3c9dc');
  sky.addColorStop(1.00, '#7c8ba8');
  g.fillStyle = sky;
  g.fillRect(0, 0, 256, 128);

  // 三盏柔光灯，对应场景里 key / fill / rim 的方向
  const spots = [
    [62, 26, 52, 'rgba(255,239,205,0.92)'],   // 暖主光
    [196, 40, 44, 'rgba(206,226,255,0.78)'],  // 冷补光
    [128, 8, 30, 'rgba(255,224,196,0.55)']    // 顶后轮廓
  ];
  for (const [x, y, r, col] of spots) {
    const rg = g.createRadialGradient(x, y, 0, x, y, r);
    rg.addColorStop(0, col);
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = rg;
    g.fillRect(0, 0, 256, 128);
  }

  const src = new THREE.CanvasTexture(c);
  src.mapping = THREE.EquirectangularReflectionMapping;
  src.colorSpace = THREE.SRGBColorSpace;
  const pmrem = new THREE.PMREMGenerator(renderer);
  let out = null;
  try { out = pmrem.fromEquirectangular(src).texture; } catch { out = null; }
  src.dispose();
  pmrem.dispose();
  return out;
}

export function setupCinema(THREE, scene, renderer, lightSet, on = true) {
  sceneRef = scene;
  lights = lightSet;
  enabled = !!on;
  try {
    envTex = makeStudioEnv(THREE, renderer);
    if (envTex && enabled) scene.environment = envTex;
  } catch (e) {
    failed = true;
    envTex = null;
  }
  return { env: !!envTex, failed };
}

/* Fresnel 轮廓光：视角越擦边越亮，动漫/影视打光里最出立体感的一笔。
   注进标准材质的 fragment 尾部，不新建材质、不改几何、不影响透明背景。
   万一 shader 编译不过，把开关关掉即可完全回退（不写在 try 里也拦不住 GPU 编译，
   所以提供了 cinemaState() 自检 + 菜单开关两道保险）。 */
export function enhanceMaterial(mat, detail = null) {
  if (!mat || !mat.isMeshPhysicalMaterial) return;
  // 记下原始值：关掉「影视级光影」时整组回退到原版材质，不是只关灯
  mat.userData.petBase = {
    normalMap: mat.normalMap || null,
    roughnessMap: mat.roughnessMap || null,
    roughness: mat.roughness,
    nx: mat.normalScale.x,
    ny: mat.normalScale.y
  };
  mat.userData.petDetail = detail || null;
  if (detail && enabled) applyDetail(mat, detail);
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uPetRim = RIM_UNIFORM;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uPetRim;')
      .replace('#include <dithering_fragment>', `
        #include <dithering_fragment>
        float petF = pow(1.0 - abs(dot(normalize(vNormal), normalize(vViewPosition))), 3.2);
        gl_FragColor.rgb += vec3(1.0, 0.82, 0.89) * petF * uPetRim;
      `);
  };
  mat.customProgramCacheKey = () => 'pet-cinema-rim-v1';
  mat.needsUpdate = true;
}

/* ---------------- 程序化细节贴图：不换模型也能把「3D 感」做出来 ----------------
   原站模型是 Tripo AI 生成、只有一张 baseColor 贴图（roughness 统一 0.9），
   所以看着偏平。这里从颜色贴图派生两张数据贴图：
     normalMap   —— 低频 Sobel 梯度，只取布料/头发的大起伏，不放大贴图噪点
     roughnessMap—— 亮处（白裙/皮肤）稍光滑、暗处（头发）保持哑光
   全部运行时生成、按贴图缓存、零新增文件；失败就退回原材质。 */
const detailCache = new Map();
let smoothedCount = 0;

function boxBlur(src, S) {
  const out = new Float32Array(src.length);
  for (let y = 0; y < S; y++) {
    const y0 = Math.max(0, y - 1), y1 = Math.min(S - 1, y + 1);
    for (let x = 0; x < S; x++) {
      const x0 = Math.max(0, x - 1), x1 = Math.min(S - 1, x + 1);
      let sum = 0;
      for (let yy = y0; yy <= y1; yy++) {
        for (let xx = x0; xx <= x1; xx++) sum += src[yy * S + xx];
      }
      out[y * S + x] = sum / ((y1 - y0 + 1) * (x1 - x0 + 1));
    }
  }
  return out;
}

export function makeDetailMaps(THREE, map) {
  if (!map || !map.image) return null;
  const key = map.uuid || 'single';
  if (detailCache.has(key)) return detailCache.get(key);
  try {
    const S = 384;                       // 降采样本身就是低通，省 CPU 又避噪
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(map.image, 0, 0, S, S);
    const px = g.getImageData(0, 0, S, S).data;

    const lum = new Float32Array(S * S);
    for (let i = 0; i < S * S; i++) {
      const j = i * 4;
      lum[i] = (px[j] * 0.299 + px[j + 1] * 0.587 + px[j + 2] * 0.114) / 255;
    }
    let a = boxBlur(lum, S);
    a = boxBlur(a, S);                   // 两轮，滤掉 JPEG 噪点和发丝级高频

    const nImg = g.createImageData(S, S);
    const rImg = g.createImageData(S, S);
    for (let y = 0; y < S; y++) {
      const yu = Math.max(0, y - 1) * S, yd = Math.min(S - 1, y + 1) * S;
      for (let x = 0; x < S; x++) {
        const xl = Math.max(0, x - 1), xr = Math.min(S - 1, x + 1);
        const dx = a[y * S + xr] - a[y * S + xl];
        const dy = a[yd + x] - a[yu + x];
        const nx = -dx * 5.0, ny = dy * 5.0, nz = 1;   // canvas y 向下，green 取反对齐 OpenGL
        const len = Math.hypot(nx, ny, nz);
        const j = (y * S + x) * 4;
        nImg.data[j] = (nx / len * 0.5 + 0.5) * 255;
        nImg.data[j + 1] = (ny / len * 0.5 + 0.5) * 255;
        nImg.data[j + 2] = (nz / len * 0.5 + 0.5) * 255;
        nImg.data[j + 3] = 255;
        // Three.js 的 roughnessMap 读 G 通道；亮处 0.62、暗处 0.94
        const v = Math.round((0.94 - 0.32 * a[y * S + x]) * 255);
        rImg.data[j] = rImg.data[j + 1] = rImg.data[j + 2] = v;
        rImg.data[j + 3] = 255;
      }
    }

    const mk = (img) => {
      const cc = document.createElement('canvas');
      cc.width = cc.height = S;
      cc.getContext('2d').putImageData(img, 0, 0);
      const t = new THREE.CanvasTexture(cc);
      // 数据贴图必须线性，且 UV 约定要跟 baseColor 完全一致，否则会错位
      t.colorSpace = THREE.NoColorSpace;
      t.flipY = map.flipY;
      t.wrapS = map.wrapS;
      t.wrapT = map.wrapT;
      t.anisotropy = 4;
      return t;
    };
    const out = { normal: mk(nImg), rough: mk(rImg) };
    detailCache.set(key, out);
    return out;
  } catch {
    return null;                       // canvas 被 tainted / 图片未解码 → 静默回退
  }
}

/* 低模硬边修复：GLB 因 UV 接缝把同位置顶点拆开、法线不连续，
   蛋糕纯只有 5620 顶点，棱角特别明显。按位置合并法线即可圆润，
   不动几何、不重算 UV、不需要源文件。 */
export function smoothNormals(THREE, geometry, blend = 0.72) {
  const pos = geometry?.attributes?.position, nor = geometry?.attributes?.normal;
  if (!pos || !nor || pos.isInterleavedBufferAttribute || nor.isInterleavedBufferAttribute) return false;
  try {
    const q = 1e4, sums = new Map(), keys = new Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      const k = Math.round(pos.getX(i) * q) + '|' + Math.round(pos.getY(i) * q) + '|' + Math.round(pos.getZ(i) * q);
      keys[i] = k;
      let s = sums.get(k);
      if (!s) { s = [0, 0, 0]; sums.set(k, s); }
      s[0] += nor.getX(i); s[1] += nor.getY(i); s[2] += nor.getZ(i);
    }
    for (const [k, s] of sums) {
      const l = Math.hypot(s[0], s[1], s[2]) || 1;
      sums.set(k, [s[0] / l, s[1] / l, s[2] / l]);
    }
    for (let i = 0; i < pos.count; i++) {
      const s = sums.get(keys[i]);
      if (!s) continue;
      const x = nor.getX(i) * (1 - blend) + s[0] * blend;
      const y = nor.getY(i) * (1 - blend) + s[1] * blend;
      const z = nor.getZ(i) * (1 - blend) + s[2] * blend;
      const l = Math.hypot(x, y, z) || 1;
      nor.setXYZ(i, x / l, y / l, z / l);
    }
    nor.needsUpdate = true;
    smoothedCount++;
    return true;
  } catch { return false; }
}

function applyDetail(mat, d) {
  if (!d) return;
  mat.normalMap = d.normal;
  mat.normalScale.set(0.26, 0.26);
  mat.roughnessMap = d.rough;
  mat.roughness = 1.0;                 // 让 G 通道全权决定粗糙度
  mat.needsUpdate = true;
}

function clearDetail(mat) {
  const b = mat.userData.petBase;
  if (!b) return;
  mat.normalMap = b.normalMap;
  mat.normalScale.set(b.nx, b.ny);
  mat.roughnessMap = b.roughnessMap;
  mat.roughness = b.roughness;
  mat.needsUpdate = true;
}

/* 灯会「呼吸」：静止时极轻微起伏，放歌时跟着低频能量亮一下，
   连击 / 贴边时轮廓光加强。energy 传 0~1。 */
export function updateCinema(t, energy = 0, boost = 0) {
  if (!lights) return;
  if (!enabled) {
    RIM_UNIFORM.value = 0;
    return;
  }
  const e = Math.max(0, Math.min(1, energy));
  const b = Math.max(0, Math.min(1, boost));
  const breath = Math.sin(t * 0.85) * 0.055;
  lights.key.intensity = BASE.key + breath + e * 0.30 + b * 0.22;
  lights.rim.intensity = BASE.rim + e * 0.45 + b * 0.30;
  lights.fill.intensity = BASE.fill + Math.sin(t * 0.6 + 1.2) * 0.035;
  RIM_UNIFORM.value = 0.10 + e * 0.07 + b * 0.09;
}

export function setCinema(on) {
  enabled = !!on;
  if (!sceneRef || !lights) return;
  sceneRef.environment = enabled ? envTex : null;
  RIM_UNIFORM.value = enabled ? 0.10 : 0;
  if (!enabled) {
    lights.hemi.intensity = BASE.hemi;
    lights.key.intensity = BASE.key;
    lights.fill.intensity = BASE.fill;
    lights.rim.intensity = BASE.rim;
  }
  sceneRef.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    mats.forEach((m) => {
      if (!m) return;
      if (m.userData.petBase) {
        if (enabled && m.userData.petDetail) applyDetail(m, m.userData.petDetail);
        else clearDetail(m);
      }
      m.needsUpdate = true;
    });
  });
}

export function cinemaState() {
  return {
    on: enabled, env: !!envTex, failed,
    rim: +RIM_UNIFORM.value.toFixed(3),
    key: lights ? +lights.key.intensity.toFixed(3) : null,
    sceneEnv: !!(sceneRef && sceneRef.environment),
    detailMaps: detailCache.size,
    smoothed: smoothedCount
  };
}
