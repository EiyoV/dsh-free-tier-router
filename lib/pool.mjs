/**
 * 候选选择：把一个请求映射成"按顺序该试哪些上游"。
 *
 * 排序规则（确定性的，便于复现问题）：
 *   1. 能力过滤 —— 请求带图片就只留声明了 image 的渠道，带 tools 就只留声明了 tools 的渠道。
 *      这一步是刚需：往纯文本渠道发图片，通义/火山这种会 200 然后瞎编，比报错更危险。
 *   2. 额度熔断 —— 达到硬阈值的渠道直接剔除（防超额、防按量付费欠费），
 *      达到软阈值的只降到队尾（还有额度，不该浪费）。见 budget.mjs。
 *      渠道可以声明 `limits.perModel`：那时额度**按模型各自记账**，这里会逐模型判定并
 *      跳过烧完的模型 —— 同一渠道的多个模型会在一次请求里连续尝试。
 *   3. priority 升序 —— 数字小的先用（免费额度排前面，本地/付费排后面）。
 *   4. 跳过正在冷却的渠道；全都在冷却时按 policy.onAllCooling 兜底。
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

/**
 * 挑这次用哪些模型。
 *
 * 单模型渠道就是"取那一个"；多模型渠道（一把 key 下几十个模型，如火山方舟）
 * 会**跳过已经冷却或已经烧完额度的模型** —— 这就是"一个模型用完自动换下一个"。
 *
 * @returns {Array<{model:string, budget:object}>} 空数组 = 这个渠道当前一个能用的模型都没有
 */
function pickModels(provider, spec, { budget, health, max = 1 } = {}) {
  const modelKey = (m) => `${provider.id}::${m}`;
  const assess = (m) => (budget ? budget.assess(provider, m) : { state: 'unconfigured' });

  // 显式点名模型：就用它，但硬阈值仍然拦
  if (spec.kind === 'exact' || spec.kind === 'model') {
    const b = assess(spec.model);
    return b.state === 'hard' ? [] : [{ model: spec.model, budget: b }];
  }

  const list = [];
  if (provider.defaultModel) list.push(provider.defaultModel);
  for (const m of provider.models) if (!list.includes(m)) list.push(m);

  const ok = [];
  const soft = [];
  for (const m of list) {
    if (ok.length >= max) break;
    // 模型级冷却：429 / 模型不存在这类失败只冷掉那一个模型，同渠道别的模型照用
    if (health && !health.isAvailable(modelKey(m))) continue;
    const b = assess(m);
    if (b.state === 'hard') continue;
    if (b.state === 'soft') soft.push({ model: m, budget: b });
    else ok.push({ model: m, budget: b });
  }

  // 没到软阈值的优先；不够再用已降级的补（还能用，只是不再是首选）
  while (soft.length > 0 && ok.length < max) ok.push(soft.shift());
  return ok.slice(0, max);
}

/**
 * @param {object} args
 * @param {Array<object>} args.providers 已通过 isConfigured 过滤的渠道
 * @param {import('./health.mjs').HealthRegistry} args.health
 * @param {object} args.spec parseModelSpec 的结果
 * @param {Set<string>} args.needs
 * @param {object} args.policy
 * @param {import('./budget.mjs').BudgetTracker} [args.budget] 额度熔断账本（不传 = 不熔断）
 * @returns {{candidates:Array<{provider:object,model:string,forced:boolean,cooling:boolean,budget:object}>, rejected:Array<{id:string,why:string}>}}
 */
export function selectCandidates({ providers, health, spec, needs, policy, budget }) {
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

  // 3) 挑模型 + 额度熔断（事前判定）：硬阈值直接剔除，软阈值只降排序
  //    硬阈值必须在这里就剔掉 —— 后面的"全在冷却兜底"不能把它捞回来，
  //    否则按量付费渠道照样会被打到，"欠费前切走"就白做了。
  const perModelMax = Math.max(1, Number(policy.perModelCandidates ?? 2));
  const picked = [];
  for (const p of capable) {
    // 渠道级熔断。perModel 的渠道这里恒为 unconfigured —— 它由下面逐模型判定
    const pb = budget ? budget.assess(p) : { state: 'unconfigured' };
    if (pb.state === 'hard') {
      rejected.push({ id: p.id, why: `额度熔断：${pb.reason || '已达硬阈值'}` });
      continue;
    }

    // perModel 的渠道多给几个候选：模型 A 当场被限额时，同一次请求里就能换成 B
    const picks = pickModels(p, spec, {
      budget,
      health,
      max: p.budget?.perModel ? perModelMax : 1,
    });
    if (picks.length === 0) {
      rejected.push({ id: p.id, why: '没有可用模型（额度用尽或全部在冷却中）' });
      continue;
    }
    picked.push({ provider: p, picks, soft: picks.every((x) => x.budget?.state === 'soft') });
  }

  // 4) 排序：软阈值排最后（还有额度，只是不再优先烧），其余按 priority
  const ordered = picked.sort((a, b) => {
    if (a.soft !== b.soft) return a.soft ? 1 : -1;
    return a.provider.priority - b.provider.priority;
  });

  // 5) 展开成候选。同一渠道的多个模型**保持相邻**，所以"模型 A 用完立刻用 B"
  //    在同一次请求内就能发生，而不是等下一次请求。
  const candidates = [];
  for (const item of ordered) {
    const cooling = !health.isAvailable(item.provider.id);
    for (const pk of item.picks) {
      candidates.push({
        provider: item.provider,
        model: pk.model,
        budget: pk.budget,
        forced: false,
        cooling,
      });
    }
  }

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
  // （软阈值的仍然排在后面 —— 兜底也不该优先烧快到上限的那个）
  const sorted = [...candidates].sort(
    (a, b) =>
      (a.budget?.state === 'soft' ? 1 : 0) - (b.budget?.state === 'soft' ? 1 : 0) ||
      health.retryAfterMs(a.provider.id) - health.retryAfterMs(b.provider.id)
  );
  return { candidates: sorted.slice(0, 2).map((c) => ({ ...c, forced: true })), rejected };
}

/** 人类可读的候选摘要，进日志用。 */
export function describeCandidates(candidates) {
  if (candidates.length === 0) return '(无可用上游)';
  return candidates
    .map((c) => {
      const tag = c.forced ? '(强制)' : c.budget?.state === 'soft' ? '(额度降级)' : '';
      return `${c.provider.id}${c.model ? `/${c.model}` : ''}${tag}`;
    })
    .join(' → ');
}
