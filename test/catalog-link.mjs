/**
 * 验证「平台 ↔ 池中渠道」的关联逻辑：面板上"一个平台一张卡"就是靠它把
 * catalog.json 的渠道信息和 config.json 的 provider 对上的。
 *
 *   node dsh-plugin/test/catalog-link.mjs
 *
 * 关联规则：baseURL 完全相同。对不上的平台在面板上会显示成"未配置"。
 */
import { readFileSync } from 'node:fs';
import { resolveCatalogPath, CONFIG_PATH } from '../lib/paths.mjs';

const catalog = JSON.parse(readFileSync(resolveCatalogPath(), 'utf8'));
const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));

const envNamesOf = (p) =>
  Array.isArray(p.apiKeyEnvs) ? p.apiKeyEnvs : p.apiKeyEnv ? [p.apiKeyEnv] : [];

let inPool = 0;
let notInPool = 0;
let noBaseUrl = 0;
let searchOnly = 0;

console.log('平台 → 池中渠道（关联依据：baseURL 相同）\n');

for (const ch of catalog.channels ?? []) {
  if (ch.deprecated) {
    console.log(`🚫 ${(ch.label ?? '').padEnd(30)} (已下线，不参与)`);
    continue;
  }
  if (!ch.baseURL) {
    // 搜索类渠道（Tavily）按设计**就不该有 baseURL**：它不进模型路由，关联上反而会被
    // probe / discover-apply 当成 chat 渠道。所以单独归类，别报成「忘了写 baseURL 的缺陷」。
    if (ch.category === 'search') {
      console.log(`🔍 ${(ch.label ?? '').padEnd(30)} 搜索类渠道 · 不参与模型路由（按设计无 baseURL）`);
      searchOnly += 1;
      continue;
    }
    console.log(`⚠️  ${(ch.label ?? '').padEnd(30)} 目录里没写 baseURL，无法关联`);
    noBaseUrl += 1;
    continue;
  }

  const matched = cfg.providers.filter((p) => p.baseURL === ch.baseURL);
  if (matched.length === 0) {
    console.log(`⬜ ${(ch.label ?? '').padEnd(30)} → 未入池`);
    notInPool += 1;
    continue;
  }

  const keys = [...new Set(matched.flatMap(envNamesOf))];
  const detail = matched
    .map((p) => `${p.id}#${p.priority}${p.enabled === false ? '(禁用)' : ''}${p.manualOnly ? '[手动]' : ''}`)
    .join(', ');
  console.log(`✅ ${(ch.label ?? '').padEnd(30)} → ${detail}`);
  console.log(`   ${' '.repeat(32)}key 槽位: ${keys.join(', ') || '(无)'}`);
  inPool += 1;
}

console.log(`\n已入池 ${inPool} 个 · 未入池 ${notInPool} 个 · 搜索类 ${searchOnly} 个 · 缺 baseURL ${noBaseUrl} 个`);

if (noBaseUrl > 0) {
  console.log('\n提示：缺 baseURL 的渠道在面板上无法关联到池中渠道，需要给 catalog.json 补上 baseURL（category=search 的搜索类按设计不适用，已被单独归类）。');
}
process.exitCode = inPool > 0 ? 0 : 1;
