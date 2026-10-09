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

### 示例：一个渠道配多个账号

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

对应的 `.env`：

```
QIANFAN_API_KEY=bce-v3/ALTAK-xxx/yyy
QIANFAN_API_KEY_2=bce-v3/ALTAK-aaa/bbb
```

> ⚠️ **同一个账号建多把 key 是共享账号额度的。** 多把 key 只在不同账号时才有独立额度。
> 命令行加账号：`node add-account.mjs qianfan-text "<新key>"`

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
