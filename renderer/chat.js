const $ = (id) => document.getElementById(id);
const logEl = $('log');

const SYSTEM = '你是蛋岛上的女孩「蛋糕纯」，一个住在用户电脑里的桌面伙伴。说话温柔、简短、有点俏皮，像朋友聊天。不要用 markdown，不要长篇大论，一次不超过三句话。你能看到用户的屏幕截图，看到什么就直说，不要编。';

let history = [];
let busy = false;
let voiceOn = localStorage.getItem('eggpet_voice') !== '0';
let lastShot = null;
let pendingAsk = '';

/* ---------------- 显示 ---------------- */
function bubble(text, who) {
  const d = document.createElement('div');
  d.className = 'msg ' + who;
  d.textContent = text;
  logEl.appendChild(d);
  logEl.scrollTop = logEl.scrollHeight;
  return d;
}
function tip(text) {
  const d = document.createElement('div');
  d.className = 'msg tip';
  d.textContent = text;
  logEl.appendChild(d);
  logEl.scrollTop = logEl.scrollHeight;
  return d;
}

/* ---------------- 朗读 ---------------- */
function speak(text) {
  if (!voiceOn || !window.speechSynthesis) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'zh-CN';
  u.rate = 1.06;
  u.pitch = 1.18;
  const zh = (speechSynthesis.getVoices() || []).find((v) => /zh|Chinese/i.test(v.lang + v.name));
  if (zh) u.voice = zh;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}
$('voice').classList.toggle('on', voiceOn);
$('voice').onclick = () => {
  voiceOn = !voiceOn;
  localStorage.setItem('eggpet_voice', voiceOn ? '1' : '0');
  $('voice').classList.toggle('on', voiceOn);
  if (!voiceOn) speechSynthesis.cancel();
};

/* ---------------- 发送 ---------------- */
async function ask(text) {
  if (busy) return;
  busy = true;
  $('send').disabled = true;
  $('mic').disabled = true;
  $('eye').disabled = true;
  $('snipBtn').disabled = true;
  const pending = bubble('…', 'her');

  try {
    const content = lastShot
      ? [{ type: 'text', text: text }, { type: 'image_url', image_url: { url: lastShot } }]
      : text;
    const msgs = [{ role: 'system', content: SYSTEM }, ...history, { role: 'user', content }];
    const reply = await window.pet.chat(msgs);
    pending.textContent = reply;
    history.push({ role: 'user', content: text });
    history.push({ role: 'assistant', content: reply });
    if (history.length > 14) history = history.slice(-14);
    speak(reply);
  } catch (err) {
    pending.textContent = '（出错了）' + (err.message || err);
    pending.classList.add('tip');
  } finally {
    lastShot = null;
    busy = false;
    $('send').disabled = false;
    $('mic').disabled = false;
    $('eye').disabled = false;
    $('snipBtn').disabled = false;
    logEl.scrollTop = logEl.scrollHeight;
    $('inp').focus();
  }
}

function sendTyped() {
  const text = $('inp').value.trim();
  if (!text) return;
  $('inp').value = '';
  bubble(text, 'me');
  ask(text);
}

$('send').onclick = sendTyped;
$('inp').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendTyped();
  }
});
$('close').onclick = () => window.pet.closeChat();

/* ---------------- 看整块屏幕 ---------------- */
$('eye').onclick = async () => {
  if (busy) return;
  bubble('看一眼我的屏幕 👁', 'me');
  try {
    lastShot = await window.pet.captureScreen();
    await ask('看看我现在屏幕上是什么，用一两句话说说。');
  } catch (err) {
    tip('截屏失败：' + (err.message || err));
    lastShot = null;
  }
};

/* ---------------- 圈一块问她 ---------------- */
$('snipBtn').onclick = async () => {
  if (busy) return;
  try {
    const data = await window.pet.snipScreen();
    if (!data) return;
    lastShot = data;
    bubble('圈了一块地方 ⬚', 'me');
    await ask('我圈出来的这块是什么？简单说说。');
  } catch (err) {
    tip('圈选失败：' + (err.message || err));
  }
};

/* ---------------- 语音输入 ---------------- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recog = null;
let recording = false;

if (SR) {
  recog = new SR();
  recog.lang = 'zh-CN';
  recog.interimResults = false;
  recog.continuous = false;
  recog.maxAlternatives = 1;

  recog.onstart = () => {
    recording = true;
    $('mic').classList.add('rec');
  };
  recog.onresult = (e) => {
    const text = (e.results[0][0].transcript || '').trim();
    if (text) {
      $('inp').value = text;
      sendTyped();
    } else {
      tip('没听清，再说一次');
    }
  };
  recog.onerror = (e) => {
    recording = false;
    $('mic').classList.remove('rec');
    const m = {
      'no-speech': '没听到声音，靠近点麦克风再说',
      'not-allowed': '麦克风权限被拒了',
      'audio-capture': '找不到麦克风',
      network: '语音服务连不上（可能要梯子）'
    };
    tip((m[e.error] || ('语音识别出错：' + e.error)));
  };
  recog.onend = () => {
    recording = false;
    $('mic').classList.remove('rec');
  };

  const startRec = (e) => {
    e.preventDefault();
    if (busy || recording) return;
    try { recog.start(); } catch { }
  };
  $('mic').addEventListener('pointerdown', startRec);
  $('mic').addEventListener('pointerup', (e) => {
    e.preventDefault();
    if (recording) { try { recog.stop(); } catch { } }
  });
} else {
  $('mic').disabled = true;
  $('mic').title = '这个环境不支持语音识别';
}

/* ---------------- 设置 ---------------- */
async function loadCfg() {
  const c = (await window.pet.getSettings()) || {};
  $('cfgUrl').value = c.apiUrl || 'https://api.deepseek.com/v1';
  $('cfgModel').value = c.apiModel || 'deepseek-flash';
  $('cfgKey').value = c.apiKey || '';
  $('cfgVision').value = c.apiVision || '';
}
$('gear').onclick = async () => { await loadCfg(); $('setup').classList.add('show'); };
$('cfgCancel').onclick = () => $('setup').classList.remove('show');
$('cfgSave').onclick = () => {
  window.pet.saveSettings({
    apiUrl: $('cfgUrl').value.trim() || 'https://api.deepseek.com/v1',
    apiModel: $('cfgModel').value.trim() || 'deepseek-flash',
    apiKey: $('cfgKey').value.trim(),
    apiVision: $('cfgVision').value.trim() || $('cfgModel').value.trim()
  });
  $('setup').classList.remove('show');
  tip('接口已保存');
};

/* ---------------- 启动 ---------------- */
(async () => {
  const c = (await window.pet.getSettings()) || {};
  if (!c.apiKey) tip('点右上角 ⚙ 填 API Key 才能说话。');
  else tip('她醒着。打字、🎤 说话、👁 看屏幕、⬚ 圈一块都行。');
  $('inp').focus();
})();
