const { app, BrowserWindow, ipcMain, Tray, Menu, screen, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');

// 透明窗口在 Windows 上的必要开关
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
// Chromium 默认禁止 file:// 页面加载 ES module，桌面应用需要放开
app.commandLine.appendSwitch('allow-file-access-from-files');

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

const WIN_W = 220;
const WIN_H = 220;

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

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.once('ready-to-show', () => {
    win.show();
    const q = s.quality || 'balanced';
    win.webContents.send('apply-settings', { quality: q, scale: s.scale || 1 });
  });

  win.on('closed', () => { win = null; });
}

function toggleVisible() {
  if (!win) return createWindow();
  if (win.isVisible()) win.hide();
  else win.show();
}

function buildTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'icon.ico'));
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 16, height: 16 }));
  tray.setToolTip('蛋岛宠物');
  const menu = Menu.buildFromTemplate([
    { label: '显示 / 隐藏', click: toggleVisible },
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
  const ok = await ensureThreeCore();
  if (!ok && !fs.existsSync(THREE_CORE)) {
    dialog.showErrorBox('缺少运行库',
      '无法下载 three.core.js，请检查网络后重试。\n\n目标路径：\n' + THREE_CORE);
  }

  createWindow();
  buildTray();

  // 调试：PET_SHOT=<路径> 时抓一张桌面合成图后退出
  if (process.env.PET_CHAT) setTimeout(() => openChat(), 3500);
  if (process.env.PET_SHOT) {
    setTimeout(async () => {
      try {
        const dbg = await win.webContents.executeJavaScript(
          `JSON.stringify({state: window.__pet, w: innerWidth, h: innerHeight})`
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
});

app.on('window-all-closed', () => {
  // 托盘常驻，不随窗口关闭退出
});

// ---- IPC ----

// 悬停命中判定：切换鼠标穿透
ipcMain.on('hover-state', (_e, hovering) => {
  if (!win) return;
  win.setIgnoreMouseEvents(!hovering, { forward: true });
});

// 拖动：渲染层按下后，主进程跟踪光标
ipcMain.on('drag-start', () => {
  if (!win) return;
  const cursor = screen.getCursorScreenPoint();
  const b = win.getBounds();
  dragOrigin = { dx: cursor.x - b.x, dy: cursor.y - b.y };
});

ipcMain.on('drag-move', () => {
  if (!win || !dragOrigin) return;
  const cursor = screen.getCursorScreenPoint();
  win.setPosition(cursor.x - dragOrigin.dx, cursor.y - dragOrigin.dy);
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
  const W = 380, H = 520;
  chatWin = new BrowserWindow({
    width: W,
    height: H,
    x: Math.max(0, Math.min(b.x - W + 120, 4000)),
    y: Math.max(0, b.y - H + 180),
    frame: false,
    resizable: false,
    skipTaskbar: false,
    alwaysOnTop: true,
    backgroundColor: '#fffaf3',
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  chatWin.setMenu(null);
  chatWin.loadFile(path.join(__dirname, 'renderer', 'chat.html'));
  chatWin.on('closed', () => { chatWin = null; });
}

ipcMain.on('open-chat', openChat);
ipcMain.on('close-chat', () => { if (chatWin) chatWin.close(); });

// 主进程转发请求，绕开渲染层 CORS
ipcMain.handle('chat', async (_e, messages) => {
  const s = readSettings();
  const base = (s.apiUrl || 'http://localhost:11434/v1').replace(/\/+$/, '');
  const model = s.apiModel || 'qwen2.5:7b';
  const key = s.apiKey || 'ollama';

  const res = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({ model, messages, stream: false, temperature: 0.8 }),
    signal: AbortSignal.timeout(60000)
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + res.statusText);
  const j = await res.json();
  const out = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (!out) throw new Error('接口没返回内容');
  return out.trim();
});

/* 右键菜单 */
const MODEL_MENU = [
  { key: 'cake', label: '蛋糕纯' },
  { key: 'jade', label: '珠玉纯' }
];

ipcMain.on('context-menu', () => {
  if (!win) return;
  const cur = readSettings().model || 'cake';
  const menu = Menu.buildFromTemplate([
    { label: '和她说话', click: openChat },
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
