/**
 * 引擎门面：把灵枢的 38 个 op 收窄成 World 需要的少数几个调用。
 * 所有写入都走灵枢的 cg(op=write)，本模块不落任何记忆文件。
 */
import { LingshuBridge } from './bridge.ts';
import { defaultPython } from './python-path.ts';
import type { MemorySection } from './config.ts';
import type { MemoryPaths } from './paths.ts';

export interface EngineOptions {
  cfg: MemorySection;
  paths: MemoryPaths;
}

/** 一次 cg 调用的结果：能解析成 JSON 就给对象，否则给原文。 */
export interface CallOutcome {
  data: unknown;
  text: string;
  isError: boolean;
}

export class Engine {
  private readonly bridge: LingshuBridge;

    constructor(opts: EngineOptions) {
    const { cfg, paths } = opts;
    const python = cfg.python.trim() || defaultPython();
    const env: Record<string, string> = {
      MDCG_ROOT: paths.root,
      MDCG_AUX_ROOT: paths.aux,
      MDCG_MCP_SURFACE: 'core',
      MDCG_POLICY_FILE: paths.policy,
      PYTHONPATH: paths.engineRoot,
      PYTHONIOENCODING: 'utf-8',
    };
    if (cfg.legacyEnvAuth) {
      env.MDCG_LEGACY_ENV_AUTH = '1';
      // identity / forget 落在 designer 白名单里；legacy 身份要两个开关才升角色。
      if (cfg.adminOps) {
        env.MDCG_CAN_ADMIN = '1';
        env.MDCG_LEGACY_ENV_ADMIN = '1';
      }
    }
    this.bridge = new LingshuBridge({
      python,
      args: cfg.engineArgs,
      env,
      cwd: paths.engineRoot,
      timeoutMs: cfg.timeoutMs,
      maxRetryDelayMs: 30_000,
    });
  }

  start(): void {
    this.bridge.start();
  }

  stop(): void {
    this.bridge.dispose();
  }

  isReady(): boolean {
    return this.bridge.isReady();
  }

  waitReady(): Promise<boolean> {
    return this.bridge.waitReady();
  }

  /** 调一个 cg op；失败抛错，由调用方决定降级方式。 */
  async call(op: string, args: Record<string, unknown> = {}): Promise<CallOutcome> {
    const result = await this.bridge.callTool('cg', { op, ...args });
    const text = (result.content ?? [])
      .map((part) => (typeof part.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('\n')
      .trim();
    if (result.isError) throw new Error(text || `灵枢 ${op} 失败`);
    let data: unknown = text;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        // 原文即可：灵枢部分 op 返回人类可读文本。
      }
    }
    return { data, text, isError: false };
  }

  /** 库统计：层数、节点数、写入策略。 */
  async status(): Promise<CallOutcome> {
    return this.call('status');
  }

  /** 写入一条记忆；gated=true 时走主动遗忘闸门三问。 */
  async write(content: string, extra: Record<string, unknown> = {}): Promise<CallOutcome> {
    return this.call('write', { content, gated: true, ...extra });
  }

  /** 按线索召回。 */
  async read(query: string, extra: Record<string, unknown> = {}): Promise<CallOutcome> {
    return this.call('read', { query, ...extra });
  }

  /** 跨会话续接包：要点 / 目标 / 任务台账 / 近期 / 未解。 */
  async sessionRecall(
    session: string,
    budgetTokens: number,
    noteLimit = 4,
    recentLimit = 6,
  ): Promise<CallOutcome> {
    return this.call('session', {
      action: 'recall',
      session,
      budget_tokens: budgetTokens,
      limit: noteLimit,
      recent_limit: recentLimit,
      // 自我状态卡由 state.ts 自己维护，不重复装进续接包。
      include_state: false,
    });
  }

  /** 把一段文本记成会话要点。 */
  async sessionNote(session: string, text: string): Promise<CallOutcome> {
    return this.call('session', { action: 'note', session, text });
  }

  /**
   * 追加一条滚动事件（灵枢「近期事件」七件套之一），供续接读取。
   * `session` 必须写进 meta：session_recall 的 recent 段按 `meta.session` 严格相等过滤。
   */
  async recentAdd(
    role: 'user' | 'assistant',
    text: string,
    session: string,
    window = 200,
  ): Promise<CallOutcome> {
    return this.call('recent', {
      action: 'add',
      role,
      text,
      window,
      meta: { session },
    });
  }

  /** 结构层任务台账（跨会话的未完成事项）。 */
  async task(args: Record<string, unknown>): Promise<CallOutcome> {
    return this.call('task', args);
  }

  /** 身份特征与画像。 */
  async identity(args: Record<string, unknown>): Promise<CallOutcome> {
    return this.call('identity', args);
  }

  /** 软删除（可 restore）；受保护节点需显式 override。 */
  async forget(nodeId: string, reason: string, override = false): Promise<CallOutcome> {
    return this.call('forget', { node_id: nodeId, reason, override });
  }

  /** 审核队列：list / stats / decide / verify_record 等，由调用方限定 action。 */
  async review(args: Record<string, unknown>): Promise<CallOutcome> {
    return this.call('review', args);
  }

  /* ---- 意识流（宿主自动调用，不给模型开工具） ---- */

  /** 启动体检：身份 + 健康 + 审核体系自描述。 */
  async info(): Promise<CallOutcome> {
    return this.call('info');
  }

  /** 理论版本核对（只读）。 */
  async theoryCheck(): Promise<CallOutcome> {
    return this.call('theory', { action: 'check' });
  }

  /** 自维持循环状态（只读，用于判断睡眠是否已由引擎自行运行）。 */
  async sustainStatus(): Promise<CallOutcome> {
    return this.call('sustain', { action: 'status' });
  }

  /** 自我状态卡（只读；emotion/affect 只用于微调四维基线）。 */
  async selfStateGet(): Promise<CallOutcome> {
    return this.call('self_state', { action: 'get' });
  }

  /** 状态事件记账：subject + slot + old/new + kind；查询走 stg(op=state_chain)。 */
  async stateEvent(
    subject: string,
    slot: string,
    oldValue: string,
    newValue: string,
    kind: string,
  ): Promise<CallOutcome> {
    return this.call('state_event', {
      subject,
      slot,
      old: oldValue,
      new: newValue,
      kind,
    });
  }

  /** 目标槽：只给 read 定向，不进召回。 */
  async goalAdd(goal: string, goalStatus = 'active'): Promise<CallOutcome> {
    return this.call('goal', { action: 'add', goal, goal_status: goalStatus });
  }

  /* ---- 夜间只读自检（P2.7） ---- */

  /** 冲突检测；关掉自动飞轮，保证只读。 */
  async consistencyCheck(): Promise<CallOutcome> {
    return this.call('consistency', { action: 'check', auto_flywheel: false });
  }

  /** 抽查审计；apply=false，绝不去污染。 */
  async scrubAudit(): Promise<CallOutcome> {
    return this.call('scrub', { action: 'audit', apply: false });
  }

  /** 审核队列计数。 */
  async reviewStats(): Promise<CallOutcome> {
    return this.call('review', { action: 'stats' });
  }

  /** 维护统计（只读）。 */
  async maintainStat(): Promise<CallOutcome> {
    return this.call('maintain', { action: 'stat' });
  }

  /** 层级边统计（只读；不带 node 时是全局摘要）。 */
  async edges(): Promise<CallOutcome> {
    return this.call('edges');
  }

  /** 单节点证据审计视图。 */
  async audit(nodeId: string, cap = 20): Promise<CallOutcome> {
    return this.call('audit', { node_id: nodeId, cap });
  }

  /** 沿边的局部预测（候选未来，不是断言）。 */
  async predictRoutes(startId: string, horizon = 7): Promise<CallOutcome> {
    return this.call('predict', { action: 'routes', start_id: startId, horizon });
  }

  /** 会话压摘要（不写 note，只压缩既有要点）。 */
  async sessionCompact(session: string, budgetTokens = 400): Promise<CallOutcome> {
    return this.call('session', { action: 'compact', session, budget_tokens: budgetTokens });
  }

  /** 近期事件窗（只读，用于夜间活动量统计）。 */
  async recentList(limit = 8): Promise<CallOutcome> {
    return this.call('recent', { action: 'list', limit });
  }
}
