/**
 * 冒烟：起引擎 → 环境段 → 写一条 → 投影块 → 续接 → 召回。
 * 用法：node --experimental-strip-types scripts/smoke.ts <engineRoot>
 * 数据落在 <包>/.smoke，跑完可删。
 */
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import world from '../src/index.ts';
import { headLength, type ProjectedRecord } from '../src/projection.ts';

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const dataDir = join(packageDir, '.smoke');
const engineRoot = process.argv[2] ?? '';
if (!engineRoot) {
  console.error('用法：node --experimental-strip-types scripts/smoke.ts <engineRoot>');
  process.exit(2);
}

rmSync(dataDir, { recursive: true, force: true });

const cfg = {
  ...world.defaults(),
  enabled: true,
  engineRoot,
  dataRoot: 'memory',
  timeoutMs: 30_000,
};

const w = world.create({ cfg, dataDir, packageDir, botName: 'Coo' } as never);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function msg(role: string, text: string, head = false): ProjectedRecord {
  return {
    version: 2,
    item: { type: 'message', role, content: [{ type: 'input_text', text }] },
    context: head ? { head: true, ts: new Date().toISOString() } : { ts: new Date().toISOString() },
  };
}

/** 从投影结果里取块文本（注入块是 role=user 的 input_text 消息）。 */
function blocks(records: readonly ProjectedRecord[]): string[] {
  return records
    .filter((r) => r.item.type === 'message' && r.item.role === 'user')
    .map((r) => {
      const content = r.item.content as Array<{ text?: string }> | undefined;
      return content?.[0]?.text ?? '';
    });
}

async function main(): Promise<void> {
  console.time('boot');
  await w.start();
  await wait(4_000);
  console.timeEnd('boot');

  console.log('env:', JSON.stringify(w.envPromptVars()));
  const tools = w.tools();
  console.log('tools:', tools.map((t) => t.name).join(', '));

  const remember = tools.find((t) => t.name === 'memory_remember');
  const recall = tools.find((t) => t.name === 'memory_recall');
  if (!remember || !recall) throw new Error('工具缺失');
  if (tools.length !== 5) throw new Error(`工具数量应为 5，实际 ${tools.length}`);

  const wrote = await remember.handler({ content: '冒烟测试：用户名叫小白。', layer: 'knowledge' });
  console.log('write →', wrote);

  const base = [msg('system', '你是 Coo。', true), msg('user', '你好')];
  const first = w.projectOutbound(base, { hardTokens: 2000 });
  if (!first) throw new Error('projectOutbound 未注入');
  const head = headLength(base);
  console.log('headLength =', head, '注入位置 =', head);
  console.log('hot 块 →\n' + blocks(first).join('\n---\n'));
  if (typeof first[head].item.id !== 'string') throw new Error('块缺少 id');

  const second = w.projectOutbound(base, { hardTokens: 2000 });
  console.log('幂等 id：', first[head].item.id, second?.[head].item.id, first[head].item.id === second?.[head].item.id ? 'OK' : 'MISMATCH');

  const batch = [
    msg('system', '你是 Coo。', true),
    msg('user', '【陪伴上下文】 现在：17:44 状态：精力 50/100 [system] The app restarted; the session carries on.'),
    msg('user', '帮我记一下周末去看海。'),
    msg('assistant', '好，我记下了。'),
  ];
  w.onBatchCommitted(batch);
  await wait(1_000);
  w.onHandoffEnded();
  const withResume = w.projectOutbound(batch, { hardTokens: 2000 });
  const injected = (withResume ?? [])
    .filter((r) => String(r.item.id ?? '').startsWith('msg_resume_'))
    .map((r) => ((r.item.content as Array<{ text?: string }>)[0]?.text ?? ''));
  console.log('续接块 →\n' + injected.join('\n---\n'));
  if (injected.join('').includes('【陪伴上下文】') || !injected.length) throw new Error('续接块异常');
  w.onTurnEnded();
  const afterTurn = w.projectOutbound(batch, { hardTokens: 2000 });
  console.log('轮末清续接：', blocks(afterTurn ?? []).some((b) => b.includes('交接续接')) ? 'FAIL' : 'OK');

  const got = await recall.handler({ query: '小白', budget_tokens: 480 });
  console.log('recall →', got.slice(0, 400));

  const task = tools.find((t) => t.name === 'memory_task');
  const identity = tools.find((t) => t.name === 'memory_identity');
  const forget = tools.find((t) => t.name === 'memory_forget');
  if (!task || !identity || !forget) throw new Error('P2 工具缺失');
  console.log('task →', (await task.handler({ action: 'list' })).slice(0, 300));
  console.log('identity →', (await identity.handler({ action: 'positions' })).slice(0, 300));

  const nodeId = /（(mem[^）]+)）/.exec(got)?.[1];
  if (!nodeId) throw new Error('召回结果没带 node_id，遗忘工具无法用');
  const forgetResult = await forget.handler({ node_id: nodeId, reason: '冒烟测试清理' });
  console.log('forget →', forgetResult.slice(0, 200));
  const after = await recall.handler({ query: '小白', budget_tokens: 480 });
  const deleted = forgetResult.startsWith('已忘记');
  console.log('遗忘闭环：', deleted ? (after.includes(nodeId) ? 'FAIL（已删但仍能召回）' : 'OK') : '未当场删除（按回执入审核队列，属正常）');

  await w.stop();
}

main().catch(async (err) => {
  console.error('SMOKE FAILED:', (err as Error).message);
  await w.stop();
  process.exitCode = 1;
});
