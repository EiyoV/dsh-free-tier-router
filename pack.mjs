/**
 * 打包成可拷贝到别的电脑的 zip。
 *
 *   node pack.mjs
 *
 * 产物：../dist-package/dsh-free-tier-router-<版本>.zip
 * 目标机器上解压后跑 `node install.mjs` 即可（需要 Node；DSH 自带的那个也行）。
 */
import { mkdirSync, rmSync, cpSync, readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'dist-package');

const pkg = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8'));
const stageName = `${pkg.name}-${pkg.version}`;
const stage = join(OUT_DIR, stageName);
const zipPath = join(OUT_DIR, `${stageName}.zip`);

// 只带运行必需的东西。test/ 带上方便用户自检。
const FILES = [
  'package.json',
  'cordis.patch.yml',
  'README.md',
  'PUBLISHING.md',
  'LICENSE',
  'install.mjs',
  'install.ps1',
];
const DIRS = ['dist', 'lib', 'test'];

/**
 * 不该进包的东西。
 * 特别是 .bak-* —— 自动调优/改配置时会生成备份，**曾经漏进过包里**，
 * 那些文件既没用又可能带着用户的旧配置。
 */
function skip(name) {
  return (
    name.endsWith('.bak') ||
    name.includes('.bak-') ||
    name.endsWith('.log') ||
    name === '.tmp' ||
    name === 'node_modules'
  );
}

console.log(`打包 ${stageName} …`);
rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

for (const f of FILES) {
  const src = join(HERE, f);
  if (!existsSync(src)) {
    console.error(`缺少 ${f}`);
    process.exit(1);
  }
  cpSync(src, join(stage, f));
}
for (const d of DIRS) {
  const src = join(HERE, d);
  if (!existsSync(src)) {
    console.error(`缺少目录 ${d}`);
    process.exit(1);
  }
  cpSync(src, join(stage, d), { recursive: true, filter: (s) => !skip(s.split(/[\\/]/).pop()) });
}

/** 递归算总大小，顺便列一下为打包带了什么。 */
function walk(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p, base));
    else out.push({ rel: p.slice(base.length + 1), size: statSync(p).size });
  }
  return out;
}

const entries = walk(stage);
const total = entries.reduce((a, e) => a + e.size, 0);
console.log(`  ${entries.length} 个文件，共 ${(total / 1024).toFixed(1)} KB`);
for (const e of entries.sort((a, b) => a.rel.localeCompare(b.rel))) {
  console.log(`    ${String(e.size).padStart(7)}  ${e.rel}`);
}

console.log('\n压缩 …');
try {
  execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Compress-Archive -Path '${stage}\\*' -DestinationPath '${zipPath}' -Force`,
    ],
    { stdio: 'inherit' }
  );
} catch (err) {
  console.error('Compress-Archive 失败：', err?.message ?? err);
  console.error(`可以手动压：把 ${stage} 整个目录拷走也一样能用。`);
  process.exit(1);
}

console.log('\n产物：' + zipPath);
console.log('目标机器：解压后在该目录跑 `node install.mjs`');
