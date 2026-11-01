/**
 * 三层预算：pinned（环境段，重建才变）/ hot（每轮注入）/ recalled（工具调用）。
 * 本模块只管 hot 与 recalled；pinned 由 ENV_PROMPT 自身的常量文案保证。
 */
import type { MemorySection } from './config.ts';

/** CJK 按字计，ASCII 词按 1.3 计——与 memory-lite 同一口径。 */
export function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g) ?? []).length;
  const words = (text.match(/[A-Za-z0-9_]+/g) ?? []).length;
  return Math.ceil(cjk + words * 1.3);
}

/**
 * hot 预算：Coo 给的 hardTokens = window − maxTokens，可能为 null。
 * null → 用配置默认；有值 → min(默认, hardTokens * 15%)，其余留给 recalled。
 */
export function hotBudget(cfg: MemorySection, hardTokens?: number | null): number {
  if (hardTokens == null || !Number.isFinite(hardTokens) || hardTokens <= 0) return cfg.hotTokens;
  return Math.max(32, Math.min(cfg.hotTokens, Math.floor(hardTokens * 0.15)));
}

/**
 * 按预算装行：表头必留，逐行累加，装不下即停。
 * 返回装进去的行与因预算被省略的行数——省略数要如实写回提示词（不静默丢）。
 */
export function fitLines(
  header: string,
  lines: readonly string[],
  budget: number,
): { text: string; kept: number; dropped: number; tokens: number } {
  const kept: string[] = [];
  let used = estimateTokens(header);
  for (const line of lines) {
    const cost = estimateTokens(line) + 1;
    if (used + cost > budget) break;
    kept.push(line);
    used += cost;
  }
  const text = kept.length ? `${header}\n${kept.map((line) => `- ${line}`).join('\n')}` : header;
  return { text, kept: kept.length, dropped: lines.length - kept.length, tokens: estimateTokens(text) };
}
