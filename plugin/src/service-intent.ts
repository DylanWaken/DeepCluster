/** Durable lifecycle mutation ownership with exact-controller and native-range recovery. */
import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { link, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { SubprocessRangeReceipt } from '@deepseek-ai/dsh-subprocess'
import { inspectProcessIdentity, sameProcessStart, type ProcessIdentity } from './process-identity.ts'
import { inspectWindowsBoot, predatesWindowsBoot, type WindowsBootEvidence } from './boot-recovery.ts'
import { parseOwnershipGeneration, recoverWorkerGeneration, WorkerRecoveryStore } from './worker-recovery.ts'

const intentSchema = z.object({ version: z.literal(1), id: z.uuid(), action: z.string().min(1), createdAt: z.iso.datetime(),
  controller: z.object({ pid: z.number().int().positive(), startTime: z.string().min(1), commandLine: z.string() }),
  settled: z.boolean().optional(),
  commands: z.object({ version: z.literal(1), stateDirectory: z.string().refine(value => path.isAbsolute(value)),
    generation: z.uuid(), complete: z.boolean() }).strict().optional() }).strict()
export type ServiceMutationIntent = z.infer<typeof intentSchema>

/** Injectable storage and process identity for isolated lifecycle tests. */
interface MutationOptions {
  readonly file?: string
  readonly inspectController?: () => Promise<ProcessIdentity | null>
  /** Native executor must await receipt persistence before starting the target command. */
  readonly managedCommands?: (script: string, persistReceipt: (receipt: SubprocessRangeReceipt) => Promise<void>) => Promise<string>
  /** Only callbacks that cannot create child processes may declare this scope. */
  readonly processScope?: 'in-process'
}
interface MutationTransaction {
  readonly action: string
  readonly options: MutationOptions
  intent?: Promise<ServiceMutationIntent>
  commands?: WorkerRecoveryStore
  settled: boolean
}
const transactions = new AsyncLocalStorage<MutationTransaction>()

/** One user-wide marker complements the machine-wide lifecycle pipe across saved configurations. */
export function serviceMutationIntentPath(): string { return path.join(homedir(), '.deep-cluster', 'service-mutation.json') }

/** Read retained uncertainty; invalid or unreadable metadata is never treated as absent. */
export async function readServiceMutationIntent(file = serviceMutationIntentPath()): Promise<ServiceMutationIntent | null> {
  try { return intentSchema.parse(JSON.parse(await readFile(file, 'utf8'))) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error(`Cannot inspect pending service mutation ${file}; preserve it and inspect the controller and its descendants.`, { cause: error })
  }
}

/** Refuse any subsequent mutation until the exact pending intent is recovered. */
export async function assertNoPendingServiceMutation(file = serviceMutationIntentPath()): Promise<void> {
  const pending = await readServiceMutationIntent(file)
  if (pending !== null) throw new Error(`DeepCluster service mutation ${pending.id} (${pending.action}) from controller PID ${String(pending.controller.pid)} did not confirm completion. Preserve ${file}; inspect its controller and descendants with \`service recover-controller --dry-run\`, then only after confirming they stopped use \`service recover-controller --confirm-controller-intent ${pending.id}\`. No new mutation was started.`)
}

/**
 * Publish intent lazily before the first external effect. Within a lifecycle transaction,
 * the marker remains until the entire action verifies readiness and records ownership.
 * Unsettled failure or controller death leaves evidence for recovery.
 * The caller must own the lifecycle pipe throughout this operation.
 */
export async function withServiceMutationIntent<T>(action: string, run: () => Promise<T>, options: MutationOptions = {}): Promise<T> {
  const transaction = transactions.getStore()
  if (transaction === undefined) {
    return await withServiceMutationTransaction(action, () => withServiceMutationIntent(action, run, options), options)
  }
  await prepareMutation(transaction, options.processScope === 'in-process')
  return await run()
}

/** Revoke settlement and record any untracked process authority before the effect starts. */
async function prepareMutation(transaction: MutationTransaction, tracked: boolean): Promise<void> {
  transaction.intent ??= publishIntent(transaction)
  const intent = await transaction.intent
  if (intent.settled === true || (!tracked && intent.commands?.complete === true)) {
    const updated: ServiceMutationIntent = { ...intent, settled: false,
      ...(!tracked && intent.commands !== undefined ? { commands: { ...intent.commands, complete: false } } : {}) }
    const pending = replaceIntent(transaction.options.file ?? serviceMutationIntentPath(), intent, updated)
    transaction.intent = pending
    await pending
  }
  transaction.settled = false
}

/**
 * Execute one lifecycle PowerShell command with durable native process ownership when configured.
 * Fallback execution cannot establish complete command recovery for the transaction.
 * @param action - diagnostic name used when no lifecycle transaction exists.
 * @param script - complete PowerShell command text.
 * @param fallback - existing executor for callers without managed command support.
 * @returns the executor's standard output after command settlement.
 */
export async function runServiceMutationCommand(action: string, script: string,
  fallback: (script: string) => Promise<string>): Promise<string> {
  const transaction = transactions.getStore()
  if (transaction?.options.managedCommands === undefined) {
    return await withServiceMutationIntent(action, () => fallback(script))
  }
  await prepareMutation(transaction, true)
  const commands = transaction.commands
  if (commands === undefined) throw new Error('Managed service command ownership was not initialized; no command was started.')
  return await transaction.options.managedCommands(script, receipt => commands.persist(receipt))
}

/**
 * Attest that every effect of the current lifecycle action has settled, including rollback.
 * The caller must await worker teardown, external commands, and ownership reconciliation first.
 * A later external effect revokes this attestation; without a transaction this has no effect.
 * @returns after the exact intent records settlement durably.
 */
export async function markServiceMutationSettled(): Promise<void> {
  const transaction = transactions.getStore()
  if (transaction === undefined) return
  if (transaction.intent !== undefined) {
    const intent = await transaction.intent
    const settled = replaceIntent(transaction.options.file ?? serviceMutationIntentPath(), intent, { ...intent, settled: true })
    transaction.intent = settled
    await settled
  }
  transaction.settled = true
}

/**
 * Keep one lazy intent through all subcommands, readiness probes and state persistence.
 * A healthy reuse or preflight refusal creates no marker because it performs no external effect.
 * A failed action retires its marker only after durable settlement; retirement failure preserves both errors.
 * The caller must hold the lifecycle pipe; nested transactions are forbidden.
 */
export async function withServiceMutationTransaction<T>(action: string, run: () => Promise<T>, options: MutationOptions = {}): Promise<T> {
  if (transactions.getStore() !== undefined) throw new Error('Nested service mutation transactions are not supported.')
  const file = options.file ?? serviceMutationIntentPath()
  await assertNoPendingServiceMutation(file)
  const transaction: MutationTransaction = { action, options, settled: false }
  return await transactions.run(transaction, async () => {
    let result: T
    try { result = await run() } catch (error) {
      if (transaction.settled && transaction.intent !== undefined) {
        try { await retireIntent(file, await transaction.intent) } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'Service action failed and its settled intent could not be retired.', { cause: error })
        }
      }
      throw error
    }
    if (transaction.intent !== undefined) await retireIntent(file, await transaction.intent)
    return result
  })
}

/** Move an unchanged intent without overwriting a newer owner's marker or earlier evidence. */
async function quarantineIntent(file: string, expected: ServiceMutationIntent, suffix: string): Promise<string> {
  const identity = await stat(file, { bigint: true })
  if (!isDeepStrictEqual(await readServiceMutationIntent(file), expected)) {
    throw new Error('Service mutation intent changed; the replacement was preserved.')
  }
  const quarantineFile = `${file}.${suffix}-${expected.id}-${randomUUID()}`
  await rename(file, quarantineFile)
  const moved = await stat(quarantineFile, { bigint: true })
  if (identity.dev !== moved.dev || identity.ino !== moved.ino) {
    throw new Error(`A replacement intent was quarantined at ${quarantineFile}; it was preserved and no new mutation was started.`)
  }
  return quarantineFile
}

/** Remove only the unchanged, settled marker after it leaves the admission path. */
async function retireIntent(file: string, expected: ServiceMutationIntent): Promise<void> {
  const settledFile = await quarantineIntent(file, expected, 'settled')
  await unlink(settledFile)
}

/** Persist recovery evidence without changing the intent identity; caller owns the lifecycle pipe. */
async function replaceIntent(file: string, expected: ServiceMutationIntent,
  updated: ServiceMutationIntent): Promise<ServiceMutationIntent> {
  const temporary = `${file}.${expected.id}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try { await handle.writeFile(JSON.stringify(updated)); await handle.sync() } finally { await handle.close() }
  try {
    const identity = await stat(file, { bigint: true })
    if (!isDeepStrictEqual(await readServiceMutationIntent(file), expected)) {
      throw new Error('Service mutation intent changed; the replacement was preserved.')
    }
    const current = await stat(file, { bigint: true })
    if (identity.dev !== current.dev || identity.ino !== current.ino) {
      throw new Error('Service mutation intent changed; the replacement was preserved.')
    }
    await rename(temporary, file)
  } finally {
    try { await unlink(temporary) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return updated
}

/**
 * Recover settled work, previous-boot effects, or complete recorded native command ranges.
 * The caller must hold the lifecycle pipe. Live matching controllers and untracked current-boot
 * effects retain the marker. Native recovery targets recorded capabilities, never PIDs.
 * @param options - private marker location and injectable host observations.
 * @returns the quarantined intent and proof, or null when no pending marker exists.
 */
export async function recoverStaleServiceMutation(options: {
  readonly file?: string
  readonly inspectBoot?: () => Promise<WindowsBootEvidence>
  readonly inspectProcess?: (pid: number) => Promise<ProcessIdentity | null>
  readonly recoverRange?: (receipt: SubprocessRangeReceipt, signal?: AbortSignal) => Promise<void>
  readonly signal?: AbortSignal
} = {}): Promise<{ quarantineFile: string; proof: 'settled' | 'previous-boot' | 'commands'; intent: ServiceMutationIntent } | null> {
  const file = options.file ?? serviceMutationIntentPath()
  const intent = await readServiceMutationIntent(file)
  if (intent === null) return null
  const inspectBoot = options.inspectBoot ?? inspectWindowsBoot
  const inspectProcess = options.inspectProcess ?? inspectProcessIdentity
  if (sameProcessStart(intent.controller, await inspectProcess(intent.controller.pid))) {
    throw new Error('The mutation controller is still running; its marker was preserved.')
  }
  let proof: 'settled' | 'previous-boot' | 'commands' = 'settled'
  if (intent.settled !== true) {
    if (intent.commands?.complete === true && options.recoverRange !== undefined) {
      if (intent.commands.generation !== intent.id) throw new Error('Service command recovery generation does not match the controller intent; the marker was preserved.')
      if (!isDeepStrictEqual(await readServiceMutationIntent(file), intent)
        || sameProcessStart(intent.controller, await inspectProcess(intent.controller.pid))) {
        throw new Error('Service controller ownership changed before command recovery; the marker was preserved.')
      }
      await recoverWorkerGeneration(intent.commands.stateDirectory, parseOwnershipGeneration(intent.commands.generation),
        options.recoverRange, options.signal)
      proof = 'commands'
    } else {
      const boot = await inspectBoot()
      if (!predatesWindowsBoot(intent.createdAt, boot) || !predatesWindowsBoot(intent.controller.startTime, boot)) {
        throw new Error('The pending service mutation has no confirmed settlement, previous-boot proof, or complete native command ownership; its marker was preserved.')
      }
      const currentBoot = await inspectBoot()
      if (boot.startedAt !== currentBoot.startedAt
        || !predatesWindowsBoot(intent.createdAt, currentBoot) || !predatesWindowsBoot(intent.controller.startTime, currentBoot)) {
        throw new Error('Windows boot evidence changed during service recovery; the intent was preserved.')
      }
      proof = 'previous-boot'
    }
  }
  if (sameProcessStart(intent.controller, await inspectProcess(intent.controller.pid))) {
    throw new Error('The mutation controller became live during recovery; its marker was preserved.')
  }
  const quarantineFile = await quarantineIntent(file, intent, proof)
  return { quarantineFile, proof, intent }
}

/** Publish complete metadata exclusively before the first external command can start. */
async function publishIntent(transaction: MutationTransaction): Promise<ServiceMutationIntent> {
  const { action, options } = transaction
  const file = options.file ?? serviceMutationIntentPath()
  const controller = await (options.inspectController ?? (() => inspectProcessIdentity(process.pid)))()
  if (controller === null) throw new Error('Cannot prove the lifecycle controller identity; no external mutation was started.')
  const id = randomUUID()
  const stateDirectory = path.join(path.dirname(file), 'service-command-state')
  if (options.managedCommands !== undefined) {
    transaction.commands = await WorkerRecoveryStore.create(stateDirectory, parseOwnershipGeneration(id))
  }
  const intent: ServiceMutationIntent = { version: 1, id, action, createdAt: new Date().toISOString(), controller,
    ...(transaction.commands === undefined ? {} : { commands: { version: 1, stateDirectory, generation: id, complete: true } }) }
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${intent.id}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try { await handle.writeFile(JSON.stringify(intent)); await handle.sync() } finally { await handle.close() }
  // Link publishes a complete marker exclusively; it cannot overwrite retained evidence.
  try { await link(temporary, file) } finally { await unlink(temporary) }
  return intent
}

/**
 * Quarantine one operator-confirmed interrupted mutation after its controller is gone.
 * The operator must additionally verify the external command and descendants stopped;
 * this command does not infer their absence from a dead controller or elapsed time.
 * The caller must own the lifecycle pipe.
 */
export async function recoverServiceMutationIntent(confirmId: string, options: {
  readonly file?: string
  readonly inspectProcess?: (pid: number) => Promise<ProcessIdentity | null>
} = {}): Promise<{ quarantineFile: string; proof: 'operator-confirmed'; intent: ServiceMutationIntent }> {
  const file = options.file ?? serviceMutationIntentPath()
  const intent = await readServiceMutationIntent(file)
  if (intent === null || intent.id !== confirmId) throw new Error('Controller intent confirmation does not match the pending mutation; nothing changed.')
  const live = await (options.inspectProcess ?? inspectProcessIdentity)(intent.controller.pid)
  if (sameProcessStart(intent.controller, live)) throw new Error('The mutation controller is still running; wait for it or inspect its process before recovery.')
  const quarantineFile = await quarantineIntent(file, intent, 'recovered')
  return { quarantineFile, proof: 'operator-confirmed', intent }
}
