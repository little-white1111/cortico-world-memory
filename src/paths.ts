/**
 * 路径解析：记忆真源与身份/凭据根都必须在 dataDir 下。
 * 绝不写进扩展包目录——pnpm 更新会连目录一起删掉。
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MemorySection } from './config.ts';

/** Coo 传进来的 packageDir 是 bot 包目录，不是扩展目录——本包的资源必须按模块文件定位。 */
const MODULE_DIR = fileURLToPath(new URL('..', import.meta.url));

export interface MemoryPaths {
  /** 记忆真源根（md 认知图）。 */
  root: string;
  /** 身份 / 凭据 / 令牌库根。 */
  aux: string;
  /** 灵枢 md_cg 所在目录（cwd 与 PYTHONPATH）。 */
  engineRoot: string;
  /** 部署级写入策略：随包发布，经 MDCG_POLICY_FILE 交给引擎。 */
  policy: string;
  /** 本包自己的派生缓存根（可丢可重建，不是真源）。 */
  cache: string;
}

export function resolvePaths(ctx: {
  cfg: MemorySection;
  dataDir: string;
  packageDir: string;
}): MemoryPaths {
  const root = join(ctx.dataDir, ctx.cfg.dataRoot.trim() || 'memory');
  const aux = join(ctx.dataDir, 'memory-aux');
  const engineRoot = ctx.cfg.engineRoot.trim() || join(MODULE_DIR, 'engine');
  const policy = join(MODULE_DIR, 'data', 'policy.json');
  const cache = join(ctx.dataDir, 'memory-cache');
  return { root, aux, engineRoot, policy, cache };
}
