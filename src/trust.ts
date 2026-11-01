/**
 * 信任叠加：只影响排序与是否进热块，不做裁决、不改灵枢数据。
 *
 * 口径：
 * - confirmed：用户明确要求长期记住的（anchor / 明确「以后都记住」）。
 * - normal：普通入库条目。
 * - review：入库但审核面留了尾巴（如 DEFER 后仍 committed）。
 * - foreign：来自他人/外部材料的转述，可信度最低。
 */
import type { MemoryCard } from './prompt.ts';

export type TrustLevel = 'confirmed' | 'normal' | 'review' | 'foreign';

const WEIGHT: Record<TrustLevel, number> = {
  confirmed: 1.15,
  normal: 1,
  review: 0.7,
  foreign: 0.5,
};

export interface ScopedCard extends MemoryCard {
  trust?: TrustLevel;
  scope?: string;
  importance?: number;
}

export function trustWeight(card: ScopedCard): number {
  return WEIGHT[card.trust ?? 'normal'] ?? 1;
}

/** 未显式声明 scope 的条目视为全局，任何作用域下都可见。 */
export function withinScope(card: ScopedCard, scope?: string): boolean {
  if (!scope || !card.scope) return true;
  return card.scope === scope || card.scope === 'global';
}
