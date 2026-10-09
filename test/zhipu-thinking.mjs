/**
 * 实测：智谱 glm-4.7-flash 的思考能不能关掉，以及它到底能不能给出正文。
 *
 *   node dsh-plugin/test/zhipu-thinking.mjs
 *
 * 背景：它是思考模型，512 token 全被 reasoning_content 吃掉、content 为空。
 * 如果每次调用都白烧几百上千个 reasoning token，那对"省 token"是致命的。
 */
import { readFileSync } from 'node:fs';
import { ENV_PATH } from '../lib/paths.mjs';

const env = {};
for (const line of readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && m[2]) env[m[1]] = m[2];
}

const key = env.ZHIPU_API_KEY;
if (!key) {
  console.error('没有 ZHIPU_API_KEY');
  process.exit(1);
}

const URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';

const cases = [
  ['基线 max_tokens=512', { max_tokens: 512 }],
  ['放大 max_tokens=4096', { max_tokens: 4096 }],
  ['thinking:{type:disabled}', { max_tokens: 512, thinking: { type: 'disabled' } }],
  ['enable_thinking:false', { max_tokens: 512, enable_thinking: false }],
  ['reasoning_effort:none', { max_tokens: 512, reasoning_effort: 'none' }],
];

for (const [name, extra] of cases) {
  try {
    const r = await fetch(URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: 'glm-4.7-flash',
        messages: [{ role: 'user', content: '回答两个字：正常' }],
        ...extra,
      }),
      signal: AbortSignal.timeout(90000),
    });
    const j = await r.json().catch(() => null);
    const msg = j?.choices?.[0]?.message;
    console.log(`【${name}】`);
    console.log(
      `  HTTP ${r.status}  finish=${j?.choices?.[0]?.finish_reason ?? '?'}  usage=${JSON.stringify(j?.usage ?? null)}`
    );
    console.log(`  content   = ${JSON.stringify(String(msg?.content ?? '').slice(0, 50))}`);
    console.log(`  reasoning = 长度 ${String(msg?.reasoning_content ?? '').length}`);
    if (!r.ok) console.log(`  错误: ${JSON.stringify(j?.error ?? j).slice(0, 200)}`);
    console.log('');
  } catch (err) {
    console.log(`【${name}】抛错：${err?.message ?? err}\n`);
  }
}
