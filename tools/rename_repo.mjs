// 把仓库改名并补齐描述 / 主页 / 标签。
// GitHub 的改名接口会自动为旧地址保留重定向。
//
// 用法:  node tools/rename_repo.mjs [owner/repo] [newName]
import fs from 'node:fs';

const target = process.argv[2] || '1iuTL/llama-shell';
const newName = process.argv[3] || 'model-stove';
const [owner, repo] = target.split('/');

const token = (process.env.GH_TOKEN || '').trim();
if (!token) {
  console.error('缺少 GH_TOKEN 环境变量');
  process.exit(1);
}

const API = 'https://api.github.com';

async function gh(method, p, body) {
  const res = await fetch(API + p, {
    method,
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'model-stove',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { ok: res.ok, status: res.status, json, text };
}

// 1) 改名
console.log(`改名前: ${owner}/${repo}`);
const ren = await gh('PATCH', `/repos/${owner}/${repo}`, { name: newName });
if (!ren.ok) {
  console.error(`改名失败 HTTP ${ren.status}: ${(ren.json && ren.json.message) || ren.text.slice(0, 200)}`);
  process.exit(1);
}
console.log(`改名后: ${ren.json.full_name}`);

// 2) 描述 / 主页 / 标签
// 描述是这轮的关键:仓库名不表意,靠它说明用途。
const patch = {
  description: 'Model Stove (模型灶台) — 本地模型启动器:管理 llama-server 的极简 Electron 图形外壳',
  homepage: '',
};
const upd = await gh('PATCH', `/repos/${owner}/${newName}`, patch);
console.log(upd.ok ? '描述已更新' : `描述更新失败 HTTP ${upd.status}`);

// 3) 标签(搜索命中的关键)
const topics = ['llama-cpp', 'llama-server', 'gguf', 'local-llm', 'electron', 'desktop-app', 'windows'];
const top = await gh('PUT', `/repos/${owner}/${newName}/topics`, { names: topics });
console.log(top.ok ? '标签已设置: ' + topics.join(', ') : `标签设置失败 HTTP ${top.status}`);

// 4) 确认
const fin = await gh('GET', `/repos/${owner}/${newName}`);
if (fin.ok) {
  const j = fin.json;
  console.log('');
  console.log('仓库   : ' + j.full_name);
  console.log('地址   : ' + j.html_url);
  console.log('描述   : ' + (j.description || '(空)'));
  console.log('标签   : ' + ((j.topics || []).join(', ') || '(无)'));
  console.log('可见性 : ' + (j.private ? 'private' : 'public'));
}

// 5) 顺手把本地 remote 指向新地址
const localGit = 'C:\\deepseek harness\\model-stove\\.git';
if (fs.existsSync(localGit)) {
  console.log('');
  console.log('本地 remote 请手动更新为: https://github.com/' + owner + '/' + newName + '.git');
}
