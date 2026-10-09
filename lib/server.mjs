/**
 * llm-router 代理服务器（插件内嵌版）。
 *
 * 请求处理逻辑与独立项目 `src/index.mjs` 完全一致 —— 那套已经过了 27 项自测
 * 和真实端到端联调。这里只是把"读配置 + listen"从处理器里剥出来，让插件可以
 * 自己控制生命周期。
 *
 * 关键语义（别改坏）：只有在"尚未向客户端写出任何字节"之前发生的失败才允许换渠道，
 * 所以流式请求会先等上游第一个 chunk 落地，再写客户端响应头。
 */
import http from 'node:http';
import { isConfigured, parseModelSpec } from './config.mjs';
import { HealthRegistry, classifyStatus, FAIL } from './health.mjs';
import { selectCandidates, inferNeeds, describeCandidates } from './pool.mjs';
import { createVisionPreprocessor } from './vision.mjs';

const MAX_BODY_BYTES = 48 * 1024 * 1024; // 带 base64 图片的请求可以很大

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`请求体超过 ${MAX_BODY_BYTES} 字节`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  if (res.writableEnded) return;
  const payload = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * 这个状态码是不是"只跟当前这个模型有关"（换一个模型就可能好）。
 *
 * 429 = 模型被限流 / 该模型的额度用尽；404 = 模型名不对或这个账号没开通它。
 * 这两类只冷掉那一个模型，同一个渠道的别的模型继续用 —— 多模型渠道（火山方舟
 * 一把 key 下几十个模型）就是靠这个做到"一个模型用完自动换下一个"。
 * 其余失败（5xx / 网络 / 401 / 403）是渠道级或账号级的，整个渠道一起冷。
 */
function isModelScoped(status) {
  return status === 429 || status === 404;
}

/** 从上游错误响应里尽量挖出可读信息。 */
async function describeUpstreamError(res) {
  let text = '';
  try {
    text = (await res.text()).slice(0, 800);
  } catch {
    /* 读不到就算了 */
  }
  let msg = text;
  try {
    const j = JSON.parse(text);
    msg = j?.error?.message ?? j?.message ?? j?.error ?? text;
  } catch {
    /* 不是 JSON，用原文 */
  }
  const retryAfter = res.headers.get('retry-after');
  let retryAfterMs;
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs)) retryAfterMs = secs * 1000;
    else {
      const at = Date.parse(retryAfter);
      if (Number.isFinite(at)) retryAfterMs = Math.max(0, at - Date.now());
    }
  }
  return { message: String(msg ?? '').slice(0, 400), retryAfterMs };
}

/**
 * 上游兼容：把 OpenAI 新版角色名 `developer` 归一成 `system`。
 *
 * 背景：DSH 对部分模型会发 `role: "developer"`，而不少国产上游只认
 * `system`/`user`/`assistant`/`tool`，收到别的会直接 400：
 *   `Input tag 'developer' found using 'role' does not match any of the expected tags`
 * 结果是**这条请求在所有候选上游上全灭**（502），日志还很难看出原因。
 * 两者语义一致，转成 system 最省事，也不用改每个渠道的配置。
 */
function normalizeRoleNames(body) {
  const msgs = body?.messages;
  if (!Array.isArray(msgs) || !msgs.some((m) => m && m.role === 'developer')) return body;
  return {
    ...body,
    messages: msgs.map((m) => (m && m.role === 'developer' ? { ...m, role: 'system' } : m)),
  };
}

/**
 * 上游失败归类。除了状态码还要看**错误正文**：
 * 有些平台的「欠费 / 账号异常」是用 HTTP 400 表达的（例如阿里云百炼的 `overdue-payment`），
 * 按 badRequest 归类只会线性冷却、很快又回到候选池，白白占掉重试名额。
 * 这类是账号级不可用，应当当作 authError 走指数冷却（等同熔断）。
 */
function classifyUpstreamFailure(status, message = '') {
  if (status >= 400 && status < 500
      && /overdue|欠费|in good standing|insufficient|balance|arrears|account is not/i.test(message)) {
    return FAIL.authError;
  }
  return classifyStatus(status) ?? FAIL.serverError;
}

/** 用一把具体的 key 打一次上游。 */
async function fetchOnce({ provider, model, body, apiKey, timeoutMs, signal }) {
  const url = `${provider.baseURL}/chat/completions`;
  const headers = { 'content-type': 'application/json', ...provider.headers };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const payload = normalizeRoleNames({ ...body, model, ...provider.bodyPatch });

  const ac = new AbortController();
  const onAbort = () => ac.abort(new Error('client disconnected'));
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ac.abort(new Error(`上游超时 ${timeoutMs}ms`)), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: ac.signal,
    });
    return {
      res,
      clearTimer: () => clearTimeout(timer),
      detach: () => signal?.removeEventListener('abort', onAbort),
    };
  } catch (err) {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    throw err;
  }
}

/**
 * 打一个渠道。一个渠道可以配多把 key（多账号）——
 * 遇到 401 / 403 / 429 这类"很可能是这把 key 的问题"的失败时，
 * 会在**同一个渠道内**换下一把 key 重试，而不是直接放弃这个渠道。
 *
 * 注意：同一个账号创建的多把 key 共享账号额度，所以这招只在 key 来自
 * 不同账号时才有意义。共有几把 key 从 provider.apiKeys 读。
 */
async function callUpstream({ provider, model, body, timeoutMs, signal, log }) {
  const keys = provider.apiKeys?.length ? provider.apiKeys : [provider.apiKey ?? null];
  let lastStatus = null;

  for (let i = 0; i < keys.length; i += 1) {
    const isLast = i === keys.length - 1;
    const attempt = await fetchOnce({ provider, model, body, apiKey: keys[i], timeoutMs, signal });
    const status = attempt.res.status;

    const keyRelated = status === 401 || status === 403 || status === 429;
    if (isLast || !keyRelated) {
      return { ...attempt, keyIndex: i, keyCount: keys.length };
    }

    // 换下一把 key：必须把响应体读掉，否则连接不释放
    attempt.clearTimer();
    attempt.detach();
    await attempt.res.text().catch(() => {});
    lastStatus = status;
    log?.(`   ↻ ${provider.id} key#${i + 1} 返回 ${status}，换本渠道下一把 key`);
  }

  throw new Error(`${provider.id}: 所有 key 都失败（最后状态 ${lastStatus}）`);
}

/**
 * 把 SSE 从上游透传到客户端。
 * reader 必须由调用方传入：首包探测已经 getReader() 锁定了这条流，
 * 这里再取一次会抛 "Invalid state: ReadableStream is locked"。
 */
async function pipeStream(reader, clientRes, firstChunk) {
  let tail = '';
  const decoder = new TextDecoder('utf-8', { fatal: false });

  clientRes.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  const push = (value) => {
    clientRes.write(value);
    tail = (tail + decoder.decode(value, { stream: true })).slice(-8192);
  };

  if (firstChunk) push(firstChunk);

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (clientRes.writableEnded) {
        await reader.cancel().catch(() => {});
        return { completed: false, aborted: true, usage: extractUsage(tail) };
      }
      push(value);
    }
  } catch (err) {
    clientRes.end();
    return { completed: false, error: err, usage: extractUsage(tail) };
  }

  clientRes.end();
  return { completed: true, usage: extractUsage(tail) };
}

function extractUsage(text) {
  const idx = text.lastIndexOf('"usage"');
  if (idx < 0) return null;
  const start = text.indexOf('{', idx);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

async function handleChat(req, res, ctx) {
  const { config, health, providers, log, budget } = ctx;

  let body;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw.toString('utf8'));
  } catch (err) {
    return sendJson(res, 400, {
      error: { message: `请求体解析失败：${err.message}`, type: 'invalid_request_error' },
    });
  }

  let spec;
  try {
    spec = parseModelSpec(body?.model, providers);
  } catch (err) {
    return sendJson(res, 400, { error: { message: err.message, type: 'invalid_request_error' } });
  }

  // 图片预处理：把 image part 换成视觉模型的文字描述，让请求退回 [text, tools]。
  // 这样「看图」只消耗一次纯 image 调用，之后整条会话不再被钉死在唯一的多模态渠道上。
  // 失败一律保留原图（materializeImages 内部已兜底），不影响正常路由。
  if (ctx.vision) {
    try {
      const materialized = await ctx.vision.materializeImages(body);
      if (materialized.replaced > 0) {
        log(`   🖼 图片转写 ${materialized.replaced}/${materialized.total} 张 → ${materialized.provider}/${materialized.model}`);
      } else if (materialized.total > 0) {
        log(`   🖼 图片未转写（${materialized.note ?? '保留原图'}），仍按原能力路由`);
      }
    } catch (err) {
      log(`   ⚠ 图片预处理异常，保留原图：${String(err?.message ?? err).slice(0, 160)}`);
    }
  }

  const needs = inferNeeds(body);
  if (spec.needs) for (const n of spec.needs) needs.add(n);

  const { candidates, rejected } = selectCandidates({
    providers,
    health,
    spec,
    needs,
    policy: config.policy,
    budget,
  });

  const wantStream = Boolean(body?.stream);
  log(
    `→ ${wantStream ? 'stream' : 'sync'} model=${body?.model ?? 'auto'}` +
      (needs.size ? ` needs=[${[...needs].join(',')}]` : '') +
      ` | 候选 ${describeCandidates(candidates)}`
  );

  if (candidates.length === 0) {
    return sendJson(res, 503, {
      error: {
        message: `没有可用上游。${
          rejected.length
            ? `被排除：${rejected.map((r) => `${r.id}(${r.why})`).join('; ')}`
            : '所有渠道都在冷却中'
        }`,
        type: 'no_upstream_available',
      },
    });
  }

  const clientAc = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) clientAc.abort();
  });

  const attempts = Math.min(config.policy.maxAttempts, candidates.length);
  const failures = [];

  for (let i = 0; i < attempts; i += 1) {
    const { provider, model, forced } = candidates[i];
    health.markRequest(provider.id);

    const timeoutMs = wantStream ? config.policy.connectTimeoutMs : config.policy.requestTimeoutMs;

    let upstream;
    try {
      upstream = await callUpstream({
        provider,
        model,
        body,
        timeoutMs,
        signal: clientAc.signal,
        log,
      });
    } catch (err) {
      const wait = health.markFailure(provider.id, FAIL.network, {
        message: String(err?.message ?? err),
      });
      failures.push(`${provider.id}: ${err?.message ?? err}`);
      log(`   ✗ ${provider.id} 网络/超时失败，冷却 ${Math.round(wait / 1000)}s`);
      continue;
    }

    const { res: up, clearTimer, detach } = upstream;

    if (!up.ok) {
      const detail = await describeUpstreamError(up);
      const kind = classifyUpstreamFailure(up.status, detail.message);
      clearTimer();
      detach();
      // 模型级的失败（429/404）只冷这个模型，同渠道别的模型照用
      const scoped = isModelScoped(up.status);
      const wait = health.markFailure(scoped ? `${provider.id}::${model}` : provider.id, kind, detail);
      failures.push(`${provider.id}: HTTP ${up.status} ${detail.message}`);
      log(
        `   ✗ ${provider.id}${scoped ? `/${model}` : ''} HTTP ${up.status} (${kind})，冷却 ${Math.round(wait / 1000)}s — ${detail.message.slice(0, 120)}`
      );
      continue;
    }

    if (wantStream) {
      const reader = up.body.getReader();
      let first;
      try {
        first = await reader.read();
      } catch (err) {
        clearTimer();
        detach();
        const wait = health.markFailure(provider.id, FAIL.serverError, {
          message: String(err?.message ?? err),
        });
        failures.push(`${provider.id}: 首包失败 ${err?.message ?? err}`);
        log(`   ✗ ${provider.id} 首包失败，冷却 ${Math.round(wait / 1000)}s`);
        continue;
      }
      if (first.done) {
        clearTimer();
        detach();
        const wait = health.markFailure(provider.id, FAIL.empty, { message: '上游返回空流' });
        failures.push(`${provider.id}: 空流`);
        log(`   ✗ ${provider.id} 空流，冷却 ${Math.round(wait / 1000)}s`);
        continue;
      }

      clearTimer();
      detach();
      log(`   ✓ ${provider.id}${forced ? ' (强制)' : ''} 开始流式透传`);
      const outcome = await pipeStream(reader, res, first.value);
      if (outcome.completed) {
        health.markSuccess(provider.id, outcome.usage);
        health.markSuccess(`${provider.id}::${model}`); // 顺手清掉这个模型的冷却
        // 额度账本：用量 + 上游响应头里的真实剩余（有就用，没有就退回本地累计）
        budget?.observe(provider, outcome.usage, up.headers, model);
        log(`   ✓ ${provider.id} 流结束`);
      } else {
        health.markFailure(provider.id, FAIL.serverError, { message: '流中途中断' });
        log(`   ✗ ${provider.id} 流中途中断`);
      }
      return;
    }

    let text;
    try {
      text = await up.text();
    } catch (err) {
      clearTimer();
      detach();
      const wait = health.markFailure(provider.id, FAIL.network, {
        message: String(err?.message ?? err),
      });
      failures.push(`${provider.id}: 读响应失败`);
      log(`   ✗ ${provider.id} 读响应失败，冷却 ${Math.round(wait / 1000)}s`);
      continue;
    }
    clearTimer();
    detach();

    let usage = null;
    try {
      usage = JSON.parse(text)?.usage ?? null;
    } catch {
      /* 上游返回了非 JSON，原样透传 */
    }
    health.markSuccess(provider.id, usage);
    health.markSuccess(`${provider.id}::${model}`); // 顺手清掉这个模型的冷却
    budget?.observe(provider, usage, up.headers, model);
    log(
      `   ✓ ${provider.id}${forced ? ' (强制)' : ''} 200${usage ? ` tokens=${usage.total_tokens ?? '?'}` : ''}`
    );

    if (res.writableEnded) return;
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(text);
    return;
  }

  const retry = candidates
    .slice(0, attempts)
    .map((c) => health.retryAfterMs(c.provider.id))
    .filter((ms) => ms > 0);
  const soonest = retry.length > 0 ? Math.min(...retry) : null;

  sendJson(res, 502, {
    error: {
      message:
        `所有候选上游都失败了（试了 ${attempts} 个）。\n` +
        failures.map((f) => `  · ${f}`).join('\n') +
        (soonest !== null ? `\n最快 ${Math.round(soonest / 1000)}s 后有渠道恢复。` : ''),
      type: 'all_upstreams_failed',
      attempts: failures,
    },
  });
}

function handleModels(res, providers) {
  const now = Math.floor(Date.now() / 1000);
  const data = [];
  for (const p of providers) {
    const models = p.models.length > 0 ? p.models : p.defaultModel ? [p.defaultModel] : [];
    for (const m of models) {
      data.push({ id: `${p.id}::${m}`, object: 'model', created: now, owned_by: p.label });
    }
  }
  sendJson(res, 200, { object: 'list', data });
}

function handleHealth(res, ctx) {
  const { config, health, providers, budget } = ctx;
  const snap = new Map(health.snapshot().map((s) => [s.id, s]));
  const allBudget = budget?.snapshot(providers) ?? [];
  const bsnap = new Map(allBudget.map((b) => [b.id, b]));
  // perModel 的渠道：把逐模型的额度行按渠道归拢，面板才知道"还剩几个模型能顶"
  const modelsOf = new Map();
  for (const b of allBudget) {
    if (!b.perModel) continue;
    if (!modelsOf.has(b.providerId)) modelsOf.set(b.providerId, []);
    modelsOf.get(b.providerId).push(b);
  }

  // 模型级冷却（429/404 只冷单个模型）必须反映到渠道状态上，
  // 否则面板会说"可用"，而实际上这个渠道的模型已经全被冷掉了。
  const coolingByProvider = new Map(); // providerId -> { count, nextAt, resetAt }
  for (const s of health.snapshot()) {
    const i = s.id.indexOf('::');
    if (i <= 0 || s.available) continue;
    const pid = s.id.slice(0, i);
    const cur = coolingByProvider.get(pid) ?? { count: 0, nextAt: 0, resetAt: null };
    cur.count += 1;
    const at = s.resetAt || s.cooldownUntil || 0;
    if (at && (cur.nextAt === 0 || at < cur.nextAt)) cur.nextAt = at;
    if (s.resetAt && (cur.resetAt === null || s.resetAt < cur.resetAt)) cur.resetAt = s.resetAt;
    coolingByProvider.set(pid, cur);
  }

  const rows = providers.map((p) => {
    const s = snap.get(p.id);
    const b = bsnap.get(p.id);
    const perModelRows = modelsOf.get(p.id) ?? null;
    const mc = coolingByProvider.get(p.id) ?? null;
    const modelCount = p.models.length > 0 ? p.models.length : p.defaultModel ? 1 : 0;
    const allModelsCooling = mc !== null && modelCount > 0 && mc.count >= modelCount;
    const available = (s ? s.available : true) && !allModelsCooling;

    // perModel 的渠道没有"渠道级额度"，渠道级状态由各模型聚合出来
    let budgetInfo = null;
    if (perModelRows) {
      const total = perModelRows.length;
      const usable = perModelRows.filter((m) => m.state !== 'hard').length;
      const exhausted = total - usable;
      budgetInfo = {
        perModel: true,
        state: usable === 0 ? 'hard' : perModelRows.some((m) => m.state === 'soft') ? 'soft' : 'ok',
        usableModels: usable,
        totalModels: total,
        // 只列"不正常"的模型：全 135 个都推给面板既没用又卡
        models: perModelRows
          .filter((m) => m.state !== 'ok')
          .slice(0, 30)
          .map((m) => ({
            id: m.model,
            state: m.state,
            used: m.used,
            limit: m.limit,
            reason: m.reason,
          })),
        softRatio: p.budget.softRatio,
        hardRatio: p.budget.hardRatio,
        reason: exhausted > 0 ? `${exhausted}/${total} 个模型的额度已用尽` : '',
      };
    } else if (b?.configured) {
      budgetInfo = {
        perModel: false,
        state: b.state,
        ratio: b.ratio,
        used: b.used,
        limit: b.limit,
        source: b.source,
        windowDays: b.window,
        resetsAt: b.resetsAt,
        softRatio: b.softRatio,
        hardRatio: b.hardRatio,
        paid: b.paid,
        reason: b.reason,
      };
    }

    const usageTokens = perModelRows
      ? perModelRows.reduce((a, m) => a + (m.usedTokens || 0), 0)
      : (b?.usedTokens ?? 0);
    const usageCost = perModelRows
      ? perModelRows.reduce((a, m) => a + (m.usedCost || 0), 0)
      : (b?.usedCost ?? 0);

    return {
      id: p.id,
      label: p.label,
      priority: p.priority,
      capabilities: p.capabilities,
      models: p.models.length > 0 ? p.models : p.defaultModel ? [p.defaultModel] : [],
      local: p.isLocal,
      available,
      // 面板用它渲染状态。注意 available 对"从未请求过"的渠道也是 true，
      // 直接拿来显示会变成绿色的"可用" —— 那是在骗人。
      status:
        !s || s.totalRequests === 0
          ? mc
            ? 'cooling'
            : 'untested'
          : !available
            ? 'cooling'
            : s.totalOk > 0
              ? 'ok'
              : 'failing',
      coolingMs: s ? s.coolingMs : 0,
      /** 冷却中的模型数（429/404 只冷单个模型，不牵连整个渠道） */
      coolingModels: mc?.count ?? 0,
      /** 本地冷却到期时间戳（渠道级优先，否则取模型级里最早恢复的那个） */
      cooldownUntil: s?.cooldownUntil || mc?.nextAt || 0,
      /** 上游明确告知的恢复时间（毫秒）；解析不出来就是 null */
      resetAt: s?.resetAt ?? mc?.resetAt ?? null,
      lastError: s?.lastError ?? null,
      lastOkAt: s?.lastOkAt ?? null,
      requests: s?.totalRequests ?? 0,
      ok: s?.totalOk ?? 0,
      failures: s?.totalFailures ?? 0,
      tokens: s?.usage?.totalTokens ?? 0,
      // ── 额度熔断 ──────────────────────────────────────────────────
      /** 本窗口累计用量（**没配额度数字的渠道也统计**，只是不熔断） */
      usageTokens,
      usageCost,
      /** 配了额度数字才有；null = unconfigured，调度完全不受影响 */
      budget: budgetInfo,
      configured: isConfigured(p).ok,
    };
  });
  sendJson(res, 200, {
    ok: rows.some((r) => r.available && r.configured),
    now: new Date().toISOString(),
    policy: config.policy,
    providers: rows,
  });
}

/** 构造一个 (req, res) 处理器，路径与独立项目一致。 */
export function createProxyHandler(ctx) {
  return (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

    if (
      req.method === 'POST' &&
      (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions')
    ) {
      handleChat(req, res, ctx).catch((err) => {
        ctx.log('未捕获异常：', err);
        sendJson(res, 500, {
          error: { message: String(err?.message ?? err), type: 'internal_error' },
        });
      });
      return;
    }

    if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
      return handleModels(res, ctx.providers);
    }

    if (req.method === 'GET' && url.pathname === '/healthz') {
      return handleHealth(res, ctx);
    }

    if (req.method === 'GET' && url.pathname === '/admin/clear') {
      const id = url.searchParams.get('id');
      if (id) {
        ctx.health.clear(id);
      } else {
        for (const s of ctx.health.snapshot()) ctx.health.clear(s.id);
      }
      return sendJson(res, 200, {
        cleared: id ?? 'all',
        state: ctx.health.snapshot().map((s) => ({ id: s.id, available: s.available })),
      });
    }

    if (req.method === 'GET' && url.pathname === '/admin/budget-reset') {
      if (!ctx.budget) return sendJson(res, 200, { ok: false, error: '未启用额度熔断' });
      const id = url.searchParams.get('id');
      ctx.budget.reset(id || null);
      return sendJson(res, 200, { ok: true, reset: id ?? 'all' });
    }

    if (req.method === 'POST' && url.pathname === '/admin/report-balance') {
      // 平台自报的真实剩余额度（OpenRouter 的 /api/v1/key 这类）由插件层定时查，
      // 查完从这里灌进预算账本。外部脚本也可以直接推，不必重启代理。
      if (!ctx.budget) return sendJson(res, 200, { ok: false, error: '未启用额度熔断' });
      readBody(req)
        .then((raw) => {
          const p = JSON.parse(raw.toString('utf8') || '{}');
          const ok = ctx.budget.reportRemaining(
            String(p.providerId ?? ''),
            {
              remaining: Number(p.remaining),
              limit: p.limit === null || p.limit === undefined ? null : Number(p.limit),
            },
            p.model ? String(p.model) : null
          );
          sendJson(res, 200, { ok, applied: ok ? p.providerId : null });
        })
        .catch((err) => sendJson(res, 400, { error: String(err?.message ?? err) }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/admin/report') {
      // 探测跑在独立进程里（不经过代理），跑完把结果报回来，面板才看得到真实状态。
      readBody(req)
        .then((raw) => {
          const payload = JSON.parse(raw.toString('utf8') || '{}');
          const results = Array.isArray(payload.results) ? payload.results : [];
          for (const r of results) {
            if (typeof r?.providerId === 'string') {
              ctx.health.markProbe(r.providerId, Boolean(r.ok), { message: r.message });
            }
          }
          sendJson(res, 200, { ok: true, applied: results.length });
        })
        .catch((err) => sendJson(res, 400, { error: String(err?.message ?? err) }));
      return;
    }

    sendJson(res, 404, { error: { message: `未知路径 ${url.pathname}`, type: 'not_found' } });
  };
}

/**
 * 启动代理。
 * @returns {Promise<{server: import('node:http').Server, port: number, close: () => Promise<void>}>}
 */
export function startProxy({ config, providers, health, budget, log, host, port }) {
  const ctx = {
    config,
    health,
    providers,
    budget,
    log,
    vision: createVisionPreprocessor({ config, providers, log, callUpstream }),
  };
  const server = http.createServer(createProxyHandler(ctx));

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port ?? config.server.port, host ?? config.server.host, () => {
      server.removeListener('error', reject);
      resolve({
        server,
        port: server.address().port,
        // closeAllConnections 不能省：fetch 走的是 keep-alive 连接池，只调 close()
        // 会留下未关闭的 socket，Node 退出时在 Windows 上会撞 libuv 断言
        // （Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)）。
        // 插件卸载时会走到这里，崩了会连带 DSH 进程一起挂。
        close: () =>
          new Promise((r) => {
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      });
    });
  });
}

export { HealthRegistry };
