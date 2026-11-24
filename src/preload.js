const { contextBridge, ipcRenderer } = require('electron');
const invoke = (channel, value) => ipcRenderer.invoke(channel, value);
contextBridge.exposeInMainWorld('desk', {
  initial: () => invoke('initial'), readSettings: () => invoke('settings-read'), save: value => invoke('save', value),
  answer: value => invoke('answer', value), merge: value => invoke('merge', value),
  deleteQuestion: id => invoke('delete', id), undoDelete: () => invoke('undo-delete'),
  select: id => invoke('select', id), newQuestion: () => invoke('new'), cancel: () => invoke('cancel'),
  startASR: rate => invoke('asr-start', rate), stopASR: () => invoke('asr-stop'),
  phoneStart: () => invoke('phone-start'), phoneStop: () => invoke('phone-stop'),
  audio: bytes => ipcRenderer.send('audio', bytes), export: () => invoke('export'),
  onEvent: handler => { const listener = (_event, data) => handler(data); ipcRenderer.on('event', listener); return () => ipcRenderer.removeListener('event', listener); }
});
