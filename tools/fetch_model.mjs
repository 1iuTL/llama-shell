// 分段并发下载器(带断点续传)。
//
// 为什么不用一次拉完:这条网络不稳定,6.67 GB 单连接一旦中断就白费。
// 切成小块逐个下载并落盘,中断后重跑只补缺失的块。
//
// 用法:node tools/fetch_model.mjs <url> <输出文件> [块大小MB]
import { openSync, closeSync, writeSync, readSync, readFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const url = process.argv[2]
const outFile = process.argv[3]
const CHUNK_MB = Number(process.argv[4] || 8)
if (!url || !outFile) {
  console.error('用法: node tools/fetch_model.mjs <url> <输出文件> [块大小MB]')
  process.exit(2)
}

const partDir = `${outFile}.parts`
if (!existsSync(partDir)) mkdirSync(partDir, { recursive: true })
const CHUNK = CHUNK_MB * 1024 * 1024

/** 带超时与停滞检测的 fetch。卡住时中止并抛错,交给上层重试。 */
async function fetchWithStall(url, init, timeoutMs = 120000, stallMs = 45000) {
  const ac = new AbortController()
  let last = Date.now()
  const timer = setInterval(() => {
    if (Date.now() - last > stallMs) ac.abort(new Error('传输停滞'))
  }, 5000)
  const hard = setTimeout(() => ac.abort(new Error('超时')), timeoutMs)
  try {
    const r = await fetch(url, { ...init, signal: ac.signal })
    // 手动读流以便更新 last
    if (!r.body) { last = Date.now(); return { status: r.status, headers: r.headers, buf: Buffer.from(await r.arrayBuffer()) } }
    const chunks = []
    const reader = r.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      last = Date.now()
      chunks.push(Buffer.from(value))
    }
    return { status: r.status, headers: r.headers, buf: Buffer.concat(chunks) }
  } finally {
    clearInterval(timer)
    clearTimeout(hard)
  }
}

// 1. 解析直链
console.log('解析下载地址 ...')
const head = await fetch(url, { method: 'GET', redirect: 'manual', headers: { 'User-Agent': 'model-stove' }, signal: AbortSignal.timeout(30000) })
let target = url
if (head.status >= 300 && head.status < 400) {
  target = head.headers.get('location')
  console.log(`  重定向 -> ${target.slice(0, 70)}...`)
} else if (head.status === 200) {
  console.log('  200,直链')
} else {
  console.error(`  意外状态 HTTP ${head.status}`)
  process.exit(1)
}

// 2. 探尺寸
const probe = await fetch(target, { headers: { 'User-Agent': 'model-stove', Range: 'bytes=0-0' }, signal: AbortSignal.timeout(30000) })
const cr = probe.headers.get('content-range')
const total = cr ? Number(cr.split('/')[1]) : Number(probe.headers.get('content-length'))
console.log(`  文件大小: ${total} 字节 (${(total / 1024 / 1024 / 1024).toFixed(2)} GiB)`)
if (!Number.isFinite(total) || total <= 0) { console.error('  取不到大小'); process.exit(1) }

const nChunks = Math.ceil(total / CHUNK)
console.log(`  切分为 ${nChunks} 块 × ${CHUNK_MB} MB,并发 6\n`)

// 3. 逐块下载(已存在的跳过)
let done = 0
let reused = 0
const t0 = Date.now()

async function getChunk(i, attempt = 1) {
  const start = i * CHUNK
  const end = Math.min(start + CHUNK, total) - 1
  const partFile = `${partDir}\\${String(i).padStart(5, '0')}.part`
  const want = end - start + 1

  if (existsSync(partFile) && statSync(partFile).size === want) {
    reused++
    done++
    return
  }

  try {
    const r = await fetchWithStall(target, {
      headers: { 'User-Agent': 'model-stove', Range: `bytes=${start}-${end}` },
    })
    if (r.status !== 206 && r.status !== 200) throw new Error(`HTTP ${r.status}`)
    if (r.buf.length !== want) throw new Error(`字节数不符: 期望 ${want} 实得 ${r.buf.length}`)
    const fd = openSync(partFile, 'w')
    try { writeSync(fd, r.buf) } finally { closeSync(fd) }
    done++
    const pct = ((done / nChunks) * 100).toFixed(1)
    const mb = (done * CHUNK_MB)
    const secs = (Date.now() - t0) / 1000
    const rate = secs > 0 ? (mb / secs).toFixed(1) : '?'
    if (done % 5 === 0 || done === nChunks) {
      console.log(`  进度 ${done}/${nChunks} (${pct}%)  约 ${mb} MB  平均 ${rate} MB/s`)
    }
  } catch (e) {
    const msg = e.cause ? e.cause.message || e.cause.code : e.message
    if (attempt < 5) {
      await sleep(2000 * attempt)
      return getChunk(i, attempt + 1)   // 失败重试,不放弃整块
    }
    throw new Error(`块 ${i} 下载失败(${attempt} 次): ${msg}`)
  }
}

// 并发调度
let next = 0
async function worker() {
  for (;;) {
    const i = next++
    if (i >= nChunks) return
    await getChunk(i)
  }
}
await Promise.all(new Array(6).fill(0).map(worker))

console.log(`\n全部块就绪(其中 ${reused} 块是续传复用)。开始合并 ...`)

// 4. 合并
const out = openSync(outFile, 'w')
let written = 0
for (let i = 0; i < nChunks; i++) {
  const partFile = `${partDir}\\${String(i).padStart(5, '0')}.part`
  const buf = readFileSync(partFile)
  writeSync(out, buf)
  written += buf.length
}
closeSync(out)

console.log(`  合并完成: ${written} 字节 -> ${outFile}`)
if (written !== total) {
  console.error(`  !! 大小不符: 期望 ${total}`)
  process.exit(1)
}

// 5. 校验文件头
const fd = openSync(outFile, 'r')
const magic = Buffer.alloc(4)
readSync(fd, magic, 0, 4, 0)
closeSync(fd)
const ok = magic.toString('ascii') === 'GGUF'
console.log(`  文件头: ${JSON.stringify(magic.toString('ascii'))} ${ok ? '✓' : '✗'}`)

if (ok) {
  rmSync(partDir, { recursive: true, force: true })
  console.log(`  已清理分块目录。用时 ${((Date.now() - t0) / 60000).toFixed(1)} 分钟。`)
}
