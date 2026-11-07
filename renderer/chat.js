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
const ttsPlayer = new Audio();
let ttsSeq = 0;

function speakFallback(text) {
  if (!window.speechSynthesis) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'zh-CN';
  u.rate = 1.06;
  const zh = (speechSynthesis.getVoices() || []).find((v) => /zh|Chinese/i.test(v.lang + v.name));
  if (zh) u.voice = zh;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

async function speak(text) {
  if (!voiceOn) return;
  const my = ++ttsSeq;
  try {
    ttsPlayer.pause();
    const url = await window.pet.tts(text);
    if (my !== ttsSeq) return;   // 期间又说了新的一句，丢掉旧的
    ttsPlayer.src = url;
    await ttsPlayer.play();
  } catch {
    if (my === ttsSeq) speakFallback(text);
  }
}

$('voice').classList.toggle('on', voiceOn);
$('voice').onclick = () => {
  voiceOn = !voiceOn;
  localStorage.setItem('eggpet_voice', voiceOn ? '1' : '0');
  $('voice').classList.toggle('on', voiceOn);
  if (!voiceOn) {
    ttsSeq++;
    ttsPlayer.pause();
    if (window.speechSynthesis) speechSynthesis.cancel();
  }
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
function showSnipPreview(data) {
  const wrap = document.createElement('div');
  wrap.className = 'snip-wrap';

  const img = document.createElement('img');
  img.src = data;
  img.className = 'snip-img';

  const row = document.createElement('div');
  row.className = 'snip-row';

  const askBtn = document.createElement('button');
  askBtn.className = 'snip-btn primary';
  askBtn.textContent = '这是什么';
  askBtn.onclick = () => {
    wrap.remove();
    bubble('这是什么？', 'me');
    ask('这是什么？简短说说。');
  };

  const dropBtn = document.createElement('button');
  dropBtn.className = 'snip-btn';
  dropBtn.textContent = '不要了';
  dropBtn.onclick = () => {
    wrap.remove();
    lastShot = null;
    tip('已取消');
  };

  row.append(askBtn, dropBtn);
  wrap.append(img, row);
  logEl.appendChild(wrap);
  logEl.scrollTop = logEl.scrollHeight;
}

$('snipBtn').onclick = async () => {
  if (busy) return;
  try {
    const data = await window.pet.snipScreen();
    if (!data) return;
    lastShot = data;
    showSnipPreview(data);
    tip('圈好了。说你想拿这块干什么，或者点上面的按钮');
    $('inp').focus();
  } catch (err) {
    tip('圈选失败：' + (err.message || err));
  }
};

/* ---------------- 语音输入：本机离线识别 + 微信式按住说话 ----------------
   以前用 Web Speech API 要连 Google，国内基本不可用。现在改成：
   按住 → 16k 单声道 PCM → 主进程 sherpa-onnx 流式识别（实时上屏）
   → 松手 → AI 纠正同音错字 + 判断「聊天 / 指令」→ 聊天直接发，指令直接执行。 */
let asrOn = false;
let asrCancelByDrag = false;
let asrStartY = 0;
let audioCtx = null, micStream = null, micNode = null;

function setVoiceLayer(on, cancel) {
  const l = $('voiceLayer');
  l.classList.toggle('on', !!on);
  l.classList.toggle('cancel', !!cancel);
  $('vHint').textContent = cancel ? '松开取消' : '松开发送 · 上滑取消';
}

function stopMic() {
  try { micNode?.disconnect(); } catch {}
  try { micStream?.getTracks().forEach((t) => t.stop()); } catch {}
  try { audioCtx?.close(); } catch {}
  micNode = null; micStream = null; audioCtx = null;
}

async function startAsr(ev) {
  if (busy || asrOn) return;
  asrOn = true;
  asrCancelByDrag = false;
  asrStartY = ev.clientY;
  $('mic').classList.add('rec');
  setVoiceLayer(true, false);
  $('vText').textContent = '正在听…';
  // 第一次按要加载 78MB 模型（约 1.3s），给个明确反馈，别让人以为没反应
  const slow = setTimeout(() => {
    if (asrOn) $('vText').textContent = '正在热识别引擎…';
  }, 420);
  try {
    window.pet.voiceDuck?.(true);   // 先掐音乐，别把歌录进去
    const r = await window.pet.asrStart();
    clearTimeout(slow);
    if (!r.ok) throw new Error(r.error || '识别引擎没起来');
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    const src = audioCtx.createMediaStreamSource(micStream);
    micNode = audioCtx.createScriptProcessor(2048, 1, 1);
    src.connect(micNode);
    micNode.connect(audioCtx.destination);
    micNode.onaudioprocess = (e) => {
      if (!asrOn) return;
      // AudioBuffer 会被复用，必须拷一份再跨进程传
      const f = new Float32Array(e.inputBuffer.getChannelData(0));
      window.pet.asrChunk(f.buffer);
    };
  } catch (err) {
    clearTimeout(slow);
    stopAsr(true);
    tip('语音输入起不来：' + (err.message || err));
  }
}

async function stopAsr(cancel) {
  if (!asrOn) return;
  asrOn = false;
  window.pet.voiceDuck?.(false);
  stopMic();
  $('mic').classList.remove('rec');
  setVoiceLayer(false, false);
  if (cancel) { window.pet.asrCancel(); return; }

  const thinking = tip('在听懂你说的话…');
  let r;
  try { r = await window.pet.asrEnd(); }
  catch (e) { thinking.remove(); tip('识别失败：' + (e.message || e)); return; }
  thinking.remove();
  const text = (r.text || '').trim();
  if (!text) { tip('没听清，再按着说一次～'); return; }

  bubble('🎤 ' + text, 'me');
  if (r.intent === 'command') {
    window.pet.voiceCommand(r.action, text);
    tip('听懂啦，正在帮你做～');
  } else {
    $('inp').value = '';
    ask(text);                    // 微信式：松手就发
  }
}

window.pet?.onAsrPartial?.((d) => { $('vText').textContent = (d && d.text) || '正在听…'; });
window.pet?.onAsrError?.((d) => tip('识别出错：' + (d && d.error)));
window.pet?.onAsrCommandDone?.((d) => tip('已执行：' + (d && d.raw)));

const mic = $('mic');
mic.title = '按住说话 · 上滑取消';
mic.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  try { mic.setPointerCapture(e.pointerId); } catch {}
  startAsr(e);
});
mic.addEventListener('pointermove', (e) => {
  if (!asrOn) return;
  const cancel = e.clientY - asrStartY < -55;      // 上滑取消
  if (cancel !== asrCancelByDrag) {
    asrCancelByDrag = cancel;
    setVoiceLayer(true, cancel);
  }
});
mic.addEventListener('pointerup', () => stopAsr(asrCancelByDrag));
mic.addEventListener('pointercancel', () => stopAsr(true));
mic.addEventListener('contextmenu', (e) => e.preventDefault());

/* ---------------- 设置 ---------------- */
async function loadCfg() {
  const c = (await window.pet.getSettings()) || {};
  $('cfgUrl').value = c.apiUrl || 'https://api.deepseek.com/v1';
  $('cfgModel').value = c.apiModel || 'deepseek-flash';
  $('cfgKey').value = c.apiKey || '';
  $('cfgVision').value = c.apiVision || '';
  $('cfgVoice').value = c.ttsVoice || 'zh-CN-XiaoxiaoNeural';
}
$('gear').onclick = async () => { await loadCfg(); $('setup').classList.add('show'); };
$('cfgCancel').onclick = () => $('setup').classList.remove('show');
$('cfgSave').onclick = () => {
  window.pet.saveSettings({
    apiUrl: $('cfgUrl').value.trim() || 'https://api.deepseek.com/v1',
    apiModel: $('cfgModel').value.trim() || 'deepseek-flash',
    apiKey: $('cfgKey').value.trim(),
    apiVision: $('cfgVision').value.trim() || $('cfgModel').value.trim(),
    ttsVoice: $('cfgVoice').value
  });
  $('setup').classList.remove('show');
  tip('已保存，点 🔊 试试新声音');
};

/* ---------------- 启动 ---------------- */
(async () => {
  const c = (await window.pet.getSettings()) || {};
  if (!c.apiKey) tip('点右上角 ⚙ 填 API Key 才能说话。');
  else tip('她醒着。打字、🎤 按住说话（上滑取消）、👁 看屏幕、⬚ 圈一块都行。说话能直接下指令，比如「看看我在干嘛」「开始专注」。');
  $('inp').focus();
})();
