/**
 * 验证「探测结果能回报到代理状态」这条链路。
 *
 *   node dsh-plugin/test/probe-report.mjs
 *
 * 起一个临时代理（独立端口），直接 POST /admin/report，确认 health 统计真的变了。
 * 不需要 key、不消耗额度 —— 报的是假结果，只验通道。
 */
import { loadConfig, isConfigured } from '../lib/config.mjs';
import { HealthRegistry } from '../lib/health.mjs';
import { startProxy } from '../lib/server.mjs';

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${extra ? `  — ${extra}` : ''}`);
  }
};

const cfg = loadConfig();
const providers = cfg.providers.filter((p) => isConfigured(p).ok);
const port = 18992;

const health = new HealthRegistry(cfg.policy.cooldown);
const proxy = await startProxy({ config: cfg, providers, health, log: () => {}, port });
console.log(`临时代理 @ ${port}，渠道 ${providers.length} 个`);

const before = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
const id = providers[0]?.id;
console.log('目标渠道:', id);
check('初始时没有请求记录', (before.providers.find((p) => p.id === id)?.requests ?? 0) === 0);

console.log('\n[1] 上报一条成功');
const r1 = await fetch(`http://127.0.0.1:${port}/admin/report`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ results: [{ providerId: id, ok: true, message: null }] }),
});
const j1 = await r1.json();
check('端点返回 ok', r1.status === 200 && j1.ok === true, JSON.stringify(j1));
check('应用条数正确', j1.applied === 1, String(j1.applied));

const after1 = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
const row1 = after1.providers.find((p) => p.id === id);
check('请求数 +1', row1.requests === 1, `requests=${row1.requests}`);
check('成功数 +1', row1.ok === 1, `ok=${row1.ok}`);
check('没有触发冷却（探测不该影响调度）', row1.available === true, `available=${row1.available}`);

console.log('\n[2] 上报一条失败');
await fetch(`http://127.0.0.1:${port}/admin/report`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ results: [{ providerId: id, ok: false, message: '模拟的探测失败' }] }),
});
const after2 = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
const row2 = after2.providers.find((p) => p.id === id);
check('失败数 +1', row2.failures === 1, `failures=${row2.failures}`);
check('最近错误被记下', String(row2.lastError ?? '').includes('模拟的探测失败'), row2.lastError);
check('失败也没有触发冷却', row2.available === true, `available=${row2.available}`);

console.log('\n[3] 非法输入不该崩');
const bad = await fetch(`http://127.0.0.1:${port}/admin/report`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: 'not json',
});
check('坏 JSON 返回 4xx 而不是抛异常', bad.status >= 400 && bad.status < 500, `status=${bad.status}`);

const empty = await fetch(`http://127.0.0.1:${port}/admin/report`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({}),
});
check('空 body 安全处理', empty.status === 200, `status=${empty.status}`);

const health_after = await (await fetch(`http://127.0.0.1:${port}/healthz`)).ok;
check('代理仍然活着', health_after === true);

await proxy.close();

console.log(`\n${'─'.repeat(46)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exitCode = fail === 0 ? 0 : 1;
