// 真正把代理起起来,验证托管逻辑:启动 -> 应答 -> 停止 -> 干净收尾。
//
// 为什么需要它:代理以前是手工程序,"忘了启动"是最常见的故障来源。
// 现在外壳负责它的生死,所以"能不能起来、停不停得掉"必须可验证。
//
// 这里用一种不需要 Electron 的办法:预加载一个补丁脚本,它把 electron
// 换成一个桩,再把真正的 main.js require 进来,然后直接调内部函数。
// 跑的是真实的 spawn、真实的端口、真实的 HTTP。
//
// 用法:node tools/test_proxy_managed.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const LOG_DIR = path.join(REPO, 'logs');
const LEDGER = path.join(LOG_DIR, 'running-proxy-pid.json');
const TMP = path.join(REPO, '.proxy-test-tmp');
const PORT = 8092;
const BASE = `http://127.0.0.1:${PORT}`;

/** 端口上有没有东西在监听。 */
function probe(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    let done = false;
    const fin = (v) => { if (!done) { done = true; try { s.destroy(); } catch {} resolve(v); } };
    s.setTimeout(700);
    s.on('connect', () => fin(true));
    s.on('timeout', () => fin(false));
    s.on('error', () => fin(false));
  });
}

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};

fs.mkdirSync(TMP, { recursive: true });

// ---- 补丁:把 electron 换成桩,再加载 main.js,最后跑我们交代的脚本 ----
const patch = `
const Module = require('module');
const path = require('path');
const REPO = ${JSON.stringify(REPO)};
const fakeApp = { whenReady: () => Promise.resolve(), getPath: () => path.join(REPO,'logs'), on(){}, quit(){} };
const fakeWin = { setMenuBarVisibility(){}, loadFile(){}, on(){}, isDestroyed: () => true,
  webContents: { send(){}, isLoadingMainFrame: () => false, once(){} } };
const stub = { app: fakeApp, BrowserWindow: function(){ return fakeWin; },
  ipcMain: { handle(){} } };
const orig = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === 'electron') return stub;
  return orig.call(this, req, parent, isMain);
};
const m = require(path.join(REPO, 'src', 'main.js'));
const t = m.__test;
(async () => {
  const out = { steps: [] };
  const log = (k, v) => { out.steps.push([k, v]); };

  log('before', { ledger: t.proxyState.managed, node: t.findNodeExe() });

  // 防火墙自检:必须能在**不提权**的情况下跑通并给出结论。
  // 它决定界面上那行警告要不要出现,所以不能挂。
  let fw = null;
  try { fw = await t.firewallStatus(); } catch (e) { fw = { error: e.message }; }
  log('firewall', fw);

  const r1 = await t.startProxy();
  log('start', r1);

  // 代理起来了就应该能应答 /_bridge/status
  let status = null;
  try {
    const res = await fetch('${BASE}/_bridge/status', { signal: AbortSignal.timeout(5000) });
    status = { code: res.status, ok: res.ok, keys: Object.keys(await res.json()).sort() };
  } catch (e) { status = { error: e.message }; }
  log('status', status);

  log('stateAfterStart', { managed: t.proxyState.managed, external: t.proxyState.external,
    pid: t.proxyState.managed ? 'child' : null });

  // 幂等:再调一次不该起第二个
  const r2 = await t.startProxy();
  log('startAgain', r2);

  await t.stopProxy();
  await new Promise((r) => setTimeout(r, 900));

  // 停掉之后端口应该不再应答
  let after = null;
  try {
    const res = await fetch('${BASE}/_bridge/status', { signal: AbortSignal.timeout(2500) });
    after = { code: res.status };
  } catch (e) { after = { unreachable: true, code: e.cause ? e.cause.code : e.message }; }
  log('afterStop', after);

  process.stdout.write('@@RESULT@@' + JSON.stringify(out) + '@@END@@');
  process.exit(0);
})().catch((e) => {
  process.stdout.write('@@RESULT@@' + JSON.stringify({ error: e.message, stack: e.stack }) + '@@END@@');
  process.exit(1);
});
`;

const patchFile = path.join(TMP, 'patch.cjs');
fs.writeFileSync(patchFile, patch, 'utf8');

// 先清掉上次的台账,保证测试从"干净"状态开始
try { fs.unlinkSync(LEDGER); } catch {}

console.log('=== 代理托管:启动 / 应答 / 幂等 / 停止 ===');

// 前置条件:8092 必须是空的。
//
// 这不是洁癖 —— 上一轮的教训:测试进程退出后代理还活着(detached + unref
// 在 Windows 上并不能真正脱离),下一次测试就会把它"认领"成 external,
// 于是"我们真的启动了一个"这一点就没被验证到,测试会假装通过。
// 所以这里显式失败,让人先清掉残留。
if (await probe(PORT)) {
  console.log(`  ✗ 前置条件不满足:${PORT} 已被占用。`);
  console.log('    先停掉残留的代理(关掉 Model Stove,或 taskkill 那个 node),再跑本测试。');
  process.exit(1);
}
check(`${PORT} 起始为空闲`, true);

const outFile = path.join(TMP, 'out.log');
const fd = fs.openSync(outFile, 'w');
const p = spawn(process.execPath, [patchFile], {
  windowsHide: true,
  // 关掉外壳的代理自动启动。
  //
  // 不关的话,app.whenReady() 里的自动 startProxy() 会和下面的显式调用
  // 同时发生,于是第一次调用拿到的是 already:true —— 看着像通过,其实
  // "我们自己起的那个代理"根本没被验证到。实测就是这么被骗过一次。
  env: { ...process.env, MODEL_STOVE_NO_AUTO_PROXY: '1' },
  stdio: ['ignore', fd, fd],
});
fs.closeSync(fd);

const code = await new Promise((r) => p.on('exit', r));
const text = fs.readFileSync(outFile, 'utf8');
const m = text.match(/@@RESULT@@([\s\S]*?)@@END@@/);
if (!m) {
  check('补丁脚本产出结果', false);
  console.log('--- 原始输出 ---'); console.log(text.slice(-3000));
  process.exit(1);
}
const out = JSON.parse(m[1]);
if (out.error) { check('补丁脚本无异常', false, out.error); console.log(out.stack || ''); process.exit(1); }

const step = (k) => (out.steps.find((s) => s[0] === k) || [])[1];
const start = step('start');
const status = step('status');
const again = step('startAgain');
const after = step('afterStop');
const state = step('stateAfterStart');

check('startProxy 返回 ok', !!(start && start.ok), JSON.stringify(start));
check('是"这次真的启动了一个"而不是认领现成的', !!(start && start.started && !start.already && !start.external), JSON.stringify(start));
check('代理真的起来了(可被本外壳托管)', !!(state && state.managed));
check('/_bridge/status 返回 200', !!(status && status.code === 200), JSON.stringify(status));
check('/_bridge/status 含 profile/compression', !!(status && status.keys && status.keys.includes('profile') && status.keys.includes('compression')),
  status && status.keys ? status.keys.join(',') : '');
check('再次调用是幂等的', !!(again && again.ok), JSON.stringify(again));
check('停止后端口不再应答', !!(after && (after.unreachable || after.code === undefined || after.code >= 500)), JSON.stringify(after));

console.log('\n--- 防火墙自检(不提权)---');
const fw = step('firewall');
console.log('  ' + JSON.stringify(fw));
check('firewallStatus 跑得通', !!(fw && !fw.error), fw && fw.error ? fw.error : '');
check('自检同时覆盖 node 与 app', !!(fw && fw.node && fw.app), fw ? Object.keys(fw).join(',') : '');
// 判据必须是注册表:解析 netsh 的本地化文本曾在中文 Windows 上把"存在"
// 误判成"不存在",那正是错误结论的来源。
check('判据来自注册表', !!(fw && fw._source === 'registry'), fw ? `_source=${fw._source}` : '');
// 这两条规则是实际加过的,注册表里查得到;查不到说明判据又坏了。
check('node.exe 被识别为已放行', !!(fw && fw.node && fw.node.present), fw && fw.node ? `count=${fw.node.count}` : '');
check('electron.exe 被识别为已放行', !!(fw && fw.app && fw.app.present), fw && fw.app ? `count=${fw.app.count}` : '');

console.log('\n--- 台账 ---');
const ledgerRaw = (() => { try { return fs.readFileSync(LEDGER, 'utf8'); } catch { return '(无)'; } })();
console.log('  ' + ledgerRaw);
check('停止后台账已清空', ledgerRaw.trim() === '[]' || ledgerRaw === '(无)', ledgerRaw);

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

// 收尾:确认测试自己没留下进程。留了就报出来,免得污染下一轮。
if (await probe(PORT)) {
  check('测试未留下残留代理', false, `${PORT} 仍被占用 —— 会影响后续运行`);
} else {
  check('测试未留下残留代理', true);
}

console.log(failed === 0 ? '\n全部通过' : `\n有 ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
