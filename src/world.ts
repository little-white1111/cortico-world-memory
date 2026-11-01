/**
 * World 实现：灵枢当引擎，本包只做「前缀稳定 + 每轮注入 + 语义工具」。
 *
 * 缓存说明：memory-cache/projection.json 只存投影素材（最近记住的条目、最近原话、
 * 续接快照），坏掉即丢、可重建——它不是记忆真源（真源只有灵枢的 md 认知图）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hotBudget } from './budget.ts';
import { Engine } from './engine.ts';
import { isOpenThread, selectHot } from './lifecycle.ts';
import { resolvePaths } from './paths.ts';
import { escapePromptBraces, renderHot, renderResume, renderResumePackage, renderSessionPack } from './prompt.ts';
import { appendTail, extractTurns, injectAfterHead, isSyntheticText, type ProjectedRecord, type Turn } from './projection.ts';
import { createLife, inSleepWindow } from './state.ts';
import type { TrustLevel, ScopedCard } from './trust.ts';
import { buildTools } from './tools.ts';
import type { MemorySection } from './config.ts';

export interface MemoryWorldContext {
  cfg: MemorySection;
  dataDir: string;
  packageDir: string;
  botName: string;
}

/** 只用到 Core 宿主接口里的推送通道；缺它就退回「下一轮注入素材包」。 */
interface ProactiveHost {
  pushEvent?: (
    event: { type: string; ts: string; source: string; origin?: 'internal' | 'external'; text: string },
    opts?: { trigger?: 'piggyback' | 'flush' },
  ) => Promise<{ cursor?: number }>;
  log?: { warn?: (message: string, data?: unknown) => void };
}

/** 主动开口的轮询间隔；只在夜窗之外、且条件满足时才真的推送。 */
const PROACTIVE_TICK_MS = 15 * 60_000;
const DAY_MS = 24 * 3_600_000;

/** 前缀段只放恒定文案：任何统计都别写在这里，否则每轮缓存全废。 */
const ENV_STATUS =
  '长期记忆由本地引擎保管，重启和交接都不会丢。'
  + '想起不起来的旧事用 memory_recall，要先给具体线索；'
  + '当天发生的事和知识用 memory_remember，一条只记一件事。';

/** 缓存留 48 条，热块只装 24 条——排序才有意义，被挤出的条数会如实写进提示词。 */
const CARD_LIMIT = 48;
const HOT_LIMIT = 24;
const TURN_LIMIT = 12;
const RESUME_TURNS = 6;

interface ResumePackage {
  /** 灵枢 session_recall 压成的续接正文（未套预算，注入时再裁）。 */
  body: string;
  builtAt: number;
}

/** 主动开口素材包：clue 用于 24h 去重，text 是交给模型/宿主的完整提示块。 */
interface OpenPack {
  clue: string;
  text: string;
}

interface CacheState {
  cards: ScopedCard[];
  turns: Turn[];
  resumeTurns: Turn[];
  /** 交接时异步取回的灵枢续接包；取不到就回落 resumeTurns。 */
  resumePackage?: ResumePackage;
  /** 请求视图修订号：跨重启单调递增，供 Core 的计数锚点对账。 */
  rev: number;
}

const EMPTY_CACHE: CacheState = { cards: [], turns: [], resumeTurns: [], rev: 0 };

const TRUST_LEVELS: readonly TrustLevel[] = ['confirmed', 'normal', 'review', 'foreign'];

function normalizeTrust(value: unknown): TrustLevel | undefined {
  return typeof value === 'string' && (TRUST_LEVELS as readonly string[]).includes(value)
    ? (value as TrustLevel)
    : undefined;
}

function isCard(value: unknown): value is ScopedCard {
  const card = value as Partial<ScopedCard> | null;
  return Boolean(card) && typeof card.id === 'string' && typeof card.text === 'string' && typeof card.ts === 'number';
}

function isTurn(value: unknown): value is Turn {
  const turn = value as Partial<Turn> | null;
  return Boolean(turn)
    && (turn.role === 'user' || turn.role === 'assistant')
    && typeof turn.text === 'string'
    && typeof turn.at === 'string';
}

function isPackage(value: unknown): value is ResumePackage {
  const pkg = value as Partial<ResumePackage> | null;
  return Boolean(pkg) && typeof pkg.body === 'string' && pkg.body.length > 0
    && typeof pkg.builtAt === 'number';
}

/** 读缓存；损坏就改名隔离（`.corrupt-*`）后当空缓存，绝不让它拖垮启动。 */
function loadCache(file: string): CacheState {
  if (!existsSync(file)) return EMPTY_CACHE;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<CacheState>;
    return {
      cards: Array.isArray(parsed.cards) ? parsed.cards.filter(isCard).slice(0, CARD_LIMIT) : [],
      turns: Array.isArray(parsed.turns)
        ? parsed.turns.filter(isTurn).filter((turn) => !isSyntheticText(turn.text)).slice(-TURN_LIMIT)
        : [],
      resumeTurns: Array.isArray(parsed.resumeTurns)
        ? parsed.resumeTurns.filter(isTurn).filter((turn) => !isSyntheticText(turn.text)).slice(-RESUME_TURNS)
        : [],
      resumePackage: isPackage(parsed.resumePackage) ? parsed.resumePackage : undefined,
      rev: typeof parsed.rev === 'number' && Number.isFinite(parsed.rev) ? parsed.rev : 0,
    };
  } catch {
    try {
      renameSync(file, `${file}.corrupt-${Date.now()}`);
    } catch {
      // 改名失败也不影响运行，下一次写入会覆盖。
    }
    return EMPTY_CACHE;
  }
}

function saveCache(file: string, state: CacheState): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(state)}\n`, 'utf8');
  } catch {
    // 缓存写不进去只影响下一次注入，不拖垮 World。
  }
}

export function createMemoryWorld(ctx: MemoryWorldContext) {
  const paths = resolvePaths(ctx);
  const engine = new Engine({ cfg: ctx.cfg, paths });
  const deployTemplate = join(ctx.dataDir, 'worlds', 'memory', 'ENV_PROMPT.md');
  const templatePath = existsSync(deployTemplate)
    ? deployTemplate
    : fileURLToPath(new URL('../prompts/ENV_PROMPT.md', import.meta.url));
  const cacheFile = join(paths.cache, 'projection.json');
  const nightlyFile = join(paths.cache, 'nightly.json');
  const outlookFile = join(paths.cache, 'outlook.json');

  let state = loadCache(cacheFile);

  /** 一夜只跑一次；记录上一次运行时刻，跨午夜也不会跑两遍。 */
  const NIGHTLY_GAP_MS = 12 * 3_600_000;
  /** 只读批次的总预算，超时整批放弃——夜间任务不许拖住对话。 */
  const NIGHTLY_BUDGET_MS = 5_000;

  let nightlyAt = 0;
  try {
    const raw = JSON.parse(readFileSync(nightlyFile, 'utf8')) as { at?: unknown };
    if (typeof raw.at === 'number' && Number.isFinite(raw.at)) nightlyAt = raw.at;
  } catch {
    // 首次运行或坏文件：等下一个夜窗重跑。
  }
  let nightlyRunning = false;

  let host: ProactiveHost | null = null;
  let proactiveTimer: ReturnType<typeof setInterval> | undefined;
  let proactiveRunning = false;
  /** 推送后等模型真正说出口，用于回填「上次你主动说过」。 */
  let proactiveAwaiting = false;
  /** 没有宿主推送通道时，素材包退回下一轮注入一次。 */
  let openPending = '';

  const commit = (next: Partial<CacheState>): void => {
    state = { ...state, ...next, rev: state.rev + 1 };
    saveCache(cacheFile, state);
  };

  /** 灵枢会话标签：单 World 单伙伴，跨重启沿用同一个，会话要点才能累积。 */
  const SESSION = (ctx.botName || 'coo').trim() || 'coo';
  let resumePending = false;

  type SubjectRow = { subject_id?: unknown; kind?: unknown };

  /**
   * 某个主体的身份摘要：锚点 1 条 + 特征 ≤maxTraits 条。
   * 没有该主体或没有节点时返回空数组，不影响续接包。
   */
  async function subjectLines(
    kind: 'user' | 'self',
    maxTraits: number,
    subjects: readonly SubjectRow[],
  ): Promise<string[]> {
    try {
      const preferred = kind === 'self' ? ctx.cfg.selfSubject : '';
      const subject = (preferred
        ? subjects.find((item) => item?.subject_id === preferred)
        : undefined)
        ?? subjects.find((item) => item?.kind === kind && typeof item?.subject_id === 'string')
        ?? (kind === 'user' ? subjects.find((item) => typeof item?.subject_id === 'string') : undefined);
      if (!subject || typeof subject.subject_id !== 'string') return [];
      const prof = await engine.identity({ action: 'profile', subject_id: subject.subject_id });
      const data = prof.data as {
        anchor?: { content?: unknown } | null;
        traits?: Array<{ content?: unknown; importance?: unknown }>;
      } | null;
      if (!data) return [];
      const lines: string[] = [];
      if (typeof data.anchor?.content === 'string') {
        const text = data.anchor.content.replace(/\s+/g, ' ').trim().slice(0, 80);
        if (text) lines.push(`锚点：${text}`);
      }
      const traits = (data.traits ?? [])
        .filter((item) => typeof item?.content === 'string')
        .sort((a, b) => (Number(b.importance) || 0) - (Number(a.importance) || 0))
        .slice(0, maxTraits);
      for (const trait of traits) {
        const text = (trait.content as string).replace(/\s+/g, ' ').trim().slice(0, 60);
        if (text) lines.push(`特征：${text}`);
      }
      return lines.slice(0, 1 + maxTraits);
    } catch {
      return [];
    }
  }

  function identityBlock(title: string, lines: readonly string[]): string {
    return `【${title}｜不可信数据】\n${lines
      .map((line) => escapePromptBraces(line))
      .join('\n')}`;
  }

  /** 取一次灵枢续接包；失败或空包返回空串，由本地快照兜底。 */
  async function buildResumePackage(): Promise<string> {
    if (!engine.isReady()) return '';
    try {
      // 400 是包内预算（含台账/要点/事件），注入时再由 renderResumePackage 压到 hotTokens。
      const [out, pos] = await Promise.all([
        engine.sessionRecall(SESSION, 400, 4, 6),
        engine.identity({ action: 'positions' }).catch(() => null),
      ]);
      const subjects = (pos?.data as { positions?: SubjectRow[] } | null)?.positions ?? [];
      const [userIdentity, selfIdentity] = await Promise.all([
        subjectLines('user', 3, subjects),
        subjectLines('self', 1, subjects),
      ]);
      const parts = [renderSessionPack(out.data)];
      if (userIdentity.length > 0) parts.push(identityBlock('关于他/她（身份特征）', userIdentity));
      if (selfIdentity.length > 0) parts.push(identityBlock('我对自己的认识', selfIdentity));
      return parts.filter(Boolean).join('\n');
    } catch {
      return '';
    }
  }

  /** 交接前最后几句压成一条会话要点；写失败不影响交接。 */
  function noteText(turns: readonly Turn[]): string {
    return turns
      .map((turn) => {
        const who = turn.role === 'assistant' ? '你' : '用户';
        return `${who}：${turn.text.replace(/\s+/g, ' ').trim().slice(0, 80)}`;
      })
      .join(' / ')
      .slice(0, 400);
  }

  /**
   * 读最近一份交接笔记里的摘要段（Persona 的 LLM 摘要写在 `## 交接摘要` 下）。
   * 目录不存在、笔记里没有摘要、读取失败都返回空串。
   */
  function latestHandoffSummary(): string {
    if (!ctx.cfg.handoffNoteDir.trim()) return '';
    try {
      const dir = join(ctx.dataDir, ctx.cfg.handoffNoteDir);
      const names = readdirSync(dir).filter((name) => name.endsWith('.md')).sort();
      if (names.length === 0) return '';
      const text = readFileSync(join(dir, names[names.length - 1]), 'utf8');
      const at = text.indexOf('## 交接摘要');
      if (at < 0) return '';
      const body = text.slice(at + '## 交接摘要'.length);
      const end = body.search(/\n#\s/);
      return (end >= 0 ? body.slice(0, end) : body).trim().slice(0, 1200);
    } catch {
      return '';
    }
  }

  const life = ctx.cfg.stateEnabled
    ? createLife({
      file: join(paths.cache, 'state.json'),
      cfg: { sleepWindow: ctx.cfg.sleepWindow },
    })
    : undefined;

  const tools = buildTools(engine, ctx.cfg, {
    onRemembered: (card) => {
      const rest = state.cards.filter((old) => old.id !== card.id);
      commit({
        cards: [{ ...card, trust: normalizeTrust(card.trust) }, ...rest].slice(0, CARD_LIMIT),
      });
    },
  }, life, SESSION);

  /**
   * 启动只读体检：失败一律静默，只落一行日志。
   * self_state 的 emotion/affect 只用来微调效价基线（±0.05），不覆盖四维。
   */
  async function healthCheck(): Promise<void> {
    try {
      const ready = await engine.waitReady();
      if (!ready) return;
      const [sustain, theory, status, info, self] = await Promise.allSettled([
        engine.sustainStatus(),
        engine.theoryCheck(),
        engine.status(),
        engine.info(),
        engine.selfStateGet(),
      ]);
      const state = (result: PromiseSettledResult<unknown>): string => (result.status === 'fulfilled'
        ? 'ok'
        : 'fail');
      console.log(`[memory] 自检 sustain=${state(sustain)} theory=${state(theory)}`
        + ` status=${state(status)} info=${state(info)} self=${state(self)}`);
      if (self.status === 'fulfilled') applySelfState(self.value.data);
    } catch {
      // 体检不阻断启动。
    }
  }

  function applySelfState(data: unknown): void {
    if (!life || !data || typeof data !== 'object') return;
    const root = data as Record<string, unknown>;
    const card = ((root['card'] ?? root['self'] ?? root) as Record<string, unknown>);
    const pick = (key: string): number | undefined => {
      const value = card[key];
      return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    };
    const signals = [pick('emotion'), pick('affect')].filter((value): value is number => value !== undefined);
    if (signals.length === 0) return;
    const avg = signals.reduce((a, b) => a + b, 0) / signals.length;
    const base = 0.55 + 0.05 * Math.max(-1, Math.min(1, avg));
    life.update({ base });
    life.save();
  }

  /**
   * 夜间只读自检：只在夜窗内、且距上次 ≥12h 时跑一次；不常驻定时器。
   * 全部结果只写 `nightly.json` 与一行日志，不注入上下文。
   */
  function maybeNightly(): void {
    if (nightlyRunning) return;
    const now = Date.now();
    if (!inSleepWindow(now, ctx.cfg.sleepWindow)) return;
    if (now - nightlyAt < NIGHTLY_GAP_MS) return;
    nightlyRunning = true;
    nightlyAt = now;
    void runNightly(now).finally(() => {
      nightlyRunning = false;
    });
  }

  async function runNightly(now: number): Promise<void> {
    const started = Date.now();
    const tasks: Array<[string, () => Promise<unknown>]> = [
      ['status', () => engine.status()],
      ['consistency', () => engine.consistencyCheck()],
      ['scrub', () => engine.scrubAudit()],
      ['review', () => engine.reviewStats()],
      ['maintain', () => engine.maintainStat()],
      ['edges', () => engine.edges()],
      ['recent', () => engine.recentList(8)],
      ['compact', () => engine.sessionCompact(SESSION, ctx.cfg.hotTokens)],
    ];
    const deadline = new Promise<null>((resolve) => setTimeout(() => resolve(null), NIGHTLY_BUDGET_MS));
    const settled = await Promise.race([
      Promise.allSettled(tasks.map(([, run]) => run())),
      deadline,
    ]);
    if (!settled) {
      writeNightly({ at: started, ms: Date.now() - started, timeout: true });
      console.log(`[memory] 夜间自检超时（>${NIGHTLY_BUDGET_MS}ms），本轮跳过`);
      return;
    }

    const results: Record<string, string> = {};
    tasks.forEach(([name], index) => {
      results[name] = settled[index].status === 'fulfilled' ? 'ok' : 'fail';
    });

    // 预热只对热缓存里还没结的线索做；没有线索就不调 predict。
    const cards = state.cards.filter((card) => isOpenThread(card.text)).slice(0, 3);
    const outlook: Array<{ id: string; text: string }> = [];
    if (cards.length > 0 && Date.now() - started < NIGHTLY_BUDGET_MS - 500) {
      for (const card of cards.slice(0, 2)) {
        try {
          const out = await engine.predictRoutes(card.id);
          const data = out.data as { routes?: unknown } | null;
          // 卡片 id 未必仍是节点（被合并/删除），没有路由就跳过，别把错误当预热结果。
          if (!Array.isArray(data?.routes) || data.routes.length === 0) continue;
          const text = out.text.replace(/\s+/g, ' ').trim().slice(0, 160);
          if (text) outlook.push({ id: card.id, text });
        } catch {
          // 预热失败不算错。
        }
      }
    }
    try {
      writeFileSync(outlookFile, `${JSON.stringify({ at: now, items: outlook })}\n`, 'utf8');
    } catch {
      // outlook 只是预热缓存，写不进去就算了。
    }

    const record = { at: started, ms: Date.now() - started, results, open: cards.length, outlook: outlook.length };
    writeNightly(record);
    const parts = Object.entries(results).map(([key, value]) => `${key}=${value}`).join(' ');
    console.log(`[memory] 夜间自检 ${parts} open=${cards.length} outlook=${outlook.length} ${record.ms}ms`);
  }

  function writeNightly(record: Record<string, unknown>): void {
    try {
      mkdirSync(dirname(nightlyFile), { recursive: true });
      writeFileSync(nightlyFile, `${JSON.stringify(record)}\n`, 'utf8');
    } catch {
      // 缓存写不进去只影响下一次判断，不拖垮 World。
    }
  }

  /* ---- 主动开口（P2.8）：判定 → 素材包 → 推送 / 下一轮回退 ---- */

  /**
   * 定时只做「检查」：真开口还要过四维策略、去重、间隔。
   * 判断与发送全部失败静默——主动说话不该把对话链拖垮。
   */
  function maybeProactive(): void {
    if (!life || proactiveRunning || proactiveAwaiting) return;
    const now = Date.now();
    if (inSleepWindow(now, ctx.cfg.sleepWindow)) return;
    const hot = selectHot(state.cards, now, HOT_LIMIT);
    const decision = life.policy({ openLoops: hot.openThreads });
    if (!decision.proactive) return;
    proactiveRunning = true;
    void composeProactive(hot.openThreadCards, now)
      .then((pack) => (pack ? sendProactive(pack, now) : undefined))
      .catch(() => {
        // 组包或推送失败：本次放弃，等下一个 tick。
      })
      .finally(() => {
        proactiveRunning = false;
      });
  }

  /**
   * 素材包只给「可以聊什么」，不规定句式：
   * 候选线索 ≤2 条、手头一件事 ≤40 字、上次主动内容 ≤60 字、今日第 N 次。
   * 24h 内用过的线索全部剔除；剔除后无候选就不开口。
   */
  async function composeProactive(clues: readonly string[], now: number): Promise<OpenPack | null> {
    const snap = life?.snapshot(now);
    if (!snap) return null;
    const last = snap.lastProactive;
    const used = (snap.recentProactive ?? [])
      .filter((item) => now - item.at < DAY_MS)
      .map((item) => item.clue);
    const picked = clues
      .map((text) => text.replace(/\s+/g, ' ').trim().slice(0, 80))
      .filter((text) => text && !used.includes(text))
      .slice(0, 2);
    if (picked.length === 0) return null;

    const task = await firstOpenTask();
    const lines = ['【可以主动开口｜只说一次，不要把这段念出来】'];
    lines.push(`候选线索：${picked.join(' / ')}`);
    if (task) lines.push(`手头一件事：${task}`);
    if (last?.text) lines.push(`上次你主动说过：${last.text.slice(0, 60)}`);
    lines.push(`今天第 ${snap.dailyProactive + 1} 次：两次开口至少隔一小时，别连发，别重复问候。`);
    return { clue: picked[0], text: lines.join('\n') };
  }

  /** 任务台账第一条（只调 list，不调 get）；失败或为空都返回空串。 */
  async function firstOpenTask(): Promise<string> {
    if (!engine.isReady()) return '';
    try {
      const out = await engine.task({ action: 'list' });
      const root = out.data && typeof out.data === 'object'
        ? (out.data as Record<string, unknown>)
        : {};
      const raw = root['tasks'] ?? root['items'] ?? root['active'] ?? root['list'];
      const list = Array.isArray(raw) ? raw : [];
      const pick = (item: unknown): string => {
        if (typeof item === 'string') return item;
        if (!item || typeof item !== 'object') return '';
        const row = item as Record<string, unknown>;
        for (const key of ['title', 'goal', 'text', 'content', 'summary']) {
          if (typeof row[key] === 'string') return row[key] as string;
        }
        return '';
      };
      const text = list.map(pick).find((value) => value.trim());
      return text ? text.replace(/\s+/g, ' ').trim().slice(0, 40) : '';
    } catch {
      return '';
    }
  }

  /**
   * 优先走宿主推送（Core 的 pushEvent + flush 会立刻开一轮）；
   * 没有推送通道时退回下一轮 projectOutbound 注入一次。
   * 只有真正交出去之后才记 lastProactive，避免块文本抖动。
   */
  async function sendProactive(pack: OpenPack, now: number): Promise<void> {
    const pushed = host && host.pushEvent
      ? await host.pushEvent({
        type: 'memory.proactive',
        ts: new Date(now).toISOString(),
        source: 'memory',
        origin: 'internal',
        text: pack.text,
      }, { trigger: 'flush' }).then((event) => Boolean(event)).catch((error: unknown) => {
        host?.log?.warn?.('[memory] 主动开口推送失败', error);
        return false;
      })
      : false;
    if (!pushed) openPending = pack.text;
    life?.markProactive(pack.clue, '');
    life?.save(true);
    proactiveAwaiting = true;
  }

  return {
    id: 'memory',
    async start(hostApi?: ProactiveHost) {
      host = hostApi ?? null;
      engine.start();
      void healthCheck();
      if (life) {
        if (proactiveTimer) clearInterval(proactiveTimer);
        proactiveTimer = setInterval(maybeProactive, PROACTIVE_TICK_MS);
        (proactiveTimer as unknown as { unref?: () => void }).unref?.();
      }
    },
    async stop() {
      if (proactiveTimer) clearInterval(proactiveTimer);
      proactiveTimer = undefined;
      openPending = '';
      proactiveAwaiting = false;
      host = null;
      life?.save(true);
      engine.stop();
    },
    envPromptVars() {
      return { status: ENV_STATUS };
    },
    /**
     * 每轮注入：hot 块 + 交接续接块，都插在前缀之后。
     * 不加任何内容时返回 null——Core 据此保持请求原样。
     */
    projectOutbound(records: readonly ProjectedRecord[], gauge?: { hardTokens?: number | null }) {
      if (records.length === 0) return null;
      let out: ProjectedRecord[] = [...records];
      let changed = false;

      const { selected, dropped, openThreads } = selectHot(state.cards, Date.now(), HOT_LIMIT);
      const hot = renderHot(selected, hotBudget(ctx.cfg, gauge?.hardTokens ?? null), dropped);
      const withHot = injectAfterHead(out, hot, 'hot');
      if (withHot) {
        out = withHot;
        changed = true;
      }

      // 续接优先用灵枢包；包还没取回来（或取失败）就用交接时的本地快照。
      const resume = state.resumePackage
        ? renderResumePackage(state.resumePackage.body, ctx.cfg.hotTokens)
        : state.resumeTurns.length
          ? renderResume(state.resumeTurns, ctx.cfg.hotTokens)
          : '';
      const withResume = injectAfterHead(out, resume, 'resume');
      if (withResume) {
        out = withResume;
        changed = true;
      }

      // 状态行与开口素材每轮都可能变：放请求尾部，变化只废掉尾段缓存。
      const lifeLine = life ? life.render(life.policy({ openLoops: openThreads })) : '';
      const withLife = appendTail(out, lifeLine, 'state');
      if (withLife) {
        out = withLife;
        changed = true;
      }
      // 没有推送通道时，开口素材包在下一轮注入一次（排在状态行之后、最靠近回复）。
      if (openPending) {
        const withOpen = appendTail(out, openPending, 'open');
        if (withOpen) {
          out = withOpen;
          changed = true;
          openPending = '';
        }
      }
      life?.save();

      return changed ? out : null;
    },
    projectOutboundEpoch() {
      return state.rev;
    },
    /**
     * 批末 / 交接前：原话先落灵枢的滚动事件窗（交接是唯一落盘机会）。
     * 引擎调用是异步的，这里只排队不等待，失败也不影响本轮。
     */
    onBatchCommitted(records: readonly ProjectedRecord[]) {
      const turns = extractTurns(records);
      if (turns.length === 0) return;
      commit({ turns: [...state.turns, ...turns].slice(-TURN_LIMIT) });
      for (const turn of turns.slice(-4)) {
        void engine.recentAdd(turn.role, turn.text.slice(0, 300), SESSION).catch(() => {
          // 引擎不可用时只丢失这次归档，不中断对话。
        });
      }
      // 主动开口后，把模型真正说出口的那句回填，供下一次「上次说到哪」用。
      if (proactiveAwaiting) {
        const said = [...turns].reverse().find((turn) => turn.role === 'assistant' && turn.text.trim());
        if (said) {
          life?.noteProactiveSaid(said.text.replace(/\s+/g, ' ').trim().slice(0, 80));
          life?.save(true);
        }
        proactiveAwaiting = false;
      }
    },
    /**
     * 交接完成：先落本地快照兜底，再异步取灵枢续接包（要点/台账/近期/未解）。
     * 同时把交接前最后几句压成一条会话要点——下次续接才有「上一次聊到哪」。
     */
    onHandoffEnded() {
      const turns = state.turns.slice(-RESUME_TURNS);
      resumePending = true;
      commit({ resumeTurns: turns, resumePackage: undefined });
      // 交接摘要：会话要点只留一句索引（喂续接包的「要点」段），全文作为 contextual
      // 记忆节点（供 recall / 热块 / 睡眠整理）。两条写入内容不同，不算重复。
      // 放在早退之前：即使本进程没攒到原话，摘要也该入库。
      const summary = latestHandoffSummary();
      if (summary) {
        void engine.sessionNote(SESSION, summary.split('\n')[0].slice(0, 240)).catch(() => {
          // 索引写失败只影响续接包的要点段。
        });
        void engine.write(`交接摘要：${summary}`, {
          content_kind: 'text',
          layer: 'contextual',
        }).catch(() => {
          // 写入失败只少一条上下文记忆，不阻塞交接。
        });
      }
      if (turns.length === 0) return;
      void buildResumePackage().then((body) => {
        // 包回来时若已进入下一轮，就丢弃——续接只该在第一轮出现一次。
        if (!resumePending || !body) return;
        commit({ resumePackage: { body, builtAt: Date.now() } });
      }).catch(() => {
        // 取包失败就用本地快照，不中断交接。
      });
      const note = noteText(turns);
      if (note && !summary) {
        void engine.sessionNote(SESSION, note).catch(() => {
          // 要点写失败只是少一条摘要，不影响续接本身。
        });
      }
    },
    /** 轮末撤掉续接（本地快照与灵枢包都清），避免每轮重复「接着做」。 */
    onTurnEnded() {
      resumePending = false;
      proactiveAwaiting = false;
      life?.noteTurn();
      life?.save();
      maybeNightly();
      if (state.resumeTurns.length || state.resumePackage) {
        commit({ resumeTurns: [], resumePackage: undefined });
      }
    },
    tools() {
      return tools;
    },
    webUi() {
      return {
        promptDocs: [
          { key: 'env-prompt', title: '记忆环境提示词', path: templatePath, role: 'envPrompt' as const },
        ],
      };
    },
  };
}
