/**
 * 图片预处理：在请求进路由器之前，把 image 部分「翻译」成文字描述。
 *
 * 为什么需要：
 *   免费池里同时具备 [image, tools] 的渠道通常只有一两个（本机是腾讯 tokenhub）。
 *   而 qq-bridge 在 reserved2 模式下，模型一旦调用 qq_get_message_images 取图，
 *   那个 image block 就会**永久留在对话历史里** —— 之后每一轮请求都被 inferNeeds
 *   判成需要 image + tools，整条会话被钉死在那唯一渠道上：既烧额度，又是单点。
 *
 * 做法：
 *   把所有 image part 抽出来，交给一个**只需要 image 能力**的渠道转写成文字，
 *   再把 image part 原地替换成这段文字。替换后 inferNeeds 只看到 text + tools，
 *   候选池立刻从 1 个渠道变回全部文本渠道。
 *
 * 代价（必须知情）：
 *   有损。主模型看到的是描述，不是原图，无法就图中细节反复追问。
 *   所以默认走「详描述」：主体 + 可见文字逐字转写 + 布局 + 颜色，
 *   尽量把「图里的信息」也保住，而不只是「知道是什么图」。
 *
 * 回退：
 *   转写失败一律**保留原图**，绝不因为预处理而让请求失败。
 *   同一张图按内容 hash 缓存，历史图片只转写一次。
 */
import { createHash } from 'node:crypto';

/** 详描述提示词：目标是「让看不到图的模型也能回答图里的细节」。 */
const DETAILED_PROMPT = [
  '你在为另一个看不到图片的文本模型做「图像转写」。只输出客观描述，不要寒暄、不要评论、不要输出 Markdown 标题。',
  '要求：',
  '1. 第一句概括这是什么图、什么场景。',
  '2. 把图中**所有可见文字逐字转写**（标题、正文、按钮、菜单项、字幕、水印、数字与单位都要）。看不清的写 [不清晰]。',
  '3. 描述主要对象的外观与位置（上/中/下、左/右），以及它们之间的关系。',
  '4. 如果是表情包/梗图，说明画面内容与上面的文字。',
  '5. 如果图中有表格、列表、代码或界面布局，按结构转写。',
  '6. 不要编造图中没有的信息。',
].join('\n');

/** 粗描述：只求便宜快，知道「是什么图」即可。 */
const BRIEF_PROMPT = '用一两句话客观描述这张图是什么、画面的主体是什么。不要寒暄。';

class LruCache {
  constructor(limit) {
    this.limit = Math.max(1, limit);
    this.map = new Map();
  }
  get(key) {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }
  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.limit) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }
  get size() {
    return this.map.size;
  }
}

/**
 * 从一个 content part 里取出图片源。
 * 兼容多种风格：OpenAI 的 image_url、Anthropic/DSH 的 source+base64、以及裸 data/url 字段。
 * @returns {string|null} data URL 或 http(s) URL
 */
export function extractImageSource(part) {
  if (!part || typeof part !== 'object') return null;
  const type = part.type;
  if (type !== 'image_url' && type !== 'image' && type !== 'input_image') return null;

  const imageUrl = part.image_url;
  if (typeof imageUrl === 'string' && imageUrl) return imageUrl;
  if (imageUrl && typeof imageUrl === 'object' && typeof imageUrl.url === 'string' && imageUrl.url) {
    return imageUrl.url;
  }
  if (typeof part.url === 'string' && part.url) return part.url;

  const src = (part.source && typeof part.source === 'object') ? part.source : part;
  const data = typeof src.data === 'string' && src.data ? src.data : null;
  if (data) {
    const mime = src.media_type || src.mediaType || part.mediaType || part.mimeType || 'image/png';
    return `data:${mime};base64,${data}`;
  }
  return null;
}

function hashSource(source) {
  return createHash('sha256').update(source).digest('hex').slice(0, 32);
}

/** 替换后的占位文本：明确告诉主模型「这是转写，别重复取图」。 */
function buildPlaceholder(desc) {
  return [
    '【图片内容·由视觉模型转写】',
    '原图没有传给本模型（本模型不支持看图），以下是对图片的转写，请据此回答；',
    '如果信息不足，请直接说明描述里没有该细节，不要重复调用取图工具。',
    '',
    desc,
  ].join('\n');
}

/**
 * 建一个图片预处理器。
 * @param {object} p
 * @param {object} p.config    完整路由器配置（读 config.visionPreprocess）
 * @param {Array}  p.providers 已解析的渠道列表
 * @param {Function} p.log
 * @param {Function} p.callUpstream 打上游的函数（由 server.mjs 注入，避免循环依赖）
 */
export function createVisionPreprocessor({ config, providers, log = () => {}, callUpstream }) {
  const opt = config?.visionPreprocess ?? {};
  const enabled = opt.enabled === true;
  const cache = new LruCache(Number(opt.cacheSize) || 200);
  const stats = { requests: 0, images: 0, described: 0, cached: 0, failed: 0, degraded: 0 };

  function pickVisionTarget() {
    const wanted = opt.provider ? String(opt.provider) : '';
    if (wanted) {
      const hit = providers.find((x) => x.id === wanted);
      if (hit && Array.isArray(hit.capabilities) && hit.capabilities.includes('image')) {
        return { provider: hit, model: opt.model || hit.defaultModel || hit.models?.[0] };
      }
    }
    // 没配或配的渠道不在了：挑一个声明了 image 的（优先级数字小的先用）
    const candidates = providers
      .filter((x) => Array.isArray(x.capabilities)
        && x.capabilities.includes('image')
        && (x.apiKey || x.apiKeys?.length))
      .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));
    if (!candidates.length) return null;
    const p = candidates[0];
    return { provider: p, model: opt.model || p.defaultModel || p.models?.[0] };
  }

  async function describe(source, target) {
    const prompt = opt.detail === 'brief' ? BRIEF_PROMPT : DETAILED_PROMPT;
    const body = {
      model: target.model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: source } },
        ],
      }],
      max_tokens: Number(opt.maxDescTokens) || 900,
      temperature: 0.2,
    };

    const upstream = await callUpstream({
      provider: target.provider,
      model: target.model,
      body,
      timeoutMs: Number(opt.timeoutMs) || 60000,
      log,
    });
    const { res, clearTimer, detach } = upstream;
    try {
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${String(detail).slice(0, 120)}`);
      }
      const json = await res.json();
      const text = json?.choices?.[0]?.message?.content;
      return typeof text === 'string' && text.trim() ? text.trim() : null;
    } finally {
      clearTimer?.();
      detach?.();
    }
  }

  /**
   * 把 body.messages 里的 image part 替换成文字描述。
   * 失败/未启用时原样保留，调用方无需处理错误。
   * @returns {Promise<{replaced:number, total:number, note?:string}>}
   */
  async function materializeImages(body) {
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const jobs = [];
    for (let i = 0; i < messages.length; i += 1) {
      const content = messages[i]?.content;
      if (!Array.isArray(content)) continue;
      for (let j = 0; j < content.length; j += 1) {
        const source = extractImageSource(content[j]);
        if (source) jobs.push({ i, j, source });
      }
    }
    if (!jobs.length) return { replaced: 0, total: 0 };
    if (!enabled) return { replaced: 0, total: jobs.length, note: '未启用' };

    stats.requests += 1;
    stats.images += jobs.length;

    const target = pickVisionTarget();
    if (!target) return { replaced: 0, total: jobs.length, note: '没有可用的视觉渠道' };

    // 同一个请求里重复出现的图只转写一次
    const byHash = new Map();
    for (const job of jobs) {
      const key = hashSource(job.source);
      if (!byHash.has(key)) byHash.set(key, { source: job.source, targets: [] });
      byHash.get(key).targets.push(job);
    }

    let replaced = 0;
    let failed = 0;
    for (const [key, group] of byHash) {
      let desc = cache.get(key);
      if (desc) {
        stats.cached += 1;
      } else {
        try {
          desc = await describe(group.source, target);
          if (desc) {
            cache.set(key, desc);
            stats.described += 1;
          }
        } catch (err) {
          desc = null;
          failed += 1;
          stats.failed += 1;
          log(`   ⚠ 图片转写失败（保留原图）：${String(err?.message ?? err).slice(0, 160)}`);
        }
      }
      if (!desc) continue;
      const placeholder = { type: 'text', text: buildPlaceholder(desc) };
      for (const job of group.targets) {
        messages[job.i].content[job.j] = placeholder;
        replaced += 1;
      }
    }

    if (replaced < jobs.length) stats.degraded += 1;
    return { replaced, total: jobs.length, provider: target.provider.id, model: target.model };
  }

  return { materializeImages, stats, get cacheSize() { return cache.size; } };
}
