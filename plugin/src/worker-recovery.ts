/** Fsynced worker receipts and generation-scoped resource recovery after an API owner exits. */
import { createHash, randomUUID } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import { link, lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { parseSubprocessRangeReceipt } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessRangeReceipt } from '@deepseek-ai/dsh-subprocess'
import { z } from 'zod'
import type { OwnershipGeneration } from './types.ts'
import { isOwnershipGeneration, preparedOwnershipGeneration } from './ownership-generation.ts'
import { sameProcessStart, type ProcessIdentity } from './process-identity.ts'
import { predatesWindowsBoot, type WindowsBootEvidence } from './boot-recovery.ts'
import { recoveryIssue, type RecoveryIssue } from './recovery-issues.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
const generationOwnerSchema = z.strictObject({ pid: z.number().int().positive(),
  startTime: z.string().refine(value => Number.isFinite(Date.parse(value))), leaseRoot: z.string().min(1) })
const manifestSchema = z.strictObject({ version: z.literal(1), generation: z.string().regex(UUID),
  receiptFormat: z.literal('windows-job-id'), owner: generationOwnerSchema.optional() })
const receiptSchema = z.strictObject({ version: z.literal(1), generation: z.string().regex(UUID),
  id: z.string().regex(UUID), range: z.unknown() })
const ownerSchema = z.object({ ownershipGeneration: z.string().regex(UUID), owner: z.string().min(1), pid: z.number().int().positive() })
const timedOwnerSchema = ownerSchema.extend({ token: z.string().min(1), acquiredAt: z.iso.datetime(), expiresAt: z.iso.datetime() })
const leaseSchema = timedOwnerSchema.extend({ resource: z.string() })
const claimSchema = timedOwnerSchema.extend({ id: z.string().min(1), root: z.string().min(1), scope: z.string().min(1),
  kind: z.enum(['worktree', 'path', 'metadata']), path: z.string(), directory: z.boolean() })
const settledSchema = z.strictObject({ version: z.literal(1), generation: z.string().regex(UUID),
  proof: z.enum(['native-ranges', 'previous-boot']), receiptCount: z.number().int().nonnegative().nullable(),
  evidenceHash: z.string().regex(/^[0-9a-f]{64}$/u) })

/** A malformed or changed receipt prevents any release of generation-owned resources. */
export class WorkerRecoveryStateError extends Error {
  override readonly name = 'WorkerRecoveryStateError'
}

/** API owner identity retained when its complete lock has not yet been published or was released. */
export interface WorkerGenerationOwner {
  readonly pid: number
  readonly startTime: string
  readonly leaseRoot: string
}

/**
 * Parse an API owner identity for worker receipt storage.
 * @param value - persisted or wire generation field.
 * @returns the canonical branded identifier.
 */
export function parseOwnershipGeneration(value: unknown): OwnershipGeneration {
  if (!isOwnershipGeneration(value)) throw new WorkerRecoveryStateError('invalid worker ownership generation')
  return value
}

/** Receipts are retained after recovery so subsequent attempts can verify the same complete generation. */
export class WorkerRecoveryStore {
  private constructor(readonly generation: OwnershipGeneration, private readonly directory: string) {}

  /**
   * Initialize a fresh generation before advertising recovery support in an API owner lock.
   * Files are fsynced before atomic publication; this guarantees process-crash ordering,
   * not survival of filesystem metadata after sudden power loss.
   * @param stateDirectory - API state root.
   * @param generation - fresh API owner UUID.
   * @param owner - host process identity and resource namespace for orphan-generation recovery.
   * @returns storage whose manifest has been published.
   */
  static async create(stateDirectory: string, generation: OwnershipGeneration,
    owner?: WorkerGenerationOwner): Promise<WorkerRecoveryStore> {
    const parent = path.join(stateDirectory, 'worker-ranges')
    await mkdir(parent, { recursive: true })
    await requireDirectory(parent)
    const directory = path.join(await realpath(parent), generation)
    await mkdir(directory)
    await publish(directory, 'manifest.json', { version: 1, generation, receiptFormat: 'windows-job-id',
      ...owner === undefined ? {} : { owner: { pid: owner.pid, startTime: owner.startTime, leaseRoot: owner.leaseRoot } } })
    return new WorkerRecoveryStore(generation, directory)
  }

  /**
   * Record one exact worker range before its target may start.
   * @param receipt - range allocated by the subprocess provider.
   * @returns after exclusive publication of the fsynced receipt; failures forbid target launch.
   */
  async persist(receipt: SubprocessRangeReceipt): Promise<void> {
    const id = receipt.jobName.slice('Global\\dsh-subprocess-'.length)
    await publish(this.directory, `${id}.json`, { version: 1, generation: this.generation, id, range: receipt })
  }
}

/** Successful termination of every range in one immutable, stopped API generation. */
export interface RecoveredWorkerGeneration {
  readonly generation: OwnershipGeneration
  /** Null when host reboot evidence made native receipt inspection unnecessary. */
  readonly receiptCount: number | null
}

/** Files preserved outside the active registry after their workers have stopped. */
export interface RecoveredOwnership {
  readonly quarantineDirectory: string | null
  readonly moved: readonly string[]
}

/** Independent generation outcomes; unresolved resources remain in the active registries. */
export interface WorkerRecoveryReport {
  readonly recovered: readonly RecoveredOwnership[]
  readonly issues: readonly RecoveryIssue[]
}

/**
 * Recover stopped generations left without an API lock, retaining live owners and all history.
 * The caller must hold the host controller lock and API recovery fence, and verify that no
 * API owner lock exists. A failed generation retains its resource ownership without
 * preventing independent generations or a fresh API from starting.
 * @param stateDirectory - one API state root; no other state roots are scanned.
 * @param leaseRoot - configured resource namespace, required to match each recovered manifest.
 * @param recoverRange - provider operation resolving after exact range termination.
 * @param inspectProcess - host PID and start-time probe; unknown observations reject.
 * @param signal - cancellation preserves any remaining ownership records.
 * @param boot - verified current host boot; older owners need no native Job inspection.
 * @returns successful quarantines and unresolved per-generation diagnostics.
 */
export async function recoverOrphanWorkerGenerations(stateDirectory: string, leaseRoot: string,
  recoverRange: (receipt: SubprocessRangeReceipt, signal?: AbortSignal) => Promise<void>,
  inspectProcess: (pid: number) => Promise<ProcessIdentity | null>, signal?: AbortSignal, boot?: WindowsBootEvidence,
): Promise<WorkerRecoveryReport> {
  const parent = path.join(stateDirectory, 'worker-ranges')
  try { await requireDirectory(parent) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { recovered: [], issues: [] }
    return { recovered: [], issues: [{ ...recoveryIssue('worker-generation', 'registry', error), blocksAdmission: true }] }
  }
  const results: RecoveredOwnership[] = []
  const issues: RecoveryIssue[] = []
  let entries
  try { entries = await readdir(parent, { withFileTypes: true }) } catch (error) {
    return { recovered: [], issues: [{ ...recoveryIssue('worker-generation', 'registry', error), blocksAdmission: true }] }
  }
  for (const entry of entries) {
    signal?.throwIfAborted()
    if (!entry.isDirectory() || !isOwnershipGeneration(entry.name)) continue
    let scoped = false
    try {
      const directory = path.join(parent, entry.name)
      await requireDirectory(directory)
      const names = await readdir(directory)
      if (!names.includes('manifest.json') && names.every(name => name === 'manifest.json.tmp')) continue
      const captured = await capture(path.join(directory, 'manifest.json'))
      const manifest = manifestSchema.parse(JSON.parse(captured.bytes.toString('utf8')))
      if (manifest.generation !== entry.name || manifest.owner === undefined) throw new WorkerRecoveryStateError('orphan worker generation has no exact owner identity')
      const recordedRoot = path.resolve(manifest.owner.leaseRoot)
      const configuredRoot = path.resolve(leaseRoot)
      if ((process.platform === 'win32' ? recordedRoot.toLowerCase() !== configuredRoot.toLowerCase() : recordedRoot !== configuredRoot)) {
        throw new WorkerRecoveryStateError('orphan worker generation belongs to a different resource namespace')
      }
      scoped = true
      if (sameProcessStart(manifest.owner, await inspectProcess(manifest.owner.pid))) continue
      await requireUnchanged(captured)
      const recovered = boot !== undefined && predatesWindowsBoot(manifest.owner.startTime, boot)
        ? await settleRebootedWorkerGeneration(stateDirectory, entry.name, manifest.owner.startTime, boot)
        : await recoverWorkerGeneration(stateDirectory, entry.name, recoverRange, signal)
      results.push(await quarantineRecoveredOwnership(leaseRoot, recovered))
    } catch (error) {
      signal?.throwIfAborted()
      if (!scoped && await workerGenerationSettled(stateDirectory, entry.name)) {
        try {
          results.push(await quarantineRecoveredOwnership(leaseRoot, { generation: entry.name, receiptCount: null }))
        } catch (cleanupError) { issues.push(recoveryIssue('worker-generation', entry.name, cleanupError)) }
        continue
      }
      issues.push({ ...recoveryIssue('worker-generation', entry.name, error), ...scoped ? {} : { blocksAdmission: true as const } })
    }
  }
  return { recovered: results, issues }
}

interface CapturedFile {
  readonly file: string
  readonly bytes: Buffer
  readonly stat: BigIntStats
}

function evidenceHash(files: readonly CapturedFile[], exists = true): string {
  return createHash('sha256').update(JSON.stringify({ exists, files: files.map(file =>
    [path.basename(file.file), createHash('sha256').update(file.bytes).digest('hex')]) })).digest('hex')
}

/**
 * Verify that a retained settlement still names the exact immutable generation evidence.
 * @param stateDirectory - API state root owning the worker generation.
 * @param generation - admitted worker generation; absence is never proof of settlement.
 * @returns true only for a validated unchanged settlement; no native process operation is performed.
 */
export async function workerGenerationSettled(stateDirectory: string, generation: OwnershipGeneration): Promise<boolean> {
  try {
    const markerRoot = path.join(stateDirectory, 'worker-settled')
    await requireDirectory(markerRoot)
    const captured = await capture(path.join(markerRoot, `${generation}.json`))
    const settled = settledSchema.parse(JSON.parse(captured.bytes.toString('utf8')))
    if (settled.generation !== generation) return false
    const current = await generationEvidence(stateDirectory, generation, settled.proof === 'previous-boot')
    if (settled.evidenceHash !== current.hash) return false
    await confirmGenerationEvidence(current)
    await requireUnchanged(captured)
    return true
  } catch {
    // Missing or unreadable evidence cannot authorize replacement after uncertain cleanup.
    return false
  }
}

/**
 * Record reboot-based settlement without opening Jobs from an earlier host boot.
 * The caller excludes the exact stopped owner and all new admission for this generation.
 * @param stateDirectory - API state root.
 * @param generation - exact stopped API generation.
 * @param ownerStartedAt - host-validated creation time of the stopped API owner.
 * @param boot - verified current host boot evidence.
 * @returns settlement evidence; receipt count is unknown because old receipts need not parse.
 */
export async function settleRebootedWorkerGeneration(stateDirectory: string, generation: OwnershipGeneration,
  ownerStartedAt: string, boot: WindowsBootEvidence): Promise<RecoveredWorkerGeneration> {
  if (!predatesWindowsBoot(ownerStartedAt, boot)) throw new WorkerRecoveryStateError('worker generation does not predate the verified host boot')
  const evidence = await generationEvidence(stateDirectory, generation, true)
  await confirmGenerationEvidence(evidence)
  await publishSettlement(stateDirectory, generation, null, evidence.hash, 'previous-boot')
  return { generation, receiptCount: null }
}

interface GenerationEvidence {
  readonly directory: string
  readonly names: readonly string[]
  readonly files: readonly CapturedFile[]
  readonly exists: boolean
  readonly hash: string
}

async function generationEvidence(stateDirectory: string, generation: OwnershipGeneration,
  allowMissing: boolean): Promise<GenerationEvidence> {
  const parent = path.join(stateDirectory, 'worker-ranges'), directory = path.join(parent, generation)
  try {
    await requireDirectory(parent)
    await requireDirectory(directory)
  } catch (error) {
    if (!allowMissing || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return { directory, names: [], files: [], exists: false, hash: evidenceHash([], false) }
  }
  const names = (await readdir(directory)).sort()
  const files = await Promise.all(names.map(async name => await capture(path.join(directory, name))))
  return { directory, names, files, exists: true, hash: evidenceHash(files) }
}

async function confirmGenerationEvidence(evidence: GenerationEvidence): Promise<void> {
  if (!evidence.exists) {
    try { await lstat(evidence.directory) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    throw new WorkerRecoveryStateError('worker generation appeared during settlement')
  }
  if (JSON.stringify((await readdir(evidence.directory)).sort()) !== JSON.stringify(evidence.names)) {
    throw new WorkerRecoveryStateError('worker generation changed during settlement')
  }
  for (const file of evidence.files) await requireUnchanged(file)
}

async function publishSettlement(stateDirectory: string, generation: OwnershipGeneration, receiptCount: number | null,
  hash: string, proof: 'native-ranges' | 'previous-boot'): Promise<void> {
  const directory = path.join(stateDirectory, 'worker-settled')
  await mkdir(directory, { recursive: true })
  await requireDirectory(directory)
  const file = path.join(directory, `${generation}.json`), temporary = path.join(directory, `.${generation}.${randomUUID()}.tmp`)
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(JSON.stringify({ version: 1, generation, receiptCount, evidenceHash: hash, proof }))
    await handle.sync()
  } finally { await handle.close() }
  try { await rename(temporary, file) } finally {
    try { await unlink(temporary) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

/**
 * Terminate every recorded range before permitting generation-owned resource recovery.
 * The caller must already exclude the API owner and new admission for this generation.
 * Missing, malformed, changed, or unrecognized receipts fail closed; history is never deleted.
 * @param stateDirectory - API state root containing the generation manifest.
 * @param generation - stopped API owner's generation.
 * @param recoverRange - provider operation that resolves only when the exact range is empty.
 * @param signal - cancellation leaves ownership records retained.
 * @returns evidence that every recorded range has become quiescent.
 */
export async function recoverWorkerGeneration(stateDirectory: string, generation: OwnershipGeneration,
  recoverRange: (receipt: SubprocessRangeReceipt, signal?: AbortSignal) => Promise<void>, signal?: AbortSignal,
): Promise<RecoveredWorkerGeneration> {
  signal?.throwIfAborted()
  const parent = path.join(stateDirectory, 'worker-ranges')
  await requireDirectory(parent)
  const directory = path.join(await realpath(parent), generation)
  await requireDirectory(directory)
  const names = (await readdir(directory)).sort()
  if (!names.includes('manifest.json')) throw new WorkerRecoveryStateError('worker generation manifest is missing; preserve ownership records')
  const files = await Promise.all(names.map(async name => await capture(path.join(directory, name))))
  const hash = evidenceHash(files)
  const settledDirectory = path.join(stateDirectory, 'worker-settled')
  const settledFile = path.join(settledDirectory, `${generation}.json`)
  try {
    await requireDirectory(settledDirectory)
    const settled = settledSchema.parse(JSON.parse((await capture(settledFile)).bytes.toString('utf8')))
    if (settled.generation !== generation || settled.evidenceHash !== hash) {
      throw new WorkerRecoveryStateError('settled worker generation evidence changed; preserve ownership records')
    }
    signal?.throwIfAborted()
    if (JSON.stringify((await readdir(directory)).sort()) !== JSON.stringify(names)) {
      throw new WorkerRecoveryStateError('settled worker generation changed during inspection; preserve ownership records')
    }
    for (const file of files) await requireUnchanged(file)
    return { generation, receiptCount: settled.receiptCount }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const receipts = new Map<string, { receipt: SubprocessRangeReceipt; text: string }>()
  let manifestText: string | undefined
  for (const file of files) {
    const name = path.basename(file.file)
    if (name === 'manifest.json' || name === 'manifest.json.tmp') {
      const value: unknown = JSON.parse(file.bytes.toString('utf8'))
      const manifest = manifestSchema.parse(value)
      if (manifest.generation !== generation) throw new WorkerRecoveryStateError('worker generation manifest does not match its owner')
      const text = JSON.stringify(manifest)
      if (manifestText !== undefined && manifestText !== text) throw new WorkerRecoveryStateError('worker generation manifest copies disagree')
      manifestText = text
      continue
    }
    const id = name.replace(/\.json(?:\.tmp)?$/u, '')
    if (!isOwnershipGeneration(id) || (name !== `${id}.json` && name !== `${id}.json.tmp`)) {
      throw new WorkerRecoveryStateError('worker receipt filename is not a provider Job identity')
    }
    const namedReceipt = parseSubprocessRangeReceipt({ kind: 'windows-job', jobName: `Global\\dsh-subprocess-${id}` })
    let value: unknown
    try {
      value = JSON.parse(file.bytes.toString('utf8'))
    } catch (error) {
      if (!(error instanceof SyntaxError) || !name.endsWith('.tmp')) throw error
      // A crash can interrupt staging before publication; its UUID already identifies the allocated Job.
      value = { version: 1, generation, id, range: namedReceipt }
    }
    const parsed = receiptSchema.parse(value)
    if (parsed.generation !== generation || parsed.id !== id) {
      throw new WorkerRecoveryStateError('worker receipt identity does not match its generation or filename')
    }
    const receipt = parseSubprocessRangeReceipt(parsed.range)
    if (receipt.jobName !== namedReceipt.jobName) throw new WorkerRecoveryStateError('worker receipt Job differs from its filename')
    const text = JSON.stringify(receipt)
    const previous = receipts.get(parsed.id)
    if (previous !== undefined && previous.text !== text) throw new WorkerRecoveryStateError('worker receipt copies disagree')
    receipts.set(parsed.id, { receipt, text })
  }
  for (const { receipt } of receipts.values()) {
    signal?.throwIfAborted()
    await recoverRange(receipt, signal)
  }
  signal?.throwIfAborted()
  if (JSON.stringify((await readdir(directory)).sort()) !== JSON.stringify(names)) {
    throw new WorkerRecoveryStateError('worker generation changed during recovery; preserve ownership records')
  }
  for (const file of files) await requireUnchanged(file)
  await publishSettlement(stateDirectory, generation, receipts.size, hash, 'native-ranges')
  return { generation, receiptCount: receipts.size }
}

/**
 * Preserve exact-generation leases, claims, and waiter tickets outside active ownership.
 * Call only while the stopped API generation remains excluded from admission. Other
 * generations, legacy records, malformed files, and directory links are retained.
 * @param leaseRoot - shared lease and claim registry root.
 * @param recovered - evidence returned after all generation ranges were terminated.
 * @returns the quarantine directory and moved relative paths.
 */
export async function quarantineRecoveredOwnership(leaseRoot: string, recovered: RecoveredWorkerGeneration): Promise<RecoveredOwnership> {
  const candidates: { captured: CapturedFile; relative: string }[] = []
  for (const kind of ['leases', 'claims'] as const) {
    const directory = path.join(leaseRoot, kind)
    try {
      await requireDirectory(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      const preparedGeneration = preparedOwnershipGeneration(entry.name)
      if (preparedGeneration !== undefined) {
        const prefix = entry.name.slice(0, entry.name.lastIndexOf('.generation-'))
        const knownPrefix = kind === 'claims' ? prefix.endsWith('.json') && isOwnershipGeneration(prefix.slice(0, -5))
          : prefix.endsWith('.lock') || /\.ticket-\d+-p\d+-[0-9a-f-]{36}$/u.test(prefix)
        if (knownPrefix && preparedGeneration === recovered.generation) {
          const captured = await captureResource(path.join(directory, entry.name))
          if (captured !== undefined) candidates.push({ captured, relative: path.join(kind, entry.name) })
        }
        continue
      }
      const waiter = kind === 'leases' && /\.ticket-\d+-p\d+-[0-9a-f-]+$/u.test(entry.name)
      if (!waiter && !(kind === 'leases' ? /\.lock(?:\.[0-9a-f-]+\.tmp)?$/u : /\.json(?:\.[0-9a-f-]+\.tmp)?$/u).test(entry.name)) continue
      const captured = await captureResource(path.join(directory, entry.name))
      if (captured === undefined) continue
      let value: unknown
      try {
        value = JSON.parse(captured.bytes.toString('utf8'))
      } catch (error) {
        if (error instanceof SyntaxError) continue
        throw error
      }
      const parsed = (waiter ? ownerSchema : kind === 'leases' ? leaseSchema : claimSchema).safeParse(value)
      if (!parsed.success || parsed.data.ownershipGeneration !== recovered.generation) continue
      candidates.push({ captured, relative: path.join(kind, entry.name) })
    }
  }
  if (candidates.length === 0) return { quarantineDirectory: null, moved: [] }
  for (const candidate of candidates) await requireUnchanged(candidate.captured)
  const recoveryRoot = path.join(leaseRoot, 'recovered')
  await mkdir(recoveryRoot, { recursive: true })
  await requireDirectory(recoveryRoot)
  const quarantineDirectory = path.join(recoveryRoot, `workers-${recovered.generation}-${randomUUID()}`)
  await mkdir(quarantineDirectory)
  await publish(quarantineDirectory, 'manifest.json', { version: 1, generation: recovered.generation,
    receiptCount: recovered.receiptCount, entries: candidates.map(candidate => candidate.relative) })
  const moved: string[] = []
  const movedInodes = new Set<string>()
  for (const candidate of candidates) {
    const inodeKey = `${String(candidate.captured.stat.dev)}:${String(candidate.captured.stat.ino)}`
    await requireUnchanged(candidate.captured, movedInodes.has(inodeKey))
    const destination = path.join(quarantineDirectory, candidate.relative)
    await mkdir(path.dirname(destination), { recursive: true })
    await rename(candidate.captured.file, destination)
    const after = await capture(destination)
    if (after.stat.ino !== candidate.captured.stat.ino || after.stat.dev !== candidate.captured.stat.dev ||
      !after.bytes.equals(candidate.captured.bytes)) {
      throw new WorkerRecoveryStateError('ownership record changed while entering quarantine; preserve the quarantine and stop recovery')
    }
    moved.push(candidate.relative)
    movedInodes.add(inodeKey)
  }
  return { quarantineDirectory, moved }
}

/** Publish complete bytes without replacing another attempt or advertising a partial record. */
async function publish(directory: string, name: string, value: object): Promise<void> {
  const temporary = path.join(directory, `${name}.tmp`)
  const handle = await open(temporary, 'wx')
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await link(temporary, path.join(directory, name))
  await unlink(temporary)
}

/** Directory links never redirect recovery into another ownership namespace. */
async function requireDirectory(directory: string): Promise<void> {
  const stat = await lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new WorkerRecoveryStateError('worker recovery directory is not a physical directory')
}

/** Capture stable bytes and filesystem identity without following a directory entry link. */
async function capture(file: string): Promise<CapturedFile> {
  const before = await lstat(file, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink()) throw new WorkerRecoveryStateError('worker recovery entry is not a regular file')
  const handle = await open(file, 'r')
  try {
    const stat = await handle.stat({ bigint: true })
    const bytes = await handle.readFile()
    const after = await handle.stat({ bigint: true })
    if (!sameFile(before, stat) || !sameFile(stat, after)) throw new WorkerRecoveryStateError('worker recovery entry changed while reading')
    return { file, bytes, stat }
  } finally {
    await handle.close()
  }
}

/** Unrelated live owners may release their own records while the shared registry is scanned. */
async function captureResource(file: string): Promise<CapturedFile | undefined> {
  try { return await capture(file) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** Reject replacement or mutation of an inspected record before releasing its ownership. */
async function requireUnchanged(before: CapturedFile, linkedEntryMoved = false): Promise<void> {
  const after = await capture(before.file)
  if (!sameFile(before.stat, after.stat, linkedEntryMoved) || !before.bytes.equals(after.bytes)) {
    throw new WorkerRecoveryStateError('worker recovery evidence changed; preserve ownership records')
  }
}

/** BigInt inode identity avoids lossy comparisons on Windows volumes. */
function sameFile(left: BigIntStats, right: BigIntStats, linkedEntryMoved = false): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && (linkedEntryMoved || left.ctimeNs === right.ctimeNs)
}
