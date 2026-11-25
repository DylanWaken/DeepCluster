/** Host process identity: PID, creation time, and command line; a matching PID alone is not an owner. */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Stable identity of one host process. */
export interface ProcessIdentity {
  readonly pid: number
  /** Process creation time; comparing it with the PID rejects PID reuse. */
  readonly startTime: string
  readonly commandLine: string
}

/** Fields compared between a recorded owner and a live process. */
export interface RecordedProcessIdentity {
  readonly pid: number
  readonly startTime: string
  readonly commandLine: string
}

/**
 * Compare a recorded owner with a live process, including command identity.
 * @param record - ownership recorded when the service was started.
 * @param live - identity observed for the same PID now.
 * @returns true only when PID, creation time, and trimmed command line all match.
 */
export function sameProcessIdentity(
  record: RecordedProcessIdentity | null,
  live: RecordedProcessIdentity | null,
): boolean {
  return record !== null && live !== null && record.pid === live.pid
    && record.startTime === live.startTime && record.commandLine.trim() === live.commandLine.trim()
}

/**
 * Compare only the PID and creation time; command lines can be truncated by the host query.
 * @param record - recorded process identity.
 * @param live - identity observed for the same PID now.
 * @returns true when the PID exists with the same creation time.
 */
export function sameProcessStart(
  record: Pick<RecordedProcessIdentity, 'pid' | 'startTime'> | null,
  live: Pick<RecordedProcessIdentity, 'pid' | 'startTime'> | null,
): boolean {
  return record !== null && live !== null && record.pid === live.pid && record.startTime === live.startTime
}

/**
 * Run one PowerShell expression without a profile and fail on a nonzero native exit code.
 * @param script - complete PowerShell command text.
 * @param timeoutMs - bound for the host command; defaults to 30 seconds.
 * @returns trimmed standard output.
 */
export async function runPowerShell(script: string, timeoutMs = 30_000): Promise<string> {
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, timeout: timeoutMs,
    })
    return stdout.trim()
  } catch (error) {
    const failure = error as { code?: number | string; stderr?: string; message?: string; killed?: boolean }
    const detail = (failure.stderr ?? '').trim() || failure.message || 'no diagnostic'
    if (failure.killed === true) throw new Error(`PowerShell command exceeded its ${String(timeoutMs)} ms bound: ${detail}`)
    throw new Error(`PowerShell command failed with exit ${String(failure.code ?? 'unknown')}: ${detail}`)
  }
}

/**
 * Read one host process identity without signalling it.
 * @param pid - positive process identifier.
 * @returns the process identity, or null when no process has that PID.
 */
export async function inspectProcessIdentity(pid: number): Promise<ProcessIdentity | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new RangeError('pid must be a positive integer')
  if (process.platform === 'win32') {
    const output = await runPowerShell(`[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$p=Get-CimInstance Win32_Process -Filter "ProcessId=${String(pid)}" -ErrorAction Stop
if ($null -eq $p) { Write-Output 'NONE'; exit 0 }
$created=if ($p.CreationDate -is [datetime]) { $p.CreationDate } else { [Management.ManagementDateTimeConverter]::ToDateTime([string]$p.CreationDate) }
Write-Output ('OK|{0}|{1}|{2}' -f $p.ProcessId, $created.ToUniversalTime().ToString('o'), $p.CommandLine)`)
    if (output === 'NONE') return null
    const [tag, rawPid, startTime, commandLine] = output.split('|', 4)
    if (tag !== 'OK' || rawPid === undefined || Number(rawPid) !== pid
      || startTime === undefined || !Number.isFinite(Date.parse(startTime)) || commandLine === undefined) {
      throw new Error(`Could not identify host process ${String(pid)}.`)
    }
    return { pid: Number(rawPid), startTime, commandLine }
  }
  try {
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'command='], {
      timeout: 10_000, env: { ...process.env, LC_ALL: 'C' },
    })
    const line = stdout.trim()
    if (line === '') return null
    const match = /^(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.*)$/u.exec(line)
    if (match === null) throw new Error(`Could not parse the start time of host process ${String(pid)}.`)
    const parsed = new Date(match[1] as string)
    return {
      pid,
      startTime: Number.isFinite(parsed.getTime()) ? parsed.toISOString() : match[1] as string,
      commandLine: match[2] as string,
    }
  } catch (error) {
    const code = (error as { code?: unknown }).code
    if (code === 1 || code === '1') return null
    throw error
  }
}
