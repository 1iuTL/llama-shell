// 收尾验证:给足预算后,Q1_0 能否完整答完而不塌缩?
//
// 上一轮把 max_tokens 卡在 512,Q1_0 的中文长回答被硬截断,而我的判定只看
// "有没有 content",于是误判成失败。从失败样本看,Q1_0 的文本里斜杠占比是 0%,
// 而 PTQ1_0 / Heretic 是 51-93% —— 两者性质完全不同。
//
// 本轮:max_tokens 给到 3000,比较三种模型在**同一问题**上能否收敛。
import { spawn } from 'node:child_process'
import { openSync, closeSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const SRC = 'C:\\deepseek harness\\model-stove'
const TMP = `${SRC}\\.repro7-tmp`
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })

const PORT = 8099
const PROMPT = '解释反射定律'
const MAX_TOKENS = 3000

const MODELS = [
  {
    name: 'Q1_0',
    bin: 'C:\\deepseek harness\\models\\llama-cpp\\llama-server.exe',
    file: 'D:\\Bonsai-27B-Q1_0.gguf',
  },
  {
    name: 'PTQ1_0三元',
    bin: 'C:\\deepseek harness\\llama-cpp-mmq\\build\\bin\\llama-server.exe',
    file: 'D:\\Ternary-Bonsai-2-27B-PTQ1_0.gguf',
  },
  {
    name: 'Heretic',
    bin: 'C:\\deepseek harness\\llama-cpp-mmq\\build\\bin\\llama-server.exe',
    file: 'D:\\Ternary-Bonsai-2-27B-Heretic-PTQ1_0.gguf',
  },
]

function analyse(text) {
  const chars = [...(text || '')]
  let run = 0, longest = 0
  for (const c of chars) {
    if (c === '/' || c === '\\') { run++; if (run > longest) longest = run }
    else run = 0
  }
  return { len: chars.length, longest }
}

async function startServer(m) {
  const args = [
    '-m', m.file, '-c', '32768', '-ngl', '99', '-fa', 'on', '-np', '1',
    '-ctk', 'q4_0', '-ctv', 'q4_0', '--jinja',
    '--temp', '0.7', '--top-p', '0.95', '--top-k', '20',
    '--host', '127.0.0.1', '--port', String(PORT), '--no-slots',
    '--reasoning-budget', '32768',
  ]
  const out = openSync(`${TMP}\\${m.name}.log`, 'w')
  const child = spawn(m.bin, args, { stdio: ['ignore', out, out], detached: false, windowsHide: true })
  closeSync(out)
  for (let i = 0; i < 200; i++) {
    await sleep(1000)
    try { const r = await fetch(`http://127.0.0.1:${PORT}/health`); if (r.status === 200) return child } catch {}
  }
  child.kill()
  throw new Error(`${m.name} 未就绪`)
}

console.log(`问题: ${PROMPT}   max_tokens=${MAX_TOKENS}\n`)

for (const m of MODELS) {
  console.log('='.repeat(72))
  console.log(m.name)
  console.log('='.repeat(72))
  let child = null
  try {
    child = await startServer(m)
    const t0 = Date.now()
    const res = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'local', messages: [{ role: 'user', content: PROMPT }],
        max_tokens: MAX_TOKENS, stream: false,
      }),
    })
    const j = await res.json()
    const msg = j.choices?.[0]?.message || {}
    const r = analyse(msg.reasoning_content)
    const c = analyse(msg.content)
    const finish = j.choices?.[0]?.finish_reason
    const secs = ((Date.now() - t0) / 1000).toFixed(1)

    writeFileSync(`${TMP}\\${m.name}-reasoning.txt`, msg.reasoning_content || '', 'utf8')
    writeFileSync(`${TMP}\\${m.name}-content.txt`, msg.content || '', 'utf8')

    console.log(`  耗时 ${secs}s   completion=${j.usage?.completion_tokens ?? '?'}   finish_reason=${finish}`)
    console.log(`  reasoning ${r.len} 字 (最长连续重复 ${r.longest})`)
    console.log(`  content   ${c.len} 字 (最长连续重复 ${c.longest})`)
    const ok = c.len > 0 && c.longest < 50 && r.longest < 50
    console.log(`  判定: ${ok ? '✓ 完整收敛,无塌缩' : '✗ 仍有问题'}`)
    console.log(`  content 前 260 字:`)
    console.log('    ' + (msg.content || '(空)').slice(0, 260).replace(/\n/g, '\n    '))
    console.log('')
  } catch (e) {
    console.log(`  失败: ${e.message}`)
  } finally {
    if (child) { try { child.kill() } catch {} }
    await sleep(4000)
  }
}
console.log(`完整原文留在 ${TMP}`)
