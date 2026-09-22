// 模型与预设清单。
// 平时只改这个文件就能增删模型、调整启动参数 —— 其它源码不用动。
const path = require('path');

const MODELS_DIR = 'D:\\';

// 两个 llama.cpp 构建并排放着:
//   prism —— PrismML 的 fork,是唯一能读 PTQ1_0(三进制)权重的构建
//   stock —— ggml-org 上游构建,读标准 Q1_0(1-bit)
// 路径写成绝对路径是有意的:这个外壳放在那棵目录树**旁边**,不在里面。
const WORKSPACE = 'C:\\deepseek harness\\models';

const BIN = {
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
    bin: BIN.prism,
    defaultPreset: 'text-64k',
  },
  {
    id: 'ternary-heretic',
    name: '三元版 · 去审查(Heretic)',
    note: 'PTQ1_0 · 5.54 GB · 拒答率大幅降低',
    file: MODELS_DIR + 'Ternary-Bonsai-2-27B-Heretic-PTQ1_0.gguf',
    bin: BIN.prism,
    defaultPreset: 'text-64k',
  },
  {
    id: 'ternary-abliterated',
    name: '三元版 · 去审查(Abliterated)',
    note: 'PTQ1_0 · 5.54 GB · 实测零拒答',
    file: MODELS_DIR + 'Ternary-Bonsai-2-27B-Abliterated-PTQ1_0.gguf',
    bin: BIN.prism,
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
 * 思考强度只有在用户明确选了档位时才传。'server-default' 会把参数完全去掉,
 * 交给模型自己的模板 —— 这一点很重要,因为不少模板默认就是最高档,
 * 否则会忽略界面上的选择器。
 */
function buildArgs(model, presetKey, port, reasoningKey) {
  const preset = PRESETS[presetKey];
  if (!preset) throw new Error('未知的预设: ' + presetKey);

  const reasoning = REASONING[reasoningKey] || REASONING['medium'];

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
    '--host', '127.0.0.1',
    '--port', String(port),
  ];

  if (reasoning.flag) {
    args.push('--reasoning-effort', reasoning.flag);
  }

  if (preset.vision) {
    args.push('--mmproj', MMPROJ, '--no-mmproj-offload', '--image-max-tokens', '1024');
  }
  return args;
}

module.exports = { MODELS, PRESETS, REASONING, BIN, MMPROJ, MODELS_DIR, buildArgs };
