// 验证代理往 llama.cpp Web UI 里注入的「档位面板」。
//
// 为什么需要注入:llama.cpp 的界面是预压缩的 Svelte 包(8.8 MB),改它要反编译
// 重建,而且上游一升级就白改。代理夹在浏览器和 llama-server 之间,在返回 HTML
// 时追加一小段自己的脚本最省事。手机端因此第一次有了切档位的入口 ——
// 在此之前,手机上完全没法改档位,只能跑到电脑上点。
//
// 要守住两件事:
//   1. HTML 里确实有面板(否则手机上还是没入口)
//   2. **其它响应一个字节都不能变**(注入只该动 HTML)——
//      这条尤其重要,因为代理刚因为资源相关的问题被怀疑过一次,
//      test_assets.mjs 已经证明它不改资源,这里再钉一遍。
//
// 用法:node tools/test_panel_inject.mjs
//   需要 8091 上有一个在跑的 llama-server(用 UPSTREAM 可指到别的端口)。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const REPO = path.resolve(import.meta.dirname, '..')
const TMP = path.join(REPO, '.panel-test')
const PORT = Number(process.env.STOVE_TEST_PORT || 8099)
const UPSTREAM = process.env.UPSTREAM || 'http://127.0.0.1:8091'

let failed = 0
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`)
  if (!ok) failed++
}

fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(TMP, { recursive: true })

console.log('=== 档位面板注入 ===')
console.log(`  上游: ${UPSTREAM}   测试代理端口: ${PORT}`)

// 上游必须活着,否则什么也验不了
try {
  const h = await fetch(`${UPSTREAM}/health`, { signal: AbortSignal.timeout(4000) })
  if (!h.ok) throw new Error('status ' + h.status)
} catch (e) {
  console.log(`  ✗ 上游不可用(${e.message})—— 先启动一个 llama-server,或用 UPSTREAM 指到别处`)
  process.exit(1)
}
check('上游可用', true)

const log = path.join(TMP, 'proxy.log')
const fd = fs.openSync(log, 'w')
const proxy = spawn(process.execPath, [path.join(REPO, 'context-proxy.mjs')], {
  cwd: REPO,
  windowsHide: true,
  env: { ...process.env, PROXY_PORT: String(PORT), UPSTREAM, PROXY_STATE_DIR: TMP },
  stdio: ['ignore', fd, fd],
})
fs.closeSync(fd)

let up = false
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 400))
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/_bridge/status`, { signal: AbortSignal.timeout(2000) })
    if (r.ok) { up = true; break }
  } catch { /* 还没起来 */ }
}
if (!up) {
  console.log('  ✗ 测试代理没起来')
  try { console.log(fs.readFileSync(log, 'utf8').slice(-800)) } catch {}
  proxy.kill()
  process.exit(1)
}
check('测试代理就绪', true)

try {
  // ---- 1. HTML 里要有面板 ----
  const r = await fetch(`http://127.0.0.1:${PORT}/`)
  const html = await r.text()
  check('/ 返回 HTML', r.headers.get('content-type', '').includes('text/html'),
    r.headers.get('content-type') || '(无 content-type)')
  check('面板容器存在', html.includes('id="stove-panel"'))
  check('面板样式存在', html.includes('id="stove-style"'))
  check('有档位文案', html.includes('任务档位'))
  check('面板会查询档位', html.includes('/_bridge/status'))
  check('面板会切换档位', html.includes('/_bridge/config'))
  check('注入在 </body> 之前', html.indexOf('stove-panel') < html.lastIndexOf('</body>'))
  check('没有叠加两份', (html.match(/id="stove-panel"/g) || []).length === 1)

  // 注入之后 content-length 必须被丢掉(长度变了,不能沿用上游的值)
  check('没有沿用上游的 content-length', !r.headers.get('content-length'),
    r.headers.get('content-length') || '(已丢弃,由 Node 重新计算)')

  // ---- 2. 其它响应一个字节都不能变 ----
  const assets = ['/manifest.webmanifest', '/_app/immutable/assets/bundle.CsYLz1sd.css']
  for (const a of assets) {
    let ua = null, ub = null
    try {
      ua = Buffer.from(await (await fetch(`http://127.0.0.1:${PORT}${a}`)).arrayBuffer())
    } catch { /* 下面报 */ }
    try {
      ub = Buffer.from(await (await fetch(`${UPSTREAM}${a}`)).arrayBuffer())
    } catch { /* 下面报 */ }
    if (!ub || !ub.length) {
      // 上游没有这个资源(版本不同),跳过而不是误报
      console.log(`  - ${a} 上游没有,跳过`)
      continue
    }
    check(`${a} 逐字节一致`, !!ua && ua.equals(ub), ua ? `${ua.length} vs ${ub.length}` : '取不到')
  }
} finally {
  proxy.kill()
  await new Promise((r) => setTimeout(r, 600))
  fs.rmSync(TMP, { recursive: true, force: true })
}

console.log(failed === 0 ? '\n全部通过' : `\n有 ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
