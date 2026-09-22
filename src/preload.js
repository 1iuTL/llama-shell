// model-stove —— 渲染层与主进程之间的桥。
// contextIsolation 已开启,所以渲染层只能看到这里显式暴露的方法。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('shell', {
  /** 取模型 / 预设 / 思考强度清单。 */
  catalogue: () => ipcRenderer.invoke('catalogue'),
  /** 启动服务。
   *  reasoning 为思考强度键名;lanMode 为 true 时监听 0.0.0.0;
   *  budget 为思考预算键名(见 catalogue 的 budgets),缺省用默认档。 */
  start: (modelId, preset, reasoning, lanMode, budget) =>
    ipcRenderer.invoke('start', { modelId, preset, reasoning, lanMode, budget }),
  /** 停止当前服务。 */
  stop: () => ipcRenderer.invoke('stop'),
  /** 查询运行状态(是否在跑 / 上下文 / 运行时长)。 */
  status: () => ipcRenderer.invoke('status'),
  /** 读取服务日志末尾。 */
  logs: () => ipcRenderer.invoke('logs'),

  /** 读取本地设置(API Key、局域网开关)和当前可用的局域网地址。 */
  getSettings: () => ipcRenderer.invoke('settings:get'),
  /** 写入设置的一部分。 */
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  /** 生成一个新的随机 API Key 并保存。 */
  genKey: () => ipcRenderer.invoke('settings:genkey'),
  /** 重新枚举网卡地址(开热点后需要刷新)。 */
  addresses: () => ipcRenderer.invoke('net:addresses'),

  /** 订阅状态变更(服务意外退出时主进程会通知)。 */
  onStateChanged: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('state-changed', handler);
    return () => ipcRenderer.removeListener('state-changed', handler);
  },
});
