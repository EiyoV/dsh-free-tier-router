/**
 * 把 dsh-llm-router-panel 装进 DSH profile（幂等，可反复跑）。
 *
 *   node install.mjs                    安装 / 更新到 desktop profile
 *   node install.mjs --profile headless 指定 profile
 *   node install.mjs --remove           卸载
 *
 * 做三件事：
 *   1. 备份 profile 的 package.json
 *   2. dependencies 加 `file:` 指向本目录，包名加进 dsh.profile.bundles
 *   3. 用 DSH 自带的 pnpm 跑 install
 *
 * 用 Node 而不是 PowerShell 改 JSON：这台机器的 pwsh 实际是 Windows PowerShell 5.1，
 * 写无 BOM 的 UTF-8 会出问题，改 profile 的 package.json 绝不能走 Set-Content。
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = 'dsh-llm-router-panel';

const argv = process.argv.slice(2);
const remove = argv.includes('--remove');
const profileArg = (() => {
  const i = argv.indexOf('--profile');
  return i >= 0 && argv[i + 1] ? argv[i + 1] : 'desktop';
})();

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const PROFILE_DIR = join(DSH_HOME, 'profiles', profileArg);
const PKG = join(PROFILE_DIR, 'package.json');

/**
 * 找到 DSH 安装根目录（换台电脑路径不同，不能硬编码）。
 * 依次尝试：环境变量 → 从当前 node 可执行文件向上找 → 常见安装位置。
 */
function findDshRoot() {
  const looksRight = (p) =>
    existsSync(join(p, 'resources', 'runtime', 'pnpm', 'bin', 'pnpm.mjs'));

  if (process.env.DSH_ROOT && looksRight(process.env.DSH_ROOT)) return process.env.DSH_ROOT;

  // 从当前 node 可执行文件逐级向上找（用 DSH 自带 node 跑的时候命中）
  let dir = dirname(process.execPath);
  for (let i = 0; i < 8; i += 1) {
    if (looksRight(dir)) return dir;
    const up = resolve(dir, '..');
    if (up === dir) break;
    dir = up;
  }

  const common = [
    join(homedir(), 'AppData', 'Local', 'Programs', 'DeepSeek Harness'),
    'C:\\Program Files\\DeepSeek Harness',
    '/Applications/DeepSeek Harness.app/Contents/Resources',
    join(homedir(), 'Applications', 'DeepSeek Harness.app', 'Contents', 'Resources'),
  ];
  for (const c of common) if (looksRight(c)) return c;
  return null;
}

if (!existsSync(PKG)) {
  console.error(`找不到 ${PKG}`);
  console.error('用 --profile <名字> 指定 profile（默认 desktop）。');
  process.exit(1);
}

for (const f of ['package.json', 'cordis.patch.yml', 'dist/index.js', 'dist/client.js', 'dist/panel.html', 'lib/server.mjs', 'lib/paths.mjs']) {
  if (!existsSync(join(HERE, f))) {
    console.error(`插件正本缺少 ${f}`);
    process.exit(1);
  }
}

const backup = `${PKG}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
copyFileSync(PKG, backup);
console.log('已备份 ->', backup);

const manifest = JSON.parse(readFileSync(PKG, 'utf8'));
manifest.dependencies ??= {};
manifest.dsh ??= {};
manifest.dsh.profile ??= {};
manifest.dsh.profile.bundles ??= [];

if (remove) {
  delete manifest.dependencies[PLUGIN];
  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((b) => b !== PLUGIN);
  console.log('已从清单移除', PLUGIN);
} else {
  const spec = `file:${HERE.replace(/\\/g, '/')}`;
  manifest.dependencies[PLUGIN] = spec;
  if (!manifest.dsh.profile.bundles.includes(PLUGIN)) {
    manifest.dsh.profile.bundles.push(PLUGIN);
  }
  console.log('dependencies ←', spec);
  console.log('dsh.profile.bundles ←', PLUGIN);
}

writeFileSync(PKG, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8'); // 无 BOM
console.log('已写入', PKG);

const root = findDshRoot();

// file: 依赖会被 pnpm 按 package.json 的 files 字段打包复制到 node_modules。
// 旧副本残留会让 pnpm 认为"无事可做"（实测输出 Packages: -10 / added 0），
// 结果新增的 lib/ 不会同步过去，插件重启后找不到内核直接加载失败。
// 所以先清掉目标副本再装。
if (!remove) {
  const installedDir = join(PROFILE_DIR, 'node_modules', PLUGIN);
  if (existsSync(installedDir)) {
    rmSync(installedDir, { recursive: true, force: true });
    console.log('已清理旧副本 ->', installedDir);
  }

  // 早期用"手动复制 + insert"装过一次会留在这个 fallback 目录里，属于残留，一并清掉
  const legacyDir = join(DSH_HOME, 'profiles', 'node_modules', PLUGIN);
  if (existsSync(legacyDir)) {
    rmSync(legacyDir, { recursive: true, force: true });
    console.log('已清理早期手动安装的残留 ->', legacyDir);
  }
}

if (!root) {
  console.log('\n⚠️ 没找到 DSH 安装目录（找不到 resources/runtime/pnpm/bin/pnpm.mjs）。');
  console.log('   请手动到 profile 目录跑一次 pnpm install，或者设 DSH_ROOT 后再跑一次。');
  process.exit(0);
}

const exe = join(root, 'DeepSeek Harness.exe');
const exeUnix = join(root, 'Contents', 'MacOS', 'DeepSeek Harness');
const pnpm = join(root, 'resources', 'runtime', 'pnpm', 'bin', 'pnpm.mjs');
const launcher = existsSync(exe) ? exe : existsSync(exeUnix) ? exeUnix : null;

console.log(`\nDSH 安装目录：${root}`);
if (!launcher) {
  console.log('⚠️ 没找到启动器可执行文件，请手动跑：');
  console.log(`   "${process.execPath}" "${pnpm}" install`);
  process.exit(0);
}

console.log('运行 pnpm install …');
try {
  const out = execFileSync(launcher, ['--expose-internals', pnpm, 'install'], {
    cwd: PROFILE_DIR,
    encoding: 'utf8',
    timeout: 180000,
  });
  console.log(out.trim().split(/\r?\n/).slice(-10).join('\n'));
} catch (err) {
  console.error('pnpm install 失败：', err?.message ?? err);
  console.error(String(err?.stdout ?? '').slice(-2000));
  process.exit(1);
}

console.log('\n完成。');
console.log('  面板        http://127.0.0.1:19387/llm-router（Host 侧，重启后立即可用）');
console.log('  设置入口    设置 → 「渠道池」（client 侧，需要重启 DSH）');
console.log('  插件列表    设置 → 插件，会看到一条 sourceType=local 的 ' + PLUGIN);
console.log('  数据目录    ' + join(DSH_HOME, 'llm-router') + '（config.json / .env / catalog.json）');
