/**
 * 发布前扫描：包里不该出现任何真实密钥。
 *
 *   node dsh-plugin/test/check-secrets.mjs
 *
 * 这是发布流程的**安全门** —— 一旦把用户的 key 打进包里发出去，就再也收不回来了。
 * 扫描范围是要发布的那些文件（dist / lib / *.mjs / cordis.patch.yml / README 等）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

// 各家 key 的形态特征。宁可误报也不能漏报。
const PATTERNS = [
  { name: '火山/方舟 key', re: /ark-[0-9a-f]{8,}/gi },
  { name: 'OpenAI/DeepSeek 风格 key', re: /sk-[A-Za-z0-9_-]{20,}/g },
  { name: '百度千帆 API Key', re: /bce-v3\/ALTAK-[A-Za-z0-9_/-]{10,}/g },
  { name: '百度 AK', re: /\bALTAK[A-Za-z0-9]{10,}/g },
  { name: '智谱 key（id.secret）', re: /\b[0-9a-f]{32}\.[A-Za-z0-9]{8,}/g },
];

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist-package', '.tmp']);
const SCAN_EXT = new Set(['.js', '.mjs', '.json', '.yml', '.yaml', '.html', '.md', '.ps1', '.cmd', '.txt']);

/** 这些是文档/模板里故意写的假占位符，不算泄露。 */
const ALLOW = [
  /sk-\.\.\./i,
  /ark-\.\.\./i,
  /bce-v3\/ALTAK-xxx/i,
  /ALTAK-xxx/i,
  /sk-b3\d*\.\.\./i,
  /xxxxx/i,
  /你的key/i,
  /<key>/i,
];

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(join(dir, e.name), out);
    } else if (SCAN_EXT.has(extname(e.name))) {
      out.push(join(dir, e.name));
    }
  }
  return out;
}

const files = walk(ROOT);
const hits = [];

for (const file of files) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  for (const { name, re } of PATTERNS) {
    re.lastIndex = 0;
    const m = re.exec(text);
    if (!m) continue;
    const found = m[0];
    if (ALLOW.some((a) => a.test(found))) continue;
    // 行号便于定位
    const line = text.slice(0, m.index).split('\n').length;
    hits.push({
      file: relative(ROOT, file),
      line,
      kind: name,
      sample: found.slice(0, 12) + '…',
    });
  }
}

console.log(`扫描 ${files.length} 个文件（发布范围）\n`);

if (hits.length === 0) {
  console.log('  ✓ 没有发现真实密钥');
  console.log('\n通过 1 项，失败 0 项');
  process.exitCode = 0;
} else {
  console.log('  ✗ 发现疑似密钥，**不要发布**：\n');
  for (const h of hits) {
    console.log(`    ${h.file}:${h.line}  [${h.kind}]  ${h.sample}`);
  }
  console.log('\n处理办法：把值改成从 .env 读取，或换成文档里的占位符。');
  console.log('通过 0 项，失败 1 项');
  process.exitCode = 1;
}
