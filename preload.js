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
  onApplySettings: (cb) => ipcRenderer.on('apply-settings', (_e, s) => cb(s)),
  onSwitchModel: (cb) => ipcRenderer.on('switch-model', (_e, k) => cb(k))
});
