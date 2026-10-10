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
 *   同时 available() 只在**配了 key** 时为 true，没配就不参与竞争。
 *
 * key 来源（与 lib/config.mjs 的既有约定一致：process.env 高于 .env 文件）：
 *   1. process.env.TAVILY_API_KEY
 *   2. ~/.dsh/llm-router/.env 的 TAVILY_API_KEY   ← 渠道密钥统一放这里
 *   3. ~/.dsh/tavily-key.txt（web-search-safe MCP 用的那份，复用免得重填一次）
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadEnvFile } from './config.mjs';

export const TAVILY_SEARCH_URL = 'https://api.tavily.com/search';

const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_MAX_RESULTS = 8;
const MAX_RESULTS_CAP = 20;

/**
 * 回退 key 文件：一行 key 即可，可带 `TAVILY_API_KEY=` 前缀，支持 # 注释。
 * 这是 web-search-safe MCP 先落地时用的存放点，这里读它只是为了不让人重填一遍。
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
 * 解析 Tavily API key。
 * @returns {{key: string, origin: string}} key 为空表示未配置；origin 用于日志。
 */
export function resolveTavilyKey() {
  const fromProc = String(process.env.TAVILY_API_KEY ?? '').trim();
  if (fromProc) return { key: fromProc, origin: '$TAVILY_API_KEY' };

  const fromEnvFile = String(loadEnvFile().TAVILY_API_KEY ?? '').trim();
  if (fromEnvFile) return { key: fromEnvFile, origin: '.env' };

  const fromFile = readFallbackKeyFile();
  if (fromFile) return { key: fromFile, origin: '~/.dsh/tavily-key.txt' };

  return { key: '', origin: '' };
}

/**
 * 构造 dsh-web 的 WebSearchProvider。
 * 契约只有三个成员：id / available() / search(request, signal)。
 * @param {{timeoutMs?: number}} [options]
 */
export function createTavilyProvider(options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    id: 'tavily',

    /** 没配 key 就返回 false —— 这样不会和内置 provider 撞出 AMBIGUOUS。 */
    available: () => resolveTavilyKey().key !== '',

    async search(request, signal) {
      const { key } = resolveTavilyKey();
      if (!key) {
        throw new Error('未配置 Tavily API key：填 ~/.dsh/llm-router/.env 的 TAVILY_API_KEY（或 ~/.dsh/tavily-key.txt）');
      }

      const asked = Number(request?.maxResults);
      const maxResults = Math.min(Math.max(Number.isFinite(asked) && asked > 0 ? asked : DEFAULT_MAX_RESULTS, 1), MAX_RESULTS_CAP);

      // 自带超时；调用方给了 signal 就两个一起生效（老 Node 没有 AbortSignal.any 时退回调用方的）
      const timeout = AbortSignal.timeout(timeoutMs);
      const combined =
        signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : signal ?? timeout;

      const res = await fetch(TAVILY_SEARCH_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          query: request.query,
          max_results: maxResults,
          search_depth: 'basic', // 1 credit/次（advanced 为 2，免费额度 1000/月）
          include_answer: true, // 让 Tavily 顺带给一段摘要，DSH 把它显示成搜索摘要
        }),
        redirect: 'error', // 与项目其它出网调用一致：不跟随重定向
        signal: combined,
      });

      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 300);
        const hint =
          res.status === 401 ? '（key 无效）'
          : res.status === 429 ? '（请求过于频繁）'
          : res.status === 432 ? '（套餐额度已用尽）'
          : res.status === 433 ? '（按量付费上限已到）'
          : '';
        throw new Error(`Tavily HTTP ${res.status}${hint}: ${detail}`);
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
    },
  };
}
