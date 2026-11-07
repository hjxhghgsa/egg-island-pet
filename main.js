const { app, BrowserWindow, ipcMain, Tray, Menu, screen, nativeImage, dialog, desktopCapturer, shell, globalShortcut, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');

// 启动耗时排查：PET_TIMING=1 时把各阶段毫秒数写到用户目录，正常启动零开销
const BOOT_T0 = Date.now();
function bootLog(label) {
  if (!process.env.PET_TIMING) return;
  try {
    fs.appendFileSync(
      path.join(app.getPath('userData'), 'boot-timing.log'),
      new Date().toISOString() + '  +' + String(Date.now() - BOOT_T0).padStart(6) + 'ms  ' + label + '\n'
    );
  } catch {}
}

// 透明窗口在 Windows 上的必要开关；顺手关掉几个纯本地应用用不到的
// Chromium 后台服务（组件更新 / 翻译 / 投屏 / 优化提示），少起进程、少占内存。
app.commandLine.appendSwitch('disable-features',
  'CalculateNativeWinOcclusion,MediaRouter,Translate,OptimizationHints,ComponentUpdater');
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-default-apps');
// Chromium 默认禁止 file:// 页面加载 ES module，桌面应用需要放开
app.commandLine.appendSwitch('allow-file-access-from-files');

// Windows 上系统通知要有 AppUserModelId 才弹得出来
app.setAppUserModelId('com.mumu.eggislandpet');
// 开发跑和打包跑的用户目录统一，歌单/设置才能共用
app.setPath('userData', path.join(app.getPath('appData'), 'EggIslandPet'));

// 只允许一个实例；重复双击就召唤已有的那只
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => { summon(); });
}

// three.module.js 只是个入口，真正的实现在同目录的 three.core.js。
// 缺了就补一次，之后走本地，永久离线。
const THREE_DIR = path.join(__dirname, 'vendor', 'three');
const THREE_CORE = path.join(THREE_DIR, 'three.core.js');

function ensureThreeCore() {
  if (fs.existsSync(THREE_CORE) && fs.statSync(THREE_CORE).size > 100000) return Promise.resolve(true);
  return new Promise((resolve) => {
    const tmp = THREE_CORE + '.part';
    const req = https.get('https://eggislandgame.xyz/vendor/build/three.core.js', { timeout: 30000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return resolve(false);
      }
      const file = fs.createWriteStream(tmp);
      res.pipe(file);
      file.on('finish', () => {
        file.close(() => {
          try { fs.renameSync(tmp, THREE_CORE); resolve(true); }
          catch { resolve(false); }
        });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => { try { fs.unlinkSync(tmp); } catch {} resolve(false); });
  });
}

const WIN_W = 200;
const WIN_H = 200;

const settingsPath = () => path.join(app.getPath('userData'), 'pet-settings.json');

function readSettings() {
  try { return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')); } catch { return {}; }
}
function writeSettings(patch) {
  const cur = readSettings();
  const next = { ...cur, ...patch };
  try { fs.mkdirSync(app.getPath('userData'), { recursive: true }); fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2)); } catch {}
  return next;
}

let win = null;
let tray = null;
let dragOrigin = null;
let autoHideTimer = null;
let userTouched = false;      // 被主人召唤/摸过，这一轮就不再自动收起
let petHovered = false;       // 鼠标正停在角色身上
const SUMMON_KEY = 'Control+Alt+E';
const HIDE_DELAY = 2500;      // 失焦后等一下再藏，避免误判
const BOOT_GRACE = 8000;      // 刚启动的 8 秒里绝不自动藏

function autoHideEnabled() { return readSettings().autoHide === true; }

function cancelAutoHide() {
  if (autoHideTimer) { clearTimeout(autoHideTimer); autoHideTimer = null; }
}

// 所有显示/隐藏都走这两个入口：顺带通知渲染层休眠 / 唤醒，
// 免得窗口藏起来后 WebGL 还在 60fps 空转吃显卡和内存。
function showPet({ focus = false } = {}) {
  if (!win || win.isDestroyed()) return;
  if (!win.isVisible()) {
    win.show();
    win.setAlwaysOnTop(true, 'screen-saver');
    win.webContents.send('pet-resume');
  }
  if (focus) win.focus();
}

function hidePet() {
  stopFling();
  stopGlide();
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  win.webContents.send('pet-pause');
  win.hide();
}

// 只有「真的切到别的软件」才考虑收起。
// 关键：不再有启动后无条件 3 秒定时器 —— 人还在桌面、什么都没点时绝不自己消失。
function maybeAutoHide() {
  cancelAutoHide();
  if (!autoHideEnabled()) return;
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  if (userTouched || petHovered) return;
  if (Date.now() - BOOT_T0 < BOOT_GRACE) return;
  if (chatWin && !chatWin.isDestroyed()) return;
  if (snipWin && !snipWin.isDestroyed()) return;
  if (peekTimer) return;                    // 正在说话，说完再收
  autoHideTimer = setTimeout(() => {
    autoHideTimer = null;
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    if (win.isFocused() || userTouched || petHovered) return;
    if (chatWin && !chatWin.isDestroyed()) return;
    hidePet();
    console.log('[autohide] focus moved to another app');
  }, HIDE_DELAY);
}

function createWindow() {
  const s = readSettings();
  const { workArea } = screen.getPrimaryDisplay();

  const x = Number.isFinite(s.x) ? s.x : workArea.x + workArea.width - WIN_W - 30;
  const y = Number.isFinite(s.y) ? s.y : workArea.y + workArea.height - WIN_H - 10;

  win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x, y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: true,
    // 直接建窗，不等 ready-to-show 再 show；透明窗口提前出现也不会闪白
    show: true,
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 关键：让 Chromium 在窗口隐藏时正常节流后台渲染，
      // 之前写 false 等于强制桌宠在后台也满帧跑 WebGL。
      backgroundThrottling: true,
      // 纯本地应用，只加载本机文件；关掉安全检查以便 file:// 下能用 ES module
      webSecurity: false
    }
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // 默认鼠标穿透透明区域，渲染层检测到悬停在宠物身上时再打开点击
  win.setIgnoreMouseEvents(true, { forward: true });

  // 长按右键拖动时，系统偶尔会把透明窗口撑大；尺寸一偏离就锁回来
  win.on('resize', () => {
    if (!win || win.isDestroyed()) return;
    try {
      const b = win.getBounds();
      if (b.width !== WIN_W || b.height !== WIN_H) {
        win.setBounds({ x: b.x, y: b.y, width: WIN_W, height: WIN_H });
      }
    } catch {}
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.once('ready-to-show', () => {
    showPet();
    const q = s.quality || 'balanced';
    win.webContents.send('apply-settings', { quality: q, scale: s.scale || 1, model: s.model || 'cake' });
    maybeGreet();                     // 启动露脸时说一句时段问候
    bootLog('ready-to-show / first paint');
    // 启动后就留在桌面上。不再「开完机 3 秒自己消失」——
    // 只有主人真的切进别的软件、且在托盘里开了自动隐藏时才收起。
  });

  // 别的窗口抢焦点时会被压下去，这里抢回最上层
  const keepTop = () => {
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    win.setAlwaysOnTop(true, 'screen-saver');
  };
  win.on('blur', () => {
    setTimeout(keepTop, 120);
    maybeAutoHide();
  });
  win.on('focus', () => { cancelAutoHide(); keepTop(); });
  win.on('show', () => setTimeout(keepTop, 120));
  // 兜底从 15s 降到 60s，且窗口藏起来时一次原生调用都不做
  const topGuard = setInterval(() => {
    if (win && !win.isDestroyed() && win.isVisible()) win.setAlwaysOnTop(true, 'screen-saver');
  }, 60000);
  if (topGuard.unref) topGuard.unref();

  // 渲染进程 OOM / GPU 崩掉时自己重载，不然就是一个透明的空窗口
  win.webContents.on('render-process-gone', (_e, d) => {
    console.log('[renderer gone]', d && d.reason);
    if (win && !win.isDestroyed() && d && d.reason !== 'clean-exit') {
      setTimeout(() => { if (win && !win.isDestroyed()) win.reload(); }, 800);
    }
  });

  // 调试：PET_DEBUG=1 把渲染进程的 console（含 shader 编译错误）打到主进程 stdout
  if (process.env.PET_DEBUG) {
    win.webContents.on('console-message', (_e, lvl, msg) => console.log('[wc]', msg));
  }

  win.on('closed', () => {
    clearInterval(topGuard);        // 不清理的话，窗口每重建一次就多一个 60s 定时器
    win = null;
  });
}

const GREETS = {
  morning: ['早', '醒了就起来', '今天想干点啥'],
  noon: ['吃饭去', '别边吃边干', '这个点该歇了'],
  evening: ['晚上好', '今天怎么样', '收个尾吧'],
  night: ['还不睡？', '夜猫子', '我陪你一会儿，然后睡']
};

function greetSlot() {
  const h = new Date().getHours();
  if (h >= 5 && h < 11) return 'morning';
  if (h >= 11 && h < 17) return 'noon';
  if (h >= 17 && h < 23) return 'evening';
  return 'night';
}

function maybeGreet() {
  const slot = greetSlot();
  const day = new Date().toISOString().slice(0, 10);
  const s = readSettings();
  if (s.greet === day + ':' + slot) return;      // 这个时段已经打过招呼了
  writeSettings({ greet: day + ':' + slot });
  const lines = GREETS[slot];
  setTimeout(() => petSay(lines[Math.floor(Math.random() * lines.length)]), 700);
}

function summon() {
  if (!win || win.isDestroyed()) return createWindow();
  cancelAutoHide();
  // 攒着的提醒，召唤时一次性说给主人听
  if (pendingSays.length) {
    const line = pendingSays.splice(0).join('  /  ');
    setTimeout(() => {
      if (win && !win.isDestroyed()) win.webContents.send('pet-say', { text: line });
    }, 450);
  }
  userTouched = true;
  showPet({ focus: true });
  win.webContents.send('summon');
  maybeGreet();
}

function dismiss() {
  cancelAutoHide();
  hidePet();
}

function toggleVisible() {
  if (!win || win.isDestroyed()) return createWindow();
  if (win.isVisible()) dismiss();
  else summon();
}

function buildTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'icon.ico'));
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 16, height: 16 }));
  tray.setToolTip('蛋岛宠物');
  const menu = Menu.buildFromTemplate([
    { label: '召唤 / 收起  (' + SUMMON_KEY.replace('Control', 'Ctrl') + ')', click: toggleVisible },
    { type: 'separator' },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked })
    },
    {
      // 默认关：人在桌面待着、什么都没点开时，绝不自作主张藏起来
      label: '切到别的软件时自动隐藏',
      type: 'checkbox',
      checked: readSettings().autoHide === true,
      click: (item) => {
        writeSettings({ autoHide: item.checked });
        if (!item.checked) cancelAutoHide();
      }
    },
    { label: '回到右下角', click: () => {
        const { workArea } = screen.getPrimaryDisplay();
        if (win) {
          win.setPosition(workArea.x + workArea.width - WIN_W - 30, workArea.y + workArea.height - WIN_H - 10);
          writeSettings({ x: win.getBounds().x, y: win.getBounds().y });
        }
      } },
    { type: 'separator' },
    { label: '退出', click: () => { app.isQuitting = true; app.quit(); } }
  ]);
  tray.setContextMenu(menu);
  tray.on('double-click', toggleVisible);
}

app.whenReady().then(async () => {
  // 语音识别要麦克风权限
  const { session } = require('electron');
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(permission === 'media' || permission === 'audioCapture' || permission === 'microphone');
  });

  bootLog('app.whenReady');

  // three.core.js 是打包时就带上的本地文件。别为了「确认一下它在不在」
  // 而 await 一次网络请求——桌面启动不该被任何 I/O 卡住。
  try {
    if (!fs.existsSync(THREE_CORE) || fs.statSync(THREE_CORE).size <= 100000) {
      ensureThreeCore().then((ok) => {
        if (!ok) dialog.showErrorBox('缺少运行库',
          '无法下载 three.core.js，请检查网络后重试。\n\n目标路径：\n' + THREE_CORE);
      });
    }
  } catch { /* 缺文件也不阻塞启动，渲染层会给出错误提示 */ }

  buildTray();          // 托盘先就位，再建窗，避免 ready-to-show 时托盘还没建好
  bootLog('tray ready');
  createWindow();
  bootLog('window created');

  // 打包后按设置开机自启（开发模式不自启）
  if (app.isPackaged && readSettings().openAtLogin) {
    try { app.setLoginItemSettings({ openAtLogin: true }); } catch {}
  }

  try {
    const ok = globalShortcut.register(SUMMON_KEY, toggleVisible);
    console.log('[hotkey]', SUMMON_KEY, ok ? 'registered' : 'FAILED');
  } catch (e) {
    console.error('[hotkey]', e.message);
  }

  // 调试：PET_SHOT=<路径> 时抓一张桌面合成图后退出
  if (process.env.PET_SNIP_DRAW) {
    setTimeout(async () => {
      try {
        const r = await snipWin.webContents.executeJavaScript(`
          (() => {
            const cx = innerWidth * 0.5, cy = innerHeight * 0.5;
            window.dispatchEvent(new MouseEvent('mousedown', { clientX: cx + 130, clientY: cy, button: 0 }));
            for (let i = 0; i <= 60; i++) {
              const a = (i / 60) * Math.PI * 2;
              window.dispatchEvent(new MouseEvent('mousemove', {
                clientX: cx + Math.cos(a) * 130,
                clientY: cy + Math.sin(a) * 95
              }));
            }
            window.dispatchEvent(new MouseEvent('mouseup', {}));
            return 'drawn';
          })()
        `);
        console.log('[draw]', r);
      } catch (e) { console.error('[draw fail]', e.message); }
    }, 9500);
  }
  if (process.env.PET_CHAT) setTimeout(() => openChat(), 3500);
  if (process.env.PET_SUMMON) setTimeout(() => { summon(); console.log('[summon] called'); }, 6000);
  // 调试：PET_MODEL=cake 走一次真实的「换个角色」IPC 路径
  if (process.env.PET_MODEL) {
    setTimeout(() => {
      if (win && !win.isDestroyed()) win.webContents.send('switch-model', process.env.PET_MODEL);
      console.log('[model] switch ->', process.env.PET_MODEL);
    }, 5000);
  }
  if (process.env.PET_MUSIC) {
    setTimeout(async () => {
      try {
        const r = await win.webContents.executeJavaScript(
          `window.pet.listMusic().then(t => JSON.stringify({count: t.length, names: t}))`
        );
        console.log('[music-test]', r);
      } catch (e) { console.error('[music-test fail]', e.message); }
    }, 5000);
  }
  // 调试：PET_ASR_IPC=1 完全模拟渲染层分块送 PCM，验证 IPC + addon 全链路
  if (process.env.PET_ASR_IPC) {
    setTimeout(async () => {
      try {
        // 打包版也能测：优先从用户目录拿测试音频，结果写文件（GUI 进程 stdout 不进管道）
        const probeOut = path.join(app.getPath('userData'), '_asr_ipc_result.txt');
        const raw = [app.getPath('userData'), __dirname]
          .map((d) => path.join(d, '_asr_test.raw'))
          .find((p) => fs.existsSync(p));
        if (!raw) { fs.writeFileSync(probeOut, 'NO_RAW'); app.isQuitting = true; app.quit(); return; }
        const b64 = fs.readFileSync(raw).toString('base64');
        const r = await win.webContents.executeJavaScript(`(async () => {
          const bin = atob(${JSON.stringify(b64)});
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          const all = new Float32Array(bytes.buffer);
          const st = await window.pet.asrStart();
          if (!st.ok) return 'START_FAIL ' + st.error;
          for (let i = 0; i < all.length; i += 1600) {
            window.pet.asrChunk(new Float32Array(all.slice(i, i + 1600)).buffer);
          }
          await new Promise((r) => setTimeout(r, 200));   // 等主进程收完排队的分块
          return JSON.stringify(await window.pet.asrEnd());
        })()`);
        console.log('[asr-ipc]', r);
        try { fs.writeFileSync(probeOut, String(r)); } catch {}
      } catch (e) {
        console.error('[asr-ipc fail]', e.stack || e.message);
        try { fs.writeFileSync(path.join(app.getPath('userData'), '_asr_ipc_result.txt'), 'ERR ' + e.message); } catch {}
      }
      app.isQuitting = true; app.quit();
    }, 2500);
  }
  // 调试：PET_ASR_TEST=1 用本地 wav 走一遍真实主进程识别链路
  if (process.env.PET_ASR_TEST) {
    setTimeout(async () => {
      try {
        // 用 raw f32 文件模拟渲染层通过 IPC 传来的普通 ArrayBuffer，
        // 不走 readWave()（它返回 native external buffer，Electron 会拒绝）
        const raw = path.join(__dirname, '_asr_test.raw');
        if (!fs.existsSync(raw)) { console.log('[asr-test] no raw'); }
        else {
          const buf = fs.readFileSync(raw);
          const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
          const all = new Float32Array(ab);
          console.log('[asr-test] step1 samples', all.length);
          const rec = getAsr();
          console.log('[asr-test] step2 recognizer ok');
          const s = rec.createStream();
          s.acceptWaveform({ samples: all, sampleRate: 16000 });
          rec.decode(s);
          console.log('[asr-test] step3 decoded');
          const rawText = rec.getResult(s).text;
          console.log('[asr-test] RESULT', JSON.stringify(rawText));
          const polished = await polishAsr(rawText);
          console.log('[asr-test] POLISHED', JSON.stringify(polished));
        }
      } catch (e) { console.error('[asr-test fail]', e.stack || e.message); }
      app.isQuitting = true; app.quit();
    }, 2000);
  }
  // 调试：PET_EVAL="表达式" 在渲染进程里跑一段 JS 并把结果打出来
  if (process.env.PET_EVAL) {
    setTimeout(async () => {
      try {
        const r = await win.webContents.executeJavaScript(`(async () => String(await (${process.env.PET_EVAL})))()`);
        console.log('[eval]', r);
      } catch (e) { console.log('[eval err]', e.message); }
      app.isQuitting = true; app.quit();
    }, Number(process.env.PET_EVAL_DELAY || 5000));
  }

  // 调试：PET_TYPING=1 直接打开键盘钩子，并在 12 秒后报告收到多少次按键
  if (process.env.PET_TYPING) {
    setTimeout(() => {
      const ok = typingSet(true);
      console.log('[typing] enabled =', ok, 'hookOk =', hookOk);
    }, 2500);
    // 每 5 秒报一次累计按键数，方便确认「真人打字时到底收不收得到」
    let ticks = 0;
    const probe = setInterval(() => {
      ticks++;
      console.log('[typing] keyCount =', keyCount, 'on =', typingOn);
      if (ticks >= 24) { clearInterval(probe); app.isQuitting = true; app.quit(); }
    }, 5000);
  }

  // 调试：PET_EDGE=left|right 把她怼到那条边并触发探头，用来验收吸附效果
  if (process.env.PET_EDGE) {
    setTimeout(() => {
      try {
        const b = win.getBounds();
        const area = screen.getDisplayMatching(b).workArea;
        const x = process.env.PET_EDGE === 'left' ? area.x : area.x + area.width - WIN_W;
        win.setBounds({ x, y: b.y, width: WIN_W, height: WIN_H });
        sendWin('near-edge', process.env.PET_EDGE);
        sendWin('snap-caught', process.env.PET_EDGE);
        setTimeout(() => sendWin('peek', process.env.PET_EDGE), 700);
        if (process.env.PET_FREED) setTimeout(() => sendWin('snap-freed', true), 4000);
        console.log('[edge-test]', process.env.PET_EDGE, x);
      } catch (e) { console.log('[edge-test fail]', e.message); }
    }, 5000);
  }

  // 调试：PET_TYPE_DEMO=1 持续发「正在打字」，方便截图看手部动作
  if (process.env.PET_TYPE_DEMO) {
    setTimeout(() => {
      const t = setInterval(() => sendWin('typing', { stop: false }), 120);
      setTimeout(() => { clearInterval(t); sendWin('typing', { stop: true }); }, 9000);
    }, 4000);
  }

  // 调试：PET_CLICK=1 模拟连续点击，验证单点/双击/连击识别
  if (process.env.PET_CLICK) {
    setTimeout(async () => {
      try {
        const r = await win.webContents.executeJavaScript(`(async () => {
          const c = document.getElementById('stage');
          const x = innerWidth / 2, y = innerHeight * 0.55;
          for (let i = 0; i < 6; i++) {
            for (const type of ['pointerdown', 'pointerup']) {
              c.dispatchEvent(new PointerEvent(type, {
                clientX: x, clientY: y, button: 0, bubbles: true, pointerId: 1
              }));
            }
            await new Promise(r => setTimeout(r, 160));
          }
          return JSON.stringify(window.__pet.clickState());
        })()`);
        console.log('[click]', r);
      } catch (e) { console.error('[click fail]', e.message); }
    }, 6000);
  }
  if (process.env.PET_ACT) {
    setTimeout(() => {
      try {
        win.webContents.executeJavaScript(`window.__pet.setAct(${JSON.stringify(process.env.PET_ACT)}, 40); 'ok'`)
          .catch(() => {});
      } catch (e) { console.error('[act fail]', e.message); }
    }, 6000);
    // 截图前一秒再放粒子，不然等截图时已经飘没了
    const delay = Number(process.env.PET_SHOT_DELAY || 9000) - 450;
    setTimeout(() => {
      try { win.webContents.executeJavaScript(`window.__pet.pop(12); 'popped'`).then(r => console.log('[pop]', r)).catch(e => console.error('[pop fail]', e.message)); }
      catch {}
    }, Math.max(1000, delay));
  }
  // 调试：把角色转开，几秒后看 debug 里的 yaw 是否自己回到 0
  if (process.env.PET_FACE) {
    setTimeout(() => {
      win.webContents.executeJavaScript(`window.__pet.setYaw(1.2); 'set'`).catch(() => {});
      console.log('[face] set yaw = 1.2');
    }, 5000);
  }
  // 调试：模拟右键「看看我在干嘛」，结果会写进 __pet.lastLook
  if (process.env.PET_LOOK) {
    setTimeout(() => {
      if (win && !win.isDestroyed()) win.webContents.send('pet-look');
      console.log('[look] sent');
    }, 6000);
  }
  // 调试：模拟一次提醒，看气泡是不是半透明、像在说话
  if (process.env.PET_SAY) {
    setTimeout(() => { petSay(process.env.PET_SAY); console.log('[say] sent'); }, 7500);
  }
  if (process.env.PET_TTS_PLAY) {
    setTimeout(async () => {
      try {
        const r = await win.webContents.executeJavaScript(`
          (async () => {
            const url = await window.pet.tts('测试播放，一二三四五');
            const a = new Audio(url);
            try {
              await a.play();
              await new Promise(r => setTimeout(r, 800));
              return 'PLAYING dur=' + a.duration + ' paused=' + a.paused + ' err=' + (a.error ? a.error.code : 'none');
            } catch (e) {
              return 'PLAY_REJECTED ' + e.name + ' ' + e.message;
            }
          })()
        `);
        console.log('[tts-play]', r);
      } catch (e) { console.error('[tts-play fail]', e.message); }
    }, 7000);
  }
  if (process.env.PET_TTS) {
    setTimeout(async () => {
      try {
        const r = await win.webContents.executeJavaScript(
          `window.pet.tts('测试一下新声音，我是蛋糕纯').then(u => 'dataurl_len=' + u.length).catch(e => 'ERR ' + e.message)`
        );
        console.log('[tts-test]', r);
      } catch (e) { console.error('[tts-test fail]', e.message); }
    }, 7000);
  }
  if (process.env.PET_SNIP) {
    setTimeout(async () => {
      try {
        await chatWin.webContents.executeJavaScript(`document.getElementById('snipBtn').click(); 'ok'`);
        console.log('[snip] clicked, windows =', BrowserWindow.getAllWindows().length);
      } catch (e) { console.error('[snip fail]', e.message); }
    }, 6000);
  }
  if (process.env.PET_TEST) {
    setTimeout(async () => {
      try {
        const r = await chatWin.webContents.executeJavaScript(`
          (async () => {
            document.getElementById('inp').value = '你好，一句话介绍你自己';
            document.getElementById('send').click();
            await new Promise(r => setTimeout(r, 14000));
            return document.getElementById('log').innerText;
          })()
        `);
        console.log('[chat-e2e]', String(r).replace(/\\s+/g, ' ').slice(0, 300));
      } catch (e) { console.error('[chat-e2e fail]', e.message); }
    }, 7000);
  }
  // 后台休眠自检：PET_PERF=1 自动跑一遍「可见 → 隐藏 → 唤醒」，把帧计数写进文件。
  // 纯调试开关，正常启动完全不会执行。
  if (process.env.PET_PERF) {
    const out = path.join(app.getPath('userData'), '_perf_result.txt');
    const log = (s) => { try { fs.appendFileSync(out, s + '\n'); } catch {} };
    try { fs.writeFileSync(out, ''); } catch {}
    const snap = async (tag) => {
      const r = await win.webContents.executeJavaScript(
        'JSON.stringify({f: window.__pet ? window.__pet.frames : -1, h: document.hidden, p: window.__pet ? window.__pet.paused() : null})'
      );
      const o = JSON.parse(r);
      log(tag + '  visible=' + win.isVisible() + '  document.hidden=' + o.h +
          '  paused=' + o.p + '  frames=' + o.f);
      return o.f;
    };
    setTimeout(async () => {
      try {
        await snap('t+2s  启动后');
        await new Promise((r) => setTimeout(r, 3000));
        await snap('t+5s  桌面静置（不该自己藏）');
        hidePet();
        await new Promise((r) => setTimeout(r, 3000));
        const b = await snap('t+8s  已隐藏 3 秒');
        await new Promise((r) => setTimeout(r, 3000));
        const c = await snap('t+11s 已隐藏 6 秒');
        showPet();
        await new Promise((r) => setTimeout(r, 2000));
        const d = await snap('t+13s 重新召唤');
        log('结论：隐藏期间新增帧 = ' + (c - b) + '（应为 0）；唤醒后新增帧 = ' + (d - c) + '（应 > 0）');
      } catch (e) { log('ERR ' + e.message); }
    }, 2000);
  }
  // 调试：PET_SHOT_WIN=路径 只截宠物窗口自己（含 WebGL，不含 DOM 特效，用来检查 3D 姿态）
  if (process.env.PET_SHOT_WIN) {
    setTimeout(async () => {
      try {
        if (process.env.PET_HIDE_FX) {
          await win.webContents.executeJavaScript(`document.getElementById('fx').style.display='none'; document.getElementById('bubble').style.display='none'; 'ok'`);
        }
        const img = await win.webContents.capturePage();
        fs.writeFileSync(process.env.PET_SHOT_WIN, img.toPNG());
        console.log('win shot saved');
      } catch (e) { console.log('win shot fail', e.message); }
    }, Number(process.env.PET_SHOT_DELAY || 4500));
  }

  if (process.env.PET_SHOT) {
    setTimeout(async () => {
      try {
        const dbg = await win.webContents.executeJavaScript(
          `JSON.stringify({state: window.__pet, probe: window.__pet.probe ? window.__pet.probe() : null, fx: document.getElementById('fx').children.length, yaw: window.__pet.yaw()})`
        );
        console.log('[debug]', dbg);
        const px = await win.webContents.executeJavaScript(`(() => {
          const c = document.getElementById('stage');
          const g = c.getContext('webgl2') || c.getContext('webgl');
          const w = c.width, h = c.height;
          const buf = new Uint8Array(w * h * 4);
          g.readPixels(0, 0, w, h, g.RGBA, g.UNSIGNED_BYTE, buf);
          let nz = 0;
          for (let i = 3; i < buf.length; i += 4) if (buf[i] > 8) nz++;
          return JSON.stringify({w, h, opaquePixels: nz, ratio: +(nz / (w * h)).toFixed(3)});
        })()`);
        console.log('[pixels]', px);
      } catch (e) { console.error('[debug fail]', e.message); }
    }, Number(process.env.PET_SHOT_DELAY || 4500));
    setTimeout(async () => {
      try {
        const { desktopCapturer } = require('electron');
        const { size } = screen.getPrimaryDisplay();
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: size.width, height: size.height }
        });
        fs.writeFileSync(process.env.PET_SHOT, sources[0].thumbnail.toPNG());
        console.log('shot saved:', process.env.PET_SHOT);
      } catch (err) {
        console.error('shot failed:', err);
      }
      // 页内截图作为兜底
      try {
        const img = await win.capturePage();
        fs.writeFileSync(process.env.PET_SHOT.replace('.png', '-page.png'), img.toPNG());
      } catch {}
      app.isQuitting = true;
      app.quit();
    }, Number(process.env.PET_SHOT_DELAY || 4500));
  }

  app.on('activate', () => { if (!win) createWindow(); });
  startCare();          // 小蛋的陪伴 / 护眼 / 喝水 / 久坐提醒

  // 陪伴时长：只在她露脸（可见）的时候累加，藏起来不算陪
  const companionTick = setInterval(() => {
    if (win && !win.isDestroyed() && win.isVisible()) bumpCompanion(1);
  }, 60000);
  if (companionTick.unref) companionTick.unref();
});

app.on('window-all-closed', () => {
  // 托盘常驻，不随窗口关闭退出
});

app.on('will-quit', () => {
  try { globalShortcut.unregisterAll(); } catch {}
  // 退出时把键盘钩子放掉，别在系统里留一个悬挂的输入钩子
  try { hook && hook.stop(); } catch {}
  stopFling();
  stopGlide();
});

// ---- IPC ----

// 悬停命中判定：切换鼠标穿透
ipcMain.on('hover-state', (_e, hovering) => {
  petHovered = !!hovering;
  if (petHovered) cancelAutoHide();   // 鼠标还在她身上就别藏
  if (!win) return;
  win.setIgnoreMouseEvents(!hovering, { forward: true });
});

// 拖动：渲染层按下后，主进程跟踪光标
let lastDragPoint = null;
let dragTrail = [];        // 最近的拖动采样，用来算松手速度
let dragNearEdge = null;    // 拖动时最近的那条边，用来提前提示
let flingTimer = null;

ipcMain.on('drag-start', () => {
  if (!win) return;
  sendWin('peek', null);
  sendWin('snap-freed', true);
  stopFling();
  stopGlide();
  const cursor = screen.getCursorScreenPoint();
  const b = win.getBounds();
  dragOrigin = { dx: cursor.x - b.x, dy: cursor.y - b.y };
  lastDragPoint = null;
  dragTrail = [];
});

ipcMain.on('drag-move', () => {
  if (!win || !dragOrigin) return;
  const cursor = screen.getCursorScreenPoint();
  // 光标没动就别反复 setBounds，长按右键时才不会一直重绘
  if (lastDragPoint && cursor.x === lastDragPoint.x && cursor.y === lastDragPoint.y) return;
  lastDragPoint = { x: cursor.x, y: cursor.y };
  dragTrail.push({ x: cursor.x, y: cursor.y, t: Date.now() });
  if (dragTrail.length > 8) dragTrail.shift();
  let nx = cursor.x - dragOrigin.dx;
  let ny = cursor.y - dragOrigin.dy;

  // 拖动中就给磁力：离边缘 48px 内直接被吸过去，松手前你就能感觉到
  const area = screen.getDisplayMatching({ x: Math.round(nx), y: Math.round(ny), width: WIN_W, height: WIN_H }).workArea;
  const MAG = 48;
  const dl = nx - area.x;
  const dr = area.x + area.width - (nx + WIN_W);
  const dt2 = ny - area.y;
  const db = area.y + area.height - (ny + WIN_H);
  let near = null;
  if (dl >= 0 && dl < MAG) { nx = area.x; near = 'left'; }
  else if (dr >= 0 && dr < MAG) { nx = area.x + area.width - WIN_W; near = 'right'; }
  if (dt2 >= 0 && dt2 < MAG) { ny = area.y; near = near || 'top'; }
  else if (db >= 0 && db < MAG) { ny = area.y + area.height - WIN_H; near = near || 'bottom'; }
  if (near !== dragNearEdge) {
    dragNearEdge = near;
    sendWin('near-edge', near);       // 让渲染层提前亮一下"要贴边了"
  }

  // 带尺寸一起写，保证拖动过程中窗口永远不会被拉大
  win.setBounds({
    x: Math.round(nx),
    y: Math.round(ny),
    width: WIN_W,
    height: WIN_H
  });
});

let glideTimer = null;

// 平滑滑到目标位置：直接 setBounds 会「瞬移」，看不出是吸过去的
function glideTo(tx, ty, ms = 200) {
  stopFling();
  if (glideTimer) { clearInterval(glideTimer); glideTimer = null; }
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  const sx = b.x, sy = b.y, t0 = Date.now();
  glideTimer = setInterval(() => {
    if (!win || win.isDestroyed()) { clearInterval(glideTimer); glideTimer = null; return; }
    const k = Math.min(1, (Date.now() - t0) / ms);
    const e = k * k * (3 - 2 * k);                 // smoothstep，起停都软
    win.setBounds({
      x: Math.round(sx + (tx - sx) * e),
      y: Math.round(sy + (ty - sy) * e),
      width: WIN_W, height: WIN_H
    });
    if (k >= 1) {
      clearInterval(glideTimer);
      glideTimer = null;
      writeSettings({ x: tx, y: ty });
    }
  }, 16);
}

// 松手吸边：四条边都吸，70px 内就贴过去（之前只有左右、只有 28px，太难点中）
function snapToEdge() {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  const area = screen.getDisplayMatching(b).workArea;
  const SNAP = 70;
  const dl = b.x - area.x;
  const dr = area.x + area.width - (b.x + b.width);
  const dt2 = b.y - area.y;
  const db = area.y + area.height - (b.y + b.height);
  const min = Math.min(dl, dr, dt2, db);
  let tx = b.x, ty = b.y;
  if (min <= SNAP) {
    if (min === dl) tx = area.x;
    else if (min === dr) tx = area.x + area.width - b.width;
    else if (min === dt2) ty = area.y;
    else ty = area.y + area.height - b.height;
  }
  let edge = null;
  if (tx !== b.x) edge = tx === area.x ? 'left' : 'right';
  if (process.env.PET_DEBUG) console.log('[snap]', JSON.stringify({ edge, from: [b.x, b.y], to: [tx, ty] }));
  if (tx === b.x && ty === b.y) { writeSettings({ x: b.x, y: b.y }); return; }
  glideTo(tx, ty);
  // 先演「被吸住 / 挣扎」，再探头
  sendWin('snap-caught', edge);
  setTimeout(() => sendWin('peek', edge), 700);
}

function stopFling() {
  if (flingTimer) { clearInterval(flingTimer); flingTimer = null; }
}

// 吸边滑行也要能被打断，否则它和甩出滑行会同时 setBounds，窗口抖成筛子
function stopGlide() {
  if (glideTimer) { clearInterval(glideTimer); glideTimer = null; }
}

// 甩出去：每帧位移衰减，撞到工作区边缘反弹，慢下来就停并记住位置
function startFling(sx, sy) {
  stopFling();
  stopGlide();
  let vx = Math.max(-60, Math.min(60, sx));
  let vy = Math.max(-60, Math.min(60, sy));
  flingTimer = setInterval(() => {
    if (!win || win.isDestroyed() || !win.isVisible()) { stopFling(); return; }
    const b = win.getBounds();
    const area = screen.getDisplayMatching(b).workArea;
    let x = b.x + vx;
    let y = b.y + vy;
    const minX = area.x, maxX = area.x + area.width - WIN_W;
    const minY = area.y, maxY = area.y + area.height - WIN_H;
    if (x < minX) { x = minX; vx = -vx * 0.55; }
    if (x > maxX) { x = maxX; vx = -vx * 0.55; }
    if (y < minY) { y = minY; vy = -vy * 0.55; }
    if (y > maxY) { y = maxY; vy = -vy * 0.55; }
    win.setBounds({ x: Math.round(x), y: Math.round(y), width: WIN_W, height: WIN_H });
    vx *= 0.9; vy *= 0.9;
    if (Math.hypot(vx, vy) < 0.6) {
      stopFling();
      snapToEdge();
    }
  }, 16);
}

ipcMain.on('drag-end', () => {
  if (!win || !dragOrigin) return;
  dragOrigin = null;

  // 松手速度（px/ms）：取最近 120ms 的两个采样点
  let vx = 0, vy = 0;
  if (dragTrail.length >= 2) {
    const now = Date.now();
    const recent = dragTrail.filter((p) => now - p.t < 140);
    if (recent.length >= 2) {
      const a0 = recent[0], a1 = recent[recent.length - 1];
      const dt = Math.max(16, a1.t - a0.t);
      vx = (a1.x - a0.x) / dt;
      vy = (a1.y - a0.y) / dt;
    }
  }
  dragTrail = [];

  dragNearEdge = null;
  sendWin('near-edge', null);

  // 甩得够快就滑一段，慢慢蹭过去的那点速度不算
  if (Math.hypot(vx, vy) > 0.7) {
    startFling(vx * 16, vy * 16);      // 换算成每帧位移
    return;
  }

  snapToEdge();
});

ipcMain.handle('get-settings', () => readSettings());
ipcMain.on('save-settings', (_e, patch) => {
  writeSettings(patch);
  // 只写盘不广播的话，改角色/画质要重启才生效（之前就是这么个坑）
  const s = readSettings();
  sendWin('apply-settings', {
    quality: s.quality || 'balanced',
    scale: s.scale || 1,
    model: s.model || 'cake'
  });
});

/* ---------- 聊天窗口 ---------- */
let chatWin = null;

function openChat() {
  if (chatWin) {
    chatWin.show();
    chatWin.focus();
    return;
  }
  const b = win ? win.getBounds() : { x: 1200, y: 600 };
  const { workArea } = screen.getPrimaryDisplay();
  const W = 360, H = 500;
  // 直接贴右下角
  const chatX = workArea.x + workArea.width - W - 16;
  const chatY = workArea.y + workArea.height - H - 16;

  // 聊天时把她收起来，免得两块重叠挡住了别人的窗口
  const petWasVisible = !!(win && win.isVisible());
  if (petWasVisible) hidePet();

  chatWin = new BrowserWindow({
    width: W,
    height: H,
    x: chatX,
    y: chatY,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    skipTaskbar: false,
    alwaysOnTop: true,
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  chatWin.setMenu(null);
  chatWin.loadFile(path.join(__dirname, 'renderer', 'chat.html'));
  // 一打开聊天窗就在后台把语音模型热起来（约 1.3s，78MB），
  // 否则第一次按「按住说话」要干等模型加载，前面几个字会被吞掉。
  setTimeout(() => { try { getAsr(); } catch (e) { console.log('[asr warmup]', e.message); } }, 1200);
  chatWin.on('closed', () => {
    chatWin = null;
    // 关掉聊天后把她放回来
    if (petWasVisible && win && !win.isDestroyed()) showPet();
  });
}

ipcMain.on('open-chat', openChat);
ipcMain.on('close-chat', () => { if (chatWin) chatWin.close(); });

// 用户碰过她，就不再自动隐身
ipcMain.on('user-touch', () => {
  userTouched = true;
  cancelAutoHide();
});
ipcMain.on('dismiss', dismiss);

// 歌单为空时用托盘气泡提醒一次
let musicHinted = false;
ipcMain.on('no-music', () => {
  if (musicHinted || !tray) return;
  musicHinted = true;
  try {
    tray.displayBalloon({
      title: '还没有歌',
      content: '把 mp3 放进 pet\\assets\\music 文件夹，点她就会播。'
    });
  } catch {}
});

// 歌放这里。打包成 exe 后项目目录只读，所以放用户数据区
const musicDir = () => path.join(app.getPath('userData'), 'music');
function ensureMusicDir() {
  try { fs.mkdirSync(musicDir(), { recursive: true }); } catch {}
}

// 列出音乐目录里的音频，点宠物时循环播放
ipcMain.handle('list-music', () => {
  ensureMusicDir();
  try {
    const { pathToFileURL } = require('url');
    return fs.readdirSync(musicDir())
      .filter((f) => /\.(mp3|m4a|wav|ogg|flac)$/i.test(f))
      .sort()
      .map((f) => pathToFileURL(path.join(musicDir(), f)).href);
  } catch {
    return [];
  }
});

ipcMain.on('open-music-folder', () => {
  ensureMusicDir();
  shell.openPath(musicDir());
});

// 语音合成：走 Edge 的神经语音，比系统 SAPI 自然得多
let edgeTTS = null;
function getEdgeTTS() {
  if (!edgeTTS) {
    const m = require('msedge-tts');
    edgeTTS = m;
  }
  return edgeTTS;
}

/* ---------------- 本地离线朗读（可选） ----------------
   和 ASR 一样用 sherpa-onnx，模型放 models/tts 就跑，没放就自动退回 Edge。
   好处是完全不联网；代价是模型约 120MB、声音不如 Edge 自然。
   用「wav」返回：这里是 WAV 字节直接转 base64，前端一个 Audio 就能播。 */
// 模型不进安装包（116MB，便携版自解压会更慢），两个位置任选其一：
//   程序目录/models/tts  或  %APPDATA%/EggIslandPet/models/tts
const TTS_DIRS = [
  path.join(__dirname, 'models', 'tts'),
  path.join(app.getPath('appData'), 'EggIslandPet', 'models', 'tts')
];
const TTS_DIR = TTS_DIRS.find((d) => fs.existsSync(path.join(d, 'model.onnx'))) || TTS_DIRS[0];
let ttsEngine = null;
let ttsBroken = false;

function localTtsReady() {
  try {
    return fs.existsSync(path.join(TTS_DIR, 'model.onnx'))
      && fs.existsSync(path.join(TTS_DIR, 'tokens.txt'))
      && fs.existsSync(path.join(TTS_DIR, 'lexicon.txt'));
  } catch { return false; }
}

function getLocalTts() {
  if (ttsEngine) return ttsEngine;
  if (ttsBroken) return null;
  if (!localTtsReady()) return null;
  try {
    const { OfflineTts } = require('sherpa-onnx-node');
    const f = (n) => path.join(TTS_DIR, n);
    ttsEngine = new OfflineTts({
      model: {
        vits: {
          model: f('model.onnx'),
          lexicon: f('lexicon.txt'),
          tokens: f('tokens.txt'),
          dictDir: f('dict')
        },
        numThreads: 2,
        debug: false,
        provider: 'cpu'
      },
      ruleFsts: [f('date.fst'), f('number.fst'), f('phone.fst')].join(','),
      maxNumSentences: 1
    });
    return ttsEngine;
  } catch (e) {
    console.log('[tts-local] init failed:', e.message);
    ttsBroken = true;
    return null;
  }
}

// Float32 单声道 → WAV 字节（16bit），浏览器直接能播
function floatToWav(samples, sampleRate) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE((v * 32767) | 0, 44 + i * 2);
  }
  return buf;
}

ipcMain.handle('tts', async (_e, text) => {
  const s = readSettings();
  // 设置里可以强制走 Edge；默认本地优先
  if (s.ttsLocal !== false) {
    const engine = getLocalTts();
    if (engine) {
      try {
        /* Electron 的 Node 不允许 addon 返回「外部 ArrayBuffer」，
           generate() 会直接抛 External buffers are not allowed。
           但 generateAsync 的 onProgress 是分块回调，每块可以正常拷出来，
           所以这里用回调攒样本，最后那句 settlement failed 无视即可。 */
        const chunks = [];
        let rate = 16000;
        try {
          await engine.generateAsync({
            text: String(text).slice(0, 200),
            sid: 0,
            speed: 1.0,
            onProgress: (info) => {
              try {
                if (info && info.samples && info.samples.length) {
                  chunks.push(new Float32Array(info.samples));
                }
              } catch {}
              return 1;
            }
          });
        } catch { /* settlement failed：音频已经拿到了，忽略 */ }

        let total = 0;
        for (const c of chunks) total += c.length;
        if (total > 0) {
          const all = new Float32Array(total);
          let off = 0;
          for (const c of chunks) { all.set(c, off); off += c.length; }
          const wav = floatToWav(all, rate);
          return 'data:audio/wav;base64,' + wav.toString('base64');
        }
      } catch (e) {
        console.log('[tts-local] synth failed:', e.message);
      }
    }
  }

  const { MsEdgeTTS, OUTPUT_FORMAT } = getEdgeTTS();
  const voiceName = s.ttsVoice || 'zh-CN-XiaoxiaoNeural';
  const rate = Number.isFinite(s.ttsRate) ? s.ttsRate : 8;

  const tts = new MsEdgeTTS();
  try {
    await tts.setMetadata(voiceName, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(text, { rate: rate });
    const chunks = [];
    for await (const c of audioStream) chunks.push(Buffer.from(c));
    const buf = Buffer.concat(chunks);
    if (!buf.length) throw new Error('合成结果为空');
    return 'data:audio/mpeg;base64,' + buf.toString('base64');
  } finally {
    try { tts.close(); } catch {}
  }
});

// 圈选：全屏截图传给选择器，用户在那边画套索、自己裁好再回传
let snipWin = null;
let snipResolve = null;

ipcMain.handle('snip-screen', async () => {
  const disp = screen.getPrimaryDisplay();
  const dpr = disp.scaleFactor || 1;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(disp.bounds.width * dpr),
      height: Math.round(disp.bounds.height * dpr)
    }
  });
  if (!sources.length) throw new Error('拿不到屏幕');
  const shot = sources[0].thumbnail.toDataURL();

  if (snipWin) { try { snipWin.close(); } catch {} snipWin = null; }

  snipWin = new BrowserWindow({
    x: disp.bounds.x,
    y: disp.bounds.y,
    width: disp.bounds.width,
    height: disp.bounds.height,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  snipWin.setAlwaysOnTop(true, 'screen-saver');
  snipWin.setIgnoreMouseEvents(false);

  snipWin.webContents.once('did-finish-load', () => {
    if (snipWin && !snipWin.isDestroyed()) snipWin.webContents.send('snip-image', shot);
  });
  snipWin.loadFile(path.join(__dirname, 'renderer', 'snip.html'));
  snipWin.on('closed', () => {
    snipWin = null;
    if (snipResolve) { snipResolve(null); snipResolve = null; }
  });

  return new Promise((resolve) => { snipResolve = resolve; });
});

ipcMain.on('snip-done', (_e, dataUrl) => {
  if (snipWin) { try { snipWin.close(); } catch {} snipWin = null; }
  if (snipResolve) { snipResolve(dataUrl || null); snipResolve = null; }
});

// 截当前屏幕，返回 base64，供视觉模型看
ipcMain.handle('capture-screen', async () => {  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 1280, height: 800 }
  });
  if (!sources.length) throw new Error('拿不到屏幕');
  return sources[0].thumbnail.toDataURL();
});

// 主进程转发请求，绕开渲染层 CORS
ipcMain.handle('chat', async (_e, messages) => {
  const s = readSettings();
  const base = (s.apiUrl || 'http://localhost:11434/v1').replace(/\/+$/, '');
  const key = s.apiKey || 'ollama';

  // 带图的消息要用视觉模型
  const hasImage = messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'));
  const model = hasImage && s.apiVision ? s.apiVision : (s.apiModel || 'qwen2.5:7b');

  const res = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      max_tokens: 1024,
      temperature: 0.8,
      reasoning_effort: 'low'
    }),
    signal: AbortSignal.timeout(60000)
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error('HTTP ' + res.status + ' ' + (t.slice(0, 120) || res.statusText));
  }
  const j = await res.json();
  const msg = j && j.choices && j.choices[0] && j.choices[0].message;
  const out = (msg && msg.content) || '';
  if (!out.trim()) throw new Error('接口没返回内容（可能 token 用完了）');
  return out.trim();
});

/* ---------------- 离线语音输入：微信式「按住说话」 ----------------
   引擎用 sherpa-onnx 的 Paraformer 中文模型，全程在本机跑，不连 Google、不上传音频。
   微信输入法的识别服务是私有的、没有公开接口可内嵌；这里用「本地识别 + 大模型纠错 + 本地意图兜底」
   把「听得清 / 听得懂」补回来。

   为什么从流式 zipformer 换到 Paraformer：同一批语料实测（Edge TTS 合成、真人相近的语速），
   流式 int8 模型平均字错率 25.6%，而且会在长音上打转（「放首歌听听吧」→「放手歌听听听听听吧」）；
   Paraformer 平均 0.0%、5 秒音频只要 50ms，模型还从 174MB 降到 78MB。
   代价是非流式、没有原生边说边出字 —— 用「积一段、重解一次」做增量预览补上。 */
const ASR_DIR = path.join(__dirname, 'models', 'asr-para');
let asrRecognizer = null;
let asrBufs = [];            // 本次按住说话累积的音频块（Float32Array）
let asrSamples = 0;          // 已累积的采样点数
let asrPreviewAt = 0;        // 上次增量预览的时间
let asrLastText = '';
let asrSender = null;
let asrBusy = false;

function getAsr() {
  if (asrRecognizer) return asrRecognizer;
  const { OfflineRecognizer } = require('sherpa-onnx-node');
  asrRecognizer = new OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      paraformer: { model: path.join(ASR_DIR, 'model.int8.onnx') },
      tokens: path.join(ASR_DIR, 'tokens.txt'),
      numThreads: 2,
      provider: 'cpu',
      debug: false
    },
    decodingMethod: 'greedy_search'
  });
  return asrRecognizer;
}

function asrConcat() {
  const out = new Float32Array(asrSamples);
  let off = 0;
  for (const b of asrBufs) { out.set(b, off); off += b.length; }
  return out;
}

// 非流式：整段一次解码。5 秒音频约 50ms，所以「重解一遍」比维护流式状态更划算。
function asrDecodeAll() {
  if (!asrSamples) return '';
  const rec = getAsr();
  const st = rec.createStream();
  st.acceptWaveform({ samples: asrConcat(), sampleRate: 16000 });
  rec.decode(st);
  try { return (rec.getResult(st).text || '').trim(); } catch { return ''; }
}

function asrEmit(channel, data) {
  const wc = asrSender && !asrSender.isDestroyed()
    ? asrSender
    : (chatWin && !chatWin.isDestroyed() ? chatWin.webContents : null);
  if (wc) wc.send(channel, data);
}

function asrDecode() {
  return asrDecodeAll();
}

// 本地意图识别：断网 / API 超时也必须能听懂指令。
// 规则写得宽松一点，好容纳识别出来的同音错字（「追专住」≈「专注」）。
function localIntent(raw) {
  const t = String(raw || '').replace(/[\s，。！？、,.:;]/g, '');
  const rules = [
    [/看看屏幕|看看我在干嘛|看一眼屏幕|瞄一眼|屏幕上是什么|看.{0,3}屏幕/, 'look'],
    [/开始专注|开启专注|番茄钟|开始.{0,4}(专|番|计时)|专注.{0,3}分钟/, 'pomodoro'],
    [/剪贴板|复制的内容|复制了什么|我复制|复制的东西/, 'clip'],
    [/放歌|放音乐|听歌|下一首|换首歌/, 'music'],
    [/隐藏|收起|躲起来|先退下/, 'hide'],
    [/换个节目|换个动作|换一套|换节目/, 'act'],
    [/翻译|译成|用英文说|英文怎么说/, 'translate']
  ];
  for (const [re, action] of rules) if (re.test(t)) return action;
  return null;
}

// 语音识别难免同音错字（「屏墓」「番切钟」）：让大模型把字改漂亮，
// 但意图判断以本地规则为底线，AI 挂了也不影响「听懂你在下指令」。
async function polishAsr(raw) {
  const local = localIntent(raw);
  const fallback = {
    text: raw,
    intent: local ? 'command' : 'chat',
    action: local || 'none'
  };
  const s = readSettings();
  if (!s.apiKey || !s.apiUrl) return fallback;
  const sys = [
    '你是中文语音输入的后处理器。用户说的话由离线语音识别转写，可能有同音错字、漏字、没有标点。',
    '只输出严格 JSON，不要 markdown、不要解释：',
    '{"text":"纠正错字并补好标点的规范中文","intent":"chat|command","action":"look|pomodoro|clip|music|hide|act|translate|none"}',
    '判断规则：让助手做事 → intent=command。看屏幕/看看我在干嘛=look；开始专注/番茄钟=pomodoro；',
    '读剪贴板/复制的内容=clip；放歌/放音乐=music；隐藏/收起=hide；换个节目/换个动作=act；翻译=translate；',
    '其他指令 action=none。只是聊天、提问、问候、吐槽 → intent=chat, action=none。',
    '纠错时只改明显的同音错字和标点，不要改写原意、不要扩写、不要加内容。'
  ].join('\n');
  try {
    const base = (s.apiUrl || '').replace(/\/+$/, '');
    const res = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + s.apiKey },
      body: JSON.stringify({
        model: s.apiModel || 'deepseek-flash',
        messages: [{ role: 'system', content: sys }, { role: 'user', content: raw }],
        stream: false, max_tokens: 512, temperature: 0.1, reasoning_effort: 'low'
      }),
      signal: AbortSignal.timeout(9000)
    });
    if (!res.ok) {
      if (process.env.PET_ASR_TEST) console.log('[polish http]', res.status, (await res.text().catch(() => '')).slice(0, 160));
      return fallback;
    }
    const j = await res.json();
    const msg = (((j.choices || [])[0] || {}).message) || {};
    // deepseek-flash 是推理模型：token 给少了 content 会是空的，内容落在 reasoning_content
    const out = msg.content || msg.reasoning_content || '';
    if (process.env.PET_ASR_TEST) console.log('[polish raw]', String(out).slice(0, 240));
    const m = String(out).match(/\{[\s\S]*\}/);
    if (!m) return fallback;
    const d = JSON.parse(m[0]);
    const action = (d.action && d.action !== 'none') ? String(d.action) : (local || 'none');
    return {
      text: String(d.text || raw).trim(),
      intent: action !== 'none' ? 'command' : 'chat',
      action
    };
  } catch (e) {
    if (process.env.PET_ASR_TEST) console.log('[polish err]', (e && e.message) || e);
    return fallback;
  }
}

ipcMain.handle('asr-start', (e) => {
  try {
    getAsr();                        // 先把模型载进内存（约 1.4s，只在第一次）
    asrBufs = [];
    asrSamples = 0;
    asrPreviewAt = 0;
    asrLastText = '';
    asrSender = e.sender;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// 增量预览：每 0.9 秒把已收到的音频整段重解一次，做出「边说边出字」的效果。
// 只在音频不到 12 秒时预览，避免长时间按住时反复解码拖慢主进程。
const ASR_PREVIEW_GAP = 900;
const ASR_PREVIEW_MAX = 16000 * 12;

ipcMain.on('asr-chunk', (_e, buf) => {
  try {
    const incoming = buf instanceof Float32Array ? buf : new Float32Array(buf);
    if (!incoming.length) return;
    // 复制一层：Electron 传过来的是 external buffer，addon 只收普通 JS Float32Array
    const samples = new Float32Array(incoming.length);
    samples.set(incoming);
    // 一直不松手时缓冲会无限涨（16k×4B ≈ 64KB/s），封顶 30 秒
    if (asrSamples < 16000 * 30) {
      asrBufs.push(samples);
      asrSamples += samples.length;
    }

    const now = Date.now();
    if (asrBusy || asrSamples < 16000 * 0.6) return;
    if (asrSamples > ASR_PREVIEW_MAX) return;
    if (now - asrPreviewAt < ASR_PREVIEW_GAP) return;
    asrPreviewAt = now;
    asrBusy = true;
    try {
      const text = asrDecodeAll();
      if (text && text !== asrLastText) {
        asrLastText = text;
        asrEmit('asr-partial', { text });
      }
    } finally {
      asrBusy = false;
    }
  } catch (err) {
    asrEmit('asr-error', { error: String((err && err.message) || err) });
  }
});

ipcMain.handle('asr-end', async () => {
  if (!asrSamples) return { text: '', intent: 'chat', action: 'none' };
  try {
    asrBusy = true;
    const text = asrDecodeAll() || asrLastText;
    asrBufs = [];
    asrSamples = 0;
    if (!text) return { text: '', intent: 'chat', action: 'none' };
    const p = await polishAsr(text);
    return { raw: text, ...p };
  } catch (err) {
    asrBufs = [];
    asrSamples = 0;
    return { text: asrLastText, intent: 'chat', action: 'none', error: String((err && err.message) || err) };
  } finally {
    asrBusy = false;
  }
});

ipcMain.on('asr-cancel', () => {
  asrBufs = [];
  asrSamples = 0;
  asrLastText = '';
  asrBusy = false;
});

ipcMain.on('voice-command', (_e, action, raw) => {
  switch (action) {
    case 'look': if (win) win.webContents.send('pet-look'); break;
    case 'clip': if (win) win.webContents.send('pet-clip'); break;
    case 'translate': if (win) win.webContents.send('pet-clip'); break;
    case 'pomodoro': startPomodoro(); break;
    case 'music': if (win) win.webContents.send('toggle-music'); break;
    case 'act': if (win) win.webContents.send('next-act'); break;
    case 'hide': dismiss(); break;
    default: break;
  }
  asrEmit('asr-command-done', { action, raw });
});

/* ---------------- 小蛋助手：陪伴 / 健康提醒 / 番茄钟 ----------------
   能力参考 GitHub 上的 DeskPet Live2D、Toty、SUDARI：都是把提醒做成
   角色的一句话，而不是冷冰冰的系统弹窗；再加番茄钟和屏幕/剪贴板感知。 */
// 性格底子：大胆、感性、爱打破常规、很在乎自己的事，偶尔搞笑
const CARE = {
  eye:   ['别盯了，抬头', '看远处，二十秒', '眼睛要废了，歇会'],
  water: ['喝水', '杯子空了', '先喝一口，再干'],
  move:  ['站起来走走', '坐太久了，动一动', '伸个懒腰，别僵着'],
  late:  ['该睡了', '明天再战', '我陪你，但别硬熬'],
  mood:  ['我在', '慢慢来，不服就再来', '你今天挺猛的', '别憋着，说出来',
          '想听歌吗', '丢脸也没事，我陪你丢']
};
const pickLine = (arr) => arr[Math.floor(Math.random() * arr.length)];

let peekTimer = null;
const pendingSays = [];

function petSay(text) {
  if (!win || win.isDestroyed()) return;
  // 关掉「露脸」时先攒着，等召唤一起说，不破坏「不常驻」的要求
  if (readSettings().peekOn === false) {
    pendingSays.push(text);
    if (pendingSays.length > 3) pendingSays.shift();
    return;
  }
  const wasHidden = !win.isVisible();
  if (wasHidden) showPet();
  // 只用角色身上的半透明气泡说话，不弹系统通知
  win.webContents.send('pet-say', { text });
  if (wasHidden) {
    clearTimeout(peekTimer);
    peekTimer = setTimeout(() => {
      peekTimer = null;
      if (win && !win.isDestroyed() && !win.isFocused() && !petHovered && !userTouched) hidePet();
    }, 5600);
  }
}

let careTick = null;
let lastEye = Date.now();
let lastWater = Date.now();
let lastMove = Date.now();
let lastMood = Date.now();
let lastLate = Date.now();
let pomoTimer = null;
let pomoBreakTimer = null;

function startCare() {
  clearInterval(careTick);
  careTick = setInterval(() => {
    const s = readSettings();
    const now = Date.now();
    const eyeMin = Number.isFinite(s.eyeMinutes) ? s.eyeMinutes : 30;
    if (eyeMin > 0 && now - lastEye >= eyeMin * 60000) {
      petSay(pickLine(CARE.eye), '小蛋 · 护眼'); lastEye = now; return;
    }
    if (now - lastWater >= 60 * 60000) {
      petSay(pickLine(CARE.water), '小蛋 · 喝水'); lastWater = now; return;
    }
    if (now - lastMove >= 90 * 60000) {
      petSay(pickLine(CARE.move), '小蛋 · 起身'); lastMove = now; return;
    }
    const h = new Date().getHours();
    if ((h >= 23 || h < 3) && now - lastLate >= 30 * 60000) {
      petSay(pickLine(CARE.late), '小蛋 · 早点睡'); lastLate = now; return;
    }
    if (s.careOn !== false && now - lastMood >= 28 * 60000) {
      petSay(pickLine(CARE.mood), '小蛋想说'); lastMood = now;
    }
  }, 30000);
}

/* ---------------- 跟着打字动（BETA，可关） ----------------
   用 uiohook-napi 的全局键盘事件，但**只看「有没有按」和「按了几下」**：
   回调里连事件对象都不接，键位、键值、输入内容一概不读取，也不写任何日志或磁盘。
   关掉开关就 uIOhook.stop()，钩子彻底撤掉。
   载入失败（缺预编译包 / 被安全软件拦）就静默降级，绝不影响桌宠本体。 */
let hook = null;
let hookOk = false;
let keyCount = 0;
let lastTypingSent = 0;
let typingOn = false;
let petalRainOn = false;

function typingAvailable() {
  if (hookOk) return true;
  try {
    const { uIOhook } = require('uiohook-napi');
    hook = uIOhook;
    hook.on('keydown', () => {
      // 这里只 +1，不读事件参数 —— 拿不到也不需要知道你按了什么
      keyCount++;
      flushTyping(false);
    });
    return (hookOk = true);
  } catch (e) {
    console.log('[typing] hook unavailable:', e.message);
    return false;
  }
}

// 节流：最多 10 秒没动静就发一次「停了」，打字时 120ms 发一次
function flushTyping(forceStop) {
  const now = Date.now();
  if (forceStop || now - lastTypingSent > 120) {
    lastTypingSent = now;
    sendWin('typing', { stop: !!forceStop });
  }
}

function typingSet(on) {
  if (on) {
    if (typingOn) return true;
    if (!typingAvailable()) { petSay('这台机器上拿不到键盘事件，用不了哦'); return false; }
    try {
      hook.start();
      typingOn = true;
      petSay('好，我跟着你打字动～只数次数，不看你按了什么');
      return true;
    } catch (e) { petSay('开不起来：' + e.message); return false; }
  }
  typingOn = false;
  try { hook && hook.stop(); } catch {}
  flushTyping(true);
  return false;
}

/* ---------------- 陪伴统计 ----------------
   同类桌宠（DeskPet / Toty）都有「今天陪了你多久」。
   只记两个数：今天累计陪伴分钟、今天完成了几次专注。按天归零。 */
function todayKey() { return new Date().toISOString().slice(0, 10); }

function bumpCompanion(minutes) {
  const s = readSettings();
  const day = todayKey();
  const cur = s.statDay === day ? s.statMin || 0 : 0;
  writeSettings({ statDay: day, statMin: cur + minutes });
}

function bumpPomodoro() {
  const s = readSettings();
  const day = todayKey();
  const cur = s.statDay === day ? s.pomoCount || 0 : 0;
  writeSettings({ statDay: day, pomoCount: cur + 1 });
}

function companionLine() {
  const s = readSettings();
  const day = todayKey();
  const min = s.statDay === day ? s.statMin || 0 : 0;
  const pomo = s.statDay === day ? s.pomoCount || 0 : 0;
  if (min < 1) return '刚来，还没算上时间呢';
  const h = Math.floor(min / 60), m = min % 60;
  const span = h ? `${h} 小时 ${m} 分` : `${m} 分钟`;
  return pomo ? `今天陪你 ${span}，一起专注了 ${pomo} 次` : `今天陪你 ${span}`;
}

function startPomodoro() {
  stopPomodoro();
  petSay('一起专注 25 分钟');
  pomoTimer = setTimeout(() => {
    pomoTimer = null;
    bumpPomodoro();
    petSay('25 分钟到啦，走走吧');
    if (win && !win.isDestroyed()) win.webContents.send('pet-celebrate', 8);
    pomoBreakTimer = setTimeout(() => {
      pomoBreakTimer = null;
      petSay('休息够了，回来吧');
    }, 5 * 60000);
  }, 25 * 60000);
}

function stopPomodoro() {
  if (pomoTimer) { clearTimeout(pomoTimer); pomoTimer = null; }
  if (pomoBreakTimer) { clearTimeout(pomoBreakTimer); pomoBreakTimer = null; }
}

ipcMain.handle('read-clipboard', () => {
  try { return clipboard.readText(); } catch { return ''; }
});

ipcMain.on('pet-notify', (_e, d) => {
  petSay(String((d && d.body) || ''));
});

/* 右键菜单 */
const MODEL_MENU = [
  { key: 'cake', label: '蛋糕纯' },
  { key: 'jade', label: '珠玉纯' }
];
const ACT_MENU = [
  { key: 'idle',  label: '站着发呆' },
  { key: 'sit',   label: '坐一会儿' },
  { key: 'swing', label: '荡秋千' },
  { key: 'spin',  label: '转个圈' },
  { key: 'hop',   label: '蹦蹦跳' },
  { key: 'walk',  label: '散步开花' },
  { key: 'bloom', label: '满地开花' },
  { key: 'wave',  label: '挥手打招呼' },
  { key: 'float', label: '飘起来' },
  { key: 'chase', label: '扑小蛋' },
  { key: 'sleep', label: '打瞌睡' }
];

// 菜单项点击时窗口可能已经关了，直接 send 会抛 "Render frame was disposed"
const sendWin = (ch, ...args) => {
  if (win && !win.isDestroyed()) win.webContents.send(ch, ...args);
};

// 按住说话期间把音乐掐掉：外放的歌会被麦克风原样录进去，识别成「放歌」指令
ipcMain.on('voice-duck', (_e, on) => sendWin('voice-duck', !!on));


/* 用户离开 / 回来：powerMonitor.getSystemIdleTime() 是系统级闲置秒数，
   不需要任何键盘钩子，也拿不到任何输入内容。闲置 3 分钟她就趴下打瞌睡，
   你一动鼠标/键盘她就醒。 */
let userAway = false;
setInterval(() => {
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  try {
    const idleSec = require('electron').powerMonitor.getSystemIdleTime();
    if (!userAway && idleSec > 180) {
      userAway = true;
      sendWin('user-idle', true);
    } else if (userAway && idleSec < 3) {
      userAway = false;
      sendWin('user-idle', false);
    }
  } catch {}
}, 15000);

// 视线跟随：把她窗口里的相对鼠标位置发过去，渲染层让头微微转过来。
// 120ms 一次足够了 —— 每帧发就是白白吵醒渲染层。
setInterval(() => {
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  try {
    const p = screen.getCursorScreenPoint();
    const b = win.getBounds();
    const dx = (p.x - (b.x + b.width / 2)) / 420;   // 归一化到 ±1 左右
    const dy = (p.y - (b.y + b.height / 2)) / 420;
    sendWin('cursor', { x: Math.max(-1, Math.min(1, dx)), y: Math.max(-1, Math.min(1, dy)) });
  } catch {}
}, 120);

ipcMain.on('context-menu', () => {
  if (!win) return;
  const cur = readSettings().model || 'cake';
  const menu = Menu.buildFromTemplate([
    { label: '和她说话', click: openChat },
    {
      label: '放首歌 / 停一下',
      click: () => sendWin('toggle-music')
    },
    { label: '下一首', click: () => sendWin('next-track') },
    { label: '打开音乐文件夹', click: () => { ensureMusicDir(); shell.openPath(musicDir()); } },
    { type: 'separator' },
    {
      label: '小蛋助手',
      submenu: [
        { label: '看看我在干嘛（截屏问 AI）', click: () => sendWin('pet-look') },
        { label: '复制的内容帮我看 · 自动识别', click: () => sendWin('pet-clip') },
        { type: 'separator' },
        { label: '开始专注 25 分钟', click: startPomodoro },
        { label: '停止专注', click: () => { stopPomodoro(); petSay('好，先不计时啦'); } },
        { type: 'separator' },
        {
          label: '护眼提醒间隔',
          submenu: [20, 30, 45, 60, 0].map((m) => ({
            label: m ? m + ' 分钟' : '关掉',
            type: 'radio',
            checked: (readSettings().eyeMinutes ?? 30) === m,
            click: () => {
              writeSettings({ eyeMinutes: m });
              lastEye = Date.now();
              petSay(m ? '护眼提醒改成每 ' + m + ' 分钟' : '护眼提醒关掉啦');
            }
          }))
        },
        {
          label: '情绪陪伴',
          type: 'checkbox',
          checked: readSettings().careOn !== false,
          click: (mi) => writeSettings({ careOn: mi.checked })
        },
        {
          label: '提醒时露个脸说',
          type: 'checkbox',
          checked: readSettings().peekOn !== false,
          click: (mi) => writeSettings({ peekOn: mi.checked })
        }
      ]
    },
    { type: 'separator' },
    { label: '换个节目 (A)', click: () => sendWin('next-act') },
    {
      label: '待机节目',
      submenu: ACT_MENU.map((a) => ({
        label: a.label,
        click: () => sendWin('set-act', a.key)
      }))
    },
    { label: '小蛋 开 / 关 (F)', click: () => sendWin('toggle-fairy') },
    {
      label: '跟着我打字动（只数次数，不记键位）',
      type: 'checkbox',
      checked: typingOn,
      click: (item) => typingSet(item.checked)
    },
    { label: '今天陪你多久', click: () => petSay(companionLine()) },
    {
      label: '本地离线朗读（不吃网络）',
      type: 'checkbox',
      checked: readSettings().ttsLocal !== false,
      click: (item) => {
        writeSettings({ ttsLocal: item.checked });
        if (item.checked && !localTtsReady()) {
          petSay('没找到语音模型，先用联网的声音');
        } else {
          petSay(item.checked ? '好，用本地的声音' : '换回联网的声音');
        }
      }
    },
    {
      label: '花瓣雨',
      type: 'checkbox',
      checked: !!petalRainOn,
      click: (item) => { petalRainOn = item.checked; sendWin('toggle-rain', petalRainOn); }
    },
    { type: 'separator' },
    {
      label: '换个角色',
      submenu: MODEL_MENU.map((m) => ({
        label: m.label,
        type: 'radio',
        checked: cur === m.key,
        click: () => {
          writeSettings({ model: m.key });
          sendWin('switch-model', m.key);
        }
      }))
    },
    { type: 'separator' },
    { label: '回到右下角', click: () => {
        const { workArea } = screen.getPrimaryDisplay();
        win.setPosition(workArea.x + workArea.width - WIN_W - 30, workArea.y + workArea.height - WIN_H - 10);
        writeSettings({ x: win.getBounds().x, y: win.getBounds().y });
      } },
    { type: 'separator' },
    { label: '隐藏（托盘可恢复）', click: () => dismiss() },
    { label: '退出', click: () => { app.isQuitting = true; app.quit(); } }
  ]);
  menu.popup({ window: win });
});

ipcMain.on('quit', () => { app.isQuitting = true; app.quit(); });

ipcMain.handle('choose-model', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: '选择模型 (.glb)',
    filters: [{ name: 'glTF Binary', extensions: ['glb'] }],
    properties: ['openFile']
  });
  if (res.canceled || !res.filePaths[0]) return null;
  return res.filePaths[0];
});
