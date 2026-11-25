/** Mount the dashboard page, its journal resource provider, and its sidebar entry over one generated Remote contribution. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-resources/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import { RemoteError, type TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type { ClusterDashboardSnapshot } from '../dashboard-types.ts'
import { ClusterIcon, ClusterPage } from './ClusterPage.tsx'
import { en, zh, NS, type ClusterKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { deepCluster: ClusterKey }
  interface ResourceProtocolMap { deepcluster: ClusterDashboardSnapshot }
}

/** Browser services used by the optional page and its generated Remote contribution. */
export const inject = ['remote', 'resources', 'slots', 'locale']

/**
 * Mount a read-only journal page; UI and streams withdraw before the generated Remote.
 * @param ctx - browser plugin scope.
 * @param remote - generated Remote contribution mounted before the page appears.
 * @returns disposer joining page and Remote cleanup.
 */
export async function mountDashboard(ctx: Context, remote: TypertRemoteContribution): Promise<() => Promise<void>> {
  const unmountRemote = await ctx.remote.$mount(remote)
  const ui = ctx.inject(['remote.deepClusterDashboard'], (child) => {
    child.effect(() => child.locale.register(NS, { en, zh }))
    child.effect(() => child.resources.register<'deepcluster'>({
      protocol: 'deepcluster',
      async *open(_address, { signal }) {
        const stream = child.remote.$stream<ClusterDashboardSnapshot>({
          name: 'deepClusterDashboard',
          open: generation => child.remote.deepClusterDashboard.watch(AbortSignal.any([signal, generation])),
          ended: () => new Error('DeepCluster dashboard stream ended'),
        })
        try {
          for await (const frame of stream) {
            if (signal.aborted) return
            yield { ok: true as const, value: frame.value }
            frame.accept()
          }
        } catch (error) {
          if (!signal.aborted) yield { ok: false as const,
            error: new RemoteError('deepCluster/observation-failed', 'DeepCluster observation failed', {}, { cause: error }) }
        } finally { await stream.dispose() }
      },
    }))
    const t = child.locale.bind(NS)
    const panel = 'deepCluster' as MainPanelId
    child.slots.inject('main', () => child.slots.register({ name: 'main', key: panel, locale: NS }, ClusterPage))
    child.slots.inject('sidebar.panellist', () => child.slots.register({ name: 'sidebar.panellist', id: panel,
      order: 20, locale: NS, label: () => t('panel') }, ClusterIcon))
  })
  try { await ui } catch (error) { await ui.dispose(); await unmountRemote(); throw error }
  return async () => { await ui.dispose(); await unmountRemote() }
}
