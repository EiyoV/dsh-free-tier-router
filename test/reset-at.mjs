/**
 * 测试「从上游错误消息里解析恢复时间」。
 *
 *   node dsh-plugin/test/reset-at.mjs
 */
import { parseResetAt } from '../lib/health.mjs';

let pass = 0;
let fail = 0;

function check(label, message, shouldParse) {
  const t = parseResetAt(message);
  const ok = shouldParse ? typeof t === 'number' && t > Date.now() - 60000 : t === null;
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${label}${t ? ' → ' + new Date(t).toLocaleString() : ''}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${label} → ${t === null ? 'null' : new Date(t).toLocaleString()}（期望${shouldParse ? '能解析' : '解析不出'}）`);
  }
}

console.log('恢复时间解析：\n');

check('火山（绝对时间 + 时区）', 'You have exceeded the 5-hour usage quota. It will reset at 2026-10-10 00:13:46 +0800 CST', true);
check('英文相对（秒）', 'Please try again in 1.5s', true);
check('英文相对（retry after）', 'Rate limit exceeded, retry after 30 seconds', true);
check('英文相对（分钟）', 'Too many requests, try again in 2 minutes', true);
check('中文相对（秒）', '请求过于频繁，请 30 秒后重试', true);
check('中文相对（分钟）', '配额已用尽，1 分钟后重试', true);
check('无时间信息', 'Invalid API key', false);
check('空字符串', '', false);
check('null', null, false);
check('模型不存在（不该误判）', 'The model does not exist or you do not have access to it.', false);

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exitCode = fail === 0 ? 0 : 1;
