/**
 * 独立运行入口：不用 DSH 也能把代理跑起来（等价于原来项目里的 src/index.mjs）。
 *
 *   node dsh-plugin/lib/cli.mjs
 *
 * 读的是同一份用户数据目录（~/.dsh/llm-router），所以和插件模式共享配置。
 * 端口被占用时不会自动复用（那是插件的逻辑），它只负责老实启动。
 */
import { ensureDataDir, DATA_DIR, ENV_PATH } from './paths.mjs';
import { loadConfig, isConfigured } from './config.mjs';
import { HealthRegistry } from './health.mjs';
import { startProxy } from './server.mjs';

const { created } = ensureDataDir();
if (created.length > 0) console.log('已初始化数据目录文件：', created.join(', '));

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(`读取配置失败：${err.message}`);
  console.error(`数据目录：${DATA_DIR}`);
  process.exit(1);
}

const providers = config.providers.filter((p) => isConfigured(p).ok);
const skipped = config.providers.filter((p) => !isConfigured(p).ok);

if (providers.length === 0) {
  console.error('没有任何可用渠道。把 key 填进：' + ENV_PATH);
  process.exit(1);
}

const health = new HealthRegistry(config.policy.cooldown);
const proxy = await startProxy({
  config,
  providers,
  health,
  log: (...a) => console.log(...a),
});

console.log(`llm-router 监听 http://127.0.0.1:${proxy.port}`);
console.log(`已启用 ${providers.length} 个渠道：${providers.map((p) => `${p.id}#${p.priority}`).join(', ')}`);
if (skipped.length > 0) {
  console.log(`已跳过：${skipped.map((p) => `${p.id}(${isConfigured(p).why})`).join(', ')}`);
}

const shutdown = () => {
  console.log('收到退出信号，关闭中…');
  proxy.close().then(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
