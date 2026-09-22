// model-stove —— 渲染层与主进程之间的桥。
// contextIsolation 已开启,所以渲染层只能看到这里显式暴露的方法。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('shell', {
  /** 取模型 / 预设 / 思考强度清单。 */
  catalogue: () => ipcRenderer.invoke('catalogue'),
  /** 启动服务。reasoning 为思考强度键名,缺省 medium。 */
  start: (modelId, preset, reasoning) => ipcRenderer.invoke('start', { modelId, preset, reasoning }),
  /** 停止当前服务。 */
  stop: () => ipcRenderer.invoke('stop'),
  /** 查询运行状态(是否在跑 / 上下文 / 运行时长)。 */
  status: () => ipcRenderer.invoke('status'),
  /** 读取服务日志末尾。 */
  logs: () => ipcRenderer.invoke('logs'),
  /** 订阅状态变更(服务意外退出时主进程会通知)。 */
  onStateChanged: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('state-changed', handler);
    return () => ipcRenderer.removeListener('state-changed', handler);
  },
});
