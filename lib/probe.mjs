/**
 * 渠道自检探针：真正发一次最小请求，核实"能不能用、模型名对不对、能力声明准不准"。
 *
 *   npm run probe                    探测全部已配置渠道，只测文本
 *   npm run probe -- --vision        额外测图片输入（核实 image 能力声明）
 *   npm run probe -- --tools         额外测工具调用（核实 tools 能力声明）
 *   npm run probe -- --only=groq-free
 *   npm run probe -- --all           连未配置(缺key)的渠道也列出来
 *
 * 这是配置好一批 key 之后的第一件事 —— 模型名/接入点会过时，别靠猜。
 */
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import zlib from 'node:zlib';
import { loadConfig, isConfigured } from './config.mjs';
import { CONFIG_PATH } from './paths.mjs';

const args = process.argv.slice(2);
const has = (f) => args.includes(`--${f}`);
const arg = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const doVision = has('vision');
const doTools = has('tools');
const only = arg('only', null);
const timeoutMs = Number(arg('timeout', '45000'));
// 探测跑完把结果回报给正在运行的代理，这样面板上的状态才是真的
const reportTo = arg('report-to', null);

/**
 * 生成一张 w×h 的棋盘格 PNG。
 *
 * 为什么不用 1×1：部分服务端会以"The image length and width ..."之类的参数错误直接拒收
 * —— 那是测法的问题，不是渠道不支持视觉。实测阿里云百炼的 qwen-vl-plus 就会因此返回 400，
 * 换成 64×64 后正常。
 */
function makePng(w, h, rgb = [200, 60, 60]) {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 2; // 真彩色 RGB

  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y += 1) {
    const off = y * (1 + w * 3);
    raw[off] = 0; // filter: none
    for (let x = 0; x < w; x += 1) {
      const p = off + 1 + x * 3;
      const on = ((x >> 3) + (y >> 3)) % 2 === 0;
      raw[p] = on ? rgb[0] : 255;
      raw[p + 1] = on ? rgb[1] : 255;
      raw[p + 2] = on ? rgb[2] : 255;
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const TEST_PNG = makePng(64, 64).toString('base64');

const TOOL_SPEC = [
  {
    type: 'function',
    function: {
      name: 'get_time',
      description: 'Return the current time. Call this when the user asks for the time.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
];

function buildBody({ vision, tools }) {
  const body = {
    messages: [
      vision
        ? {
            role: 'user',
            content: [
              { type: 'text', text: 'Reply with exactly: OK' },
              { type: 'image_url', image_url: { url: `data:image/png;base64,${TEST_PNG}` } },
            ],
          }
        : { role: 'user', content: 'Reply with exactly: OK' },
    ],
    // 不能给小预算：思考型模型会把额度全烧在 reasoning 上，512 都可能只拿到空正文。
    // 探测要能反映「真实开销」，所以给足。
    max_tokens: 1024,
    stream: false,
  };
  if (tools) {
    body.tools = TOOL_SPEC;
    body.tool_choice = 'auto';
    body.messages = [{ role: 'user', content: 'What time is it right now? Use the tool.' }];
  }
  return body;
}

async function probe(provider, which) {
  const vision = which === 'vision';
  const tools = which === 'tools';
  const model = provider.defaultModel ?? provider.models[0];
  const started = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);
  try {
    const headers = { 'content-type': 'application/json', ...provider.headers };
    if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;
    const res = await fetch(`${provider.baseURL}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...buildBody({ vision, tools }), model, ...provider.bodyPatch }),
      signal: ac.signal,
    });
    const ms = Date.now() - started;
    // 不截断：usage 在 JSON 末尾，slice(0,1500) 会把它切掉，就拿不到真实 token 开销了。
    // 展示用的截断在各分支里各自做。
    const text = await res.text();
    let usage = null;
    try {
      usage = JSON.parse(text)?.usage ?? null;
    } catch {
      /* 非 JSON */
    }
    let detail = '';
    let ok = res.ok;
    if (!res.ok) {
      try {
        const j = JSON.parse(text);
        detail = j?.error?.message ?? j?.message ?? text.slice(0, 200);
      } catch {
        detail = text.slice(0, 200);
      }
    } else if (tools) {
      // 200 还不够：要看到真的返回了 tool_calls，才算支持工具调用
      let called = false;
      try {
        const j = JSON.parse(text);
        const msg = j?.choices?.[0]?.message;
        called = Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0;
        if (!called) {
          detail = `200 但没返回 tool_calls（finish=${j?.choices?.[0]?.finish_reason ?? '?'}）→ 声明 tools 不可靠`;
          ok = false;
        }
      } catch {
        detail = '返回不是 JSON';
        ok = false;
      }
      if (called) detail = 'tool_calls ✓';
    } else {
      let content = '';
      try {
        const j = JSON.parse(text);
        content = String(j?.choices?.[0]?.message?.content ?? '').replace(/\s+/g, ' ').slice(0, 40);
      } catch {
        content = text.slice(0, 40);
      }
      detail = content || '(空回复)';
    }
    return { ok, ms, status: res.status, detail, model, totalTokens: usage?.total_tokens ?? null };
  } catch (err) {
    return { ok: false, ms: Date.now() - started, status: 0, detail: `连接失败: ${err?.message ?? err}`, model, totalTokens: null };
  } finally {
    clearTimeout(timer);
  }
}

const config = loadConfig();
const list = config.providers.filter((p) => (only ? p.id === only : true));

console.log(`探测 ${list.length} 个渠道（超时 ${timeoutMs}ms）${doVision ? ' + vision' : ''}${doTools ? ' + tools' : ''}\n`);

const rows = [];
const reports = []; // 回报给代理的状态
for (const p of list) {
  const chk = isConfigured(p);
  if (!chk.ok) {
    rows.push({ 渠道: p.id, 项: '配置', 结果: `跳过（${chk.why}）`, 状态: '-', 耗时: '-', 模型: '-' });
    if (!has('all')) continue;
  }
  const checks = [['text', await probe(p, 'text')]];
  if (doVision) checks.push(['vision', await probe(p, 'vision')]);
  if (doTools) checks.push(['tools', await probe(p, 'tools')]);

  // 渠道整体算通过还是失败：任一项通过就算"能连上"；全败则带上第一条失败原因
  const okAny = checks.some(([, r]) => r.ok);
  const firstBad = checks.find(([, r]) => !r.ok);
  const textCheck = checks.find(([name]) => name === 'text');
  reports.push({
    providerId: p.id,
    ok: okAny,
    message: okAny ? null : `${firstBad?.[0] ?? 'text'}: ${firstBad?.[1]?.detail ?? '失败'}`,
    // 自动调优用：文本项实测的 token 开销与耗时（越低越该排前面）
    totalTokens: textCheck?.[1]?.totalTokens ?? null,
    ms: textCheck?.[1]?.ms ?? null,
    priority: p.priority,
    manualOnly: Boolean(p.manualOnly),
  });

  for (const [name, r] of checks) {
    rows.push({
      渠道: p.id,
      项: name,
      结果: `${r.ok ? '✓' : '✗'} ${r.detail}`.slice(0, 70),
      状态: r.status || 'ERR',
      耗时: `${r.ms}ms`,
      // 实测 token 开销：自动调优就是按这一列排序的
      token: r.totalTokens ?? '-',
      模型: r.model ?? '-',
    });
  }
}

console.table(rows);

// 上报给代理：失败不影响探测结果本身，只是面板统计会不准
if (reportTo) {
  try {
    const res = await fetch(`${reportTo.replace(/\/+$/, '')}/admin/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ results: reports }),
    });
    const j = await res.json().catch(() => null);
    console.log(
      `\n已回报 ${reports.length} 条状态给代理（HTTP ${res.status}${j?.applied != null ? `，应用 ${j.applied} 条` : ''}）`
    );
  } catch (err) {
    console.log(`\n⚠️ 回报状态失败（${err?.message ?? err}）—— 探测结果仍然有效，只是面板统计没更新`);
  }
}

const bad = rows.filter((r) => r.结果.startsWith('✗'));
if (bad.length > 0) {
  console.log(`\n有 ${bad.length} 项没通过。常见原因：模型名过时（去官方文档核对）、该渠道免费模型已下线、网络不可达、能力声明写错。`);
  console.log('如果只是"声明了但实际不支持"，把 config.json 里对应渠道的 capabilities 改准即可。');
} else {
  console.log('\n全部通过。');
}

// ── 自动调优：按实测 token 开销重排 priority ──────────────────────────
if (has('tune')) {
  const ranked = reports
    .filter((r) => !r.manualOnly && r.ok && typeof r.totalTokens === 'number')
    .sort((a, b) => a.totalTokens - b.totalTokens || (a.ms ?? 0) - (b.ms ?? 0));

  if (ranked.length === 0) {
    console.log('\n⚠️ 没有可用于排序的实测数据（可能都没测通），跳过自动调优。');
  } else {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    const assigned = [];
    let next = 10;

    for (const r of ranked) {
      const p = (raw.providers ?? []).find((x) => x.id === r.providerId);
      if (!p) continue;
      if (p.priority !== next) {
        assigned.push(
          `${r.providerId.padEnd(20)} ${String(p.priority).padStart(3)} → ${String(next).padStart(3)}   (${r.totalTokens} token, ${r.ms}ms)`
        );
        p.priority = next;
      }
      next += 1;
    }

    if (assigned.length === 0) {
      console.log('\n优先级已经是最优的，无需改动。');
    } else {
      copyFileSync(CONFIG_PATH, `${CONFIG_PATH}.bak-${Date.now()}`);
      writeFileSync(CONFIG_PATH, `${JSON.stringify(raw, null, 2)}\n`, 'utf8'); // 无 BOM
      console.log('\n已按实测 token 开销重排 priority（越省越靠前）：');
      for (const a of assigned) console.log('  ' + a);
      console.log('  标记为手动专用的渠道（manualOnly）不参与排序。');
      console.log('  去面板点「重新加载配置」生效。');
    }
  }
}
