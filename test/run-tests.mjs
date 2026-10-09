/**
 * llm-router 自测：全部基于假上游，不消耗任何真实额度、不需要任何 key。
 *
 *   node test/run-tests.mjs
 *
 * 覆盖：429/5xx 自动接管、冷却后跳过、能力路由（图片/工具）、流式 fallback、
 *       空流 fallback、全失败时的行为、冷却到期恢复。
 */
import net from 'node:net';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMock } from './mock-upstreams.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = resolve(ROOT, 'test', '.tmp');

let passed = 0;
let failed = 0;

function check(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${extra ? `  — ${extra}` : ''}`);
  }
}

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });
}

async function waitFor(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {
      /* 还没起来 */
    }
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}

function basePolicy(overrides = {}) {
  return {
    maxAttempts: 6,
    connectTimeoutMs: 5000,
    requestTimeoutMs: 15000,
    onAllCooling: 'fail',
    cooldown: {
      rateLimitMs: 60000,
      serverErrorMs: 20000,
      authErrorMs: 1800000,
      minMs: 5000,
      maxMs: 3600000,
    },
    ...overrides,
  };
}

function makeProvider(id, mock, { priority, capabilities = ['text'], model = 'm1' } = {}) {
  return {
    id,
    label: `${id} (${mock.behavior})`,
    baseURL: `http://127.0.0.1:${mock.port}/v1`,
    priority: priority ?? 100,
    capabilities,
    defaultModel: model,
    models: [model],
  };
}

async function startRouter(providers, policyOverrides) {
  const port = await freePort();
  const configPath = resolve(TMP, `config-${port}.json`);
  writeFileSync(
    configPath,
    JSON.stringify(
      { server: { host: '127.0.0.1', port }, policy: basePolicy(policyOverrides), providers },
      null,
      2
    ),
    'utf8'
  );

  // 指向真实内核（lib/），不是任何会过期的副本 ——
  // 测试必须测「实际运行的代码」，否则全绿也没意义。
  const proc = spawn(process.execPath, [resolve(ROOT, 'lib', 'cli.mjs')], {
    env: { ...process.env, LLM_ROUTER_CONFIG: configPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  proc.stdout.on('data', (d) => {
    output += d.toString();
  });
  proc.stderr.on('data', (d) => {
    output += d.toString();
  });

  const ready = await waitFor(`http://127.0.0.1:${port}/healthz`, 10000);
  if (!ready) {
    throw new Error(`router 未能启动（port ${port}）：\n${output}`);
  }

  return {
    port,
    proc,
    get output() {
      return output;
    },
    chat: async (body) => {
      const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const text = await r.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* SSE 或非 JSON */
      }
      return { status: r.status, text, json };
    },
    health: async () => (await fetch(`http://127.0.0.1:${port}/healthz`)).json(),
    stop: () =>
      new Promise((res) => {
        proc.once('exit', () => res());
        proc.kill();
        setTimeout(res, 2500);
      }),
  };
}

const contentOf = (r) => r.json?.choices?.[0]?.message?.content ?? '';

async function main() {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });

  console.log('启动假上游…');
  const m429 = await startMock('m429', 'always429');
  const m500 = await startMock('m500', 'always500');
  const mOK = await startMock('mOK', 'ok');
  const mOK2 = await startMock('mOK2', 'ok');
  const mStream = await startMock('mStream', 'stream');
  const mEmpty = await startMock('mEmpty', 'emptyStream');
  const mTextOnly = await startMock('mTextOnly', 'textOnly');
  const mVision = await startMock('mVision', 'visionOk');
  const mFlaky = await startMock('mFlaky', 'failThenOk');
  const allMocks = [m429, m500, mOK, mOK2, mStream, mEmpty, mTextOnly, mVision, mFlaky];

  try {
    // ── 场景 1：429 → 500 → 成功，自动接管 ─────────────────────────
    console.log('\n[场景 1] 429/500 自动接管 + 冷却后跳过');
    {
      const router = await startRouter([
        makeProvider('down429', m429, { priority: 1 }),
        makeProvider('down500', m500, { priority: 2 }),
        makeProvider('good', mOK, { priority: 3 }),
      ]);

      const b429 = m429.state.count;
      const b500 = m500.state.count;
      const bOK = mOK.state.count;

      const r1 = await router.chat({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] });
      check('首选 429、次选 500 时仍返回 200', r1.status === 200, `status=${r1.status} body=${r1.text.slice(0, 200)}`);
      check('响应确实来自第三个上游', contentOf(r1) === 'OK from mOK', `content=${JSON.stringify(contentOf(r1))}`);
      check(
        '三个上游各被访问一次',
        m429.state.count - b429 === 1 && m500.state.count - b500 === 1 && mOK.state.count - bOK === 1,
        `429=${m429.state.count - b429} 500=${m500.state.count - b500} ok=${mOK.state.count - bOK}`
      );

      const h1 = await router.health();
      const bad429 = h1.providers.find((p) => p.id === 'down429');
      const bad500 = h1.providers.find((p) => p.id === 'down500');
      check('429 渠道进入冷却', bad429 && bad429.available === false, JSON.stringify(bad429));
      check('500 渠道进入冷却', bad500 && bad500.available === false, JSON.stringify(bad500));

      // 第二次请求：冷却中的两个应被直接跳过
      const before429 = m429.state.count;
      const before500 = m500.state.count;
      const r2 = await router.chat({ model: 'auto', messages: [{ role: 'user', content: 'again' }] });
      check('冷却后第二次请求仍成功', r2.status === 200, `status=${r2.status}`);
      check('冷却中的渠道没有被再次访问', m429.state.count === before429 && m500.state.count === before500,
        `429=${m429.state.count} 500=${m500.state.count}`);

      await router.stop();
    }

    // ── 场景 2：能力路由 ───────────────────────────────────────────
    console.log('\n[场景 2] 能力路由（图片请求必须跳过纯文本渠道）');
    {
      const router = await startRouter([
        makeProvider('text-only', mTextOnly, { priority: 1, capabilities: ['text'] }),
        makeProvider('vision-capable', mVision, { priority: 2, capabilities: ['text', 'image'] }),
      ]);

      const bText = mTextOnly.state.count;
      const imgBody = {
        model: 'auto',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'what is this' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
            ],
          },
        ],
      };
      const r = await router.chat(imgBody);
      check('带图请求返回 200', r.status === 200, `status=${r.status}`);
      check('带图请求命中了支持图片的渠道', contentOf(r) === 'OK from mVision', `content=${JSON.stringify(contentOf(r))}`);
      check('纯文本渠道完全没有被访问', mTextOnly.state.count === bText, `count=${mTextOnly.state.count}`);

      const r2 = await router.chat({ model: 'auto', messages: [{ role: 'user', content: 'plain text' }] });
      check('纯文本请求优先命中高优先级渠道', contentOf(r2) === 'OK from mTextOnly', `content=${JSON.stringify(contentOf(r2))}`);

      await router.stop();
    }

    // ── 场景 3：流式 fallback ─────────────────────────────────────
    console.log('\n[场景 3] 流式请求的 fallback');
    {
      const router = await startRouter([
        makeProvider('down429', m429, { priority: 1 }),
        makeProvider('streamer', mStream, { priority: 2 }),
      ]);

      const r = await router.chat({ model: 'auto', stream: true, messages: [{ role: 'user', content: 'hi' }] });
      check('流式请求在首选 429 后仍返回 200', r.status === 200, `status=${r.status}`);
      check('收到的是 SSE 内容', r.text.includes('data:'), r.text.slice(0, 120));
      check('SSE 内容来自正确上游', r.text.includes('from mStream'), r.text.slice(0, 200));
      check('SSE 以 [DONE] 收尾', r.text.includes('[DONE]'), r.text.slice(-120));

      await router.stop();
    }

    // ── 场景 4：空流 fallback ─────────────────────────────────────
    console.log('\n[场景 4] 上游 200 但空流时接管');
    {
      const router = await startRouter([
        makeProvider('empty', mEmpty, { priority: 1 }),
        makeProvider('streamer', mStream, { priority: 2 }),
      ]);

      const r = await router.chat({ model: 'auto', stream: true, messages: [{ role: 'user', content: 'hi' }] });
      check('空流上游被跳过，最终成功', r.status === 200, `status=${r.status} body=${r.text.slice(0, 150)}`);
      check('内容来自第二个上游（真 SSE）', r.text.includes('from mStream') && r.text.includes('[DONE]'), r.text.slice(0, 200));

      const h = await router.health();
      const empty = h.providers.find((p) => p.id === 'empty');
      check('空流渠道被标记失败', empty.failures >= 1, JSON.stringify(empty));

      await router.stop();
    }

    // ── 场景 5：全军覆没 ──────────────────────────────────────────
    console.log('\n[场景 5] 全部上游失败时的行为');
    {
      const router = await startRouter([makeProvider('down429', m429, { priority: 1 })], { onAllCooling: 'fail' });

      const started = Date.now();
      const r = await router.chat({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] });
      const elapsed = Date.now() - started;
      check('返回错误状态而不是挂住', r.status >= 400, `status=${r.status}`);
      check('错误响应里带上了失败原因', String(r.json?.error?.message ?? '').includes('down429'), r.text.slice(0, 200));
      check('响应很快（没有无意义重试）', elapsed < 8000, `${elapsed}ms`);

      await router.stop();
    }

    // ── 场景 6：冷却到期恢复 ──────────────────────────────────────
    console.log('\n[场景 6] 冷却到期后渠道自动恢复');
    {
      const router = await startRouter([makeProvider('flaky', mFlaky, { priority: 1 })], {
        onAllCooling: 'force-local',
        cooldown: { rateLimitMs: 1500, serverErrorMs: 1500, authErrorMs: 1500, minMs: 1000, maxMs: 5000 },
      });

      const r1 = await router.chat({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] });
      check('第一次请求失败（上游 429）', r1.status >= 400, `status=${r1.status}`);

      await new Promise((res) => setTimeout(res, 2200));
      const h = await router.health();
      const flaky = h.providers.find((p) => p.id === 'flaky');
      check('冷却到期后重新可用', flaky.available === true, JSON.stringify({ available: flaky.available, coolingMs: flaky.coolingMs }));

      const r2 = await router.chat({ model: 'auto', messages: [{ role: 'user', content: 'hi again' }] });
      check('恢复后请求成功', r2.status === 200, `status=${r2.status}`);
      check('内容来自恢复的渠道', contentOf(r2) === 'OK from mFlaky', `content=${JSON.stringify(contentOf(r2))}`);

      await router.stop();
    }

    // ── 场景 7：/v1/models 与显式指定 ─────────────────────────────
    console.log('\n[场景 7] 模型清单与显式指定 provider');
    {
      const router = await startRouter([
        makeProvider('aaa', mOK, { priority: 1 }),
        makeProvider('bbb', mOK2, { priority: 2 }),
      ]);

      const models = await (await fetch(`http://127.0.0.1:${router.port}/v1/models`)).json();
      check('模型清单包含两个渠道', models.data?.length === 2, JSON.stringify(models.data?.map((m) => m.id)));

      const r = await router.chat({ model: 'bbb::m1', messages: [{ role: 'user', content: 'hi' }] });
      check('显式指定 provider 生效', contentOf(r) === 'OK from mOK2', `content=${JSON.stringify(contentOf(r))}`);

      await router.stop();
    }
  } finally {
    for (const m of allMocks) await m.close();
    rmSync(TMP, { recursive: true, force: true });
  }

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n自测异常终止：', err);
  process.exit(1);
});
