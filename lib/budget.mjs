/**
 * 额度熔断：在额度**用完之前**就把渠道降级或停掉。
 *
 * 为什么需要它（和 health.mjs 的分工）：
 *   · health.mjs 是**事后**的 —— 只有收到 429/402 才会把渠道冷却掉。
 *     对免费额度来说，这顶多浪费一次请求；但免费额度超额是**报错**，不是**欠费**。
 *   · 对**按量付费**渠道（火山 /api/v3 这类），欠费发生在响应返回之前：
 *     请求成功 → 当场计费 → 余额扣穿。事后切换救不回来，所以必须**事前**判断。
 *   两件事互不替代：health 管"已经不能用了"，budget 管"快不能用了"。
 *
 * 三层信息源（优先级从高到低），没有就不猜、不干预：
 *   1. 上游报的真实剩余 —— 响应头 x-ratelimit-remaining-tokens（Groq / Cerebras 等）；
 *   2. 本地累计 usage ÷ 配置额度 —— 只统计经过本代理的流量（DSH 直连的算不到）；
 *   3. 都没有 —— 状态 unconfigured，调度完全不受影响（默认零配置行为不变）。
 *
 * 两档阈值（这是"不会白扔剩余额度"的关键）：
 *   · softRatio（默认 0.9）：**只降排序** —— 排到候选队尾，别人能用就先用别人；
 *   · hardRatio（默认 1.0）：**真正禁用**，连"全在冷却时兜底"都不会捞它回来。
 *   免费渠道用软档就够（超额只报错）；按量付费渠道才需要硬档，且建议设 0.8。
 *
 * 配置写在 provider 的 limits 里（老配置只有 note 时 budget 为 null → 行为不变）：
 *   "limits": {
 *     "note": "…………",
 *     "window": "90d",          // day / month / 90d / total（total = 永不重置，默认）
 *     "tokens": 1000000,        // 该周期 token 上限
 *     "cost": 20,               // 或金额上限，配合 priceIn / priceOut（元/百万 token）
 *     "priceIn": 1.2, "priceOut": 4,
 *     "softRatio": 0.9, "hardRatio": 0.8,
 *     "expiresAt": "2027-01-01T00:00:00+08:00"   // 可选：绝对到期（如百炼 90 天）
 *   }
 */
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { USAGE_PATH } from './paths.mjs';

const VERSION = 1;
const WRITE_THROTTLE_MS = 500;
/** 上游报的剩余额度多久算过期（过期就退回本地累计） */
const REPORT_TTL_MS = 30 * 60 * 1000;
/** 没配额度数字的渠道：用量按天清零（纯统计，不熔断） */
const DEFAULT_STATS_WINDOW_MS = 86400000;

const UNIT_MS = { h: 3600000, d: 86400000, w: 7 * 86400000, mo: 30 * 86400000 };

/** '90d' / 'month' / 'total' → 毫秒；无法识别或表示"不重置"时返回 null。 */
export function parseWindow(spec) {
  if (spec === undefined || spec === null) return null;
  const s = String(spec).trim().toLowerCase();
  if (!s || s === 'total' || s === 'never' || s === 'none') return null;
  if (s === 'hour') return UNIT_MS.h;
  if (s === 'day') return UNIT_MS.d;
  if (s === 'week') return UNIT_MS.w;
  if (s === 'month') return UNIT_MS.mo;
  const m = /^([0-9.]+)\s*(h|hour|hours|d|day|days|w|week|weeks|mo|month|months)$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n * (UNIT_MS[m[2].slice(0, 2)] ?? UNIT_MS[m[2][0]]);
}

function num(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 把 provider.limits 规范化成熔断配置。
 * @returns {null|{tokens:number|null, cost:number|null, windowMs:number|null,
 *   softRatio:number, hardRatio:number, expiresAt:number|null,
 *   priceIn:number, priceOut:number, note:string}}
 *   null = 这个渠道没配额度数字 → 不统计、不干预
 */
export function normalizeBudget(limits) {
  const L = limits ?? {};
  const tokens = num(L.tokens ?? L.limitTokens);
  const cost = num(L.cost ?? L.limitCost);
  const expiresAtRaw = L.expiresAt ?? L.expires;
  const expiresAt = expiresAtRaw ? Date.parse(expiresAtRaw) : NaN;
  const hasExpiry = Number.isFinite(expiresAt);
  // balance: true = 只信平台自报的剩余额度（OpenRouter 的 /api/v1/key 这类），
  // 不需要用户填任何数字 —— 平台没报总额度时 assess 会返回 unconfigured，不会误判。
  const useBalance = Boolean(L.balance ?? L.autoBalance);

  // 只有 note（老配置）→ 完全没有熔断语义
  if (tokens === null && cost === null && !hasExpiry && !useBalance) return null;
  if (tokens !== null && tokens <= 0) return null;

  let soft = num(L.softRatio) ?? 0.9;
  let hard = num(L.hardRatio) ?? 1.0;
  // 配置写反了也不至于失效：夹到 (0,1.2] 并保证 soft <= hard
  soft = Math.min(Math.max(soft, 0.05), 1.2);
  hard = Math.min(Math.max(hard, 0.05), 1.2);
  if (hard < soft) [soft, hard] = [hard, soft];

  return {
    tokens,
    cost,
    windowMs: parseWindow(L.window),
    softRatio: soft,
    hardRatio: hard,
    expiresAt: hasExpiry ? expiresAt : null,
    priceIn: num(L.priceIn) ?? 0,
    priceOut: num(L.priceOut) ?? 0,
    note: typeof L.note === 'string' ? L.note : '',
    /** 免费额度用完只是报错 → 默认不硬禁；付费渠道请显式设 hardRatio */
    paid: Boolean(L.paid),
    /** true = 额度的绝对数字只来自平台自报（balance.mjs 查到的真实剩余） */
    useBalance,
    /** true = 这份额度是**每个模型各自一份**（同一渠道下多模型各记各的账） */
    perModel: Boolean(L.perModel),
  };
}

/** 从上游响应头读真实剩余额度（Groq / Cerebras / OpenAI 风格）。 */
function remainingFromHeaders(headers) {
  if (!headers || typeof headers.get !== 'function') return null;
  const r = num(headers.get('x-ratelimit-remaining-tokens'));
  if (r === null) return null;
  const l = num(headers.get('x-ratelimit-limit-tokens'));
  return { remaining: r, limit: l !== null && l > 0 ? l : null };
}

/** 记账键：perModel 的渠道按「渠道::模型」**各自**计数，否则整个渠道共用一份。 */
function slotKey(provider, model) {
  return provider?.budget?.perModel && model ? `${provider.id}::${model}` : provider.id;
}

/** 一个渠道下所有可用的模型（defaultModel 排最前，去重）。 */
function modelList(provider) {
  const out = [];
  if (provider?.defaultModel) out.push(provider.defaultModel);
  for (const m of provider?.models ?? []) if (!out.includes(m)) out.push(m);
  return out;
}

function freshSlot() {
  return {
    windowStart: Date.now(),
    usedTokens: 0,
    usedCost: 0,
    requests: 0,
    lastUsedAt: null,
    reported: null,
    reportedAt: 0,
  };
}

function load(path) {
  try {
    if (!existsSync(path)) return { version: VERSION, providers: {} };
    const j = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
    if (!j || typeof j !== 'object' || typeof j.providers !== 'object' || j.providers === null) {
      return { version: VERSION, providers: {} };
    }
    return { version: VERSION, providers: j.providers };
  } catch {
    // 用量文件坏了不该挡住代理启动 —— 丢掉重来
    return { version: VERSION, providers: {} };
  }
}

/**
 * 用量账本 + 熔断判定。
 * 用量**持久化**（跨 DSH 重启保留），否则重启一次就等于"额度又满了"。
 */
export class BudgetTracker {
  constructor({ path = USAGE_PATH, log = () => {} } = {}) {
    this.path = path;
    this.log = log;
    this.data = load(path);
    this.dirty = false;
    this.lastWrite = 0;
    this.timer = null;
  }

  _slot(id) {
    let s = this.data.providers[id];
    if (!s) {
      s = freshSlot();
      this.data.providers[id] = s;
    }
    return s;
  }

  /**
   * 窗口滚动：到点了就把计数清零。
   *   · 配了 window 的按配置走；配了但没 window（total）→ 永不重置；
   *   · **没配额度数字**的渠道按天重置 —— 那只是纯统计，面板上"今日用量"才有意义，
   *     但它不参与任何熔断判定（assess 对这类渠道返回 unconfigured）。
   */
  _rollWindow(s, budget, now) {
    const ms = budget ? (budget.windowMs ?? null) : DEFAULT_STATS_WINDOW_MS;
    if (ms && now - s.windowStart >= ms) {
      s.windowStart = now;
      s.usedTokens = 0;
      s.usedCost = 0;
      s.reported = null;
      s.reportedAt = 0;
      this.dirty = true;
      return true;
    }
    return false;
  }

  /**
   * 记录一次成功的用量。
   * @param {object} provider 归一化后的渠道（含 budget）
   * @param {object|null} usage OpenAI 风格 usage
   * @param {Headers|null} headers 上游响应头（用于读真实剩余额度）
   * @param {string|null} model 本次用的模型（perModel 的渠道按它分账）
   */
  observe(provider, usage, headers, model = null) {
    const b = provider?.budget ?? null;
    const s = this._slot(slotKey(provider, model));
    const now = Date.now();
    this._rollWindow(s, b, now);

    const pt = num(usage?.prompt_tokens) ?? 0;
    const ct = num(usage?.completion_tokens) ?? 0;
    const tt = num(usage?.total_tokens) ?? pt + ct;
    if (tt > 0) {
      s.usedTokens += tt;
      s.lastUsedAt = now;
    }
    s.requests += 1;

    if (b && (b.priceIn > 0 || b.priceOut > 0)) {
      s.usedCost += (pt / 1e6) * b.priceIn + (ct / 1e6) * b.priceOut;
    }

    const rep = remainingFromHeaders(headers);
    if (rep) {
      s.reported = rep;
      s.reportedAt = now;
    }

    this.dirty = true;
    this.flush();
  }

  /**
   * 灌入**平台自报**的真实剩余额度（balance.mjs 查到的 OpenRouter /api/v1/key 这类）。
   * 可信度与上游响应头同级 —— 都是"平台自己说的"，优先于本地累计。
   * @returns {boolean} 是否成功记录
   */
  reportRemaining(providerId, { remaining, limit } = {}, model = null) {
    if (!Number.isFinite(remaining)) return false;
    const s = this._slot(model ? `${providerId}::${model}` : providerId);
    s.reported = { remaining, limit: Number.isFinite(limit) && limit > 0 ? limit : null };
    s.reportedAt = Date.now();
    this.dirty = true;
    this.flush();
    return true;
  }

  /**
   * 判定某个渠道现在的额度状态。
   * @returns {{state:'ok'|'soft'|'hard'|'unconfigured', ratio:number|null, used:number|null,
   *   limit:number|null, source:string|null, resetsAt:number|null, reason:string}}
   */
  assess(provider, model = null) {
    const b = provider?.budget ?? null;

    // perModel 的渠道不判"渠道级"：那由"挑哪一个模型"的循环逐模型判定（见 pool.mjs）
    if (b?.perModel && !model) {
      return {
        model: null,
        usedTokens: 0,
        usedCost: 0,
        requests: 0,
        windowStart: 0,
        resetsAt: null,
        state: 'unconfigured',
        ratio: null,
        used: null,
        limit: null,
        source: null,
        reason: '',
      };
    }

    const s = this._slot(slotKey(provider, model));
    const now = Date.now();
    this._rollWindow(s, b, now);

    const base = {
      model,
      usedTokens: s.usedTokens,
      usedCost: s.usedCost,
      requests: s.requests,
      windowStart: s.windowStart,
      resetsAt: b?.windowMs ? s.windowStart + b.windowMs : null,
    };

    if (!b) {
      return { ...base, state: 'unconfigured', ratio: null, used: null, limit: null, source: null, reason: '' };
    }

    if (b.expiresAt && now >= b.expiresAt) {
      return {
        ...base,
        state: 'hard',
        ratio: 1,
        used: null,
        limit: null,
        source: 'expiry',
        reason: `额度已于 ${new Date(b.expiresAt).toLocaleString('zh-CN')} 到期`,
      };
    }

    // 1) 上游报的真实剩余最准
    let limit = null;
    let used = null;
    let ratio = null;
    let source = null;

    if (s.reported && now - s.reportedAt < REPORT_TTL_MS) {
      if (s.reported.limit) {
        limit = s.reported.limit;
        used = limit - s.reported.remaining;
      } else {
        // 上游只给了"还剩多少"，没有总量 —— 用配置额度当分母
        limit = b.tokens ?? null;
        used = limit ? limit - s.reported.remaining : null;
      }
      if (limit && limit > 0 && used !== null) {
        ratio = Math.max(0, used) / limit;
        source = '上游响应头';
      }
    }

    // 2) 退回本地累计
    if (ratio === null && b.tokens) {
      limit = b.tokens;
      used = s.usedTokens;
      ratio = used / limit;
      source = '本地累计';
    }
    if (ratio === null && b.cost) {
      limit = b.cost;
      used = s.usedCost;
      ratio = used / limit;
      source = '本地估算费用';
    }

    if (ratio === null) {
      return { ...base, state: 'unconfigured', ratio: null, used: null, limit: null, source: null, reason: '' };
    }

    const state = ratio >= b.hardRatio ? 'hard' : ratio >= b.softRatio ? 'soft' : 'ok';
    const pct = (ratio * 100).toFixed(1);
    const reason =
      state === 'hard'
        ? `已用 ${pct}% ≥ 硬阈值 ${(b.hardRatio * 100).toFixed(0)}%，停止使用（防超额/欠费）`
        : state === 'soft'
          ? `已用 ${pct}% ≥ 软阈值 ${(b.softRatio * 100).toFixed(0)}%，降为最低优先级`
          : '';

    return { ...base, state, ratio, used, limit, source, reason };
  }

  /** 面板用：每个渠道（perModel 的渠道则每个模型）的用量与状态。 */
  snapshot(providers) {
    const out = [];
    for (const p of providers ?? []) {
      const meta = {
        providerId: p.id,
        configured: Boolean(p.budget),
        softRatio: p.budget?.softRatio ?? null,
        hardRatio: p.budget?.hardRatio ?? null,
        window: p.budget?.windowMs ? p.budget.windowMs / 86400000 : null,
        paid: Boolean(p.budget?.paid),
        perModel: Boolean(p.budget?.perModel),
      };

      if (p.budget?.perModel) {
        // 每个模型一行 —— 这样面板才看得出"哪个模型烧完了、还有几个能顶"
        const rows = modelList(p).map((m) => ({
          id: `${p.id}::${m}`,
          label: `${p.label} · ${m}`,
          ...meta,
          ...this.assess(p, m),
        }));
        const usable = rows.filter((r) => r.state !== 'hard').length;
        for (const r of rows) r.modelsUsable = usable;
        out.push(...rows);
        continue;
      }

      out.push({ id: p.id, label: p.label, ...meta, ...this.assess(p) });
    }
    return out;
  }

  /** 手动清零（面板上的「重置用量」，也支持 `渠道::模型`）。 */
  reset(id) {
    if (id) {
      this.data.providers[id] = freshSlot();
      // 传渠道 id 时，把它的所有模型分账一并清掉
      if (!id.includes('::')) {
        for (const k of Object.keys(this.data.providers)) {
          if (k.startsWith(`${id}::`)) this.data.providers[k] = freshSlot();
        }
      }
    } else {
      this.data.providers = {};
    }
    this.dirty = true;
    this.flush(true);
  }

  flush(force = false) {
    if (!this.dirty) return;
    const now = Date.now();
    if (!force && now - this.lastWrite < WRITE_THROTTLE_MS) {
      if (!this.timer) {
        // 节流补写：写完就清掉；unref 保证它不会拖住进程退出
        this.timer = setTimeout(() => {
          this.timer = null;
          this.flush(true);
        }, WRITE_THROTTLE_MS);
        this.timer.unref?.();
      }
      return;
    }
    try {
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: VERSION, providers: this.data.providers }), 'utf8');
      renameSync(tmp, this.path);
      this.dirty = false;
      this.lastWrite = now;
    } catch (err) {
      // 写不进去（权限/磁盘）不该影响请求本身，只在日志里说一次
      this.dirty = false;
      this.log(`用量文件写入失败（不影响请求）：${err?.message ?? err}`);
    }
  }
}
