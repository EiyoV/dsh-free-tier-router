/**
 * 按实测数据重排渠道优先级（同时作用于当前配置和内置模板）。
 *
 *   node dsh-plugin/tune-priority.mjs
 *
 * 实测依据（2026-10-09，同一个问题「回答两个字：正常」，max_tokens=2048，走代理）：
 *
 *   百炼 qwen-plus      14 token    0.5s   答案正确        ← 最省最快
 *   百炼 qwen-vl-plus             26 token 完成一次识图    ← 视觉也最省
 *   智谱 glm-4.7-flash  177~465 个思考 token，且频繁 429
 *   硅基 Qwen3-8B       386 token  18.5s  也是思考模型，慢到没法交互
 *
 * 结论：百炼当主力，智谱降为备用，硅基再降一级。
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { CONFIG_PATH, DEFAULT_CONFIG_PATH } from './lib/paths.mjs';

const ORDER = {
  'dashscope-text': 10,
  'dashscope-vision': 11,
  'zhipu-text': 20,
  'zhipu-vision': 21,
  'siliconflow': 40,
};

const targets = [CONFIG_PATH, DEFAULT_CONFIG_PATH].filter((p) => existsSync(p));

if (targets.length === 0) {
  console.error('找不到配置文件');
  process.exit(1);
}

for (const path of targets) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const changes = [];

  for (const p of raw.providers ?? []) {
    const want = ORDER[p.id];
    if (want !== undefined && p.priority !== want) {
      changes.push(`${p.id}: ${p.priority} → ${want}`);
      p.priority = want;
    }
  }

  if (changes.length === 0) {
    console.log(`${path}\n  （无需改动）`);
    continue;
  }

  copyFileSync(path, `${path}.bak-${Date.now()}`);
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, 'utf8'); // 无 BOM
  console.log(`${path}`);
  for (const c of changes) console.log(`  ${c}`);
}

console.log('\n去面板点「重新加载配置」让它生效。');
