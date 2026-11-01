/**
 * 面向模型的语义工具：一个能力一个工具，而不是把 38 个 op 全摊开。
 * 六个：记住 / 取回 / 任务 / 身份 / 遗忘 / 审核（状态工具另计）。
 */
import type { Engine } from './engine.ts';
import type { MemorySection } from './config.ts';
import { isOpenThread } from './lifecycle.ts';
import type { LifeEventKind, LifeHandle, LifeSnapshot } from './state.ts';

/** 情绪事件落到哪个状态槽；用于同步灵枢的 state_event（只记账，不改四维）。 */
const SLOT_OF: Record<LifeEventKind, 'energy' | 'valence' | 'social'> = {
  happy: 'valence',
  sad: 'valence',
  angry: 'valence',
  tired: 'energy',
  social: 'social',
  rest: 'energy',
};

function round3(value: number): string {
  return (Math.round(value * 1000) / 1000).toFixed(3);
}

export interface MemoryToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  tags: Array<'read' | 'write' | 'speak' | 'act' | 'flow' | 'snapshot'>;
  handler: (args: Record<string, unknown>) => Promise<string>;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export interface RememberedCard {
  id: string;
  text: string;
  ts: number;
  /** 写回执里能拿到的可信度与重要度；拿不到就由世界侧用默认值。 */
  trust?: string;
  importance?: number;
}

export interface MemoryToolHooks {
  /** 写成功后通知世界更新 hot 缓存（缓存只放投影素材，不是真源）。 */
  onRemembered: (card: RememberedCard) => void;
}

const LIFE_EVENTS: readonly LifeEventKind[] = ['happy', 'sad', 'angry', 'tired', 'social', 'rest'];

function lifeText(snap: LifeSnapshot): string {
  const pct = (value: number) => `${Math.round(value * 100)}%`;
  return `精力 ${pct(snap.energy)}｜警觉 ${pct(snap.alert)}｜心情 ${pct(snap.valence)}｜想说话 ${pct(snap.social)}`;
}

export function buildTools(
  engine: Engine,
  cfg: MemorySection,
  hooks: MemoryToolHooks,
  life?: LifeHandle,
  session = 'coo',
): MemoryToolDef[] {
  // state_event 的幂等键（slot|old|new|分钟桶）：同一分钟内的相同跃迁只记一次。
  const sentStateEvents = new Set<string>();
  const out: MemoryToolDef[] = [
    {
      name: 'memory_remember',
      description:
        '记住一件值得留下的事：今天发生了什么、聊到的事、约定、偏好，或你答应过的事。'
        + '只写你确认过的内容，不要复述寒暄；一条只记一件事，原话里的细节要保留。'
        + '名字、称呼、脾气、偏好这类身份信息不要写这里，用 memory_identity（observe/trait）；层怎么选见 layer。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          content: {
            type: 'string',
            description: '要记住的内容，用一句完整的话写清主体、事件与结果。',
          },
          layer: {
            type: 'string',
            enum: ['contextual', 'knowledge', 'structural'],
            description: '按内容选层。contextual（缺省）：当天/本次发生的事、临时状态、未决事项。'
              + 'knowledge：已确认、可复用、不依赖特定时刻的事实与经验。'
              + 'structural：带触发条件的稳定行为规则/价值观（条件空间即触发时机），或跨会话任务台账；'
              + '它表示“有条件地我会怎样”，不是“这条很重要”。',
          },
        },
        required: ['content'],
      },
      tags: ['write'],
      handler: async (args) => {
        const content = asString(args['content']);
        if (!content) return '没有内容可写。';
        const extra: Record<string, unknown> = { content_kind: 'text' };
        const layer = asString(args['layer']);
        if (layer) extra['layer'] = layer;
        try {
          const out = await engine.write(content, extra);
          const data = out.data as {
            committed?: unknown;
            id?: unknown;
            trust?: unknown;
            importance?: unknown;
            verdict?: { state?: unknown; evidence?: unknown };
          } | null;
          const committed = Boolean(data && data.committed === true);
          if (committed && typeof data?.id === 'string') {
            hooks.onRemembered({
              id: data.id,
              text: content,
              ts: Date.now(),
              trust: typeof data.trust === 'string' ? data.trust : undefined,
              importance: typeof data.importance === 'number' ? data.importance : undefined,
            });
            // 像未结线索的事同时记一条目标，只给 read 定向用；失败不影响记住本身。
            if (isOpenThread(content)) {
              void engine.goalAdd(content.slice(0, 120)).catch(() => {});
            }
            return `已记住：${content}`;
          }
          if (data && typeof data.verdict?.state === 'string') {
            const evidence = typeof data.verdict.evidence === 'string' ? data.verdict.evidence : '';
            return `这条没有入库（${data.verdict.state}）：${evidence}`;
          }
          return out.text || '已写入。';
        } catch (err) {
          return `记忆引擎暂时不可用：${(err as Error).message}`;
        }
      },
    },
    {
      name: 'memory_recall',
      description:
        '按线索找回以前记住的事。线索要是具体的词（人名、项目、地点、事件），'
        + '寒暄不算线索。想不起来时才调用，不要每轮都翻。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: {
            type: 'string',
            description: '检索线索；可带多个关键词。',
          },
          budget_tokens: {
            type: 'number',
            description: `返回内容的 token 预算，缺省 ${cfg.recalledTokens}。`,
          },
        },
        required: ['query'],
      },
      tags: ['read'],
      handler: async (args) => {
        const query = asString(args['query']);
        if (!query) return '没有线索。';
        const budget = Number(args['budget_tokens']);
        try {
          const out = await engine.read(query, {
            budget_tokens: Number.isFinite(budget) && budget > 0 ? budget : cfg.recalledTokens,
          });
          const data = out.data as { pack?: Array<{ id?: unknown; content?: unknown }> } | null;
          const pack = Array.isArray(data?.pack) ? data.pack : [];
          const lines = pack
            .map((item) => {
              const text = typeof item?.content === 'string' ? item.content.replace(/\s+/g, ' ').trim() : '';
              if (!text) return '';
              const id = typeof item?.id === 'string' ? item.id : '';
              return id ? `- （${id}）${text}` : `- ${text}`;
            })
            .filter(Boolean);
          if (lines.length === 0) return out.text || '没有找到相关的记忆。';
          return ['【记忆检索】', ...lines].join('\n');
        } catch (err) {
          return `记忆引擎暂时不可用：${(err as Error).message}`;
        }
      },
    },
    {
      name: 'memory_task',
      description:
        '跨会话的未完成事项台账。开新事用 action=open（同名即同一条），'
        + '推进状态用 status，看一眼手上还有什么用 list / session。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'session', 'get', 'find', 'open', 'status', 'plan_add', 'recall_memory', 'record_memory'],
            description: '缺省 list。',
          },
          name: { type: 'string', description: '任务名（open / get / status 的身份判据）。' },
          task_status: {
            type: 'string',
            enum: ['active', 'blocked', 'done', 'dropped'],
            description: 'status 的目标状态；迁 done 时 result 必填。',
          },
          result: { type: 'string', description: '做完了什么（迁 done 必填）。' },
          plan: { type: 'string', description: '下一步计划。' },
          limit: { type: 'number', description: 'list / find 的条数上限。' },
        },
      },
      tags: ['read', 'write'],
      handler: async (args) => {
        const payload: Record<string, unknown> = { action: asString(args['action']) || 'list' };
        for (const key of ['name', 'task_status', 'result', 'plan', 'limit']) {
          const value = args[key];
          if (value !== undefined && value !== null && value !== '') payload[key] = value;
        }
        try {
          const out = await engine.task(payload);
          return out.text || '（无内容）';
        } catch (err) {
          return `记忆引擎暂时不可用：${(err as Error).message}`;
        }
      },
    },
    {
      name: 'memory_identity',
      description:
        '要记住“我是谁 / 你是谁”时用本工具写：自我叙事（我是谁、我怎么来的）、价值观、关系、边界，'
        + '以及名字与称呼、偏好、习惯、脾气。'
        + '先 profile 看已有画像，确认后再用 observe / trait 记一条，不要凭一句玩笑就下结论。'
        + '用户的事用 subject_id=user（缺省）；你自己的事（名字、性格、自己的立场）用 subject_id=self。'
        + '这类信息不要用 memory_remember（那是事件与知识）；observe 记历史证据，trait 记条件触发的特征。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            enum: ['profile', 'positions', 'catalog', 'trait', 'observe'],
            description: '缺省 profile；观察一条用 observe。',
          },
          subject_id: {
            type: 'string',
            description: '主体：用户用 user（缺省）；你自己用 self；也可写 user:alice / self:xixi。',
          },
          content: { type: 'string', description: '要记的特征或观察，一句话。' },
          position: { type: 'string', description: '特征所在单元（如 identity / values / memory）。' },
        },
      },
      tags: ['read', 'write'],
      handler: async (args) => {
        const action = asString(args['action']) || 'profile';
        const payload: Record<string, unknown> = { action };
        for (const key of ['subject_id', 'content', 'position']) {
          const value = args[key];
          if (value !== undefined && value !== null && value !== '') payload[key] = value;
        }
        // 哨兵 self → 引擎要求的 self:<name>（只写 self 会被判成 user）。
        if (payload['subject_id'] === 'self') payload['subject_id'] = cfg.selfSubject;
        // 写侧缺省落在 user 主体：模型不必先猜称呼，画像仍能累积。
        if ((action === 'observe' || action === 'trait') && !payload['subject_id']) {
          payload['subject_id'] = 'user';
        }
        try {
          const out = await engine.identity(payload);
          return out.text || '（无内容）';
        } catch (err) {
          return `记忆引擎暂时不可用：${(err as Error).message}`;
        }
      },
    },
    {
      name: 'memory_review',
      description:
        '灵枢的审核队列：待审候选、裁决记录。只在用户明确说「看看审核队列」「处理这条审核」时用；'
        + 'list 看条目，decide 对单条裁决（accept/reject/noop/merge），verify_record 查某节点裁决历史。'
        + '不要自动裁决，也不要替用户做决定。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'stats', 'decide', 'verify_record'],
            description: '缺省 list。',
          },
          pid: { type: 'string', description: '待审条目的 pid（list 结果里取）。' },
          decision: {
            type: 'string',
            enum: ['accept', 'reject', 'edit', 'merge', 'noop'],
            description: 'decide 的裁决；edit 需 content，merge 需 merge_into。',
          },
          content: { type: 'string', description: 'decision=edit 时改写后的正文。' },
          merge_into: { type: 'string', description: 'decision=merge 时的目标节点 id。' },
          reason: { type: 'string', description: '裁决理由（用户原话优先）。' },
          node_id: { type: 'string', description: 'verify_record 的裁决记录节点 id（decide 回执里的记录 id，形如 rev_<pid>_rN）。' },
          override: { type: 'boolean', description: '确需越过保护/门槛时才置 true。' },
        },
      },
      tags: ['read', 'write'],
      handler: async (args) => {
        const action = asString(args['action']) || 'list';
        try {
          if (action === 'decide') {
            const pid = asString(args['pid']);
            const decision = asString(args['decision']);
            if (!pid || !decision) return '缺少 pid 或 decision。';
            const payload: Record<string, unknown> = { action: 'decide', pid, decision };
            if (decision === 'edit') {
              const content = asString(args['content']);
              if (!content) return 'edit 需要 content。';
              payload['edits'] = { content };
            }
            if (decision === 'merge') {
              const mergeInto = asString(args['merge_into']);
              if (!mergeInto) return 'merge 需要 merge_into。';
              payload['merge_into'] = mergeInto;
            }
            for (const key of ['reason']) {
              const value = asString(args[key]);
              if (value) payload[key] = value;
            }
            if (args['override'] === true) payload['override'] = true;
            const out = await engine.review(payload);
            const data = out.data as {
              ok?: unknown;
              error?: unknown;
              hint?: unknown;
              record_node_id?: unknown;
            } | null;
            if (data && data.ok === true) {
              const record = typeof data.record_node_id === 'string'
                ? `（记录 ${data.record_node_id}）`
                : '';
              return `已裁决 ${pid}：${decision}${record}`;
            }
            if (data && typeof data.error === 'string') {
              const hint = typeof data.hint === 'string' ? `：${data.hint}` : '';
              return `没有裁决（${data.error}）${hint}`;
            }
            return out.text || '已处理。';
          }
          if (action === 'verify_record') {
            const nodeId = asString(args['node_id']);
            if (!nodeId) return '缺少 node_id。';
            const out = await engine.review({ action: 'verify_record', node_id: nodeId });
            return out.text || '（无记录）';
          }
          if (action === 'stats') {
            const out = await engine.review({ action: 'stats' });
            return out.text || '（无统计）';
          }
          const out = await engine.review({ action: 'list' });
          const data = out.data as { pending?: unknown } | null;
          const pending = Array.isArray(data?.pending) ? data.pending : [];
          if (pending.length === 0) return '审核队列是空的。';
          const lines = pending.slice(0, 5).map((item) => {
            const rec = (item ?? {}) as Record<string, unknown>;
            const pid = typeof rec['pid'] === 'string' ? rec['pid'] : '?';
            const kind = typeof rec['kind'] === 'string' ? rec['kind'] : 'proposal';
            const body = typeof rec['content'] === 'string'
              ? rec['content']
              : typeof rec['text'] === 'string' ? rec['text'] : '';
            return `- ${pid}｜${kind}｜${body.replace(/\s+/g, ' ').trim().slice(0, 100)}`;
          });
          return `待审 ${pending.length} 条（最多显示 5 条）：\n${lines.join('\n')}`;
        } catch (err) {
          return `记忆引擎暂时不可用：${(err as Error).message}`;
        }
      },
    },
    {
      name: 'memory_forget',
      description:
        '用户明确要求「忘掉这件事」时才用。node_id 从 memory_recall 的结果里取；'
        + '软删除、可恢复。自主档可能只出一张审核单而不当场删，回执会写明。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          node_id: { type: 'string', description: '要遗忘的条目 id（召回结果里括号内的那串）。' },
          reason: { type: 'string', description: '为什么忘掉（用户原话优先）。' },
          override: { type: 'boolean', description: '受保护条目才需要显式置 true。' },
        },
        required: ['node_id'],
      },
      tags: ['write'],
      handler: async (args) => {
        const nodeId = asString(args['node_id']);
        if (!nodeId) return '缺少 node_id。';
        try {
          const out = await engine.forget(nodeId, asString(args['reason']), args['override'] === true);
          const data = out.data as {
            ok?: unknown;
            deleted?: unknown;
            error?: unknown;
            hint?: unknown;
          } | null;
          if (data && data.ok === true && data.deleted === true) return `已忘记：${nodeId}`;
          if (data && typeof data.hint === 'string') return `没有当场删除：${data.hint}`;
          if (data && typeof data.error === 'string') return `没有删除（${data.error}）。`;
          return out.text || '已处理。';
        } catch (err) {
          return `记忆引擎暂时不可用：${(err as Error).message}`;
        }
      },
    },
  ];

  if (life) {
    out.push({
      name: 'memory_state',
      description:
        '你自己的当前状态（精力/警觉/心情/社交意愿）。它只影响说话长短和语气，'
        + '不是记忆，也不会被别人看见。对话里发生了明显的情绪事件（被夸、被凶、'
        + '累到不行、聊到很投入）时才用 action=event 记一笔；平时不用频繁查。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            enum: ['get', 'event', 'update'],
            description: '缺省 get。',
          },
          kind: {
            type: 'string',
            enum: ['happy', 'sad', 'angry', 'tired', 'social', 'rest'],
            description: 'event 的事件类型；social 是社交消耗，rest 是休息回升。',
          },
          amp: { type: 'number', description: 'event 的幅度，缺省按类型取值（上限 ±0.25）。' },
          energy: { type: 'number', description: 'update 直设精力（0–1），调试用。' },
          valence: { type: 'number', description: 'update 直设心情（0–1），调试用。' },
          social: { type: 'number', description: 'update 直设社交意愿（0–1），调试用。' },
        },
      },
      tags: ['read', 'write'],
      handler: async (args) => {
        const action = asString(args['action']) || 'get';
        if (action === 'event') {
          const kind = asString(args['kind']) as LifeEventKind;
          if (!LIFE_EVENTS.includes(kind)) return '未知的事件类型。';
          const amp = Number(args['amp']);
          const before = life.snapshot();
          const snap = life.event(kind, Number.isFinite(amp) ? amp : undefined);
          life.save(true);
          // 四维只在本包算；灵枢只收一条五元事件作账（同一分钟相同跃迁只记一次）。
          const slot = SLOT_OF[kind];
          const oldValue = round3(before[slot]);
          const newValue = round3(snap[slot]);
          const key = `${slot}|${oldValue}|${newValue}|${Math.floor(Date.now() / 60_000)}`;
          if (!sentStateEvents.has(key)) {
            if (sentStateEvents.size > 16) sentStateEvents.clear();
            sentStateEvents.add(key);
            // 灵枢台账的 kind 只认 migration/retraction/enablement/acquisition/replacement；
            // 情绪脉冲是「旧值被新值替换」，统一记 replacement。
            void engine.stateEvent(session, slot, oldValue, newValue, 'replacement').catch(() => {});
          }
          return `已记下。当前 ${lifeText(snap)}`;
        }
        if (action === 'update') {
          const patch: { energy?: number; valence?: number; social?: number } = {};
          for (const key of ['energy', 'valence', 'social']) {
            const value = Number(args[key]);
            if (Number.isFinite(value)) patch[key] = value;
          }
          if (Object.keys(patch).length === 0) return '没有要改的值。';
          const snap = life.update(patch);
          life.save(true);
          return `已更新。当前 ${lifeText(snap)}`;
        }
        const snap = life.snapshot();
        return life.render(life.policy({ openLoops: 0 }, snap.now), snap);
      },
    });
  }
  return out;
}
