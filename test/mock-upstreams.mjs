/**
 * 假上游服务器：用于在**不消耗任何真实免费额度**的前提下验证
 * fallback 切换、能力路由、冷却接管这些核心逻辑。
 *
 * 每个 mock 都是一个最小可用的 OpenAI 兼容 /v1/chat/completions 服务。
 */
import http from 'node:http';

const USAGE = { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 };

function readAll(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

function chatCompletion(label) {
  return {
    id: `chatcmpl-${label}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: label,
    choices: [
      { index: 0, message: { role: 'assistant', content: `OK from ${label}` }, finish_reason: 'stop' },
    ],
    usage: USAGE,
  };
}

function sseChunk(label, text) {
  return `data: ${JSON.stringify({
    id: `chatcmpl-${label}`,
    object: 'chat.completion.chunk',
    model: label,
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  })}\n\n`;
}

/** 一个完整的、合规的 SSE 回复。 */
function sendStream(label, res, headers = {}) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...headers });
  res.write(sseChunk(label, 'OK '));
  res.write(sseChunk(label, `from ${label}`));
  res.write(`data: ${JSON.stringify({ id: `chatcmpl-${label}`, choices: [], usage: USAGE })}\n\n`);
  res.write('data: [DONE]\n\n');
  return res.end();
}

/**
 * @param {string} label 用于在响应内容里区分是哪个上游
 * @param {'ok'|'always429'|'always500'|'textOnly'|'visionOk'|'stream'|'emptyStream'|'failThenOk'|'quotaHeader'|'multiModel'} behavior
 */
export function startMock(label, behavior) {
  const state = { count: 0, lastBody: null, label, behavior, hasImage: false };

  const server = http.createServer(async (req, res) => {
    state.count += 1;
    const raw = await readAll(req);
    let body = null;
    try {
      body = JSON.parse(raw);
    } catch {
      /* 忽略 */
    }
    state.lastBody = body;
    state.hasImage = raw.includes('image_url');
    const wantsStream = Boolean(body?.stream);

    const send = (status, obj, headers = {}) => {
      const payload = typeof obj === 'string' ? obj : JSON.stringify(obj);
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
      res.end(payload);
    };

    switch (behavior) {
      case 'always429':
        return send(429, { error: { message: `rate limited (${label})` } }, { 'retry-after': '30' });
      case 'always500':
        return send(500, { error: { message: `boom (${label})` } });
      case 'ok':
        if (wantsStream) return sendStream(label, res);
        return send(200, chatCompletion(label));
      case 'textOnly':
        // 模拟"纯文本渠道"：声明上不支持图片，收到图会真报错
        if (state.hasImage) {
          return send(400, { error: { message: `this model does not accept image input (${label})` } });
        }
        if (wantsStream) return sendStream(label, res);
        return send(200, chatCompletion(label));
      case 'visionOk':
        if (wantsStream) return sendStream(label, res);
        return send(200, chatCompletion(label));
      case 'emptyStream': {
        // 200 但响应体立刻结束 —— 验证"首包为空仍能换渠道"
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        return res.end();
      }
      case 'stream': {
        if (!wantsStream) return send(200, chatCompletion(label));
        return sendStream(label, res);
      }
      case 'failThenOk':
        if (state.count === 1) {
          return send(429, { error: { message: 'first call rate limited' } }, { 'retry-after': '1' });
        }
        return send(200, chatCompletion(label));
      case 'multiModel': {
        // 同一个渠道下每个模型各记各的账：state.quota 次之后就只对这个模型报 429。
        // 用来验证"一个模型烧完 → 自动换同渠道的下一个模型"。
        state.byModel ??= {};
        const m = body?.model ?? '(none)';
        state.byModel[m] = (state.byModel[m] ?? 0) + 1;
        if (state.byModel[m] > (state.quota ?? 1)) {
          return send(
            429,
            { error: { message: `model ${m} quota exhausted (${label})` } },
            { 'retry-after': '60' }
          );
        }
        if (wantsStream) return sendStream(label, res);
        return send(200, chatCompletion(`${label}/${m}`));
      }
      case 'quotaHeader': {        // 上游主动汇报剩余额度（Groq / Cerebras 这类会这么干）：
        // 第 1 次剩 600/1000、第 2 次 200、第 3 次 -200。
        // 用来验证"上游说的比本地累计更可信" —— 这条渠道的本地累计额度故意配得极小。
        const limit = 1000;
        const remaining = limit - state.count * 400;
        const h = {
          'x-ratelimit-limit-tokens': String(limit),
          'x-ratelimit-remaining-tokens': String(remaining),
        };
        if (wantsStream) return sendStream(label, res, h);
        return send(200, chatCompletion(label), h);
      }
      default:
        return send(500, { error: { message: `unknown behavior ${behavior}` } });
    }
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        label,
        behavior,
        port: server.address().port,
        state,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
