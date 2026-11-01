/**
 * 部署配置段 worlds.memory 的形状、默认值与深合并。
 * 默认 enabled=false：没在部署配置里打开时不会运行。
 */

export interface MemorySection {
  enabled: boolean;
  /** Python 解释器；空串 = 按平台解析（Windows python / 其它 python3）。 */
  python: string;
  /** 灵枢 md_cg 所在目录（作为 cwd 与 PYTHONPATH）；空串 = packageDir/engine。 */
  engineRoot: string;
  /** 传给 python 的参数。 */
  engineArgs: string[];
  /** 数据根：相对 dataDir 的子目录名。 */
  dataRoot: string;
  /** 前缀常驻段预算。 */
  pinnedTokens: number;
  /** 每轮注入段预算。 */
  hotTokens: number;
  /** 按需召回段预算。 */
  recalledTokens: number;
  /** 单次 MCP 调用超时（毫秒）。 */
  timeoutMs: number;
  /** 生活状态注入开关（清单 §5.5）；关掉后状态不推进、不注入、不挂工具。 */
  stateEnabled: boolean;
  /** 作息窗口（本地时间，支持跨午夜）；空串 = 没有固定睡眠。 */
  sleepWindow: string;
  /**
   * 自我认知主体 id。身份引擎的 self 类型必须是 `self:<name>`；只写 `self`
   * 会被 split_subject 判成 user。`memory_identity` 的 `subject_id=self` 哨兵映射到这里。
   */
  selfSubject: string;
  /** 交接笔记目录（相对 dataDir）。空串 = 不把交接摘要写进记忆。 */
  handoffNoteDir: string;
  /** P0 临时：用环境变量鉴权绕过令牌签发。P2 换成 token.ts 后应关闭。 */
  legacyEnvAuth: boolean;
  /**
   * legacy 身份下是否授予 designer 角色。identity / forget 两个 op 不在 recorder
   * 白名单里，关掉后对应工具会返回 AccessDenied（属正常闸门，不是故障）。
   */
  adminOps: boolean;
}

export function memoryDefaults(): MemorySection {
  return {
    enabled: false,
    python: '',
    engineRoot: '',
    engineArgs: ['-m', 'md_cg.mcp_server'],
    dataRoot: 'memory',
    pinnedTokens: 160,
    hotTokens: 256,
    recalledTokens: 480,
    timeoutMs: 60_000,
    stateEnabled: true,
    sleepWindow: '23:30-07:30',
    selfSubject: 'self:lingshu',
    handoffNoteDir: 'home/companion/workspace/handoffs',
    legacyEnvAuth: true,
    adminOps: true,
  };
}

/** 部署配置可能是半截的，这里补齐，避免读 undefined。 */
export function normalize(raw: Partial<MemorySection> | undefined): MemorySection {
  const base = memoryDefaults();
  if (!raw) return base;
  const merged: MemorySection = { ...base, ...raw };
  if (merged.dataRoot.trim() === '') merged.dataRoot = base.dataRoot;
  if (!Array.isArray(merged.engineArgs) || merged.engineArgs.length === 0) {
    merged.engineArgs = base.engineArgs;
  }
  if (merged.pinnedTokens <= 0) merged.pinnedTokens = base.pinnedTokens;
  if (merged.hotTokens <= 0) merged.hotTokens = base.hotTokens;
  if (merged.recalledTokens <= 0) merged.recalledTokens = base.recalledTokens;
  if (merged.timeoutMs <= 0) merged.timeoutMs = base.timeoutMs;
  if (typeof merged.adminOps !== 'boolean') merged.adminOps = base.adminOps;
  if (typeof merged.stateEnabled !== 'boolean') merged.stateEnabled = base.stateEnabled;
  if (typeof merged.sleepWindow !== 'string') merged.sleepWindow = base.sleepWindow;
  if (typeof merged.selfSubject !== 'string' || merged.selfSubject.trim() === '') {
    merged.selfSubject = base.selfSubject;
  }
  if (typeof merged.handoffNoteDir !== 'string') merged.handoffNoteDir = base.handoffNoteDir;
  return merged;
}
