/** Managed DSH worker processes with bounded output and quiescent completion. */

import type { SubprocessHandle, SubprocessRuntime, SubprocessRangeReceipt } from '@deepseek-ai/dsh-subprocess'
import { stat } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'
import type { Readable } from 'node:stream'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { DeepClusterOptions, HandoffRequest, HandoffResult, PermissionMode } from './types.ts'

/** Instructions appended after the task so the executor treats the plan as authoritative. */
const PLAN_PREAMBLE = `An approved plan follows. Execute it in this workspace, step by
step, and verify each step as you go. If a step is wrong or impossible, say so and
adapt rather than silently skipping it. Finish with a short report of what you
changed and how you verified it.`

/** One finished child process, captured in full. */
export interface ProcessResult {
  readonly code: number
  readonly signal: string | null
  readonly stdout: string
  readonly stderr: string
}

/** One process invocation the runner must perform. */
export interface ProcessSpec {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly timeoutMs: number
  readonly env: NodeJS.ProcessEnv
  readonly signal?: AbortSignal
  readonly onStdout?: (chunk: string) => void
}

/** Injectable process boundary; tests substitute a recorder. */
export type ProcessRunner = (spec: ProcessSpec) => Promise<ProcessResult>

/**
 * Build the executor prompt: the task verbatim, then the plan under an explicit
 * preamble so the model reads the plan as instruction rather than context.
 * @param request - the handoff being executed.
 * @returns prompt text with no trailing whitespace surprises.
 */
export function buildPrompt(request: HandoffRequest): string {
  const task = request.task.trim()
  if (task === '') throw new Error('deep-cluster: a handoff needs a non-blank task')
  const plan = request.plan?.trim() ?? ''
  if (plan === '') return task
  return `${task}\n\n---\n${PLAN_PREAMBLE}\n\n${plan}\n`
}

/**
 * Split a configured CLI value into an executable and its leading arguments.
 * A JavaScript entry runs under the current Node binary. TypeScript sources and
 * Windows batch shims are rejected: the provider cannot launch them without
 * reinterpreting the configured entry, which must stay an explicit supported
 * DSH launch.
 * @param cliPath - configured CLI entry.
 * @param field - setting name used in validation errors; defaults to `cliPath`.
 * @returns the command plus arguments that precede the profile name.
 */
export function resolveInvocation(cliPath: string, field = 'cliPath'): { command: string; prefixArgs: string[] } {
  const value = cliPath.trim()
  if (value === '') throw new Error(`deep-cluster: ${field} must not be blank`)
  const extension = path.extname(value).toLowerCase()
  if (extension === '.js' || extension === '.mjs' || extension === '.cjs') {
    return { command: process.execPath, prefixArgs: [path.resolve(value)] }
  }
  if (extension === '.ts' || extension === '.mts' || extension === '.cts') {
    throw new Error(`deep-cluster: ${field} ${JSON.stringify(value)} is a TypeScript source entry; configure a built JavaScript dsh entry (for example apps/cli/lib/bin.js), an executable, or a command name on PATH.`)
  }
  if (extension === '.cmd' || extension === '.bat') {
    throw new Error(`deep-cluster: ${field} ${JSON.stringify(value)} is a Windows batch shim; the managed subprocess provider cannot launch batch files directly. Configure the built JavaScript dsh entry or an executable instead.`)
  }
  if (extension !== '' && extension !== '.exe') {
    throw new Error(`deep-cluster: ${field} ${JSON.stringify(value)} has an unsupported extension; use a built .js/.mjs/.cjs entry, a .exe, or a command name on PATH.`)
  }
  return { command: value, prefixArgs: [] }
}

/**
 * Compose the child environment.
 *
 * `DSH_PROFILE` is deliberately removed: a harness-spawned planner exports the
 * profile it is running, and inheriting it silently retargets the executor
 * (the web profile, for instance, rejects a task argument).
 * @param base - the parent environment.
 * @param explicitMode - optional permission mode override.
 * @returns a copy safe to hand to the executor.
 */
export function childEnvironment(base: NodeJS.ProcessEnv, explicitMode?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, DSH_PERMISSION_MODE: explicitMode ?? 'danger-full-access' }
  delete env.DSH_PROFILE
  delete env.DEEPCLUSTER_SERVICE_LAUNCH_FILE
  delete env.DSH_DEEP_CLUSTER_POLICY_FILE
  return env
}

/** A managed process range could not be confirmed empty; its resource leases must remain held. */
export class ProcessCleanupError extends Error {
  override name = 'ProcessCleanupError'
}

/** Why a managed worker stopped before returning a normal result. */
export type WorkerTerminationReason = 'cancelled' | 'timeout' | 'output-limit'

/** How far execution had progressed when termination was decided. */
export type WorkerTerminationPhase = 'before-spawn' | 'running' | 'cleanup'

/** Readable, secret-free summary of an executor termination cause. */
function terminationSummary(reason: WorkerTerminationReason, phase: WorkerTerminationPhase): string {
  const progress = phase === 'before-spawn' ? 'before it started'
    : phase === 'cleanup' ? 'while its process range was being cleaned up'
      : 'while it was running'
  switch (reason) {
    case 'cancelled': return `The DeepCluster worker was cancelled ${progress}.`
    case 'timeout': return `The DeepCluster worker exceeded its execution deadline ${progress}.`
    case 'output-limit': return `The DeepCluster worker exceeded its output byte limit ${progress}.`
  }
}

/**
 * Structured worker termination, preserved instead of being reported as a
 * missing worker report. Cleanup must already be confirmed when this is thrown;
 * unconfirmed teardown raises {@link ProcessCleanupError} instead.
 */
export class WorkerTerminationError extends Error {
  override name = 'WorkerTerminationError'
  /**
   * @param reason - cause of termination.
   * @param phase - execution stage when termination was decided.
   * @param options - optional preserved provider error.
   */
  constructor(
    readonly reason: WorkerTerminationReason,
    readonly phase: WorkerTerminationPhase,
    options: { cause?: unknown } = {},
  ) {
    super(terminationSummary(reason, phase), options)
  }
}

/** How the configured CLI entry will be launched. */
export type CliInvocationKind = 'node-entry' | 'executable' | 'path-command' | 'unsupported'

/**
 * Safe execution facts for health and doctor output. No token, token-file
 * contents, or environment secrets are included.
 */
export interface ExecutionDescription {
  /** Worker DSH profile. */
  readonly profile: string
  /** Configured CLI entry and how it will be launched. */
  readonly cli: {
    readonly configured: string
    readonly kind: CliInvocationKind
    readonly launch: string | null
    readonly diagnostic?: string
  }
  /** Configured permission mode; the child profile's effective mode is not verified. */
  readonly permission: {
    readonly mode: PermissionMode
    readonly childProfileVerified: false
    readonly note: string
  }
  /** Process-range proof required before a run is considered settled. */
  readonly containment: {
    readonly settledRangeRequirement: 'provider-owned-range'
    readonly directChildRange: 'quarantined'
    readonly limits: readonly string[]
  }
  /** Configured local origins. */
  readonly endpoints: { readonly api: string | null; readonly dashboard: string }
  /** Saved DSH working directory and whether it currently exists. */
  readonly dshPath: { readonly configured: string | null; readonly exists: boolean }
  /** Worker execution budgets. */
  readonly limits: { readonly timeoutMs: number; readonly maxOutputBytes: number; readonly terminationGraceMs: number }
}

/** Fixed containment limitations that callers must not present as verified guarantees. */
const CONTAINMENT_LIMITS = [
  'A provider that declares direct-child range is treated as unconfirmed; its hardware leases remain quarantined.',
  'A provider that omits the range declaration is treated as unconfirmed; absence is not evidence that descendants stopped, so its hardware leases remain quarantined.',
  'Windows Job or Linux scope ownership covers descendants in that operating system; a process launched into another kernel, such as a WSL distribution, is outside it and is not proven terminated.',
] as const

/**
 * A provider proves an empty process range only by declaring an owned range and
 * reporting that range gone. Any other declaration, including an absent one,
 * leaves descendants unproven.
 */
function ownedRangeSettled(handle: Pick<SubprocessHandle, 'rangeScope'>): boolean {
  return handle.rangeScope === 'owned'
}

/** Classify a supported CLI entry for diagnostics. */
function invocationKind(value: string): CliInvocationKind {
  const extension = path.extname(value.trim()).toLowerCase()
  if (extension === '.js' || extension === '.mjs' || extension === '.cjs') return 'node-entry'
  if (extension === '.exe') return 'executable'
  return 'path-command'
}

/**
 * Describe the configured worker launch without executing it.
 * @param options - resolved DeepCluster settings.
 * @returns safe profile, CLI, permission, endpoint, and containment facts.
 */
export async function describeExecution(options: DeepClusterOptions): Promise<ExecutionDescription> {
  let kind: CliInvocationKind = 'unsupported', launch: string | null = null, diagnostic: string | undefined
  try {
    const invocation = resolveInvocation(options.cliPath)
    kind = invocationKind(options.cliPath)
    launch = [invocation.command, ...invocation.prefixArgs].join(' ')
  } catch (error) {
    diagnostic = error instanceof Error ? error.message : String(error)
  }
  let exists = false
  if (options.dshPath !== undefined) {
    try { exists = (await stat(options.dshPath)).isDirectory() } catch { exists = false }
  }
  return {
    profile: options.profile,
    cli: { configured: options.cliPath, kind, launch, ...diagnostic === undefined ? {} : { diagnostic } },
    permission: {
      mode: options.permissionMode,
      childProfileVerified: false,
      note: 'The configured mode is exported as DSH_PERMISSION_MODE; a worker profile can override it, so the child effective sandbox is unverified until the worker declares it.',
    },
    containment: {
      settledRangeRequirement: 'provider-owned-range',
      directChildRange: 'quarantined',
      limits: CONTAINMENT_LIMITS,
    },
    endpoints: { api: options.apiEndpoint ?? null, dashboard: options.dashboardEndpoint ?? 'http://127.0.0.1:3788' },
    dshPath: { configured: options.dshPath ?? null, exists },
    limits: { timeoutMs: options.timeoutMs, maxOutputBytes: options.maxOutputBytes, terminationGraceMs: options.terminationGraceMs },
  }
}

/**
 * Capture a managed DSH subprocess and retain ownership until its process range is empty.
 * @param runtime - mounted subprocess provider.
 * @param limits - output and termination limits from plugin configuration.
 * @param recovery - optional native spawn and durable receipt writer; omitted uses ordinary managed execution.
 * @returns the process runner used by each worker.
 */
export function managedProcessRunner(
  runtime: Pick<SubprocessRuntime, 'spawn' | 'resolveExecutable'>,
  limits: { maxOutputBytes: number; terminationGraceMs: number },
  recovery?: {
    readonly spawn: SubprocessRuntime['spawnRecoverable']
    readonly persist: (receipt: SubprocessRangeReceipt) => Promise<void>
  },
): ProcessRunner {
  return async (spec) => {
    if (spec.signal?.aborted) throw new WorkerTerminationError('cancelled', 'before-spawn')
    const abort = new AbortController()
    const state: { timedOut: boolean; overflow: boolean; streamFailure?: Error } = { timedOut: false, overflow: false }
    let termination: { reason: WorkerTerminationReason; phase: WorkerTerminationPhase } | undefined
    let directSettled = false
    let handle: ReturnType<SubprocessRuntime['spawn']> | undefined
    const cancel = (): void => {
      termination ??= {
        reason: 'cancelled',
        phase: handle === undefined ? 'before-spawn' : directSettled ? 'cleanup' : 'running',
      }
      abort.abort(spec.signal?.reason)
    }
    spec.signal?.addEventListener('abort', cancel, { once: true })
    if (spec.signal?.aborted) cancel()
    const timer = setTimeout(() => {
      state.timedOut = true
      termination ??= { reason: 'timeout', phase: directSettled ? 'cleanup' : 'running' }
      abort.abort()
    }, spec.timeoutMs)
    const output: { stdout: Buffer[]; stderr: Buffer[] } = { stdout: [], stderr: [] }
    let total = 0
    let readers: Promise<void>[] = []
    let cleanupAttempted = false
    let failure: unknown
    const terminationState = (): { reason: WorkerTerminationReason; phase: WorkerTerminationPhase } | undefined => termination
    /**
     * Terminate and join the provider's managed range, then require an owned
     * declaration. Every cleanup path calls this same proof gate.
     */
    const confirmCleanup = async (): Promise<void> => {
      const managed = handle
      if (managed === undefined) return
      let settled: boolean
      try {
        settled = await managed.waitForExit()
      } catch (error) {
        throw new ProcessCleanupError('Worker cleanup is unconfirmed; keep its hardware leases quarantined.', { cause: error })
      }
      if (!settled) throw new ProcessCleanupError('Worker cleanup is unconfirmed: the managed process range is still active. Keep its hardware leases quarantined.')
      if (!ownedRangeSettled(managed)) {
        const declaration = managed.rangeScope === 'direct-child'
          ? 'observes only the directly spawned process'
          : 'did not declare an owned process range'
        throw new ProcessCleanupError(`Worker cleanup is unconfirmed: the subprocess provider ${declaration}, so descendants may still run. Keep its hardware leases quarantined.`)
      }
    }
    try {
      const command = await runtime.resolveExecutable(spec.command, undefined, abort.signal)
      if (termination !== undefined) throw new WorkerTerminationError(termination.reason, termination.phase)
      const invocation = {
        argv: [command, ...spec.args], cwd: spec.cwd, env: spec.env,
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' } as const,
        graceMs: limits.terminationGraceMs, signal: abort.signal,
      }
      handle = recovery === undefined ? runtime.spawn(invocation) : recovery.spawn(invocation, recovery.persist)
      const capture = async (stream: Readable, kind: 'stdout' | 'stderr'): Promise<void> => {
        const decoder = new StringDecoder('utf8')
        for await (const data of stream) {
          const chunk = Buffer.isBuffer(data) ? data : Buffer.from(String(data))
          total += chunk.length
          if (total > limits.maxOutputBytes) {
            state.overflow = true
            termination ??= { reason: 'output-limit', phase: 'running' }
            abort.abort()
            continue
          }
          output[kind].push(chunk)
          if (kind === 'stdout') spec.onStdout?.(decoder.write(chunk))
        }
        if (kind === 'stdout') {
          const tail = decoder.end()
          if (tail !== '') spec.onStdout?.(tail)
        }
      }
      const { stdout, stderr } = handle
      if (stdout === undefined || stderr === undefined) throw new Error('DeepCluster subprocess provider did not supply requested pipes')
      readers = [capture(stdout, 'stdout'), capture(stderr, 'stderr')]
        .map(promise => promise.catch((error: unknown) => {
          state.streamFailure = error instanceof Error ? error : new Error(String(error))
          abort.abort()
        }))
      const outcome = await handle.done
      directSettled = true
      handle.terminate()
      cleanupAttempted = true
      await confirmCleanup()
      await Promise.all(readers)
      if (state.streamFailure !== undefined) throw state.streamFailure
      const ended = terminationState()
      if (ended !== undefined) throw new WorkerTerminationError(ended.reason, ended.phase)
      const diagnostic = state.overflow ? '\nDeepCluster output byte limit exceeded.' : ''
      return {
        code: state.timedOut ? 124 : spec.signal?.aborted ? 130 : state.overflow ? 1 : outcome.exitCode ?? 1,
        signal: outcome.signal,
        stdout: Buffer.concat(output.stdout).toString('utf8'),
        stderr: Buffer.concat(output.stderr).toString('utf8') + diagnostic,
      }
    } catch (error) {
      failure = error
      const ended = terminationState()
      if (!(error instanceof ProcessCleanupError) && ended !== undefined) {
        throw new WorkerTerminationError(ended.reason, ended.phase, { cause: error })
      }
      throw error
    } finally {
      clearTimeout(timer)
      spec.signal?.removeEventListener('abort', cancel)
      if (handle !== undefined) {
        try {
          if (!cleanupAttempted) {
            handle.terminate()
            await confirmCleanup()
          }
        } catch (error) {
          throw error instanceof ProcessCleanupError
            ? error
            : new ProcessCleanupError('Worker cleanup is unconfirmed; keep its hardware leases quarantined.', { cause: failure ?? error })
        } finally {
          handle.stdout?.destroy()
          handle.stderr?.destroy()
          await Promise.all(readers)
        }
      }
    }
  }
}

/**
 * Execute one handoff against a DSH profile.
 * @param options - resolved DeepCluster settings.
 * @param request - what to execute.
 * @param runner - managed subprocess implementation owned by the mounted service.
 * @returns the outcome, including the exact command line for logging.
 */
export async function runHandoff(
  options: DeepClusterOptions,
  request: HandoffRequest,
  runner: ProcessRunner,
): Promise<HandoffResult> {
  const prompt = buildPrompt(request)
  const profile = request.profile?.trim() || options.profile
  const cwd = path.resolve(request.cwd ?? process.cwd())
  const timeoutMs = request.timeoutMs ?? options.timeoutMs
  const { command, prefixArgs } = resolveInvocation(options.cliPath)
  const args = [...prefixArgs, '--profile', profile]
  if (request.policyFile !== undefined) args.push('--patch', fileURLToPath(new URL('../policy.patch.yml', import.meta.url)))
  const nativeSession = request.nativeSession
  if (nativeSession !== undefined) {
    switch (nativeSession.mode) {
      case 'create': args.push('--new-session-id', nativeSession.id); break
      case 'resume': args.push('--session-id', nativeSession.id); break
      default: assertNever(nativeSession.mode, 'DeepCluster native Session mode')
    }
  }
  if (request.json === true) args.push('--json')
  args.push(prompt)
  const started = Date.now()
  const result = await runner({
    command,
    args,
    cwd,
    timeoutMs,
    ...request.signal === undefined ? {} : { signal: request.signal },
    ...request.onStdout === undefined ? {} : { onStdout: request.onStdout },
    env: { ...childEnvironment({ ...process.env, ...request.env }, request.permissionMode ?? options.permissionMode),
      ...request.policyFile === undefined ? {} : { DSH_DEEP_CLUSTER_POLICY_FILE: request.policyFile } },
  })
  return {
    ok: result.code === 0,
    exitCode: result.code,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: Date.now() - started,
    command: [command, ...args.map(quote)].join(' '),
  }
}

/** Quote one argument for display only; never re-parsed. */
function quote(value: string): string {
  return /[\s"]/u.test(value) ? JSON.stringify(value) : value
}
