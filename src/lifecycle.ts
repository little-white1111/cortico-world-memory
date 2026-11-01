/**
 * 生命周期：只排序、只决定「谁进热块」，绝不删除、绝不改写灵枢的条目。
 * 被挤出热块的条目仍留在缓存里，提示词里如实写明条数并指路 memory_recall。
 */
import type { ScopedCard } from './trust.ts';
import { trustWeight, withinScope } from './trust.ts';

/** 14 天半衰：两周前的条目权重减半，但不归零（旧事仍可被排上来）。 */
const HALF_LIFE_HOURS = 24 * 14;

/** 没做完的事：只是排序加权，不作为「待办」写回任何地方。 */
const OPEN_THREAD = /(待办|还没|没做完|未完成|悬着|回头|下次|明天要|等(?:我|你|会儿|一下)|TODO|todo)/;

/** 同一条正则以供写入侧复用（记住的事若像未结线索，就同步一条目标）。 */
export function isOpenThread(text: string): boolean {
  return OPEN_THREAD.test(text);
}

/** 情绪浓度高的片段：同样只用于排序。 */
const HIGH_INTENSITY = /(崩溃|哭了|生气|吵架|难过|害怕|焦虑|兴奋|紧张|失眠|心疼|委屈)/;

const OPEN_THREAD_BONUS = 1.25;
const HIGH_INTENSITY_BONUS = 1.15;

export function decayWeight(ts: number, now: number): number {
  const ageHours = Math.max(0, (now - ts) / 3_600_000);
  return Math.pow(0.5, ageHours / HALF_LIFE_HOURS);
}

export interface CardScore {
  card: ScopedCard;
  score: number;
  openThread: boolean;
  highIntensity: boolean;
}

export function scoreCard(card: ScopedCard, now: number): CardScore {
  const openThread = OPEN_THREAD.test(card.text);
  const highIntensity = HIGH_INTENSITY.test(card.text);
  let score = decayWeight(card.ts, now) * trustWeight(card);
  if (typeof card.importance === 'number' && Number.isFinite(card.importance)) {
    score *= 0.5 + Math.max(0, Math.min(1, card.importance));
  }
  if (openThread) score *= OPEN_THREAD_BONUS;
  if (highIntensity) score *= HIGH_INTENSITY_BONUS;
  return { card, score, openThread, highIntensity };
}

/**
 * 热块选材：按分数排序后取前 limit 条。
 * 返回被排除的条数——由调用方写进提示词，而不是静默丢掉。
 */
export function selectHot(
  cards: readonly ScopedCard[],
  now: number,
  limit: number,
  scope?: string,
): {
  selected: ScopedCard[];
  dropped: number;
  openThreads: number;
  /** 命中开放回路的卡片正文（最多 2 条），供主动开口的素材包使用。 */
  openThreadCards: string[];
} {
  const visible = cards.filter((card) => withinScope(card, scope));
  const ranked = visible.map((card) => scoreCard(card, now)).sort((a, b) => b.score - a.score);
  const selected = ranked.slice(0, Math.max(0, limit)).map((entry) => entry.card);
  const openCards = selected.filter((card) => OPEN_THREAD.test(card.text));
  return {
    selected,
    dropped: Math.max(0, visible.length - selected.length),
    openThreads: openCards.length,
    openThreadCards: openCards.slice(0, 2).map((card) => card.text.slice(0, 60)),
  };
}
