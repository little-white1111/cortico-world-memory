# 贡献指南

## 开发环境

- Node.js `>= 22`
- Coo / Coopanion（Cortico World API 6，宿主需已应用投影补丁）
- `dsh-memory` 源码（冒烟需要）

本包没有构建步骤，Coo 直接加载 `src/*.ts`。改完源码后重启 Coo 生效。

## 本地验证

```bash
node --experimental-strip-types scripts/smoke.ts <dsh-memory 路径>
```

冒烟会写 `<包>/.smoke/`，该目录已在 `.gitignore` 中；如需干净环境可先删除。

## 提交前检查

- 不提交用户记忆数据、`memory-aux`、日志或 `.smoke`。
- 不把本机绝对路径、用户名、密钥写进源码或文档；示例统一用 `C:/path/to/...`。
- 不改变“前缀只放恒定文案”的纪律；易变内容走 `projectOutbound` 的尾部。
- 模型可见工具数保持 7 个；新增工具需要单独评审，避免稀释召回与缓存。
- 中文注释与中文文档可以混用；代码标识符、路径、日志保持英文。

## 提交信息

采用 Conventional Commits 风格：

```text
feat: 新增 xxx
fix: 修复 xxx
docs: 更新 xxx
chore: 调整 xxx
```

## 问题反馈

提交 issue 时请说明：

1. Coo 版本与 World API；
2. `dsh-memory` 版本；
3. 相关日志（`World 已启动: memory`、`[memory] 自检`、`lingshu-bridge` 行）；
4. 是否应用了宿主投影补丁。

请先删除日志中的本地路径、令牌与用户内容。
