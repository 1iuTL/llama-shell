// 通过 GitHub 的 git smart 协议推送,完全绕开 git 的 HTTPS 传输。
//
// 为什么不直接 `git push`:这台机器上 git 与 PowerShell 都走 schannel,
// 向 GitHub 发 HTTPS 一律报 `schannel: AcquireCredentialsHandle failed:
// SEC_E_NO_CREDENTIALS (0x8009030e)`。而 Node 自带 OpenSSL,不碰 schannel,
// 实测 fetch 到 api.github.com 与 github.com 都是 200。
//
// 做法:
//   1. git pack-objects 从源仓库打出 pack(对象按普通文件写)
//   2. 按 receive-pack 协议拼一个 pkt-line 请求体:
//         <len><old-sha> <new-sha> <ref>\0<caps>
//         0000
//         <PACK 二进制>
//   3. Node fetch POST 到 /git-receive-pack,解析 report-status 回包
//
// pkt-line 的长度是 **4 位十六进制,含这 4 字节自身**。
// token 从 GH_TOKEN 环境变量读(不用管道问 credential-manager —— 沙箱禁止命名管道)。
import { spawn } from 'node:child_process'
import { openSync, closeSync, mkdirSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs'

const OWNER = '1iuTL'
const REPO = 'model-stove'
const BRANCH = process.argv[2] || 'main'
const SRC = process.argv[3] || 'C:\\deepseek harness\\model-stove'
const TMP = `${SRC}\\.push-tmp`

const token = process.env.GH_TOKEN
if (!token) { console.error('缺少 GH_TOKEN 环境变量'); process.exit(2) }

mkdirSync(TMP, { recursive: true })

/** 跑命令,stdin/stdout/stderr 用文件描述符(不用管道)。 */
function run(argv, { cwd, stdinFile, stdoutFile, stderrFile } = {}) {
  return new Promise((resolve, reject) => {
    const fds = []
    const pick = (file, mode, fallback) => {
      if (!file) return fallback
      const fd = openSync(file, mode)
      fds.push(fd)
      return fd
    }
    const opts = {
      cwd,
      stdio: [
        pick(stdinFile, 'r', 'ignore'),
        pick(stdoutFile, 'w', 'ignore'),
        pick(stderrFile, 'w', 'ignore'),
      ],
    }
    const p = spawn(argv[0], argv.slice(1), opts)
    p.on('error', (e) => { fds.forEach((f) => { try { closeSync(f) } catch {} }); reject(e) })
    p.on('close', (code) => {
      fds.forEach((f) => { try { closeSync(f) } catch {} })
      resolve(code ?? 0)
    })
  })
}

async function capture(argv, cwd, tag) {
  const out = `${TMP}\\${tag}.out`
  const err = `${TMP}\\${tag}.err`
  const code = await run(argv, { cwd, stdoutFile: out, stderrFile: err })
  return { code, stdout: readFileSync(out, 'utf8'), stderr: readFileSync(err, 'utf8') }
}

// ---------------------------------------------------------------- pkt-line

/** 组装一个 pkt-line 帧。长度必须包含那 4 个长度字节自身。 */
function pktLine(payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8')
  const len = body.length + 4
  if (len > 0xffff) throw new Error('pkt-line 超过 65519 字节')
  const header = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii')
  return Buffer.concat([header, body])
}
const FLUSH = Buffer.from('0000', 'ascii')

/**
 * 解析回包里的 pkt-line,返回文本行。
 *
 * 协商了 side-band-64k 之后,每条消息的 payload 前面会多一个**通道字节**:
 *   1 = 正常数据,2 = 进度信息,3 = 致命错误。
 * 不剥掉它,`unpack ok` 这类判定就会匹配失败(踩过一次 —— 明明推成功了
 * 却报失败)。
 */
function parsePktLines(buf) {
  const lines = []
  let i = 0
  while (i + 4 <= buf.length) {
    const len = parseInt(buf.slice(i, i + 4).toString('ascii'), 16)
    if (Number.isNaN(len)) break
    if (len === 0) { i += 4; continue }
    if (len < 4) break
    let payload = buf.slice(i + 4, i + len)
    // 剥掉带内通道字节(1/2/3),它不属于文本内容
    if (payload.length > 0 && payload[0] >= 1 && payload[0] <= 3) {
      payload = payload.slice(1)
    }
    lines.push(payload.toString('utf8'))
    i += len
  }
  return lines
}

// ---------------------------------------------------------------- 1. pack

const head = (await capture(['git', 'rev-parse', 'HEAD'], SRC, 'head')).stdout.trim()
console.log(`源 HEAD: ${head.slice(0, 7)}`)

// 用 GitHub API 先问远程 ref,决定是否需要干净的全量推送
async function api(path) {
  const r = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'model-stove-push',
    },
  })
  const text = await r.text()
  let body = null
  try { body = JSON.parse(text) } catch { body = text }
  return { status: r.status, body }
}

const refInfo = await api(`/git/ref/heads/${BRANCH}`)
const oldSha = refInfo.status === 200 ? refInfo.body.object.sha : '0'.repeat(40)
console.log(`远程 ${BRANCH}: ${oldSha === '0'.repeat(40) ? '(不存在,将创建)' : oldSha.slice(0, 7)}`)

if (oldSha === head) {
  console.log('远程已是最新,无需推送。')
  rmSync(TMP, { recursive: true, force: true })
  process.exit(0)
}

console.log('打包中 ...')
const packPrefix = `${TMP}\\pack`
const packPath = `${TMP}\\push.pack`
{
  // pack-objects 把 pack 写到 <prefix>-<hash>.pack,并把文件名打到 stdout
  const nameOut = await capture(
    ['git', 'pack-objects', packPrefix, '--all', '--revs'],
    SRC,
    'packname',
  )
  const name = nameOut.stdout.trim()
  if (!name) {
    console.error('pack-objects 没有输出文件名,stderr:', nameOut.stderr.slice(0, 400))
    process.exit(1)
  }
  const built = `${packPrefix}-${name}.pack`
  const size = statSync(built).size
  console.log(`pack: ${name}  ${(size / 1024).toFixed(1)} KB`)
  writeFileSync(packPath, readFileSync(built))
}

// ---------------------------------------------------------------- 2. 请求体

const caps = 'report-status side-band-64k object-format=sha1 agent=model-stove'
const command = `${oldSha} ${head} refs/heads/${BRANCH}\0 ${caps}\n`
const body = Buffer.concat([
  pktLine(command),
  FLUSH,
  readFileSync(packPath),
])

console.log(`请求体: ${(body.length / 1024).toFixed(1)} KB`)

// ---------------------------------------------------------------- 3. 上传

console.log('上传中 ...')
const url = `https://github.com/${OWNER}/${REPO}.git/git-receive-pack`
const auth = Buffer.from(`${OWNER}:${token}`, 'utf8').toString('base64')

const res = await fetch(url, {
  method: 'POST',
  headers: {
    Authorization: `Basic ${auth}`,
    'Content-Type': 'application/x-git-receive-pack-request',
    Accept: 'application/x-git-receive-pack-result',
    'Content-Length': String(body.length),
    'User-Agent': 'git/2.55.0',
  },
  body,
})

console.log(`HTTP ${res.status} ${res.headers.get('content-type') || ''}`)
const resBuf = Buffer.from(await res.arrayBuffer())
const lines = parsePktLines(resBuf)
if (lines.length) {
  console.log('--- 服务端回包 ---')
  lines.forEach((l) => console.log('  ' + l.replace(/\n$/, '')))
} else {
  console.log('--- 原始回包(前 600 字节)---')
  console.log(resBuf.slice(0, 600).toString('utf8'))
}

// 校验:unpack ok,且目标 ref 回报的状态不是 ng。
const statusLine = lines.find((l) => l.startsWith('unpack ')) || ''
const refLine = lines.find((l) => l.includes('refs/heads/')) || ''
const unpackOk = /^unpack ok/.test(statusLine.replace(/\n$/, ''))
const refNg = /(^|\s)ng\s/.test(refLine)
const ok = res.status === 200 && unpackOk && !refNg && refLine.length > 0

if (ok) {
  const after = await api(`/git/ref/heads/${BRANCH}`)
  const now = after.status === 200 ? after.body.object.sha : '?'
  console.log(`\n推送成功。远程 ${BRANCH} = ${now.slice(0, 7)}${now === head ? '  (与本地一致)' : '  !! 与本地不一致'}`)
} else {
  console.log('\n推送未成功,请检查上面的回包。')
}

rmSync(TMP, { recursive: true, force: true })
process.exit(ok ? 0 : 1)
