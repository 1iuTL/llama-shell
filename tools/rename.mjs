// 批量改名:model-stove -> model-stove
// 用 Node 而不是 PowerShell 做文本替换 —— PowerShell 默认按 ANSI 读写会把中文搞成乱码。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SKIP = /[\\/](node_modules|\.git|logs)[\\/]/;

// 注意顺序:先处理带 .ico 的,再处理裸名字,避免二次替换
const RULES = [
  ['model-stove.ico', 'model-stove.ico'],
  ['model-stove', 'model-stove'],
  ['model_stove_', 'model_stove_'],
  ['MODEL_STOVE_', 'MODEL_STOVE_'],
  ['Model Stove', 'Model Stove'],
];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (SKIP.test(full)) continue;
    if (e.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const TEXT_EXT = /\.(js|mjs|py|json|md|html|bat|txt|yml|yaml|gitignore|LICENSE)$/i;
let changed = 0;

for (const file of walk(ROOT)) {
  const base = path.basename(file);
  if (!TEXT_EXT.test(base) && base !== 'LICENSE') continue;
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
  let next = text;
  for (const [from, to] of RULES) next = next.split(from).join(to);
  if (next !== text) {
    fs.writeFileSync(file, next, 'utf8');
    console.log('  改写 ' + path.relative(ROOT, file));
    changed++;
  }
}

// 图标文件本身改名
const icoOld = path.join(ROOT, 'model-stove.ico');
const icoNew = path.join(ROOT, 'model-stove.ico');
if (fs.existsSync(icoOld)) {
  fs.renameSync(icoOld, icoNew);
  console.log('  重命名 model-stove.ico -> model-stove.ico');
  changed++;
}

console.log('\n共 ' + changed + ' 处改动');
