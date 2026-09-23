// 退化复现:直接看服务端返回的原始 reasoning_content,判断斜杠是不是模型真输出。
//
// 为什么要绕开 UI:截图里看到的斜杠有两种可能 ——
//   (a) 模型真的在输出 '/'
//   (b) 前端把"仍在生成"渲染成了斜纹进度条
// 只有拿到服务端原始 JSON 才能分辨。这是整个问题的分水岭。
//
// 参数矩阵(一次只变一个变量):
//   1. 预算 32768 + 提示语   ← 你 23:18 那次的配置
//   2. 预算 32768,无提示语   ← 去掉我加的注入文本
//   3. 完全不加预算          ← 回到 llama-server 默认(不限)
//
// 每个组合都问同一个能触发思考的简单问题,记录:
//   生成 token 数、耗时、reasoning 里 '\' 的占比、是否收敛出答案
//
// 用法:node tools/repro_degeneration.mjs
import { spawn } from 'node:child_process'
import { openSync, closeSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const SRC = 'C:\\deepseek harness\\model-stove'
const BIN = 'C:\\deepseek harness\\llama-cpp-mmq\\build\\bin\\llama-server.exe'
const MODEL = 'D:\\Ternary-Bonsai-2-27B-PTQ1_0.gguf'
const PORT = 8099
const TMP = `${SRC}\\.repro-tmp`
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })

const PROMPT = '1+1等于几'

// 三个组合,一次只差一个变量
const CASES = [
  {
    name: '预算32768 + 提示语(你出问题那次的配置)',
    budget: 32768,
    budgetMessage: '思考预算已用完,请立即基于已有分析给出最终答案。',
  },
  {
    name: '预算32768,无提示语',
    budget: 32768,
    budgetMessage: null,
  },
  {
    name: '完全不加预算(服务默认不限)',
    budget: null,
    budgetMessage: null,
  },
]

function baseArgs() {
  return [
    '-m', MODEL,
    '-c', '65536', '-ngl', '99', '-fa', 'on', '-np', '1',
    '-ctk', 'q4_0', '-ctv', 'q4_0', '--jinja',
    '--temp', '1.0', '--top-p', '0.95', '--top-k', '20',
    '--host', '127.0.0.1', '--port', String(PORT),
    '--no-slots',
  ]
}

async function startServer(args, logName) {
  const log = `${TMP}\\${logName}.log`
  const out = openSync(log, 'w')
  const child = spawn(BIN, args, { stdio: ['ignore', out, out], detached: false, windowsHide: true })
  closeSync(out)
  // 等就绪
  for (let i = 0; i < 180; i++) {
    await sleep(1000)
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`)
      if (r.status === 200) return child
    } catch { /* 还没起来 */ }
  }
  child.kill()
  throw new Error(`服务在 180 秒内没就绪,见 ${log}`)
}

function analyse(text) {
  if (!text) return { len: 0, slashes: 0, slashRatio: 0, longestRun: 0 }
  const chars = [...text]
  let slashes = 0
  let run = 0
  let longest = 0
  for (const c of chars) {
    if (c === '/' || c === '\\') {
      slashes++
      run++
      if (run > longest) longest = run
    } else run = 0
  }
  return {
    len: chars.length,
    slashes,
    slashRatio: chars.length ? slashes / chars.length : 0,
    longestRun: longest,
  }
}

const results = []

for (const c of CASES) {
  const args = baseArgs()
  if (c.budget != null) {
    args.push('--reasoning-budget', String(c.budget))
    if (c.budgetMessage) args.push('--reasoning-budget-message', c.budgetMessage)
  }

  console.log(`\n${'='.repeat(64)}`)
  console.log(c.name)
  console.log('='.repeat(64))

  let child = null
  try {
    child = await startServer(args, `case-${results.length}`)
    console.log('  服务就绪,发请求(最多生成 1024 token)...')

    const t0 = Date.now()
    const res = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'local',
        messages: [{ role: 'user', content: PROMPT }],
        max_tokens: 1024,
        stream: false,
      }),
    })
    const json = await res.json()
    const ms = Date.now() - t0

    const msg = json.choices?.[0]?.message || {}
    const reasoning = msg.reasoning_content || ''
    const content = msg.content || ''
    const usage = json.usage || {}

    const rStat = analyse(reasoning)
    const cStat = analyse(content)

    console.log(`  HTTP ${res.status}   耗时 ${(ms / 1000).toFixed(1)}s`)
    console.log(`  usage: completion=${usage.completion_tokens ?? '?'} prompt=${usage.prompt_tokens ?? '?'}`)
    console.log(`  reasoning_content: ${rStat.len} 字符,斜杠 ${rStat.slashes} 个(${(rStat.slashRatio * 100).toFixed(1)}%),最长连续 ${rStat.longestRun}`)
    console.log(`  content          : ${cStat.len} 字符,斜杠 ${cStat.slashes} 个`)
    console.log(`  reasoning 开头 200 字: ${JSON.stringify(reasoning.slice(0, 200))}`)
    console.log(`  reasoning 结尾 120 字: ${JSON.stringify(reasoning.slice(-120))}`)
    console.log(`  content 全文        : ${JSON.stringify(content.slice(0, 300))}`)

    writeFileSync(`${TMP}\\case-${results.length}-reasoning.txt`, reasoning, 'utf8')
    writeFileSync(`${TMP}\\case-${results.length}-raw.json`, JSON.stringify(json, null, 2), 'utf8')

    results.push({ case: c.name, ok: res.status === 200, ms, usage, rStat, cStat, content: content.slice(0, 200) })
  } catch (e) {
    console.log(`  失败: ${e.message}`)
    results.push({ case: c.name, ok: false, error: e.message })
  } finally {
    if (child) { try { child.kill() } catch { /* 已退出 */ } }
    await sleep(4000)   // 等显存释放
  }
}

// ------------------------------------------------------------------ 汇总

console.log(`\n${'='.repeat(64)}`)
console.log('汇总')
console.log('='.repeat(64))
console.log('组合'.padEnd(36) + 'completion  reasoning 斜杠占比  最长连续  有答案')
for (const r of results) {
  if (!r.ok) { console.log(r.case.padEnd(36) + '失败: ' + (r.error || '').slice(0, 40)); continue }
  const hasAnswer = (r.content || '').trim().length > 0 ? '是' : '否'
  console.log(
    r.case.padEnd(36) +
    String(r.usage.completion_tokens ?? '?').padStart(6) + '    ' +
    String(r.rStat.len).padStart(8) + '  ' +
    ((r.rStat.slashRatio * 100).toFixed(1) + '%').padStart(9) + '  ' +
    String(r.rStat.longestRun).padStart(8) + '  ' +
    hasAnswer
  )
}

console.log(`\n原始输出已存到 ${TMP}\\,可逐字核对。`)
console.log('这次不自动清理临时目录,方便你自己看。')
