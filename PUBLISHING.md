# 发布指南

这个插件有**两种发布方式**，都不需要改代码。

## 方式 A：发到 npm（推荐，用户一条命令装）

```powershell
cd E:\工程\AI\workspace\llm-router\dsh-plugin

# 1) 确认 package.json 里的 private 已删除（发布必需）
#    当前已经是可发布状态，name = dsh-free-tier-router

# 2) 先看会被发布哪些文件（不会真的发）
node ..\pack.mjs           # 打 zip 预览
npm pack --dry-run         # 看 npm 会带哪些文件

# 3) 登录（第一次需要）
npm login

# 4) 发布
npm publish --access public
```

发完之后别人这样装：

```powershell
dsh plugin --profile <profile名> add dsh-free-tier-router
```

**包名冲突**：`dsh-free-tier-router` 如果已被占用，改 `package.json` 的 `name`
（比如加自己的前缀 `你的名字-dsh-free-tier-router`），然后同步改 `cordis.patch.yml`
里 `insert` 的 `name` 字段 —— **两处必须一致**，否则挂载不上。

## 方式 B：发到 GitHub（不需要 npm 账号）

```powershell
# 1) 把 dsh-plugin/ 目录推到一个公开仓库
git init
git add .
git commit -m "dsh-free-tier-router v1.0.0"
git remote add origin https://github.com/你的用户名/dsh-free-tier-router.git
git push -u origin main
```

别人这样装：

```powershell
dsh plugin --profile <profile名> add github:你的用户名/dsh-free-tier-router
```

## 发布前自检

```powershell
cd E:\工程\AI\workspace\llm-router
node test\run-tests.mjs                    # 27 项：fallback / 能力路由 / 熔断
node dsh-plugin\test\smoke.mjs             # 11 项：内核自包含启动
node dsh-plugin\test\probe-report.mjs      # 12 项：探测结果回报通道
node dsh-plugin\test\reset-at.mjs          # 10 项：恢复时间解析
node dsh-plugin\test\check-panel.mjs       #  7 项：面板语法 + 静态检查
node dsh-plugin\test\catalog-link.mjs      # 平台↔渠道关联
node test\verify-package.mjs               # 19 项：解压到临时目录验证自包含
```

全绿再发。

## 发布后要提醒用户的事

README 里已经写清楚，但发帖时最好也说一遍：

1. **需要自己注册各平台的账号拿免费额度** —— 插件不提供额度，也不能替你注册
2. **免费额度是有限的**，各家的免费政策会变，模型名会过时（面板上有「探测并优化优先级」可核实）
3. **多账号轮换免费额度普遍违反平台条款**，有封号风险
4. 插件里**不含任何内置密钥**，所有 key 都由用户自己填，存在 `~/.dsh/llm-router/`

## 版本号怎么定

- 修 bug → `1.0.1`
- 加功能 → `1.1.0`
- 改配置格式 / 破坏兼容 → `2.0.0`

改 `package.json` 的 `version` 即可。
