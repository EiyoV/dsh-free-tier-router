/**
 * 探索：各平台有没有"查剩余额度"的公开接口。
 *
 *   node dsh-plugin/test/balance-probe.mjs
 *
 * 结论会决定面板上能不能显示"还剩多少额度"。查不到就是查不到，不编数字。
 */
import { readFileSync } from 'node:fs';
import { ENV_PATH } from '../lib/paths.mjs';

const env = {};
for (const line of readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && m[2]) env[m[1]] = m[2];
}

/** 试一个 GET 端点，返回 { status, body } 或抛错。 */
async function probeKeys(label, url, key) {
  if (!key) {
    console.log(`· ${label.padEnd(16)} 没填 key，跳过`);
    return;
  }
  try {
    const r = await fetch(url, {
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    const text = (await r.text()).slice(0, 400);
    console.log(`· ${label.padEnd(16)} HTTP ${r.status}  ${text.replace(/\s+/g, ' ')}`);
  } catch (err) {
    console.log(`· ${label.padEnd(16)} 失败：${err?.message ?? err}`);
  }
}

console.log('探测各平台是否有"查额度"接口\n');

// OpenRouter 有公开的 key/credits 接口（官方文档）
await probeKeys('OpenRouter/key', 'https://openrouter.ai/api/v1/key', env.OPENROUTER_API_KEY);
await probeKeys('OpenRouter/credits', 'https://openrouter.ai/api/v1/credits', env.OPENROUTER_API_KEY);

// 硅基流动：常见的是 /v1/user/info（不一定存在）
await probeKeys('硅基流动/user', 'https://api.siliconflow.cn/v1/user/info', env.SILICONFLOW_API_KEY);

// 智谱：没有公开的余额接口，试一下 models 列表看是否至少能列模型
await probeKeys('智谱/models', 'https://open.bigmodel.cn/api/paas/v4/models', env.ZHIPU_API_KEY);

// 百炼：试 OpenAI 兼容的 models 列表
await probeKeys('百炼/models', 'https://dashscope.aliyuncs.com/compatible-mode/v1/models', env.DASHSCOPE_API_KEY);

// 千帆：试 models 列表
await probeKeys('千帆/models', 'https://qianfan.baidubce.com/v2/models', env.QIANFAN_API_KEY);

console.log('\n说明：返回 200 且带余额字段的，才可能显示"还剩多少"；');
console.log('      返回 200 只列出模型的，只能用来核实模型名，不能算额度。');
console.log('      404/403 表示该平台没有这个接口。');
