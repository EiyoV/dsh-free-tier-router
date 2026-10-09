/**
 * 命令行改某个渠道的 key（等价于面板上的「保存 / 替换」）。
 *
 *   node set-key.mjs ZHIPU_API_KEY ab0d...xxxx
 *   node set-key.mjs ZHIPU_API_KEY            # 只显示当前状态，不修改
 *   node set-key.mjs --list                   # 列出所有 key 的填写状态（不显示值）
 *
 * 改完记得在面板上点「重新加载配置」，或者重启 DSH。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { ENV_PATH } from './lib/paths.mjs';

if (!existsSync(ENV_PATH)) {
  console.error(`找不到 ${ENV_PATH}\n先让插件跑一次，它会初始化数据目录。`);
  process.exit(1);
}

const argv = process.argv.slice(2);

function readPairs(text) {
  const out = [];
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(raw.trim());
    if (m) out.push([m[1], m[2]]);
  }
  return out;
}

const text = readFileSync(ENV_PATH, 'utf8');

if (argv[0] === '--list' || argv.length === 0) {
  console.log(`密钥文件：${ENV_PATH}\n`);
  for (const [k, v] of readPairs(text)) {
    console.log(`  ${(v ? '[已填]' : '[空]  ')} ${k.padEnd(22)}${v ? `长度 ${v.length}` : ''}`);
  }
  if (argv.length === 0) {
    console.log('\n用法：node set-key.mjs <变量名> <值>');
  }
  process.exit(0);
}

const name = argv[0];
const value = argv.slice(1).join(' ').trim();

if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
  console.error(`变量名不合法：${name}`);
  process.exit(1);
}

if (!value) {
  const cur = readPairs(text).find(([k]) => k === name);
  if (!cur) {
    console.error(`.env 里没有 ${name} 这一行`);
    process.exit(1);
  }
  console.log(`${name}：${cur[1] ? `已填（长度 ${cur[1].length}）` : '空'}`);
  process.exit(0);
}

const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
let replaced = false;
const next = lines.map((line) => {
  const m = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
  if (m && m[2] === name) {
    replaced = true;
    return `${name}=${value}`;
  }
  return line;
});
if (!replaced) next.push(`${name}=${value}`);

writeFileSync(ENV_PATH, next.join('\n'), 'utf8'); // 无 BOM

console.log(`${name} 已${replaced ? '替换' : '新增'}（长度 ${value.length}）`);
console.log('去面板点「重新加载配置」让它生效。');
