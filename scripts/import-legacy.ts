/**
 * 旧插件记忆导入（一次性脚本，默认干跑）。
 *
 *   node scripts/import-legacy.ts --legacy <memory-lite目录> --data <Coo数据目录> [--apply]
 *
 * 只导 memory-lite/memories.jsonl 里 status=valid 的条目；private-companion 的
 * events.jsonl 是逐句原话日志（不是整理过的记忆），不导。幂等靠 fact_key：
 * 已导过的键记在 <数据目录>/memory-cache/imported-legacy.json，重复跑不会叠加。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalize } from '../src/config.ts';
import { Engine } from '../src/engine.ts';
import { resolvePaths } from '../src/paths.ts';

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));

interface LegacyMemory {
  id?: string;
  kind?: string;
  text?: string;
  fact_key?: string;
  status?: string;
  tier?: string;
  pinned?: boolean;
  needs_review?: boolean;
  stated_at?: string;
}

function arg(name: string): string {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : '';
}

function hash(text: string): string {
  let value = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 0x01000193);
  }
  return (value >>> 0).toString(36);
}

function loadJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  const out: T[] = [];
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // 坏行跳过，不因一条脏数据中止整批导入。
    }
  }
  return out;
}

function layerOf(memory: LegacyMemory): string {
  return memory.kind === 'commitment' || memory.pinned ? 'structural' : 'knowledge';
}

async function main(): Promise<void> {
  // 一次性脚本不养常驻循环：灵枢的 sustain 是「每个真源一个」的单例，Coo 里正在跑的
  // 引擎已经持锁，第二个实例会在 `_start_sustain` 里一直等——表现为 initialize 永不回。
  process.env.MDCG_SUSTAIN = '0';
  const legacy = arg('legacy');
  const dataDir = arg('data');
  const apply = process.argv.includes('--apply');
  if (!legacy || !dataDir) {
    console.error('用法: node scripts/import-legacy.ts --legacy <memory-lite目录> --data <Coo数据目录> [--apply]');
    process.exit(1);
  }

  const source = join(legacy, 'memories.jsonl');
  const all = loadJsonl<LegacyMemory>(source);
  const candidates = all.filter((m) => m.status === 'valid' && (m.text ?? '').trim().length > 0);
  console.log(`读到 ${all.length} 条，可导入 ${candidates.length} 条（status=valid 且有正文）`);
  console.log('前 3 条预览：');
  for (const m of candidates.slice(0, 3)) {
    console.log(`  [${m.kind ?? '?'}/${m.tier ?? '?'}] ${(m.text ?? '').slice(0, 80)}`);
  }

  const cfg = normalize({
    enabled: true,
    engineRoot: arg('engine') || '',
    dataRoot: arg('data-root') || 'memory',
    // 一次性脚本，宁可多等：灵枢首启要做代校验（导入数十个含 numpy 的模块），
    // 60s 在机器忙时不够，握手超时会让整批导入一条也写不进去。
    timeoutMs: Number(arg('timeout')) || 240_000,
  });
  const paths = resolvePaths({ cfg, dataDir, packageDir: PACKAGE_DIR });
  const ledgerFile = join(paths.cache, 'imported-legacy.json');
  const ledger = existsSync(ledgerFile)
    ? (JSON.parse(readFileSync(ledgerFile, 'utf8')) as Record<string, string>)
    : {};

  if (!apply) {
    const fresh = new Set<string>();
    let seen = 0;
    for (const m of candidates) {
      const key = keyOf(m);
      if (ledger[key]) seen += 1;
      else fresh.add(key);
    }
    console.log(
      `干跑：已导过 ${seen} 条，将新导 ${fresh.size} 条`
      + `（${candidates.length - seen - fresh.size} 条与同批重复，按 fact_key 合并）。加 --apply 才会写入。`,
    );
    return;
  }

  const engine = new Engine({ cfg, paths });
  engine.start();
  if (!(await engine.waitReady())) {
    engine.stop();
    console.error('引擎未就绪，中止（不写入任何一条）。');
    return;
  }

  let written = 0;
  let skipped = 0;
  let failed = 0;
  for (const memory of candidates) {
    const key = keyOf(memory);
    if (ledger[key]) {
      skipped += 1;
      continue;
    }
    const text = (memory.text ?? '').trim();
    try {
      const out = await engine.write(text, { content_kind: 'text', layer: layerOf(memory) });
      const data = out.data as { committed?: unknown } | null;
      if (data && data.committed === true) {
        written += 1;
        ledger[key] = memory.id ?? key;
      } else {
        failed += 1;
        console.warn(`未入库：${text.slice(0, 40)}`);
      }
    } catch (err) {
      failed += 1;
      console.warn(`调用失败：${(err as Error).message}`);
    }
    if (written % 20 === 0 && written > 0) {
      mkdirSync(dirname(ledgerFile), { recursive: true });
      writeFileSync(ledgerFile, `${JSON.stringify(ledger)}\n`, 'utf8');
    }
  }

  mkdirSync(dirname(ledgerFile), { recursive: true });
  writeFileSync(ledgerFile, `${JSON.stringify(ledger)}\n`, 'utf8');
  engine.stop();
  console.log(`完成：写入 ${written}，已存在跳过 ${skipped}，失败 ${failed}。账本 ${ledgerFile}`);
}

/** fact_key 优先；没有就用正文指纹，两条同文只导一条。 */
function keyOf(memory: LegacyMemory): string {
  const key = (memory.fact_key ?? '').trim();
  return key || `text:${hash((memory.text ?? '').trim())}`;
}

main().catch((err) => {
  console.error('导入失败：', (err as Error).message);
  process.exit(1);
});
