# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与
[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.1.0] - 2026-11-01

首个可发布版本。

### Added

- 单 World `memory`：把灵枢（`dsh-memory`）作为唯一记忆引擎，经 stdio MCP 调用。
- 7 个工具：`memory_remember`、`memory_recall`、`memory_task`、`memory_identity`、
  `memory_review`、`memory_forget`、`memory_state`。
- 注入分层：恒定内容进前缀头，易变块（状态行、主动开口）追加到请求尾部。
- 交接续接包：任务、未决问题、要点、近期原话、目标，以及用户/自我身份摘要。
- 交接摘要入库：读最新交接笔记的 `## 交接摘要`；一句 ≤240 字写会话要点（供续接包「要点」段），
  全文写一条 `contextual` 记忆（可 recall、进热块、参与睡眠整理）。摘要缺失时退回 400 字原话要点。
- 新增配置 `handoffNoteDir`（默认 `home/companion/workspace/handoffs`，空串关闭）。
- 四维生活状态：精力、警觉、心情、社交意愿；连续时间积分并持久化。
- 主动开口：15 分钟 tick，每日不限次，两次至少间隔 60 分钟。
- 身份画像：`subject_id=user` 与 `self`，写入 `observe` / `trait`，接入续接包。
- 审核闭环：`memory_review` 的 list / stats / decide / verify_record。
- 写入策略：`data/policy.json` 禁凭据等 13 条规则。
