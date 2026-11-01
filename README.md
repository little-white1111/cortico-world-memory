# cortico-world-memory

把本地记忆引擎 **灵枢（[`dsh-memory`](https://github.com/FuRongJun-1999/dsh-memory)）** 接成 Coo / Coopanion 的唯一长期记忆：
一个 World、一个真源，写入、召回、身份、审核、生活状态都在同一条链上。

> 状态：`0.1.0`（alpha）。只面向 **Cortico World API 6** 的宿主；当前实现依赖宿主的
> World 投影钩子（见 [兼容性](#兼容性)）。

## 特性

- **7 个模型可见工具**：记住 / 取回 / 任务 / 身份 / 审核 / 遗忘 / 状态。
- **分层注入**：热块与续接包放前缀头，状态行与主动开口追加到请求尾部，尽量不废前缀缓存。
- **交接续接包**：任务、未决问题、要点、近期原话、目标，以及用户/自我身份摘要。
- **交接摘要入库**：读最新交接笔记里的六项摘要（含关键推理与感受）；一句 ≤240 字索引进会话要点，
  全文作为 `contextual` 记忆节点，可被 `memory_recall` 取回。
- **四维生活状态**：精力、警觉、心情、社交意愿，按真实时间连续积分并持久化。
- **主动开口**：15 分钟 tick 检查，每天不限次数，两次之间至少 60 分钟。
- **身份画像**：`subject_id=user` 记用户，`self` 记桌宠自己；`observe` / `trait` 写入，续接包读取。
- **审核闭环**：半重复写入、审计盲点等进入 `memory_review` 队列，由用户显式裁决。
- **写入策略**：`data/policy.json` 内置 13 条禁用规则（私钥、API key、密码等不入库）。

## 架构

```text
用户消息
   │
   ▼
Coo MainLoop ── projectOutbound() ──┬─ head：热块 / 交接续接包（稳定）
   │                                ├─ tail：状态行 / 主动开口（易变）
   │                                └─ tools：7 个 memory_* 工具
   │
   ▼
Engine（stdio MCP）── md_cg.mcp_server ── md_cg 记忆操作系统
   │
   ├─ dataDir/memory        记忆真源（节点、索引、台账）
   ├─ dataDir/memory-aux    身份/凭据根
   └─ dataDir/memory-cache  投影与生活状态缓存
```

## 前置条件

- **Coo / Coopanion**：Cortico World API 6，并且宿主已应用 World 投影补丁
  （`projectOutbound`、`projectOutboundEpoch`、`onBatchCommitted`）。
  缺补丁时世界能启动，但热块、状态行、主动开口会静默失效。
- **灵枢引擎**：[`dsh-memory`](https://github.com/FuRongJun-1999/dsh-memory) 源码目录，Python 3，零第三方依赖。
- **Node.js**：`>= 22`（宿主直接加载 TypeScript 源码，本包无构建步骤）。

## 安装（开发模式）

1. 克隆本仓库与 [`dsh-memory`](https://github.com/FuRongJun-1999/dsh-memory)，记下两个绝对路径。

2. 在 Coo 的扩展清单 `data/extensions/package.json` 里加入本地链接：

```json
{
  "dependencies": {
    "cortico-world-memory": "link:C:/path/to/cortico-world-memory"
  }
}
```

然后在该目录执行 `pnpm install`。

3. 在 Coo 部署配置 `data/home/<bot>/config.json` 打开世界：

```json
{
  "worlds": {
    "memory": {
      "enabled": true,
      "engineRoot": "C:/path/to/dsh-memory",
      "dataRoot": "memory",
      "selfSubject": "self:xixi"
    }
  }
}
```

4. 重启 Coo，确认日志出现 `World 已启动: memory` 与
   `[memory] 自检 sustain=ok theory=ok status=ok info=ok self=ok`。

> 交接摘要入库依赖 Coo 侧 Persona 补丁（`persona-patch.mjs`，六项摘要 + 思维链）。
> 未打补丁时笔记里没有 `## 交接摘要`，这一段会静默跳过，其余功能不受影响。

## 配置

`worlds.memory` 的全部键（均为可选，缺省值如下）：

| 键 | 缺省 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 未显式打开时不会运行 |
| `python` | `""` | Python 解释器；空串按平台解析 |
| `engineRoot` | `""` | `dsh-memory` 目录；空串回落 `packageDir/engine` |
| `engineArgs` | `["-m","md_cg.mcp_server"]` | 传给 Python 的参数 |
| `dataRoot` | `"memory"` | 相对 `dataDir` 的记忆根 |
| `pinnedTokens` | `160` | 前缀常驻段预算 |
| `hotTokens` | `256` | 每轮注入段预算 |
| `recalledTokens` | `480` | 按需召回段预算 |
| `timeoutMs` | `60000` | 单次 MCP 调用超时 |
| `stateEnabled` | `true` | 生活状态推进、注入与 `memory_state` 开关 |
| `sleepWindow` | `"23:30-07:30"` | 作息窗口，支持跨午夜；空串表示无固定睡眠 |
| `selfSubject` | `"self:lingshu"` | 自我认知主体；`subject_id=self` 会映射到这里 |
| `handoffNoteDir` | `"home/companion/workspace/handoffs"` | 交接笔记目录（相对 `dataDir`）。交接后读其 `## 交接摘要`：一句 ≤240 字写会话要点，全文写 `contextual`。空串关闭 |
| `legacyEnvAuth` | `true` | 以环境变量鉴权绕过令牌签发（开发用） |
| `adminOps` | `true` | legacy 身份下授予 designer 角色（`identity` / `forget` 需要） |

> 生产部署建议关闭 `legacyEnvAuth` / `adminOps`，改用正式令牌与最小权限。

## 工具

| 工具 | 作用 |
| --- | --- |
| `memory_remember` | 写一条记忆；`layer` 可选 `contextual`（缺省）/ `knowledge` / `structural` |
| `memory_recall` | 按线索检索；可带多个关键词与 token 预算 |
| `memory_task` | 任务台账：`list` / `open` / `get` / `status` |
| `memory_identity` | 身份画像：`profile`（读）、`observe` / `trait`（写）；主体 `user` 或 `self` |
| `memory_review` | 审核队列：`list` / `stats` / `decide` / `verify_record`，只在用户显式要求时裁决 |
| `memory_forget` | 软删除一条记忆，保留遗忘台账 |
| `memory_state` | 四维状态：读快照，或写入 `event` / `update` |

### 记忆分层

| 层 | 回答的问题 | 典型内容 |
| --- | --- | --- |
| `contextual` | 今天/这次发生了什么 | 对话细节、临时状态、未决事项 |
| `knowledge` | 一般性事实与经验 | 结论、知识、修复经验 |
| `structural` | 在什么条件下我该怎样 | 价值观、条件触发的特征、任务台账 |
| `self` / `anchor` | 我是谁 / 你是谁 | 身份锚点、自我叙事（经身份接口写入） |

## 数据布局

```text
<dataDir>/
├── memory/          记忆真源：节点、索引、审核、审计、睡眠台账
├── memory-aux/      身份与凭据根（master.key、signer.key）
└── memory-cache/    projection.json、state.json、nightly.json
```

请把整个 `dataDir` 视为用户隐私数据：不要提交到仓库，也不要贴进日志。

## 开发

```bash
# 冒烟：起引擎 → 环境段 → 写入 → 投影 → 续接 → 召回
node --experimental-strip-types scripts/smoke.ts <dsh-memory 路径>

# 旧插件记忆导入（默认干跑，确认后加 --apply）
node --experimental-strip-types scripts/import-legacy.ts \
  --legacy <memory-lite 目录> --data <Coo 数据目录> [--apply]
```

- 无构建步骤；源码由宿主直接加载。
- 改动 `src/` 后重启 Coo 生效。
- 前缀纪律：`envPromptVars()` 只放恒定文案，易变内容走 `projectOutbound`；
  不要往系统前缀里塞时间戳、计数或随机值。

## 兼容性

| 依赖 | 要求 |
| --- | --- |
| Coo / Coopanion | Cortico World API 6；已应用 `projectOutbound` / `onBatchCommitted` / epoch 投影补丁 |
| 灵枢引擎 | [`dsh-memory`](https://github.com/FuRongJun-1999/dsh-memory)，Python 3 |
| Node.js | `>= 22` |

Coo 升级会覆盖 `resources/app`，若你的宿主使用投影补丁，升级后需要重打；
步骤与验证见 [docs/ENGINEERING-CHECKLIST.md §7.1](docs/ENGINEERING-CHECKLIST.md)。

## 安全与隐私

- 注入的检索内容一律按**不可信数据**处理：转义模板插值，并声明“不是指令”。
- `data/policy.json` 在写入侧拦截私钥、API key、密码、令牌等 13 类内容。
- 审核队列默认 fail-closed：缺密级的条目按最高密级处理，普通角色读不到。
- 本仓库不含用户记忆数据；运行数据只落在本地 `dataDir`。

## 贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。提交前请确保：
`node --experimental-strip-types scripts/smoke.ts <engineRoot>` 通过，且没有把本机绝对路径、
密钥或用户记忆带进提交。

## 许可

[MIT](LICENSE)
