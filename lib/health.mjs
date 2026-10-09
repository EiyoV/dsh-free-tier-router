/**
 * 渠道健康状态与冷却。
 *
 * 设计要点：
 * - 冷却时长按失败类型区分：429（限流）退避最久，5xx 短退避，401/403（key 失效）长退避，
 *   这样一把填错的 key 不会在每个请求上白等一轮超时。
 * - 连续失败会指数放大冷却，成功一次立刻清零 —— 免费额度大多是"窗口恢复"型，
 *   到点就该立刻放它回来，所以冷却到期即视为可用。
 * - 429 如果带了 Retry-After，优先采用上游说的时长。
 */

const REASON = {
  rateLimit: 'rateLimit',
  serverError: 'serverError',
  authError: 'authError',
  network: 'network',
  badRequest: 'badRequest',
  empty: 'empty',
};

export const FAIL = REASON;

/**
 * 从上游错误消息里尽力解析"什么时候恢复"。
 *
 * 各家格式五花八门，能认几种算几种；认不出返回 null，面板会退回显示冷却倒计时。
 * 已知能认的：
 *   · 火山：You have exceeded the 5-hour usage quota. It will reset at 2026-10-10 00:13:46 +0800 CST
 *   · OpenAI 风格：Please try again in 1.5s  /  retry after 30 seconds
 *   · 中文：请 30 秒后重试 / 1 分钟后重试
 */
export function parseResetAt(message) {
  if (!message || typeof message !== 'string') return null;

  // 绝对时间：YYYY-MM-DD HH:MM:SS（可带时区偏移）
  const abs =
    /([0-9]{4})-([0-9]{2})-([0-9]{2})[ T]([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\s*([+-][0-9]{2}):?([0-9]{2}))?/.exec(
      message
    );
  if (abs) {
    const [, y, mo, d, h, mi, sec, tzH, tzM] = abs;
    const tz = tzH ? `${tzH}:${tzM ?? '00'}` : '';
    const t = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${sec}${tz}`);
    // 太旧的时间（比如消息里提到的是过去）不算
    if (Number.isFinite(t) && t > Date.now() - 86400000) return t;
  }

  // 相对时间：英文
  const rel =
    /(?:try again|retry|reset)\s*(?:in|after)\s*([0-9.]+)\s*(ms|s|sec|secs|seconds|m|min|mins|minutes|h|hours?)/i.exec(
      message
    );
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    const factor = unit === 'ms' ? 1 : unit.startsWith('s') ? 1000 : unit.startsWith('m') ? 60000 : 3600000;
    if (Number.isFinite(n)) return Date.now() + n * factor;
  }

  // 相对时间：中文
  const zh = /([0-9.]+)\s*(毫秒|秒|分钟|小时)\s*(?:后|之后)/.exec(message);
  if (zh) {
    const n = Number(zh[1]);
    const factor = zh[2] === '毫秒' ? 1 : zh[2] === '秒' ? 1000 : zh[2] === '分钟' ? 60000 : 3600000;
    if (Number.isFinite(n)) return Date.now() + n * factor;
  }

  return null;
}

/** 把上游 HTTP 状态码归类成失败原因。 */
export function classifyStatus(status) {
  if (status === 429) return REASON.rateLimit;
  if (status === 401 || status === 403) return REASON.authError;
  if (status === 402) return REASON.authError; // 余额不足，等同不可用
  if (status === 404) return REASON.badRequest; // 模型名/接入点不对
  if (status >= 500) return REASON.serverError;
  if (status >= 400) return REASON.badRequest;
  return null;
}

export class HealthRegistry {
  constructor(cooldownCfg) {
    this.cfg = cooldownCfg;
    this.state = new Map();
  }

  _get(id) {
    let s = this.state.get(id);
    if (!s) {
      s = {
        id,
        cooldownUntil: 0,
        consecutiveFailures: 0,
        lastError: null,
        lastErrorAt: null,
        lastOkAt: null,
        /** 上游明确告知的恢复时间（毫秒时间戳）；解析不出来就是 null */
        resetAt: null,
        totalRequests: 0,
        totalFailures: 0,
        totalOk: 0,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
      this.state.set(id, s);
    }
    return s;
  }

  isAvailable(id, now = Date.now()) {
    const s = this._get(id);
    return s.cooldownUntil <= now;
  }

  /** 距离可用还要多久（毫秒），0 表示现在可用。 */
  retryAfterMs(id, now = Date.now()) {
    const s = this._get(id);
    return Math.max(0, s.cooldownUntil - now);
  }

  cooldownRemaining(id) {
    return this.retryAfterMs(id);
  }

  markRequest(id) {
    this._get(id).totalRequests += 1;
  }

  markSuccess(id, usage) {
    const s = this._get(id);
    s.consecutiveFailures = 0;
    s.cooldownUntil = 0;
    s.lastError = null;
    s.resetAt = null;
    s.lastOkAt = Date.now();
    s.totalOk += 1;
    if (usage) {
      s.usage.promptTokens += Number(usage.prompt_tokens ?? 0);
      s.usage.completionTokens += Number(usage.completion_tokens ?? 0);
      s.usage.totalTokens += Number(usage.total_tokens ?? 0);
    }
  }

  /**
   * 记录一次**探测**结果：更新统计与最近状态，但**不设置冷却**。
   *
   * 为什么单独一个方法：探测是独立进程直连上游做的（为了不受代理的能力过滤干扰，
   * 才真能验证 capabilities 声明准不准），它不是真实流量，不该影响调度决策 ——
   * 否则一次误报的探测会把好渠道冷却掉。
   */
  markProbe(id, ok, detail = {}) {
    const s = this._get(id);
    s.totalRequests += 1;
    if (ok) {
      s.totalOk += 1;
      s.lastOkAt = Date.now();
      s.lastError = null;
    } else {
      s.totalFailures += 1;
      s.lastError = detail.message ?? '探测失败';
      s.lastErrorAt = Date.now();
      s.resetAt = parseResetAt(detail.message);
    }
  }

  /**
   * 记录失败并设置冷却。
   * @param {string} id
   * @param {string} reason 见 FAIL
   * @param {{message?:string, retryAfterMs?:number}} [detail]
   */
  markFailure(id, reason, detail = {}) {
    const s = this._get(id);
    s.consecutiveFailures += 1;
    s.totalFailures += 1;
    s.lastError = detail.message ?? reason;
    s.lastErrorAt = Date.now();
    // 上游说了恢复时间就用它 —— 面板上显示"14:35 恢复"比"冷却还剩 3600 秒"直观得多
    s.resetAt = parseResetAt(detail.message);

    // 注意：this.cfg 就是 cooldown 配置对象本身（由 index.mjs 传 config.policy.cooldown），
    // 不要再取 .cooldown —— 那会得到 undefined 并在每次失败时抛异常。
    const { minMs, maxMs } = this.cfg;
    let base;
    switch (reason) {
      case REASON.rateLimit:
        base = this.cfg.rateLimitMs;
        break;
      case REASON.authError:
        base = this.cfg.authErrorMs;
        break;
      case REASON.serverError:
      case REASON.network:
      case REASON.empty:
        base = this.cfg.serverErrorMs;
        break;
      case REASON.badRequest:
      default:
        // 请求本身有问题（比如模型名不对）—— 短冷却，且不要惩罚成倍放大
        base = Math.max(minMs, 5000);
        break;
    }

    // 指数放大：第 1 次 base，第 2 次 2×，第 3 次 4×……
    const growth = reason === REASON.badRequest ? 1 : 2 ** Math.min(s.consecutiveFailures - 1, 4);
    let wait = base * growth;
    if (detail.retryAfterMs && Number.isFinite(detail.retryAfterMs)) {
      wait = Math.max(wait, detail.retryAfterMs);
    }
    wait = Math.min(Math.max(wait, minMs), maxMs);
    s.cooldownUntil = Date.now() + wait;
    s.cooldownReason = reason;
    return wait;
  }

  /** 手动解除冷却（运维用）。 */
  clear(id) {
    const s = this._get(id);
    s.cooldownUntil = 0;
    s.consecutiveFailures = 0;
    s.lastError = null;
    s.resetAt = null;
  }

  snapshot() {
    const now = Date.now();
    return [...this.state.values()].map((s) => ({
      ...s,
      coolingMs: Math.max(0, s.cooldownUntil - now),
      available: s.cooldownUntil <= now,
    }));
  }
}
