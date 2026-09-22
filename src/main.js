// model-stove —— 一个围绕 llama-server 的极简 Electron 外壳。
//
// 职责:
//   1. 选一个模型 + 预设(以及思考强度)
//   2. 用正确的参数拉起对应的 llama-server 构建
//   3. 轮询 /health,等它返回 200
//   4. 在主区域加载服务自带的 Web UI
//   5. 停止 / 切换 / 退出时把子进程收干净
//
// 聊天界面本身来自 llama.cpp;这个外壳只负责管理它。
const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const { MODELS, PRESETS, REASONING, buildArgs } = require('./config');

const PORT = 8091;
const BASE = `http://127.0.0.1:${PORT}`;

let win = null;
let child = null;
let current = { modelId: null, preset: null, reasoning: null, startedAt: null };
let logFile = null;

// 子进程的输出写进文件,而不是管道。
// Node 默认的管道 stdio 会打开匿名管道,某些沙箱会拒绝;而管道一旦失败,
// 整个 Electron 主进程会被原生崩溃带走。重定向没有这两个问题,
// 而且我们仍然可以读取这个文件来喂日志面板。
const LOG_DIR = path.join(__dirname, '..', 'logs');

// ---------------------------------------------------------------- 工具函数

/** 读取日志文件末尾若干行。 */
function readLogTail(maxLines = 250) {
  if (!logFile) return [];
  try {
    const text = fs.readFileSync(logFile, 'utf8');
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    return lines.slice(-maxLines);
  } catch {
    return [];
  }
}

/** 发一个 GET,把结果收敛成 { ok, status, body } —— 连不上不抛异常。 */
function httpGet(url, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ ok: res.statusCode === 200, status: res.statusCode, body }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, body: '' }); });
    req.on('error', () => resolve({ ok: false, status: 0, body: '' }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询 /health 直到就绪。模型加载通常 30-60 秒,给足 5 分钟。 */
async function waitForHealth(timeoutMs = 300000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (!child) return false;
    const r = await httpGet(`${BASE}/health`, 2000);
    if (r.ok) return true;
    await sleep(1200);
  }
  return false;
}

function modelExists(model) {
  try { return fs.existsSync(model.file); } catch { return false; }
}

function binExists(model) {
  try { return fs.existsSync(model.bin); } catch { return false; }
}

// ------------------------------------------------------------------ 进程

/** 停掉当前服务。先温和 kill,8 秒不退就强杀。 */
function stopServer() {
  return new Promise((resolve) => {
    if (!child) { current = { modelId: null, preset: null, reasoning: null, startedAt: null }; return resolve(); }
    const dying = child;
    child = null;
    try {
      dying.kill();
    } catch { /* 已经没了 */ }
    const done = () => { current = { modelId: null, preset: null, reasoning: null, startedAt: null }; resolve(); };
    const t = setTimeout(() => { try { dying.kill('SIGKILL'); } catch {} ; done(); }, 8000);
    dying.once('exit', () => { clearTimeout(t); done(); });
  });
}

/** 拉起服务并等它就绪。
 *  reasoningKey 为 null/空时**不传** --reasoning-effort,由模型模板或界面自行决定。 */
async function startServer(modelId, presetKey, reasoningKey) {
  await stopServer();

  const model = MODELS.find((m) => m.id === modelId);
  if (!model) throw new Error(`未知的模型标识: ${modelId}`);
  if (!modelExists(model)) throw new Error(`模型文件不存在:\n${model.file}`);
  if (!binExists(model)) throw new Error(`llama-server 不存在:\n${model.bin}`);

  const args = buildArgs(model, presetKey, PORT, reasoningKey);

  fs.mkdirSync(LOG_DIR, { recursive: true });
  logFile = path.join(LOG_DIR, `shell-${modelId}.log`);
  const banner = `[shell] ${new Date().toISOString()}\n[shell] ${model.bin}\n[shell] ${args.join(' ')}\n`;
  fs.writeFileSync(logFile, banner, 'utf8');
  const out = fs.openSync(logFile, 'a');

  // detached: 外壳崩了子进程也能活,而不是被一起带走。
  // stdio 走文件,永远不走管道。
  child = spawn(model.bin, args, {
    windowsHide: true,
    detached: true,
    stdio: ['ignore', out, out],
  });
  current = { modelId, preset: presetKey, reasoning: reasoningKey || null, startedAt: Date.now() };

  // 子进程已经有自己的句柄了;我们继续持有会每次启动漏一个 fd。
  try { fs.closeSync(out); } catch {}
  try { child.unref(); } catch {}

  child.on('error', (err) => {
    try { fs.appendFileSync(logFile, `[shell] 启动子进程失败: ${err.message}\n`); } catch {}
  });

  child.on('exit', (code) => {
    try { fs.appendFileSync(logFile, `[shell] 服务退出,code=${code}\n`); } catch {}
    if (child) { child = null; current = { modelId: null, preset: null, reasoning: null, startedAt: null }; }
    notifyRenderer();
  });

  const ok = await waitForHealth();
  if (!ok) {
    const tail = readLogTail(14).join('\n');
    await stopServer();
    throw new Error(`服务启动失败或超时。日志末尾:\n${tail}`);
  }
  try { fs.appendFileSync(logFile, '[shell] 服务就绪\n'); } catch {}
  return { url: `${BASE}/`, modelId, preset: presetKey, reasoning: current.reasoning };
}

// ------------------------------------------------------------------ 渲染层

function notifyRenderer() {
  if (win && !win.isDestroyed()) win.webContents.send('state-changed');
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 940,
    minHeight: 620,
    backgroundColor: '#14161a',
    title: 'Model Stove · 模型灶台',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,      // 右侧主区域是一个指向 llama-server 的 <webview>
      spellcheck: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'index.html'));
  win.on('closed', () => { win = null; });
}

// --------------------------------------------------------------------- IPC

ipcMain.handle('catalogue', () => ({
  models: MODELS.map((m) => ({
    id: m.id,
    name: m.name,
    note: m.note,
    file: m.file,
    defaultPreset: m.defaultPreset,
    present: modelExists(m),
    binPresent: binExists(m),
  })),
  presets: Object.entries(PRESETS).map(([k, v]) => ({
    key: k, label: v.label, hint: v.hint, ctx: v.ctx, vision: v.vision,
  })),
  reasoning: Object.entries(REASONING).map(([k, v]) => ({
    key: k, label: v.label, hint: v.hint, flag: v.flag,
  })),
  port: PORT,
}));

ipcMain.handle('start', async (_e, { modelId, preset, reasoning }) => {
  try {
    const r = await startServer(modelId, preset, reasoning);
    return { ok: true, ...r };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('stop', async () => { await stopServer(); return { ok: true }; });

ipcMain.handle('status', async () => {
  const health = await httpGet(`${BASE}/health`, 1500);
  const slots = await httpGet(`${BASE}/slots`, 1500);
  let ctx = null;
  if (slots.ok) {
    try { ctx = JSON.parse(slots.body)[0]?.n_ctx ?? null; } catch {}
  }
  const model = MODELS.find((m) => m.id === current.modelId) || null;
  return {
    running: health.ok,
    modelId: current.modelId,
    modelName: model ? model.name : null,
    preset: current.preset,
    reasoning: current.reasoning,
    ctx,
    uptimeSec: current.startedAt ? Math.floor((Date.now() - current.startedAt) / 1000) : 0,
    url: health.ok ? `${BASE}/` : null,
  };
});

ipcMain.handle('logs', () => readLogTail(250));

// ------------------------------------------------------------------ 生命周期

app.whenReady().then(async () => {
  createWindow();

  // 自测开关:MODEL_STOVE_AUTOSTART="<模型id>:<预设>[:<思考强度>]" 会在启动时
  // 立刻拉起一个服务,用来在不点任何按钮的情况下验证 拉起→健康检查→界面 这条链路。
  // 不设这个变量时完全无副作用。
  const auto = process.env.MODEL_STOVE_AUTOSTART;
  if (auto) {
    const [modelId, preset, reasoning] = auto.split(':');
    // 等窗口加载完,免得在渲染层还不存在时就发状态变更。
    try {
      await new Promise((r) => {
        if (!win || win.webContents.isLoadingMainFrame()) {
          win.webContents.once('did-finish-load', r);
        } else r();
      });
    } catch {}
    console.log('[shell] 自测启动', modelId, preset, reasoning || '(默认思考强度)');
    try {
      await startServer(modelId, preset, reasoning);
      console.log('[shell] 自测启动成功');
      notifyRenderer();
    } catch (e) {
      console.error('[shell] 自测启动失败:', e.message);
      if (win && !win.isDestroyed()) {
        win.webContents.executeJavaScript(
          `alert(${JSON.stringify('自测启动失败:\n\n' + e.message)})`).catch(() => {});
      }
    }
  }
});

app.on('window-all-closed', async () => {
  await stopServer();
  app.quit();
});

// 确保子进程不会比外壳活得更久。
app.on('before-quit', () => {
  if (child) { try { child.kill(); } catch {} }
});
