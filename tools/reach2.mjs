const targets = [
  ["GitHub API",      "https://api.github.com"],
  ["GitHub 主站",      "https://github.com"],
  ["Gitee 码云",       "https://gitee.com"],
  ["GitCode",         "https://gitcode.com"],
  ["GitCode API",     "https://api.gitcode.com"],
  ["Cloudflare Pages","https://pages.cloudflare.com"],
  ["Vercel",          "https://vercel.com"],
  ["npm registry",    "https://registry.npmjs.org"],
  ["npmmirror",       "https://registry.npmmirror.com"],
  ["gh-proxy.com",    "https://gh-proxy.com"],
  ["hf-mirror",       "https://hf-mirror.com"],
  ["ModelScope",      "https://www.modelscope.cn"],
];
for (const [name, url] of targets) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 12000);
  const t0 = Date.now();
  try {
    const r = await fetch(url, { redirect: "manual", signal: ac.signal });
    console.log(`OK    ${name.padEnd(18)} HTTP ${r.status}  ${Date.now()-t0}ms`);
  } catch (e) {
    console.log(`FAIL  ${name.padEnd(18)} ${e.name}: ${String(e.message).slice(0,60)}`);
  } finally { clearTimeout(t); }
}
