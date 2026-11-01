/**
 * 出站投影：只在请求视图里插块，不改 session、不碰磁盘。
 *
 * 两条硬约束（来自 memory-lite 的实测结论）：
 * - 插点必须在 `headLength(records)` 之后——system 与合成开头是前缀缓存的地基。
 * - 块 id 取 `msg_<kind>_${fnv1a(text)}`：同样的文本得到同样的 id，前缀才稳定。
 */

/** 只依赖记录的最小结构；不 import Core 类型，保持零依赖。 */
export interface ProjectedRecord {
  version: 2;
  item: {
    type: string;
    role?: string;
    id?: string;
    name?: string;
    call_id?: string;
    arguments?: unknown;
    output?: unknown;
    content?: unknown;
    [key: string]: unknown;
  };
  context: { head?: true; ts?: string; [key: string]: unknown };
}

export interface Turn {
  role: 'user' | 'assistant';
  text: string;
  at: string;
}

/** 32 位 FNV-1a：只用于幂等 id，不做安全用途。 */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** 前缀（system 与合成开头）不算可插段。 */
export function headLength(records: readonly ProjectedRecord[]): number {
  let i = 0;
  while (i < records.length) {
    const item = records[i].item;
    const system = item?.type === 'message' && item.role === 'system';
    if (!system && records[i].context?.head !== true) break;
    i += 1;
  }
  return i;
}

/** 把一段文本插到前缀之后；文本为空时返回 null（调用方据此保持「不改请求」）。 */
export function injectAfterHead(
  records: readonly ProjectedRecord[],
  text: string,
  kind: string,
  ts = new Date(),
): ProjectedRecord[] | null {
  if (!text.trim()) return null;
  const at = headLength(records);
  return [...records.slice(0, at), blockOf(text, kind, ts), ...records.slice(at)];
}

/**
 * 易变块追加到请求尾部：它落在缓存前缀之后，文本变化只废掉尾段，不会重建整段前缀。
 * 只用于「此刻状态 / 开口素材」这类每轮可能变的内容；hot/resume 仍留在 head 之后。
 */
export function appendTail(
  records: readonly ProjectedRecord[],
  text: string,
  kind: string,
  ts = new Date(),
): ProjectedRecord[] | null {
  if (!text.trim()) return null;
  return [...records, blockOf(text, kind, ts)];
}

function blockOf(text: string, kind: string, ts: Date): ProjectedRecord {
  return {
    version: 2,
    item: {
      type: 'message',
      id: `msg_${kind}_${fnv1a(text).toString(36)}`,
      status: 'completed',
      role: 'user',
      content: [{ type: 'input_text', text }],
    },
    context: { ts: ts.toISOString() },
  };
}

// ---------- 原话提取（S-1）：工具调用与回执本身不算原话 ----------

interface CallIndex {
  name: Map<string, string>;
  index: Map<string, number>;
}

function indexCalls(records: readonly ProjectedRecord[]): CallIndex {
  const name = new Map<string, string>();
  const index = new Map<string, number>();
  records.forEach((record, i) => {
    if (record.item?.type !== 'function_call') return;
    const id = record.item.call_id;
    if (typeof id !== 'string' || !id) return;
    name.set(id, String(record.item.name ?? ''));
    index.set(id, i);
  });
  return { name, index };
}

function textOf(record: ProjectedRecord): string {
  const content = record.item?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      const p = part as { text?: unknown; refusal?: unknown };
      if (typeof p?.text === 'string') return p.text;
      if (typeof p?.refusal === 'string') return p.refusal;
      return '';
    })
    .join('');
}

/** external_event_frame 输出里的 [typed] 行就是用户原话；[touch]/[DSH] 不算。 */
function typedLines(output: unknown): string[] {
  const raw = typeof output === 'string' ? output : '';
  if (!raw.trim()) return [];
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const at = line.indexOf('[typed]');
    if (at < 0) continue;
    const rest = line.slice(at + '[typed]'.length).trim();
    const m = rest.match(/^([^:：]+)[:：]\s*([\s\S]+)$/);
    const text = (m ? m[2] : rest).trim();
    if (text) out.push(text);
  }
  return out;
}

function stripEmotion(text: string): string {
  return text.replace(/^\s*(?:【[^】]*】\s*)+/, '').trim();
}

/** pet_say 的 arguments 是 JSON，正文本在 script。 */
function scriptOf(args: unknown): string {
  if (typeof args !== 'string' || !args.trim()) return '';
  try {
    const parsed = JSON.parse(args) as { script?: unknown };
    if (typeof parsed?.script !== 'string') return '';
    return stripEmotion(parsed.script);
  } catch {
    return '';
  }
}

/** Coo 自己塞进来的启动/重启/陪伴上下文——不是用户说的话，投影与续接都要排除。 */
export function isSyntheticText(text: string): boolean {
  const value = text.trim();
  if (/^\[system\]/i.test(value)) return true;
  if (/^【陪伴上下文】/.test(value)) return true;
  if (/\[system\]\s*(the app restarted|application restarted)/i.test(value)) return true;
  return false;
}

function dialogueOf(record: ProjectedRecord, calls: CallIndex): Turn[] {
  const at = typeof record.context?.ts === 'string' ? record.context.ts : '';
  if (record.item?.type === 'message') {
    if (record.context?.head === true) return [];
    const role = String(record.item.role ?? '');
    if (role !== 'user' && role !== 'assistant') return [];
    const text = textOf(record).trim();
    if (!text || isSyntheticText(text)) return [];
    return [{ role: role as 'user' | 'assistant', text, at }];
  }
  if (record.item?.type === 'function_call_output') {
    const callId = record.item.call_id;
    if (typeof callId !== 'string' || calls.name.get(callId) !== 'external_event_frame') return [];
    return typedLines(record.item.output).map((text) => ({ role: 'user' as const, text, at }));
  }
  if (record.item?.type === 'function_call' && record.item.name === 'pet_say') {
    const text = scriptOf(record.item.arguments);
    return text ? [{ role: 'assistant' as const, text, at }] : [];
  }
  return [];
}

/** 从一批记录里取用户/助手的原话，按顺序返回。 */
export function extractTurns(
  records: readonly ProjectedRecord[],
  now = new Date().toISOString(),
): Turn[] {
  const calls = indexCalls(records);
  const out: Turn[] = [];
  for (const record of records) {
    for (const turn of dialogueOf(record, calls)) {
      const text = turn.text.replace(/\s+/g, ' ').trim();
      if (text) out.push({ ...turn, text, at: turn.at || now });
    }
  }
  return out;
}
