/**
 * Tavily 搜索 provider：把 Tavily Search API 接进 DSH 的 `ctx.web` 服务。
 *
 * 为什么走 provider，而不是配内置的 dsh-web-search-deepseek：
 *   `ctx.web` 是「服务 + 可插拔 provider」结构，`registerSearchProvider()` 就是公开的
 *   注册点。内置那个只是**恰好实现了同一个接口的一个 provider**——它内部写死 Anthropic
 *   Messages 协议（请求打 baseURL + /messages，还要从响应里读 web_search_tool_result），
 *   所以怎么改 baseURL 都接不上 Tavily 的 REST 接口。注册自己的 provider 之后，DSH
 *   原生的 `web_search` 工具就走 Tavily，不再受内置 provider 的协议限制。
 *
 * provider 选择语义（dsh-web 在执行期解析，不是按注册顺序）：
 *   配了 id 且已注册且 available() → 用它；
 *   没配 id + 恰好一个 available  → 用它；
 *   没配 id + 多个 available      → 抛 WEB_PROVIDER_AMBIGUOUS。
 *   所以本插件在自己的 cordis.patch.yml 里把 `web.searchProvider` 钉成 'tavily'；
 *   available() 只在**配到至少一把 key** 时为 true，没配就不参与竞争。
 *
 * ── 多把 key（和渠道池一个语义）──────────────────────────────────────
 * 槽位就是 .env 里的变量名：`TAVILY_API_KEY`、`TAVILY_API_KEY_2`、`TAVILY_API_KEY_3`…
 * 搜索时**按序逐把试**，这把不行就换下一把 —— 与 lib/server.mjs 里 LLM 渠道的
 * nextKey / keyIndex / attempts 是同一套思路，只是这里挂在搜索 provider 上。
 *
 * 为什么值得轮换：免费档那 1000 credits/月 是**按账号**算的，所以多把不同账号的 key
 * 才真是把额度叠起来；同账号的多把 key 共用额度，只在故障兜底时有意义
 * （面板上「同账号多 key 共享额度」那句提示说的就是这件事）。
 *
 * key 来源（与 lib/config.mjs 的既有约定一致：process.env 高于 .env 文件）：
 *   1. .env / process.env 里的 TAVILY_API_KEY[_N]
 *   2. ~/.dsh/tavily-key.txt（web-search-safe 先落地时的存放点，兼容读一把）
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadEnvFile } from './config.mjs';

export const TAVILY_SEARCH_URL = 'https://api.tavily.com/search';

/** 主槽名。与 catalog.json 里 tavily 条目的 apiKeyEnv 一致，面板据此渲染槽位。 */
export const TAVILY_SLOT_BASE = 'TAVILY_API_KEY';
/** 追加槽上限：个人场景够用，也避免面板列一长串没意义的空行。 */
export const TAVILY_SLOT_MAX = 9;

const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_MAX_RESULTS = 8;
const MAX_RESULTS_CAP = 20;

/**
 * 该换下一把 key 的状态码 —— 都是「这把 key 自己不行 / 它的配额到顶 / 上游抖动」：
 *   401 403 = key 无效或无权限；429 = 这把被限流（不同 key 配额独立，换一把还能打）；
 *   432 433 = 该账号套餐额度 / 按量上限到顶（多账号叠额度的主要场景）；5xx = 上游抖动。
 * 不在表里的（400 / 422 这类）是**请求本身不合法**，换 key 也是同样的错，直接抛。
 */
const ROTATE_STATUSES = new Set([401, 403, 429, 432, 433, 500, 502, 503, 504]);

/** 槽位名序列：主槽 + _2 … _MAX。 */
export function tavilySlotNames() {
  const out = [TAVILY_SLOT_BASE];
  for (let i = 2; i <= TAVILY_SLOT_MAX; i += 1) out.push(`${TAVILY_SLOT_BASE}_${i}`);
  return out;
}

/** 某个变量名是不是 Tavily 的合法槽位（account / save-key 之类接口据此放行）。 */
export function isTavilySlot(name) {
  return tavilySlotNames().includes(String(name));
}

/**
 * 兼容旧存放点 ~/.dsh/tavily-key.txt：一行 key 即可，可带 `TAVILY_API_KEY=` 前缀，支持 # 注释。
 * 读它是为了不让已经在那儿填过的人重填一遍。
 */
function readFallbackKeyFile() {
  try {
    const raw = readFileSync(join(homedir(), '.dsh', 'tavily-key.txt'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const text = line.trim();
      if (!text || text.startsWith('#')) continue;
      const value = text.includes('=') ? text.slice(text.indexOf('=') + 1) : text;
      const cleaned = value.trim().replace(/^["']|["']$/g, '').trim();
      if (cleaned) return cleaned;
    }
  } catch {
    /* 文件不存在/不可读 = 当作没配 */
  }
  return '';
}

/**
 * 解析所有可用的 Tavily key，按槽位顺序返回。
 * 空值跳过、同值去重（同一把 key 填两遍不会白试两次）。
 * @returns {Array<{name: string, value: string, origin: string}>}
 */
export function resolveTavilyKeys() {
  const merged = { ...loadEnvFile(), ...process.env }; // process.env 优先，与 config.mjs 一致
  const list = [];
  const seen = new Set();

  for (const name of tavilySlotNames()) {
    const raw = String(merged[name] ?? '').trim().replace(/^["']|["']$/g, '').trim();
    if (!raw || seen.has(raw)) continue;
    seen.add(raw);
    list.push({ name, value: raw, origin: process.env[name] ? '$env' : '.env' });
  }

  const legacy = readFallbackKeyFile();
  if (legacy && !seen.has(legacy)) {
    seen.add(legacy);
    list.push({ name: 'tavily-key.txt', value: legacy, origin: '~/.dsh/tavily-key.txt' });
  }

  return list;
}

/**
 * 单把 key 视图（供旧的调用点与自检显示沿用）。
 * @returns {{key: string, origin: string}} key 为空表示未配置。
 */
export function resolveTavilyKey() {
  const [first] = resolveTavilyKeys();
  return first ? { key: first.value, origin: first.origin } : { key: '', origin: '' };
}

/** 面板「增加一把」用的下一个空槽名；槽位已满返回 null。 */
export function nextTavilySlot(taken = []) {
  const busy = new Set((Array.isArray(taken) ? taken : []).map(String));
  return tavilySlotNames().find((n) => !busy.has(n)) ?? null;
}

/**
 * 打一次 Tavily。非 2xx 一律抛错（调用侧据此换下一把 key）。
 * 错误消息带上状态码含义，方便对着额度/限流排查；err.status 供上层分类。
 */
async function callTavily(request, key, signal, timeoutMs) {
  const asked = Number(request?.maxResults);
  const maxResults = Math.min(
    Math.max(Number.isFinite(asked) && asked > 0 ? asked : DEFAULT_MAX_RESULTS, 1),
    MAX_RESULTS_CAP
  );

  // 自带超时；调用方给了 signal 就两个一起生效（老 Node 没有 AbortSignal.any 时退回调用方的）
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined =
    signal && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([signal, timeout])
      : signal ?? timeout;

  const res = await fetch(TAVILY_SEARCH_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      query: request.query,
      max_results: maxResults,
      search_depth: 'basic', // 1 credit/次（advanced 为 2；免费档 1000 credits/月）
      include_answer: true, // 顺带要一段摘要，DSH 显示成搜索结果摘要
    }),
    redirect: 'error', // 与项目其它出网调用一致：不跟随重定向
    signal: combined,
  });

  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    const hint =
      res.status === 401 ? '（key 无效）'
      : res.status === 403 ? '（无权限）'
      : res.status === 429 ? '（频率超限）'
      : res.status === 432 ? '（该账号套餐额度已用尽）'
      : res.status === 433 ? '（按量付费上限已到）'
      : '';
    const err = new Error(`Tavily HTTP ${res.status}${hint}: ${detail}`);
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  const sources = (Array.isArray(data?.results) ? data.results : [])
    .map((r) => ({
      url: String(r?.url ?? ''),
      title: r?.title ? String(r.title) : undefined,
      snippet: r?.content ? String(r.content) : undefined,
      publishedAt: r?.published_date ? String(r.published_date) : undefined,
    }))
    .filter((s) => s.url);

  // truncated 交给 dsh-web 那层按 request.maxResults 统一裁定，这里恒为 false。
  return {
    content: data?.answer ? String(data.answer) : undefined,
    sources,
    truncated: false,
  };
}

/**
 * 哪些状态码该换下一把 key —— 都是「这把 key 自己不行 / 配额到顶」类：
 *   401 / 403 = key 无效或无权限；429 = 这把被限流（不同 key 配额独立，换一把还能打）；
 *   432 / 433 = 该账号套餐额度 / 按量上限到顶（多账号 key 叠额度的主要场景）；
 *   5xx = 上游抖动，换一把重试有意义。
 * 反过来，400 / 422 是**请求本身不合法**（比如 query 太短），换 key 也还是同样的错，
 * 逐把试只会白烧网络 —— 实测踩过：一把都不成功后才抛，浪费 N 次往返。
 * @param {unknown} err
 */
function shouldTryNextKey(err) {
  const status = err?.status;
  if (status === undefined) return true; // 网络错误 / 超时 / 非 JSON 响应：兜底换一把
  return ROTATE_STATUSES.has(status);
}

/**
 * 构造 dsh-web 的 WebSearchProvider。
 * 契约只有三个成员：id / available() / search(request, signal)。
 * @param {{timeoutMs?: number, onKeyFailure?: (info: {slot: string, error: unknown}) => void}} [options]
 */
export function createTavilyProvider(options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    id: 'tavily',

    /** 一把 key 都没有才 false —— 这样不会和内置 provider 撞出 AMBIGUOUS。 */
    available: () => resolveTavilyKeys().length > 0,

    /**
     * 按槽位顺序逐把试，失败就换下一把 —— 与渠道池对 LLM 渠道的多 key 语义一致。
     * 全部失败才抛错，并把每把的失败原因汇总出来（额度到顶 / 限流 / 网络，一眼分清）。
     */
    async search(request, signal) {
      const keys = resolveTavilyKeys();
      if (!keys.length) {
        throw new Error(
          '未配置 Tavily API key：在面板的 Tavily 卡片里填，或写 ~/.dsh/llm-router/.env 的 TAVILY_API_KEY'
        );
      }

      const failures = [];
      for (let i = 0; i < keys.length; i += 1) {
        const k = keys[i];
        try {
          const result = await callTavily(request, k.value, signal, timeoutMs);
          // 把"这次用的是第几把"带出去，面板/自检能看清现在靠哪把在跑
          return { ...result, keySlot: k.name, keyCount: keys.length };
        } catch (err) {
          failures.push(`#${i + 1} ${k.name}（${k.origin}）：${err?.message ?? err}`);
          if (typeof options.onKeyFailure === 'function') options.onKeyFailure({ slot: k.name, error: err });
          // 参数类错误（400 / 422）换 key 也是同样的错 —— 立刻抛，别把后面几把白烧一遍。
          if (!shouldTryNextKey(err)) {
            throw new Error(`${k.name}（${k.origin}）：${err?.message ?? err}`);
          }
          // 其余情况继续下一把：这把可能额度到顶 / 被限流 / 网络抖动，另一把还能用
        }
      }

      throw new Error(`${keys.length} 把 Tavily key 全部失败：\n  ${failures.join('\n  ')}`);
    },
  };
}
