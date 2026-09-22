// llama-shell -- a minimal Electron shell around llama-server.
//
// Responsibilities:
//   1. pick a model + preset
//   2. spawn the right llama-server build with the right flags
//   3. wait until /health answers 200
//   4. load the server's own Web UI in the main pane
//   5. kill the child cleanly on stop/switch/quit
//
// The chat UI itself is llama.cpp's built-in one; this shell only manages it.
const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const { MODELS, PRESETS, buildArgs } = require('./config');

const PORT = 8091;
const BASE = `http://127.0.0.1:${PORT}`;

let win = null;
let child = null;
let current = { modelId: null, preset: null, startedAt: null };
let logFile = null;

// The child's output goes to a file rather than a pipe on purpose.
// Piped stdio (Node's default) opens an anonymous pipe; some sandboxes refuse
// that, and a failing pipe takes the whole Electron main process down with a
// native null-pointer crash. Redirection has neither problem, and we can still
// tail the file for the log pane.
const LOG_DIR = path.join(__dirname, '..', 'logs');

// ---------------------------------------------------------------- utilities

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

// ------------------------------------------------------------------ process

function stopServer() {
  return new Promise((resolve) => {
    if (!child) { current = { modelId: null, preset: null, startedAt: null }; return resolve(); }
    const dying = child;
    child = null;
    try {
      dying.kill();
    } catch { /* already gone */ }
    const done = () => { current = { modelId: null, preset: null, startedAt: null }; resolve(); };
    // Escalate to a hard kill if it lingers.
    const t = setTimeout(() => { try { dying.kill('SIGKILL'); } catch {} ; done(); }, 8000);
    dying.once('exit', () => { clearTimeout(t); done(); });
  });
}

async function startServer(modelId, presetKey) {
  await stopServer();

  const model = MODELS.find((m) => m.id === modelId);
  if (!model) throw new Error(`未知模型: ${modelId}`);
  if (!modelExists(model)) throw new Error(`模型文件不存在:\n${model.file}`);
  if (!binExists(model)) throw new Error(`llama-server 不存在:\n${model.bin}`);

  const args = buildArgs(model, presetKey, PORT);

  fs.mkdirSync(LOG_DIR, { recursive: true });
  logFile = path.join(LOG_DIR, `shell-${modelId}.log`);
  const banner = `[shell] ${new Date().toISOString()}\n[shell] ${model.bin}\n[shell] ${args.join(' ')}\n`;
  fs.writeFileSync(logFile, banner, 'utf8');
  const out = fs.openSync(logFile, 'a');

  // detached: the child outlives a crashed shell rather than being torn down
  // with it. stdio goes to a file, never a pipe.
  child = spawn(model.bin, args, {
    windowsHide: true,
    detached: true,
    stdio: ['ignore', out, out],
  });
  current = { modelId, preset: presetKey, startedAt: Date.now() };

  // The child has its own handles now; holding ours would leak one fd per start.
  try { fs.closeSync(out); } catch {}
  try { child.unref(); } catch {}

  child.on('error', (err) => {
    try { fs.appendFileSync(logFile, `[shell] spawn error: ${err.message}\n`); } catch {}
  });

  child.on('exit', (code) => {
    try { fs.appendFileSync(logFile, `[shell] server exited with code ${code}\n`); } catch {}
    if (child) { child = null; current = { modelId: null, preset: null, startedAt: null }; }
    notifyRenderer();
  });

  const ok = await waitForHealth();
  if (!ok) {
    const tail = readLogTail(14).join('\n');
    await stopServer();
    throw new Error(`服务启动失败或超时。日志末尾:\n${tail}`);
  }
  try { fs.appendFileSync(logFile, '[shell] server ready\n'); } catch {}
  return { url: `${BASE}/`, modelId, preset: presetKey };
}

// -------------------------------------------------------------------- render

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
    title: 'llama-shell',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,      // the right pane is a <webview> onto llama-server
      spellcheck: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'index.html'));
  win.on('closed', () => { win = null; });
}

// ----------------------------------------------------------------------- IPC

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
  port: PORT,
}));

ipcMain.handle('start', async (_e, { modelId, preset }) => {
  try {
    const r = await startServer(modelId, preset);
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
    ctx,
    uptimeSec: current.startedAt ? Math.floor((Date.now() - current.startedAt) / 1000) : 0,
    url: health.ok ? `${BASE}/` : null,
  };
});

ipcMain.handle('logs', () => readLogTail(250));

// ---------------------------------------------------------------- lifecycle

app.whenReady().then(async () => {
  createWindow();

  // Self-test hook: LLAMA_SHELL_AUTOSTART="<modelId>:<preset>" boots a server
  // immediately on launch. Used to verify the spawn -> health -> UI chain
  // without clicking anything; harmless when the variable is unset.
  const auto = process.env.LLAMA_SHELL_AUTOSTART;
  if (auto) {
    const [modelId, preset] = auto.split(':');
    // Wait for the window to finish loading so the renderer exists before we
    // start emitting state changes.
    try {
      await new Promise((r) => {
        if (!win || win.webContents.isLoadingMainFrame()) {
          win.webContents.once('did-finish-load', r);
        } else r();
      });
    } catch {}
    console.log('[shell] autostart', modelId, preset);
    try {
      await startServer(modelId, preset);
      console.log('[shell] autostart OK');
      notifyRenderer();
    } catch (e) {
      console.error('[shell] autostart FAILED:', e.message);
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

// Make sure the child never outlives the shell.
app.on('before-quit', () => {
  if (child) { try { child.kill(); } catch {} }
});
