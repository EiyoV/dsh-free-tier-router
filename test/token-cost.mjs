/**
 * 同一个问题在不同渠道上的 token 开销对比 —— 用来回答"什么任务派给谁最省"。
 *
 *   node dsh-plugin/test/token-cost.mjs
 *
 * 走正在运行的代理（8787），用 exact 模式锁定单个渠道，避免 fallback 干扰对比。
 */
const BASE = process.env.LLM_ROUTER_BASE ?? 'http://127.0.0.1:8787';
const URL = `${BASE}/v1/chat/completions`;

const targets = [
  { label: '智谱 glm-4.7-flash', model: 'zhipu-text::glm-4.7-flash' },
  { label: '百炼 qwen-plus', model: 'dashscope-text::qwen-plus' },
  { label: '硅基 Qwen3-8B', model: 'siliconflow::Qwen/Qwen3-8B' },
  { label: 'OpenRouter dots-3', model: 'openrouter::dots-studio/dots-3-note-preview:free' },
];

const PROMPT = '回答两个字：正常';

const rows = [];
for (const t of targets) {
  const started = Date.now();
  try {
    const r = await fetch(URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: t.model,
        messages: [{ role: 'user', content: PROMPT }],
        max_tokens: 2048,
      }),
      signal: AbortSignal.timeout(90000),
    });
    const j = await r.json().catch(() => null);
    const u = j?.usage;
    const content = j?.choices?.[0]?.message?.content;
    rows.push({
      渠道: t.label,
      HTTP: r.status,
      耗时: `${Date.now() - started}ms`,
      输入: u?.prompt_tokens ?? '-',
      输出: u?.completion_tokens ?? '-',
      思考: u?.completion_tokens_details?.reasoning_tokens ?? 0,
      合计: u?.total_tokens ?? '-',
      回答: String(content ?? j?.error?.message ?? '').replace(/\s+/g, ' ').slice(0, 20) || '(空)',
    });
  } catch (err) {
    rows.push({
      渠道: t.label,
      HTTP: 'ERR',
      耗时: `${Date.now() - started}ms`,
      输入: '-',
      输出: '-',
      思考: '-',
      合计: '-',
      回答: String(err?.message ?? err).slice(0, 28),
    });
  }
}

console.log(`同一个问题：「${PROMPT}」   max_tokens=2048\n`);
console.table(rows);

console.log('\n要点：');
console.log('  ·「思考」是推理 token —— 它和正文共享 max_tokens 预算，且真实计入用量。');
console.log('  · 思考型模型在简单任务上等于白烧额度：同样两个字，开销能差一个数量级。');
console.log('  · 选渠道不只看免费，还要看「每件事花多少 token」。');
