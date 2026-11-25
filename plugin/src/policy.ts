/** Worker tool policy consumer; normal tool denials remain visible in the native Session log. */
import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-tools'
import { executePolicyHooks, workerPolicySchema } from './policy-hooks.ts'
import { managedProcessRunner } from './executor.ts'
import { Journal } from './journal.ts'

/** Required process-range owner and tool decision pipeline. */
export const inject = ['subprocess', 'tools']

/**
 * Apply a host-authored policy snapshot from the worker environment.
 * @param ctx - worker lifetime; disposal cancels and joins every hook invocation.
 */
export async function apply(ctx: Context): Promise<void> {
  const file = process.env.DSH_DEEP_CLUSTER_POLICY_FILE
  if (file === undefined) throw new Error('DeepCluster worker policy requires its coordinator-owned context file')
  const config = workerPolicySchema.parse(JSON.parse(await readFile(file, 'utf8')))
  const journal = new Journal(config.workspace), abort = new AbortController(), pending = new Set<Promise<unknown>>()
  ctx.on('tools/pre-execute', async (exec, next) => {
    const work = (async () => {
      const decisions = await executePolicyHooks(config.hooks, { event: 'tool', workspace: config.workspace,
        subject: { name: exec.name, arguments: exec.arguments } }, hook => managedProcessRunner(ctx.subprocess, {
        maxOutputBytes: hook.maxOutputBytes, terminationGraceMs: config.terminationGraceMs,
      }), AbortSignal.any([abort.signal, exec.signal]))
      for (const decision of decisions) await journal.record('policy/decision', { runId: config.runId, ...decision })
      return decisions
    })()
    pending.add(work)
    try {
      const decisions = await work
      abort.signal.throwIfAborted()
      const refusal = decisions.find(decision => decision.decision !== 'allow')
      if (refusal !== undefined) return { kind: 'deny', reason: `Policy ${refusal.hookId}: ${refusal.reason}` }
      return await next()
    } finally { pending.delete(work) }
  })
  ctx.effect(() => async () => { abort.abort(); await Promise.allSettled(pending) }, 'DeepCluster policy subprocess teardown')
}
