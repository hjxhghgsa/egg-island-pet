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
export function enhanceMaterial(mat) {
  if (!mat || !mat.isMeshPhysicalMaterial) return;
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
  if (sceneRef.environment) {
    sceneRef.traverse((o) => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((m) => { if (m) m.needsUpdate = true; });
    });
  }
}

export function cinemaState() {
  return {
    on: enabled, env: !!envTex, failed,
    rim: +RIM_UNIFORM.value.toFixed(3),
    key: lights ? +lights.key.intensity.toFixed(3) : null,
    sceneEnv: !!(sceneRef && sceneRef.environment)
  };
}
