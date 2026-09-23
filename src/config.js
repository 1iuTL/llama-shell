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

// 思考强度的 token 上限。
//
// llama-server 的 --reasoning-budget 默认是 **-1(无限)**。这是一道**保险**,
// 不是常态约束。
//
// 但要看清它的作用边界:实测这类极低比特量化模型的退化是**随机**的
// (同一配置 3 次里 1 次正常、2 次塌缩成连续斜杠),而且**降温、加重复惩罚
// 都不能改善**(temp 0.6 反而 3/3 全崩)。所以预算只能限制"崩多久",
// 不能减少"崩不崩"。真正的解法是换模型或关掉思考,见 README。
//
// 注意别把它和"思考档位"混为一谈:档位由 --reasoning-effort 控制,预算只
// 限制总长度。两者独立。
const REASONING_BUDGETS = [
  { key: 'unlimited', label: '不限', hint: '不干预,完全由模型自己决定何时停', value: -1 },
  { key: '8192', label: '8K', hint: '较紧,适合快问快答', value: 8192 },
  { key: '32768', label: '32K', hint: '推荐:难题够用,又能兜住失控', value: 32768 },
  { key: '65536', label: '64K', hint: '几乎等同不限', value: 65536 },
];

const DEFAULT_REASONING_BUDGET = '32768';

// 预算耗尽时**不做**任何注入。
//
// 这里原本有一条中文提示语("思考预算已用完,请立即基于已有分析给出最终答案"),
// 实测它是**退化触发器**:同一模型、同一提示词、同一采样参数下,
//   - 加上它:reasoning 1026 字符里 1016 个是 '/' (99%),content 为空,答不出
//   - 去掉它:reasoning 仅 29 字符,内容正常,正常作答
// 复现 100% 稳定。原因大概是这类量化模型对输入扰动极敏感,一段固定的长中文串
// 会把它推入重复塌缩。
//
// 所以预算只做"截断",不做"提醒":宁可停在思考中途,也不要因为一句提示
// 把整轮输出废掉。
const REASONING_BUDGET_MESSAGE = null;

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
//
// 关于 PTQ1_0 那三个:实测它们在**思考模式下会塌缩**。同一个提示词
// ("1+1等于几")、同一套参数,reasoning 会变成 1000 多个连续的 '/'
// 且 content 为空 —— 完全答不出。两个不同问题各复现一次,3 次试验里 1 次
// 直接崩、两次侥幸通过。
//
// 而 Q1_0 恰恰相反:3/3 正常,reasoning 有完整的分步分析(含自检),
// 两个问题都给出正确答案,且几乎没有重复。
//
// 所以**默认用 Q1_0**。这不是比特数的问题(Q1_0 位数更低反而更稳),
// 更像是 PTQ1_0 这个较新的三值格式在该模型上实现不佳。
const MODELS = [
  {
    id: 'onbit',
    name: 'Bonsai 27B 1-bit',
    note: 'Q1_0 · 3.54 GB · 实测稳定,默认推荐',
    file: MODELS_DIR + 'Bonsai-27B-Q1_0.gguf',
    bin: BIN.stock,
    defaultPreset: 'text-64k',
  },
  {
    id: 'ternary',
    name: 'Bonsai 2 27B 三元版',
    note: 'PTQ1_0 · 5.54 GB · 思考模式会塌缩成重复字符,不推荐',
    file: MODELS_DIR + 'Ternary-Bonsai-2-27B-PTQ1_0.gguf',
    bin: BIN.fast,
    defaultPreset: 'text-64k',
    warn: '实测:思考模式下 reasoning 会变成上千个连续的 /,且给不出答案。',
  },
  {
    id: 'ternary-heretic',
    name: '三元版 · 去审查(Heretic)',
    note: 'PTQ1_0 · 5.54 GB · 同样存在塌缩问题,不推荐',
    file: MODELS_DIR + 'Ternary-Bonsai-2-27B-Heretic-PTQ1_0.gguf',
    bin: BIN.fast,
    defaultPreset: 'text-64k',
    warn: '实测:思考模式下会塌缩成重复字符。若要用,建议把思考设为「关闭」。',
  },
  {
    id: 'ternary-abliterated',
    name: '三元版 · 去审查(Abliterated)',
    note: 'PTQ1_0 · 5.54 GB · 未单独复测,但同属该量化',
    file: MODELS_DIR + 'Ternary-Bonsai-2-27B-Abliterated-PTQ1_0.gguf',
    bin: BIN.fast,
    defaultPreset: 'text-64k',
    warn: '与前两个同属 PTQ1_0,大概率有同样的塌缩问题。',
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
 * 另外按 reasoningBudgetKey 加 --reasoning-budget。这是一道保险,防止模型
 * 陷入重复生成后停不下来;默认 32K,想完全不干预可以选「不限」。
 * 详见 REASONING_BUDGETS 的注释。
 *
 * 关于 API Key 与网页界面:llama.cpp 自带的 Web UI **认识**这个 Key ——
 * 检测到 401 会弹一个输入框,校验通过就存进浏览器 localStorage,之后免输。
 * 所以手机只需输一次。注意 / 这个页面本身是放行的(不然连输入框都拿不到),
 * 被挡住的是 /v1/* 与 /props 这些真正的接口。
 */
function buildArgs(model, presetKey, port, reasoningKey, lanMode, apiKey, budgetKey) {
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

  // 思考预算。'off' 档位下模型本就不思考,不必加。
  // 预算为 -1(不限)时也不加参数,保持 llama-server 默认行为。
  if (reasoningKey !== 'off') {
    const budget = resolveBudget(budgetKey);
    if (budget.value >= 0) {
      args.push('--reasoning-budget', String(budget.value));
      // 提示语默认是 null(实测它会诱发退化),只有显式配置了才加。
      if (REASONING_BUDGET_MESSAGE) {
        args.push('--reasoning-budget-message', REASONING_BUDGET_MESSAGE);
      }
    }
  }

  // 只在真的设了 Key 时才加。留空表示不鉴权 —— 局域网模式下等于
  // 同网段任何人都能用,界面上必须把这件事说清楚。
  if (apiKey) args.push('--api-key', apiKey);

  if (preset.vision) {
    args.push('--mmproj', MMPROJ, '--no-mmproj-offload', '--image-max-tokens', '1024');
  }
  return args;
}

/** 把预算键名解析成具体档位;键名缺失或无效时回落到默认档。 */
function resolveBudget(key) {
  if (key) {
    const hit = REASONING_BUDGETS.find((b) => b.key === key);
    if (hit) return hit;
  }
  return REASONING_BUDGETS.find((b) => b.key === DEFAULT_REASONING_BUDGET) || REASONING_BUDGETS[0];
}

module.exports = {
  MODELS, PRESETS, REASONING, REASONING_BUDGETS, DEFAULT_REASONING_BUDGET,
  BIN, MMPROJ, MODELS_DIR, buildArgs, resolveBudget,
};
