/** 包入口：WorldDefinition。id 必须是 `memory`，与 `worlds` 配置段的键一致。 */
import { createMemoryWorld } from './world.ts';
import { memoryDefaults, normalize, type MemorySection } from './config.ts';

export default {
  id: 'memory',
  label: '记忆（灵枢）',
  defaults: memoryDefaults,
  create(ctx: { cfg: MemorySection; dataDir: string; packageDir: string; botName: string }) {
    return createMemoryWorld({ ...ctx, cfg: normalize(ctx.cfg) });
  },
};
