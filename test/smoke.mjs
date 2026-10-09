/**
 * 自包含冒烟测试：不依赖外部项目、不需要 key，验证插件内核能独立跑起来。
 *
 *   node dsh-plugin/test/smoke.mjs
 *
 * 会真的在 ~/.dsh/llm-router/ 初始化数据目录（这正是安装后的效果）。
 */
import { ensureDataDir, DATA_DIR, CONFIG_PATH, ENV_PATH, resolveCatalogPath } from '../lib/paths.mjs';
import { loadConfig, isConfigured } from '../lib/config.mjs';
import { HealthRegistry } from '../lib/health.mjs';
import { startProxy } from '../lib/server.mjs';
import { existsSync } from 'node:fs';

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

console.log('数据目录:', DATA_DIR);
const { created } = ensureDataDir();
console.log('新建文件:', created.length ? created.join(', ') : '(无，已存在)');

console.log('\n[1] 数据目录初始化');
check('config.json 存在', existsSync(CONFIG_PATH), CONFIG_PATH);
check('.env 存在', existsSync(ENV_PATH));
check('catalog.json 可解析', existsSync(resolveCatalogPath()), resolveCatalogPath());

console.log('\n[2] 配置加载');
const cfg = loadConfig();
check('配置能加载', Array.isArray(cfg.providers) && cfg.providers.length > 0, `${cfg.providers?.length} 个渠道`);
check('policy 完整', Boolean(cfg.policy?.cooldown?.rateLimitMs));
const providers = cfg.providers.filter((p) => isConfigured(p).ok);
console.log(`  已配置可用的渠道：${providers.length} 个 ${providers.map((p) => p.id).join(', ') || '(还没填 key)'}`);

console.log('\n[3] 内嵌代理启动（端口 18787）');
const port = 18787;
const health = new HealthRegistry(cfg.policy.cooldown);
const proxy = await startProxy({
  config: cfg,
  providers,
  health,
  log: (...a) => console.log('   [proxy]', ...a),
  port,
});
check('代理已监听', proxy.port === port, String(proxy.port));

console.log('\n[4] 端点');
const h = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
check('/healthz 返回结构正确', typeof h.ok === 'boolean' && Array.isArray(h.providers), JSON.stringify(h).slice(0, 120));

const m = await (await fetch(`http://127.0.0.1:${port}/v1/models`)).json();
check('/v1/models 可用', m.object === 'list', JSON.stringify(m).slice(0, 120));

const chat = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }),
});
const chatBody = (await chat.text()).slice(0, 200);
// 注意：有 key 时这个请求会真的打出去（成功 200 / 限流 429 / 全败 502），
// 没 key 时是 503。断言只要求"给出明确结果、不挂住"，别假设环境是空的。
check(
  '请求得到明确结果（成功或明确错误），不会挂住',
  chat.status === 200 || chat.status === 502 || chat.status === 503,
  `status=${chat.status} body=${chatBody}`
);

const clear = await (await fetch(`http://127.0.0.1:${port}/admin/clear`)).json();
check('/admin/clear 可用', clear.cleared === 'all', JSON.stringify(clear).slice(0, 100));

await proxy.close();
check('代理能正常关闭', true);

console.log(`\n${'─'.repeat(46)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
console.log('\n下一步：把 key 填进 ' + ENV_PATH);
// 不用 process.exit：句柄没收干净就强退，会在 Windows 上触发 libuv 断言
process.exitCode = fail === 0 ? 0 : 1;
