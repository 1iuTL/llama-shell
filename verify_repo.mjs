const base = "https://api.github.com/repos/1iuTL/llama-shell";
const r = await fetch(base, { headers: { "User-Agent": "dsh" } });
if (!r.ok) { console.log("HTTP", r.status); process.exit(1); }
const j = await r.json();
console.log(`仓库   : ${j.full_name}`);
console.log(`可见性 : ${j.private ? "private" : "public"}`);
console.log(`分支   : ${j.default_branch}`);
console.log(`地址   : ${j.html_url}`);
console.log(`描述   : ${j.description}`);
const c = await fetch(base + "/contents/", { headers: { "User-Agent": "dsh" } });
const files = await c.json();
console.log("\n根目录内容:");
for (const f of files) console.log(`  ${f.type === "dir" ? "[dir] " : "      "}${f.name}`);
const src = await (await fetch(base + "/contents/src", { headers: { "User-Agent": "dsh" } })).json();
console.log("\nsrc/ 内容:");
for (const f of src) console.log(`  ${(f.size/1024).toFixed(1).padStart(7)} KB  ${f.name}`);
