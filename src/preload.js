// Bridge between the renderer (index.html) and the main process.
// contextIsolation is on, so the renderer only sees exactly these methods.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('shell', {
  catalogue: () => ipcRenderer.invoke('catalogue'),
  start: (modelId, preset) => ipcRenderer.invoke('start', { modelId, preset }),
  stop: () => ipcRenderer.invoke('stop'),
  status: () => ipcRenderer.invoke('status'),
  logs: () => ipcRenderer.invoke('logs'),
  onStateChanged: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('state-changed', handler);
    return () => ipcRenderer.removeListener('state-changed', handler);
  },
});
