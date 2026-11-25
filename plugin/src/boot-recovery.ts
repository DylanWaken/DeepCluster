/** Preserve ownership evidence while releasing records acquired before the current Windows boot. */
import { createHash } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { runPowerShell } from './process-identity.ts'

/** Host-reported boot time and the observation that bounds it. */
export interface WindowsBootEvidence {
  readonly startedAt: string
  readonly observedAt: string
}

/** A filesystem identity captured together with the record bytes. */
interface FileIdentity {
  readonly device: string
  readonly inode: string
  readonly modified: string
  readonly changed: string
  readonly size: string
}

/** One validated ownership record from a previous host boot. */
export interface PreviousBootEntry {
  readonly relativePath: string
  readonly kind: 'lease' | 'claim' | 'waiter' | 'claim-mutex'
  readonly pid: number
  readonly acquiredAt: string
  readonly identity: FileIdentity
  readonly recordIdentity: FileIdentity
  readonly contentHash: string
}

/** An entry whose ownership cannot be released using host reboot evidence. */
export interface RetainedBootEntry {
  readonly relativePath: string
  readonly reason: string
}

/** Read-only inspection; operation records and released-claim history are outside its scope. */
export interface PreviousBootInspection {
  readonly root: string
  readonly boot: WindowsBootEvidence
  readonly candidates: readonly PreviousBootEntry[]
  readonly retained: readonly RetainedBootEntry[]
}

/** Quarantine evidence after exact previous-boot entries have moved out of active ownership. */
export interface PreviousBootRecovery {
  readonly quarantineDirectory: string | null
  readonly moved: readonly string[]
  readonly retained: readonly RetainedBootEntry[]
}

/** Recovery stops with preserved evidence when host facts or ownership are uncertain. */
export class BootRecoveryError extends Error {
  override readonly name = 'DeepClusterBootRecoveryError'
  /**
   * @param code - host inspection or ownership failure.
   * @param message - affected evidence and required next action.
   * @param options - original filesystem or host failure, when available.
   */
  constructor(readonly code: 'invalid-boot' | 'ownership-changed' | 'recovery-incomplete', message: string, options?: ErrorOptions) {
    super(message, options)
  }
}

/**
 * Read Windows boot and current UTC times from the operating system.
 * @param run - host command executor; omitted uses the bounded hidden PowerShell executor.
 * @returns validated boot evidence; unavailable or inconsistent host facts reject.
 */
export async function inspectWindowsBoot(run: (script: string) => Promise<string> = runPowerShell): Promise<WindowsBootEvidence> {
  const output = await run(`[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$os=Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
$boot=if ($os.LastBootUpTime -is [datetime]) { $os.LastBootUpTime } else { [Management.ManagementDateTimeConverter]::ToDateTime([string]$os.LastBootUpTime) }
Write-Output ('BOOT|{0}|{1}' -f $boot.ToUniversalTime().ToString('o'), [datetime]::UtcNow.ToString('o'))`)
  const match = /^BOOT\|([^|\r\n]+)\|([^|\r\n]+)$/u.exec(output.trim())
  const started = match === null ? NaN : Date.parse(match[1] as string)
  const observed = match === null ? NaN : Date.parse(match[2] as string)
  if (!Number.isFinite(started) || !Number.isFinite(observed) || started > observed) {
    throw new BootRecoveryError('invalid-boot', 'Windows boot time could not be established; ownership records remain retained.')
  }
  return { startedAt: new Date(started).toISOString(), observedAt: new Date(observed).toISOString() }
}

/**
 * Compare persisted acquisition or process creation time with host boot evidence.
 * @param timestamp - recorded time; malformed or absent values cannot prove an earlier boot.
 * @param boot - validated host boot observation.
 * @returns true only for a valid timestamp strictly before this boot.
 */
export function predatesWindowsBoot(timestamp: string | undefined, boot: WindowsBootEvidence): boolean {
  const recorded = timestamp === undefined ? NaN : Date.parse(timestamp)
  return Number.isFinite(recorded) && recorded < Date.parse(boot.startedAt)
}

const pid = z.number().int().positive()
const timestamp = z.string().refine(value => Number.isFinite(Date.parse(value)))
const leaseSchema = z.object({ resource: z.string(), owner: z.string(), token: z.string().min(1), pid,
  acquiredAt: timestamp, expiresAt: timestamp })
const claimSchema = z.object({ id: z.string().min(1), scope: z.string().min(1), root: z.string().optional(),
  kind: z.enum(['worktree', 'path', 'metadata']), path: z.string(), directory: z.boolean(), owner: z.string().min(1),
  token: z.string().min(1), pid, acquiredAt: timestamp, expiresAt: timestamp })
const waiterSchema = z.object({ owner: z.string(), pid })
const mutexSchema = z.object({ pid, token: z.string().min(1), at: timestamp })

function identity(value: BigIntStats): FileIdentity {
  return { device: String(value.dev), inode: String(value.ino), modified: String(value.mtimeNs),
    changed: String(value.ctimeNs), size: String(value.size) }
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode && left.modified === right.modified
    && left.changed === right.changed && left.size === right.size
}

/** Open and read the same regular file identity observed at its path. */
async function readEvidence(file: string): Promise<{ identity: FileIdentity; hash: string; value: unknown }> {
  const before = await lstat(file, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('Ownership evidence is not a regular file.')
  const handle = await open(file, 'r')
  try {
    if (!sameIdentity(identity(before), identity(await handle.stat({ bigint: true })))) throw new Error('Ownership evidence changed while opening it.')
    const text = await handle.readFile('utf8')
    if (!sameIdentity(identity(before), identity(await lstat(file, { bigint: true })))) throw new Error('Ownership evidence changed while reading it.')
    const value: unknown = JSON.parse(text)
    return { identity: identity(before), hash: createHash('sha256').update(text).digest('hex'), value }
  } finally { await handle.close() }
}

/** Inspect a known ownership namespace entry without following links. */
async function inspectEntry(root: string, relativePath: string, boot: WindowsBootEvidence): Promise<PreviousBootEntry> {
  const file = path.join(root, relativePath), info = await lstat(file, { bigint: true })
  if (info.isSymbolicLink()) throw new Error('Symbolic-link ownership entries remain retained.')
  const name = path.basename(file)
  let kind: PreviousBootEntry['kind'], recordFile = file
  if (relativePath === 'claims/mutex') {
    if (!info.isDirectory() || (await readdir(file)).join() !== 'owner.json') throw new Error('The claim mutex contains unknown ownership evidence.')
    kind = 'claim-mutex'; recordFile = path.join(file, 'owner.json')
  } else if (!info.isFile()) throw new Error('Unknown ownership directory remains retained.')
  else if (relativePath.startsWith('claims/') && name.endsWith('.json')) kind = 'claim'
  else if (relativePath.startsWith('leases/') && name.endsWith('.lock')) kind = 'lease'
  else if (relativePath.startsWith('leases/') && name.includes('.ticket-')) kind = 'waiter'
  else throw new Error('Unknown ownership entry remains retained.')
  const record = await readEvidence(recordFile)
  let ownerPid: number, acquiredAt: string
  if (kind === 'claim-mutex') {
    const value = mutexSchema.parse(record.value)
    ownerPid = value.pid; acquiredAt = value.at
  } else if (kind === 'claim') {
    const value = claimSchema.parse(record.value)
    if (value.id !== name) throw new Error('Claim filename and identity disagree.')
    ownerPid = value.pid; acquiredAt = value.acquiredAt
  } else if (kind === 'lease') {
    const value = leaseSchema.parse(record.value)
    if (`${encodeURIComponent(value.resource)}.lock` !== name) throw new Error('Lease filename and resource disagree.')
    ownerPid = value.pid; acquiredAt = value.acquiredAt
  } else {
    const value = waiterSchema.parse(record.value), match = /\.ticket-(\d+)-p(\d+)-[a-f0-9-]+$/u.exec(name)
    if (match === null || Number(match[2]) !== value.pid || !Number.isSafeInteger(Number(match[1]))) {
      throw new Error('Waiter filename and owner disagree.')
    }
    ownerPid = value.pid; acquiredAt = new Date(Number(match[1])).toISOString()
  }
  if (!predatesWindowsBoot(acquiredAt, boot)) throw new Error('Acquisition is not proven to precede the current Windows boot.')
  return { relativePath, kind, pid: ownerPid, acquiredAt,
    identity: identity(info), recordIdentity: record.identity, contentHash: record.hash }
}

/**
 * Inspect lease, waiter, claim, and claim-mutex records for acquisition before boot.
 * @param leaseRoot - existing host ownership directory; its real path defines inspection scope.
 * @param boot - validated current Windows boot evidence.
 * @returns exact candidates and retained unknown or current-boot entries; nothing is changed.
 */
export async function inspectPreviousBootOwnership(leaseRoot: string, boot: WindowsBootEvidence): Promise<PreviousBootInspection> {
  const root = await realpath(leaseRoot), candidates: PreviousBootEntry[] = [], retained: RetainedBootEntry[] = []
  for (const namespace of ['leases', 'claims']) {
    const directory = path.join(root, namespace)
    try {
      const info = await lstat(directory)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Ownership namespace is not a physical directory.')
      for (const name of (await readdir(directory)).sort()) {
        const relativePath = `${namespace}/${name}`
        try { candidates.push(await inspectEntry(root, relativePath, boot)) } catch (error) {
          retained.push({ relativePath, reason: error instanceof Error ? error.message : 'Ownership evidence could not be read.' })
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        retained.push({ relativePath: namespace, reason: error instanceof Error ? error.message : 'Ownership namespace could not be read.' })
      }
    }
  }
  return { root, boot, candidates, retained }
}

/**
 * Quarantine exact previous-boot ownership entries without signalling any PID.
 * The caller must retain the lifecycle lock and API admission fence and recheck its
 * API owner. Current-boot or unknown entries remain held. A failure can leave some
 * old records quarantined; the manifest and original bytes remain for inspection.
 * @param inspection - unchanged candidates from the current boot inspection.
 * @returns preserved quarantine paths; operation and release-history files are never touched.
 */
export async function quarantinePreviousBootOwnership(inspection: PreviousBootInspection): Promise<PreviousBootRecovery> {
  if (inspection.candidates.length === 0) return { quarantineDirectory: null, moved: [], retained: inspection.retained }
  const verify = async (candidate: PreviousBootEntry): Promise<void> => {
    const namespace = await lstat(path.join(inspection.root, candidate.relativePath.split('/')[0] as string))
    if (!namespace.isDirectory() || namespace.isSymbolicLink()) throw new BootRecoveryError('ownership-changed', 'Ownership namespace changed; restart recovery inspection.')
    let current: PreviousBootEntry
    try { current = await inspectEntry(inspection.root, candidate.relativePath, inspection.boot) } catch (error) {
      throw new BootRecoveryError('ownership-changed', `Ownership changed at ${candidate.relativePath}; restart recovery inspection.`, { cause: error })
    }
    if (!sameIdentity(candidate.identity, current.identity) || !sameIdentity(candidate.recordIdentity, current.recordIdentity)
      || candidate.contentHash !== current.contentHash) {
      throw new BootRecoveryError('ownership-changed', `Ownership changed at ${candidate.relativePath}; restart recovery inspection.`)
    }
  }
  for (const candidate of inspection.candidates) await verify(candidate)
  const recovered = path.join(inspection.root, 'recovered')
  try { await mkdir(recovered, { mode: 0o700 }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const parent = await lstat(recovered)
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new BootRecoveryError('ownership-changed', 'The recovery evidence directory is not a physical directory.')
  const quarantineDirectory = await mkdtemp(path.join(recovered, 'previous-boot-'))
  const moved: string[] = []
  await writeFile(path.join(quarantineDirectory, 'manifest.json'), JSON.stringify({ version: 1, proof: 'previous-windows-boot',
    boot: inspection.boot, root: inspection.root, candidates: inspection.candidates }), { flag: 'wx', mode: 0o600 })
  try {
    for (const candidate of inspection.candidates) {
      await verify(candidate)
      const target = path.join(quarantineDirectory, candidate.relativePath)
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
      await rename(path.join(inspection.root, candidate.relativePath), target)
      const relocated = await lstat(target, { bigint: true })
      if (String(relocated.dev) !== candidate.identity.device || String(relocated.ino) !== candidate.identity.inode) {
        throw new BootRecoveryError('ownership-changed', `A replacement entry moved to ${target}; preserve it and inspect ownership before starting workers.`)
      }
      const preserved = await readEvidence(candidate.kind === 'claim-mutex' ? path.join(target, 'owner.json') : target)
      if (preserved.hash !== candidate.contentHash || preserved.identity.device !== candidate.recordIdentity.device
        || preserved.identity.inode !== candidate.recordIdentity.inode) {
        throw new BootRecoveryError('ownership-changed', `Ownership evidence changed at ${target}; preserve it before starting workers.`)
      }
      moved.push(candidate.relativePath)
    }
  } catch (error) {
    throw new BootRecoveryError('recovery-incomplete', `Previous-boot recovery stopped; preserve ${quarantineDirectory} and inspect retained ownership before starting workers.`, { cause: error })
  }
  return { quarantineDirectory, moved, retained: inspection.retained }
}
