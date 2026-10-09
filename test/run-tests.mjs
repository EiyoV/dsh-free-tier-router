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
import { normalizeBudget, parseWindow } from '../lib/budget.mjs';

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

function makeProvider(id, mock, { priority, capabilities = ['text'], model = 'm1', models, limits } = {}) {
  return {
    id,
    label: `${id} (${mock.behavior})`,
    baseURL: `http://127.0.0.1:${mock.port}/v1`,
    priority: priority ?? 100,
    capabilities,
    defaultModel: model,
    models: models ?? [model],
    ...(limits ? { limits } : {}),
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
    // 用量账本指向临时目录：测试绝不能污染用户真实的 ~/.dsh/llm-router/usage.json
    env: { ...process.env, LLM_ROUTER_CONFIG: configPath, LLM_ROUTER_DATA: TMP },
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

    // ── 场景 8：额度熔断（在"用完"之前就切走）──────────────────────
    console.log('\n[场景 8] 额度熔断：软阈值降级 / 硬阈值剔除 / 上游剩余优先 / 跨重启保留');

    // 8.0 配置解析：没配额度的渠道必须零干预
    check('只有 note 的老配置 → budget 为 null（调度行为完全不变）', normalizeBudget({ note: '免费' }) === null);
    check('window "90d" 解析正确', parseWindow('90d') === 90 * 86400000, String(parseWindow('90d')));
    check('window "total" 表示永不重置', parseWindow('total') === null);
    {
      const coerced = normalizeBudget({ tokens: 100, softRatio: 1.1, hardRatio: 0.5 });
      check('阈值写反时自动夹正（soft ≤ hard）', coerced.softRatio <= coerced.hardRatio, JSON.stringify(coerced));
      check('绝对到期时间可被识别', normalizeBudget({ expiresAt: '2030-01-01T00:00:00Z' }) !== null);
    }

    // 8.1 软阈值：只降级，不浪费剩余额度
    {
      const router = await startRouter([
        makeProvider('soft-A', mOK, { priority: 1, limits: { tokens: 14, softRatio: 0.5, hardRatio: 1 } }),
        makeProvider('other-B', mOK2, { priority: 2 }),
      ]);

      const a0 = mOK.state.count;
      const r1 = await router.chat({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] });
      check('未达阈值时仍用首选渠道', contentOf(r1) === 'OK from mOK', `content=${JSON.stringify(contentOf(r1))}`);

      const a = (await router.health()).providers.find((p) => p.id === 'soft-A');
      check(
        'healthz 报出该渠道用量与比例',
        a.usageTokens === 7 && a.budget?.state === 'soft',
        JSON.stringify({ tokens: a.usageTokens, budget: a.budget })
      );

      const r2 = await router.chat({ model: 'auto', messages: [{ role: 'user', content: 'again' }] });
      check('到软阈值后降为队尾，改由次选接手', contentOf(r2) === 'OK from mOK2', `content=${JSON.stringify(contentOf(r2))}`);
      check('降级期间不会被白白多打一次', mOK.state.count - a0 === 1, `实际 ${mOK.state.count - a0} 次`);

      await router.stop();
    }

    // 8.2 硬阈值：打满就彻底剔除，连 force-any 兜底也不能把它捞回来
    {
      const router = await startRouter(
        [
          makeProvider('hard-A', mOK, { priority: 1, limits: { tokens: 7, hardRatio: 1 } }),
          makeProvider('dead-B', m500, { priority: 2 }),
        ],
        { onAllCooling: 'force-any', maxAttempts: 2 }
      );

      const a0 = mOK.state.count;
      const r1 = await router.chat({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] });
      check('第一次用首选并打满额度', contentOf(r1) === 'OK from mOK', `content=${JSON.stringify(contentOf(r1))}`);

      const hb = (await router.health()).providers.find((p) => p.id === 'hard-A').budget;
      check('达到硬阈值后状态为 hard', hb?.state === 'hard', JSON.stringify(hb));

      const r2 = await router.chat({ model: 'auto', messages: [{ role: 'user', content: 'again' }] });
      check('打满后不再被选中（次选失败则整体报错）', r2.status >= 400, `status=${r2.status}`);

      const r3 = await router.chat({ model: 'auto', messages: [{ role: 'user', content: 'third' }] });
      check(
        '全在冷却时 force-any 兜底也不会把打满的渠道捞回来',
        mOK.state.count - a0 === 1,
        `hard-A 被打了 ${mOK.state.count - a0} 次（应为 1）`
      );
      check('确实报错，而不是静默超额使用', r3.status >= 400, `status=${r3.status}`);

      await router.stop();
    }

    // 8.3 上游报的真实剩余优先于本地累计
    {
      const mHeader = await startMock('mHeader', 'quotaHeader');
      const router = await startRouter([
        // 本地额度故意配成 1：若不用上游响应头，第一次请求就该被判 hard
        makeProvider('hdr-A', mHeader, { priority: 1, limits: { tokens: 1, softRatio: 0.7, hardRatio: 1 } }),
      ]);

      const r1 = await router.chat({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] });
      check('上游报还剩 600/1000 → 即使本地累计超额也照常可用', r1.status === 200, `status=${r1.status}`);

      const b1 = (await router.health()).providers.find((p) => p.id === 'hdr-A').budget;
      check('额度比例以上游响应头为准', b1?.source === '上游响应头' && b1.ratio < 0.5, JSON.stringify(b1));

      await router.chat({ model: 'auto', messages: [{ role: 'user', content: 'again' }] });
      const b2 = (await router.health()).providers.find((p) => p.id === 'hdr-A').budget;
      check('上游剩余降到 200/1000 → 判为 soft（先降级而不是直接停）', b2?.state === 'soft', JSON.stringify(b2));

      const r3 = await router.chat({ model: 'auto', messages: [{ role: 'user', content: 'third' }] });
      check('上游这次说已超额（-200/1000）→ 响应照常返回', r3.status === 200, `status=${r3.status}`);

      const b3 = (await router.health()).providers.find((p) => p.id === 'hdr-A').budget;
      check('读到负剩余后立刻判 hard', b3?.state === 'hard', JSON.stringify(b3));

      const r4 = await router.chat({ model: 'auto', messages: [{ role: 'user', content: 'fourth' }] });
      check('下一次请求被挡住，不再产生任何费用（这就是"欠费前切走"）', r4.status >= 400, `status=${r4.status}`);

      await router.stop();
      await mHeader.close();
    }

    // 8.4 用量跨重启保留 + 手动重置
    {
      const limits = { tokens: 7, hardRatio: 1 };
      const mk = () => [
        makeProvider('persist-A', mOK, { priority: 1, limits }),
        makeProvider('persist-B', mOK2, { priority: 2 }),
      ];

      const r1 = await startRouter(mk());
      await r1.chat({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] });
      const before = (await r1.health()).providers.find((p) => p.id === 'persist-A').budget;
      check('打满后判 hard', before?.state === 'hard', JSON.stringify(before));
      await r1.stop();

      // 重新起一个（模拟 DSH 重启）：用量必须还在，否则"重启即满血"就白做了
      const r2 = await startRouter(mk());
      const after = (await r2.health()).providers.find((p) => p.id === 'persist-A').budget;
      check('用量跨重启保留（重启不会让额度"复活"）', after?.state === 'hard', JSON.stringify(after));

      await fetch(`http://127.0.0.1:${r2.port}/admin/budget-reset?id=persist-A`);
      const reset = (await r2.health()).providers.find((p) => p.id === 'persist-A').budget;
      check('手动重置后恢复可用', reset?.state === 'ok', JSON.stringify(reset));
      check(
        '重置只影响指定渠道',
        (await r2.health()).providers.find((p) => p.id === 'persist-B').budget === null
      );

      await r2.stop();
    }

    // 8.5 没配额度数字的渠道：行为必须和以前一模一样
    {
      const router = await startRouter([
        makeProvider('plain-A', mOK, { priority: 1 }),
        makeProvider('plain-B', mOK2, { priority: 2 }),
      ]);
      const seen = [];
      for (let i = 0; i < 3; i += 1) {
        const r = await router.chat({ model: 'auto', messages: [{ role: 'user', content: `hi ${i}` }] });
        seen.push(contentOf(r));
      }
      check('未配置额度的渠道零干预（连打 3 次仍走首选）', seen.every((c) => c === 'OK from mOK'), JSON.stringify(seen));

      await router.stop();
    }

    // 8.6 balance:true —— 只信平台自报的余额（OpenRouter 那类），零配置、零猜测
    {
      check('balance:true 会建账（但没数字时不干预）', normalizeBudget({ balance: true }) !== null);

      const router = await startRouter([
        makeProvider('bal-A', mOK, { priority: 1, limits: { balance: true, softRatio: 0.9, hardRatio: 1 } }),
        makeProvider('bal-B', mOK2, { priority: 2 }),
      ]);

      const h0 = (await router.health()).providers.find((p) => p.id === 'bal-A').budget;
      check('平台还没报总额度 → unconfigured（绝不误判）', h0?.state === 'unconfigured', JSON.stringify(h0));

      const report = (body) =>
        fetch(`http://127.0.0.1:${router.port}/admin/report-balance`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });

      await report({ providerId: 'bal-A', remaining: 50, limit: 1000 });
      const h1 = (await router.health()).providers.find((p) => p.id === 'bal-A').budget;
      check('平台自报还剩 5% → 判为 soft（先降级）', h1?.state === 'soft', JSON.stringify(h1));

      await report({ providerId: 'bal-A', remaining: -10, limit: 1000 });
      const h2 = (await router.health()).providers.find((p) => p.id === 'bal-A').budget;
      check('平台自报已超额 → 判为 hard', h2?.state === 'hard', JSON.stringify(h2));

      const r = await router.chat({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] });
      check('请求被挡住并改由次选接手', contentOf(r) === 'OK from mOK2', `content=${JSON.stringify(contentOf(r))}`);

      await router.stop();
    }

    // ── 场景 9：同一个渠道下的多个模型各自记额度（火山方舟那类）────────
    console.log('\n[场景 9] perModel：一个模型的额度烧完，自动换同渠道的下一个模型');
    check('perModel 会被解析出来', normalizeBudget({ perModel: true, tokens: 10 })?.perModel === true);

    // 9.1 额度驱动：不靠上游报错，纯粹因为"这个模型烧完了"而换模型
    {
      const mM = await startMock('mM', 'multiModel');
      allMocks.push(mM);
      mM.state.quota = 999; // 这个场景只测额度熔断驱动的切换，不让上游报 429

      const router = await startRouter([
        makeProvider('volc', mM, {
          priority: 1,
          model: 'mA',
          models: ['mA', 'mB', 'mC'],
          // 每个模型各自 7 token，而 mock 每次回 7 token → 每个模型用一次就满
          limits: { perModel: true, tokens: 7, window: 'day', softRatio: 0.9, hardRatio: 1 },
        }),
      ]);

      const used = [];
      for (let i = 0; i < 3; i += 1) {
        const r = await router.chat({ model: 'auto', messages: [{ role: 'user', content: `hi ${i}` }] });
        used.push(contentOf(r));
      }
      check(
        'mA 烧完自动换 mB、再换 mC',
        used.join(' | ') === 'OK from mM/mA | OK from mM/mB | OK from mM/mC',
        JSON.stringify(used)
      );

      const volc = (await router.health()).providers.find((p) => p.id === 'volc');
      check(
        'healthz 报出 3 个模型全部用尽',
        volc.budget?.perModel === true && volc.budget.totalModels === 3 && volc.budget.usableModels === 0,
        JSON.stringify(volc.budget)
      );

      const r4 = await router.chat({ model: 'auto', messages: [{ role: 'user', content: 'fourth' }] });
      check('全部模型都用完 → 明确报错，而不是继续烧', r4.status >= 400, `status=${r4.status}`);

      await router.stop();
    }

    // 9.2 上游当场 429：同一个请求内就换下一个模型（模型级冷却，不牵连整个渠道）
    {
      const mQ = await startMock('mQ', 'multiModel');
      allMocks.push(mQ);
      mQ.state.quota = 0; // 所有模型都 429

      const router = await startRouter([
        makeProvider('volc2', mQ, {
          priority: 1,
          model: 'mA',
          models: ['mA', 'mB', 'mC'],
          // 额度给得极大：这里要验的是"429 只冷单个模型"，不是额度熔断
          limits: { perModel: true, tokens: 999999999, window: 'day', softRatio: 0.9, hardRatio: 1 },
        }),
      ]);

      const r = await router.chat({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] });
      check('所有模型都 429 时如实报错', r.status >= 400, `status=${r.status}`);

      const tried = Object.keys(mQ.state.byModel ?? {});
      check(
        '同一次请求内换了模型（不是第一个模型失败就放弃整个渠道）',
        tried.length >= 2,
        JSON.stringify(tried)
      );

      const h = await router.health();
      const volc2 = h.providers.find((p) => p.id === 'volc2');
      check(
        '429 只冷掉个别模型，渠道级仍然活着（别的模型还能用）',
        volc2.available === true && volc2.coolingModels >= 2,
        JSON.stringify({ available: volc2.available, coolingModels: volc2.coolingModels })
      );

      await router.stop();
    }

    // 9.3 按金额熔断：一次性代金券那类（防"券用完了自动转按量"导致欠费）
    {
      const router = await startRouter([
        makeProvider('voucher-A', mOK, {
          priority: 1,
          // mock 每次回 5 prompt + 2 completion token；单价 100 元/百万 ⇒ 每次约 0.0007 元
          limits: {
            cost: 0.0005,
            priceIn: 100,
            priceOut: 100,
            window: 'total',
            softRatio: 0.9,
            hardRatio: 1,
          },
        }),
        makeProvider('backup-C', mOK2, { priority: 2 }),
      ]);

      const a0 = mOK.state.count;
      const r1 = await router.chat({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] });
      check('第一次仍在额度内', contentOf(r1) === 'OK from mOK', `content=${JSON.stringify(contentOf(r1))}`);

      const h = (await router.health()).providers.find((p) => p.id === 'voucher-A').budget;
      check(
        '按元折算也能判定（来源=本地估算费用）',
        h?.source === '本地估算费用' && h.state === 'hard',
        JSON.stringify(h)
      );

      const r2 = await router.chat({ model: 'auto', messages: [{ role: 'user', content: 'again' }] });
      check(
        '金额用尽后自动切走 —— 这就是"代金券用超自动转按量"的防线',
        contentOf(r2) === 'OK from mOK2',
        `content=${JSON.stringify(contentOf(r2))}`
      );
      check('用尽后不再打那条渠道', mOK.state.count - a0 === 1, `实际 ${mOK.state.count - a0} 次`);

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
