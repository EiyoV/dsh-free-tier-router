/**
 * 渠道发现与体检。
 *
 *   node src/discover.mjs                 体检：哪些已就绪、哪些待你注册、去哪注册
 *   node src/discover.mjs --openrouter    额外实时拉取 OpenRouter 的零价模型（真·自动发现）
 *   node src/discover.mjs --json          机器可读输出（留给 GUI/插件用）
 *
 * 能力边界（别误解）：
 *   - 有公开 JSON API 的渠道（OpenRouter）可以全自动发现新免费模型；
 *   - 文档站是 SPA 的国内渠道（智谱/火山/硅基）抓不到正文，靠 catalog.json 人工维护；
 *   - 任何程序都不能替你注册账号 —— 那要手机号/实名/验证码。
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile, loadConfig } from './config.mjs';
import { resolveCatalogPath, CONFIG_PATH } from './paths.mjs';

// 路径一律走 paths.mjs 的数据目录（~/.dsh/llm-router），不依赖插件的安装位置
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const has = (f) => args.includes(`--${f}`);

const catalog = JSON.parse(readFileSync(resolveCatalogPath(), 'utf8'));
const env = { ...loadEnvFile(), ...process.env };

let config = null;
let configError = null;
try {
  config = loadConfig();
} catch (err) {
  configError = err.message;
}
const providers = config?.providers ?? [];

/** 判断某个目录渠道当前处于什么状态。 */
function assess(ch) {
  if (ch.deprecated) return 'deprecated';
  if (!ch.apiKeyEnv) return 'no-key-needed';
  if (!env[ch.apiKeyEnv]) return 'need-key';
  const matched = providers.filter((p) => p.baseURL && p.baseURL === ch.baseURL);
  if (matched.length === 0) return 'need-config';
  if (matched.every((p) => p.enabled === false)) return 'disabled';
  return 'ready';
}

const LABEL = {
  ready: '✅ 已就绪',
  disabled: '⏸️ 已配置但被禁用',
  'need-config': '⚠️ 有 key 但 config.json 里没有对应渠道',
  'need-key': '⬜ 待你注册',
  deprecated: '🚫 已下线/不该入池',
};

if (configError) {
  console.log(`⚠️  config.json 读取失败：${configError}\n`);
}

const groups = {};
for (const ch of catalog.channels) {
  const st = assess(ch);
  (groups[st] ??= []).push(ch);
}

if (has('json')) {
  console.log(
    JSON.stringify(
      catalog.channels.map((ch) => ({
        id: ch.id,
        label: ch.label,
        state: assess(ch),
        registerUrl: ch.registerUrl ?? null,
        materials: ch.materials ?? null,
        apiKeyEnv: ch.apiKeyEnv ?? null,
        verified: ch.verified ?? null,
        confidence: ch.confidence ?? null,
        caveats: ch.caveats ?? [],
      })),
      null,
      2
    )
  );
  process.exit(0);
}

console.log(`渠道目录（更新于 ${catalog.updated}）\n${'─'.repeat(64)}`);

for (const st of ['ready', 'need-key', 'need-config', 'disabled', 'deprecated']) {
  const list = groups[st];
  if (!list || list.length === 0) continue;
  console.log(`\n${LABEL[st]}  (${list.length})`);

  if (st === 'need-key') {
    // 待注册的按 priorityHint 排序：数字小的先注册，收益最大
    list.sort((a, b) => (a.priorityHint ?? 999) - (b.priorityHint ?? 999));
    let i = 1;
    for (const ch of list) {
      console.log(`\n   ${i}. ${ch.label}`);
      console.log(`      注册：${ch.registerUrl ?? '(未知)'}`);
      console.log(`      需要：${ch.materials ?? '(未知)'}`);
      console.log(`      核实：${ch.verified ?? '(未核实)'}`);
      if (ch.capabilitiesHint) console.log(`      价值：${ch.capabilitiesHint}`);
      if (ch.caveats?.length) for (const c of ch.caveats) console.log(`      ⚠️  ${c}`);
      console.log(`      然后填进 .env：${ch.apiKeyEnv}=你的key`);
      i += 1;
    }
    console.log('\n  （注册完告诉我，我跑 probe 核实它实际支持哪些模型）');
  } else {
    for (const ch of list) {
      console.log(`   · ${ch.label}${ch.deprecated ? ` — ${ch.verified}` : ''}`);
    }
  }
}

const readyCount = (groups.ready ?? []).length;
const pendingCount = (groups['need-key'] ?? []).length;
console.log(`\n${'─'.repeat(64)}`);
console.log(`已就绪 ${readyCount} 个 · 待注册 ${pendingCount} 个`);

// ── OpenRouter 实时发现 ────────────────────────────────────────────────
if (has('openrouter')) {
  console.log(`\n${'─'.repeat(64)}`);
  console.log('OpenRouter 实时零价模型发现（这是唯一能全自动发现的渠道）\n');

  let payload;
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', {
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    payload = await res.json();
  } catch (err) {
    console.log(`  抓取失败：${err?.message ?? err}`);
    console.log('  （OpenRouter 需要海外网络。这一步失败不影响本地 fallback 链。）');
    process.exit(0);
  }

  const all = payload.data ?? [];
  const free = all.filter(
    (m) => Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0
  );
  const hasImg = (m) => (m.architecture?.input_modalities ?? []).includes('image');
  const hasTools = (m) => (m.supported_parameters ?? []).includes('tools');

  const visionTools = free.filter((m) => hasImg(m) && hasTools(m));
  const visionOnly = free.filter((m) => hasImg(m) && !hasTools(m));
  const toolsOnly = free.filter((m) => !hasImg(m) && hasTools(m));

  console.log(`  模型总数 ${all.length}，其中零价 ${free.length}`);
  console.log(`  视觉+工具 ${visionTools.length} · 仅视觉 ${visionOnly.length} · 仅工具 ${toolsOnly.length}`);

  const useful = [...visionTools, ...toolsOnly];
  if (useful.length > 0) {
    console.log('\n  可用于 agent 循环的零价模型（视觉+工具优先）：');
    console.table(
      useful.slice(0, 15).map((m) => ({
        id: m.id,
        视觉: hasImg(m) ? '是' : '否',
        工具: hasTools(m) ? '是' : '否',
        上下文: m.context_length ?? '-',
      }))
    );
  }

  // 和我们 config 里声明的对比
  const configured = providers.find((p) => p.baseURL?.includes('openrouter'));
  const known = new Set(configured?.models ?? []);
  const nowIds = new Set(useful.map((m) => m.id));
  const added = [...nowIds].filter((id) => !known.has(id));
  const gone = [...known].filter((id) => !nowIds.has(id));

  if (known.size > 0) {
    console.log(`\n  与 config.json 已声明的 ${known.size} 个模型对比：`);
    if (added.length) console.log(`    🆕 新可用：${added.join(', ')}`);
    if (gone.length) console.log(`    💀 已消失：${gone.join(', ')}`);
    if (!added.length && !gone.length) console.log('    没有变化');
  } else {
    console.log('\n  config.json 里还没有 openrouter 渠道的模型声明。');
    console.log(`    建议先填这几个（视觉+工具）：${useful.slice(0, 3).map((m) => m.id).join(', ')}`);
  }

  // ── 自动增加：把新发现的零价模型合并进 config.json ──────────────────
  if (has('update')) {
    const cfgPath = CONFIG_PATH;
    if (!existsSync(cfgPath)) {
      console.log('\n  ⚠️ 没有 config.json，无法自动更新（先复制 config.example.json）。');
    } else {
      const raw = JSON.parse(readFileSync(cfgPath, 'utf8'));
      const target = raw.providers?.find((p) => p.baseURL?.includes('openrouter'));
      if (!target) {
        console.log('\n  ⚠️ config.json 里没有 openrouter 渠道，跳过。');
      } else {
        const before = target.models?.length ?? 0;
        if (added.length > 0) {
          target.models = [...new Set([...(target.models ?? []), ...added])];
        }

        // 默认模型优先选「视觉+工具」的。原因：capabilities 是 provider 级的，
        // 如果默认模型是纯文本却声明了 image，带图请求会被路由到这里、然后打到纯文本
        // 模型上 —— 那比不声明这个能力更糟。必须保证默认模型真的撑得起声明出来的能力。
        const preferred = visionTools[0] ?? toolsOnly[0];
        const currentSupportsVision = visionTools.some((m) => m.id === target.defaultModel);
        let defaultNote = '';
        if (preferred && !currentSupportsVision) {
          defaultNote = `${target.defaultModel ?? '(未设置)'} → ${preferred.id}`;
          target.defaultModel = preferred.id;
        }

        const caps = new Set(target.capabilities ?? ['text']);
        const capsBefore = [...caps].sort().join('+');
        if (preferred && hasImg(preferred)) caps.add('image');
        if (preferred && hasTools(preferred)) caps.add('tools');
        target.capabilities = [...caps];
        const capsAfter = [...caps].sort().join('+');

        const modelsAfter = target.models?.length ?? 0;
        const changed = added.length > 0 || defaultNote !== '' || capsBefore !== capsAfter;

        if (!changed) {
          console.log('\n  配置已是最新，无需写入。');
        } else {
          const backupPath = `${cfgPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
          copyFileSync(cfgPath, backupPath);
          writeFileSync(cfgPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
          console.log('\n  ✅ 已写入 config.json');
          if (added.length > 0) {
            console.log(`     模型：${before} → ${modelsAfter} 个（新增 ${added.length}）`);
          }
          if (defaultNote) {
            console.log(`     默认模型：${defaultNote}`);
            console.log('     （换成支持视觉的，否则带图请求会打到纯文本模型上）');
          }
          if (capsBefore !== capsAfter) {
            console.log(`     能力声明：${capsBefore} → ${capsAfter}`);
          }
          console.log(`     备份：${backupPath}`);
          console.log('     重启代理后生效（只改 config.json，模板 config.example.json 未动）');
        }
      }
    }
  }
}
