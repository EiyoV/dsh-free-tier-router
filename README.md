# dsh-llm-router-panel

DSH 插件：**自带代理内核**的多平台 LLM 渠道池。

把好几个平台的**免费额度**合成一个"看起来用不完"的池子：谁限流了就换下一个，按实测成本自动排序，
**按任务自动挑渠道**（要识图就用能识图的、要调工具就用支持工具的），付费渠道永不自动参与。

自包含 —— 不依赖任何外部项目目录，换台电脑解压即装。

## 它做什么 / 不做什么

**做**：

- 一个可用的渠道池 + 自动 fallback + 冷却熔断
- **按任务自动选渠道**：请求带图片 → 只选能识图的；带 tools → 只选支持工具调用的；都没有 → 挑最省的
- **按实测 token 成本自动排序**优先级（不是靠猜，是拿真实 `total_tokens` 排）
- 面板上一个平台一张卡：平台信息 + API 管理地址 + key 的增删改
- 显示每个渠道的状态、冷却/恢复时间、累计 token、最近错误
- 从 OpenRouter 自动发现新的零价模型

**不做**（这些界限是刻意的）：

- ❌ **不产生额度**。免费额度要你自己去各平台注册领取
- ❌ **不替你注册账号**（要手机号 / 实名 / 验证码）
- ❌ **不做风控对抗**（不伪造设备指纹、不做 IP 轮换、不自动注册）
- ❌ **不查余额**。大多数平台没有查余额的 API，只能去各自控制台看；
  但**限流时很多平台会把恢复时间写在错误消息里**（如火山 `It will reset at ...`），
  插件会把它抓出来显示成「14:35 恢复」

> ⚠️ 同一个账号建多把 key 是**共享账号额度**的，多把 key 只在「不同账号」时才是独立额度。
> 多账号轮换免费额度普遍违反平台条款，有封号风险，后果自负。

## 路由规则（核心行为）

一次请求怎么选渠道：

1. **能力硬过滤**：请求带图片 → 只留声明了 `image` 的渠道；带 tools → 只留声明了 `tools` 的。
   （往纯文本渠道发图片，火山/通义这类会返回 **200 然后瞎编**，比报错危险得多。）
2. **跳过 `manualOnly`**：标记为手动专用的渠道（通常是付费的）在 `auto` 模式下**永不参与**，
   只有显式写 `providerId::model` 才会用到 —— 防止自动 fallback 撞上付费渠道产生费用。
3. **按 priority 升序**，跳过正在冷却的。
4. 失败就换下一个，并给失败的渠道设冷却。

### 自动调优优先级

面板上的「**探测并优化优先级**」跑完会**按实测 token 开销自动重排 priority**（越省越靠前）：

```powershell
node lib/probe.mjs --tune          # 单独跑也行
```

排序依据是同一条探测请求的 `total_tokens`（同分比耗时）。`manualOnly` 的渠道不参与排序。
实测示例：千帆 6 token → 百炼 14 → OpenRouter 42 → 硅基 174 → 智谱（思考型，几百）。

### 一个渠道配多把 key（多账号）

```powershell
node add-account.mjs qianfan-text "bce-v3/ALTAK-xxx/yyy"
node add-account.mjs --list                    # 看每个渠道有几把
```

配置形态：`apiKeyEnvs: ["QIANFAN_API_KEY", "QIANFAN_API_KEY_2", ...]`。
请求遇到 401/403/429 时，代理会在**同一渠道内**换下一把 key 重试。

> ⚠️ **同一个账号建多把 key 是共享额度的** —— 多把 key 只在「不同账号」时才有独立额度。
> 多账号轮换免费额度普遍违反平台条款，有封号风险，后果自负。

## 换台电脑怎么用

1. 拿到 `dsh-llm-router-panel-0.1.0.zip`（在项目 `dist-package/` 下，或自己跑 `node dsh-plugin/pack.mjs` 生成）
2. 解压到任意目录
3. 在该目录执行：
   ```powershell
   node install.mjs
   ```
   （没装 Node 也行 —— 装了 DSH 就有 Node，脚本会自动找到 DSH 安装目录和它自带的 pnpm）
4. **重启 DSH**
5. 打开面板填 key：http://127.0.0.1:19387/llm-router

配置和密钥住在 `~/.dsh/llm-router/`，**首次运行自动生成**。想带着配置换机就把这个目录一起拷走。

## 装完在哪看

| 位置 | 内容 | 生效 |
|---|---|---|
| 设置 → **渠道池** | 独立选项面板（client 侧） | 需重启 DSH |
| 设置 → **插件** | 列表里一条 `sourceType=local` 的 `dsh-llm-router-panel`，可启停 | 安装后即有 |
| `/llm-router` | 同一份面板的直达地址 | 重启后可用 |
| `/api/llm-router/*` | `status` / `catalog` / `action` / `save-key` | 重启后可用 |

## 面板能干什么

- 看每个渠道：是否可用、冷却剩多久、请求 / 成功 / 失败次数、累计 token、最近错误
- 一键：解除全部冷却、探测渠道（真实请求）、发现新免费模型、发现并写入配置、重新加载配置
- 看「待你注册」渠道清单：注册地址、需要什么材料、我核实到的坑
- **直接粘贴 key 保存**（不用手改文件）

## 数据目录

```
~/.dsh/llm-router/
  config.json    渠道清单与策略（首次从内置模板生成，可自行改）
  .env           各渠道密钥（首次生成带注释的模板）
  catalog.json   渠道目录（注册指引 / 已核实额度 / 坑）
  logs/          预留
```

`config.json` 里的能力声明（`capabilities`）很关键：往纯文本渠道发图片，火山/通义这类会返回 **200 然后开始瞎编**，比报错危险得多。所以请求带图时只会选声明了 `image` 的渠道。

## 端口冲突

代理默认监听 `127.0.0.1:8787`。如果该端口已经有另一个 llm-router 在跑（比如独立项目的 `start.cmd`），插件会**复用它而不是重复启动**。要改端口就改 `cordis.patch.yml` 里的 `port`，或 `config.json` 里的 `server.port`。

## 目录结构

```
package.json        声明 dsh.bundle.patch（自动挂载）与 dsh.client（web 平台）
cordis.patch.yml    bundle 层：insert 自己
dist/index.js       Host：启动内嵌代理 + 注册路由 + 面板
dist/client.js      client：IIFE + __ModuleLoader__.load，注册 settings.section
dist/panel.html     面板本体（纯 HTML/CSS/JS，无构建）
lib/                代理内核（config / health / pool / server / discover / probe / paths）
lib/default-config.json  内置默认渠道配置
test/smoke.mjs      冒烟测试（不需要 key）
install.mjs         安装脚本
pack.mjs            打 zip
migrate-env.mjs     把项目 .env 的 key 迁进数据目录（本机一次性用）
```

`dist/*.js` 和 `lib/*.mjs` 都是**手写纯 JS**，没有 TypeScript、没有打包步骤 —— 改完跑 `install.mjs` 即可。

## 开发

```powershell
node dsh-plugin\test\smoke.mjs     # 冒烟测试（不需 key，会初始化数据目录）
node dsh-plugin\install.mjs        # 同步到 profile（会先清掉旧副本）
node dsh-plugin\pack.mjs           # 重新打 zip
node test\verify-package.mjs       # 解压到临时目录验证包是自包含的
```

改 **Host 侧**（`dist/index.js`、`lib/`）→ 跑 `install.mjs` + 重启 DSH。
改 **client 侧**（`dist/client.js`）→ 必须重启 DSH（index 注入在 web server 启动时生成）。

## 注意

- `cordis.patch.yml` 里的路径用**正斜杠**：YAML 双引号里的反斜杠是转义符，中文路径必踩。
- `package.json` 的 `name` 必须与 patch 里的 `name` 完全一致。
- `file:` 依赖会被 pnpm 按 `files` 字段打包复制 —— 改了 `files` 或加了新目录（如 `lib/`）后，
  必须先删掉 `node_modules/dsh-llm-router-panel` 再装，否则 pnpm 认为"无事可做"（实测输出 `Packages: -10`），
  新文件不会同步过去。`install.mjs` 已经自动处理这一步。
- 用 Node 改 JSON，不要用 PowerShell `Set-Content`：这台机器的 `pwsh` 是 Windows PowerShell 5.1，写无 BOM 的 UTF-8 会出问题。
- 安装必须用 DSH 自带的 pnpm：`dsh plugin --profile desktop ...` 会被 CLI 硬拒绝（源码写死 desktop 由 Electron 独占管理）。
