// 往 llama.cpp 自带的 Web UI 里注入一个「档位」面板。
//
// 为什么需要注入而不是改 llama.cpp 的界面:那个界面是**预压缩的 Svelte 包**
// (8.8 MB),改它需要反编译和重建,而且一升级 llama.cpp 就白改。代理正好夹在
// 浏览器和 llama-server 之间,可以在**返回 HTML 时**追加一小段自己的脚本 ——
// 只有一个文件、不碰上游代码、上游换版本也不受影响。
//
// 面板做三件事:
//   1. 切档位(通用 / 推理 / 写作 / 代码)—— 手机端原本完全没法切
//   2. 显示当前档位与思考开关状态(原来只有电脑端的 Model Stove 能看到)
//   3. 开关自动压缩
//
// 请求走代理自己的 /_bridge 接口,所以不带 API Key 也能用。
//
// 关于位置:默认在**右上角**,并且可以拖动,位置记在 localStorage 里。
//
// 为什么不放右下角:llama.cpp 的输入区右下角就是「发送 / 停止」按钮,
// 固定在那儿会把手机上唯一的发送入口挡住。
//
// 关于长按:光靠 user-select:none 不够 —— 实测长按会弹出系统的文字选取/
// 复制菜单,而且 pointermove 根本没机会跑。所以要几层一起上:
//   - user-select 与 -webkit-touch-callout 都关掉
//   - pointerdown 里 preventDefault,不让浏览器进入长按手势
//   - contextmenu 也吞掉
//   - touch-action:none 挡住滚动接管

export const PANEL_HTML = `<div id="stove-panel" class="stove-collapsed stove-below">
  <button id="stove-toggle" type="button" title="任务档位(可按住拖动)">档位</button>
  <div id="stove-body">
    <div class="stove-h">任务档位 <span id="stove-dot"></span></div>
    <div id="stove-list"></div>
    <div id="stove-note"></div>
    <label class="stove-opt"><input type="checkbox" id="stove-compress" /> 自动压缩上下文</label>
    <div class="stove-tip">按住「档位」可拖动 · <a id="stove-reset" href="#">复位</a></div>
  </div>
</div>`

export const PANEL_CSS = `
#stove-panel{position:fixed;top:14px;right:14px;z-index:2147483000;
  font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#e6edf3;
  -webkit-user-select:none;user-select:none;-webkit-touch-callout:none}
#stove-panel *{box-sizing:border-box;
  -webkit-user-select:none;user-select:none;-webkit-touch-callout:none}
#stove-toggle{background:#1f6feb;color:#fff;border:0;border-radius:999px;
  padding:9px 15px;font:600 13px/1 system-ui,sans-serif;cursor:grab;
  box-shadow:0 3px 12px rgba(0,0,0,.4);
  touch-action:none;            /* 拖动时不要触发页面滚动 */
  -webkit-user-select:none;user-select:none;-webkit-touch-callout:none;
  -webkit-tap-highlight-color:transparent}
#stove-toggle:active{cursor:grabbing}
#stove-panel.stove-dragging #stove-toggle{opacity:.85}
#stove-body{display:none;width:236px;margin-bottom:8px;background:#161b22;
  border:1px solid #30363d;border-radius:11px;padding:11px;
  box-shadow:0 6px 24px rgba(0,0,0,.5);max-height:64vh;overflow:auto}
#stove-panel.stove-open #stove-body{display:block}
/* 拖到屏幕上半部分时,把面板翻到按钮下面,免得顶出可视区 */
#stove-panel.stove-below{display:flex;flex-direction:column-reverse}
#stove-panel.stove-below #stove-body{margin-bottom:0;margin-top:8px}
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
.stove-tip{font-size:10.5px;color:#6e7681;margin-top:7px;text-align:center}
.stove-tip a{color:#58a6ff;text-decoration:none}
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
    note.textContent = s.profile.label + ' · ' + (s.profile.thinking ? '思考开' : '思考关') +
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
        // 档位在**请求层**生效,当前这轮不重发;下一句话就是新档位。
        load();
      })
      .catch(function () { $('stove-note').textContent = '切换失败'; });
  }

  // ---------- 拖动 ----------
  //
  // 用 Pointer Events,鼠标和触摸一套代码。
  //
  // 关于长按:实测长按会弹出系统的**文字选取/复制菜单**,而 pointermove 根本
  // 没机会跑 —— 也就是说拖动完全失效。光靠 CSS 的 user-select:none 不够,
  // 所以这里几层一起上:
  //   - CSS 里对面板整体关掉 user-select 与 -webkit-touch-callout
  //   - pointerdown 里 preventDefault,阻止浏览器进入长按手势
  //   - contextmenu 直接吞掉
  //   - CSS 里 touch-action:none 挡住滚动接管
  // 另外把默认位置放到**右上角**(而不是右下角的发送按钮旁边),
  // 这样即使拖动在某台设备上仍然不灵,也不会挡住输入区。
  //
  // 位置键带版本号:改成右上角之后,旧的右下角坐标不该再被沿用,
  // 否则用户会以为"改了没生效"。
  var POS_KEY = 'stove-panel-pos-v2';
  var DEFAULT_POS = { top: 14, right: 14 };

  var dragMoved = false;

  /** 用 left/top 定位。right/bottom 归零,否则会和 left/top 打架。 */
  function applyPos(btn, x, y) {
    btn.style.left = x + 'px';
    btn.style.top = y + 'px';
    btn.style.right = 'auto';
    btn.style.bottom = 'auto';
  }

  function savePos(x, y) {
    try { localStorage.setItem(POS_KEY, JSON.stringify({ x: x, y: y })); } catch (e) {}
  }

  function clearPos(btn) {
    try { localStorage.removeItem(POS_KEY); } catch (e) {}
    btn.style.left = 'auto';
    btn.style.top = DEFAULT_POS.top + 'px';
    btn.style.right = DEFAULT_POS.right + 'px';
    btn.style.bottom = 'auto';
  }

  function restorePos(btn) {
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(POS_KEY) || 'null'); } catch (e) {}
    if (saved && typeof saved.x === 'number' && typeof saved.y === 'number') {
      applyPos(btn, saved.x, saved.y);
    }
  }

  /** 把按钮拉回可视区;返回修正后的坐标(没定位过就返回 null)。 */
  function clamp(btn) {
    var r = btn.getBoundingClientRect();
    var x = parseFloat(btn.style.left);
    var y = parseFloat(btn.style.top);
    if (isNaN(x) || isNaN(y)) return null;
    var maxX = window.innerWidth - r.width - 8;
    var maxY = window.innerHeight - r.height - 8;
    x = Math.min(Math.max(8, x), Math.max(8, maxX));
    y = Math.min(Math.max(8, y), Math.max(8, maxY));
    applyPos(btn, x, y);
    return { x: x, y: y };
  }

  /** 按钮在上半屏时,面板翻到按钮下方,免得展开后顶出可视区。 */
  function updateFlip(panel, btn) {
    var r = btn.getBoundingClientRect();
    panel.classList.toggle('stove-below', r.top < window.innerHeight * 0.45);
  }

  function bindDrag() {
    var panel = $('stove-panel');
    var btn = $('stove-toggle');
    if (!panel || !btn) return;

    restorePos(btn);
    updateFlip(panel, btn);

    var startX = 0, startY = 0, originLeft = 0, originTop = 0, active = false;

    btn.addEventListener('pointerdown', function (e) {
      active = true;
      dragMoved = false;
      var r = btn.getBoundingClientRect();
      originLeft = r.left;
      originTop = r.top;
      startX = e.clientX;
      startY = e.clientY;
      try { btn.setPointerCapture(e.pointerId); } catch (err) {}
      panel.classList.add('stove-dragging');
      // 阻止浏览器把这次按下当成"长按选取文字"的起点
      if (e.cancelable) e.preventDefault();
    });

    btn.addEventListener('pointermove', function (e) {
      if (!active) return;
      var dx = e.clientX - startX;
      var dy = e.clientY - startY;
      if (!dragMoved && Math.abs(dx) + Math.abs(dy) < 6) return;  // 阈值内当作点击
      dragMoved = true;
      applyPos(btn, originLeft + dx, originTop + dy);
      updateFlip(panel, btn);
      if (e.cancelable) e.preventDefault();
    });

    function end(e) {
      if (!active) return;
      active = false;
      panel.classList.remove('stove-dragging');
      try { btn.releasePointerCapture(e.pointerId); } catch (err) {}
      if (dragMoved) {
        var c = clamp(btn);
        if (c) savePos(c.x, c.y);
      }
    }
    btn.addEventListener('pointerup', end);
    btn.addEventListener('pointercancel', end);
    // 拖出按钮范围再松手也要收尾,否则会卡在拖动状态
    btn.addEventListener('lostpointercapture', end);

    // 长按时浏览器会弹系统菜单(复制/搜索),直接吞掉
    btn.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    // 点一下开合面板;拖过之后的那次 click 要忽略掉
    btn.addEventListener('click', function (e) {
      if (dragMoved) { dragMoved = false; e.preventDefault(); return; }
      panel.classList.toggle('stove-open');
      if (panel.classList.contains('stove-open')) load();
    });

    // 复位
    var reset = $('stove-reset');
    if (reset) {
      reset.addEventListener('click', function (e) {
        e.preventDefault();
        clearPos(btn);
        updateFlip(panel, btn);
      });
    }

    // 横竖屏切换或窗口变化后把面板拉回可视区
    window.addEventListener('resize', function () {
      if (clamp(btn)) updateFlip(panel, btn);
    });
  }

  function bindControls() {
    if (!$('stove-panel')) return false;
    $('stove-compress').onchange = function (e) {
      fetch('/_bridge/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !!e.target.checked })
      }).catch(function () {});
    };
    bindDrag();
    load();
    return true;
  }

  if (!bindControls()) {
    // 脚本放在 body 末尾,通常 DOM 已就绪;真没就绪就等一等。
    window.addEventListener('DOMContentLoaded', bindControls);
  }
})();
`

/**
 * 面板脚本的对外路径。
 *
 * 为什么把脚本做成**外链**而不是内联:
 *   1. 内联脚本可能被 CSP 或某些"脚本拦截"策略挡掉,而元素照样渲染 ——
 *      表现就是"面板在,但点不动、拖不动"。外链走独立的资源请求,不受
 *      内联策略影响。
 *   2. 外链可以单独设缓存头,避免手机拿到旧版本的面板脚本(内联的话它跟着
 *      HTML 一起被缓存,更难控制)。
 *   3. 语法/加载失败更容易定位:直接请求这个路径就能看到内容。
 */
export const PANEL_SCRIPT_PATH = '/_stove/panel.js'

/**
 * 把面板注入到 HTML 里。
 *
 * 只用字符串拼接,不用正则改写原有内容 —— 侵入性最小,也最不容易改坏上游。
 * 注入的三种成分:
 *   - CSS 放在 </head> 之前(样式内联没问题,它不涉及执行)
 *   - 面板 HTML + 一段**外链** script 放在 </body> 之前
 *   - </body> 不存在时退化为直接追加(上游结构变化时不至于什么都不注入)
 */
export function injectPanel(html) {
  const head = `<style id="stove-style">${PANEL_CSS}</style>`
  const tail = `${PANEL_HTML}<script src="${PANEL_SCRIPT_PATH}" defer></script>`

  let out = html
  if (out.includes('</head>')) out = out.replace('</head>', `${head}</head>`)
  else out = head + out

  if (out.includes('</body>')) out = out.replace('</body>', `${tail}</body>`)
  else out = out + tail

  return out
}

/** 面板 HTML 片段(CSS + 容器 + 外链脚本标签),给测试用。 */
export function panelFragment() {
  return injectPanel('</head><body></body>')
}

/** 面板脚本源码,给测试做语法校验用。 */
export function panelScript() {
  return PANEL_JS
}
