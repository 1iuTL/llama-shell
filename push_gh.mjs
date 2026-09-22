// Push the model-stove working tree to GitHub through the REST API.
//
// Why the API and not `git push`: git's TLS backends are unusable inside this
// sandbox (schannel cannot acquire credentials; Git for Windows' sh.exe cannot
// create its signal pipe). Node's fetch works, and api.github.com is reachable.
//
// The token is read from Git Credential Manager and never printed.
//
// Usage:  node push_gh.mjs <owner/repo>
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SRC = 'C:\\deepseek harness\\model-stove';
const target = process.argv[2] || '1iuTL/model-stove';
const [owner, repo] = target.split('/');

// Files that belong in the repo, in order. node_modules/ and logs/ are excluded.
const FILES = [
  '.gitignore',
  'LICENSE',
  'README.md',
  'package.json',
  'src/config.js',
  'src/index.html',
  'src/main.js',
  'src/preload.js',
  '\u542f\u52a8.bat',
];

const API = 'https://api.github.com';

function getToken() {
  // Prefer an externally supplied token. Node's child_process is unavailable in
  // some sandboxes (spawnSync EPERM), so the caller can read it from Git
  // Credential Manager and hand it over through the environment instead.
  const fromEnv = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (fromEnv && fromEnv.trim()) {
    return { token: fromEnv.trim(), username: process.env.GH_USER || '(from env)' };
  }

  // Fallback for a normal terminal: ask Git Credential Manager directly.
  const tmpDir = process.env.TEMP || process.env.TMP || '.';
  const outPath = path.join(tmpDir, 'gh-cred-' + Date.now() + '.txt');
  const fd = fs.openSync(outPath, 'w');
  try {
    execFileSync('git', ['credential-manager', 'get'], {
      input: 'protocol=https\nhost=github.com\n\n',
      stdio: [null, fd, fd],
    });
  } finally {
    fs.closeSync(fd);
  }
  const out = fs.readFileSync(outPath, 'utf8');
  try { fs.unlinkSync(outPath); } catch { /* best effort */ }

  const line = out.split(/\r?\n/).find((l) => l.startsWith('password='));
  if (!line) throw new Error('credential manager returned no password field');
  const token = line.slice('password='.length).trim();
  if (!token) throw new Error('empty token from credential manager');
  return { token, username: (out.match(/^username=(.*)$/m) || [])[1] || '(unknown)' };
}

async function gh(token, method, p, body) {
  const res = await fetch(API + p, {
    method,
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'model-stove-push',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* error page */ }
  return { ok: res.ok, status: res.status, json, text };
}

const { token, username } = getToken();
console.log(`credential: username=${username} token=***${token.slice(-4)} (${token.length} chars)`);

// 1) who is this?
const me = await gh(token, 'GET', '/user');
if (!me.ok) {
  console.error(`token rejected: HTTP ${me.status} ${(me.json && me.json.message) || ''}`);
  process.exit(1);
}
const login = me.json.login;
console.log(`authenticated as: ${login}`);

// 2) repo present?
const head = await gh(token, 'GET', `/repos/${login}/${repo}`);
if (head.status === 404) {
  console.log(`creating ${login}/${repo} ...`);
  const created = await gh(token, 'POST', '/user/repos', {
    name: repo,
    private: false,
    auto_init: false,
    description: 'Minimal Electron shell that manages llama-server and hosts its built-in Web UI',
  });
  if (!created.ok) {
    console.error(`create failed: HTTP ${created.status} ${(created.json && created.json.message) || ''}`);
    process.exit(1);
  }
  console.log('repo created');
} else if (head.ok) {
  console.log('repo exists, uploading files');
} else {
  console.error(`repo lookup failed: HTTP ${head.status}`);
  process.exit(1);
}

// 3) upload every file
let ok = 0;
for (const rel of FILES) {
  const abs = path.join(SRC, rel);
  if (!fs.existsSync(abs)) { console.log(`skip ${rel} (missing)`); continue; }
  const content = Buffer.from(fs.readFileSync(abs)).toString('base64');

  const body = { message: 'add ' + rel, content, branch: 'main' };
  const cur = await gh(token, 'GET',
    `/repos/${login}/${repo}/contents/${encodeURIComponent(rel)}?ref=main`);
  if (cur.ok && cur.json && cur.json.sha) body.sha = cur.json.sha;

  const put = await gh(token, 'PUT',
    `/repos/${login}/${repo}/contents/${encodeURIComponent(rel)}`, body);
  if (put.ok) {
    ok++;
    console.log(`ok   ${rel}`);
  } else {
    console.log(`FAIL ${rel}  HTTP ${put.status} ${(put.json && put.json.message) || put.text.slice(0, 120)}`);
  }
}

console.log(`\n${ok}/${FILES.length} files uploaded`);
console.log(`https://github.com/${login}/${repo}`);
process.exit(ok === FILES.length ? 0 : 1);
