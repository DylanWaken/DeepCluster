/** Atomic API admission fencing with exact stopped-controller recovery. */
import { randomUUID } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import { link, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { API_RECOVERY_FENCE_FILE } from './api-types.ts'
import { inspectWindowsBoot, predatesWindowsBoot, type WindowsBootEvidence } from './boot-recovery.ts'
import { inspectProcessIdentity, sameProcessStart, type ProcessIdentity } from './process-identity.ts'

const timestamp = z.string().refine(value => Number.isFinite(Date.parse(value)))
const fenceSchema = z.strictObject({ version: z.literal(1), id: z.uuid(), startedAt: timestamp,
  controller: z.strictObject({ pid: z.number().int().positive(), startTime: timestamp }) })

/** Host observations used to distinguish a stopped controller from a reused PID. */
export interface ApiRecoveryFenceOptions {
  readonly inspectProcess?: (pid: number) => Promise<ProcessIdentity | null>
  readonly inspectController?: () => Promise<ProcessIdentity | null>
  readonly inspectBoot?: () => Promise<WindowsBootEvidence>
}

/** Admission remains fenced when controller identity or release ownership is uncertain. */
export class ApiRecoveryFenceError extends Error {
  override readonly name = 'ApiRecoveryFenceError'

  /**
   * @param code - identified owner or preserved-state failure.
   * @param message - actionable explanation.
   * @param options - original host or filesystem cause.
   */
  constructor(readonly code: 'active-controller' | 'unknown-controller' | 'fence-changed', message: string, options?: ErrorOptions) {
    super(message, options)
  }
}

interface FenceFile {
  readonly file: string
  readonly stat: BigIntStats
  readonly bytes: Buffer
}

/**
 * Quarantine an abandoned fence while the caller holds the host lifecycle lock.
 * Same-boot fences require exact PID and creation-time evidence; legacy fences require
 * an acquisition time before the current boot. Unknown ownership remains blocking.
 * @param directory - one API state directory.
 * @param options - host process and boot observations.
 * @returns the preserved fence path, or null when no fence exists.
 */
export async function reclaimApiRecoveryFence(directory: string, options: ApiRecoveryFenceOptions = {}): Promise<string | null> {
  const file = path.join(directory, API_RECOVERY_FENCE_FILE)
  let captured: FenceFile
  try { captured = await captureFence(file) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  let value: unknown
  try { value = JSON.parse(captured.bytes.toString('utf8')) } catch (error) {
    throw new ApiRecoveryFenceError('unknown-controller', 'The API recovery fence is malformed; preserve it until its controller ownership is established.', { cause: error })
  }
  const parsed = fenceSchema.safeParse(value)
  if (parsed.success) {
    let live: ProcessIdentity | null
    try { live = await (options.inspectProcess ?? inspectProcessIdentity)(parsed.data.controller.pid) } catch (error) {
      throw new ApiRecoveryFenceError('unknown-controller', 'The API recovery controller could not be inspected; its fence remains held.', { cause: error })
    }
    if (sameProcessStart(parsed.data.controller, live)) {
      throw new ApiRecoveryFenceError('active-controller', 'The API recovery controller is still running; wait for it to release admission.')
    }
  } else {
    const legacy = z.object({ startedAt: timestamp }).safeParse(value)
    if (!legacy.success || !predatesWindowsBoot(legacy.data.startedAt, await (options.inspectBoot ?? inspectWindowsBoot)())) {
      throw new ApiRecoveryFenceError('unknown-controller', 'The legacy API recovery fence has no stopped-controller evidence; preserve it for inspection.')
    }
  }
  await unchangedFence(captured)
  const destination = `${file}.recovered-${randomUUID()}`
  await rename(file, destination)
  const moved = await captureFence(destination)
  if (!sameInode(captured.stat, moved.stat) || !captured.bytes.equals(moved.bytes)) {
    throw new ApiRecoveryFenceError('fence-changed', 'The recovery fence changed while entering quarantine; preserve both paths and stop recovery.')
  }
  return destination
}

/**
 * Fence API admission for one recovery under the caller's host lifecycle lock.
 * Complete owner metadata is fsynced before exclusive publication; a controller crash
 * therefore leaves either no active fence or one with an exact recoverable identity.
 * @param directory - API state directory.
 * @param run - recovery work performed while admission is excluded.
 * @param options - host identity and boot probes.
 * @returns the recovery result after ownership-checked fence release.
 */
export async function withApiRecoveryFence<T>(directory: string, run: () => Promise<T>, options: ApiRecoveryFenceOptions = {}): Promise<T> {
  await mkdir(directory, { recursive: true })
  await reclaimApiRecoveryFence(directory, options)
  const controller = await (options.inspectController ?? (async () => await inspectProcessIdentity(process.pid)))()
  if (controller === null) throw new ApiRecoveryFenceError('unknown-controller', 'The recovery controller has no host start identity; admission was not fenced.')
  const file = path.join(directory, API_RECOVERY_FENCE_FILE)
  const id = randomUUID()
  const temporary = path.join(directory, `.${API_RECOVERY_FENCE_FILE}-${id}.tmp`)
  const bytes = Buffer.from(JSON.stringify({ version: 1, id, startedAt: new Date().toISOString(),
    controller: { pid: controller.pid, startTime: controller.startTime } }))
  const handle = await open(temporary, 'wx', 0o600)
  let stat: BigIntStats
  try {
    try {
      await handle.writeFile(bytes)
      await handle.sync()
      stat = await handle.stat({ bigint: true })
    } finally { await handle.close() }
    await link(temporary, file)
  } finally { await unlink(temporary) }
  const owned = { file, stat, bytes }
  let failed = false
  let primary: unknown
  try {
    return await run()
  } catch (error) {
    failed = true
    primary = error
    throw error
  } finally {
    try {
      await unchangedFence(owned)
      await unlink(file)
    } catch (error) {
      if (failed) throw new AggregateError([primary, error], 'API recovery and admission-fence release failed')
      throw error
    }
  }
}

/** Read regular-file bytes with the identity that owns them. */
async function captureFence(file: string): Promise<FenceFile> {
  const before = await lstat(file, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink()) throw new ApiRecoveryFenceError('fence-changed', 'The API recovery fence is not a regular file.')
  const handle = await open(file, 'r')
  try {
    const stat = await handle.stat({ bigint: true })
    const bytes = await handle.readFile()
    const after = await handle.stat({ bigint: true })
    if (!sameInode(before, stat) || !sameInode(stat, after) || stat.mtimeNs !== after.mtimeNs || stat.size !== after.size) {
      throw new ApiRecoveryFenceError('fence-changed', 'The API recovery fence changed while being read.')
    }
    return { file, stat, bytes }
  } finally { await handle.close() }
}

/** Preserve replacements rather than deleting another controller's admission fence. */
async function unchangedFence(before: FenceFile): Promise<void> {
  const stat = await lstat(before.file, { bigint: true })
  if (!stat.isFile() || stat.isSymbolicLink() || !sameInode(before.stat, stat) || !(await readFile(before.file)).equals(before.bytes)) {
    throw new ApiRecoveryFenceError('fence-changed', 'The API recovery fence changed; its replacement was preserved.')
  }
}

function sameInode(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}
