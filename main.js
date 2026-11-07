const { app, BrowserWindow, ipcMain, Tray, Menu, screen, nativeImage, dialog, desktopCapturer, shell, globalShortcut, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');

// 透明窗口在 Windows 上的必要开关
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
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
let userTouched = false;
const SUMMON_KEY = 'Control+Alt+E';

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
    show: false,
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
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
    win.show();
    win.setAlwaysOnTop(true, 'screen-saver');
    const q = s.quality || 'balanced';
    win.webContents.send('apply-settings', { quality: q, scale: s.scale || 1 });

    // 露个脸就藏起来，等召唤。碰过她就不藏了
    if (!process.env.PET_KEEP && !process.env.PET_SHOT) {
      try {
        tray.displayBalloon({
          title: '蛋岛宠物在后台',
          content: '按 Ctrl+Alt+E 召唤她，或者点右下角托盘图标。'
        });
      } catch {}
      autoHideTimer = setTimeout(() => {
        if (!win || win.isDestroyed() || !win.isVisible()) return;
        // 正在聊天就不收起来
        if (chatWin && !chatWin.isDestroyed()) return;
        win.hide();
        console.log('[autohide] hidden');
      }, 3000);
    }
  });

  // 别的窗口抢焦点时会被压下去，这里一直抢回最上层
  const keepTop = () => {
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    win.setAlwaysOnTop(true, 'screen-saver');
  };
  win.on('blur', () => setTimeout(keepTop, 120));
  win.on('show', () => setTimeout(keepTop, 120));
  setInterval(keepTop, 15000);

  win.on('closed', () => { win = null; });
}

function summon() {
  if (!win || win.isDestroyed()) return createWindow();
  if (autoHideTimer) { clearTimeout(autoHideTimer); autoHideTimer = null; }
  // 攒着的提醒，召唤时一次性说给主人听
  if (pendingSays.length) {
    const line = pendingSays.splice(0).join('  /  ');
    setTimeout(() => {
      if (win && !win.isDestroyed()) win.webContents.send('pet-say', { text: line });
    }, 450);
  }
  userTouched = true;
  if (!win.isVisible()) {
    win.show();
    win.setAlwaysOnTop(true, 'screen-saver');
    win.webContents.send('summon');
  } else {
    win.focus();
    win.webContents.send('summon');
  }
}

function dismiss() {
  if (win && !win.isDestroyed()) win.hide();
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

  const ok = await ensureThreeCore();
  if (!ok && !fs.existsSync(THREE_CORE)) {
    dialog.showErrorBox('缺少运行库',
      '无法下载 three.core.js，请检查网络后重试。\n\n目标路径：\n' + THREE_CORE);
  }

  createWindow();
  buildTray();

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
  if (process.env.PET_SHOT) {
    setTimeout(async () => {
      try {
        const dbg = await win.webContents.executeJavaScript(
          `JSON.stringify({state: window.__pet, w: innerWidth, h: innerHeight, fx: document.getElementById('fx').children.length, bits: [...document.getElementById('fx').children].slice(0,3).map(e => ({t: e.textContent, o: getComputedStyle(e).opacity, c: e.style.color})), yaw: window.__pet.yaw()})`
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
});

app.on('window-all-closed', () => {
  // 托盘常驻，不随窗口关闭退出
});

app.on('will-quit', () => {
  try { globalShortcut.unregisterAll(); } catch {}
});

// ---- IPC ----

// 悬停命中判定：切换鼠标穿透
ipcMain.on('hover-state', (_e, hovering) => {
  if (!win) return;
  win.setIgnoreMouseEvents(!hovering, { forward: true });
});

// 拖动：渲染层按下后，主进程跟踪光标
let lastDragPoint = null;
ipcMain.on('drag-start', () => {
  if (!win) return;
  const cursor = screen.getCursorScreenPoint();
  const b = win.getBounds();
  dragOrigin = { dx: cursor.x - b.x, dy: cursor.y - b.y };
  lastDragPoint = null;
});

ipcMain.on('drag-move', () => {
  if (!win || !dragOrigin) return;
  const cursor = screen.getCursorScreenPoint();
  // 光标没动就别反复 setBounds，长按右键时才不会一直重绘
  if (lastDragPoint && cursor.x === lastDragPoint.x && cursor.y === lastDragPoint.y) return;
  lastDragPoint = { x: cursor.x, y: cursor.y };
  // 带尺寸一起写，保证拖动过程中窗口永远不会被拉大
  win.setBounds({
    x: cursor.x - dragOrigin.dx,
    y: cursor.y - dragOrigin.dy,
    width: WIN_W,
    height: WIN_H
  });
});

ipcMain.on('drag-end', () => {
  if (!win || !dragOrigin) return;
  dragOrigin = null;
  const b = win.getBounds();
  writeSettings({ x: b.x, y: b.y });
});

ipcMain.handle('get-settings', () => readSettings());
ipcMain.on('save-settings', (_e, patch) => writeSettings(patch));

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
  if (petWasVisible) win.hide();

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
  chatWin.on('closed', () => {
    chatWin = null;
    // 关掉聊天后把她放回来
    if (petWasVisible && win && !win.isDestroyed()) {
      win.show();
      win.setAlwaysOnTop(true, 'screen-saver');
    }
  });
}

ipcMain.on('open-chat', openChat);
ipcMain.on('close-chat', () => { if (chatWin) chatWin.close(); });

// 用户碰过她，就不再自动隐身
ipcMain.on('user-touch', () => {
  userTouched = true;
  if (autoHideTimer) { clearTimeout(autoHideTimer); autoHideTimer = null; }
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

ipcMain.handle('tts', async (_e, text) => {
  const { MsEdgeTTS, OUTPUT_FORMAT } = getEdgeTTS();
  const s = readSettings();
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

/* ---------------- 小蛋助手：陪伴 / 健康提醒 / 番茄钟 ----------------
   能力参考 GitHub 上的 DeskPet Live2D、Toty、SUDARI：都是把提醒做成
   角色的一句话，而不是冷冰冰的系统弹窗；再加番茄钟和屏幕/剪贴板感知。 */
const CARE = {
  eye:   ['看看远处 20 秒～', '眨眨眼，歇一下', '抬眼看看窗外吧'],
  water: ['喝口水吧～', '杯子空了，添点水', '补点水再继续'],
  move:  ['起来伸个懒腰吧', '肩膀紧了吧，动一动', '走两步，别久坐'],
  late:  ['这么晚啦，早点收工', '今天够了，休息吧', '我陪你，但别熬太狠'],
  mood:  ['我在呢，慢慢来', '歇会儿也没关系', '今天也辛苦啦',
          '刚才那下挺利索', '深呼吸一下，不急', '有我陪着你呢']
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
  if (wasHidden) {
    win.show();
    win.setAlwaysOnTop(true, 'screen-saver');
  }
  // 只用角色身上的半透明气泡说话，不弹系统通知
  win.webContents.send('pet-say', { text });
  if (wasHidden) {
    clearTimeout(peekTimer);
    peekTimer = setTimeout(() => {
      if (win && !win.isDestroyed() && !win.isFocused()) win.hide();
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

function startPomodoro() {
  stopPomodoro();
  petSay('一起专注 25 分钟');
  pomoTimer = setTimeout(() => {
    pomoTimer = null;
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
  { key: 'chase', label: '追小精灵' },
  { key: 'sleep', label: '打瞌睡' }
];

ipcMain.on('context-menu', () => {
  if (!win) return;
  const cur = readSettings().model || 'cake';
  const menu = Menu.buildFromTemplate([
    { label: '和她说话', click: openChat },
    {
      label: '放首歌 / 停一下',
      click: () => win && win.webContents.send('toggle-music')
    },
    { label: '下一首', click: () => win && win.webContents.send('next-track') },
    { label: '打开音乐文件夹', click: () => { ensureMusicDir(); shell.openPath(musicDir()); } },
    { type: 'separator' },
    {
      label: '小蛋助手',
      submenu: [
        { label: '看看我在干嘛（截屏问 AI）', click: () => win && win.webContents.send('pet-look') },
        { label: '复制的内容帮我看看', click: () => win && win.webContents.send('pet-clip') },
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
    { label: '换个节目 (A)', click: () => win && win.webContents.send('next-act') },
    {
      label: '待机节目',
      submenu: ACT_MENU.map((a) => ({
        label: a.label,
        click: () => win && win.webContents.send('set-act', a.key)
      }))
    },
    { label: '小蛋 开 / 关 (F)', click: () => win && win.webContents.send('toggle-fairy') },
    { type: 'separator' },
    {
      label: '换个角色',
      submenu: MODEL_MENU.map((m) => ({
        label: m.label,
        type: 'radio',
        checked: cur === m.key,
        click: () => {
          writeSettings({ model: m.key });
          win.webContents.send('switch-model', m.key);
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
    { label: '隐藏（托盘可恢复）', click: () => win.hide() },
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
