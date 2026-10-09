/**
 * 抽出 panel.html 里的 <script> 内容做语法检查。
 *
 *   node dsh-plugin/test/check-panel.mjs
 *
 * 为什么需要：panel.html 里的 JS 不进任何构建流程，写错了只有打开页面才发现。
 * 发布前跑一下这个，避免把语法错误一起发出去。
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL = join(HERE, '..', 'dist', 'panel.html');
const CLIENT = join(HERE, '..', 'dist', 'client.js');
const INDEX = join(HERE, '..', 'dist', 'index.js');

const html = readFileSync(PANEL, 'utf8');
const indexJs = readFileSync(INDEX, 'utf8');

// 抓最后一个 <script>...</script>（页面里只有一段内联脚本）
const m = /<script>([\s\S]*?)<\/script>/.exec(html);
if (!m) {
  console.error('panel.html 里没找到 <script> 块');
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), 'panel-check-'));
const jsPath = join(tmp, 'panel-script.js');
writeFileSync(jsPath, m[1], 'utf8');

let pass = 0;
let fail = 0;

function checkFile(label, path) {
  try {
    execFileSync(process.execPath, ['--check', path], { stdio: 'pipe' });
    console.log(`  ✓ ${label} 语法 OK`);
    pass += 1;
    return true;
  } catch (err) {
    console.log(`  ✗ ${label} 语法错误：`);
    console.log(String(err.stderr ?? err.message).split('\n').slice(0, 8).join('\n'));
    fail += 1;
    return false;
  }
}

console.log('面板脚本语法检查：\n');
checkFile('panel.html 内联脚本', jsPath);
checkFile('dist/client.js', CLIENT);

// 顺带做几个"忘了改"的静态检查
function checkContains(label, text, needle, shouldHave) {
  const has = text.includes(needle);
  if (has === shouldHave) {
    console.log(`  ✓ ${label}`);
    pass += 1;
  } else {
    console.log(`  ✗ ${label}（${shouldHave ? '缺少' : '残留'} ${JSON.stringify(needle)}）`);
    fail += 1;
  }
}

console.log('\n静态检查：');
checkContains('面板有摘要容器', html, 'id="summary"', true);
checkContains('面板有恢复时间格式化', html, 'function fmtTime', true);
checkContains('面板有冷却文字逻辑', html, 'function coolingText', true);
checkContains('面板有额度单元格', html, 'function quotaText', true);
checkContains('面板有重置用量按钮', html, 'id="btn-reset-usage"', true);
// 这个漏过一次：面板拿不到 apiKeyEnv 就会把保存按钮写成 data-savekey=""，
// 点保存被接口以"变量名不合法"驳回 —— 用户看到的现象就是"key 填了存不上"。
checkContains(
  'catalog 接口把 apiKeyEnv 传给面板（否则未入池渠道的 key 存不上）',
  indexJs,
  'apiKeyEnv: ch.apiKeyEnv',
  true
);
checkContains('已移除旧的「账号管理」区', html, 'id="accounts"', false);
checkContains('已移除旧的按钮 id', html, 'btn-acct-add', false);

rmSync(tmp, { recursive: true, force: true });

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exitCode = fail === 0 ? 0 : 1;
