// 通过 GitHub REST Git Data API 推送,只用 api.github.com。
//
// 为什么不用 git push:
//   1. 本机的 git 与 PowerShell 都走 schannel,向 GitHub 发 HTTPS 一律失败
//      (SEC_E_NO_CREDENTIALS)。
//   2. 即便绕开 schannel,github.com:443(receive-pack 上传端点所在域名)在
//      这条网络上经常整体不可达,而 api.github.com 与 codeload.github.com 正常。
// 所以走 REST:建 blob -> 建 tree -> 建 commit -> 更新 ref,全程只用 API。
//
// 已知偏差:GitHub 组装提交对象时会把正文的结尾换行规范化掉,因此生成的
// commit sha 与本地的**必然**不同(本地用 git hash-object 验证过:git 的规范
// 格式要求正文恰以一个 \n 结尾)。内容由 verifyTree 逐文件自检保证正确,
// sha 差异只影响后续推送的增量效率,不影响仓库内容。
//
// 需要 GH_TOKEN。用法:node tools/push_api.mjs [分支]
import { spawn } from 'node:child_process'
import { openSync, closeSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const OWNER = '1iuTL'
const REPO = 'model-stove'
const BRANCH = process.argv[2] || 'main'
const SRC = 'C:\\deepseek harness\\model-stove'
const TMP = `${SRC}\\.api-push-tmp`

const token = process.env.GH_TOKEN
if (!token) { console.error('缺少 GH_TOKEN 环境变量'); process.exit(2) }

const BASE = `https://api.github.com/repos/${OWNER}/${REPO}`
const H = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'model-stove-push',
  'Content-Type': 'application/json',
}

rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })

// ------------------------------------------------------------------ git

function run(argv, { stdoutFile } = {}) {
  return new Promise((resolve, reject) => {
    let fd = null
    if (stdoutFile) fd = openSync(stdoutFile, 'w')
    const p = spawn(argv[0], argv.slice(1), {
      cwd: SRC,
      stdio: ['ignore', fd === null ? 'ignore' : fd, 'ignore'],
    })
    p.on('error', reject)
    p.on('close', () => { if (fd !== null) { try { closeSync(fd) } catch { /* 已关 */ } } resolve(0) })
  })
}

/** 跑一条 git 命令并取回 stdout 文本(去尾空白)。 */
async function git(args, tag) {
  const o = `${TMP}\\${tag}.o`
  await run(['git', ...args], { stdoutFile: o })
  return readFileSync(o, 'utf8').trim()
}

/** 取某个路径在某个提交里的 tree sha;不存在返回 null。 */
async function treeShaOf(commit, relPath) {
  const spec = relPath ? `${commit}:${relPath}` : `${commit}^{tree}`
  const v = await git(['rev-parse', spec], 'ts')
  return /^[0-9a-f]{40}$/.test(v) ? v : null
}

// ------------------------------------------------------------------ API

async function api(method, path, body, attempts = 4) {
  let lastErr = null
  for (let i = 1; i <= attempts; i++) {
    try {
      const r = await fetch(`${BASE}${path}`, {
        method,
        headers: H,
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const text = await r.text()
      let json = null
      try { json = JSON.parse(text) } catch { /* 非 JSON 响应 */ }
      // 5xx 值得重试;4xx 是请求本身的问题,重试没用。
      if (r.status >= 500 && i < attempts) {
        console.log(`    HTTP ${r.status},${i * 2} 秒后重试 ...`)
        await sleep(2000 * i)
        continue
      }
      return { status: r.status, json, text }
    } catch (e) {
      lastErr = e
      const cause = e && e.cause ? (e.cause.code || e.cause.message) : e.message
      console.log(`    网络失败 ${cause},${i * 2} 秒后重试 ...`)
      if (i < attempts) await sleep(2000 * i)
    }
  }
  throw lastErr
}

// ------------------------------------------------------------------ tree 构建

let blobCount = 0
let treeCount = 0
let reuseCount = 0
let blobCacheHits = 0

// blob 的磁盘缓存:本地 blob sha -> 远程 blob sha。
//
// 为什么放在磁盘上而不是内存里:这条网络不稳定,推送可能中途超时。
// 缓存落盘后重跑就能跳过已上传的内容,不必从头再来一遍(实测全量重传
// 会直接把一次推送拖过 5 分钟)。文件在 .gitignore 里。
const CACHE_DIR = `${SRC}\\.api-push-cache`
if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true })

function cacheGet(localSha) {
  try {
    const v = readFileSync(`${CACHE_DIR}\\${localSha}`, 'utf8').trim()
    return /^[0-9a-f]{40}$/.test(v) ? v : null
  } catch { return null }
}
function cacheSet(localSha, remoteSha) {
  try { writeFileSync(`${CACHE_DIR}\\${localSha}`, remoteSha, 'utf8') } catch { /* 缓存失败不影响推送 */ }
}

/**
 * 递归建好一个目录的 tree,返回它的 sha。
 *
 * 两级复用,都是为了少发请求:
 *   1. 本地这个目录在该提交里的 tree sha,如果远程已经有同名 tree
 *      (tree sha 由内容唯一决定),整棵直接复用,零请求。
 *   2. 如果父提交里同一路径的 tree sha 与它相同,说明这个目录没变,
 *      同样直接复用。
 * 都命中不了才逐条构建;构建时也只传本目录的直接条目,子目录递归处理。
 */
async function ensureTree(commit, relPath, remoteKnown, parentCommit) {
  const localSha = await treeShaOf(commit, relPath)
  if (localSha && remoteKnown.has(localSha)) {
    reuseCount++
    return localSha
  }
  // 与父提交同路径比较:相同即未改动
  if (localSha && parentCommit) {
    const parentSha = await treeShaOf(parentCommit, relPath)
    if (parentSha && parentSha === localSha) {
      reuseCount++
      remoteKnown.add(localSha)
      return localSha
    }
  }

  // 列出该目录的**直接**子项 —— 不能带 -r。
  //
  // 这里踩了个反直觉的坑:`-r` 会把子目录**递归展开成其中的 blob**,
  // 于是输出里再也看不到 tree 条目,建出来的树就丢了整层子目录
  // (实测:根目录只剩 7 个文件,src/ 与 tools/ 全没了,而 commit sha
  // 对不上却看不出原因)。
  // 不带 -r 时输出正好是直接子项,且天然区分 blob 与 tree。
  const o = `${TMP}\\ls-${(relPath || 'root').replace(/[\\/]/g, '_')}.o`
  await run(['git', 'ls-tree', '-z', commit, '--', relPath || '.'], { stdoutFile: o })
  const entries = readFileSync(o, 'utf8').split('\x00').filter(Boolean)

  const treeEntries = []
  for (const e of entries) {
    const tab = e.indexOf('\t')
    const [mode, type, sha] = e.slice(0, tab).split(' ')
    // 非递归输出里,tab 之后就是相对仓库根的完整路径
    const full = e.slice(tab + 1)
    if (!full) continue
    const name = relPath ? full.slice(relPath.length + 1) : full

    if (type === 'commit') {
      treeEntries.push({ path: name, mode: '160000', type: 'commit', sha })
      continue
    }
    if (type === 'tree') {
      const sub = await ensureTree(commit, full, remoteKnown, parentCommit)
      treeEntries.push({ path: name, mode, type: 'tree', sha: sub })
      continue
    }

    // blob:先查缓存;未命中再上传,然后记进缓存。
    const cached = cacheGet(sha)
    if (cached) {
      blobCacheHits++
      treeEntries.push({ path: name, mode, type: 'blob', sha: cached })
      continue
    }
    const blobFile = `${TMP}\\blob.bin`
    await run(['git', 'cat-file', 'blob', sha], { stdoutFile: blobFile })
    const buf = readFileSync(blobFile)
    const b = await api('POST', '/git/blobs', { content: buf.toString('base64'), encoding: 'base64' })
    if (b.status !== 201) throw new Error(`建 blob 失败 (${name}) HTTP ${b.status}: ${b.text.slice(0, 200)}`)
    blobCount++
    cacheSet(sha, b.json.sha)
    treeEntries.push({ path: name, mode, type: 'blob', sha: b.json.sha })
  }

  if (!treeEntries.length) {
    throw new Error(`目录 ${relPath || '/'} 没有列出任何条目 —— ls-tree 参数有问题`)
  }

  console.log(`    [建 tree] ${relPath || '/'}  条目 ${treeEntries.length} 个: ${treeEntries.map((x) => x.path + '(' + x.type[0] + ')').join(' ')}`)

  const t = await api('POST', '/git/trees', { tree: treeEntries })
  if (t.status !== 201) {
    const dump = `${TMP}\\tree-fail.json`
    writeFileSync(dump, JSON.stringify({ dir: relPath || '/', response: t.text, entries: treeEntries }, null, 2), 'utf8')
    throw new Error(`建 tree 失败 (${relPath || '/'}) HTTP ${t.status},详情见 ${dump}`)
  }
  treeCount++
  // 记进已知集合:同一提交内若有相同内容的目录,可直接复用。
  if (localSha) remoteKnown.add(localSha)
  return t.json.sha
}

// ------------------------------------------------------------------ 自检

/**
 * 把刚建好的 tree 递归拉回来,与本地 `ls-tree -r` 逐文件比对。
 *
 * 为什么要这一步:建 tree 的逻辑一旦漏掉子目录内容,推送会"成功"但内容残缺,
 * 而且 commit sha 对不上,极难定位(实际踩过:src/ 与 tools/ 整层丢失,
 * 根目录看着却完全正常)。提交前花几个请求验一遍,比事后从 sha 反推便宜得多。
 */
async function verifyTree(treeSha, localCommit) {
  const remote = new Map()
  async function walk(sha, prefix) {
    const r = await api('GET', `/git/trees/${sha}`)
    if (r.status !== 200) throw new Error(`自检读取 tree 失败 HTTP ${r.status}`)
    for (const e of r.json.tree) {
      const p = prefix ? `${prefix}/${e.path}` : e.path
      if (e.type === 'tree') await walk(e.sha, p)
      else remote.set(p, e.sha)
    }
  }
  await walk(treeSha, '')

  const o = `${TMP}\\selfcheck.o`
  await run(['git', 'ls-tree', '-r', '-z', localCommit], { stdoutFile: o })
  const local = new Map()
  for (const e of readFileSync(o, 'utf8').split('\x00').filter(Boolean)) {
    const tab = e.indexOf('\t')
    local.set(e.slice(tab + 1), e.slice(0, tab).split(' ')[2])
  }

  const problems = []
  for (const [p, s] of local) {
    if (!remote.has(p)) problems.push(`漏掉 ${p}`)
    else if (remote.get(p) !== s) problems.push(`内容不符 ${p}`)
  }
  for (const p of remote.keys()) if (!local.has(p)) problems.push(`多出 ${p}`)

  return { localCount: local.size, remoteCount: remote.size, problems }
}

// ------------------------------------------------------------------ 主流程

console.log(`仓库: ${OWNER}/${REPO}   分支: ${BRANCH}`)

const ref = await api('GET', `/git/ref/heads/${BRANCH}`)
if (ref.status !== 200) {
  console.error(`读 ref 失败 HTTP ${ref.status}: ${ref.text.slice(0, 200)}`)
  process.exit(1)
}
const remoteSha = ref.json.object.sha
const headSha = await git(['rev-parse', 'HEAD'], 'head')
console.log(`远程 ${BRANCH}: ${remoteSha.slice(0, 7)}`)
console.log(`本地 HEAD : ${headSha.slice(0, 7)}`)

if (remoteSha === headSha) {
  console.log('已是最新,无需推送。')
  rmSync(TMP, { recursive: true, force: true })
  process.exit(0)
}

// 远程提交必须存在于本地对象库,否则算不出增量
const kind = await git(['cat-file', '-t', remoteSha], 'kind')
if (kind !== 'commit') {
  console.error('远程提交不在本地对象库中,无法做增量推送。')
  process.exit(1)
}

const commits = (await git(['rev-list', '--reverse', `${remoteSha}..HEAD`], 'list'))
  .split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
console.log(`待推送 ${commits.length} 个提交`)

// 远程已有的 tree 集合,用于整棵复用。tree sha 由内容决定,所以远程提交的
// tree 一定在远程。
const remoteKnown = new Set()
{
  const t = await git(['rev-parse', `${remoteSha}^{tree}`], 'rt')
  if (/^[0-9a-f]{40}$/.test(t)) remoteKnown.add(t)
}

let parent = remoteSha
for (const sha of commits) {
  const msg = await git(['log', '-1', '--format=%B', sha], 'msg')
  const an = await git(['log', '-1', '--format=%an', sha], 'an')
  const ae = await git(['log', '-1', '--format=%ae', sha], 'ae')
  const ad = await git(['log', '-1', '--format=%aI', sha], 'ad')

  console.log(`\n${sha.slice(0, 7)}  ${msg.split('\n')[0]}`)

  const treeSha = await ensureTree(sha, '', remoteKnown, parent)

  const chk = await verifyTree(treeSha, sha)
  if (chk.problems.length) {
    console.log(`  !! 自检不通过:本地 ${chk.localCount} 个文件 / 远程 ${chk.remoteCount} 个`)
    chk.problems.slice(0, 12).forEach((p) => console.log(`     ${p}`))
    if (chk.problems.length > 12) console.log(`     ...另有 ${chk.problems.length - 12} 条`)
    throw new Error(`tree 内容不完整 (${sha.slice(0, 7)}),已中止,未更新 ref`)
  }
  console.log(`  自检通过:${chk.localCount} 个文件全部一致`)

  // 正文保证恰以一个 \n 结尾(git 规范格式)。GitHub 仍会规范化掉它,
  // 导致 sha 不同,但至少传过去的是规范形式。
  const cleanMsg = msg.replace(/\n+$/, '') + '\n'
  const c = await api('POST', '/git/commits', {
    message: cleanMsg,
    tree: treeSha,
    parents: [parent],
    author: { name: an, email: ae, date: ad },
    committer: { name: an, email: ae, date: ad },
  })
  if (c.status !== 201) throw new Error(`建 commit 失败 HTTP ${c.status}: ${c.text.slice(0, 300)}`)

  if (c.json.sha === sha) {
    console.log(`  -> ${c.json.sha.slice(0, 7)}  与本地一致`)
  } else {
    console.log(`  -> ${c.json.sha.slice(0, 7)}  与本地 ${sha.slice(0, 7)} 不同(GitHub 规范化正文结尾换行所致)`)
  }
  console.log(`     上传 blob ${blobCount} / 新建 tree ${treeCount} / 复用 tree ${reuseCount}`)
  parent = c.json.sha
}

console.log(`\n更新 refs/heads/${BRANCH} -> ${parent.slice(0, 7)}`)
const up = await api('PATCH', `/git/refs/heads/${BRANCH}`, { sha: parent, force: true })
if (up.status !== 200) {
  console.error(`更新 ref 失败 HTTP ${up.status}: ${up.text.slice(0, 300)}`)
  rmSync(TMP, { recursive: true, force: true })
  process.exit(1)
}

// 校验:远程最终指向哪里,内容是否与本地 HEAD 一致
const after = await api('GET', `/git/ref/heads/${BRANCH}`)
const now = after.status === 200 ? after.json.object.sha : null
console.log(`\n远程 ${BRANCH} = ${now ? now.slice(0, 7) : '?'}`)

let contentOk = false
if (now) {
  const cRes = await api('GET', `/git/commits/${now}`)
  const finalChk = await verifyTree(cRes.json.tree.sha, headSha)
  contentOk = finalChk.problems.length === 0
  console.log(contentOk
    ? `内容校验通过:${finalChk.localCount} 个文件与本地 HEAD 完全一致 —— 推送成功`
    : `!! 内容校验未通过(${finalChk.problems.length} 处差异)`)
  finalChk.problems.slice(0, 8).forEach((p) => console.log(`     ${p}`))
}
console.log(`统计: 上传 blob ${blobCount} 个(缓存命中 ${blobCacheHits} 个),新建 tree ${treeCount} 个,复用 tree ${reuseCount} 个`)

rmSync(TMP, { recursive: true, force: true })
process.exit(contentOk ? 0 : 1)
