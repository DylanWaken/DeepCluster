/** Bounded host-configured decision programs; they can refuse actions but cannot allocate work or grant authority. */
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile, unlink } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { childEnvironment, ProcessCleanupError, type ProcessRunner } from './executor.ts'

/** Validated trusted executable and explicit I/O and time budgets. */
export const policyHookSchema = z.object({
  id: z.string().trim().min(1), command: z.string().trim().min(1), args: z.array(z.string()),
  events: z.array(z.enum(['admission', 'tool'])).min(1), timeoutMs: z.number().int().positive().max(2_147_483_647),
  maxInputBytes: z.number().int().positive(), maxOutputBytes: z.number().int().positive(),
}).strict()
/** A trusted deployment-owned policy executable; no field comes from a model call. */
export type PolicyHook = z.infer<typeof policyHookSchema>

/** Recorded decision from one hook, including contained execution failures. */
export const policyDecisionSchema = z.object({
  hookId: z.string(), event: z.enum(['admission', 'tool']), decision: z.enum(['allow', 'deny', 'require-review', 'error']), reason: z.string(),
}).strict()
/** Recorded decision; only allow delegates to the next hook or action. */
export type PolicyDecision = z.infer<typeof policyDecisionSchema>

/** Logged subject of a policy evaluation; the host owns every hook definition. */
export interface PolicyInput {
  readonly event: 'admission' | 'tool'
  readonly workspace: string
  readonly subject: unknown
}

/** Immutable worker context read at plugin activation, separate from the persisted conversation. */
export const workerPolicySchema = z.object({ workspace: z.string().refine(value => path.isAbsolute(value)), runId: z.string().min(1),
  hooks: z.array(policyHookSchema), terminationGraceMs: z.number().int().positive() }).strict()

const decisionSchema = z.object({ decision: z.enum(['allow', 'deny', 'require-review']), reason: z.string().trim().min(1) }).strict()

/**
 * Execute matching decision programs in order and stop at the first refusal.
 * Input arrives through a private JSON file named by DEEPCLUSTER_POLICY_REQUEST_FILE;
 * stdout must be exactly one decision object. Timeout, malformed output, and nonzero
 * exit refuse the action. An uncertain process range propagates to its lifecycle owner.
 * @param hooks - trusted host definitions; an empty list permits the ordinary pipeline.
 * @param input - fixed action subject, never expanded into command arguments.
 * @param runnerFor - managed process owner with each hook's output limit.
 * @param signal - owning admission or tool cancellation signal.
 * @returns decisions through the first refusal; these decisions do not override other guards.
 */
export async function executePolicyHooks(hooks: readonly PolicyHook[], input: PolicyInput,
  runnerFor: (hook: PolicyHook) => ProcessRunner, signal: AbortSignal): Promise<PolicyDecision[]> {
  const decisions: PolicyDecision[] = []
  for (const hook of hooks.filter(item => item.events.includes(input.event))) {
    signal.throwIfAborted()
    let file: string | undefined
    let retainInput = false
    let decision: PolicyDecision
    try {
      const body = JSON.stringify(input)
      if (Buffer.byteLength(body, 'utf8') > hook.maxInputBytes) throw new Error('Policy input exceeds its byte budget')
      const directory = path.join(input.workspace, '.deep-cluster', 'policy-inputs')
      await mkdir(directory, { recursive: true })
      file = path.join(directory, `${randomUUID()}.json`)
      await writeFile(file, body, { flag: 'wx', mode: 0o600 })
      const env = childEnvironment(process.env)
      delete env.DSH_DEEP_CLUSTER_POLICY_FILE
      env.DEEPCLUSTER_POLICY_REQUEST_FILE = file
      const result = await runnerFor(hook)({ command: hook.command, args: hook.args, cwd: input.workspace,
        timeoutMs: hook.timeoutMs, env, signal })
      signal.throwIfAborted()
      if (result.code !== 0) throw new Error(`Policy program exited with code ${String(result.code)}`)
      if (Buffer.byteLength(result.stdout, 'utf8') > hook.maxOutputBytes) throw new Error('Policy output exceeds its byte budget')
      const parsed = decisionSchema.parse(JSON.parse(result.stdout))
      decision = { hookId: hook.id, event: input.event, ...parsed }
    } catch (error) {
      if (error instanceof ProcessCleanupError) retainInput = true
      if (signal.aborted || error instanceof ProcessCleanupError) throw error
      decision = { hookId: hook.id, event: input.event, decision: 'error', reason: 'Policy evaluation failed; the action was refused. Inspect the configured hook and its budgets.' }
    } finally {
      if (file !== undefined && !retainInput) await unlink(file)
    }
    decisions.push(decision)
    if (decision.decision !== 'allow') break
  }
  return decisions
}
