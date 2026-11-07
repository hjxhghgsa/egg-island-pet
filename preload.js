const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pet', {
  hover: (hovering) => ipcRenderer.send('hover-state', hovering),
  dragStart: () => ipcRenderer.send('drag-start'),
  dragMove: () => ipcRenderer.send('drag-move'),
  dragEnd: () => ipcRenderer.send('drag-end'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (patch) => ipcRenderer.send('save-settings', patch),
  quit: () => ipcRenderer.send('quit'),
  chooseModel: () => ipcRenderer.invoke('choose-model'),
  contextMenu: () => ipcRenderer.send('context-menu'),
  openChat: () => ipcRenderer.send('open-chat'),
  closeChat: () => ipcRenderer.send('close-chat'),
  chat: (messages) => ipcRenderer.invoke('chat', messages),
  captureScreen: () => ipcRenderer.invoke('capture-screen'),
  snipScreen: () => ipcRenderer.invoke('snip-screen'),
  snipDone: (dataUrl) => ipcRenderer.send('snip-done', dataUrl),
  onSnipImage: (cb) => ipcRenderer.on('snip-image', (_e, d) => cb(d)),
  listMusic: () => ipcRenderer.invoke('list-music'),
  tts: (text) => ipcRenderer.invoke('tts', text),
  noMusic: () => ipcRenderer.send('no-music'),
  onToggleMusic: (cb) => ipcRenderer.on('toggle-music', () => cb()),
  onNextTrack: (cb) => ipcRenderer.on('next-track', () => cb()),
  onSummon: (cb) => ipcRenderer.on('summon', () => cb()),
  touch: () => ipcRenderer.send('user-touch'),
  onApplySettings: (cb) => ipcRenderer.on('apply-settings', (_e, s) => cb(s)),
  onSwitchModel: (cb) => ipcRenderer.on('switch-model', (_e, k) => cb(k))
});
