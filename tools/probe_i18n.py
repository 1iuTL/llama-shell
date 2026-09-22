import urllib.request, gzip, re, sys
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
req = urllib.request.Request("http://127.0.0.1:8091/_app/immutable/bundle.Bc971Did.js",
      headers={"Accept-Encoding": "gzip"})
r = urllib.request.urlopen(req, timeout=120)
raw = r.read()
if r.headers.get("Content-Encoding") == "gzip":
    raw = gzip.decompress(raw)
js = raw.decode("utf-8", "replace")

print("=== 1) 语言相关标识符 ===")
for pat in [r'locales?\s*[:=]\s*\[[^\]]{0,200}\]',
            r'locale\s*[:=]\s*[\'"][a-zA-Z-]{2,10}[\'"]',
            r'navigator\.language[^;]{0,60}',
            r'getLocale\(\)[^;]{0,80}',
            r'setLocale\([^)]{0,60}\)']:
    for m in re.finditer(pat, js)  :
        print("  " + m.group(0)[:150].replace("\n", " "))
    print("  ---")

print()
print("=== 2) 是否存在语言包/词典注册 ===")
for kw in ["dictionary", "dictionaries", "messages", "addMessages", "registerLocale",
           "en-US", "en_US", "availableLocales", "supportedLocales", "fallbackLocale"]:
    print(f"  {kw:20} {js.count(kw)} 次")

print()
print("=== 3) 那两个中日韩字符是什么 ===")
for m in re.finditer(r'[\u4e00-\u9fff\u3040-\u30ff]{1,20}', js):
    s = js[max(0, m.start()-60):m.end()+60].replace("\n", " ")
    print("  ..." + s + "...")
