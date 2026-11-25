/** Read-only startup observation for one Task Scheduler instance; exit never proves descendant cleanup. */
import { open } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { runPowerShell } from './process-identity.ts'

/** Exact Windows Task Scheduler invocation identity. */
export type ServiceTaskInstanceId = Branded<'DeepClusterServiceTaskInstanceId'>

/** Controller-owned launch identity and private diagnostic file. */
export interface ServiceTaskLaunch {
  readonly kind: 'api' | 'dashboard'
  readonly taskName: string
  readonly instanceId: ServiceTaskInstanceId
  readonly commandFile: string
  readonly logFile: string
}

/** Startup conditions that stop readiness polling without asserting safe retry or worker exit. */
export type ServiceStartupFailure = 'startup-exited' | 'startup-task-missing' | 'startup-task-replaced' | 'startup-observation-unavailable'

/** A service cannot become ready through the observed task instance. */
export class ServiceStartupError extends Error {
  override readonly name = 'DeepClusterServiceStartupError'
  /**
   * @param code - startup refusal class.
   * @param launch - exact invocation the controller admitted.
   * @param taskResult - scheduler's most recent task result, or null when unavailable; it is not an instance exit proof.
   * @param logTail - bounded URL-redacted complete log lines, or null when the log cannot be read.
   * @param cause - internal observation failure; omitted when the scheduler returned a usable observation.
   */
  constructor(readonly code: ServiceStartupFailure, readonly launch: ServiceTaskLaunch,
    readonly taskResult: number | null, readonly logTail: string | null, cause?: unknown) {
    const detail: Record<ServiceStartupFailure, string> = {
      'startup-exited': 'its scheduled task instance ended before readiness',
      'startup-task-missing': 'its scheduled task is missing',
      'startup-task-replaced': 'its scheduled task action changed',
      'startup-observation-unavailable': 'its scheduled task state could not be verified',
    }
    super(`DeepCluster ${launch.kind} startup failed: ${detail[code]}. Inspect the retained launch log and ownership before retrying; descendant cleanup is not confirmed.`
      + (logTail === null || logTail === '' ? '' : `\n${logTail}`), { cause })
  }
}

/**
 * Validate the Scheduler's returned instance GUID before retaining launch identity.
 * @param value - a plain UUID or the brace-delimited GUID emitted by Task Scheduler.
 * @returns normalized, branded invocation identity; malformed output throws.
 */
export function parseServiceTaskInstanceId(value: unknown): ServiceTaskInstanceId {
  const text = z.string().parse(value).trim()
  const unwrapped = text.startsWith('{') && text.endsWith('}') ? text.slice(1, -1) : text
  return z.uuid().parse(unwrapped).toLowerCase() as ServiceTaskInstanceId
}

const observationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('missing') }).strict(),
  z.object({ kind: z.literal('unavailable') }).strict(),
  z.object({ kind: z.literal('observed'),
    actions: z.array(z.object({ execute: z.string(), arguments: z.string() }).strict()),
    instances: z.array(z.object({ id: z.string(), state: z.number().int() }).strict()),
    lastTaskResult: z.number().int(),
  }).strict(),
])

/** Diagnostic output limits prevent a failed startup from returning an unbounded service log. */
const LOG_READ_BYTES = 8192, LOG_TAIL_CHARS = 4096

function literal(value: string): string { return `'${value.replace(/'/gu, "''")}'` }

function observationScript(taskName: string): string {
  return `$ErrorActionPreference = 'Stop'
$scheduler = New-Object -ComObject Schedule.Service
$scheduler.Connect()
try { $task = $scheduler.GetFolder('\\').GetTask(${literal(taskName)}) } catch {
  if ($_.Exception.HResult -eq -2147024894 -or $_.Exception.HResult -eq -2147024893) {
    @{kind='missing'} | ConvertTo-Json -Compress
  } else { @{kind='unavailable'} | ConvertTo-Json -Compress }
  exit 0
}
$actions = @($task.Definition.Actions | ForEach-Object { @{execute=[string]$_.Path; arguments=[string]$_.Arguments} })
$instances = @($task.GetInstances(0) | ForEach-Object { @{id=[string]$_.InstanceGuid; state=[int]$_.State} })
@{kind='observed'; actions=$actions; instances=$instances; lastTaskResult=[long]$task.LastTaskResult} | ConvertTo-Json -Depth 4 -Compress`
}

/** Discard a partial first line so a cropped login URL cannot escape URL redaction. */
async function startupLog(file: string): Promise<string | null> {
  try {
    const handle = await open(file, 'r')
    try {
      const size = (await handle.stat()).size, offset = Math.max(0, size - LOG_READ_BYTES)
      const buffer = Buffer.alloc(Math.min(size, LOG_READ_BYTES))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
      let text = buffer.subarray(0, bytesRead).toString('utf8')
      if (offset > 0) {
        const newline = text.indexOf('\n')
        text = newline < 0 ? '' : text.slice(newline + 1)
      }
      return text.replace(/https?:\/\/[^\s<>"']+/giu, '<redacted-url>')
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '').slice(-LOG_TAIL_CHARS).trim()
    } finally { await handle.close() }
  } catch (_error) {
    // Log access is diagnostic only; the verified startup failure remains reportable without it.
    return null
  }
}

interface ObservationDependencies {
  readonly runPowerShell: (script: string) => Promise<string>
  readonly systemRoot: string | undefined
}

/**
 * Inspect the exact scheduled invocation while its service is not yet ready.
 * An absent instance fails immediately, even when the task's result is zero. This
 * does not authorize recovery, terminate a process, or prove worker quiescence.
 * @param launch - exact invocation returned by the Scheduler and its expected action.
 * @param dependencies - optional host observation adapter; omitted uses Windows Task Scheduler.
 * @returns whether that invocation is queued or running; otherwise throws ServiceStartupError.
 */
export async function observeServiceTask(launch: ServiceTaskLaunch,
  dependencies: ObservationDependencies = { runPowerShell, systemRoot: process.env.SystemRoot }): Promise<'queued' | 'running'> {
  const fail = async (code: ServiceStartupFailure, taskResult: number | null = null, cause?: unknown): Promise<never> => {
    throw new ServiceStartupError(code, launch, taskResult, await startupLog(launch.logFile), cause)
  }
  let observation: z.infer<typeof observationSchema>
  try {
    observation = observationSchema.parse(JSON.parse(await dependencies.runPowerShell(observationScript(launch.taskName))))
  } catch (error) {
    return await fail('startup-observation-unavailable', null, error)
  }
  if (observation.kind === 'missing') return await fail('startup-task-missing')
  if (observation.kind === 'unavailable') return await fail('startup-observation-unavailable')
  const action = observation.actions[0]
  if (dependencies.systemRoot === undefined) return await fail('startup-observation-unavailable', observation.lastTaskResult)
  const conhost = path.win32.join(dependencies.systemRoot, 'System32', 'conhost.exe')
  const expectedArguments = `--headless cmd.exe /d /c "${launch.commandFile}"`
  if (observation.actions.length !== 1 || action === undefined
    || path.win32.normalize(action.execute).toLowerCase() !== conhost.toLowerCase()
    || action.arguments !== expectedArguments) return await fail('startup-task-replaced', observation.lastTaskResult)
  let instance
  try {
    instance = observation.instances.find(item => parseServiceTaskInstanceId(item.id) === launch.instanceId)
  } catch (error) { return await fail('startup-observation-unavailable', observation.lastTaskResult, error) }
  if (instance === undefined) return await fail('startup-exited', observation.lastTaskResult)
  if (instance.state === 2) return 'queued'
  if (instance.state === 4) return 'running'
  return await fail('startup-observation-unavailable', observation.lastTaskResult)
}
