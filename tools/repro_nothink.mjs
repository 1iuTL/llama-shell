// 关掉思考后,PTQ1_0 还能用吗?
//
// 动机:所有塌缩都发生在 reasoning_content 里,content 反而干净
// (实测 reasoning 99% 斜杠时 content 长度恰好为 0 —— 说明它是在
//  *思考阶段*崩的)。既然塌缩只出现在思考路径,关掉思考或许就能用。
//
// 这对用户有实际意义:三个去审查版(Heretic / Abliterated)都是 PTQ1_0,
// 如果关思考可用,它们就不必报废。
//
// 关思考的方式:--reasoning off(服务级),以及请求里带 chat_template_kwargs
// 开 enable_thinking=false —— 两种都测。
import { spawn } from 'node:child_process'
import { openSync, closeSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const SRC = 'C:\\deepseek harness\\model-stove'
const BIN = 'C:\\deepseek harness\\llama-cpp-mmq\\build\\bin\\llama-server.exe'
const MODEL = 'D:\\Ternary-Bonsai-2-27B-Heretic-PTQ1_0.gguf'   // 去审查版,PTQ1_0
const PORT = 8099
const TMP = `${SRC}\\.repro5-tmp`
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })

const PROMPT = '1+1等于几'

function analyse(text) {
  const chars = [...(text || '')]
  let slashes = 0, run = 0, longest = 0
  for (const c of chars) {
    if (c === '/' || c === '\\') { slashes++; run++; if (run > longest) longest = run }
    else run = 0
  }
  return { len: chars.length, slashes, longest }
}

async function startServer(extraArgs, logName) {
  const args = [
    '-m', MODEL, '-c', '32768', '-ngl', '99', '-fa', 'on', '-np', '1',
    '-ctk', 'q4_0', '-ctv', 'q4_0', '--jinja',
    '--temp', '1.0', '--top-p', '0.95', '--top-k', '20',
    '--host', '127.0.0.1', '--port', String(PORT), '--no-slots',
    ...extraArgs,
  ]
  const out = openSync(`${TMP}\\${logName}.log`, 'w')
  const child = spawn(BIN, args, { stdio: ['ignore', out, out], detached: false, windowsHide: true })
  closeSync(out)
  for (let i = 0; i < 180; i++) {
    await sleep(1000)
    try { const r = await fetch(`http://127.0.0.1:${PORT}/health`); if (r.status === 200) return child } catch {}
  }
  child.kill()
  throw new Error(`${logName} 未就绪`)
}

async function ask(bodyExtra, tag) {
  const res = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'local',
      messages: [{ role: 'user', content: PROMPT }],
      max_tokens: 512,
      stream: false,
      ...bodyExtra,
    }),
  })
  const j = await res.json()
  const m = j.choices?.[0]?.message || {}
  const r = analyse(m.reasoning_content)
  const c = analyse(m.content)
  writeFileSync(`${TMP}\\${tag}.txt`,
    `reasoning:\n${m.reasoning_content || '(空)'}\n\ncontent:\n${m.content || '(空)'}\n`, 'utf8')
  return { r, c, usage: j.usage, content: m.content || '', reasoning: m.reasoning_content || '' }
}

// 三种配置各跑 2 次:服务级关思考 / 请求级关思考 / 默认(对照)
const CONFIGS = [
  { name: '服务级 --reasoning off', args: ['--reasoning', 'off'], body: {} },
  { name: '请求级 enable_thinking=false', args: [], body: { chat_template_kwargs: { enable_thinking: false } } },
  { name: '默认(对照,应会塌缩)', args: [], body: {} },
]

console.log(`模型: Heretic-PTQ1_0   提示词: ${JSON.stringify(PROMPT)}\n`)
const summary = []

for (const cfg of CONFIGS) {
  console.log('='.repeat(66))
  console.log(cfg.name)
  console.log('='.repeat(66))
  let child = null
  const rows = []
  try {
    child = await startServer(cfg.args, cfg.name.replace(/[^a-z0-9]/gi, '_'))
    for (let t = 1; t <= 2; t++) {
      try {
        const { r, c, usage, content, reasoning } = await ask(cfg.body, `${cfg.name}-${t}`.replace(/[^a-z0-9]/gi, '_'))
        const answered = content.trim().length > 0 && c.longest < 50
        rows.push({ answered })
        console.log(`  #${t}: completion=${String(usage?.completion_tokens ?? '?').padStart(4)}  ` +
          `reasoning ${String(r.len).padStart(4)}字(斜杠${String(r.slashes).padStart(4)}, 最长连续${String(r.longest).padStart(4)})  ` +
          `content ${String(c.len).padStart(4)}字  ${answered ? '有答案' : '退化'}`)
        console.log(`       content: ${JSON.stringify(content.slice(0, 90))}`)
        if (reasoning) console.log(`       reasoning 开头: ${JSON.stringify(reasoning.slice(0, 70))}`)
      } catch (e) {
        console.log(`  #${t}: 失败 ${e.message}`)
        rows.push({ answered: false })
      }
      await sleep(400)
    }
  } catch (e) {
    console.log(`  启动失败: ${e.message}`)
  } finally {
    if (child) { try { child.kill() } catch {} }
    await sleep(4000)
  }
  summary.push({ name: cfg.name, trials: rows.length, ok: rows.filter((x) => x.answered).length })
}

console.log(`\n${'='.repeat(66)}`)
console.log('汇总')
console.log('='.repeat(66))
console.log('配置'.padEnd(34) + '次数  有答案')
for (const s of summary) console.log(s.name.padEnd(34) + String(s.trials).padStart(4) + String(s.ok).padStart(7))
console.log(`\n原文留在 ${TMP}`)
