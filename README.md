# llama-shell

一个极简的 Electron 外壳,用来管理本地 `llama-server`,并把 llama.cpp 自带的 Web 聊天界面装进一个桌面窗口。

聊天界面本身是 llama.cpp 官方提供的 —— 这个外壳只负责**进程编排**:列模型、选预设、拉起服务、等它就绪、把界面指过去、退出时收干净。

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

**它本身不绑定任何模型。** 配合什么模型、带什么参数,全在 `src/config.js` 里定义。

## 快速开始

```bash
# 1. 装依赖(Electron 43.x)
npm install

# 2. 准备一个 llama-server 可执行文件(见下)
# 3. 改 src/config.js,把路径和模型指向你自己的环境
# 4. 启动
npm start
```

Windows 上也可以双击 `启动.bat`。

## 前置条件:你要有 llama-server

这个外壳**不含** llama.cpp,需要你自己准备。两条路:

**A. 直接用官方预编译包(多数情况够了)**

到 [ggml-org/llama.cpp 的 releases](https://github.com/ggml-org/llama.cpp/releases) 下载 `llama-*-bin-win-cuda-*.zip`,解压,把 `llama-server.exe` 的路径填进配置。

**B. 某些量化格式需要专门的构建**

llama.cpp 支持大量量化类型,但**并非所有构建都认识所有类型**。如果某个模型加载时报类似:

```
invalid ggml type <N>
unsupported tensor "..." size overflows
```

那说明你手上的 `llama-server` 不认识这个权重格式,需要换成产出该格式的那一方提供的构建。配置里的 `BIN` 就是为这种情况准备的 —— 可以同时登记多个构建,按模型选用。

## 配置

只改 `src/config.js`。三个部分:

**1) 二进制位置**

```js
const BIN = {
  stock: 'C:\\path\\to\\llama-cpp\\llama-server.exe',
  // 需要时再加一个专门构建:
  // prism: 'C:\\path\\to\\llama-fork\\llama-server.exe',
};
```

**2) 模型清单**

```js
const MODELS = [
  {
    id: 'my-model',
    name: '显示在侧栏的名字',
    note: '副标题,比如量化格式和大小',
    file: 'D:\\models\\MyModel-Q4_K_M.gguf',
    bin: BIN.stock,          // 用哪个构建
    defaultPreset: 'text-32k',
  },
];
```

**3) 运行预设**

预设 = 一组启动参数 + 上下文长度。加一个预设就是加一条:

```js
const PRESETS = {
  'text-32k': { label: '常规 32K', hint: '说明文字', ctx: 32768, vision: false },
};
```

`buildArgs()` 负责把模型 + 预设拼成 `llama-server` 的命令行。**这一段是本项目里最需要按自己环境调整的地方** —— 见下。

## 启动参数怎么定

`buildArgs()` 里的公共参数是一组通用起点:

| 参数 | 作用 |
|---|---|
| `-fa on` | flash attention,省计算缓冲 |
| `-np 1` | 单槽位(多槽位会额外吃显存) |
| `-ctk q4_0 -ctv q4_0` | KV cache 量化。**大上下文能塞进小显存主要靠这个** |
| `--jinja` | 启用工具调用 |
| `--temp/--top-p/--top-k` | 采样参数,通常照模型卡推荐填 |

其中三点值得单独说明:

- **`-ctk/-ctv` 是显存的关键。** 不量化 KV cache 时,上下文会贵好几倍。如果你的卡够大、追求最高质量,可以去掉。
- **`--reasoning-effort` 只对推理模型有意义,而且默认值因模型而异。** 有些模型的聊天模板默认就是最高档,会把整个输出预算烧在思考里、最终返回空字符串 —— 看起来像拒答,其实是截断。遇到这种情况可以显式压低它,或者干脆关掉思考。这**不是通用问题**,取决于你用的模型。
- **显存不够时先降上下文,再考虑降量化。**

调参建议:先只放一个模型、一个预设跑通,再逐步加。`llama-server --help` 是最准确的参数来源。

## 踩过的坑(改代码前值得看)

这几条和具体模型无关,是 Electron + 子进程管理本身的坑。

### 1. webview 不能每轮轮询都重新赋值 `src`

状态轮询每 4 秒跑一次。如果每次都 `setAttribute('src', url)` —— **即使值完全一样** —— Electron 也会发起一次导航。对某些前端来说,一次导航就是一次新会话,结果就是每隔几秒多出一个新标签页。

修法:记住实际加载过的 URL,没变就完全不碰 webview(`src/index.html` 里的 `loadedUrl`)。

### 2. `about:blank` 复位要加条件

隐藏 webview 时如果无条件把 `src` 设为 `about:blank`,同样会产生一次"发起又中止"的导航,控制台被 `ERR_ABORTED (-3)` 刷屏。只在真的加载了东西时才复位。

### 3. 子进程的 stdout 必须重定向到文件,不能用管道

用 `child.stdout.on('data', ...)`(管道 stdio)在某些受限环境里会直接让 **Electron 主进程原生崩溃**(表现为"XX 指令引用了 XX 内存")。改成 `stdio: ['ignore', fd, fd]` 把输出写进日志文件,再按需读取。日志面板就是这么实现的。

### 4. 长驻进程要用后台任务起

用 `Start-Process` 起的进程,会在启动它的命令结束时被连带清理。调试 GUI 程序时容易把这个误判成崩溃。

### 5. `llama-server` 的 Web UI 要求客户端声明 gzip

新版 llama.cpp 的界面是预压缩静态资源。用 `Invoke-WebRequest` 或 `urllib` 直接抓根路径会得到 `415 gzip is not supported by this browser`。浏览器天然会发 `Accept-Encoding: gzip`,所以正常使用不受影响 —— 但你自己写健康检查时要知道这一点。

## 作者的实际配置(示例,不是默认值)

下面这套是开发这个外壳时用的,**仅作参考** —— 它针对特定硬件和一小组模型,不代表通用最佳实践。换环境请以 `llama-server --help` 和你的模型卡为准。

**硬件:** RTX 5060 Laptop 8GB / Intel ArrowLake-H 20 线程 / Windows 11

**用到的模型:** PrismML 的 Bonsai 系列(27B 参数压到 3.5–5.5GB 的极端低位宽模型),其中三元版需要 PrismML 的 llama.cpp 分支才能读取。

**因此预设里多带了两个参数:**

| 参数 | 为什么 |
|---|---|
| `--reasoning-effort medium` | Bonsai 的模板默认最高档思考,不压会返回空字符串 |
| `--mmproj` + `--no-mmproj-offload` | 视觉预设需要投影器;放系统内存省约 0.9GB 显存 |

**参考的社区配置:** [sudoingX/bonsai2-small-gpu](https://github.com/sudoingX/bonsai2-small-gpu) 的 `serve/8gb.sh`,那里面按显存档位给了整套启动参数。

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
