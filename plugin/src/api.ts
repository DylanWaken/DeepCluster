/** Optional loopback HTTP controller, composed entirely from public DSH plugin services. */
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from './index.ts'
import { createApiRuntime } from './api-runtime.ts'
import type { ApiConfig } from './api-types.ts'

/** Cordis plugin identity. */
export const name = 'deep-cluster-api'
/** The dedicated listener and configured worker coordinator must exist before routes are exposed. */
export const inject = ['webServer', 'deepCluster']

/** Explicit deployment limits; admission requires no credential, only a same-computer peer. */
export interface Config extends ApiConfig {}

/** Resolve deployment defaults before constructing the API owner. */
export const Config: z<Partial<Config>, Config> = z.object({
  stateDirectory: z.string().required(), leaseRoot: z.string().required(),
  maxBodyBytes: z.natural().min(1).default(1048576), maxOperations: z.natural().min(1).default(10000),
  maxActiveRuns: z.natural().min(1).default(4), maxConcurrency: z.natural().min(1).default(16),
  maxTimeoutMs: z.natural().min(1).max(2_147_483_647).default(7200000), maxAttempts: z.natural().min(1).default(4),
  maxRepairs: z.natural().default(2), requestTimeoutMs: z.natural().min(1).max(2_147_483_647).default(30000),
  maxTail: z.natural().min(1).default(1000), maxMessageChars: z.natural().min(1).max(16000).default(4000),
  maxKnowledgeRecords: z.natural().min(1).default(1000),
  maxKnowledgeBodyBytes: z.natural().min(1).default(16384),
  maxKnowledgeReferences: z.natural().min(1).default(16),
  maxKnowledgeSnapshotBytes: z.natural().min(1).max(1048576).default(65536),
  maxNativeSessions: z.natural().min(1).default(1000), maxSessionHandoffBytes: z.natural().min(1).default(32768),
  maxWakeups: z.natural().min(1).default(1000), maxWakeupAttempts: z.natural().min(1).default(10),
  wakeupPollIntervalMs: z.natural().min(1).max(2_147_483_647).default(1000),
  wakeupRetryDelayMs: z.natural().min(1).max(2_147_483_647).default(1000),
  policyHooks: z.array(z.object({
    id: z.string().min(1), command: z.string().min(1), args: z.array(z.string()).default([]),
    events: z.array(z.union(['admission', 'tool'])).min(1),
    timeoutMs: z.natural().min(1).max(2_147_483_647).default(10000),
    maxInputBytes: z.natural().min(1).default(262144), maxOutputBytes: z.natural().min(1).default(16384),
  })).default([]),
  defaultConcurrency: z.natural().min(1).default(1),
  defaultTimeoutMs: z.natural().min(1).max(2_147_483_647).default(1800000), defaultMaxAttempts: z.natural().min(1).default(2),
  defaultMaxRepairs: z.natural().default(1), defaultLeaseTtlMs: z.natural().min(1).max(2_147_483_647).default(1200000),
  defaultLeaseWaitMs: z.natural().max(2_147_483_647).default(1200000),
})

/**
 * Mount same-computer routes and join their admitted work before releasing the API owner.
 * @param ctx - plugin scope with a dedicated loopback WebServer and DeepCluster provider.
 * @param config - resolved storage locations and bounded operation defaults.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (ctx.webServer.host !== '127.0.0.1' && ctx.webServer.host !== '::1') {
    throw new Error('DeepCluster API requires a dedicated WebServer bound to 127.0.0.1 or ::1.')
  }
  if (![config.stateDirectory, config.leaseRoot].every(value => path.isAbsolute(value))) {
    throw new Error('DeepCluster API stateDirectory and leaseRoot must be absolute paths.')
  }
  if (config.defaultConcurrency > config.maxConcurrency || config.defaultTimeoutMs > config.maxTimeoutMs
    || config.defaultMaxAttempts > config.maxAttempts || config.defaultMaxRepairs > config.maxRepairs
    || config.defaultLeaseTtlMs > config.maxTimeoutMs || config.defaultLeaseWaitMs > config.maxTimeoutMs) {
    throw new Error('DeepCluster API defaults must not exceed their configured operation limits.')
  }
  await ctx.effect(async () => {
    const exit = ctx.get('appExit')
    const runtime = await createApiRuntime(ctx.deepCluster, config, ctx.webServer.getOrigin(), (error) => {
      ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
    }, () => { exit?.(0) })
    let unregister: (() => void) | undefined
    try { unregister = ctx.webServer.register({ kind: 'prefix', path: '/v1',
      handler: async (request, response) => { await runtime.handle(request, response) } }) } catch (error) {
      await runtime.dispose(); throw error
    }
    return async () => { unregister(); await runtime.dispose() }
  }, 'DeepCluster API admission and worker teardown')
}
