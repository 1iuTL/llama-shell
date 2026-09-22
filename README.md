# llama-shell

一个极简的 Electron 外壳,用来管理本地 `llama-server`,并把 llama.cpp 自带的 Web 聊天界面装进一个桌面窗口。

聊天界面本身是 llama.cpp 官方提供的 —— 这个外壳只负责**进程编排**:选模型、选预设、拉起服务、等它就绪、把界面指过去、退出时收干净。

```
┌──────────────────────────────────────────────┐
│  llama-shell  (Electron)                     │
│  ┌────────────────────┬────────────────────┐ │
│  │ 侧栏                │ <webview>          │ │
│  │  模型列表            │  llama.cpp 官方    │ │
│  │  运行预设            │  Web 聊天界面      │ │
│  │  启停按钮            │                    │ │
│  │  状态(上下文/时长)  │                    │ │
│  └────────────────────┴────────────────────┘ │
└───────────────────┬──────────────────────────┘
                    │ spawn / kill
                    ▼
        llama-server.exe(按预设拉起)
```

## 为什么需要它

`llama-server` 自带一个很完整的 Web UI(思考块折叠、图片上传、多轮历史、参数调节),但它是个后台进程 —— 没有窗口、没有模型列表、要手敲一长串参数。这个外壳补上这一层。

## 快速开始

```bash
# 1. 装依赖(Electron 43.x)
npm install

# 2. 改配置:src/config.js 里的路径指向你自己的目录
#    - WORKSPACE:  llama.cpp 构建所在的目录
#    - MODELS_DIR: 模型权重所在的目录

# 3. 启动
npm start
```

Windows 上也可以直接双击 `启动.bat`。

## 配置

只有 `src/config.js` 需要改:

```js
const WORKSPACE = 'C:\\your\\models\\dir';   // llama-prism / llama-cpp 的上级目录
const MODELS_DIR = 'D:\\';                   // .gguf 权重所在目录

const BIN = {
  prism: path.join(WORKSPACE, 'llama-prism', 'llama-server.exe'),
  stock: path.join(WORKSPACE, 'llama-cpp',  'llama-server.exe'),
};
```

**为什么要两个构建:**
- `prism` —— PrismML 的 fork,**唯一能读 PTQ1_0(三进制)权重**的构建
- `stock` —— ggml-org 上游构建,读标准 Q1_0(1-bit)

模型和预设都写在 `MODELS` / `PRESETS` 里。加一个模型就是加一条对象,不用改别的代码。

## 预设里的参数不是随便填的

`buildArgs()` 里那串 flag 是 8GB 显存档位实测出来的配置,每一项都有理由:

| 参数 | 作用 |
|---|---|
| `-fa on` | flash attention,省掉计算缓冲 |
| `-np 1` | 单槽位(四个槽位白吃约 450 MiB) |
| `-ctk q4_0 -ctv q4_0` | KV cache 压到 1/4 —— **这才是 64K 上下文能塞进 8GB 的原因** |
| `--reasoning-effort medium` | 覆盖模型模板的默认值。不覆盖的话它会一路思考到烧光上下文,**返回空字符串** |
| `--jinja` | 启用工具调用 |
| `--temp 1.0 --top-p 0.95 --top-k 20` | 模型卡推荐的思考模式采样参数 |

参考实现:[sudoingX/bonsai2-small-gpu](https://github.com/sudoingX/bonsai2-small-gpu) 的 `serve/8gb.sh`。

## 踩过的坑(改代码前值得看)

### 1. webview 不能每轮轮询都重新赋值 `src`

状态轮询每 4 秒跑一次。如果每次都 `setAttribute('src', url)` —— **即使值完全一样** —— Electron 也会发起一次导航,而 llama.cpp 的 UI 把每次导航当成一个新会话,结果就是每隔几秒多出一个 "New chat" 标签页。

修法:记住实际加载过的 URL,没变就完全不碰 webview(`src/index.html` 里的 `loadedUrl`)。

### 2. `about:blank` 复位要加条件

隐藏 webview 时如果无条件把 `src` 设为 `about:blank`,同样会产生一次"发起又中止"的导航,控制台被 `ERR_ABORTED (-3)` 刷屏。只在真的加载了东西时才复位。

### 3. 子进程的 stdout 必须重定向到文件,不能用管道

用 `child.stdout.on('data', ...)`(管道 stdio)在某些受限环境里会直接让 **Electron 主进程原生崩溃**(`0x8 内存不可读`)。改成 `stdio: ['ignore', fd, fd]` 把输出写进日志文件,再按需读取。这也是日志面板的实现方式。

### 4. 长驻进程要用后台任务起

用 `Start-Process` 起的进程,会在启动它的命令结束时被连带清理。调试 GUI 程序时容易把这个误判成崩溃。

## 已知限制

- 端口硬编码 8091(`src/main.js` 顶部的 `PORT`)
- 不下载模型,只列已存在的文件
- 记不住上次选的模型/预设,每次默认第一个
- 没有多会话管理,靠官方 UI 自己的历史
- 没配 electron-builder 打包,目前是源码运行
- 模型文件缺失时只在列表里置灰,不做自动获取

## 目录

```
src/config.js     模型与预设清单(唯一需要按环境改的文件)
src/main.js       主进程:进程编排、IPC、日志
src/preload.js    contextBridge 暴露的白名单接口
src/index.html    侧栏界面 + 内嵌 webview
启动.bat          Windows 启动器(用绝对路径,避开空格截断)
```

## 许可

MIT
