// 往 llama.cpp 自带的 Web UI 里注入一个「档位」面板。
//
// 为什么需要注入而不是改 llama.cpp 的界面:那个界面是**预压缩的 Svelte 包**
// (8.8 MB),改它需要反编译和重建,而且一升级 llama.cpp 就白改。代理正好夹在
// 浏览器和 llama-server 之间,可以在**返回 HTML 时**追加一小段自己的脚本 ——
// 只有一个文件、不碰上游代码、上游换版本也不受影响。
//
// 为什么必须放在 HTML 里而不是别处:因为要做到"点一下立刻生效"就得有交互界面,
// 而交互界面必须在页面里。
//
// 面板做三件事:
//   1. 切档位(通用 / 推理 / 写作 / 代码)—— 手机端原本完全没法切
//   2. 显示当前档位与思考开关状态(原来只有电脑端的 Model Stove 能看到)
//   3. 开关自动压缩
//
// 请求走代理自己的 /_bridge 接口,所以不带 API Key 也能用。

export const PANEL_HTML = `<div id="stove-panel" class="stove-collapsed">
  <button id="stove-toggle" type="button" title="任务档位">档位</button>
  <div id="stove-body">
    <div class="stove-h">任务档位 <span id="stove-dot"></span></div>
    <div id="stove-list"></div>
    <div id="stove-note"></div>
    <label class="stove-opt"><input type="checkbox" id="stove-compress" /> 自动压缩上下文</label>
  </div>
</div>`

export const PANEL_CSS = `
#stove-panel{position:fixed;right:14px;bottom:14px;z-index:2147483000;
  font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#e6edf3}
#stove-panel *{box-sizing:border-box}
#stove-toggle{background:#1f6feb;color:#fff;border:0;border-radius:999px;
  padding:9px 15px;font:600 13px/1 system-ui,sans-serif;cursor:pointer;
  box-shadow:0 3px 12px rgba(0,0,0,.4)}
#stove-body{display:none;width:236px;margin-bottom:8px;background:#161b22;
  border:1px solid #30363d;border-radius:11px;padding:11px;
  box-shadow:0 6px 24px rgba(0,0,0,.5);max-height:64vh;overflow:auto}
#stove-panel.stove-open #stove-body{display:block}
.stove-h{font-weight:600;font-size:12px;color:#8b949e;margin-bottom:8px;
  display:flex;align-items:center;gap:6px}
#stove-dot{width:7px;height:7px;border-radius:50%;background:#8b949e;display:inline-block}
#stove-dot.on{background:#3fb950;box-shadow:0 0 6px #3fb950}
#stove-dot.err{background:#f85149}
#stove-list button{display:block;width:100%;text-align:left;margin-bottom:5px;
  background:#21262d;color:#e6edf3;border:1px solid #30363d;border-radius:7px;
  padding:7px 9px;cursor:pointer;font:inherit}
#stove-list button:hover{border-color:#58a6ff}
#stove-list button.sel{background:#1f6feb;border-color:#1f6feb;color:#fff}
#stove-list .d{display:block;font-size:11px;opacity:.75;margin-top:2px}
#stove-note{font-size:11px;color:#8b949e;margin:6px 0}
.stove-opt{display:flex;align-items:center;gap:6px;font-size:12px;
  color:#c9d1d9;cursor:pointer;padding-top:7px;border-top:1px solid #30363d}
`

export const PANEL_JS = `
(function () {
  if (window.__stovePanelLoaded) return;
  window.__stovePanelLoaded = true;
  var $ = function (id) { return document.getElementById(id); };

  function render(s) {
    var dot = $('stove-dot');
    var list = $('stove-list');
    var note = $('stove-note');
    if (!s || !s.profile) {
      dot.className = 'err';
      note.textContent = '连不上档位代理';
      return;
    }
    dot.className = 'on';
    list.innerHTML = '';
    var avail = s.profile.available || [];
    for (var i = 0; i < avail.length; i++) {
      (function (p) {
        var b = document.createElement('button');
        b.type = 'button';
        if (p.key === s.profile.current) b.className = 'sel';
        var t = document.createElement('span');
        t.textContent = p.label;
        var d = document.createElement('span');
        d.className = 'd';
        d.textContent = p.hint || '';
        b.appendChild(t); b.appendChild(d);
        b.onclick = function () { setProfile(p.key); };
        list.appendChild(b);
      })(avail[i]);
    }
    var th = s.profile.thinking ? '思考开' : '思考关';
    note.textContent = s.profile.label + ' · ' + th +
      (s.context && s.context.nCtx ? ' · 上下文 ' + s.context.nCtx : '');
    var cb = $('stove-compress');
    cb.disabled = false;
    cb.checked = !!(s.compression && s.compression.enabled);
  }

  function load() {
    fetch('/_bridge/status', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(render)
      .catch(function () { render(null); });
  }

  function setProfile(key) {
    $('stove-note').textContent = '切换中…';
    fetch('/_bridge/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: key })
    }).then(function (r) { return r.json(); })
      .then(function () {
        // 档位是在**请求层**生效的,所以当前这轮不重发;下一句话就是新档位。
        load();
      })
      .catch(function () { $('stove-note').textContent = '切换失败'; });
  }

  function bind() {
    if (!$('stove-panel')) return false;
    $('stove-toggle').onclick = function () {
      $('stove-panel').classList.toggle('stove-open');
    };
    $('stove-compress').onchange = function (e) {
      fetch('/_bridge/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !!e.target.checked })
      }).catch(function () {});
    };
    load();
    return true;
  }

  if (!bind()) {
    // 脚本放在 body 末尾,通常 DOM 已就绪;真没就绪就等一等。
    window.addEventListener('DOMContentLoaded', bind);
  }
})();
`

/**
 * 把面板注入到 HTML 里。
 *
 * 只用字符串拼接,不用正则改写原有内容 —— 侵入性最小,也最不容易改坏上游。
 * 注入的三种成分:
 *   - CSS 放在 </head> 之前
 *   - HTML + JS 放在 </body> 之前
 *   - </body> 不存在时退化为直接追加(上游结构变化时不至于什么都不注入)
 */
export function injectPanel(html) {
  const head = `<style id="stove-style">${PANEL_CSS}</style>`
  const tail = `${PANEL_HTML}<script>${PANEL_JS}</script>`

  let out = html
  if (out.includes('</head>')) out = out.replace('</head>', `${head}</head>`)
  else out = head + out

  if (out.includes('</body>')) out = out.replace('</body>', `${tail}</body>`)
  else out = out + tail

  return out
}
