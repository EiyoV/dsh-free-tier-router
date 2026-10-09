# Changelog

本项目的所有重要变更都记在这里。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [1.0.0] - 2026-10-09

首个发布版本。

### 新增

- **多渠道自动 fallback**：429 / 5xx / 401 / 模型名错误各自分级退避，
  连续失败指数放大，成功一次立刻清零
- **按任务自动选渠道**：请求带图片 → 只选声明了 `image` 的渠道；
  带 `tools` → 只选声明了 `tools` 的；两者都没有 → 按优先级挑最省的
- **按实测 token 成本自动排序优先级**：探测一遍后按真实 `total_tokens`
  重排 `priority` 并写回配置（写前自动备份），不是靠猜
- **额度恢复时间解析**：从上游限流错误里提取恢复时间，支持 10 种格式
  （火山 `It will reset at ...` / OpenAI 风格相对时间 / 中文「N 秒后重试」）
- **余额查询**：能查的平台显示剩余额度（实测目前仅 OpenRouter 有公开接口）
- **一个平台一张卡的面板**：平台信息 + API 管理地址 + key 的增删改
- **一个渠道可配多把 key**：请求遇到 401/403/429 时在同一渠道内换下一把
- **`manualOnly` 标记**：付费渠道在 `auto` 模式下永不参与，只在显式点名时使用
- **从 OpenRouter 自动发现新的零价模型**

### 安全

- 密钥泄露扫描（发布前安全门，扫描 33 个文件）
- 代理只监听 `127.0.0.1`；面板的写操作只接受本机回环请求

### 已知边界

- 不产生额度，免费额度需用户自行到各平台注册领取
- 不代注册账号（需要手机号 / 实名 / 验证码）
- 不做风控对抗（不伪造设备指纹、不做 IP 轮换）
- 大多数平台不提供余额查询接口，只能去各自控制台查看

[Unreleased]: https://github.com/EiyoV/dsh-free-tier-router/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/EiyoV/dsh-free-tier-router/releases/tag/v1.0.0
