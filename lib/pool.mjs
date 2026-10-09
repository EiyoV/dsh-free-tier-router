/**
 * 候选选择：把一个请求映射成"按顺序该试哪些上游"。
 *
 * 排序规则（确定性的，便于复现问题）：
 *   1. 能力过滤 —— 请求带图片就只留声明了 image 的渠道，带 tools 就只留声明了 tools 的渠道。
 *      这一步是刚需：往纯文本渠道发图片，通义/火山这种会 200 然后瞎编，比报错更危险。
 *   2. priority 升序 —— 数字小的先用（免费额度排前面，本地/付费排后面）。
 *   3. 跳过正在冷却的渠道；全都在冷却时按 policy.onAllCooling 兜底。
 */

/**
 * 从请求体推断它需要哪些能力。
 * @returns {Set<'image'|'tools'>}
 */
export function inferNeeds(body) {
  const needs = new Set();
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (const m of messages) {
    const content = m?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const t = part?.type;
      if (t === 'image_url' || t === 'image' || t === 'input_image') needs.add('image');
    }
  }
  if (Array.isArray(body?.tools) && body.tools.length > 0) needs.add('tools');
  if (Array.isArray(body?.functions) && body.functions.length > 0) needs.add('tools');
  return needs;
}

function hasCapabilities(provider, needs) {
  for (const need of needs) {
    if (!provider.capabilities.includes(need)) return false;
  }
  return true;
}

function pickModel(provider, spec) {
  if (spec.kind === 'exact' || spec.kind === 'model') return spec.model;
  // auto：优先 defaultModel，否则第一个声明的模型
  return provider.defaultModel ?? provider.models[0] ?? null;
}

/**
 * @param {object} args
 * @param {Array<object>} args.providers 已通过 isConfigured 过滤的渠道
 * @param {import('./health.mjs').HealthRegistry} args.health
 * @param {object} args.spec parseModelSpec 的结果
 * @param {Set<string>} args.needs
 * @param {object} args.policy
 * @returns {{candidates:Array<{provider:object,model:string,forced:boolean,cooling:boolean}>, rejected:Array<{id:string,why:string}>}}
 */
export function selectCandidates({ providers, health, spec, needs, policy }) {
  const rejected = [];

  // 1) 先按 spec 收窄
  let pool = providers;
  if (spec.kind === 'exact') {
    // 显式点名：manualOnly 也放行 —— 那正是它存在的用法
    pool = providers.filter((p) => p.id === spec.providerId);
  } else if (spec.kind === 'model') {
    pool = providers.filter((p) => p.models.includes(spec.model) || p.defaultModel === spec.model);
  } else {
    // auto：跳过标记为"仅手动"的渠道（通常是付费渠道），
    // 免得自动 fallback 一路试到付费渠道上，产生意外费用。
    pool = providers.filter((p) => {
      if (p.manualOnly) {
        rejected.push({ id: p.id, why: '标记为仅手动使用（auto 模式跳过）' });
        return false;
      }
      return true;
    });
  }

  // 2) 能力过滤
  const capable = [];
  for (const p of pool) {
    if (hasCapabilities(p, needs)) capable.push(p);
    else rejected.push({ id: p.id, why: `缺少能力 [${[...needs].join(', ')}]` });
  }

  // 3) 排序 + 冷却判定
  const ordered = capable
    .map((p) => ({ provider: p, model: pickModel(p, spec) }))
    .filter((c) => {
      if (!c.model) {
        rejected.push({ id: c.provider.id, why: '没有可用模型' });
        return false;
      }
      return true;
    })
    .sort((a, b) => a.provider.priority - b.provider.priority);

  let candidates = ordered.map((c) => ({
    ...c,
    forced: false,
    cooling: !health.isAvailable(c.provider.id),
  }));

  const ready = candidates.filter((c) => !c.cooling);
  if (ready.length > 0) {
    return { candidates: ready, rejected };
  }

  // 全在冷却：按策略兜底
  const mode = policy.onAllCooling ?? 'force-local';
  if (mode === 'fail') return { candidates: [], rejected };

  if (mode === 'force-local') {
    const local = candidates.filter((c) => c.provider.isLocal);
    if (local.length > 0) {
      return { candidates: local.map((c) => ({ ...c, forced: true })), rejected };
    }
  }

  // force-local 但没有本地渠道，或 force-any：挑冷却时间最短的
  const sorted = [...candidates].sort(
    (a, b) => health.retryAfterMs(a.provider.id) - health.retryAfterMs(b.provider.id)
  );
  return { candidates: sorted.slice(0, 2).map((c) => ({ ...c, forced: true })), rejected };
}

/** 人类可读的候选摘要，进日志用。 */
export function describeCandidates(candidates) {
  if (candidates.length === 0) return '(无可用上游)';
  return candidates
    .map((c) => `${c.provider.id}${c.model ? `/${c.model}` : ''}${c.forced ? '(强制)' : ''}`)
    .join(' → ');
}
