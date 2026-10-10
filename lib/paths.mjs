/**
 * 统一的路径解析：插件自带内核，但**数据跟着用户走**，不跟着安装目录走。
 *
 *   ~/.dsh/llm-router/config.json   渠道配置（首次自动生成）
 *   ~/.dsh/llm-router/.env          各渠道密钥（首次自动生成模板）
 *   ~/.dsh/llm-router/catalog.json  渠道目录（首次从插件内置复制，可自行修改）
 *   ~/.dsh/llm-router/usage.json    各渠道累计用量（额度熔断用，跨重启保留）
 *   ~/.dsh/llm-router/logs/         日志
 *
 * 这样换台电脑、重新解压安装，只要把这个目录带上（或重新填一次 key）就能用。
 */
import { existsSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 插件内置的只读资源目录（lib/）。 */
export const BUILTIN_DIR = HERE;
/** 内置默认配置模板。 */
export const DEFAULT_CONFIG_PATH = join(HERE, 'default-config.json');
/** 内置渠道目录（作为数据目录缺失时的回退）。 */
export const BUILTIN_CATALOG_PATH = join(HERE, 'catalog.json');

export const DATA_DIR = process.env.LLM_ROUTER_DATA ?? join(homedir(), '.dsh', 'llm-router');
export const CONFIG_PATH = join(DATA_DIR, 'config.json');
export const ENV_PATH = join(DATA_DIR, '.env');
export const CATALOG_PATH = join(DATA_DIR, 'catalog.json');
export const USAGE_PATH = join(DATA_DIR, 'usage.json');
export const LOG_DIR = join(DATA_DIR, 'logs');

const ENV_TEMPLATE = `# llm-router 渠道密钥。一个渠道一把 key；没填的渠道会被自动跳过。
# 改完保存即可，下一次请求生效（不需要重启 DSH）。
# 先用面板上的「探测渠道」核实哪些真能用。

# ── 国内直连（推荐，不需要海外网络）─────────────────────
ZHIPU_API_KEY=
DASHSCOPE_API_KEY=
SILICONFLOW_API_KEY=
QIANFAN_API_KEY=
TENCENT_TOKENHUB_API_KEY=
# 魔搭 ModelScope（阿里）：注册 https://www.modelscope.cn/ → 个人中心「访问令牌」生成 SDK Token
MODELSCOPE_API_KEY=

# ── 火山方舟（ep- 接入点 ID 要自己在控制台创建；只挑带「协作奖励计划」标签的才有免费额度）
ARK_API_KEY=

# ── 需要海外网络（本机实测多数不可达）───────────────────
GEMINI_API_KEY=
GROQ_API_KEY=
OPENROUTER_API_KEY=

# ── 本地 Ollama（默认关闭；要用就把 config.json 里 local-ollama 的 enabled 改成 true）
OLLAMA_BASE_URL=http://127.0.0.1:11434/v1

# ── 搜索（Tavily）：给 DSH 原生的 web_search 用，**不是一个 LLM 渠道**。
# 注册 https://app.tavily.com 免费档有 1000 credits/月（basic 搜索 1 credit/次）。
# 留空也可以：插件会回退读 ~/.dsh/tavily-key.txt。
TAVILY_API_KEY=
`;

/**
 * 确保数据目录存在，并在缺失时用内置模板初始化。
 * 只补缺，绝不覆盖用户已改过的文件。
 * @returns {{created: string[]}}
 */
export function ensureDataDir() {
  const created = [];

  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
    created.push(DATA_DIR);
  }
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }
  if (!existsSync(CONFIG_PATH) && existsSync(DEFAULT_CONFIG_PATH)) {
    copyFileSync(DEFAULT_CONFIG_PATH, CONFIG_PATH);
    created.push(CONFIG_PATH);
  }
  if (!existsSync(ENV_PATH)) {
    writeFileSync(ENV_PATH, ENV_TEMPLATE, 'utf8');
    created.push(ENV_PATH);
  }
  if (!existsSync(CATALOG_PATH) && existsSync(BUILTIN_CATALOG_PATH)) {
    copyFileSync(BUILTIN_CATALOG_PATH, CATALOG_PATH);
    created.push(CATALOG_PATH);
  }

  return { created };
}

/** 读渠道目录：优先数据目录里用户可改的那份，回退到插件内置。 */
export function resolveCatalogPath() {
  return existsSync(CATALOG_PATH) ? CATALOG_PATH : BUILTIN_CATALOG_PATH;
}
