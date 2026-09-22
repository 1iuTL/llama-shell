// Model + preset catalogue.
// Edit this file to add models or tweak launch flags -- nothing else needs to change.
const path = require('path');

const MODELS_DIR = 'D:\\';

// Where the two llama.cpp builds and the model files live.
// Absolute on purpose: this shell sits beside that tree, not inside it.
const WORKSPACE = 'C:\\deepseek harness\\models';

// Two llama.cpp builds live side by side:
//   prism  - PrismML fork, the ONLY build that can read PTQ1_0 (ternary) weights
//   stock  - upstream ggml-org build, reads standard Q1_0 (1-bit)
const BIN = {
  prism: path.join(WORKSPACE, 'llama-prism', 'llama-server.exe'),
  stock: path.join(WORKSPACE, 'llama-cpp', 'llama-server.exe'),
};

const MMPROJ = 'D:\\Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf';

// Vision adds ~0.9 GiB (projector kept in RAM) plus image tokens, so it is
// paired with a smaller context on an 8 GB card.
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

// Thinking levels the sidebar can request, mapped to llama-server's flag.
//
// This is deliberately user-selectable rather than hardcoded. An earlier
// version pinned `--reasoning-effort medium` unconditionally, which silently
// overrode whatever thinking level the chat UI sent -- picking "high" still
// produced shallow thinking. Pass 'server-default' to send no flag at all and
// let the model's own chat template decide.
const REASONING = {
  'server-default': { label: '跟随模型默认', hint: '不加参数,由模板决定', flag: null },
  off: { label: '关闭思考', hint: '最快,不产出思考内容', flag: 'none' },
  low: { label: '低', hint: '浅思考', flag: 'low' },
  medium: { label: '中', hint: '推荐起点', flag: 'medium' },
  high: { label: '高', hint: '深思考,更慢', flag: 'high' },
};

// Every model here was downloaded and verified in this workspace.
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
    name: '三元版 · 去审查 (Heretic)',
    note: 'PTQ1_0 · 5.54 GB · 拒答率大幅降低',
    file: MODELS_DIR + 'Ternary-Bonsai-2-27B-Heretic-PTQ1_0.gguf',
    bin: BIN.prism,
    defaultPreset: 'text-64k',
  },
  {
    id: 'ternary-abliterated',
    name: '三元版 · 去审查 (Abliterated)',
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
 * Build the llama-server argv for a model + preset.
 *
 * The flags below are the community 8 GB-tier configuration
 * (sudoingX/bonsai2-small-gpu). Each one earns its place:
 *   -fa on              flash attention, drops the compute buffer
 *   -np 1               single slot; extra slots waste ~450 MiB each
 *   -ctk q4_0 -ctv q4_0 KV cache at 1/4 size -- this is what makes 64K fit
 *   --reasoning-effort  this model's template defaults to unbounded thinking,
 *                       which burns the whole context and returns nothing
 *   --jinja             tool calls
 *   --temp/--top-p/--top-k  the model card's thinking-mode sampling values
 */
function buildArgs(model, presetKey, port, reasoningKey) {
  const preset = PRESETS[presetKey];
  if (!preset) throw new Error('unknown preset: ' + presetKey);

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

  // Only sent when the user actually picked a level. 'server-default' leaves the
  // model's own template in charge -- important, because several templates
  // default to their highest level and would otherwise ignore a UI selector.
  if (reasoning.flag) {
    args.push('--reasoning-effort', reasoning.flag);
  }

  if (preset.vision) {
    args.push('--mmproj', MMPROJ, '--no-mmproj-offload', '--image-max-tokens', '1024');
  }
  return args;
}

module.exports = { MODELS, PRESETS, REASONING, BIN, MMPROJ, MODELS_DIR, buildArgs };
