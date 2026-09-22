// GitHub Discussions 没有 REST 端点,先把页面正文抽出来
const url = "https://github.com/ggml-org/llama.cpp/discussions/19032";
try {
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  console.log("HTTP", r.status);
  let t = await r.text();
  t = t.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
  t = t.replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
       .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
       .replace(/\s+/g, " ").trim();
  const i = t.indexOf("WebUI localization");
  console.log(i >= 0 ? t.slice(i, i + 2500) : t.slice(0, 2500));
} catch (e) { console.log("FAIL", e.message); }
