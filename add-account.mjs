/**
 * 给某个渠道增加一把 key（多账号）。
 *
 *   node dsh-plugin/add-account.mjs qianfan-text "bce-v3/ALTAK-xxx/yyy"   # 追加一把
 *   node dsh-plugin/add-account.mjs qianfan-text                          # 只看当前有几把
 *   node dsh-plugin/add-account.mjs --list                                # 列出所有渠道的 key 数
 *
 * 会同时改两处：.env 里加一个变量、config.json 里把该渠道升级成 apiKeyEnvs 数组。
 * 请求遇到 401/403/429 时，代理会在**同一个渠道内**换下一把 key 重试。
 *
 * ⚠️ 两个必须知道的事实：
 *   1. 同一个账号创建的多把 key 共享账号额度 —— 多把 key 只在「不同账号」时才有独立额度。
 *   2. 多账号轮换免费额度普遍违反平台条款，有封号风险，后果自负。
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { CONFIG_PATH, ENV_PATH } from './lib/paths.mjs';

const argv = process.argv.slice(2);

function readEnvPairs() {
  const out = {};
  if (!existsSync(ENV_PATH)) return out;
  for (const raw of readFileSync(ENV_PATH, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(raw.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function envNamesOf(p) {
  return Array.isArray(p.apiKeyEnvs) ? p.apiKeyEnvs : p.apiKeyEnv ? [p.apiKeyEnv] : [];
}

const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
const providers = raw.providers ?? [];

// ── 只列状态 ──────────────────────────────────────────────────────────
if (argv.length === 0 || argv[0] === '--list') {
  const env = readEnvPairs();
  console.log(`配置文件：${CONFIG_PATH}`);
  console.log(`密钥文件：${ENV_PATH}\n`);
  for (const p of providers) {
    const names = envNamesOf(p);
    if (names.length === 0) continue;
    const filled = names.filter((n) => env[n]);
    const flag = p.manualOnly ? '[手动]' : '      ';
    console.log(`${flag} ${p.id.padEnd(20)} ${filled.length}/${names.length} 把已填   ${names.join(', ')}`);
  }
  console.log('\n追加一把：node dsh-plugin/add-account.mjs <渠道id> "<key>"');
  process.exit(0);
}

// ── 追加一把 key ──────────────────────────────────────────────────────
const providerId = argv[0];
const value = argv.slice(1).join(' ').trim();

if (!value) {
  console.error('用法：node dsh-plugin/add-account.mjs <渠道id> "<key>"');
  process.exit(1);
}

const target = providers.find((p) => p.id === providerId);
if (!target) {
  console.error(`找不到渠道 "${providerId}"。可用：${providers.map((p) => p.id).join(', ')}`);
  process.exit(1);
}

const names = envNamesOf(target);
if (names.length === 0) {
  console.error(`渠道 ${providerId} 不需要 key（或没配 apiKeyEnv）`);
  process.exit(1);
}

// 下一个变量名：基础名 + _2 / _3 ...
const base = names[0].replace(/_\d+$/, '');
let nextIndex = 2;
while (names.includes(`${base}_${nextIndex}`)) nextIndex += 1;
const newName = `${base}_${nextIndex}`;

// 1) 写 .env
const envText = readFileSync(ENV_PATH, 'utf8').replace(/^\uFEFF/, '');
const envLines = envText.split(/\r?\n/);
let envReplaced = false;
const nextEnv = envLines.map((line) => {
  const m = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
  if (m && m[2] === newName) {
    envReplaced = true;
    return `${newName}=${value}`;
  }
  return line;
});
if (!envReplaced) nextEnv.push(`${newName}=${value}`);
writeFileSync(ENV_PATH, nextEnv.join('\n'), 'utf8'); // 无 BOM

// 2) 改 config.json：升级成 apiKeyEnvs 数组
copyFileSync(CONFIG_PATH, `${CONFIG_PATH}.bak-${Date.now()}`);
target.apiKeyEnvs = [...names, newName];
delete target.apiKeyEnv;
writeFileSync(CONFIG_PATH, `${JSON.stringify(raw, null, 2)}\n`, 'utf8'); // 无 BOM

console.log(`渠道 ${providerId} 增加了第 ${names.length + 1} 把 key`);
console.log(`  .env       ${newName}=<已写入，长度 ${value.length}>`);
console.log(`  config.json apiKeyEnvs = [${target.apiKeyEnvs.join(', ')}]`);
console.log('\n去面板点「重新加载配置」生效。');
console.log('提醒：同账号多 key 共享额度；多账号轮换有封号风险。');
