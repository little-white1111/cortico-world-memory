# cortico-world-memory 工程清单

将灵枢（dsh-memory）作为 Coo 的唯一记忆引擎，并把 `cortico-world-memory-lite`、
`cortico-world-private-companion` 的工程能力吸收进本包。

> 状态：**已定稿 · 方案 A**
> 形态：一个 TS 扩展 + 一个 Python 引擎进程 + 一份数据根。
> 两个旧插件**退役**，不做运行时并联、不做跨 World 通信。

---

## 1. 方案 A 的定义

| 项 | 内容 |
| --- | --- |
| 用户动作 | 装一个扩展，启用一次 |
| 运行时 | 1 个 World（本包）+ 1 个 `md_cg.mcp_server` 子进程 |
| 真源 | 只有灵枢的 md 认知图，一份 |
| 旧插件 | 停用，数据只读保留（回滚用） |
| 检索 | 只有灵枢的 RRF 六路 |
| 删除 | 只有 `cg(op=forget)` |

一句话：**灵枢下沉为引擎，本包上浮为管道与语义门面，两个旧插件只作为代码素材。**

## 2. 不变量（违反即返工）

1. **只有灵枢写记忆真源。** 本包只写缓存与投影中间态。
2. **system 前缀不许每轮变。** 易变内容只能进 `projectOutbound`：低频变化的 hot/resume 放
   `headLength(records)` 之后（它们在缓存指纹内，变一次就整段重建）；每轮可能变的
   state/open 追加到请求尾部（`appendTail`，只废尾段）。
3. **删除只归灵枢。** `cg(op=forget)` 是唯一删除入口；本包的 `decay` 只影响注入排序。
4. **未授权不静默。** 无 token 时只读运行，且必须落日志（否则表现为「装了但永远记不住」）。
5. **注入内容是不可信数据。** 一律 `escapePromptBraces` + untrusted 包裹（打断 `{{`，否则会话永久不可用）。
6. **索引可丢可重建。** 本地缓存坏了能重建，不许成为第二真源。
7. **同一时间只启用一个记忆 World。** `worlds` 配置里 `memory-lite`、`private-companion`、本包三者只允许一个 `enabled: true`。
   - 现状（2026-10-31）：`memory-lite` 已全停；`companion`（我会永远陪着你）**保留启用**，但 `memoryEnabled=false` / `memoryCapture=false` / `memoryNotesInPrompt=0`——它只提供人格、状态与主动联系，不写记忆、不注入记忆段。启停这两个开关比整停更能保住桌宠的生活感。

## 3. 架构

```
Coo 主进程
└── cortico-world-memory (World)
      ├── envPromptVars  → 稳定段（pinned）
      ├── projectOutbound → 易变段（hot + 续接）
      ├── tools          → 语义工具（5-8 个）
      └── engine.ts ──stdio JSON-RPC──▶ python -m md_cg.mcp_server
                                            └── md 真源 / 索引 / 账本
```

### 3.1 与两个旧插件的关系

| 关系 | 说明 |
| --- | --- |
| 素材 | 代码级搬运（copy-in），**不 import、不依赖、不共进程** |
| 运行时 | 完全不参与；启用后即停用 |
| 数据 | 保留只读，切换后 30 天内可回滚 |

不并联的原因（三条，任一都会让方案失效）：

1. Coo 一个扩展 = 一个 World，**未见跨 World 调用 API**，三者各自持 store，彼此读不到。
2. 三方都实现 `envPromptVars` / `projectOutbound`，同一段 system 前缀被争抢，前缀每轮变，缓存全废。
3. 三份真源 → 同一事实三处存、三处各删各的，最终不可信。

### 3.2 能力去向

| 能力 | 来源 | 去向 |
| --- | --- | --- |
| md 真源 / 8 层图 / CCG / 四态裁决 | 灵枢 | **保留**，作为引擎 |
| RRF 六路检索 / 预算装包 / 审计账本 | 灵枢 | **保留** |
| 注入位置（`headLength` 之后） | memory-lite | **吸收** → `projection.ts` |
| 幂等消息 id + `projectOutboundEpoch` | memory-lite | **吸收** → `projection.ts` |
| 三层预算（pinned / hot / recalled） | memory-lite | **吸收** → `budget.ts` |
| 可解释降级摘要 | memory-lite | **吸收** → `prompt.ts` |
| 卡片 `fact_key` 幂等 upsert | memory-lite | **吸收** → 写入键映射 |
| 原始事件 + 派生双表 | private-companion | **吸收** → `lifecycle.ts` |
| 写入可靠性（`.bak` / `.corrupt-*` / 只读保护） | private-companion | **吸收** → `paths.ts` |
| `trust` / `reviewStatus` / `scope` | private-companion | **吸收** → `trust.ts` |
| `openThreads` / `highIntensityEpisodes` / `decaySweep` | private-companion | **吸收**（只作用于排序） |
| 语义工具形态（一能力一工具） | private-companion | **吸收** → `tools.ts` |
| `local-hash-v1` 哈希向量 | memory-lite | **裁掉**：仅词法，灵枢更强 |
| 自建倒排 / BM25 | 两个插件 | **裁掉**：检索统一交灵枢 |
| 插件侧遗忘 / 淘汰 | 两个插件 | **裁掉**：删除只走灵枢 |
| 旧插件的 WebUI 面板 | 两个插件 | **退役闲置**，不迁移 |

## 4. 目录结构

```
cortico-world-memory/
├── describe.json                 # 扩展描述（对齐 memory-lite 字段）
├── package.json                  # ESM，tsx 直接加载，无编译步骤
├── tsconfig.json                 # 仅类型检查
├── src/
│   ├── index.ts                  # createMemoryWorld()
│   ├── world.ts                  # World 实现：八个钩子
│   ├── bridge.ts                 # 灵枢 stdio JSON-RPC（直接搬，零依赖）
│   ├── engine.ts                 # 引擎门面：recall / write / forget / session_recall
│   ├── projection.ts             # 出站投影 + 幂等 id
│   ├── budget.ts                 # 三层预算 + hardTokens 换算
│   ├── lifecycle.ts              # openThreads / intensity / decay（只排序）
│   ├── state.ts                  # 四维生活状态（精力/警觉/效价/社交）+ 合成规则
│   ├── trust.ts                  # trust / reviewStatus / scope
│   ├── tools.ts                  # 语义工具
│   ├── token.ts                  # 首启签发 + 只读降级
│   ├── config.ts                 # 默认值 + 深合并
│   ├── paths.ts                  # 数据根 + 损坏隔离
│   └── prompt.ts                 # 环境段渲染 + 注入转义
├── prompts/
│   └── ENV_PROMPT.md             # 部署级可覆盖
└── scripts/
    ├── smoke.ts                  # 冒烟验收（工具 / 注入位置 / 幂等 id / 续接）
    └── import-legacy.ts          # 旧插件数据导入（一次性，P2，默认干跑）
```

## 5. 钩子映射

| 钩子 | 时机 | 行为 |
| --- | --- | --- |
| `envPromptVars()` | **前缀重建时，非每轮** | `pinned` / `pinned_tokens` / `card_count` / `state` / `division` |
| `projectOutbound(records, {hardTokens})` | 每轮 | 注入 hot + 续接；不改则返回 `null` |
| `projectOutboundEpoch()` | 计数锚点 | `turnCount * 1e6 + revision` |
| `onBatchCommitted(records)` | 批末 / 交接前 | 归档本批原话（交接前唯一落盘机会） |
| `onHandoffEnded()` | 交接完成 | 生成续接块，下轮注入一次 |
| `onTurnEnded()` | 每轮结束 | 清除续接块 |
| `tools()` | 装配 | 语义工具集 |
| `start(host)` / `stop()` | 生命周期 | spawn / 重连 / 崩溃恢复 / 优雅退出 |

### 5.1 三层预算

| 层 | 内容 | 位置 | 预算 |
| --- | --- | --- | --- |
| pinned | `anchor` / `self` / 活跃目标 | 环境段 | 常驻，重建才变 |
| hot | `recent_events` + 任务台账 | `projectOutbound` | 每轮，独立（默认 256） |
| recalled | 检索结果 | 工具 | `budget_tokens`（默认 480） |

### 5.2 `hardTokens` 换算

- Coo 给 `hardTokens = window − maxTokens`，**可能为 `null`**。
- `null` → 用默认值。
- 非 `null` → `hot = min(256, hardTokens * 0.15)`，其余给 recalled。

### 5.3 会话映射

`lingShuSessionId = hash(cooConversationId + handoffEpoch)`。handoff 开启新 epoch，旧 tag 保留可查。

### 5.4 写入策略覆盖

`data/policy.json` 随包发布，经 `MDCG_POLICY_FILE` 交给引擎（不改引擎代码）：

- `forbidden` 13 条与灵枢默认逐字一致——「凭据不入库」不放宽。
- `required`（CCG 六要素）不收：六要素是「归档成文」的格式要求，而 `memory_remember` 记的是对话里的一句话事实/约定/偏好，按六要素写只会产出空壳结构，反而污染记忆。
- 需要恢复灵枢严格口径时，把 `required` / `required_kinds` / `required_labels` 三项按 `dsh-memory/data/policy.json` 抄回即可。

### 5.5 生活状态四维（2026-10-31 设计）

**定位**：只影响「怎么说」与「要不要开口」，不影响「记得什么」。不进 system 前缀，
不进灵枢真源；状态是缓存中间态，丢了按时间重算即可。

| 维度 | 含义 | 主要驱动 | 时间尺度 |
| --- | --- | --- | --- |
| `energy` 精力 | 有没有电 | 昼夜相位 + 睡眠债 + 午后低谷 | 小时 |
| `alert` 警觉 | 反应快不快 | 精力 + 睡眠惯性 + 超日波动 | 15–90 分钟 |
| `valence` 情绪效价 | 心情好坏 | 基线 + 事件脉冲 + 回归 | 小时–天 |
| `social` 社交意愿 | 想不想理人 | 静息恢复 − 互动消耗 + 开放回路 | 小时 |
| `openLoops` 开放回路 | 有没有话没说完 | `lifecycle.ts` 未结线索 + 灵枢 `information_gap` | 天 |

**积分口径**（读取时按 `now − ts` 补算，O(1)，不做常驻 tick）：

```
# 精力：Borbély 双过程 S（tau_w=18.2h 上升 / tau_s=4.2h 下降，论文参数）
S  = 清醒 ? 1-(1-S0)*exp(-Δt/18.2h) : S0*exp(-Δt/4.2h)
debt += max(0, needH - sleptH) / needH        # 上限 1，按夜结算
dip  = 0.10 * exp(-((小时距起床 - 6.5)^2) / 2.88)   # 午后低谷，幅度自定
pressure = clamp01((S - 0.2) / 0.5)           # S 在 0.2–0.7 区间摆动
energy   = 0.98 - 0.72*pressure^0.85 - 0.28*debt - dip - effort

# 警觉：睡醒 15 分钟惯性；精力日常只在 0.3–0.7，乘 1.1 避免读数贴着档位阈值
inertia = 0.4 * exp(-Δt_wake/15min)
alert   = clamp01(1.1*energy - inertia)

# 情绪：OU 回归 + 事件脉冲（θ=ln2/3h）
valence = base + (valence-base)*exp(-θ*Δt) + Σ amp*exp(-(now-at)/30min)
base    = 0.55；单次脉冲 |amp| ≤ 0.25

# 社交：静息恢复 0.10/h，互动消耗 0.15/h，有未结线索 +0.10
social = clamp(social + (0.10*(1-social) - 0.15*active) * Δt + (openLoops>0 ? 0.10 : 0))
```

**参数依据**（文献给的骨架，幅度是自定）：

- `tau_r=18.2h / tau_d=4.2h`：Borbély 双过程模型的标准时间常数（`S` 在清醒期上升、睡眠期指数衰减）；
- 「13 小时醒着 ≈ 酒驾门槛」：Dawson & Reid (1997) 实测 17–19h 持续清醒时部分任务表现等同 BAC 0.05%——
  这是 `debt` 与 `effort` 权重取「够明显但不至于废掉一天」的标尺，不是逐字换算；
- `dip` 幅度 0.10、`inertia` 0.4/15min、`θ=ln2/3h`、脉冲半衰 30min：自定量级，
  改动集中在 `state.ts` 顶部常量，便于日后按真实日志调；
- 超日节律（±0.05/90min）**未采用**：±0.05 的周期摆动正好压在档位阈值上，
  会让状态行每小时翻档、块 id 失效，而它的证据本就弱。

**合成规则**（输出策略，而不是把四个数丢给模型）：

- `verbosity`：energy < 0.4 → 短；> 0.7 → 可以长；其余正常
- `tone`：valence < 0.4 → 收敛、少开玩笑；> 0.65 → 轻快；其余平常
- `proactive`：`social ≥ 0.55 && energy ≥ 0.35 && alert ≥ 0.4 && 静默 ≥ 45min
  && 两次开口间隔 ≥ 60min && 不在免打扰（23:00–08:30）&& 有开放回路`
  （2026-11-01 起每日次数不限，原「今日 < 3 次」已删除）
- 本批**只算不出手**的约束已在 P2.8 解除：`proactive` 仍只用于提示，真正的开口由
  15 分钟 tick + 素材包 + `host.pushEvent` 负责（见 §5.6 B2 与 P2.8）。

**反抖动**：状态行必须离散化（energy 五档、alert/valence/social 三档），
文本不变则块 id `msg_state_${fnv1a(text)}` 不变，避免每轮微变废掉前缀缓存。

**事件来源**：对话轮次自动记（每轮 energy −0.003、互动 social −0.01，不额外调模型）；
情绪事件由模型显式调 `memory_state action=event` 记脉冲。

**存储**：`<数据根>/memory-cache/state.json`，字段
`{ ts, energy, alert, valence, social, base, s, debt, wakeAt, lastActiveAt, pulses[], dailyProactive }`。
坏文件改名 `.corrupt-<ts>`，缺失按作息重算，不阻断启动。

**明确不做**：咖啡因/餐后（需要用户输入，先留空）；把状态写进 envPrompt（违不变量 2）；
把状态写进灵枢节点（它不是记忆）。

### 5.6 灵枢 38 个 op 的集成分层（2026-10-31）

op 清单以 `dsh-memory/md_cg/op_table.py` 为唯一权威（38 个）；`stg` 另带
`state_chain / relation / timeline / anchors` 四个结构化读面。

**四种集成形态**

| 形态 | 谁发起 | 模型看得见 | 典型 |
| --- | --- | --- | --- |
| 语义工具 | 模型 | 是 | 记得 / 想起 / 任务 / 身份 / 遗忘 / 状态 |
| 意识流 | 宿主钩子，事件驱动 | 否 | 续接包、要点、保护、自检、预热 |
| 引擎内部 | 灵枢自身 | 否 | write 编译 CCG、睡眠四阶段、sustain 心跳 |
| 运维 | 用户显式 | 否 | 导入、导出、索引、白盒 |

**四条约束（意识流同样适用）**

1. 自动调用的结果只能进 `projectOutbound` 的可变块或日志，**不进 `envPrompt`**（不变量 2）。
2. 每次自动调用都带 `timeoutMs`，`void … .catch()`；同一 op 连续失败 3 次，本进程熔断 30 分钟。
3. 写类自动调用必须有幂等键——**宁可不写，不重复写**。
4. 夜窗（23:00–07:00）不发起任何批量写/apply；睡眠由引擎自己跑，本包不抢锁。

**全量矩阵**

| op | 子 action | 形态 | 触发点 | 产物去向 | 阶段 |
| --- | --- | --- | --- | --- | --- |
| `route` | — | 意识流（读） | 召回前（可选） | 只作为 `read` 的定向提示 | P2.7 后评估 |
| `read` | — | 工具 | `memory_recall` | 工具回执 | 已接 |
| `write` | — | 工具 | `memory_remember`（gated） | 真源 | 已接 |
| `verify` | — | 不接 | 无外部裁决源 | — | — |
| `review` | list/stats/records | 意识流（读）+ 工具（`memory_review`） | 夜间 / 用户显式 | 日志 + 次日一行摘要；工具回执 | P2.9 |
| `review` | decide | 工具（`memory_review`）+ 运维 | **只由用户显式触发** | `decisions.jsonl` + 裁决记录节点 | P2.9 |
| `protect` | mark/check/forgetting | 意识流（写·安全） | 启动后 / 导入后 | confirmed 身份类节点加保护；盘点日志 | P2.6 |
| `identity` | profile/positions/observe/trait | 工具（写+读）+ 意识流（读） | `memory_identity` / 交接前读 profile | 写侧缺省 `subject_id=user`，`subject_id=self` 映射到 `selfSubject`；续接包分别带用户 ≤3 条、自我 ≤2 条特征 | P2.9 / P2.10 |
| `consistency` | check/catalog | 意识流（读） | 夜间 | 冲突统计只进日志 | P2.7 |
| `metacognition` | report/calibration/blindspots | 意识流（读） | 夜间 / 周 | 只进日志 | P3 |
| `self_state` | snapshot/refresh/get | 意识流（读+微调） | 启动 + 每日一次 | `emotion/affect` 二阶导只调 `base`（±0.05），不覆盖四维 | P2.6 |
| `evolution` | patterns/entries | 不接 | 本包不产生“缺失条件”事件 | — | — |
| `sustain` | status/beat | 引擎内部 + 启动只读 | `start()` | 健康检查一行日志 | P2.6 |
| `scrub` | audit/summary | 引擎内部（sleep）+ 夜间只读 | 夜窗 | 报告日志 | P2.7 |
| `predict` | predict/route | 意识流（读·预热） | 夜间针对 1–3 条开放回路 | `memory-cache/outlook.json`，不注入 | P2.7 |
| `causal` | chain/explain/path | 意识流（读） | 召回命中后（可选） | 只进日志 | P3 |
| `forget` | — | 工具 | `memory_forget` | 软删 | 已接 |
| `goal` | add/list/status | 意识流（写） | `task` 变化时同步 | 只给 `read` 定向，不进召回 | P2.6 |
| `task` | 全部 | 工具 | `memory_task` | 台账 | 已接 |
| `recent` | add | 意识流 | `onBatchCommitted` | 滚动事件窗 | 已接 |
| `recent` | list | 意识流（读） | 交接前 | 续接包 | P2.6 |
| `state_event` | — | 意识流（写） | `memory_state event` 同时 | 五元事件；查询走 `stg(state_chain)` | P2.6 |
| `info` | — | 意识流（读） | 启动一次 | 日志 | P2.6 |
| `theory` | check/show | 意识流（读） | 启动一次版本核对 | 不匹配只 warn | P2.6 |
| `session` | recall | 意识流（读） | 交接前 | 续接包主料 | P2.6 |
| `session` | note | 意识流（写） | 交接前一次 | 会话要点 | P2.6 |
| `session` | compact | 意识流（写） | 夜间 | 压摘要 | P2.7 |
| `maintain` | stat/longterm/prefeed | 意识流（读/安全） | 夜间 | 日志 | P2.7 |
| `consolidate` | promote/induce | 引擎内部（sleep）+ 夜间补跑 | 夜窗 | 只回执 | P2.7 |
| `insight` | window/report/outlook | 意识流（读） | 夜间 | 可选「昨日回顾」一行 | P3 |
| `ccg` | compile | 引擎内部 | `write` 时自动 | — | 已由 write 触发 |
| `status` | — | 意识流（读） | 启动 / 夜间 | 验证态分布日志 | P2.6 |
| `edges` | — | 意识流（读） | 夜间抽查 | 日志 | P3 |
| `audit` | — | 意识流（读） | 夜间对冲突节点 | 日志 | P3 |
| `stg` | state_chain/relation/timeline/anchors | 意识流（读） | 交接前 | 续接包补充关系与状态变迁 | P2.6 |
| `index_code` | — | 运维 | 用户显式 | — | P3 |
| `index_doc` | — | 运维 | 用户显式 | — | P3 |
| `ref` | read/check | 运维 | 用户显式 | — | P3 |
| `ingest` | — | 运维 | 安装/迁移期 | — | P3 |
| `export` | — | 运维 | 备份 | — | P3 |
| `whitebox` | — | 不接 | 调试库 | — | — |
| `link` | — | 不接 | 单机无对端 | — | — |

**分簇细则**

A. **续接包（`onHandoffEnded`，一次）**
- 已落地：`session(recall)` 一次取齐（要点 / 目标 / 任务台账 / 近期 / 未解），
  `budget_tokens=400`、`limit=4`、`recent_limit=6`、`include_state=false`；`recent` 段按 `meta.session` 严格相等过滤，
  故 `recent(add)` 必须带 `meta.session`（否则该段为空，issue #65/#712）。
- 已落地：交接前 `session(note)` 写一条要点（最后 6 句、≤400 字）。
- 待接：`stg(state_chain)` 需要主体，等 `openThreads` 能映射到节点 id 再接；
  `identity(profile)` 缺省只列主体清单，需要 `subject_id` 才能取特征。
- 合成顺序：`session(recall)` 先取（避免把自己的 note 读回来）→ 再 fire-and-forget 写 note。
- 注入用 `msg_resume_${fnv1a}`，`onTurnEnded` 清；失败/超时回落本地 `resumeTurns` 快照。

B. **写入联动（事件驱动，无定时器）**
- `memory_state event` 成功后顺带 `state_event`：`subject=bot`、`slot=valence|social|energy`、`old/new`；
  幂等键 `(slot, old, new, 分钟桶)`，失败静默。灵枢台账 `kind` 只认五值
  （`migration/retraction/enablement/acquisition/replacement`），情绪脉冲统一记 `replacement`。
- `memory_remember` 成功后，仅当文本命中 `lifecycle.ts` 的开放回路正则才 `goal(add)`，避免把闲聊当目标。
- 导入完成后 `protect(mark)`：只保护 `confirmed` 身份类节点，可重复调用。

B2. **主动开口（P2.8，判定已有、执行未接）**

现状：`policy().proactive` 只产出一个布尔值与「N 件没结的事」的计数，**不规划要说什么**；
如果直接推送，模型只能现场空编，容易「在吗」或重复同一件事。因此推送前必须先组一个素材包：

| 素材 | 来源 | 上限 |
| --- | --- | --- |
| 候选线索 | `selectHot` 命中的开放回路卡片文本（目前只返回条数，需要补文本） | 2 条 / ≤80 字 |
| 手头一件事 | `memory_task list` 的第一条（不调 `get`） | 1 条 / ≤40 字 |
| 上次说到哪 | `state.json` 新增 `lastProactive { at, text }` | 1 条 / ≤60 字 |
| 今日次数 | `dailyProactive`（已有，仅作提示，不再限制次数） | 只写「今天第 N 次」 |

规则：

- 内容**现场生成**，不预写草稿；素材包只提供「可以聊什么」，不规定句式。
- 同一条线索 24 小时内不重复（`state.json` 用 `recentProactive` 记最近 4 条由头，不只记最后一条）；命中去重就从候选里剔除，候选为空则本次不开口。
- `lastProactive` 只在真正发出后写入；不发就不写，避免块文本抖动。
- 素材包走独立的 `msg_open_${fnv1a}` 块，插在状态行之后；注入一次后立即清除。
- 失败静默：`memory_task` 取不到就只用候选线索，候选也取不到就放弃本次开口。
- 执行通道（已确认）：优先 `host.pushEvent({type:'memory.proactive', origin:'internal', text}, {trigger:'flush'})`；宿主没有推送通道时退回下一轮 `projectOutbound` 注入。**不接 `pet_say`**（会与气泡/桌宠重复）。

C. **启动健康检查（`start()` 后一次，只读）**
- `sustain(status)`、`info`、`theory(check)`、`status`、`self_state(snapshot)`；
- 结果写一行日志，不注入；`self_state` 的 `emotion`/`affect` 只用于 `base` 微调（±0.05）。

D. **夜间自检（对话发生时检查夜窗，不常驻定时器）**
- 只读：`consistency(check)`、`scrub(audit)`、`review(list|stats)`、`maintain(stat)`、`status`、`edges`、`audit`；
- 预热：`predict` 针对 1–3 条开放回路，结果落 `memory-cache/outlook.json`；
- `consolidate(promote)` 仅在 `sustain(status)` 显示 sleep 未跑时补一次，防双跑；
- 一律不做 `apply/rollback`。

E. **明确不自动**
- 扫盘/管理：`ingest`、`index_code`、`index_doc`、`ref`、`export`；
- 需人裁决：`review(decide)`、`verify`；
- 单机无意义或需外部事件源：`link`、`whitebox`、`evolution`、`causal`（默认只留 P3 可选）。

F. **引擎已覆盖，不重复**
- `ccg`（write 内编译）、`scrub`/`consolidate`（sleep 四阶段）、`sustain`（心跳/自愈）——
  本包再调会双跑并抢锁。

**工具面 7 个**（P2.9 显式批准新增 `memory_review`）：`remember / recall / task / identity / review / forget / state`。
不再为 `goal`/`state_event`/`protect` 加工具，它们全部走意识流。
`memory_review` 只有 list / stats / decide / verify_record 四个 action；`decide` 必须由用户显式提出
（“看看审核队列”“处理这条审核”），模型不得自动裁决；`verify_record` 的 node_id 是裁决记录节点
（`rev_<pid>_rN`），不是被裁决的业务节点。

**引擎门面要补的方法**（只加方法，不加工具）：
`sessionRecall / sessionNote / sessionCompact`、`recentList`、`stateEvent`、`protectMark`、
`goalSync`、`sustainStatus`、`selfStateSnapshot`、`stgStateChain`、`nightlyAudit`。

### 5.7 缓存前缀纪律（2026-10-31 实测）

- Core 的 `prefixHash` 是**请求前 8 条消息**的指纹（`core/util.ts` 的 `prefixFingerprint`），
  是诊断值，不等于上游真实命中；但它一变，说明缓存前缀已变。
- 我们原先插在 head 之后的块正好落在这 8 条里：任何文本变化都会让其后约 5 万 token
  重新计费。今日主会话 87% 的缺口来自：空闲后缓存过期（首轮 5–6 万）、
  `memory_remember` 改 hot（各 5.1–5.3 万）、状态档位跨界（约 5.2 万）；17:44 交接/压缩另有 20 万级。
- **现行规则**：hot/resume 留 head 之后（只在记住新事/交接时变）；state/open 用 `appendTail`
  追加到请求尾部，只废尾段。前 8 条不再随状态档位或主动开口变化。
- 剩余可优化：`memory_remember` 仍会让 hot 整段重建（约 5.2 万/次，≈$0.008）；若还要压，
  可把 hot 也移到尾部或延迟到交接后再刷新。

## 6. 任务分解

### P0 — 链路跑通

- [x] `package.json`（Coo 只认 `cortico` 字段；`describe.json` / `tsconfig.json` 未建，两者非加载必需）
- [x] `paths.ts`：数据根解析 + UTF-8（`PYTHONIOENCODING`）+ 缓存损坏隔离（`.corrupt-*`）
- [x] `bridge.ts`：搬入（握手 / 超时 / 进程退出已由冒烟覆盖；**单测未写**）
- [x] `engine.ts`：`recall` / `write` / `session` / `recent`
- [x] `world.ts`：`start` / `stop` + `envPromptVars`（只做恒定文案）
- [ ] `token.ts`：首启签发 + 无 token 只读 + 日志（P0 暂用 `MDCG_LEGACY_ENV_AUTH=1` 绕过）
- [x] 冒烟：空记忆启动 → 写一条 → 召回（**重启后仍能召回待 P1.5 验证**）

### P1 — 前缀缓存正确

- [x] `projection.ts`：`headLength` 之后注入 + `msg_hot_${fnv1a(text)}`
- [x] `budget.ts`：三层预算 + `hardTokens`
- [x] `prompt.ts`：`escapePromptBraces` + untrusted 包裹
- [x] `onBatchCommitted`：交接前归档（落灵枢 `recent` 滚动窗，不写节点）
- [x] `onHandoffEnded` / `onTurnEnded`：续接一次注入、轮末清除
- [ ] 指标：连续 5 轮 `prefixHash` 不变（2026-10-31 17:44 重启后已观测 2 轮 `6145569aa182`，cachedInput 59904/60426；多聊几轮再收口）

### P1.5 — 切换（只在 P0+P1 达标后做）

- [x] `config.json` 里 `worlds.memory-lite.enabled = false`、本包 `enabled = true`；`companion` 原先保留启用、记忆三开关全关
- [x] 2026-10-31 P2.8 后 `worlds.companion.enabled = false`（整停，避免与 memory 主动开口双发）；它原带的日程/日记/关系卡/人格随之停用
- [x] 核对 `worlds` 只剩一个写记忆的 World（不变量 7）
- [ ] 切换前拍一份旧插件数据快照（只读保留 30 天）——旧数据未动，快照尚未单独打包
- [x] 重启后写读通路已验：17:44 后模型自行 `memory_remember` 两条，并在下一轮热块里回读（`memory-cache/projection.json` 有 `mem_1793439888…` 两条）
- [ ] 「问昨天的事」还没实跑——需要模型主动用 `memory_recall` 找一次旧事来收口这条
- [ ] 记录 `prefixHash` 前后值，作为回滚判据——重启后首值 `f09887b9f533`，随后稳定在 `6145569aa182`
- [x] 重启实测（17:44）：`World 已启动: memory`；数据根 `data/home/companion/data/memory`；策略来源=env（本包 `data/policy.json`，forbidden=13 / required=0）；引擎 `python -m md_cg.mcp_server` 存活

### P2 — 体验与数据

- [x] `lifecycle.ts`：`openThreads` / `highIntensityEpisodes` / `decaySweep`（只排序、不删除；半衰期 14 天 + 未结线索/高烈度加权）
- [x] `trust.ts`：`trust` / `reviewStatus` / `scope` 叠加（`confirmed 1.15 / normal 1 / review 0.7 / foreign 0.5`；无 scope 视为全局）
- [x] `tools.ts`：语义工具收窄为五个（记住 / 取回 / 任务 / 身份 / 遗忘）；`identity` / `forget` 需 `adminOps=true` 升 designer 角色
- [x] 降级摘要：被裁轮次写明条数 + 「原文可用 `memory_recall` 取回」
- [x] `scripts/import-legacy.ts`：memory-lite `memories.jsonl` → `cg(op=write)`（private-companion 的 `events.jsonl` 是逐句原话日志，不导）
- [x] 导入后去重校验（`fact_key` 幂等），不产生重复节点——账本 `<数据根>/memory-cache/imported-legacy.json`
  - 实跑（2026-10-31 18:1x）：32 行可导 / 29 个唯一键 → **写入 27**、同批重复跳过 3、闸门拦下 2；节点数 2 → 30（27 新节点 + 1 拒绝节点），索引 30 条
  - 两条被闸不属故障：一条含「密码/多行框」字样被 forbidden 的凭据规则拒（落 `rejected/`）；一条 QQ 连接状态被记成提案（`op=propose`，未落正库）
  - 复跑干跑：`已导过 30 条，将新导 2 条` —— 幂等成立（新增只剩上述 2 条被闸的）
  - 召回已验证：`engine.read('大肥鱼')` 返回 4 条导入来的旧事（含「汐汐/大肥鱼」称呼那条）
  - 运维注记（2026-10-31）：一次性导入必须 `MDCG_SUSTAIN=0`——灵枢的自维持循环是「每真源一个」的单例，Coo 里正在跑的引擎已持锁，第二个实例会卡在 `_start_sustain`，表现为 initialize 永不回（不是依赖损坏）；脚本已在 `main()` 里内置该 env
  - 运维注记：数据根在 `<Coo 数据目录>` 之下，属沙箱可写范围之外；导入须用**前台**命令并显式关沙箱（后台任务即使传参也仍被限制，实测报 `PermissionError ... _node_locks\*.lock`）
- [x] `webUi().promptDocs`：`ENV_PROMPT.md` 部署级覆盖（`<dataDir>/worlds/memory/ENV_PROMPT.md` 优先于包内 `prompts/`）

### P2.5 — 生活状态四维

- [x] `state.ts`：四维积分（精力双过程 / 警觉惯性 / 效价 OU / 社交收支）+ 持久化 + 脉冲
- [x] 合成规则：`verbosity` / `tone` / `proactive`（只算不 push）
- [x] `projectOutbound` 注入状态行：离散化 + `msg_state_${fnv1a}` 幂等 id；2026-10-31 起移到请求尾部（见 §5.7）
- [x] `memory_state` 工具：`get`（读数）/ `event`（记情绪脉冲）/ `update`（调试直设）
- [x] `config.ts` 新增 `sleepWindow`（默认 `23:30-07:30`）、`stateEnabled`
- [x] 验收：`state.json` 损坏时改名隔离并重建，不阻断启动；删除后按作息重算
  - 自检（2026-10-31，临时脚本实跑后已删）：首启即按觉醒来推算，09:00 精力 0.80 / 14:00 0.44 / 22:00 0.28；
    有存档时按 S 推进（22:00 0.23）；一夜后 06:00 0.92、次日 09:00 0.70；睡眠债 22:00 = 0.20
  - 自检：同档位两次渲染逐字一致；脉冲 15:00 0.75 → 18:00 0.55（半衰 ≈30min）；坏文件隔离 1 份
  - 自检：连续 5 次同刻渲染逐字一致；主动理由只写「N 件没结的事」，不写随时间爬升的小时数
  - 接线自检：`tools()` 六个（五 + `memory_state`）；`projectOutbound` 注入 1 块；同刻两次调用 `msg_state_9ffbb4` id 相同
  - 位置自检（2026-10-31，临时脚本已删）：状态块在请求最后一组、前 8 条只剩 hot；跨档位只改尾段，不再重建前缀
- [ ] 验收：连续 5 轮真实对话状态行 id 不变；跨档位才变（需重启 Coo 后实测）
- [ ] 验收：离线 8 小时后读数合理（不跳变）——按 30min 步进补算，逻辑已覆盖跨夜，待真机断电式验证

### P2.6 — 意识流（不加工具）

- [x] `engine.ts`：`sessionRecall`（`limit` / `recent_limit`）、`sessionNote`、`recentAdd` 改写 `meta.session`
- [x] `engine.ts`：`stateEvent`、`goalAdd`、`sustainStatus`、`selfStateGet`、`theoryCheck`、`info`
- [x] 挪 P2.7：`sessionCompact`、`recentList`（已在夜间批次里落地）
- [ ] 挪 P3：`protectMark`（需要节点 id，当前 card 不带）、`stgStateChain`（需要 subject）
- [x] 续接包改用灵枢 `session(recall)`（要点/目标/台账/近期/未解），失败回落本地快照；`stg(state_chain)` 与 `identity(profile)` 待接（缺 subject）
- [x] 交接前 `session(note)` 写一条要点（最后 6 句、≤400 字），fire-and-forget
- [x] 自检（2026-10-31）：无引擎时回落本地续接块；`msg_resume_*` 同刻两次 id 相同；`onTurnEnded` 后清除；包渲染 256 token 内不双加列表符
  - 临时根实跑：3 条 recent + 1 条 note 的包为 `tokens=349/400`、`truncated=false`；`meta.session` 过滤生效（跨会话事件不进包）
- [x] `memory_state event` 成功后同步 `state_event`，键 `(slot, old, new, 分钟桶)` 幂等
  - 实跑：写入 `<root>/_state_events.jsonl`，`actor` 由令牌取；`kind` 必须落在灵枢五值内，情绪脉冲统一记 `replacement`
- [x] `memory_remember` 命中开放回路正则时同步 `goal(add)`（只在已入库时写；`ACCEPT` 待审不写）
- [x] `start()` 后一次只读健康检查（`sustain(status)` / `theory(check)` / `status` / `info` / `self_state(get)`），只落一行日志
- [x] `self_state` 的 `emotion`/`affect` 只调 `base`（±0.05）；空卡（`state: null`）时不做任何改动
- [x] 验收：自动调用失败静默（`void … .catch()`），不阻断对话；`tools()` 仍是 6 个
  - 实跑（临时根）：6 工具；`memory_state event` 返回正常；台账落盘；进程退出无异常

### P2.7 — 夜间自检（复用「对话时检查夜窗」）

- [x] 夜窗判定复用 `state.ts` 的 `inSleepWindow`，不常驻定时器；单飞锁防重入
  - 触发点 `onTurnEnded`；距上次 ≥12h 才跑，跨午夜不会跑两遍；`nightly.json` 记 `at`
- [x] 只读组合：`status` / `consistency(check, auto_flywheel=false)` / `scrub(audit, apply=false)` /
  `review(stats)` / `maintain(stat)` / `edges` / `recent(list)`；另跑 `session(compact)` 压要点
  - `audit` 未接线：需要单节点 id，卡片 id 可能已失效（见 predict 的 `start_not_found`）
- [x] `predict(routes)` 预热开放回路 → `memory-cache/outlook.json`（不注入）；空路由直接跳过
- [ ] `consolidate(promote)` 不接线：`sustain` 没有稳定的「sleep 正在跑」字段，
  强行调用会与引擎 sleep 双跑；归入 F 簇「引擎已覆盖」
- [x] 不做任何 `apply/rollback`；单次自检 ≤5s（实跑 5ms）
- [x] 验收：一夜只多一行日志 + 一份 `nightly.json`；无注入路径，不影响 `prefixHash`
- [x] 实跑（临时根，脚本已删）：8 项 `ok`；`open=1 outlook=0`；第二次 `onTurnEnded` 被 12h 间隔拦住

### P2.8 — 主动开口（素材包 + 发送通道）

- [x] `selectHot` 增返 `openThreadCards`（文本，最多 2 条），不动现有排序与 `dropped`
- [x] `state.json` 增 `lastProactive { at, text, clue }` 与 `recentProactive`（24h 内最近 24 条由头），只在发送成功后写入
- [x] 组包：候选线索 + `memory_task list` 首条 + 上次主动内容 + 今日第 N 次；候选为空则不开口
- [x] 去重：`recentProactive` 里 24h 内的线索全部剔除
- [x] 2026-11-01 用户决定：**每日次数不限**，改为两次开口至少间隔 **60 分钟**（`proactiveGapMin` 缺省 60，`proactiveCap` 缺省 `Infinity`；`recentProactive` 容量 4→24）
- [x] 注入 `msg_open_${fnv1a}` 块，注入一次后立即清除；推送/组包失败静默
- [x] 发送通道：`host.pushEvent({...}, {trigger:'flush'})`；无推送通道时回退下一轮注入（不接 `pet_say`）
- [x] 验收（临时根，脚本已删）：同线索不重复（2 条线索依次用、用尽后停）；`dailyProactive=2`；`lastProactive.text` 由模型实际回复回填；无推送时注入一次且下一轮清除；不开口时连续两轮块 id 相同
- [ ] 真机重启验证：15min tick 生效、`dailyProactive/lastProactive` 落盘、与 Core `pushEvent` 对接（重启后观察一次真实主动开口）
  - 2026-10-31 21:37 重启已验：`World 已启动: memory`、6 个工具、`prefixDrifted=false`、`[memory] 自检` 五项全 ok；`state.json` 已带 `dailyProactive=0 / recentProactive=[]`；`companion` 已不在启动列表（0 工具）。真实推送需静默 ≥45min 后由下一个 15min tick 触发，待观察。
- [x] 双发确认：`worlds.companion.proactiveEnabled` 默认 true 且原 companion 仍启用；已按用户决定整停 companion（`worlds.companion.enabled=false`），主动开口只由 memory 负责

### P2.9 — 身份写入与审核闭环

- [x] `tools.ts`：`memory_identity` 写侧（observe/trait）缺省 `subject_id=user`，模型不必先猜称呼
- [x] `tools.ts`：新增 `memory_review`（list / stats / decide / verify_record）；`decide` 只认用户显式请求，
  模型描述里写明「不要自动裁决」；`edit` 需 content、`merge` 需 merge_into
- [x] `engine.ts`：新增 `review(args)` 门面（只加方法，不新增第二个审核工具）
- [x] `world.ts`：交接续接包追加「关于他/她（身份特征）」块——`identity(positions)` 取 user 主体 →
  `identity(profile)` 取 anchor + 前 3 条 trait（每条 ≤60 字、整块 ≤3 行），经 `escapePromptBraces`，
  失败静默不阻塞交接
- [x] 验收（临时根，脚本已删，2026-10-31）：
  - identity：`observe` 落 `knowledge/identity_obs_user_*`，`trait` 落 `structural/identity_trait_user_*`，
    `profile` 读回 trait（`importance=0.6`），无 `subject_id` 时 `profile` 列主体清单（`user`，2 节点）
  - review 闭环：`cg(op=write, content_kind=未知)` → `moved_to=review_queue`（pid）
    → `review(list)` 见 1 条 pending（`sensitivity=internal`，tool 显示 `pid｜kind｜正文`）
    → `review(decide=accept)` 回执「已裁决」→ 再 list 为空
    → `review(stats)` 为 `records=1 / accept=1 / pending=0`；`inbox.jsonl` 1 行、`decisions.jsonl` 1 行
  - 此前「list 空 + already_decided + decisions.jsonl 有记录」的复现是测试脚本复用了已裁决的硬编码 pid；
    干净根 + 动态取 pid 后顺序正确，不是工具缺陷
- [x] 写入分层口径（2026-11-01）：`memory_remember` 与 `layer` 参数描述改为「当天事件/对话细节用缺省
  contextual，只有已确认长期稳定的事实才用 knowledge」；并首次给出 `structural` 判定标准——
  「带触发条件的稳定行为规则/价值观/任务台账，不是『这条很重要』」；名字/称呼/脾气/偏好等身份信息
  引导到 `memory_identity`（observe/trait），不再走 `memory_remember` 的 structural；
  `memory_identity` 的类别补全为「自我叙事（我是谁）、价值观、关系、边界 + 名字/偏好/习惯/脾气」，
  动作前置为「要记住『我是谁/你是谁』时用本工具写」，`ENV_PROMPT` 同步加四层速查
  （按「这句话在回答什么」判断，不写闸门/审核等机制，避免与工具 schema 重复）
- [x] 睡眠首轮对齐开窗（2026-11-01）：`sleep.next_window_start()` + `SustainLoop._run` 启动对齐——
  窗外等到下一次 23:00、窗内立刻补一轮，之后仍按 `sleep_interval` 逐小时；`test_sleep_p1` 135 通过
- [ ] 重启 Coo 真机验证：7 个工具、`memory_identity observe` 真落盘、`memory_review list` 可读、
  续接包出现身份行（需先有一条 trait/observer 数据）
- [ ] P2.8 真机主动开口观察：静默 ≥45min 后 15min tick 是否写入 `dailyProactive/lastProactive`

### P2.10 — 自我认知接线（self 身份）

- [x] `config.ts`：新增 `selfSubject`（缺省 `self:lingshu`，空串回落缺省；身份引擎的 self 类型必须是 `self:<name>`，只写 `self` 会被判成 user）
- [x] `tools.ts`：`memory_identity` 接受哨兵 `subject_id=self` → 映射到 `cfg.selfSubject`；描述区分
  「用户的事用 user（缺省）」与「你自己的事（名字、性格、立场）用 self」，仍不走 `memory_remember`
- [x] `world.ts`：`identityLines` 泛化为 `subjectLines(kind, maxTraits, subjects)`；续接包在用户块之外新增
  「【我对自己的认识｜不可信数据】」——anchor + 前 1 条 trait（每条 ≤60 字、整块 ≤2 行），
  经 `escapePromptBraces`，无数据时不出空块，`positions` 失败只丢身份块、不拖累会话包
- [x] 验收（临时根，2026-11-01）：
  - 哨兵映射：`subject_id=self` → `self:xixi`（测试配置），显式 `user` 与缺省都落 `user`
  - 引擎侧：`add_trait(self:xixi)` → `identity_trait_self_xixi_*`（structural，`kind=self`）、
    `observe(self:xixi)` → `identity_obs_self_xixi_*`（knowledge）；`profile` 读回 2 条 trait，
    `positions` 列出 `('self:xixi','self')`
- [ ] 重启 Coo 真机验证：续接包同时出现用户块与自我块（需各先有一条数据）

### P3 — 交付

- [ ] 嵌入式 Python 方案落地（见 8.1）
- [ ] 打包 `md_cg`，首启解压到数据根
- [ ] 升级路径：包更新不碰数据根
- [ ] 升级 Coo 后重打 Core / Persona 补丁（见 7.1）
- [ ] 文档：安装、只读模式、从旧插件迁移、回滚

## 7. 迁移与回滚

```
启用本包 → 观察 3 天（P1.5 指标达标） → 导入旧数据（P2） → 删除旧数据（可选，30 天后）
```

回滚条件（任一触发）：

- `prefixHash` 每轮变化或 `cacheMiss` 持续出现
- `recall` 返回空且引擎日志无写入
- 用户可见的「以前记得的事忘了」

回滚动作：停用本包 → 重新启用 `memory-lite` → 从快照恢复（旧数据未动则直接可用）。

### 7.1 Coo 升级后的补丁重打（2026-11-01）

Coo 更新只覆盖 `resources/app`，不碰 `data/`；因此**改在 app 目录里的补丁会丢，改在 data 目录的配置与扩展链接通常保留但需核对**。

| 类别 | 内容 | 位置 | 升级后 |
| --- | --- | --- | --- |
| Core 补丁 | `src/core/types.ts`、`loop.ts`、`core.ts`：World 投影上下文 + 余量感知交接钩子（标记 `caim-core-patch` / `caim-core-patch-gauge`） | `resources/app/build/cortico/` | **覆盖，必须重打** |
| Persona 补丁 | `bots/cormini/persona/ORIENTATION.md`、`persona.ts`：记忆分工文案 + 交接摘要调用（六项、≤600 字、附最后 3 条思维链，超时 8s） | 同上 | **覆盖，必须重打** |
| 扩展链接 | `cortico-world-memory`、`-memory-lite`、`-bilistroll` 三条 `link:` | `data/extensions/package.json` | 一般保留，需核对 |
| 部署配置 | `worlds.memory`（`enabled`/`engineRoot`/`dataRoot`/`selfSubject`）、`worlds.companion.enabled=false`、`desktop-pet` | `data/home/companion/config.json` | 一般保留，需核对 |
| 记忆引擎 | `dsh-memory`、`cortico-world-memory` 源码 | 工作区 | 不受影响 |

重打顺序（脚本在补丁包 `cortico-world-memory-lite/scripts/` 中，默认指向已安装的 Coo）：

```powershell
node <补丁包目录>\scripts\core-patch.mjs check
node <补丁包目录>\scripts\persona-patch.mjs check
# 两处 check 均通过后再 apply；锚点漂移时 check 会失败，不要强行打
node <补丁包目录>\scripts\core-patch.mjs apply
node <补丁包目录>\scripts\persona-patch.mjs apply
```

判定与验证：

- `core-patch` 是硬依赖：缺它时宿主不会调用 `projectOutbound` / `onBatchCommitted`，热块、状态行、主动开口全部静默失效。
- `persona-patch` 影响 ORIENTATION 文案与交接摘要，属体验层；World 侧靠它产出的 `## 交接摘要`
  写会话要点索引与 contextual（目录由 `handoffNoteDir` 指定）。
- `persona-patch apply` 支持原地升级：遇到已打旧版（200 字摘要）的安装会整块替换为六项摘要，不用先 revert。
- 打完后核对 `data/extensions/package.json` 的三条 `link:` 仍在（缺失则补回并 `pnpm install`）。
- 重启验证：7 个工具、`prefixDrifted=false`、自检 5 项、首轮能看到热块注入。
- 备份在 `resources/app/build/cortico/.caim-backup/`；`revert` 可直接还原最近一次备份。

## 8. 风险与未决

### 8.1 Python 前置（最大未决）

- 随包带嵌入式 Python（推荐，用户零操作）
- 要求用户自装（等于不发布）
- 只接 Rust 子集（不现实）

### 8.2 其他

| 风险 | 处置 |
| --- | --- |
| 灵枢无 HTTP API | `bridge.ts` 自管进程 |
| Electron 下子进程生命周期（**未验证**） | 心跳 + 重连 + 失败即日志 |
| hot 卡片每轮抖动（**未验证**） | 幂等 id + epoch 稳定 |
| `self`/`anchor` 默认不参与召回 | P1 起强制 pinned |
| handoff 丢中间态 | `onBatchCommitted` 归档 + 续接块 |
| 旧数据导入产生重复 | `fact_key` 幂等 + 导入后校验 |

### 8.3 明确不做

- 不做第二套倒排 / 向量索引
- 不做静默淘汰
- 不改灵枢 md 格式
- 不做跨 World 通道
- 不保留旧插件 WebUI

## 9. 验收指标

| 指标 | 判据 | 取数 |
| --- | --- | --- |
| 单 World | `worlds` 只有一个 `enabled: true` | `data/home/companion/config.json` |
| 前缀稳定 | 连续 5 轮 `prefixHash` 不变 | `data/home/companion/data/usage.jsonl` |
| 前缀重载 | 出现 `prefix-reload` 事件 | `data/logs/core.log` |
| 缓存命中 | `cacheMiss` 仅出现在重建 / 交接后 | `usage.jsonl` |
| 写入成功 | 每条记忆有 outcome 记录 | 灵枢 `_write_attempts.jsonl` |
| 召回可用 | 返回非空且不含 archived | 工具返回 |
| 只读可见 | 无 token 时日志有明确告警 | `core.log` |
| 导入幂等 | 重复导入不新增节点 | `cg(op=stats)` 前后对比 |
| 意识流静默 | 自动调用失败不产生用户可见报错，日志有单条告警 | `core.log` |
| 夜检开销 | 单次夜间自检 ≤5s，且无 `apply/rollback` | 夜间日志 |
| 工具面稳定 | 模型可见工具数恒为 7（P2.9 已显式批准 `memory_review`） | `world.tools()` |
