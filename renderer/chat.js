const $ = (id) => document.getElementById(id);
const logEl = $('log');

const SYSTEM = '你是蛋岛上的女孩「蛋糕纯」，一个住在用户电脑里的桌面伙伴。说话温柔、简短、有点俏皮，像朋友聊天。不要用 markdown，不要长篇大论，一次不超过三句话。';

let history = [];
let busy = false;

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
}

async function send() {
  if (busy) return;
  const text = $('inp').value.trim();
  if (!text) return;

  $('inp').value = '';
  bubble(text, 'me');
  history.push({ role: 'user', content: text });

  busy = true;
  $('send').disabled = true;
  const pending = bubble('…', 'her');

  try {
    const reply = await window.pet.chat([{ role: 'system', content: SYSTEM }, ...history]);
    pending.textContent = reply;
    history.push({ role: 'assistant', content: reply });
    if (history.length > 12) history = history.slice(-12);
  } catch (err) {
    pending.textContent = '（连不上接口）' + (err.message || err);
  } finally {
    busy = false;
    $('send').disabled = false;
    logEl.scrollTop = logEl.scrollHeight;
    $('inp').focus();
  }
}

$('send').onclick = send;
$('inp').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
$('close').onclick = () => window.pet.closeChat();

/* 设置面板 */
async function loadCfg() {
  const c = (await window.pet.getSettings()) || {};
  $('cfgUrl').value = c.apiUrl || 'http://localhost:11434/v1';
  $('cfgModel').value = c.apiModel || 'qwen2.5:7b';
  $('cfgKey').value = c.apiKey || 'ollama';
}

$('gear').onclick = async () => {
  await loadCfg();
  $('setup').classList.add('show');
};
$('cfgCancel').onclick = () => $('setup').classList.remove('show');
$('cfgSave').onclick = () => {
  const patch = {
    apiUrl: $('cfgUrl').value.trim() || 'http://localhost:11434/v1',
    apiModel: $('cfgModel').value.trim() || 'qwen2.5:7b',
    apiKey: $('cfgKey').value.trim() || 'ollama'
  };
  window.pet.saveSettings(patch);
  $('setup').classList.remove('show');
  tip('接口已保存');
};

(async () => {
  const c = (await window.pet.getSettings()) || {};
  if (!c.apiUrl) {
    tip('第一次用：点右上角 ⚙ 填接口地址（本机有 Ollama 就填 localhost:11434）');
  } else {
    tip('她醒着，聊点什么吧');
  }
  $('inp').focus();
})();
