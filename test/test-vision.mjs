/**
 * vision.mjs 的单元测试：不发真实上游请求，全部 mock。
 * 验证：提取/替换/缓存/失败回退/未启用/多格式兼容。
 *
 *   node test/test-vision.mjs
 */
import { createVisionPreprocessor, extractImageSource } from '../lib/vision.mjs';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let pass = 0;
let fail = 0;
function check(name, ok, extra = '') {
  if (ok) { pass += 1; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail += 1; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

const providers = [{ id: 'p1', capabilities: ['image'], defaultModel: 'm1', apiKey: 'k' }];

// ── case 1: 正常替换 ────────────────────────────────────────────────
let calls = 0;
let lastBody = null;
const okUpstream = async ({ body }) => {
  calls += 1;
  lastBody = body;
  return {
    res: { ok: true, json: async () => ({ choices: [{ message: { content: '一张纯粉色图片。可见文字：无。' } }] }) },
    clearTimer: () => {},
    detach: () => {},
  };
};
const v1 = createVisionPreprocessor({
  config: { visionPreprocess: { enabled: true, provider: 'p1', model: 'm1', cacheSize: 10 } },
  providers,
  log: () => {},
  callUpstream: okUpstream,
});

const body1 = {
  messages: [
    { role: 'system', content: 'sys' },
    { role: 'user', content: [{ type: 'text', text: '这图里写了啥' }, { type: 'image_url', image_url: { url: PNG } }] },
  ],
};
const r1 = await v1.materializeImages(body1);
check('正常替换 replaced=1', r1.replaced === 1, `got ${r1.replaced}`);
check('image part 已变成 text', body1.messages[1].content[1].type === 'text');
check('占位文本含转写内容', String(body1.messages[1].content[1].text).includes('一张纯粉色图片'));
check('占位文本含防重复取图提示', String(body1.messages[1].content[1].text).includes('不要重复调用取图工具'));
check('文本 part 未被误伤', body1.messages[1].content[0].text === '这图里写了啥');
check('system 消息未被动', body1.messages[0].content === 'sys');
check('上游只调了 1 次', calls === 1, `calls=${calls}`);
check('转写请求带上了图', JSON.stringify(lastBody).includes('image_url'));
check('转写请求默认走详描述', String(lastBody?.messages?.[0]?.content?.[0]?.text).includes('逐字转写'));

// ── case 2: 缓存命中 ────────────────────────────────────────────────
const body2 = { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: PNG } }] }] };
const r2 = await v2call();
async function v2call() { return v1.materializeImages(body2); }
check('同一张图第二次仍替换', r2.replaced === 1);
check('同一张图第二次不调上游（缓存命中）', calls === 1, `calls=${calls}`);

// ── case 3: 上游失败 → 保留原图 ──────────────────────────────────────
let failCalls = 0;
const badUpstream = async () => { failCalls += 1; throw new Error('上游炸了'); };
const v3 = createVisionPreprocessor({
  config: { visionPreprocess: { enabled: true, provider: 'p1', model: 'm1' } },
  providers, log: () => {}, callUpstream: badUpstream,
});
const body3 = { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: PNG } }] }] };
const r3 = await v3.materializeImages(body3);
check('失败时 replaced=0', r3.replaced === 0);
check('失败时原图保留（仍是 image_url）', body3.messages[0].content[0].type === 'image_url');
check('失败不会抛异常（已兜底）', true);

// ── case 4: enabled=false 不动作 ────────────────────────────────────
const v4 = createVisionPreprocessor({
  config: { visionPreprocess: { enabled: false } }, providers, log: () => {}, callUpstream: okUpstream,
});
const body4 = { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: PNG } }] }] };
const r4 = await v4.materializeImages(body4);
check('未启用时 replaced=0', r4.replaced === 0);
check('未启用时原图保留', body4.messages[0].content[0].type === 'image_url');

// ── case 5: 没有可用的视觉渠道 → 保留原图 ────────────────────────────
const v5 = createVisionPreprocessor({
  config: { visionPreprocess: { enabled: true } }, providers: [], log: () => {}, callUpstream: okUpstream,
});
const body5 = { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: PNG } }] }] };
const r5 = await v5.materializeImages(body5);
check('无渠道时 replaced=0 且有 note', r5.replaced === 0 && Boolean(r5.note), r5.note ?? '');
check('无渠道时原图保留', body5.messages[0].content[0].type === 'image_url');

// ── case 6: 多种 part 格式 ─────────────────────────────────────────
check('image_url 字符串形式', extractImageSource({ type: 'image_url', image_url: 'http://x/1.png' }) === 'http://x/1.png');
check('Anthropic mediaType+data', String(extractImageSource({ type: 'image', mediaType: 'image/jpeg', data: 'AAA' })).startsWith('data:image/jpeg;base64,AAA'));
check('source.media_type 形式', String(extractImageSource({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'BBB' } })).startsWith('data:image/png;base64,BBB'));
check('input_image 形式', extractImageSource({ type: 'input_image', image_url: { url: 'http://x/2.png' } }) === 'http://x/2.png');
check('文本 part 返回 null', extractImageSource({ type: 'text', text: 'x' }) === null);
check('null part 返回 null', extractImageSource(null) === null);

// ── case 7: 一个请求里同一张图出现两次，只转写一次 ────────────────────
let dupCalls = 0;
const dupUpstream = async () => {
  dupCalls += 1;
  return { res: { ok: true, json: async () => ({ choices: [{ message: { content: 'dup' } }] }) }, clearTimer: () => {}, detach: () => {} };
};
const v7 = createVisionPreprocessor({
  config: { visionPreprocess: { enabled: true, provider: 'p1', model: 'm1' } }, providers, log: () => {}, callUpstream: dupUpstream,
});
const body7 = { messages: [{ role: 'user', content: [
  { type: 'image_url', image_url: { url: PNG } },
  { type: 'text', text: '再看一眼' },
  { type: 'image_url', image_url: { url: PNG } },
] }] };
const r7 = await v7.materializeImages(body7);
check('重复图全部替换 replaced=2', r7.replaced === 2, `got ${r7.replaced}`);
check('重复图只调上游 1 次', dupCalls === 1, `calls=${dupCalls}`);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
