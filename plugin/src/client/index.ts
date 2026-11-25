/** DeepCluster's optional DSH navigation page and journal resource provider. */
import type { Context } from '@deepseek-ai/cordis'
import remote from '@deepseek-ai/dsh-experimental-deep-cluster/remote'
import { mountDashboard } from './mount.ts'

export { inject } from './mount.ts'

/**
 * Mount a read-only journal page; UI and streams withdraw before the generated Remote.
 * @param ctx - browser plugin scope.
 * @returns disposer joining page and Remote cleanup.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  return await mountDashboard(ctx, remote)
}
