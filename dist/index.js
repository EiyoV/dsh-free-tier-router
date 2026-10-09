/**
 * dsh-free-tier-router —— Host 侧（**自包含**：代理内核内嵌，不依赖外部项目）。
 *
 * 干四件事：
 *   1. 在 DSH 进程内启动 llm-router 代理（127.0.0.1:8787）
 *   2. 把它的 /healthz 转发到 DSH 自己的 web 服务（同源，免跨域）
 *   3. 暴露渠道目录（catalog + 哪些 key 还没填）
 *   4. 提供自带的面板页面 /llm-router
 *
 * 数据在 ~/.dsh/llm-router/（config.json / .env / catalog.json），跟着用户走，
 * 所以换台电脑解压安装、把这个目录带上就能用。
 *
 * 端口冲突处理：若 8787 已经有代理在跑（比如独立项目 start.cmd），就复用它，不重复启动。
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import net from 'node:net';

import {
  ensureDataDir,
  DATA_DIR,
  CONFIG_PATH,
  ENV_PATH,
  BUILTIN_DIR,
  resolveCatalogPath,
} from '../lib/paths.mjs';
import { loadConfig, isConfigured } from '../lib/config.mjs';
import { HealthRegistry } from '../lib/health.mjs';
import { startProxy } from '../lib/server.mjs';
import { fetchBalance, clearBalanceCache } from '../lib/balance.mjs';

const name = 'dsh-free-tier-router';
const inject = ['webServer'];

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

/** 只接受本机回环来源，挡掉跨站写操作。 */
function isLoopback(req) {
  const host = String(req.headers.host ?? '');
  return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1024 * 512) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (err) {
        reject(new Error(`JSON 解析失败：${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

/** 端口上是否已经有活的 llm-router。 */
async function probeExisting(port, timeoutMs = 800) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return false;
    const j = await r.json();
    return Array.isArray(j?.providers);
  } catch {
    return false;
  }
}

/** 端口是否被占用（不区分是谁）。 */
function isPortTaken(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', (err) => resolve(err.code === 'EADDRINUSE'));
    s.once('listening', () => s.close(() => resolve(false)));
    s.listen(port, '127.0.0.1');
  });
}

function runScript(args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      args,
      { cwd: BUILTIN_DIR, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const out = `${stdout ?? ''}${stderr ?? ''}`.trim();
        resolve({
          ok: !err,
          exitCode: err?.code ?? 0,
          output: out.length > 20000 ? `…（已截断）\n${out.slice(-20000)}` : out,
        });
      }
    );
  });
}

export async function apply(ctx, config = {}) {
  const log = (...a) => console.log(`[${name}]`, ...a);

  const { created } = ensureDataDir();
  if (created.length > 0) log('已初始化数据目录文件：', created.join(', '));

  // ── 内嵌代理的生命周期 ────────────────────────────────────────────
  const state = {
    proxy: null,
    health: null,
    providers: [],
    config: null,
    port: null,
    /** 'own' = 本插件启动的；'external' = 复用已存在的；'down' = 没起来 */
    mode: 'down',
    error: null,
  };

  // 每次从磁盘读，不缓存：panel.html 才十几 KB，换来"改完面板刷新页面即生效"，
  // 调 UI 时不用反复重启 DSH。注意它按 package.json 的 files 被 pnpm 复制进 node_modules，
  // 所以这里读的是安装副本 —— 修正本后必须先跑 install.mjs。
  const readPanel = () => readFileSync(join(BUILTIN_DIR, '..', 'dist', 'panel.html'), 'utf8');

  const readEnvKeys = () => {
    const out = {};
    if (!existsSync(ENV_PATH)) return out;
    for (const raw of readFileSync(ENV_PATH, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (m && m[2] !== '') out[m[1]] = m[2];
    }
    return out;
  };

  async function bootProxy() {
    state.error = null;
    let cfg;
    try {
      cfg = loadConfig();
    } catch (err) {
      state.mode = 'down';
      state.error = `读取配置失败：${err.message}`;
      log(state.error);
      return;
    }
    state.config = cfg;

    state.providers = cfg.providers.filter((p) => isConfigured(p).ok);
    const skipped = cfg.providers.filter((p) => !isConfigured(p).ok);
    if (skipped.length > 0) {
      log(`已跳过：${skipped.map((p) => `${p.id}(${isConfigured(p).why})`).join(', ')}`);
    }

    const port = config.port ?? cfg.server.port;

    // 已有别的 llm-router 在跑 → 复用
    if (await probeExisting(port)) {
      state.mode = 'external';
      state.port = port;
      log(`端口 ${port} 上已有 llm-router，复用它（本插件不再另起一个）`);
      return;
    }

    if (state.providers.length === 0) {
      state.mode = 'down';
      state.error = `没有任何渠道可用。把 key 填进 ${ENV_PATH} 后点面板上的「重新加载」。`;
      log(state.error);
      return;
    }

    if (await isPortTaken(port)) {
      state.mode = 'down';
      state.error = `端口 ${port} 被别的程序占用，且它不是 llm-router。请改 config.json 里的 server.port。`;
      log(state.error);
      return;
    }

    try {
      const health = new HealthRegistry(cfg.policy.cooldown);
      const proxy = await startProxy({
        config: cfg,
        providers: state.providers,
        health,
        log: (...a) => log('proxy', ...a),
        port,
      });
      state.proxy = proxy;
      state.health = health;
      state.port = proxy.port;
      state.mode = 'own';
      log(`内嵌代理已启动：http://127.0.0.1:${proxy.port}（${state.providers.length} 个渠道）`);
    } catch (err) {
      state.mode = 'down';
      state.error = `启动代理失败：${err?.message ?? err}`;
      log(state.error);
    }
  }

  await bootProxy();

  // ── 路由 1：池状态 ────────────────────────────────────────────────
  ctx.webServer.register({
    kind: 'exact',
    path: '/api/llm-router/status',
    handler: async (_req, res) => {
      if (state.mode === 'down') {
        return sendJson(res, 200, {
          ok: false,
          mode: 'down',
          error: state.error,
          dataDir: DATA_DIR,
          envPath: ENV_PATH,
          providers: [],
        });
      }
      try {
        const r = await fetch(`http://127.0.0.1:${state.port}/healthz`, {
          signal: AbortSignal.timeout(6000),
        });
        const j = await r.json();
        sendJson(res, 200, { ...j, mode: state.mode, dataDir: DATA_DIR, envPath: ENV_PATH });
      } catch (err) {
        sendJson(res, 200, {
          ok: false,
          mode: state.mode,
          error: `连不上代理（端口 ${state.port}）：${err?.message ?? err}`,
          dataDir: DATA_DIR,
          envPath: ENV_PATH,
          providers: [],
        });
      }
    },
  });

  // ── 路由 2：渠道目录 ──────────────────────────────────────────────
  ctx.webServer.register({
    kind: 'exact',
    path: '/api/llm-router/catalog',
    handler: async (_req, res) => {
      const catalogPath = resolveCatalogPath();
      if (!existsSync(catalogPath)) {
        return sendJson(res, 404, { error: `找不到渠道目录 ${catalogPath}` });
      }
      try {
        const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
        const env = readEnvKeys();

        let cfgProviders = [];
        try {
          cfgProviders = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')).providers ?? [];
        } catch {
          /* config 读不到就给空列表 */
        }

        const envNamesOf = (p) =>
          Array.isArray(p.apiKeyEnvs) ? p.apiKeyEnvs : p.apiKeyEnv ? [p.apiKeyEnv] : [];

        // 一个平台一张卡：把 catalog.json 的渠道信息与 config.json 的 provider 按 baseURL 关联。
        // 关联上的（已入池）显示 key 管理，关联不上的显示注册引导。
        const channels = (catalog.channels ?? []).map((ch) => {
          const matched = ch.baseURL ? cfgProviders.filter((p) => p.baseURL === ch.baseURL) : [];
          const providerIds = matched.map((p) => p.id);

          // key 槽位按名字去重：zhipu-text 和 zhipu-vision 共用同一把 ZHIPU_API_KEY，
          // 不去重就会在界面上重复显示。
          const keyMap = new Map();
          for (const p of matched) {
            for (const n of envNamesOf(p)) {
              if (!keyMap.has(n)) {
                keyMap.set(n, {
                  name: n,
                  filled: Boolean(env[n]),
                  length: env[n]?.length ?? 0,
                  providerIds: [],
                  addTo: p.id, // 新建槽位时挂到哪个 provider
                });
              }
              keyMap.get(n).providerIds.push(p.id);
            }
          }

          return {
            id: ch.id,
            label: ch.label,
            deprecated: Boolean(ch.deprecated),
            registerUrl: ch.registerUrl ?? null,
            materials: ch.materials ?? null,
            verified: ch.verified ?? null,
            capabilitiesHint: ch.capabilitiesHint ?? null,
            caveats: ch.caveats ?? [],
            priorityHint: ch.priorityHint ?? 999,
            /** config.json 里有没有对应 provider */
            inPool: matched.length > 0,
            enabled: matched.some((p) => p.enabled !== false),
            manualOnly: matched.length > 0 && matched.every((p) => p.manualOnly),
            providerIds,
            priorities: matched.map((p) => p.priority),
            keys: [...keyMap.values()],
          };
        });

        // 顺便查余额。**只有提供公开接口的平台查得到**（实测目前只有 OpenRouter），
        // 查不到就留空 —— 面板会显示"该平台不提供查询接口"，而不是编一个数字。
        // 5 分钟缓存，避免每次刷新页面都打网络。
        const balanceByProvider = new Map();
        await Promise.all(
          cfgProviders.map(async (p) => {
            const names = envNamesOf(p);
            const key = names.map((n) => env[n]).find(Boolean);
            if (!key) return;
            const b = await fetchBalance({ id: p.id, baseURL: p.baseURL, apiKey: key });
            if (b) balanceByProvider.set(p.id, b);
          })
        );

        for (const ch of channels) {
          ch.balances = (ch.providerIds ?? [])
            .map((id) =>
              balanceByProvider.has(id) ? { providerId: id, ...balanceByProvider.get(id) } : null
            )
            .filter(Boolean);
        }

        sendJson(res, 200, {
          updated: catalog.updated,
          catalogPath,
          envPath: ENV_PATH,
          configPath: CONFIG_PATH,
          channels,
        });
      } catch (err) {
        sendJson(res, 500, { error: String(err?.message ?? err) });
      }
    },
  });

  // ── 路由 2.5：账号槽位增删（一个渠道可以配多把 key）─────────────────
  ctx.webServer.register({
    kind: 'exact',
    path: '/api/llm-router/account',
    handler: async (req, res) => {
      if (!isLoopback(req)) return sendJson(res, 403, { ok: false, error: '已拒绝非本机来源' });
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err.message });
      }

      const action = String(body.action ?? '');
      const providerId = String(body.providerId ?? '');
      const name = String(body.name ?? '');
      const value = String(body.value ?? '').trim();

      try {
        const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
        const provider = (raw.providers ?? []).find((p) => p.id === providerId);
        if (!provider) return sendJson(res, 404, { ok: false, error: `找不到渠道 ${providerId}` });

        const names = Array.isArray(provider.apiKeyEnvs)
          ? provider.apiKeyEnvs
          : provider.apiKeyEnv
            ? [provider.apiKeyEnv]
            : [];

        if (action === 'add') {
          if (!value) return sendJson(res, 400, { ok: false, error: '缺少 key 值' });
          if (names.length === 0) return sendJson(res, 400, { ok: false, error: '该渠道不需要 key' });

          const base = names[0].replace(/_\d+$/, '');
          let i = 2;
          while (names.includes(`${base}_${i}`)) i += 1;
          const newName = `${base}_${i}`;

          const envLines = readFileSync(ENV_PATH, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
          let replaced = false;
          const nextEnv = envLines.map((line) => {
            const m = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
            if (m && m[2] === newName) {
              replaced = true;
              return `${newName}=${value}`;
            }
            return line;
          });
          if (!replaced) nextEnv.push(`${newName}=${value}`);
          writeFileSync(ENV_PATH, nextEnv.join('\n'), 'utf8'); // 无 BOM

          copyFileSync(CONFIG_PATH, `${CONFIG_PATH}.bak-${Date.now()}`);
          provider.apiKeyEnvs = [...names, newName];
          delete provider.apiKeyEnv;
          writeFileSync(CONFIG_PATH, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');

          log(`${providerId} 增加账号槽位 ${newName}（长度 ${value.length}）`);
          return sendJson(res, 200, {
            ok: true,
            action,
            name: newName,
            note: '点「重新加载配置」生效。同账号多 key 共享额度，只有不同账号才是独立额度。',
          });
        }

        if (action === 'remove') {
          if (names.length <= 1) {
            return sendJson(res, 400, {
              ok: false,
              error: '只剩一把了，删掉这个渠道就没有 key 了。要停用请去 config.json 把它的 enabled 改成 false',
            });
          }
          if (!names.includes(name)) {
            return sendJson(res, 404, { ok: false, error: `${providerId} 里没有 ${name}` });
          }

          copyFileSync(CONFIG_PATH, `${CONFIG_PATH}.bak-${Date.now()}`);
          const left = names.filter((n) => n !== name);
          provider.apiKeyEnvs = left;
          delete provider.apiKeyEnv;
          writeFileSync(CONFIG_PATH, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');

          // 只清空那一行的值，保留行本身，免得别处引用断掉
          const envLines = readFileSync(ENV_PATH, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
          const nextEnv = envLines.map((line) => {
            const m = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
            if (m && m[2] === name) return `${name}=`;
            return line;
          });
          writeFileSync(ENV_PATH, nextEnv.join('\n'), 'utf8');

          log(`${providerId} 移除账号槽位 ${name}`);
          return sendJson(res, 200, { ok: true, action, removed: name, left, note: '点「重新加载配置」生效' });
        }

        return sendJson(res, 400, {
          ok: false,
          error: `未知动作 "${action}"`,
          allowed: ['add', 'remove'],
        });
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String(err?.message ?? err) });
      }
    },
  });

  // ── 路由 3：动作 ──────────────────────────────────────────────────
  ctx.webServer.register({
    kind: 'exact',
    path: '/api/llm-router/action',
    handler: async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const action = url.searchParams.get('do');

      try {
        if (action === 'clear-all') {
          if (state.mode === 'down') return sendJson(res, 200, { ok: false, output: state.error });
          const r = await fetch(`http://127.0.0.1:${state.port}/admin/clear`, {
            signal: AbortSignal.timeout(6000),
          });
          return sendJson(res, 200, { ok: r.ok, output: (await r.text()).slice(0, 2000) });
        }

        if (action === 'reload') {
          if (state.proxy) {
            await state.proxy.close().catch(() => {});
            state.proxy = null;
          }
          await bootProxy();
          return sendJson(res, 200, {
            ok: state.mode !== 'down',
            output:
              state.mode === 'down'
                ? `${state.error}\n数据目录：${DATA_DIR}`
                : `已重新加载。模式：${state.mode}，端口：${state.port}，渠道：${state.providers.length} 个`,
          });
        }

        if (action === 'probe') {
          const args = [join(BUILTIN_DIR, 'probe.mjs')];
          if (url.searchParams.get('vision') === '1') args.push('--vision');
          // 让探测结果回报给代理，否则面板上会一直显示「未测试」——
          // probe 是独立进程直连上游，不经过代理的 health。
          if (state.mode !== 'down' && state.port) {
            args.push(`--report-to=http://127.0.0.1:${state.port}`);
          }
          // 探测完顺手按实测 token 开销重排优先级（越省越靠前）
          args.push('--tune');
          const r = await runScript(args, 300000);
          return sendJson(res, 200, r);
        }

        if (action === 'discover') {
          const r = await runScript([join(BUILTIN_DIR, 'discover.mjs'), '--openrouter'], 120000);
          return sendJson(res, 200, r);
        }

        if (action === 'discover-apply') {
          const r = await runScript(
            [join(BUILTIN_DIR, 'discover.mjs'), '--openrouter', '--update'],
            120000
          );
          return sendJson(res, 200, r);
        }

        return sendJson(res, 400, {
          error: `未知动作 "${action}"`,
          allowed: ['clear-all', 'reload', 'probe', 'discover', 'discover-apply'],
        });
      } catch (err) {
        sendJson(res, 500, { error: String(err?.message ?? err) });
      }
    },
  });

  // ── 路由 4：在面板里直接填 key ────────────────────────────────────
  ctx.webServer.register({
    kind: 'exact',
    path: '/api/llm-router/save-key',
    handler: async (req, res) => {
      if (!isLoopback(req)) return sendJson(res, 403, { ok: false, error: '已拒绝非本机来源' });
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err.message });
      }
      const keyName = String(body.name ?? '');
      const value = String(body.value ?? '').trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyName)) {
        return sendJson(res, 400, { ok: false, error: '变量名不合法' });
      }
      if (!existsSync(ENV_PATH)) return sendJson(res, 400, { ok: false, error: `找不到 ${ENV_PATH}` });

      try {
        const lines = readFileSync(ENV_PATH, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
        let replaced = false;
        const next = lines.map((line) => {
          const m = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
          if (m && m[2] === keyName) {
            replaced = true;
            return `${keyName}=${value}`;
          }
          return line;
        });
        if (!replaced) next.push(`${keyName}=${value}`);
        writeFileSync(ENV_PATH, next.join('\n'), 'utf8'); // 无 BOM

        log(`已更新 ${keyName}（长度 ${value.length}）`);
        return sendJson(res, 200, { ok: true, name: keyName, replaced, note: '点「重新加载」让它生效' });
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: String(err?.message ?? err) });
      }
    },
  });

  // ── 路由 5：面板 ──────────────────────────────────────────────────
  ctx.webServer.register({
    kind: 'exact',
    path: '/llm-router',
    handler: (_req, res) => {
      try {
        sendText(res, 200, readPanel(), 'text/html; charset=utf-8');
      } catch (err) {
        sendText(res, 500, `读取 panel.html 失败：${err?.message ?? err}`);
      }
    },
  });

  // 插件卸载时收掉自己起的代理
  ctx.effect(() => () => {
    state.proxy?.close().catch(() => {});
  }, `${name}: proxy lifecycle`);

  log(
    `ready — 面板 /llm-router · 模式 ${state.mode} · 数据目录 ${DATA_DIR}` +
      (state.error ? ` · ${state.error}` : '')
  );
}

export { name, inject };
