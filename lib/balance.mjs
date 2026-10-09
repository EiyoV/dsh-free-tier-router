/**
 * 尽量查各平台的剩余额度。
 *
 * 现实是：**大多数平台没有公开的余额接口**。实测（2026-10-09）：
 *   · OpenRouter  ✅ GET /api/v1/key → { limit, limit_remaining, usage, is_free_tier, expires_at }
 *   · 智谱/百炼/千帆 ✅ 有 /models（能核实模型名，但**不含余额**）
 *   · 硅基流动    ✗ /v1/user/info 已废弃（HTTP 410）
 *
 * 查不到就返回 null —— 面板会显示"该平台不提供查询接口"，而不是编一个数字。
 * 这与"什么时候恢复额度"是两件事：恢复时间可以从限流错误消息里解析（见 health.mjs）。
 */

const CACHE = new Map(); // providerId -> { at, value }
const TTL_MS = 5 * 60 * 1000; // 余额不用查太勤

/**
 * @param {{id:string, baseURL:string, apiKey?:string}} provider
 * @returns {Promise<null|{kind:string, limit:number|null, remaining:number|null, usage:number|null,
 *   isFreeTier?:boolean, expiresAt?:string|null, note:string}>}
 */
export async function fetchBalance(provider) {
  const key = provider.apiKey;
  if (!key) return null;

  const cached = CACHE.get(provider.id);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;

  let value = null;
  try {
    if (/openrouter\.ai/i.test(provider.baseURL ?? '')) {
      value = await openRouterBalance(key);
    }
    // 其他平台目前没有公开的余额接口，留 null
  } catch {
    value = null;
  }

  CACHE.set(provider.id, { at: Date.now(), value });
  return value;
}

async function openRouterBalance(key) {
  const r = await fetch('https://openrouter.ai/api/v1/key', {
    headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) return null;

  const j = await r.json().catch(() => null);
  const d = j?.data;
  if (!d) return null;

  return {
    kind: 'openrouter',
    limit: d.limit ?? null,
    remaining: d.limit_remaining ?? null,
    usage: d.usage ?? null,
    isFreeTier: Boolean(d.is_free_tier),
    expiresAt: d.expires_at ?? null,
    note: 'OpenRouter 官方 /api/v1/key',
  };
}

/** 清掉缓存（强制下次重新查）。 */
export function clearBalanceCache() {
  CACHE.clear();
}
