/** Durable scheduled-service launch identity, process registration, and native range recovery. */

import { createHash, randomUUID } from 'node:crypto'
import { link, lstat, mkdir, open, readdir, readFile, unlink } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { z } from 'zod'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { parseSubprocessRangeReceipt } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessRangeReceipt, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { inspectProcessIdentity, runPowerShell, sameProcessIdentity, type ProcessIdentity } from './process-identity.ts'
import { parseServiceTaskInstanceId, type ServiceTaskInstanceId } from './service-task-observation.ts'
import { runServiceMutationCommand } from './service-intent.ts'

/** One immutable launch admitted before Task Scheduler is changed. */
export type ServiceLaunchId = Branded<'DeepClusterServiceLaunchId'>

const absolute = z.string().refine(value => path.isAbsolute(value), 'expected an absolute path')
const processSchema = z.object({ pid: z.number().int().positive(),
  startTime: z.string().refine(value => Number.isFinite(Date.parse(value))),
  commandLine: z.string().min(1) }).strict()
const invocationSchema = z.object({ argv: z.tuple([z.string().min(1)]).rest(z.string()), cwd: absolute,
  env: z.record(z.string(), z.string()), graceMs: z.number().int().nonnegative() }).strict()
const launchSchema = z.object({ version: z.literal(1), id: z.uuid().transform(value => value as ServiceLaunchId),
  kind: z.enum(['api', 'dashboard']), taskName: z.string().min(1), commandFile: absolute, logFile: absolute,
  commandHash: z.string().regex(/^[0-9a-f]{64}$/u), createdAt: z.iso.datetime(), invocation: invocationSchema }).strict()

/** Exact target request retained before the scheduled host may start. */
export type ServiceLaunchInvocation = z.infer<typeof invocationSchema>
/** Immutable launcher, target request, and scheduler action identity. */
export type ServiceLaunchRecord = z.infer<typeof launchSchema>
/** Inputs whose command-file digest and unique identity are supplied by the store. */
export type ServiceLaunchInput = Pick<ServiceLaunchRecord, 'kind' | 'taskName' | 'commandFile' | 'logFile' | 'invocation'>
/** Observations retained separately so interruption never overwrites launch identity. */
export interface ServiceLaunchEvidence {
  readonly launch: ServiceLaunchRecord
  readonly host: ProcessIdentity | null
  readonly owner: ProcessIdentity | null
  readonly range: SubprocessRangeReceipt | null
  readonly instanceId: ServiceTaskInstanceId | null
  readonly cancelled: boolean
  readonly settled: boolean
  readonly recovered: boolean
}

async function readJSON(file: string): Promise<unknown> {
  const entry = await lstat(file)
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`Service launch record must be a physical file: ${file}`)
  const value: unknown = JSON.parse(await readFile(file, 'utf8'))
  return value
}

const MISSING = Symbol('missing service launch record')

async function optionalJSON(file: string): Promise<unknown> {
  try { return await readJSON(file) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return MISSING
    throw error
  }
}

/** Publish a complete flushed record without replacing an earlier writer's evidence. */
async function publish(file: string, value: unknown, existing: 'same' | 'preserve' | 'reject' = 'same'): Promise<void> {
  const text = `${JSON.stringify(value)}\n`
  const temporary = `${file}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try { await handle.writeFile(text); await handle.sync() } finally { await handle.close() }
  try {
    try { await link(temporary, file) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (existing === 'preserve') return
      if (existing === 'reject' || JSON.stringify(await readJSON(file)) !== JSON.stringify(value)) {
        throw new Error(`Service launch evidence already exists with different ownership: ${file}`, { cause: error })
      }
    }
  } finally { await unlink(temporary) }
}

function sidecar(file: string, kind: string): string { return `${file}.${kind}.json` }

/**
 * Persist the launch request after writing its command file and before scheduler mutation.
 * @param file - absolute private per-run launch JSON path.
 * @param input - exact scheduler action and target invocation.
 * @returns the complete immutable launch record.
 */
export async function createServiceLaunch(file: string, input: ServiceLaunchInput): Promise<ServiceLaunchRecord> {
  absolute.parse(file)
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const launch = launchSchema.parse({ version: 1, id: randomUUID(), createdAt: new Date().toISOString(), ...input,
    commandHash: createHash('sha256').update(await readFile(input.commandFile)).digest('hex') })
  await publish(file, launch)
  return launch
}

/**
 * Read the immutable launch and reject changes to its scheduled command file.
 * @param file - private launch JSON path.
 * @returns validated launch fields whose command file still matches its recorded digest.
 */
export async function readServiceLaunch(file: string): Promise<ServiceLaunchRecord> {
  const launch = launchSchema.parse(await readJSON(file))
  if (createHash('sha256').update(await readFile(launch.commandFile)).digest('hex') !== launch.commandHash) {
    throw new Error(`Service launch command changed: ${launch.commandFile}`)
  }
  return launch
}

/**
 * Find retained launch records without deleting older runs or diagnostic files.
 * @param serviceDirectory - controller's private service directory.
 * @param reportIssue - retain a damaged historical entry and continue independent launches; omission rejects it.
 * @returns per-run launch paths and validated immutable records.
 */
export async function listServiceLaunches(serviceDirectory: string,
  reportIssue?: (file: string, error: unknown) => void,
): Promise<Array<{ file: string; launch: ServiceLaunchRecord }>> {
  const root = path.join(serviceDirectory, 'runs')
  let names: string[]
  try { names = await readdir(root) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const launches: Array<{ file: string; launch: ServiceLaunchRecord }> = []
  for (const name of names.sort()) {
    const directory = path.join(root, name)
    const file = path.join(directory, 'launch.json')
    try {
      const entry = await lstat(directory)
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      if (await optionalJSON(file) !== MISSING) launches.push({ file, launch: await readServiceLaunch(file) })
    } catch (error) {
      if (reportIssue === undefined) throw error
      reportIssue(file, error)
    }
  }
  return launches
}

/**
 * Retain the exact scheduler instance when Run returned to the controller.
 * @param file - admitted launch JSON path.
 * @param instanceId - validated Task Scheduler invocation identity.
 */
export async function recordServiceLaunchInstance(file: string, instanceId: ServiceTaskInstanceId): Promise<void> {
  const launch = await readServiceLaunch(file)
  await publish(sidecar(file, 'instance'), { launchId: launch.id, instanceId })
}

/**
 * Register the scheduled host or service process before it admits work.
 * @param file - launch JSON path passed by the supported launcher.
 * @param role - host wrapper or actual API/dashboard process.
 * @param inspect - process identity reader; production inspects the calling process.
 */
export async function registerServiceLaunchProcess(file: string, role: 'host' | 'owner',
  inspect: () => Promise<ProcessIdentity | null> = () => inspectProcessIdentity(process.pid)): Promise<void> {
  const launch = await readServiceLaunch(file)
  const owner = await inspect()
  if (owner === null) throw new Error('Cannot record the scheduled service process identity')
  await publish(sidecar(file, role), { launchId: launch.id, owner: processSchema.parse(owner) }, role === 'host' ? 'reject' : 'same')
}

/**
 * Read independently committed launch facts; malformed or mismatched records fail closed.
 * @param file - admitted launch JSON path.
 * @returns stored facts; process liveness and service readiness require fresh host observations.
 */
export async function readServiceLaunchEvidence(file: string): Promise<ServiceLaunchEvidence> {
  const launch = await readServiceLaunch(file)
  const envelope = z.object({ launchId: z.literal(launch.id) })
  const owner = async (kind: 'host' | 'owner'): Promise<ProcessIdentity | null> => {
    const value = await optionalJSON(sidecar(file, kind))
    if (value === MISSING) return null
    if (kind === 'host') {
      const host = z.union([envelope.extend({ owner: processSchema }).strict(),
        envelope.extend({ closed: z.literal(true) }).strict()]).parse(value)
      return 'owner' in host ? host.owner : null
    }
    return envelope.extend({ owner: processSchema }).strict().parse(value).owner
  }
  const range = await optionalJSON(sidecar(file, 'range'))
  const instance = await optionalJSON(sidecar(file, 'instance'))
  const cancelled = await optionalJSON(sidecar(file, 'cancelled'))
  const settled = await optionalJSON(sidecar(file, 'settled'))
  const recovered = await optionalJSON(sidecar(file, 'recovered'))
  if (cancelled !== MISSING) envelope.strict().parse(cancelled)
  if (settled !== MISSING) envelope.extend({ exitCode: z.number().int() }).strict().parse(settled)
  if (recovered !== MISSING) envelope.extend({ task: z.enum(['stopped', 'missing', 'replaced']) }).strict().parse(recovered)
  return { launch, host: await owner('host'), owner: await owner('owner'),
    range: range === MISSING ? null : parseSubprocessRangeReceipt(envelope.extend({ receipt: z.unknown() }).strict().parse(range).receipt),
    instanceId: instance === MISSING ? null
      : parseServiceTaskInstanceId(envelope.extend({ instanceId: z.string() }).strict().parse(instance).instanceId),
    cancelled: cancelled !== MISSING, settled: settled !== MISSING, recovered: recovered !== MISSING }
}

/**
 * Run one persistent API or dashboard through the supported profile's native provider.
 * @param file - immutable launch JSON admitted before Task Scheduler was changed.
 * @param subprocess - provider capable of durable native range recovery.
 * @param signal - requests target teardown and waits for its native range to settle.
 * @param inspectSelf - process identity inspection; tests supply a deterministic host identity.
 * @returns the target exit code after confirmed descendant cleanup.
 */
export async function runServiceHost(file: string, subprocess: Pick<SubprocessRuntime, 'spawnRecoverable'>, signal: AbortSignal,
  inspectSelf: () => Promise<ProcessIdentity | null> = () => inspectProcessIdentity(process.pid)): Promise<number> {
  const evidence = await readServiceLaunchEvidence(file)
  if (evidence.cancelled) throw new Error('This scheduled service launch was cancelled')
  if (evidence.host !== null || evidence.range !== null || evidence.settled) throw new Error('This scheduled service launch has already been consumed')
  await registerServiceLaunchProcess(file, 'host', inspectSelf)
  const launch = evidence.launch
  const environment: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !['DSH_PROFILE', 'DEEPCLUSTER_SERVICE_LAUNCH_FILE'].includes(name.toUpperCase())) environment[name] = value
  }
  const handle = subprocess.spawnRecoverable({ ...launch.invocation, signal,
    env: { ...environment, ...launch.invocation.env, DEEPCLUSTER_SERVICE_LAUNCH_FILE: file },
    stdio: { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' } }, async (receipt) => {
    await publish(sidecar(file, 'range'), { launchId: launch.id, receipt })
    if ((await readServiceLaunchEvidence(file)).cancelled) throw new Error('This scheduled service launch was cancelled before target start')
  })
  let exitCode: number
  try { exitCode = (await handle.done).exitCode ?? 1 } finally {
    try { handle.terminate() } finally {
      if (!await handle.waitForExit()) throw new Error('Scheduled service native range did not confirm cleanup')
    }
  }
  await publish(sidecar(file, 'settled'), { launchId: launch.id, exitCode })
  return exitCode
}

/** Scheduler adapter for exact scheduled-launch cancellation. */
export interface ServiceLaunchCancellationDependencies {
  readonly run: (script: string) => Promise<string>
  readonly systemRoot: string | undefined
  readonly inspectProcess?: (pid: number) => Promise<ProcessIdentity | null>
}

function literal(value: string): string { return `'${value.replace(/'/gu, "''")}'` }

async function stopLaunchTask(evidence: ServiceLaunchEvidence, dependencies: ServiceLaunchCancellationDependencies): Promise<'stopped' | 'missing' | 'replaced'> {
  const { launch, instanceId } = evidence
  if (dependencies.systemRoot === undefined) throw new Error('Cannot verify the scheduled service action without SystemRoot')
  const output = await dependencies.run(`$ErrorActionPreference='Stop'
$scheduler=New-Object -ComObject Schedule.Service
$scheduler.Connect()
try { $task=$scheduler.GetFolder('\\').GetTask(${literal(launch.taskName)}) } catch {
  if ($_.Exception.HResult -eq -2147024894 -or $_.Exception.HResult -eq -2147024893) { [Console]::Write('missing'); exit 0 }; throw
}
$actions=@($task.Definition.Actions)
if ($actions.Count -ne 1 -or [string]$actions[0].Path -ine ${literal(path.win32.join(dependencies.systemRoot, 'System32', 'conhost.exe'))} -or [string]$actions[0].Arguments -cne ${literal(`--headless cmd.exe /d /c "${launch.commandFile}"`)}) { [Console]::Write('replaced'); exit 0 }
$instances=@($task.GetInstances(0))
${instanceId === null ? '' : `foreach ($instance in $instances) { if (([string]$instance.InstanceGuid).Trim('{}') -ine ${literal(instanceId)}) { [Console]::Write('replaced'); exit 0 } }`}
foreach ($instance in $instances) { $instance.Stop() }
while (@($task.GetInstances(0) | Where-Object { $instances.InstanceGuid -contains $_.InstanceGuid }).Count -gt 0) { Start-Sleep -Milliseconds 50 }
[Console]::Write('stopped')`)
  return z.enum(['stopped', 'missing', 'replaced']).parse(output.trim())
}

/**
 * Revoke future target start, then settle any native range already published by the host.
 * The lifecycle owner must also stop the exact scheduled action before replacing it.
 * A registered host is joined before a late receipt is re-read; its callback cannot authorize target start after cancellation.
 * @param file - admitted launch JSON path.
 * @param recoverRange - native recovery operation that resolves only for an absent or empty range.
 * @param signal - cancels recovery without declaring the launch settled.
 * @param dependencies - owned PowerShell executor and Windows directory used to verify the scheduler action.
 * @returns the scheduler outcome; a replaced task is preserved while the original native range is settled.
 */
export async function cancelServiceLaunch(file: string,
  recoverRange: (receipt: SubprocessRangeReceipt, signal?: AbortSignal) => Promise<void>, signal?: AbortSignal,
  dependencies: ServiceLaunchCancellationDependencies = {
    run: script => runServiceMutationCommand('stop scheduled service launch', script, runPowerShell),
    systemRoot: process.env.SystemRoot,
  }): Promise<{ task: 'stopped' | 'missing' | 'replaced'; recovered: true }> {
  const launch = await readServiceLaunch(file)
  const recovered = await optionalJSON(sidecar(file, 'recovered'))
  if (recovered !== MISSING) {
    const previous = z.object({ launchId: z.literal(launch.id), task: z.enum(['stopped', 'missing', 'replaced']) }).strict().parse(recovered)
    return { task: previous.task, recovered: true }
  }
  await publish(sidecar(file, 'cancelled'), { launchId: launch.id })
  // Registration and cancellation compete for one immutable admission record.
  await publish(sidecar(file, 'host'), { launchId: launch.id, closed: true }, 'preserve')
  const task = await stopLaunchTask(await readServiceLaunchEvidence(file), dependencies)
  let recoveredRange: string | undefined
  for (;;) {
    signal?.throwIfAborted()
    const evidence = await readServiceLaunchEvidence(file)
    if (evidence.range !== null && evidence.range.jobName !== recoveredRange) {
      await recoverRange(evidence.range, signal)
      recoveredRange = evidence.range.jobName
    }
    if (evidence.host === null || !sameProcessIdentity(evidence.host,
      await (dependencies.inspectProcess ?? inspectProcessIdentity)(evidence.host.pid))) break
    await setTimeout(10, undefined, { signal })
  }
  const final = await readServiceLaunchEvidence(file)
  if (final.range !== null && final.range.jobName !== recoveredRange) await recoverRange(final.range, signal)
  await publish(sidecar(file, 'recovered'), { launchId: launch.id, task })
  return { task, recovered: true }
}
