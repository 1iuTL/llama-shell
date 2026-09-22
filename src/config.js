// 模型与预设清单。
// 平时只改这个文件就能增删模型、调整启动参数 —— 其它源码不用动。
const path = require('path');

const MODELS_DIR = 'D:\\';

// 三个 llama.cpp 构建:
//   fast  —— 本机从 sudoingX/llama.cpp 的 pr-ptq1-mmv 分支编出来的构建,
//            含 PTQ1_0 专用 mat-vec 内核,针对 sm_120a。
//            实测(三元版 64K,同参数):预填充 332 -> 769 t/s(2.31x),
//            生成 33.5 -> 43.5 t/s(+30%)。读 PTQ1_0(三进制)。
//   prism —— PrismML 官方预编译包,能读 PTQ1_0 但**没有那个内核**,慢。
//            保留作为回退:万一 fast 出问题可以秒切。
//   stock —— ggml-org 上游构建,读标准 Q1_0(1-bit)。
// 路径写成绝对路径是有意的:这个外壳放在那棵目录树**旁边**,不在里面。
const WORKSPACE = 'C:\\deepseek harness\\models';
const FAST_BUILD = 'C:\\deepseek harness\\llama-cpp-mmq\\build\\bin';

const BIN = {
  fast: path.join(FAST_BUILD, 'llama-server.exe'),
  prism: path.join(WORKSPACE, 'llama-prism', 'llama-server.exe'),
  stock: path.join(WORKSPACE, 'llama-cpp', 'llama-server.exe'),
};

const MMPROJ = 'D:\\Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf';

// 视觉能力会多占约 0.9 GiB(投影器放内存)外加图片 token,
// 所以在 8 GB 卡上给它配了更小的上下文。
const PRESETS = {
  'text-64k': {
    label: '长文本 64K',
    hint: '64K 上下文,适合读长文档/代码',
    ctx: 65536,
    vision: false,
    budgetMiB: 8000,
  },
  'text-32k': {
    label: '常规 32K',
    hint: '32K 上下文,显存更宽裕',
    ctx: 32768,
    vision: false,
    budgetMiB: 8000,
  },
  'vision-32k': {
    label: '图片 32K',
    hint: '带视觉投影,可传图片',
    ctx: 32768,
    vision: true,
    budgetMiB: 8000,
  },
  'quick-8k': {
    label: '轻量 8K',
    hint: '8K 上下文,启动最快',
    ctx: 8192,
    vision: false,
    budgetMiB: 8000,
  },
};

// 侧栏可选的思考强度,映射到 llama-server 的参数。
//
// 这里刻意做成**用户可选**而不是写死。早先的版本无条件钉上
// `--reasoning-effort medium`,结果静默覆盖了聊天界面发出的思考档位 ——
// 选了「高」也照样只有浅思考。选 'server-default' 则完全不带参数,
// 由模型自己的聊天模板决定。
const REASONING = {
  'server-default': { label: '跟随模型默认', hint: '不加参数,由模板决定', flag: null },
  off: { label: '关闭思考', hint: '最快,不产出思考内容', flag: 'none' },
  low: { label: '低', hint: '浅思考', flag: 'low' },
  medium: { label: '中', hint: '推荐起点', flag: 'medium' },
  high: { label: '高', hint: '深思考,更慢', flag: 'high' },
};

// 这里的每个模型都已经在本机下载并校验过。
const MODELS = [
  {
    id: 'ternary',
    name: 'Bonsai 2 27B 三元版',
    note: 'PTQ1_0 · 5.54 GB · 质量保留 98.2%',
    file: MODELS_DIR + 'Ternary-Bonsai-2-27B-PTQ1_0.gguf',
    bin: BIN.fast,
    defaultPreset: 'text-64k',
  },
  {
    id: 'ternary-heretic',
    name: '三元版 · 去审查(Heretic)',
    note: 'PTQ1_0 · 5.54 GB · 拒答率大幅降低',
    file: MODELS_DIR + 'Ternary-Bonsai-2-27B-Heretic-PTQ1_0.gguf',
    bin: BIN.fast,
    defaultPreset: 'text-64k',
  },
  {
    id: 'ternary-abliterated',
    name: '三元版 · 去审查(Abliterated)',
    note: 'PTQ1_0 · 5.54 GB · 实测零拒答',
    file: MODELS_DIR + 'Ternary-Bonsai-2-27B-Abliterated-PTQ1_0.gguf',
    bin: BIN.fast,
    defaultPreset: 'text-64k',
  },
  {
    id: 'onbit',
    name: 'Bonsai 27B 1-bit',
    note: 'Q1_0 · 3.54 GB · 最省显存,速度最快',
    file: MODELS_DIR + 'Bonsai-27B-Q1_0.gguf',
    bin: BIN.stock,
    defaultPreset: 'text-64k',
  },
];

/**
 * 为「模型 + 预设」拼出 llama-server 的命令行。
 *
 * 下面这些参数是 8 GB 显存档位的社区配置
 * (sudoingX/bonsai2-small-gpu)。每一条都有理由:
 *   -fa on              flash attention,省掉计算缓冲
 *   -np 1               单槽位;多一个槽位白吃约 450 MiB
 *   -ctk q4_0 -ctv q4_0 KV cache 压到 1/4 —— 64K 能塞进 8GB 全靠这个
 *   --jinja             启用工具调用
 *   --temp/--top-p/--top-k  模型卡推荐的思考模式采样值
 *
 * reasoningKey 的三种取值:
 *   未传 / null / 'server-default' —— 都不加 --reasoning-effort,由模型模板
 *     或聊天界面里那个按对话的控件决定。这是默认行为。
 *   其它已知档位 —— 加对应的 flag。
 *
 * 只有在明确要「服务级固定档位」时才传 reasoningKey。注意服务端 flag 会盖住
 * 界面里按对话设置的档位,因为界面通常以请求参数下发,优先级低于服务端配置。
 *
 * lanMode 为 true 时监听 0.0.0.0,手机才能连上;同网段的人也能连。
 * 默认只监听 127.0.0.1。手机访问的可行做法是让电脑(或手机)开热点,
 * 这样安全边界就是热点本身,不依赖校园网是否允许设备互访。
 *
 * apiKey 非空时加 --api-key,所有接口都要带 Authorization: Bearer <key>。
 *
 * 关于 API Key 与网页界面:llama.cpp 自带的 Web UI **认识**这个 Key ——
 * 检测到 401 会弹一个输入框,校验通过就存进浏览器 localStorage,之后免输。
 * 所以手机只需输一次。注意 / 这个页面本身是放行的(不然连输入框都拿不到),
 * 被挡住的是 /v1/* 与 /props 这些真正的接口。
 */
function buildArgs(model, presetKey, port, reasoningKey, lanMode, apiKey) {
  const preset = PRESETS[presetKey];
  if (!preset) throw new Error('未知的预设: ' + presetKey);

  // 没指定、或指定了「跟随模型默认」,都表示不加参数。
  const reasoning = reasoningKey ? REASONING[reasoningKey] : null;

  const args = [
    '-m', model.file,
    '-c', String(preset.ctx),
    '-ngl', '99',
    '-fa', 'on',
    '-np', '1',
    '-ctk', 'q4_0',
    '-ctv', 'q4_0',
    '--jinja',
    '--temp', '1.0',
    '--top-p', '0.95',
    '--top-k', '20',
    '--host', lanMode ? '0.0.0.0' : '127.0.0.1',
    '--port', String(port),
  ];

  if (reasoning && reasoning.flag) {
    args.push('--reasoning-effort', reasoning.flag);
  }

  // /slots 默认开启,会回报每个槽位正在处理的内容 —— 也就是别人能看到你的提问。
  // 绑到网络上时关掉。
  if (lanMode) args.push('--no-slots');

  // 只在真的设了 Key 时才加。留空表示不鉴权 —— 局域网模式下等于
  // 同网段任何人都能用,界面上必须把这件事说清楚。
  if (apiKey) args.push('--api-key', apiKey);

  if (preset.vision) {
    args.push('--mmproj', MMPROJ, '--no-mmproj-offload', '--image-max-tokens', '1024');
  }
  return args;
}

module.exports = { MODELS, PRESETS, REASONING, BIN, MMPROJ, MODELS_DIR, buildArgs };
