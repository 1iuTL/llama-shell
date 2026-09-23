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

## Bonsai 2 必须配官方 fork 构建(踩坑记录)

这是本项目最费时间的一个坑,而且**根因是我自己配错了二进制**,不是模型的问题。写下来免得别人重走。

### 现象

问一句简单的话,聊天界面的 reasoning 区刷出一大片 `/`,**答不出东西**:

```
用户问"1+1////////////////////////////////////////////////////…
                    (之后 1000 个字符全是 /)
content: (空)
```

另一种形态是**先答对、再崩**:`content` 里正常写出正确答案,然后接一条几百字符的斜杠长龙,直到 token 上限。两种都见过。

那些 `/` **确实是模型输出的**,不是界面动画。必须用服务端原始响应确认,不能靠看界面猜:

```bash
curl -s http://127.0.0.1:8091/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"local","messages":[{"role":"user","content":"1+1等于几"}],"max_tokens":512}' \
  | python -c "import json,sys; m=json.load(sys.stdin)['choices'][0]['message']; r=m.get('reasoning_content','') or ''; print('reasoning', len(r), '斜杠', r.count('/'), '| content', len(m.get('content') or ''))"
```

### 真正的原因:fork 与 gguf 必须配对

PrismML 的 [Bonsai-demo README](https://github.com/PrismML-Eng/Bonsai-demo#upstream-status-for-ternary) 写得很明确:

> **Bonsai 2 需要 Hadamard 激活变换,尚未进入上游**,所以每一档都必须用 PrismML fork 的二进制。

而维护者在 [issue #82](https://github.com/PrismML-Eng/Bonsai-demo/issues/82) 里补充:**每个 gguf 版本只兼容特定 fork** —— `Q2_0` 配官方 fork,`Q2_0_g64` 配上游。

`Ternary-Bonsai-2-27B-*` 正是 **Bonsai 2**,所以必须配官方构建。本项目一度用了社区第三方 fork(`sudoingX/llama.cpp` 的 `pr-ptq1-mmv` 分支)去跑它 —— 那个构建预填充快一倍(332 → 769 t/s),但**对 Bonsai 2 会稳定塌缩**。

### 实测对照:同一模型文件,只换二进制

问题都用「解释反射定律」,各 2 次:

| 构建 | 模型 | 结果 | 最长连续重复 |
|---|---|---|---|
| PrismML 官方 | PTQ1_0 | **2/2 正常** | 1 |
| PrismML 官方 | Heretic | **2/2 正常** | 0–1 |
| 社区 sudoingX | PTQ1_0 | 0/2 塌缩 | **708** |
| 社区 sudoingX | Heretic | 0/2 塌缩 | **657** |

官方构建下三个三值模型(含 Abliterated)全部正常,`content` 750–944 字,最长连续重复都是 1 个字符。

**教训:同一个 gguf 换一个构建就能从"完全不可用"变成"完全可用"。** 在把问题归到量化格式或模型质量之前,先确认二进制与模型是配对的 —— 这类不匹配往往不报错,只是安静地输出垃圾。

### 试过但**无效**的手段

方向错了时这些都试过,记下来免得别人浪费时间:

| 手段 | 结果 |
|---|---|
| 降低 `temp`(1.0 → 0.6) | 无效甚至更糟 |
| 加 `--repeat-penalty 1.3` | 无效 |
| 加 `--reasoning-budget` 截断 | 只能限制"崩多久",不能减少"崩不崩" |
| 关掉思考(`--reasoning off`) | 能出正确答案,但尾巴仍可能拖废输出 |

正确的解法只有一个:**换成配对的官方构建**。

### 附:一个真实的陷阱

`--reasoning-budget-message`(预算耗尽时注入提示语)在**配错构建**的前提下会显著加重塌缩。同一模型、同一提示词:

- **加上**这条中文提示语:reasoning 1026 字符里 1016 个是 `/`
- **去掉**:reasoning 仅 29 字符,内容正常

但换对构建之后这条提示语就不再是问题了。所以 `src/config.js` 里这个常量仍留成 `null` —— 理由很实际:预算的职责是**截断**,不需要额外注入文本,少一个变量少一份风险。

## 实测:吞吐量高 ≠ 回答快

同一台机器(RTX 5060 Laptop 8GB)、同一套参数、PrismML 官方构建、`temp 0.7`、开启思考,每个模型问 3 个问题:

| 模型 | 预填充 | 生成 | 「解释反射定律」耗时 | 思考字数 | 正确率 |
|---|---|---|---|---|---|
| Q1_0(1-bit,3.54 GB) | **826.25 t/s** | **43.34 t/s** | 11.2 s | **1159 字** | 3/3 |
| PTQ1_0(三值,5.54 GB) | 338.47 t/s | 33.86 t/s | 2.7 s | 66 字 | 3/3 |
| PQ2_0(三值,6.71 GB) | 716.16 t/s | 39.43 t/s | **2.3 s** | 63 字 | 3/3 |

**Q1_0 的吞吐量最高,却是最慢的** —— 回答同一个问题要 11.2 秒,而另外两个只要 2-3 秒。原因不在速度,在于它每条都写约 1000 字思考,别人只写 60 字左右。

你实际等待的时间是:

```
耗时 ≈ 输出 token 数 ÷ 生成速度
```

只看 t/s 会把这三个模型**排反**。选模型时更该看"实际回答耗时",或者干脆实测一遍。

其他几点观察:

- **PQ2_0 的吞吐几乎追平 Q1_0**(716 vs 826),同时预填充是 PTQ1_0 的 **2.1 倍**。对一个体积大 1.2 GB 的文件来说表现很好。
- **简单问题上三者质量没差别**,官方的 Q2 高 4 分是针对推理类基准(数学、代码竞赛)的,日常问答体现不出来。
- Q1_0 出现过把英文词混进中文句子(`现在 basket 里有 6 个苹果`),是这类低比特量化的典型小瑕疵。
- **PQ2_0 占 6.70 GiB**,在 8 GB 卡上配 64K 上下文很紧,可能要把上下文降到 32K。
- **官方没有 Q2 档的去审查版**:Heretic / Abliterated 只有 PTQ1_0。想要去审查就只能用它。

### 命名陷阱:Q2_0 与 PQ2_0 不是一回事

下载"Q2"时注意别下错。PrismML 有两个容易混的仓库:

| 仓库 | 文件 | 配哪个构建 |
|---|---|---|
| `prism-ml/Ternary-Bonsai-2-27B-gguf` | PTQ1_0、**PQ2_0** | **官方 fork**(本项目用这个) |
| `prism-ml/Ternary-Bonsai-27B-gguf` | Q2_0、Q2_g64 | 上游构建 |

从后者下 Q2_0 给官方构建用,会被直接拒绝,报错里还带着有用的提示:

```
this file matches the legacy Prism Q2_0 layout (group size 128 stored as ggml type id 42),
but this build reads Q2_0 as the official group-64 format
you are probably using the wrong GGUF: use the PQ2_0 version of this model
```

这次它**响亮地失败了**。但同样是"fork 与 gguf 不配对",前面那三个三值模型却是**安静地输出垃圾** —— 所以配错时的表现从报错到静默出错都有可能,不能指望一定有提示。

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

## 自动上下文压缩(`context-proxy.mjs`)

llama.cpp 自带的 Web UI 每次把**完整对话历史**发给 `llama-server`。聊得久了历史必然撑爆上下文,然后要么报错、要么被静默截断 —— 上游界面没有压缩功能,也不该去改它,所以在中间加一层代理:

```
浏览器 → context-proxy.mjs(:8092) → llama-server(:8091)
              │
              └─ 历史超过阈值时,把较早的对话交给模型总结成一段,替换掉原文
```

### 跑起来

```powershell
# 先在 Model Stove 里点「启动」,让 llama-server 跑起来
node context-proxy.mjs
```

**手机该连哪个端口,二维码会自动选。** 代理在跑时它指向 `:8092`(档位与压缩都生效),代理没在跑时退回 `:8091`(直连,功能少但能用)。设置面板会同时列出两类地址,并说明两者的聊天记录是**各自独立**的 —— 浏览器按来源地址隔离存储。

代理监听在 `0.0.0.0`,所以手机走局域网地址能直接连上(实测两个网卡地址都返回 200)。

功能开关与实时状态:

```
GET  http://<电脑IP>:8092/_bridge/status
POST http://<电脑IP>:8092/_bridge/config   {"enabled":true}
POST http://<电脑IP>:8092/_bridge/config   {"profile":"write"}
```

压缩默认**开启**,阈值是上下文的 60%,保留最近 4 轮原文。

### 为什么要另起端口:localStorage 按地址隔离

浏览器把聊天记录存在 **localStorage** 里,而 localStorage 是**按来源地址隔离**的。手机以前连 `8091`,记录就存在 `8091` 这个来源下;改连 `8092` 后是另一个来源,**看不到原来的历史会话**。

记录没有丢,只是不在新地址下。想保留旧对话:

1. 仍用 `8091` 打开旧地址 → 逐个会话复制内容出来
2. 或者从此就用 `8092`,把旧记录留在原处备查

llama-server 刻意留在 8091 不动,这样 Model Stove、桌面端、以及你原有的书签都不受影响。

### 一个容易踩的坑:system 消息必须只有一条且在开头

把摘要作为**新的** system 消息插到原 system 之后,会直接报错:

```
Jinja Exception: System message must be at the beginning.
```

所以摘要必须**并入**原有 system 内容,而不是新增一条。这一点上游模板不会容忍。

### 首次对话慢是正常的,与压缩无关

模型加载后的**第一次**推理要建 CUDA 图、分配 KV cache,约 30 秒量级。实测同一个请求连发三次:

```
#1: 32.5s     #2: 1.3s     #3: 0.8s
```

第二次起就正常了。**不要把这 30 秒归因于压缩** —— 我一开始就误判过:当时把"某个参数让总结从 35s 降到 3s"当成结论,后来连发三次才发现那只是"它排在第二位、已经预热过了"。同一进程里依次跑多个配置,后者天然更快,对比时必须重复或打乱顺序。

### 任务档位

同一个压缩代理还负责**任务档位** —— 因为一套采样参数不可能同时适合推理和创作。档位在 ⚙ 设置面板里切。

为什么必须放在代理里、而不是外壳加个启动参数就行:**请求里带的采样参数会盖住服务端启动参数**。实测:请求里指定 `temperature=0.01` 时三次输出完全相同(贪心解码生效),指定 `1.8` 时三次各不相同。所以档位只能在**请求层**覆盖。

四个档位(定义在 `src/profiles.js`):

| 档位 | 思考 | 取向 |
|---|---|---|
| **通用**(默认) | 关 | 日常问答与创作,平衡取向 |
| 推理 | **开** | 数学与逻辑,低温度 |
| 写作 | 关 | 长文与创意,高温度 + 重复惩罚 |
| 代码 | 关 | 写代码与排错,低温度 |

实测档位确实改变行为(同一个数学题,走代理且不带采样参数):

```
档位     思考   思考字数  回答字数  耗时
推理     开          307       212     8.6s
通用     关            0       609    12.2s
写作     关            0       688    13.3s
代码     关            0       637    12.8s
```

注意**推理档最快**(思考内容不长且直接给答案),而其它三档回答更长。用错档位的代价是实质性的:在只给 600 token 预算的测试里,推理档写小说会**输出为空** —— 开思考后整个预算被思考吃光,没有余量留给正文。

## 沙箱里哪些做不了(实测边界)

这些是在受限环境里开发时反复撞到的,记下来免得重走:

| 能力 | 结果 | 说明 |
|---|---|---|
| `netstat -ano` | ✅ 可用 | 判断"谁在监听某端口"唯一可靠的办法,还带 PID |
| `tasklist` | ❌ Access denied | 进程枚举整体不可用 |
| `cmd /c`、`Start-Process` | ❌ Access denied | 为捕获输出而起的子 shell 也被拒 |
| `wmic` | ❌ 不存在 | 系统里没有 |
| `Get-CimInstance` / `Get-NetTCPConnection` | ⚠️ 部分被拒 | 查不到进程详情,连接信息也可能是空的 |
| 命名管道 | ❌ 禁止 | 所以子进程 stdio 一律走**文件**,用管道会 `spawn EPERM` |
| Cordis Host 半里的 `fetch` / `AbortController` | ❌ 不存在 | 只有 ctx / harness / console / btoa / atob / TextEncoder / TextDecoder;要发 HTTP 得走子进程 |

**最重要的一条教训**:`tasklist` 看不见进程,**不等于**服务没在跑。我因为这一点误判过服务已经卡死,而它当时 `/health` 一直返回 200。判断服务是否可用要**以真实响应为准**,进程数只作参考 —— 这也是 `stove_health` 把"端口监听"和"服务响应"分开查、并主动报出二者矛盾的原因。

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
src/config.js        模型与预设清单(唯一需要按环境改的文件)
src/main.js          主进程:进程编排、IPC、日志、局域网地址枚举
src/preload.js       contextBridge 暴露的白名单接口
src/settings.js      外壳自己的设置(API Key、局域网开关),存 userData
src/profiles.js      任务档位定义(推理/通用/写作/代码),界面与代理共用
src/index.html       侧栏界面 + 内嵌 webview
src/qr.js            零依赖二维码生成器(给手机访问面板用)
context-proxy.mjs    任务档位 + 自动上下文压缩代理(可选,手机访问时用)
qq-bridge.mjs        QQ 官方机器人桥接(未部署,见文件头说明)
启动.bat             Windows 启动器(用绝对路径,避开空格截断)
```

`src/qr.js` 是自己写的,不是引包 —— 外壳要求完全离线,而这里只需要编一条几十字节的局域网地址。它只实现 byte 模式 + 纠错等级 L + 版本 1–10。生成结果与参考实现(经典 `qrcode.js`)逐格对拍一致,并有往返解码测试。

`tools/` 下是验证与实验脚本,跑测试不需要任何依赖:

```
node tools/test_qr.cjs        # 二维码结构(24 项)
node tools/decode_qr.cjs      # 二维码往返解码(版本 1-10、多块交织、中文)
node tools/check_ui.cjs       # 界面结构:内联脚本语法、元素引用、id 唯一性
node tools/test_profiles.mjs  # 档位是否真的改变行为(自己起停代理)
node tools/probe_runner.mjs   # 采样参数对照实验(预热 + 重复 + 顺序轮换)
node tools/health_check.mjs   # 服务健康检测(端口/响应/显存/日志聚集)
```

后两个同时被一个动态 Cordis 插件当作工具后端使用 —— 插件不自己发 HTTP,而是起子进程跑脚本(原因见"沙箱里哪些做不了")。

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
