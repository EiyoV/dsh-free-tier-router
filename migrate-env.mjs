/**
 * 把项目目录 .env 里已填好的 key 迁到插件的用户数据目录（~/.dsh/llm-router/.env）。
 * 只搬非空值，保留数据目录里那份模板的注释结构。
 *
 *   node dsh-plugin/migrate-env.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', '.env');
const DST = join(homedir(), '.dsh', 'llm-router', '.env');

function parse(text) {
  const out = {};
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m && m[2] !== '') out[m[1]] = m[2];
  }
  return out;
}

if (!existsSync(SRC)) {
  console.log(`源文件不存在，跳过：${SRC}`);
  process.exit(0);
}
if (!existsSync(DST)) {
  console.error(`目标不存在：${DST}\n先让插件跑一次（它会初始化数据目录），或手动建这个文件。`);
  process.exit(1);
}

const src = parse(readFileSync(SRC, 'utf8'));
const names = Object.keys(src);
if (names.length === 0) {
  console.log('源 .env 里没有已填的 key，没什么要迁的。');
  process.exit(0);
}

const lines = readFileSync(DST, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
const done = new Set();
const next = lines.map((line) => {
  const m = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
  if (m && src[m[2]] !== undefined) {
    done.add(m[2]);
    return `${m[2]}=${src[m[2]]}`;
  }
  return line;
});
const appended = names.filter((n) => !done.has(n));

let text = next.join('\n');
if (appended.length > 0) {
  text += `\n# ── 迁移自项目 .env ──\n${appended.map((n) => `${n}=${src[n]}`).join('\n')}\n`;
}
writeFileSync(DST, text, 'utf8'); // 无 BOM

console.log(`已迁移 ${names.length} 个 key 到 ${DST}`);
for (const n of names) console.log(`  · ${n}（长度 ${src[n].length}）`);
console.log('\n重启 DSH 后，插件会读这份配置。');
