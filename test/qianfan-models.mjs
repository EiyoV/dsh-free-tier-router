/**
 * 试出百度千帆到底能用哪个模型名。
 *
 *   node dsh-plugin/test/qianfan-models.mjs
 *
 * 千帆 v2 是 OpenAI 兼容端点，但模型名跟别家不一样，而且要先在控制台开通对应模型，
 * 所以只能逐个试。这里只打印状态码和结论，不打印 key。
 */
import { readFileSync } from 'node:fs';
import { ENV_PATH } from '../lib/paths.mjs';

const env = {};
for (const line of readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && m[2]) env[m[1]] = m[2];
}

const key = env.QIANFAN_API_KEY;
if (!key) {
  console.error('没有 QIANFAN_API_KEY');
  process.exit(1);
}

console.log(`key 长度 ${key.length}，前缀 ${JSON.stringify(key.slice(0, 6))}\n`);

// 千帆 v2 的 OpenAI 兼容端点
const URL = 'https://qianfan.baidubce.com/v2/chat/completions';

const candidates = [
  'ernie-4.5-turbo-128k',
  'ernie-4.5-turbo-vl',
  'ernie-4.0-turbo-8k',
  'ernie-4.0-8k',
  'ernie-3.5-8k',
  'ernie-speed-128k',
  'ernie-speed-8k',
  'ernie-lite-8k',
  'deepseek-v3',
  'deepseek-r1',
];

const ok = [];
for (const model of candidates) {
  const started = Date.now();
  try {
    const r = await fetch(URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: '回答两个字：正常' }],
        max_tokens: 256,
      }),
      signal: AbortSignal.timeout(45000),
    });
    const j = await r.json().catch(() => null);
    const ms = Date.now() - started;
    const content = j?.choices?.[0]?.message?.content;
    const errMsg = j?.error?.message ?? j?.error?.code ?? '';
    if (r.ok) {
      ok.push(model);
      console.log(`✓ ${model.padEnd(24)} ${r.status}  ${ms}ms  tokens=${j?.usage?.total_tokens ?? '?'}  回答=${JSON.stringify(String(content ?? '').slice(0, 16))}`);
    } else {
      console.log(`✗ ${model.padEnd(24)} ${r.status}  ${ms}ms  ${String(errMsg).slice(0, 90)}`);
    }
  } catch (err) {
    console.log(`✗ ${model.padEnd(24)} ERR   ${err?.message ?? err}`);
  }
}

console.log('');
if (ok.length === 0) {
  console.log('没有任何模型可用。可能原因：');
  console.log('  · key 不对，或用的是旧版 AK/SK 而不是 v2 的 API Key');
  console.log('  · 还没在千帆控制台「开通」任何模型服务');
  console.log('  · 账号实名/代金券状态问题');
} else {
  console.log(`可用模型 ${ok.length} 个：${ok.join(', ')}`);
  console.log('把最省的那个填进 config.json 的 qianfan 渠道。');
}
