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

/** 用一把具体的 key 打一次上游。 */
async function fetchOnce({ provider, model, body, apiKey, timeoutMs, signal }) {
  const url = `${provider.baseURL}/chat/completions`;
  const headers = { 'content-type': 'application/json', ...provider.headers };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const payload = { ...body, model, ...provider.bodyPatch };

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
  const { config, health, providers, log } = ctx;

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

  const needs = inferNeeds(body);
  if (spec.needs) for (const n of spec.needs) needs.add(n);

  const { candidates, rejected } = selectCandidates({
    providers,
    health,
    spec,
    needs,
    policy: config.policy,
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
      const kind = classifyStatus(up.status) ?? FAIL.serverError;
      const detail = await describeUpstreamError(up);
      clearTimer();
      detach();
      const wait = health.markFailure(provider.id, kind, detail);
      failures.push(`${provider.id}: HTTP ${up.status} ${detail.message}`);
      log(
        `   ✗ ${provider.id} HTTP ${up.status} (${kind})，冷却 ${Math.round(wait / 1000)}s — ${detail.message.slice(0, 120)}`
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
  const { config, health, providers } = ctx;
  const snap = new Map(health.snapshot().map((s) => [s.id, s]));
  const rows = providers.map((p) => {
    const s = snap.get(p.id);
    return {
      id: p.id,
      label: p.label,
      priority: p.priority,
      capabilities: p.capabilities,
      models: p.models.length > 0 ? p.models : p.defaultModel ? [p.defaultModel] : [],
      local: p.isLocal,
      available: s ? s.available : true,
      // 面板用它渲染状态。注意 available 对"从未请求过"的渠道也是 true，
      // 直接拿来显示会变成绿色的"可用" —— 那是在骗人。
      status:
        !s || s.totalRequests === 0
          ? 'untested'
          : !s.available
            ? 'cooling'
            : s.totalOk > 0
              ? 'ok'
              : 'failing',
      coolingMs: s ? s.coolingMs : 0,
      /** 本地冷却到期时间戳 */
      cooldownUntil: s?.cooldownUntil ?? 0,
      /** 上游明确告知的恢复时间（毫秒）；解析不出来就是 null */
      resetAt: s?.resetAt ?? null,
      lastError: s?.lastError ?? null,
      lastOkAt: s?.lastOkAt ?? null,
      requests: s?.totalRequests ?? 0,
      ok: s?.totalOk ?? 0,
      failures: s?.totalFailures ?? 0,
      tokens: s?.usage?.totalTokens ?? 0,
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
export function startProxy({ config, providers, health, log, host, port }) {
  const ctx = { config, health, providers, log };
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
