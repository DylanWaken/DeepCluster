/** DSH Remote forwarding authenticated dashboard reads to the local DeepCluster API. */
import { setTimeout } from 'node:timers/promises'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { apiRequest } from './api-client.ts'
import { resolveConfiguredOptions } from './config.ts'
import { parseDashboardSnapshot } from './dashboard-wire.ts'
import type { ClusterDashboardSnapshot } from './dashboard-types.ts'
import type { DeepClusterOptions } from './types.ts'

/** Host-selected history roots and refresh bounds; the API also includes its active workspaces. */
export interface DashboardConfig {
  readonly workspace: string
  /** Additional roots retained for history after their API operations finish. */
  readonly workspaces?: readonly string[]
  readonly pollIntervalMs: number
  readonly eventLimit: number
  /** Local API endpoint; omitted uses the saved DeepCluster settings. */
  readonly apiEndpoint?: string
}

/** Read-only dashboard controller; streams close on Remote cancellation or plugin disposal. */
export class DeepClusterDashboard extends TypertRemoteService {
  static inject = ['typert']
  static Config = z.object({
    workspace: z.string().min(1),
    workspaces: z.array(z.string().min(1)).default([]),
    pollIntervalMs: z.natural().min(100).default(1000),
    eventLimit: z.natural().min(1).max(10000).default(300),
    apiEndpoint: z.string(),
  })

  private readonly roots: readonly string[]
  private readonly options: DeepClusterOptions

  /**
   * @param ctx - Host Remote registration scope.
   * @param config - journal root and observation bounds.
   */
  constructor(ctx: Context, private readonly config: DashboardConfig) {
    super(ctx, 'deepClusterDashboard', { namespace: 'deepClusterDashboard' })
    this.roots = [...new Set([config.workspace, ...config.workspaces ?? []].map(root => path.resolve(root)))]
    this.options = resolveConfiguredOptions({
      ...(config.apiEndpoint === undefined ? {} : { apiEndpoint: config.apiEndpoint }),
    })
    if (this.options.apiEndpoint === undefined) {
      throw new Error('DeepCluster dashboard requires apiEndpoint in its configuration or saved DeepCluster settings.')
    }
  }

  /**
   * Read recorded worker, lease, and outcome state without exposing model reasoning content.
   * @param signal - cancellation for this read.
   * @returns the current projection; API failures and malformed replies become a typed Remote error.
   */
  @Remote
  async snapshot(signal: AbortSignal): Promise<ClusterDashboardSnapshot> {
    signal.throwIfAborted()
    const query = new URLSearchParams({ workspace: path.resolve(this.config.workspace), eventLimit: String(this.config.eventLimit) })
    for (const root of this.roots.slice(1)) query.append('workspaces', root)
    try {
      return parseDashboardSnapshot(await apiRequest(this.options, { method: 'GET', path: `/v1/dashboard?${query}`, signal }))
    } catch (error) {
      signal.throwIfAborted()
      throw new RemoteError('deepCluster/observation-failed', 'DeepCluster API observation failed', {}, { cause: error })
    }
  }

  /**
   * Follow committed journal updates, including runs launched by another process.
   * @param signal - Remote stream lifetime.
   * @returns an initial snapshot and a fresh snapshot whenever the journal changes.
   */
  @Remote({ mode: 'stream' })
  async *watch(signal: AbortSignal): AsyncIterable<ClusterDashboardSnapshot> {
    let previous = ''
    const aborted = (): boolean => signal.aborted
    while (!aborted()) {
      const snapshot = await this.snapshot(signal)
      const fingerprint = JSON.stringify(snapshot)
      if (fingerprint !== previous) { previous = fingerprint; yield snapshot }
      try { await setTimeout(this.config.pollIntervalMs, undefined, { signal }) } catch (error) {
        if (aborted()) return
        throw error
      }
    }
  }
}

export default DeepClusterDashboard
