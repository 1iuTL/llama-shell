# Model Stove(模型灶台)

**本地模型启动器** —— 把 [llama.cpp](https://github.com/ggml-org/llama.cpp) 的 `llama-server` 管起来,并把它自带的 Web 聊天界面装进一个桌面窗口。

一个极简的 Electron 外壳:列模型、选预设、拉起服务、等它就绪、把界面指过去、退出时收干净。

聊天界面本身是 llama.cpp 官方提供的,**这个外壳只负责进程编排**,不绑定任何模型。

```
┌──────────────────────────────────────────────┐
│  model-stove  (Electron)                     │
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

## 低比特量化会出现"重复塌缩"(实测记录)

这是本项目踩过最费时间的一个坑,值得单独写一节 —— 因为它看起来像"模型一直在思考",实际是**输出故障**。

### 现象

问一句极简单的话(`1+1等于几`),聊天界面的 reasoning 区刷出一大片 `/`,而且**永远不产出答案**:

```
用户问"1+1////////////////////////////////////////////////////…
                    (之后 1000 个字符全是 /)
content: (空)
```

注意那些 `/` **是模型真的输出的**,不是界面的加载动画。这一点必须用服务端原始响应确认,不能靠看界面猜 —— 下面是分辨方法。

### 怎么确认是哪一边的问题

绕开界面直接看服务端返回的 `reasoning_content`:

```bash
curl -s http://127.0.0.1:8091/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"local","messages":[{"role":"user","content":"1+1等于几"}],"max_tokens":512}' \
  | python -c "import json,sys; m=json.load(sys.stdin)['choices'][0]['message']; r=m.get('reasoning_content',''); print(len(r), r.count('/'), r[:200])"
```

如果 `reasoning_content` 里斜杠占比极高,就是模型塌缩;如果那里干净、只是界面显示成斜杠,才是渲染问题。

### 实测结论

| 模型 | 有答案 | reasoning 里的最长连续重复 |
|---|---|---|
| `Bonsai-27B-Q1_0.gguf`(纯 1-bit) | **3/3** | **1 个字符** |
| `Ternary-Bonsai-2-27B-PTQ1_0.gguf`(三值) | 2/3 | 497 个字符 |

Q1_0 的 reasoning 有完整的分步分析(含自检环节),两个不同问题都给出正确答案。PTQ1_0 则在写出半句之后直接塌缩。

**所以这不是"比特数越低越不稳"** —— 位数更低的 Q1_0 反而正常,问题出在 PTQ1_0 这个较新的三值格式上。这也是为什么 `src/config.js` 里把 Q1_0 排在第一位作为默认,并给三个 PTQ1_0 模型都标了警告。

### 试过但**无效**的手段

别在这几条上浪费时间,都实测过了:

| 手段 | 结果 |
|---|---|
| 降低 `temp`(1.0 → 0.6) | **更糟**,3/3 全塌缩 |
| 加 `--repeat-penalty 1.3` | 无效,3/3 仍塌缩 |
| 加 `--reasoning-budget` 截断 | 只能限制"崩多久",不能减少"崩不崩" |

### 一个反直觉的陷阱

`--reasoning-budget-message`(预算耗尽时注入提示语)会**诱发**塌缩。同一模型、同一提示词、同一采样参数:

- **加上**这条中文提示语:reasoning 1026 字符里 1016 个是 `/`,content 为空,答不出
- **去掉**:reasoning 仅 29 字符,内容正常,正常作答

猜测是这类量化模型对输入扰动极敏感,一段固定的长中文串会把它推入重复。所以 `src/config.js` 里这个常量留成了 `null` —— **预算只做截断,不做提醒**。宁可停在思考中途,也不要因为一句提示把整轮输出废掉。

## 手机访问(局域网模式)

想在手机上用同一个模型,点右边栏的 ⚙ 设置:

1. **打开「允许其它设备连接」。** 这会让 `llama-server` 从只监听 `127.0.0.1` 改成监听 `0.0.0.0`,手机才连得上。
2. **设置一个 API Key。** 点「生成随机」即可,会得到一个 32 位十六进制串。
3. **重新启动服务。** 这两项都是启动参数,改了要重启才生效。
4. 设置面板里会出现本机所有局域网地址和二维码,手机扫码或手输地址即可。

手机上第一次打开会弹出 API Key 输入框 —— 那是 llama.cpp 自带 Web UI 的能力,填一次就存进浏览器 localStorage,以后免输。

### 网络怎么选

- **推荐用热点。** 让手机连电脑开的热点,或者电脑连手机热点。这样安全边界就是热点本身。
- **校园网/公共 WiFi 常常设备隔离**(AP isolation),手机和电脑互相看不见,这不是配置问题。这也是推荐热点的原因。
- 其它方案(如 Tailscale)也能用,但要额外账号、且国内可能需要中转,不如热点直接。

### 为什么必须设 API Key

监听 `0.0.0.0` 之后,**同一网络下的任何人都能直接用你的模型**。默认状态下没有任何认证,对方的请求和你的请求在服务端看起来一模一样。

关于这层防护的边界,说清楚比较好:

| 做得到 | 做不到 |
|---|---|
| 挡住同网段的其他人 | 挡不住能登录你这台电脑的人 |
| 明文 Key 只存在本机用户目录 | 加密传输 —— 是普通 HTTP,同网段可被抓包 |

Key 存放在 `%APPDATA%\model-stove\settings.json`(Windows)。它不进仓库,重装外壳也不会丢。

代码里还做了两件相关的事:

- **局域网模式下自动加 `--no-slots`。** `/slots` 默认会回报每个槽位正在处理的内容 —— 也就是别人能看到你正在问什么。绑到网络上时关掉。
- **日志里隐藏 Key。** 启动横幅会把这个参数打成 `<已隐藏>`,免得 Key 明文留在日志文件里被随手分享出去。

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

## 目录

```
src/config.js     模型与预设清单(唯一需要按环境改的文件)
src/main.js       主进程:进程编排、IPC、日志、局域网地址枚举
src/preload.js    contextBridge 暴露的白名单接口
src/settings.js   外壳自己的设置(API Key、局域网开关),存 userData
src/index.html    侧栏界面 + 内嵌 webview
src/qr.js         零依赖二维码生成器(给手机访问面板用)
启动.bat          Windows 启动器(用绝对路径,避开空格截断)
```

`src/qr.js` 是自己写的,不是引包 —— 外壳要求完全离线,而这里只需要编一条几十字节的局域网地址。它只实现 byte 模式 + 纠错等级 L + 版本 1–10。生成结果与参考实现(经典 `qrcode.js`)逐格对拍一致,并有往返解码测试。

`tools/` 下是验证脚本和一个推送脚本,跑测试不需要任何依赖:

```
node tools/test_qr.cjs       # 二维码结构(24 项)
node tools/decode_qr.cjs     # 二维码往返解码(版本 1-10、多块交织、中文)
node tools/check_ui.cjs      # 界面结构:内联脚本语法、元素引用、id 唯一性
```

`check_ui.cjs` 值得单独说一句:它会把 `index.html` 里 `$('xxx')` 引用到的每个 id 都对着 HTML 核一遍,并检查 id 不重复。这类错误不会在启动时报出来,只会在点某个按钮时静默失效,所以值得机器检查。

## 已知限制

- 端口硬编码 8091(`src/main.js` 顶部的 `PORT`)
- 不下载模型,只列已存在的文件
- 记不住上次选的模型/预设,每次默认第一个
- 没有多会话管理,靠官方 UI 自己的历史
- 没配 electron-builder 打包,目前是源码运行
- 模型文件缺失时只在列表里置灰,不做自动获取
- 局域网是明文 HTTP,没有 TLS(手机端要 HTTPS 得自己套反代)

## 开发备注:这台机器上 git push 不可用

如果你在这台机器上继续开发,会撞到一个和本项目无关、但很费时间的环境问题:

**PowerShell 和 git 的 HTTPS 传输都走 schannel,向 GitHub 发请求一律失败:**

```
schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS (0x8009030e)
```

`git push`、`git ls-remote`、`Invoke-WebRequest`、`curl` 全都受影响。Node 不受影响 —— 它自带 OpenSSL,不碰 schannel。

所以 `tools/push_gh.mjs` 是绕行方案:它用 `git pack-objects` 在本地打 pack,再按 git 的 receive-pack 协议自己拼请求体,最后用 Node 的 `fetch` 发出去。用法:

```powershell
$cred = ("protocol=https`nhost=github.com`n`n" | git credential-manager get)
$env:GH_TOKEN = ($cred | Where-Object { $_ -match '^password=' }) -replace '^password=',''
node tools\push_gh.mjs
```

token 只能从环境变量传进来,不能让脚本自己去 `git credential-manager` 问 —— 那需要向子进程 stdin 写入,而沙箱禁止命名管道(`spawn EPERM`)。同理,脚本内部所有子进程的 stdio 都接**文件**而不是管道。

## 许可

MIT
