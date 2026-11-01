/**
 * 生活状态四维（清单 §5.5）：精力 / 警觉 / 情绪效价 / 社交意愿。
 *
 * 三条纪律：
 * - 只影响「怎么说」与「要不要开口」，不影响「记得什么」；不进 system 前缀、不进灵枢。
 * - 读取时按真实时间补算（O(1) 步进，不做常驻 tick），离线八小时也不会跳变。
 * - 渲染离散化：同一档位文本逐字不变，块 id 才稳定（前缀缓存才不会被微变废掉）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const MIN = 60_000;
const HOUR = 60 * MIN;

/** 可校准常量（来源见清单 §5.5；论文参数与自定参数在此集中）。 */
const TAU_WAKE_H = 18.2;
const TAU_SLEEP_H = 4.2;
const NEED_SLEEP_H = 8;
/** S 的参考区间（Borbély 双过程里 S 在 0.2–0.7 之间摆动，不是 0–1）。 */
const S_MIN = 0.2;
const S_MAX = 0.7;
const PRESSURE_CURVE = 0.85;
const ENERGY_BASE = 0.98;
const ENERGY_WEIGHT = 0.72;
const DEBT_WEIGHT = 0.28;
const DIP_DEPTH = 0.1;
const DIP_CENTER_H = 6.5;
const DIP_WIDTH = 2.88;
const INERTIA_DEPTH = 0.4;
const INERTIA_MIN = 15;
/** 警觉缩放：精力日常在 0.3–0.7，乘 1.1 后白天的「清醒」才不必贴着阈值抖动。 */
const ALERT_GAIN = 1.1;
const VALENCE_TAU_H = 3;
const PULSE_TAU_MIN = 30;
const SOCIAL_RECOVER_PER_H = 0.1;
const SOCIAL_OPEN_BONUS = 0.1;
const SOCIAL_TURN_COST = 0.01;
const EFFORT_PER_TURN = 0.003;
const EFFORT_TAU_H = 1;
const STEP_MS = 30 * MIN;
const MAX_STEPS = 31 * 24 * 2;
const DEFAULT_WINDOW = '23:30-07:30';
const SAVE_GAP_MS = 5 * MIN;

export interface LifeConfig {
  /** 作息窗口（本地时间，支持跨午夜）；空串 = 没有固定睡眠。 */
  sleepWindow: string;
}

export interface LifePulse {
  at: number;
  amp: number;
}

export interface LifeState {
  /** 上次结算时刻（毫秒）。 */
  ts: number;
  /** 双过程模型里的睡眠压力 S（0 睡饱，1 很困）。 */
  s: number;
  /** 睡眠债（0–1）。 */
  debt: number;
  /** 这次醒来后累积的对话消耗（0–1，睡眠时衰减）。 */
  effort: number;
  /** 情绪回归值（不含脉冲；脉冲在读取时叠加）。 */
  valence: number;
  /** 情绪基线。 */
  base: number;
  /** 社交意愿（0–1）。 */
  social: number;
  /** 本次醒来的时刻；0 表示尚未观测到一次完整睡眠。 */
  wakeAt: number;
  /** 最近一次用户互动。 */
  lastActiveAt: number;
  /** 未过期的情绪脉冲。 */
  pulses: LifePulse[];
  /** 记数用的本地日期键（YYYY-MM-DD）。 */
  dailyKey: string;
  /** 当日已主动开口次数。 */
  dailyProactive: number;
  /** 上一次主动开口：由头（用于 24h 去重）、实际说出的话（用于「上次说到哪」）。 */
  lastProactive?: { at: number; text: string; clue: string };
  /** 24h 内用过的由头（最多留 4 条），保证一天多次开口也不重复同一线索。 */
  recentProactive?: Array<{ at: number; clue: string }>;
}

export interface LifeSnapshot {
  now: number;
  energy: number;
  alert: number;
  valence: number;
  social: number;
  /** 含开放回路加成的社交意愿（只用于策略，不写回）。 */
  socialEffective: number;
  sleeping: boolean;
  idleMin: number;
  dailyProactive: number;
  lastProactive?: { at: number; text: string; clue: string };
  recentProactive?: Array<{ at: number; clue: string }>;
}

export type LifeEventKind = 'happy' | 'sad' | 'angry' | 'tired' | 'social' | 'rest';

export interface LifePatch {
  energy?: number;
  valence?: number;
  social?: number;
  base?: number;
}

export interface LifePolicyContext {
  openLoops: number;
  /** 每日开口上限；缺省不限。 */
  proactiveCap?: number;
  /** 静默多久后允许主动开口（分钟）。 */
  idleGateMin?: number;
  /** 两次主动开口之间的最小间隔（分钟），缺省 60。 */
  proactiveGapMin?: number;
}

export interface LifePolicy {
  verbosity: 'short' | 'normal' | 'long';
  tone: 'low' | 'normal' | 'high';
  proactive: boolean;
  /** 主动开口的理由；空串 = 不说。 */
  reason: string;
}

export interface LifeHandle {
  snapshot(now?: number): LifeSnapshot;
  render(policy: LifePolicy, snapshot?: LifeSnapshot): string;
  policy(ctx: LifePolicyContext, now?: number): LifePolicy;
  noteTurn(now?: number): void;
  event(kind: LifeEventKind, amp?: number, now?: number): LifeSnapshot;
  update(patch: LifePatch, now?: number): LifeSnapshot;
  /** 记一次已发出的主动开口（由头 + 当时的文本），并把当日次数 +1。 */
  markProactive(clue: string, text: string, now?: number): void;
  /** 模型真正说出口后回填「上次你主动说过」。 */
  noteProactiveSaid(text: string, now?: number): void;
  /** 节流保存：距上次写盘不足 5 分钟就不写。 */
  save(force?: boolean): void;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function localDateKey(now: number): string {
  const d = new Date(now);
  const month = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

/** 解析 `HH:MM-HH:MM`；非法形态回落到默认窗（宁可保守，也不把打错字当成整夜清醒）。 */
export function parseWindow(spec: string): { start: number; end: number } | null {
  const text = (spec || '').trim();
  if (!text) return null;
  const parts = text.split('-');
  if (parts.length !== 2) return parseWindow(DEFAULT_WINDOW);
  const start = hhmm(parts[0]);
  const end = hhmm(parts[1]);
  if (start === null || end === null) return parseWindow(DEFAULT_WINDOW);
  return { start, end };
}

function hhmm(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

export function inSleepWindow(now: number, spec: string): boolean {
  const win = parseWindow(spec);
  if (!win) return false;
  const d = new Date(now);
  const minute = d.getHours() * 60 + d.getMinutes();
  return win.start <= win.end
    ? minute >= win.start && minute < win.end
    : minute >= win.start || minute < win.end;
}

/** 从作息窗口推出「此刻是不是免打扰」。空窗口视为不打扰。 */
export function quietNow(now: number, spec: string): boolean {
  return inSleepWindow(now, spec);
}

function initialState(now: number, cfg: LifeConfig): LifeState {
  const win = parseWindow(cfg.sleepWindow);
  const sleeping = inSleepWindow(now, cfg.sleepWindow);
  const d = new Date(now);
  const minutes = d.getHours() * 60 + d.getMinutes();
  let wakeAt = now - 60 * MIN;
  if (win) {
    // 醒着时取今天的窗口结束时刻；睡着时取昨晚的结束时刻。
    const minutesIntoDay = sleeping ? minutes - win.end + 24 * 60 : minutes - win.end;
    wakeAt = now - Math.max(60, minutesIntoDay) * MIN;
  }
  // 首启没有历史，按「已经醒了多久」反推 S；否则晚上第一次打开会误判成刚睡饱。
  const awakeH = sleeping ? 0 : Math.max(0, (now - wakeAt) / HOUR);
  const s0 = sleeping ? 0.35 : 1 - (1 - S_MIN) * Math.exp(-awakeH / TAU_WAKE_H);
  return {
    ts: now,
    s: s0,
    debt: 0.2,
    effort: 0,
    valence: 0.55,
    base: 0.55,
    social: 0.55,
    wakeAt,
    lastActiveAt: now - 45 * MIN,
    pulses: [],
    dailyKey: localDateKey(now),
    dailyProactive: 0,
  };
}

function isState(value: unknown): value is LifeState {
  const v = value as Partial<LifeState> | null;
  return Boolean(v)
    && typeof v.ts === 'number' && Number.isFinite(v.ts)
    && typeof v.s === 'number'
    && typeof v.debt === 'number'
    && typeof v.social === 'number'
    && typeof v.valence === 'number';
}

/** 读状态；坏文件改名隔离后重建，绝不阻断启动。 */
export function loadState(file: string, now: number, cfg: LifeConfig): LifeState {
  if (!existsSync(file)) return initialState(now, cfg);
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!isState(parsed)) throw new Error('bad state');
    return {
      ...initialState(now, cfg),
      ...parsed,
      effort: typeof parsed.effort === 'number' ? parsed.effort : 0,
      base: typeof parsed.base === 'number' ? parsed.base : 0.55,
      wakeAt: typeof parsed.wakeAt === 'number' ? parsed.wakeAt : now - 60 * MIN,
      lastActiveAt: typeof parsed.lastActiveAt === 'number' ? parsed.lastActiveAt : now - 45 * MIN,
      pulses: Array.isArray(parsed.pulses) ? parsed.pulses.filter(isPulse).slice(-8) : [],
      dailyKey: typeof parsed.dailyKey === 'string' ? parsed.dailyKey : localDateKey(now),
      dailyProactive: typeof parsed.dailyProactive === 'number' ? parsed.dailyProactive : 0,
      lastProactive: isProactive(parsed.lastProactive) ? parsed.lastProactive : undefined,
      recentProactive: Array.isArray(parsed.recentProactive)
        ? parsed.recentProactive.filter(isRecentProactive).slice(-24)
        : [],
    };
  } catch {
    try {
      renameSync(file, `${file}.corrupt-${Date.now()}`);
    } catch {
      // 改名失败也不影响运行，下一次写入会覆盖。
    }
    return initialState(now, cfg);
  }
}

function isPulse(value: unknown): value is LifePulse {
  const p = value as Partial<LifePulse> | null;
  return Boolean(p) && typeof p.at === 'number' && typeof p.amp === 'number';
}

function isProactive(value: unknown): value is { at: number; text: string; clue: string } {
  const p = value as Partial<{ at: number; text: string; clue: string }> | null;
  return Boolean(p) && typeof p.at === 'number' && Number.isFinite(p.at)
    && typeof p.text === 'string' && typeof p.clue === 'string';
}

function isRecentProactive(value: unknown): value is { at: number; clue: string } {
  const p = value as Partial<{ at: number; clue: string }> | null;
  return Boolean(p) && typeof p.at === 'number' && Number.isFinite(p.at)
    && typeof p.clue === 'string';
}

function saveState(file: string, state: LifeState): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(state)}\n`, 'utf8');
  } catch {
    // 写不进去只影响下一次读数，不拖垮 World。
  }
}

/** 按真实时间补算：清醒期 S 上升、睡眠期下降；跨夜结算睡眠债。 */
export function advance(state: LifeState, now: number, cfg: LifeConfig): LifeState {
  if (now <= state.ts) return state;
  const next: LifeState = { ...state, pulses: [...state.pulses] };
  let t = state.ts;
  let sleeping = inSleepWindow(t, cfg.sleepWindow);
  let sleepStart = sleeping ? t : 0;
  let steps = 0;
  while (t < now && steps < MAX_STEPS) {
    const at = Math.min(t + STEP_MS, now);
    const dtH = (at - t) / HOUR;
    const nowSleeping = inSleepWindow(at, cfg.sleepWindow);
    if (nowSleeping) {
      next.s = next.s * Math.exp(-dtH / TAU_SLEEP_H);
      next.effort = next.effort * Math.exp(-dtH / EFFORT_TAU_H);
    } else {
      next.s = 1 - (1 - next.s) * Math.exp(-dtH / TAU_WAKE_H);
      next.social = clamp01(next.social + SOCIAL_RECOVER_PER_H * (1 - next.social) * dtH);
    }
    if (!nowSleeping && sleeping && sleepStart) {
      const sleptH = (at - sleepStart) / HOUR;
      if (sleptH < NEED_SLEEP_H) {
        next.debt = clamp01(next.debt + (NEED_SLEEP_H - sleptH) / NEED_SLEEP_H);
      } else {
        next.debt = clamp01(next.debt - (sleptH - NEED_SLEEP_H) / NEED_SLEEP_H);
      }
      next.wakeAt = at;
    }
    if (nowSleeping) {
      if (!sleepStart) sleepStart = at;
    } else {
      sleepStart = 0;
    }
    sleeping = nowSleeping;
    t = at;
    steps += 1;
  }
  next.ts = now;
  const totalH = (now - state.ts) / HOUR;
  next.valence = clamp01(
    next.base + (next.valence - next.base) * Math.exp(-(Math.log(2) / VALENCE_TAU_H) * totalH),
  );
  // 过期脉冲清掉：10 小时后贡献已可忽略。
  next.pulses = next.pulses.filter((p) => now - p.at < 10 * HOUR);
  const key = localDateKey(now);
  if (key !== next.dailyKey) {
    next.dailyKey = key;
    next.dailyProactive = 0;
  }
  return next;
}

/** 脉冲叠加后的情绪（只读派生，不写回）。 */
export function effectiveValence(state: LifeState, now: number): number {
  let out = state.valence;
  for (const pulse of state.pulses) {
    const ageMin = Math.max(0, (now - pulse.at) / MIN);
    out += pulse.amp * Math.exp(-ageMin / PULSE_TAU_MIN);
  }
  return clamp01(out);
}

function dipAt(state: LifeState, now: number): number {
  if (!state.wakeAt) return 0;
  const hours = (now - state.wakeAt) / HOUR;
  return DIP_DEPTH * Math.exp(-((hours - DIP_CENTER_H) ** 2) / DIP_WIDTH);
}

function pressureOf(s: number): number {
  return clamp01((s - S_MIN) / (S_MAX - S_MIN));
}

function snapshotOf(state: LifeState, now: number, window: string): LifeSnapshot {
  const dip = dipAt(state, now);
  const pressure = pressureOf(state.s);
  const energy = clamp01(
    ENERGY_BASE - ENERGY_WEIGHT * pressure ** PRESSURE_CURVE - DEBT_WEIGHT * state.debt - dip - state.effort,
  );
  const sinceWakeMin = state.wakeAt ? (now - state.wakeAt) / MIN : 24 * 60;
  const inertia = INERTIA_DEPTH * Math.exp(-Math.max(0, sinceWakeMin) / INERTIA_MIN);
  // 不加超日正弦项：±0.05 的周期摆动会让读数贴着档位阈值来回跳，块 id 就不稳了。
  const alert = clamp01(ALERT_GAIN * energy - inertia);
  return {
    now,
    energy,
    alert,
    valence: effectiveValence(state, now),
    social: state.social,
    socialEffective: state.social,
    sleeping: inSleepWindow(now, window),
    idleMin: Math.max(0, (now - state.lastActiveAt) / MIN),
    dailyProactive: state.dailyProactive,
    lastProactive: state.lastProactive,
    recentProactive: state.recentProactive ?? [],
  };
}

/** 五档 / 三档离散词：只有跨档位时文本才变。 */
function bandEnergy(value: number): string {
  if (value >= 0.75) return '充沛';
  if (value >= 0.55) return '尚可';
  if (value >= 0.4) return '一般';
  if (value >= 0.25) return '偏低';
  return '见底';
}

function bandAlert(value: number): string {
  if (value >= 0.55) return '清醒';
  if (value >= 0.35) return '一般';
  return '发困';
}

function bandValence(value: number): string {
  if (value >= 0.65) return '轻快';
  if (value >= 0.4) return '平常';
  return '沉';
}

function bandSocial(value: number): string {
  if (value >= 0.65) return '想聊';
  if (value >= 0.4) return '一般';
  return '想安静';
}

export function createLife(options: { file: string; cfg: LifeConfig; now?: number }): LifeHandle {
  const now = options.now ?? Date.now();
  let state = advance(loadState(options.file, now, options.cfg), now, options.cfg);
  let savedAt = 0;

  const snapshot = (at?: number): LifeSnapshot => {
    const when = at ?? Date.now();
    state = advance(state, when, options.cfg);
    return snapshotOf(state, when, options.cfg.sleepWindow);
  };

  return {
    snapshot,
    policy(ctx, at) {
      const snap = snapshot(at);
      const cap = ctx.proactiveCap ?? Number.POSITIVE_INFINITY;
      const idleGate = ctx.idleGateMin ?? 45;
      const gapMin = ctx.proactiveGapMin ?? 60;
      const lastAt = state.lastProactive?.at;
      const gapOk = !lastAt || (snap.now - lastAt) / MIN >= gapMin;
      const social = clamp01(snap.social + (ctx.openLoops > 0 ? SOCIAL_OPEN_BONUS : 0));
      const quiet = quietNow(snap.now, options.cfg.sleepWindow);
      // 理由只写数量，不写「多久没说话」：那是个随时间爬升的数字，会让块 id 每一小时都变一次。
      const reason = ctx.openLoops > 0 ? `${ctx.openLoops} 件没结的事` : '';
      const proactive = !quiet
        && social >= 0.55
        && snap.energy >= 0.35
        && snap.alert >= 0.4
        && snap.idleMin >= idleGate
        && gapOk
        && state.dailyProactive < cap
        && ctx.openLoops > 0;
      return {
        verbosity: snap.energy < 0.4 ? 'short' : snap.energy > 0.7 ? 'long' : 'normal',
        tone: snap.valence < 0.4 ? 'low' : snap.valence > 0.65 ? 'high' : 'normal',
        proactive,
        reason: proactive ? reason : '',
      };
    },
    render(policy, snap) {
      const s = snap ?? snapshot();
      const toneText = policy.tone === 'low' ? '收敛、少开玩笑' : policy.tone === 'high' ? '轻快' : '平常';
      const lengthText = policy.verbosity === 'short' ? '短一点' : policy.verbosity === 'long' ? '可以多说几句' : '正常长度';
      const lines = [
        '【此刻状态｜只供你参考，不要念出来】',
        `精力：${bandEnergy(s.energy)}｜警觉：${bandAlert(s.alert)}｜心情：${bandValence(s.valence)}｜想说话：${bandSocial(s.social)}`,
        `说话：${lengthText}，语气${toneText}。`,
      ];
      if (policy.proactive) lines.push(`这会儿可以主动找他说句话（${policy.reason}）。`);
      return lines.join('\n');
    },
    noteTurn(at) {
      const when = at ?? Date.now();
      state = advance(state, when, options.cfg);
      state.lastActiveAt = when;
      state.effort = clamp01(state.effort + EFFORT_PER_TURN);
      state.social = clamp01(state.social - SOCIAL_TURN_COST);
      state = { ...state, ts: when };
    },
    event(kind, amp, at) {
      const when = at ?? Date.now();
      state = advance(state, when, options.cfg);
      const amount = typeof amp === 'number' && Number.isFinite(amp) ? Math.max(-0.25, Math.min(0.25, amp)) : undefined;
      switch (kind) {
        case 'happy':
          state.pulses.push({ at: when, amp: amount ?? 0.2 });
          break;
        case 'sad':
          state.pulses.push({ at: when, amp: amount ?? -0.2 });
          break;
        case 'angry':
          state.pulses.push({ at: when, amp: amount ?? -0.15 });
          break;
        case 'tired':
          state.effort = clamp01(state.effort + (amount ?? 0.05));
          state.pulses.push({ at: when, amp: -0.05 });
          break;
        case 'social':
          state.social = clamp01(state.social - (amount ?? 0.03));
          break;
        case 'rest':
          state.social = clamp01(state.social + (amount ?? 0.05));
          break;
        default:
          break;
      }
      state = { ...state, ts: when };
      return snapshotOf(state, when, options.cfg.sleepWindow);
    },
    update(patch, at) {
      const when = at ?? Date.now();
      state = advance(state, when, options.cfg);
      if (typeof patch.base === 'number') state.base = clamp01(patch.base);
      if (typeof patch.valence === 'number') state.valence = clamp01(patch.valence);
      if (typeof patch.social === 'number') state.social = clamp01(patch.social);
      if (typeof patch.energy === 'number') {
        // 反推 S（线性近似，够调试用）：energy ≈ 0.98 - 0.72*pressure - 0.28*debt - dip - effort
        const dip = dipAt(state, when);
        const pressure = (ENERGY_BASE - clamp01(patch.energy) - DEBT_WEIGHT * state.debt - dip - state.effort)
          / ENERGY_WEIGHT;
        state.s = S_MIN + clamp01(pressure) * (S_MAX - S_MIN);
      }
      state = { ...state, ts: when };
      return snapshotOf(state, when, options.cfg.sleepWindow);
    },
    markProactive(clue, text, at) {
      const when = at ?? Date.now();
      state = advance(state, when, options.cfg);
      state.dailyProactive += 1;
      state.lastProactive = { at: when, text: text.slice(0, 80), clue: clue.slice(0, 120) };
      state.recentProactive = [
        ...(state.recentProactive ?? []),
        { at: when, clue: clue.slice(0, 120) },
      ].filter((item) => when - item.at < 24 * 60 * 60_000).slice(-24);
      state = { ...state, ts: when };
    },
    noteProactiveSaid(text, at) {
      if (!state.lastProactive) return;
      const when = at ?? Date.now();
      state.lastProactive = { ...state.lastProactive, text: text.slice(0, 80) };
      state = { ...state, ts: when };
    },
    save(force) {
      const when = Date.now();
      if (!force && when - savedAt < SAVE_GAP_MS) return;
      state = advance(state, when, options.cfg);
      saveState(options.file, state);
      savedAt = when;
    },
  };
}
