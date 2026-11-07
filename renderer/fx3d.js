/*
 * 3D 柔光粒子 —— 照着蛋岛原站 atmosphere.js 里那套星星 shader 的思路做的：
 *   核心 exp(-r²·k) 的软核 + 十字星芒，不是贴图、也不是 CSS 圆点。
 * 和原站的区别：那边是给不透明的夜空用的 AdditiveBlending，
 * 这个窗口是透明的，加色会把背景糊成灰团，所以这里用 NormalBlending + 预乘感的高光，
 * 背景保持全透明，粒子自己发光。
 *
 * 用法：
 *   const fx = createParticles(THREE, scene, 640);
 *   fx.burst({ x: 0, y: 0.75, z: 0.2 }, { n: 18, colors: ['#ffd678'], speed: 0.9 });
 *   tick 里 fx.update(t);
 * 所有粒子共用一个 BufferGeometry，环形复用，不产生垃圾对象。
 */
export function createParticles(THREE, scene, capacity = 640) {
  const geo = new THREE.BufferGeometry();
  const origin = new Float32Array(capacity * 3);
  const vel = new Float32Array(capacity * 3);
  const col = new Float32Array(capacity * 3);
  const start = new Float32Array(capacity);
  const life = new Float32Array(capacity);
  const size = new Float32Array(capacity);
  const seed = new Float32Array(capacity);

  const attr = (name, arr, n) => {
    const a = new THREE.BufferAttribute(arr, n);
    a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute(name, a);
    return a;
  };
  // three 靠 geometry.attributes.position 决定画多少个点，缺了它整批粒子一个都不画
  const aOrigin = attr('position', origin, 3);
  const aVel = attr('aVel', vel, 3);
  const aCol = attr('aColor', col, 3);
  const aStart = attr('aStart', start, 1);
  const aLife = attr('aLife', life, 1);
  const aSize = attr('aSize', size, 1);
  const aSeed = attr('aSeed', seed, 1);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.6, 0), 4);
  start.fill(-9999);           // 初始全部「已经死透」，不会画出东西
  life.fill(1);

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uScale: { value: 220 },
      uFade: { value: 1 }
    },
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.NormalBlending,
    vertexShader: /* glsl */`

      attribute vec3 aVel;
      attribute vec3 aColor;
      attribute float aStart;
      attribute float aLife;
      attribute float aSize;
      attribute float aSeed;
      uniform float uTime;
      varying vec3 vColor;
      varying float vAlpha;
      varying float vSeed;
      void main() {
        float age = uTime - aStart;
        float k = clamp(age / aLife, 0.0, 1.0);
        // 出生 0.06 秒淡入，之后平方衰减，别一出来就硬邦邦
        float fade = smoothstep(0.0, 0.06, age) * (1.0 - k) * (1.0 - k * 0.35);
        vec3 p = position + aVel * age;
        p.y -= 0.55 * age * age;              // 轻微下坠，像有重量
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        // 点尺寸按像素给，只做轻微远近缩放：除以 -mv.z 会把 10px 变成 700px，
        // 整屏糊成一层灰雾（这就是第一版看不见粒子的原因）
        gl_PointSize = aSize * (1.0 - 0.45 * k) * clamp(2.8 / max(0.4, -mv.z), 0.7, 1.8);
        vColor = aColor;
        vAlpha = (age <= 0.0 || k >= 1.0) ? 0.0 : fade;
        vSeed = aSeed;
      }
    `,
    fragmentShader: /* glsl */`
      varying vec3 vColor;
      varying float vAlpha;
      varying float vSeed;
      uniform float uFade;
      void main() {
        vec2 q = gl_PointCoord * 2.0 - 1.0;
        float r2 = dot(q, q);
        if (r2 > 1.0) discard;
        float core = exp(-r2 * 9.0);                          // 亮核收得很紧
        float halo = exp(-r2 * 2.6) * 0.22;                   // 柔光很淡
        float arm = 0.30 + 0.28 * sin(vSeed * 6.283);          // 有的带星芒，有的不带
        float sx = pow(max(0.0, 1.0 - abs(q.x) * 2.1), 22.0);
        float sy = pow(max(0.0, 1.0 - abs(q.y) * 2.1), 22.0);
        // pow(1-r2) 强制边缘归零：没有这一步，像素点会显出硬边圆盘的轮廓
        float fall = pow(max(0.0, 1.0 - r2), 1.7);
        float a = (core * 1.25 + halo + (sx + sy) * arm) * fall * vAlpha * uFade;
        if (a < 0.004) discard;
        vec3 c = vColor * (1.0 + core * 1.3) + vec3(core * 0.55);
        gl_FragColor = vec4(c, a);
      }
    `
  });

  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = 10;
  scene.add(points);

  let head = 0;
  let now = 0;

  const rgb = {};
  function toRgb(hex) {
    if (rgb[hex]) return rgb[hex];
    const h = hex.replace('#', '');
    const v = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
    const out = [(v >> 16 & 255) / 255, (v >> 8 & 255) / 255, (v & 255) / 255];
    rgb[hex] = out;
    return out;
  }

  // 发一撮：pos 世界坐标，colors 十六进制数组
  function burst(pos, o = {}) {
    const n = o.n || 12;
    const colors = o.colors || ['#fff6cd'];
    const speed = o.speed == null ? 0.85 : o.speed;
    const spread = o.spread == null ? 1 : o.spread;
    const lifeMin = o.lifeMin == null ? 0.5 : o.lifeMin;
    const lifeMax = o.lifeMax == null ? 1.25 : o.lifeMax;
    const sizeMin = o.sizeMin == null ? 6 : o.sizeMin;
    const sizeMax = o.sizeMax == null ? 13 : o.sizeMax;
    const up = o.up == null ? 0.55 : o.up;       // 向上的分量，0 = 全向球面
    const dir = o.dir || null;                    // 定向喷射（拖尾 / 走路往后甩）

    const ox = pos.x || 0, oy = pos.y || 0, oz = pos.z || 0;
    for (let i = 0; i < n; i++) {
      const j = head;
      head = (head + 1) % capacity;

      // 均匀球面采样，再压一点到上半球
      const th = Math.random() * Math.PI * 2;
      const cth = Math.random() * 2 - 1;
      const sth = Math.sqrt(1 - cth * cth);
      const sp = speed * (0.55 + Math.random() * 0.75);

      let vx = Math.sin(th) * sth * sp * spread;
      let vy = cth * sp * spread;
      let vz = Math.cos(th) * sth * sp * spread;
      if (dir) { vx += (dir.x || 0) * sp; vy += (dir.y || 0) * sp; vz += (dir.z || 0) * sp; }
      vy = Math.abs(vy) * up + vy * (1 - up) * 0.5;

      origin[j * 3] = ox + (Math.random() - 0.5) * (o.jitter || 0.06);
      origin[j * 3 + 1] = oy + (Math.random() - 0.5) * (o.jitter || 0.06);
      origin[j * 3 + 2] = oz + (Math.random() - 0.5) * (o.jitter || 0.06);
      vel[j * 3] = vx;
      vel[j * 3 + 1] = vy;
      vel[j * 3 + 2] = vz;

      const c = toRgb(colors[(Math.random() * colors.length) | 0]);
      col[j * 3] = c[0]; col[j * 3 + 1] = c[1]; col[j * 3 + 2] = c[2];

      start[j] = now;
      life[j] = lifeMin + Math.random() * (lifeMax - lifeMin);
      size[j] = sizeMin + Math.random() * (sizeMax - sizeMin);
      seed[j] = Math.random();
    }

    aOrigin.needsUpdate = true;
    aVel.needsUpdate = true;
    aCol.needsUpdate = true;
    aStart.needsUpdate = true;
    aLife.needsUpdate = true;
    aSize.needsUpdate = true;
    aSeed.needsUpdate = true;
  }

  return {
    points,
    material: mat,
    burst,
    update(t) {
      now = t;
      mat.uniforms.uTime.value = t;
    },
    resize(h) {
      mat.uniforms.uScale.value = h * 1.1;
    },
    clear() { start.fill(-9999); aStart.needsUpdate = true; }
  };
}
