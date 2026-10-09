# 贡献指南

## 这个项目的形状

纯 JavaScript（ESM），**没有构建步骤** —— `dist/*.js` 和 `lib/*.mjs` 都是手写的，
改完直接生效。不需要 TypeScript，不需要打包器。

```
dist/index.js      Host 侧：启动内嵌代理 + 注册 HTTP 路由 + 面板
dist/client.js     client 侧：注册「设置 → 渠道池」分区
dist/panel.html    面板本体（自包含 HTML/CSS/JS）
lib/               代理内核（配置 / 健康 / 池 / 服务器 / 探测 / 发现 / 余额）
test/              自检脚本
```

## 开发流程

```powershell
# 1) 改代码（改 dist/ 或 lib/ 下的文件）

# 2) 跑自检 —— 全绿才算改完
node test\run-tests.mjs                    # 27 项：fallback / 能力路由 / 熔断
node test\smoke.mjs                        # 11 项：内核能独立启动
node test\probe-report.mjs                 # 12 项：探测结果回报通道
node test\reset-at.mjs                     # 10 项：恢复时间解析
node test\check-panel.mjs                  #  7 项：面板语法 + 静态检查
node test\check-secrets.mjs                #  1 项：密钥泄露扫描
node test\catalog-link.mjs                 # 平台↔渠道关联

# 3) 同步到 DSH profile（会清掉旧副本再装）
node install.mjs

# 4) 重启 DSH 看效果
```

改 **client 侧**（`dist/client.js`）必须重启 DSH —— index 注入在 web server 启动时生成。
改 Host 侧同样需要重启（插件代码不在热重载范围内）。

## 提交前必须确认

1. **`check-secrets.mjs` 通过** —— 这条最重要。往公开仓库里推真实密钥是不可逆的事故。
2. **面板语法检查通过** —— `panel.html` 里的 JS 不进任何构建流程，写错了只能靠打开页面发现。
3. **`.gitattributes` 保持 `* -text`** —— 否则在 `core.autocrlf=true` 的机器上会产生
   "整个文件都改了"的假 diff。

## 代码约定

- **注释写「为什么」，不写「做了什么」** —— 代码本身能说明做了什么。
  特别要记下那些踩过的坑，比如"为什么探测失败不设冷却""为什么这里必须先 getReader"。
- **失败要分类**：429 / 5xx / 401 / 模型名错误 的处理策略不同，别一律当"失败"。
- **不要在日志里打印密钥**，只打印长度和前缀。

## 加新渠道怎么改

1. 在 `lib/default-config.json` 里加一个 provider（`id` / `baseURL` / `apiKeyEnv` / `capabilities`）
2. 在 `lib/catalog.json` 里加对应的平台信息（注册地址、需要的材料、核实情况）
3. 跑 `node lib/probe.mjs --tune` 实测一次，看它到底支持什么、token 开销多少
4. **根据实测结果修正 `capabilities`** —— 声明错了比不声明更危险
   （往纯文本渠道发图片，有些上游会返回 200 然后瞎编）

## 提 PR

- 一个 PR 做一件事，别把重构和功能混在一起
- 说明**为什么**要改，最好带上实测数据
- 自检输出贴一下（哪几项通过）
