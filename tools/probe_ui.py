import urllib.request, gzip, re, json, sys
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

def get(path, want_text=False):
    req = urllib.request.Request("http://127.0.0.1:8091" + path,
          headers={"Accept": "*/*", "Accept-Encoding": "gzip"})
    r = urllib.request.urlopen(req, timeout=25)
    raw = r.read()
    if r.headers.get("Content-Encoding") == "gzip":
        raw = gzip.decompress(raw)
    return r.status, (raw.decode("utf-8", "replace") if want_text else raw)

# HTML 里找语言/国际化痕迹
st, html = get("/", True)
print("HTML:", st, len(html), "字节")
for kw in ["i18n", "locale", "lang", "translat", "zh-", "chinese"]:
    hits = len(re.findall(kw, html, re.I))
    print(f"  '{kw}' 出现 {hits} 次")

# 找 JS bundle 名
m = re.findall(r'href="[^"]*bundle[^"]*\.js"', html)
print("  bundle 引用:", m[:3])
