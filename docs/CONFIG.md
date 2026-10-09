# 配置参考

配置文件在 `~/.dsh/llm-router/config.json`，密钥在同目录的 `.env`。
**首次运行时自动从插件内置模板生成**，不需要手工创建。

## 顶层结构

```json
{
  "server":   { "host": "127.0.0.1", "port": 8787 },
  "policy":   { },
  "providers": [ ]
}
```

### server

| 字段 | 默认 | 说明 |
|---|---|---|
| `host` | `127.0.0.1` | 监听地址。⚠️ **改成非回环地址会让面板的管理端点也暴露出去**，谨慎 |
| `port` | `8787` | 端口。被占用时插件会先探测是不是另一个 llm-router，是就复用它而不重复启动 |

### policy

| 字段 | 默认 | 说明 |
|---|---|---|
| `maxAttempts` | 6 | 单个请求最多尝试几个上游 |
| `connectTimeoutMs` | 20000 | 流式请求等首字节的超时 |
| `requestTimeoutMs` | 180000 | 非流式请求的整体超时 |
| `onAllCooling` | `force-any` | 全部渠道都在冷却时：`force-any` 挑冷却最短的硬试 / `force-local` 只用本地模型 / `fail` 直接报错 |
| `perModelCandidates` | 2 | 多模型渠道（`limits.perModel`）一次请求最多产出几个候选：模型 A 当场被限流时，同一次请求里就能换成 B |
| `cooldown.rateLimitMs` | 60000 | 429 的初始退避 |
| `cooldown.serverErrorMs` | 20000 | 5xx / 网络 / 空流的初始退避 |
| `cooldown.authErrorMs` | 1800000 | 401 / 402 / 403 的初始退避（30 分钟） |
| `cooldown.minMs` / `maxMs` | 5000 / 3600000 | 冷却时长的上下限（指数放大后仍被夹在这个区间） |

## providers[]

每个渠道一个条目。

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✓ | 唯一标识，也是 `id::model` 里用的名字 |
| `baseURL` | ✓ | OpenAI 兼容端点，末尾不要带斜杠 |
| `label` | | 面板上显示的名字 |
| `apiKeyEnv` | | 单个密钥的环境变量名 |
| `apiKeyEnvs` | | **多个密钥**（多账号）的变量名数组；与 `apiKeyEnv` 二选一 |
| `priority` | | 数字越小越先用。会被「探测并优化优先级」按实测成本重写 |
| `enabled` | | `false` 则该渠道完全不参与（默认 true） |
| `manualOnly` | | `true` 则 `auto` 模式**永不**选中它，只有显式写 `id::model` 才用。**付费渠道建议开** |
| `capabilities` | | 能力声明：`text` / `image` / `tools`。⚠️ **声明错了比不声明更危险** |
| `defaultModel` | | `auto` 模式下用哪个模型 |
| `models` | | 该渠道支持的模型列表（`/v1/models` 会列出来） |
| `local` | | `true` 表示本地模型（不需要 key），如 Ollama |
| `headers` | | 额外请求头（例如 OpenRouter 的 `x-title`） |
| `bodyPatch` | | 请求体补丁，会合并进发往上游的 JSON |
| `limits` | | 额度说明与**额度熔断**配置，见下节 |

### limits：额度熔断（在额度用完之前就切走）

`limits` 里只要出现 `tokens` / `cost` / `expiresAt` / `balance` 之一，这个渠道就启用**事前熔断**。
**只有 `note` 的老配置行为完全不变** —— 不参与阈值判定、不干预调度。

| 字段 | 默认 | 说明 |
|---|---|---|
| `note` | | 纯文字说明，不参与判定 |
| `tokens` | | 本周期 token 上限（自己填；只统计经过本代理的流量） |
| `cost` | | 或金额上限，配合 `priceIn` / `priceOut`（元/百万 token）折算 |
| `priceIn` / `priceOut` | 0 | 每百万 token 的单价，用于把用量折算成钱 |
| `window` | 不重置 | 周期：`day` / `week` / `month` / `90d` / `total` |
| `expiresAt` | | 绝对到期时间（ISO 8601）。到点直接停用，比 `window` 准 |
| `softRatio` | 0.9 | **软阈值**：达到后只把该渠道排到候选队尾 —— 额度不浪费，只是不再优先烧 |
| `hardRatio` | 1.0 | **硬阈值**：达到后彻底停用，连"全部冷却时兜底"也不会选中它 |
| `balance` | false | `true` = 只信平台自报的真实剩余（如 OpenRouter 的 `/api/v1/key`），不需要你填数字 |
| `paid` | false | 标记为付费渠道，面板上区分显示 |
| `perModel` | false | `true` = 这份额度是**每个模型各自一份**（同一渠道下多模型各记各的账，谁先烧完就换下一个） |

判定用的是**三层信息源**（从准到糙），没有就不判定：

1. **平台自报** —— 上游响应头 `x-ratelimit-remaining-tokens`（Groq / Cerebras 这类会带），
   或 `balance: true` 时定时查到的官方余额。**平台没给数字就绝不猜。**
2. **本地累计** —— `tokens`（或 `cost`）当分母 ÷ 本代理记录的用量。
3. 都没有 → 不干预，回到"撞到 429 才切换"的老行为。

⚠️ **必须知道的几点**

- **本地累计只算经过本代理的流量**。DSH 主对话若直连上游，那部分用量这里看不到。
- **用量写在 `~/.dsh/llm-router/usage.json`，跨重启保留**（否则重启一次就等于额度回满）。
- 平台侧真的重置过额度时，点面板的「重置额度用量」，或 `GET /admin/budget-reset?id=<渠道>`。
- **免费额度用完是报错（429），不是欠费** —— 所以免费渠道用软阈值就够，`hardRatio` 保持 `1.0`。
- **按量付费渠道**（余额扣穿会产生欠费）才需要 `hardRatio: 0.8` 这类提前量；同时务必留意
  `manualOnly` —— 它是让付费渠道彻底不被自动 fallback 撞上的第一道闸。

```json
"limits": {
  "note": "官方标称每模型 100 万 token / 90 天",
  "tokens": 1000000,
  "window": "90d",
  "softRatio": 0.9,
  "hardRatio": 1.0
}
```

#### 一个渠道下多个模型各自有额度（火山方舟那类）

火山方舟一把 key 下能挂几十上百个模型，**每个模型各有自己的额度**。
打开 `perModel`，账就按「渠道::模型」分开记，谁先烧完就自动换下一个：

```json
{
  "id": "ark-free",
  "baseURL": "https://ark.cn-beijing.volces.com/api/v3",
  "apiKeyEnv": "ARK_API_KEY",
  "priority": 5,
  "capabilities": ["text"],
  "defaultModel": "doubao-seed-1-6-flash-250715",
  "models": ["doubao-seed-1-6-flash-250715", "kimi-k2-250711", "deepseek-v3-250324"],
  "limits": {
    "note": "方舟每个模型每天 200 万 token",
    "perModel": true,
    "tokens": 2000000,
    "window": "day",
    "softRatio": 0.9,
    "hardRatio": 0.95
  }
}
```

行为：

- 选模型时**跳过**已经烧完（硬阈值）或正在冷却的模型，自动用 `models` 里的下一个；
- **同一次请求内就会连续尝试**（数量由 `policy.perModelCandidates` 控制，默认 2），
  所以"模型 A 当场被限流"不必等下一次请求；
- **429 / 404 只冷掉那一个模型**，同一渠道的别的模型照用；
  其余失败（5xx / 网络 / 401 / 403）仍然冷却整个渠道；
- 面板的「额度」列显示 `可用模型数 / 总模型数`。

> 模型清单别手抄：`/api/v3/models` 会返回一大堆**不能对话**的模型
> （embedding、视频生成、图片编辑…）。真打一发 `max_tokens=1` 的请求才算数。

### 多账号怎么配：先分清模型 ID 是不是"账号内资源"

| | 模型名是**平台级**的 | 模型 ID 是**账号内资源**的 |
|---|---|---|
| 例子 | 百炼 `qwen-plus`、腾讯 `deepseek-v4-pro`、千帆 `ernie-4.5-turbo-128k`、智谱 `glm-4.7-flash` | **火山方舟接入点 `ep-m-...`**（每个账号单独创建） |
| 换 key 能打吗 | ✅ 任何账号的 key 都能调同一个模型名 | ❌ 账号 A 的接入点，用账号 B 的 key 打**必然 404** |
| 怎么加账号 | 可以 `apiKeyEnvs` 放多把 key；**但想让额度算得准，仍推荐一个账号一个 provider** | **必须一个账号一个 provider**，各自 pin 自己的 key + 自己的接入点列表 |

**判断方法**：如果需要"先在控制台为某个账号单独创建这个 ID"，它就是账号内资源。

**回答一个常见疑问**：加新账号**不会**影响老账号 —— 老 provider 原样留着，它的模型照旧能用；
两个账号的接入点 ID 也**必然不同**（即使是同一个模型，两个账号各创建一个接入点，ID 也不一样）。

#### 示例 A：平台级模型名（可以用 apiKeyEnvs）

```json
{
  "id": "qianfan-text",
  "baseURL": "https://qianfan.baidubce.com/v2",
  "apiKeyEnvs": ["QIANFAN_API_KEY", "QIANFAN_API_KEY_2"],
  "priority": 10,
  "capabilities": ["text"],
  "defaultModel": "ernie-4.5-turbo-128k",
  "models": ["ernie-4.5-turbo-128k"]
}
```

#### 示例 B：账号内资源（火山接入点，必须一账号一 provider）

```json
[
  {
    "id": "ark-account-1",
    "label": "火山方舟 账号1",
    "apiKeyEnv": "ARK_API_KEY",
    "baseURL": "https://ark.cn-beijing.volces.com/api/v3",
    "priority": 5,
    "capabilities": ["text", "tools"],
    "defaultModel": "ep-m-AAAAAAAAAAAA-aaaaa",
    "models": ["ep-m-AAAAAAAAAAAA-aaaaa", "ep-m-BBBBBBBBBBBB-bbbbb"],
    "limits": { "perModel": true, "tokens": 2000000, "window": "day", "softRatio": 0.9, "hardRatio": 0.95 }
  },
  {
    "id": "ark-account-2",
    "label": "火山方舟 账号2",
    "apiKeyEnv": "ARK_API_KEY_2",
    "baseURL": "https://ark.cn-beijing.volces.com/api/v3",
    "priority": 6,
    "capabilities": ["text", "tools"],
    "defaultModel": "ep-m-CCCCCCCCCCCC-ccccc",
    "models": ["ep-m-CCCCCCCCCCCC-ccccc"],
    "limits": { "perModel": true, "tokens": 2000000, "window": "day", "softRatio": 0.9, "hardRatio": 0.95 }
  }
]
```

要点：

- **各自用 `apiKeyEnv`（单数）**，不是 `apiKeyEnvs` —— 一把 key 只管自己那批接入点
- **不要给它们配同一个 `limits.group`** —— 不同账号的额度本来就独立，配了 group 会把两份额度算成一份
- 加账号 = **新增一个 provider**，老 provider 一个字都不用改

> ⚠️ **同一个账号建多把 key 是共享账号额度的**，多把 key 只在**不同账号**时才是独立额度。
> 命令行加账号：`node add-account.mjs <providerId> "<新key>"`

> ⚠️ **配错的症状**：把账号 A 的接入点和账号 B 的 key 混在同一个 provider 里，
> A 的接入点会被 B 的 key 打成 `404 does not exist or you do not have access to it`，
> 按本项目的分类 404 属**模型级失败** → 那个模型被冷却。
> 表现出来是"模型莫名其妙不可用"，其实只是 key 和接入点串了。

## 怎么确定模型名

`defaultModel` 和 `models` 必须填该渠道**实际支持**的模型名。各家会变，**别靠记忆**：

```powershell
node lib/probe.mjs --vision --tools       # 测所有已配置渠道的 defaultModel
node lib/probe.mjs --only=<渠道id>         # 单独测一个
```

或者直接用面板上的「**探测并优化优先级**」—— 它会顺便按实测 token 开销重排顺序。

已知的模型名陷阱：

- **智谱**：`glm-4.7-flash` 是**思考模型**，简单问题也要烧 177~465 个 reasoning token
- **硅基流动**：`Qwen/Qwen3-8B` 同样带思考，实测 18 秒 / 386 token
- **千帆**：账号只开通了 `ernie-4.5` 系列，其他名字报 `does not exist or you do not have access`
- **火山**：`/api/coding/v3` 和 `/api/v3` 是两条不同通道，接入点 ID（`ep-...`）只能走后者

## `.env` 的格式

```
# 注释以 # 开头
ZHIPU_API_KEY=xxxx
DASHSCOPE_API_KEY=yyyy
```

- **空值的行会被跳过**（该渠道视为未配置，启动日志里会显示"已跳过"）
- 值两边的成对引号会被去掉
- `process.env` 里的同名变量**优先级高于**文件，方便临时覆盖
- 文件用 UTF-8，**不要带 BOM**

## 面板上能改什么

| 操作 | 相当于改了哪 |
|---|---|
| 「替换」某把 key | `.env` 里对应那一行 |
| 「增加一把」（多账号） | `.env` 加一个变量 + `config.json` 里把 `apiKeyEnv` 升级成 `apiKeyEnvs` |
| 「删除」某把 key | 从 `apiKeyEnvs` 移除 + 清空 `.env` 那行（只剩一把时会拒绝） |
| 「探测并优化优先级」 | 按实测 `total_tokens` 重写所有非 `manualOnly` 渠道的 `priority` |

所有写操作都会**先备份**（`config.json.bak-<时间戳>`）。
