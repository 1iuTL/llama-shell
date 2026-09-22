import urllib.request, gzip, re, sys, time
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
url = "http://127.0.0.1:8091/_app/immutable/bundle.Bc971Did.js"
req = urllib.request.Request(url, headers={"Accept-Encoding": "gzip"})
t0 = time.time()
r = urllib.request.urlopen(req, timeout=120)
raw = r.read()
if r.headers.get("Content-Encoding") == "gzip":
    raw = gzip.decompress(raw)
js = raw.decode("utf-8", "replace")
print(f"bundle: HTTP {r.status}  解压后 {len(js)/1048576:.1f} MB  耗时 {time.time()-t0:.1f}s")
print()
print("国际化 / 本地化线索:")
for kw in ["i18n", "locale", "gettext", "translation", "zh-CN", "\\u4e00", "language"]:
    n = len(re.findall(re.escape(kw), js, re.I))
    print(f"  {kw:14} 出现 {n} 次")
print()
# 找 UI 里已知的英文界面词,确认能否靠文本替换做汉化
probes = ["Import/Export", "Save settings", "Reset to default", "Type a message",
          "New chat", "System Message", "Sampling", "Developer", "General", "Display"]
print("界面文案是否硬编码在 bundle 里(用于判断能否文本替换):")
for p in probes:
    n = js.count(p)
    print(f"  {p:20} {n} 处")
