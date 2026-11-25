/**
 * Cross-process write claims for DeepCluster scheduling.
 *
 * A claim is additive and nonreplaceable: an omitted access declaration reserves the
 * whole physical worktree, `writes:` reserves disjoint literal paths, and `access: read-only`
 * reserves nothing. Every request and record carries the canonical absolute directory its
 * relative path is resolved against, so a parent workspace, a child workspace, a nested
 * repository and a Git top level conflict on one physical path even when their scope keys
 * differ. Claims live in the shared lease namespace so independent coordinators cannot race
 * through a check-then-create window: every mutation runs under one registry mutex and
 * records are written with unique exclusive names. Windows uses an OS-owned named pipe
 * keyed by the canonical registry directory, which closes when its owner exits.
 *
 * Expiry is a diagnostic deadline only; an expired or dead-owner claim is never reclaimed.
 * Legacy directory mutexes remain blocking evidence until verified recovery. Non-Windows
 * registries retain directory mutexes and require explicit recovery after an owner crash.
 *
 * Released claims are appended to one bounded, atomically replaced history file so an audit
 * can still explain a change made by a short operation that finished before another
 * operation audited. Retention records the newest removed release; an audit that needs
 * evidence older than that reports incomplete attribution instead of blaming a writer.
 *
 * @module @deepseek-ai/dsh-experimental-deep-cluster/claims
 */

import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { LeaseToken, OwnershipGeneration } from './types.ts'
import { isOwnershipGeneration, publishOwnershipRecord } from './ownership-generation.ts'
import { acquireServiceLifecycleLock } from './service-lock.ts'
import { claimSpanCovers, claimSpanKey, claimSpansOverlap, comparisonKey,
  type ClaimSpan, type NormalizedClaimPath } from './scope.ts'
import { processAlive } from './lease.ts'

/** One scope a claim can reserve. */
export type ClaimKind = 'worktree' | 'path' | 'metadata'

/** One requested reservation, already canonicalized against its worktree. */
export interface ClaimRequest {
  /** Canonical scope key retained for diagnostics and journaling. */
  readonly scope: string
  /**
   * Canonical absolute directory the relative path is resolved against: the physical
   * worktree for `worktree`/`path`, or the Git common directory for `metadata`.
   */
  readonly root: string
  readonly kind: ClaimKind
  /** Root-relative claim for `worktree`/`path`; unused for `metadata`. */
  readonly path: NormalizedClaimPath
}

/** Persisted ownership of one requested claim. */
export interface WriteClaimRecord {
  /** Unique record filename, also the record identity. */
  readonly id: string
  /** Canonical absolute directory the relative path is resolved against. */
  readonly root: string
  readonly scope: string
  readonly kind: ClaimKind
  readonly path: string
  readonly directory: boolean
  readonly owner: string
  readonly token: LeaseToken
  readonly pid: number
  readonly acquiredAt: string
  readonly expiresAt: string
  /** Set when ownership ended; the released copy remains in the bounded audit history. */
  readonly releasedAt?: string
  readonly note?: string
  /** Worker receipt generation required before reclaiming this record. */
  readonly ownershipGeneration?: OwnershipGeneration
}

/** Live and released claim evidence, with the newest release removed by retention. */
export interface ClaimHistory {
  readonly records: readonly WriteClaimRecord[]
  /** Newest `releasedAt` removed by retention; absent when no release was pruned. */
  readonly prunedThrough?: string
}

/** One acquired claim set; every record shares the same owner token. */
export interface WriteClaimSet {
  readonly token: LeaseToken
  readonly requests: readonly ClaimRequest[]
  readonly records: readonly WriteClaimRecord[]
}

/** Acquisition settings; expiry never revokes ownership. */
export interface AcquireWriteClaimOptions {
  readonly owner: string
  readonly ownershipGeneration?: OwnershipGeneration
  readonly requests: readonly ClaimRequest[]
  readonly ttlMs?: number
  readonly waitMs?: number
  readonly note?: string
  readonly signal?: AbortSignal
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
}

/** Renewal and release options shared by both mutations. */
export interface ClaimHeartbeatOptions {
  readonly signal?: AbortSignal
  readonly now?: () => number
}

/** The requested claims remained held by other coordinators through the wait budget. */
export class WriteClaimTimeoutError extends Error {
  override name = 'WriteClaimTimeoutError'
  readonly scope: string

  /**
   * @param scope - contested scope key.
   * @param waitedMs - wait budget consumed.
   * @param holders - current holders for operator diagnosis.
   */
  constructor(scope: string, waitedMs: number, holders: readonly string[]) {
    super(`write claims in scope "${scope}" were not free after ${String(waitedMs)}ms (held by ${holders.join(', ') || 'unknown'}); inspect those coordinators before recovery`)
    this.scope = scope
  }
}

/** This coordinator's token no longer owns a claim record. */
export class WriteClaimLostError extends Error {
  override name = 'WriteClaimLostError'
  readonly scope: string

  /**
   * @param scope - scope whose record is no longer owned by this token.
   */
  constructor(scope: string) {
    super(`write claim in scope "${scope}" is no longer held by this coordinator`)
    this.scope = scope
  }
}

/** Claim state cannot be established; acquisition fails closed. */
export class WriteClaimStateError extends Error {
  override name = 'WriteClaimStateError'
}

/** Directory holding every persisted claim and the acquisition mutex. */
function claimsDirectory(root: string): string {
  return path.join(root, 'claims')
}

/** Maximum time one caller waits for the acquisition mutex. */
const MUTEX_WAIT_MS = 10_000
/** Poll interval while the mutex is held. */
const MUTEX_POLL_MS = 20
/** Released claims retained for audit attribution. */
const HISTORY_RETENTION_MS = 12 * 60 * 60_000
/** Maximum released claims retained after time-based pruning. */
const HISTORY_MAX_RELEASED = 1_000

/** Audit history of released claims, replaced atomically under the registry mutex. */
function historyFile(root: string): string {
  return path.join(root, 'claim-history.json')
}

/** Persisted release history and the newest release retention removed. */
interface ReleaseHistory {
  readonly records: readonly WriteClaimRecord[]
  readonly prunedThrough?: string
}

/**
 * Validate and normalize one persisted claim record.
 * A record written before canonical roots were stored falls back to its scope key, which
 * is already the canonical worktree or Git common-directory comparison key.
 */
function normalizedRecord(value: unknown): WriteClaimRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (!(typeof record.id === 'string' && record.id.length > 0 &&
    typeof record.scope === 'string' && record.scope.length > 0 &&
    (record.kind === 'worktree' || record.kind === 'path' || record.kind === 'metadata') &&
    typeof record.path === 'string' && typeof record.directory === 'boolean' &&
    typeof record.owner === 'string' && record.owner.length > 0 &&
    typeof record.token === 'string' && record.token.length > 0 &&
    typeof record.pid === 'number' && Number.isSafeInteger(record.pid) && record.pid > 0 &&
    typeof record.acquiredAt === 'string' && Number.isFinite(Date.parse(record.acquiredAt)) &&
    typeof record.expiresAt === 'string' && Number.isFinite(Date.parse(record.expiresAt)) &&
    (!('note' in record) || typeof record.note === 'string') &&
    (!('ownershipGeneration' in record) || isOwnershipGeneration(record.ownershipGeneration)) &&
    (!('releasedAt' in record) || record.releasedAt === undefined ||
      (typeof record.releasedAt === 'string' && Number.isFinite(Date.parse(record.releasedAt)))))) return undefined
  const root = typeof record.root === 'string' && record.root.length > 0
    ? record.root
    : record.scope
  const releasedAt = typeof record.releasedAt === 'string' ? record.releasedAt : undefined
  const note = typeof record.note === 'string' ? record.note : undefined
  return {
    id: record.id,
    root,
    scope: record.scope,
    kind: record.kind,
    path: record.path,
    directory: record.directory,
    owner: record.owner,
    token: record.token as LeaseToken,
    pid: record.pid,
    acquiredAt: record.acquiredAt,
    expiresAt: record.expiresAt,
    ...releasedAt === undefined ? {} : { releasedAt },
    ...note === undefined ? {} : { note },
    ...isOwnershipGeneration(record.ownershipGeneration) ? { ownershipGeneration: record.ownershipGeneration } : {},
  }
}

/** Read every valid record; corruption and access failures never look empty. */
async function readRecords(directory: string): Promise<WriteClaimRecord[]> {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new WriteClaimStateError('cannot read the write-claim registry; preserve it and confirm worker termination before recovery', { cause: error })
  }
  const records: WriteClaimRecord[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    let text: string
    try {
      text = await readFile(path.join(directory, entry.name), 'utf8')
    } catch (error) {
      // A live record can disappear between the listing and the read only when its owner
      // released it; release records the bounded history entry before unlinking, so
      // readers must ignore this race instead of failing a concurrent audit or admission.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw new WriteClaimStateError(`cannot establish write-claim state from "${entry.name}"; preserve the registry before recovery`, { cause: error })
    }
    try {
      const record = normalizedRecord(JSON.parse(text))
      if (record === undefined) throw new Error('invalid claim fields')
      records.push(record)
    } catch (error) {
      throw new WriteClaimStateError(`cannot establish write-claim state from "${entry.name}"; preserve the registry before recovery`, { cause: error })
    }
  }
  return records.sort((left, right) => left.id.localeCompare(right.id))
}

/** Read the bounded release history; corruption and access failures never look empty. */
async function readReleaseHistory(root: string): Promise<ReleaseHistory> {
  let text: string
  try {
    text = await readFile(historyFile(root), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { records: [] }
    throw new WriteClaimStateError('cannot read the released-claim history; preserve the registry before recovery', { cause: error })
  }
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null || !('records' in value) || !Array.isArray(value.records)) {
      throw new Error('invalid release history fields')
    }
    const records: WriteClaimRecord[] = []
    for (const item of value.records) {
      const record = normalizedRecord(item)
      if (record === undefined || record.releasedAt === undefined) throw new Error('invalid release history record')
      records.push(record)
    }
    let prunedThrough: string | undefined
    if ('prunedThrough' in value) {
      if (typeof value.prunedThrough !== 'string' || !Number.isFinite(Date.parse(value.prunedThrough))) {
        throw new Error('invalid release history retention marker')
      }
      prunedThrough = value.prunedThrough
    }
    return { records, ...prunedThrough === undefined ? {} : { prunedThrough } }
  } catch (error) {
    throw new WriteClaimStateError('cannot read the released-claim history; preserve the registry before recovery', { cause: error })
  }
}

/** Replace the release history atomically so audits never observe a partial file. */
async function writeReleaseHistory(root: string, history: ReleaseHistory): Promise<void> {
  const file = historyFile(root)
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(history), { flag: 'wx' })
  try {
    await rename(temporary, file)
  } finally {
    try {
      await unlink(temporary)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

/** Bound released evidence by time and count without losing the oldest-removed marker. */
function boundReleaseHistory(history: ReleaseHistory, nowMs: number): ReleaseHistory {
  const cutoff = nowMs - HISTORY_RETENTION_MS
  const removed = new Set<string>()
  for (const record of history.records) {
    if (record.releasedAt !== undefined && Date.parse(record.releasedAt) < cutoff) removed.add(record.id)
  }
  const retained = history.records.filter(record => !removed.has(record.id))
    .sort((left, right) => (left.releasedAt ?? '').localeCompare(right.releasedAt ?? ''))
  for (const record of retained.slice(0, Math.max(0, retained.length - HISTORY_MAX_RELEASED))) removed.add(record.id)
  if (removed.size === 0) return history
  let prunedThrough = history.prunedThrough ?? '1970-01-01T00:00:00.000Z'
  for (const record of history.records) {
    if (!removed.has(record.id) || record.releasedAt === undefined) continue
    if (record.releasedAt > prunedThrough) prunedThrough = record.releasedAt
  }
  return { records: history.records.filter(record => !removed.has(record.id)), prunedThrough }
}

/** Append one released claim and reapply retention bounds before the live record is removed. */
async function recordRelease(root: string, record: WriteClaimRecord): Promise<void> {
  const history = await readReleaseHistory(root)
  const merged = [...history.records.filter(item => item.id !== record.id), record]
  await writeReleaseHistory(root, boundReleaseHistory({ ...history, records: merged }, Date.now()))
}

/** Reapply retention bounds during acquisition without touching any live record. */
async function pruneReleaseHistory(root: string, nowMs: number): Promise<void> {
  const history = await readReleaseHistory(root)
  const bounded = boundReleaseHistory(history, nowMs)
  if (bounded.records.length !== history.records.length || bounded.prunedThrough !== history.prunedThrough) {
    await writeReleaseHistory(root, bounded)
  }
}

/**
 * Take the registry mutex. A mutex held by another process is never renamed or removed:
 * observing an old owner and then replacing its directory has a check-then-act window in
 * which a fresh owner can be displaced. A stuck mutex fails closed for manual recovery.
 * @param root - shared lease namespace.
 * @param signal - cancellation for the wait.
 * @param now - clock used for the wait budget.
 * @param sleep - wait implementation.
 * @param waitMs - maximum time to wait for the mutex.
 * @returns a token-checked release operation.
 */
async function lockClaims(root: string, signal: AbortSignal | undefined, now: () => number,
  sleep: (ms: number) => Promise<void>, waitMs = MUTEX_WAIT_MS): Promise<() => Promise<void>> {
  const directory = path.join(claimsDirectory(root), 'mutex')
  await mkdir(claimsDirectory(root), { recursive: true })
  if (process.platform === 'win32') {
    const canonical = comparisonKey(await realpath(claimsDirectory(root)))
    const key = createHash('sha256').update(canonical).digest('hex')
    const release = await acquireServiceLifecycleLock({
      pipeName: `\\\\.\\pipe\\deepcluster-claims-${key}`, timeoutMs: waitMs,
      ...signal === undefined ? {} : { signal },
    })
    let legacyExists = true
    try {
      await lstat(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') legacyExists = false
      else {
        await release()
        throw new WriteClaimStateError('cannot inspect the legacy write-claim mutex; preserve the registry before recovery', { cause: error })
      }
    }
    if (legacyExists) {
      await release()
      throw new WriteClaimStateError(`the legacy write-claim mutex at "${directory}" requires verified recovery; automatic takeover is disabled until its worker ownership is resolved`)
    }
    return release
  }
  const token = randomUUID()
  const started = now()
  for (;;) {
    signal?.throwIfAborted()
    let created = false
    try {
      await mkdir(directory)
      created = true
      await writeFile(path.join(directory, 'owner.json'), JSON.stringify({ pid: process.pid, token, at: new Date(now()).toISOString() }), { flag: 'wx' })
    } catch (error) {
      if (created) {
        try {
          await rm(directory, { recursive: true, force: true })
        } catch (cleanupError) {
          throw new WriteClaimStateError('the write-claim mutex was created but its owner record failed; preserve the registry and inspect coordinators before recovery',
            { cause: new AggregateError([error, cleanupError], 'mutex initialization and cleanup both failed') })
        }
        throw new WriteClaimStateError('cannot initialize the write-claim mutex', { cause: error })
      }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new WriteClaimStateError('cannot acquire the write-claim mutex', { cause: error })
      }
      if (now() - started >= waitMs) {
        throw new WriteClaimStateError(`the write-claim mutex at "${directory}" stayed held beyond its wait budget; automatic takeover is disabled because replacing it is not atomic. Confirm no coordinator is running, inspect owner.json, then remove that directory manually`)
      }
      await sleep(MUTEX_POLL_MS)
      continue
    }
    return async () => {
      let owner: unknown
      try {
        owner = JSON.parse(await readFile(path.join(directory, 'owner.json'), 'utf8'))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw new WriteClaimStateError('cannot read the write-claim mutex owner; preserve it and inspect coordinators before recovery', { cause: error })
      }
      if (!(typeof owner === 'object' && owner !== null && 'token' in owner && owner.token === token)) {
        throw new WriteClaimStateError('the write-claim mutex is no longer owned by this coordinator; preserve it and inspect coordinators before recovery')
      }
      try {
        await rm(directory, { recursive: true, force: true })
      } catch (error) {
        throw new WriteClaimStateError('cannot release the write-claim mutex; preserve it and inspect coordinators before recovery', { cause: error })
      }
    }
  }
}

/** Deduplicate and order requests so independent coordinators acquire in one global order. */
function ordered(requests: readonly ClaimRequest[]): ClaimRequest[] {
  const seen = new Map<string, ClaimRequest>()
  for (const request of requests) {
    const key = JSON.stringify([request.root, request.scope, request.kind, request.path.key, request.path.directory])
    if (!seen.has(key)) seen.set(key, request)
  }
  return [...seen.values()].sort((left, right) => {
    const leftKey = JSON.stringify([left.root, left.scope, left.kind, left.path.key, left.path.directory])
    const rightKey = JSON.stringify([right.root, right.scope, right.kind, right.path.key, right.path.directory])
    return leftKey.localeCompare(rightKey)
  })
}

/** Physical span covered by one requested claim. */
function requestSpan(request: ClaimRequest): ClaimSpan {
  return { root: request.root, path: request.path.path, directory: request.path.directory }
}

/** Physical span covered by one persisted record. */
function recordSpan(record: WriteClaimRecord): ClaimSpan {
  return { root: record.root, path: record.path, directory: record.directory }
}

/**
 * Whether two requested claims conflict.
 *
 * Source claims conflict by canonical absolute span, even when a parent workspace, a child
 * workspace, a nested repository or a Git top level named them through different scope keys.
 * Git metadata is a separate accounting namespace: it conflicts only with metadata on the
 * same or a nested common directory, and every `git: write` step also holds its worktree.
 * @param left - first canonical request.
 * @param right - second canonical request.
 * @returns true when both may touch the same physical path.
 */
export function claimRequestsOverlap(left: ClaimRequest, right: ClaimRequest): boolean {
  if (left.kind === 'metadata' || right.kind === 'metadata') {
    // Git metadata is a separate accounting namespace: a source writer never claims
    // `.git`, and every git: write step also holds the whole physical worktree.
    return left.kind === 'metadata' && right.kind === 'metadata' &&
      claimSpansOverlap(requestSpan(left), requestSpan(right))
  }
  return claimSpansOverlap(requestSpan(left), requestSpan(right))
}

/**
 * Whether a persisted record conflicts with a requested claim.
 * @param record - held ownership record.
 * @param request - requested claim.
 * @returns true when both may touch the same physical path.
 */
export function claimRecordOverlaps(record: WriteClaimRecord, request: ClaimRequest): boolean {
  if (record.kind === 'metadata' || request.kind === 'metadata') {
    return record.kind === 'metadata' && request.kind === 'metadata' &&
      claimSpansOverlap(recordSpan(record), requestSpan(request))
  }
  return claimSpansOverlap(recordSpan(record), requestSpan(request))
}

/**
 * Whether a requested claim authorizes a changed `/`-separated path under its own root.
 * @param request - canonical requested claim.
 * @param pathKey - case-folded root-relative path.
 * @returns true when the path is the claim or a descendant of a directory claim.
 */
export function claimRequestCovers(request: ClaimRequest, pathKey: string): boolean {
  return claimRequestCoversPath(request, request.root, pathKey)
}

/**
 * Whether a persisted record authorizes a changed `/`-separated path under its own root.
 * @param record - held ownership record.
 * @param pathKey - case-folded root-relative path.
 * @returns true when the path is the record's claim or a descendant of it.
 */
export function claimRecordCovers(record: WriteClaimRecord, pathKey: string): boolean {
  return claimRecordCoversPath(record, record.root, pathKey)
}

/**
 * Whether a requested claim authorizes a source path in a possibly different worktree root.
 * @param request - canonical requested claim.
 * @param worktreeRoot - canonical absolute worktree the changed path belongs to.
 * @param path - `/`-separated changed path.
 * @returns true when a worktree or path claim covers the absolute path.
 */
export function claimRequestCoversPath(request: ClaimRequest, worktreeRoot: string, path: string): boolean {
  if (request.kind === 'metadata') return false
  return claimSpanCovers(requestSpan(request), claimSpanKey({ root: worktreeRoot, path, directory: false }))
}

/**
 * Whether a persisted claim authorizes a source path in a possibly different worktree root.
 * @param record - persisted claim record.
 * @param worktreeRoot - canonical absolute worktree the changed path belongs to.
 * @param path - `/`-separated changed path.
 * @returns true when a worktree or path claim covers the absolute path.
 */
export function claimRecordCoversPath(record: WriteClaimRecord, worktreeRoot: string, path: string): boolean {
  if (record.kind === 'metadata') return false
  return claimSpanCovers(recordSpan(record), claimSpanKey({ root: worktreeRoot, path, directory: false }))
}

/**
 * Whether a requested explicit path claim authorizes changing pre-existing dirty work.
 * Whole-worktree claims do not: preserving dirty work requires declaring its path.
 * @param request - canonical requested claim.
 * @param worktreeRoot - canonical absolute worktree.
 * @param path - `/`-separated changed path.
 * @returns true only for a `path` claim covering the path.
 */
export function claimRequestCoversDirtyPath(request: ClaimRequest, worktreeRoot: string, path: string): boolean {
  return request.kind === 'path' && claimRequestCoversPath(request, worktreeRoot, path)
}

/**
 * Whether a persisted explicit path claim authorizes changing pre-existing dirty work.
 * @param record - persisted claim record.
 * @param worktreeRoot - canonical absolute worktree.
 * @param path - `/`-separated changed path.
 * @returns true only for a `path` claim covering the path.
 */
export function claimRecordCoversDirtyPath(record: WriteClaimRecord, worktreeRoot: string, path: string): boolean {
  return record.kind === 'path' && claimRecordCoversPath(record, worktreeRoot, path)
}

/**
 * Whether a requested claim reserves Git metadata at a common directory.
 * @param request - canonical requested claim.
 * @param commonDir - canonical Git common directory.
 * @returns true for a metadata claim covering that directory.
 */
export function claimRequestCoversGitMetadata(request: ClaimRequest, commonDir: string): boolean {
  return request.kind === 'metadata' && claimSpanCovers(requestSpan(request), comparisonKey(commonDir))
}

/**
 * Whether a persisted claim reserves Git metadata at a common directory.
 * @param record - persisted claim record.
 * @param commonDir - canonical Git common directory.
 * @returns true for a metadata claim covering that directory.
 */
export function claimRecordCoversGitMetadata(record: WriteClaimRecord, commonDir: string): boolean {
  return record.kind === 'metadata' && claimSpanCovers(recordSpan(record), comparisonKey(commonDir))
}

/**
 * Whether a claim was observed between two snapshot times.
 * @param record - persisted claim record, live or released.
 * @param startMs - epoch milliseconds of the earlier observation.
 * @param endMs - epoch milliseconds of the later observation.
 * @returns true when the ownership interval intersects the observation window.
 */
export function claimRecordActiveBetween(record: WriteClaimRecord, startMs: number, endMs: number): boolean {
  const acquired = Date.parse(record.acquiredAt)
  const released = record.releasedAt === undefined ? Number.POSITIVE_INFINITY : Date.parse(record.releasedAt)
  return acquired <= endMs && released >= startMs
}

/**
 * Read every live claim without mutating anything.
 * @param root - shared lease namespace.
 * @param scope - optional canonical scope filter.
 * @returns persisted records in stable order.
 */
export async function listWriteClaims(root: string, scope?: string): Promise<WriteClaimRecord[]> {
  const live = (await readRecords(claimsDirectory(root))).filter(record => record.releasedAt === undefined)
  return scope === undefined ? live : live.filter(record => record.scope === scope)
}

/**
 * Read live and released claim evidence for audit attribution.
 *
 * Released records remain until bounded retention prunes them. `prunedThrough` marks the
 * newest release whose evidence is gone, so a caller observing an older window can report
 * incomplete attribution instead of blaming a writer.
 * @param root - shared lease namespace.
 * @returns every retained record and the newest pruned release time.
 */
export async function readClaimHistory(root: string): Promise<ClaimHistory> {
  const live = await readRecords(claimsDirectory(root))
  const released = await readReleaseHistory(root)
  const records = new Map(live.map(record => [record.id, record]))
  for (const record of released.records) records.set(record.id, record)
  return {
    records: [...records.values()].sort((left, right) => left.id.localeCompare(right.id)),
    ...released.prunedThrough === undefined ? {} : { prunedThrough: released.prunedThrough },
  }
}

/**
 * Inspect claim availability for diagnostics; expired claims remain held.
 * @param root - shared lease namespace.
 * @param scope - canonical scope filter.
 * @param requests - candidate claims to test.
 * @returns held records, current conflicts and a stale diagnostic flag.
 */
export async function writeClaimStatus(root: string, scope: string, requests: readonly ClaimRequest[]): Promise<{
  held: readonly WriteClaimRecord[]
  conflicts: readonly WriteClaimRecord[]
  stale: boolean
}> {
  const held = await listWriteClaims(root, scope)
  return {
    held,
    conflicts: held.filter(record => requests.some(request => claimRecordOverlaps(record, request))),
    stale: held.some(record => Date.parse(record.expiresAt) <= Date.now() || !processAlive(record.pid)),
  }
}

/**
 * Acquire every requested claim atomically under the registry mutex.
 * @param root - shared lease namespace.
 * @param options - owner, canonical requests, deadline, and cancellation.
 * @returns the retained claim set; a conflicting or expired claim is never replaced.
 */
export async function acquireWriteClaims(root: string, options: AcquireWriteClaimOptions): Promise<WriteClaimSet> {
  const requests = ordered(options.requests)
  const token = randomUUID() as LeaseToken
  if (requests.length === 0) return { token, requests, records: [] }
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? (async (ms: number) => { await delay(ms, undefined, { signal: options.signal }) })
  const ttlMs = options.ttlMs ?? 20 * 60_000
  const waitMs = options.waitMs ?? 20 * 60_000
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || !Number.isFinite(waitMs) || waitMs < 0) {
    throw new RangeError('claim ttlMs must be positive and waitMs must be nonnegative')
  }
  const started = now()
  const directory = claimsDirectory(root)
  let holders: string[] = []
  for (;;) {
    options.signal?.throwIfAborted()
    const release = await lockClaims(root, options.signal, now, sleep,
      Math.max(100, Math.min(MUTEX_WAIT_MS, waitMs)))
    let acquired: WriteClaimRecord[] = []
    try {
      const records = await readRecords(directory)
      const conflicts = records.filter(record => record.releasedAt === undefined &&
        requests.some(request => claimRecordOverlaps(record, request)))
      if (conflicts.length === 0) {
        const createdAt = new Date(now()).toISOString()
        const expiresAt = new Date(now() + ttlMs).toISOString()
        acquired = requests.map(request => ({
          id: `${randomUUID()}.json`,
          root: request.root,
          scope: request.scope,
          kind: request.kind,
          path: request.path.path,
          directory: request.path.directory,
          owner: options.owner,
          token,
          pid: process.pid,
          acquiredAt: createdAt,
          expiresAt,
          ...options.note === undefined ? {} : { note: options.note },
          ...options.ownershipGeneration === undefined ? {} : { ownershipGeneration: options.ownershipGeneration },
        }))
        for (const record of acquired) {
          await publishOwnershipRecord(path.join(directory, record.id), record, options.ownershipGeneration)
        }
        try {
          await pruneReleaseHistory(root, now())
        } catch {
          // Retention maintenance is best effort; the claims written above are authoritative
          // and an unpruned history only retains extra released evidence.
        }
        return { token, requests, records: acquired }
      }
      holders = conflicts.map(record => `${record.owner}#${String(record.pid)}`)
    } catch (error) {
      const cleanup: unknown[] = []
      for (const record of acquired) {
        try {
          await unlink(path.join(directory, record.id))
        } catch (cleanupError) {
          if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') cleanup.push(cleanupError)
        }
      }
      if (cleanup.length > 0) {
        throw new WriteClaimStateError('claim acquisition failed after partial registry writes; preserve the registry and confirm worker termination before recovery',
          { cause: new AggregateError([error, ...cleanup], 'claim acquisition and cleanup both failed') })
      }
      throw error
    } finally {
      await release()
    }
    if (now() - started >= waitMs) throw new WriteClaimTimeoutError(requests[0]?.scope ?? '', waitMs, holders)
    await sleep(Math.min(200, Math.max(20, waitMs - (now() - started))))
  }
}

/**
 * Extend every claim deadline while the worker is healthy.
 * @param root - shared lease namespace.
 * @param set - retained claim set.
 * @param ttlMs - new diagnostic lifetime.
 * @param options - cancellation and clock.
 * @returns the updated claim set.
 */
export async function renewWriteClaims(root: string, set: WriteClaimSet, ttlMs: number,
  options: ClaimHeartbeatOptions = {}): Promise<WriteClaimSet> {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new RangeError('ttlMs must be positive')
  if (set.records.length === 0) return set
  const now = options.now ?? Date.now
  const directory = claimsDirectory(root)
  const release = await lockClaims(root, options.signal, now, async (ms) => { await delay(ms, undefined, { signal: options.signal }) })
  try {
    const records: WriteClaimRecord[] = []
    for (const record of set.records) {
      const file = path.join(directory, record.id)
      let current: WriteClaimRecord | undefined
      try {
        current = normalizedRecord(JSON.parse(await readFile(file, 'utf8')))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new WriteClaimLostError(record.scope)
        throw new WriteClaimStateError('cannot read an owned write claim; preserve the registry before recovery', { cause: error })
      }
      if (current === undefined) throw new WriteClaimStateError('owned write claim is corrupt; preserve the registry before recovery')
      if (current.token !== set.token || current.releasedAt !== undefined) throw new WriteClaimLostError(record.scope)
      const updated: WriteClaimRecord = { ...current, expiresAt: new Date(now() + ttlMs).toISOString() }
      await publishOwnershipRecord(file, updated, updated.ownershipGeneration, true)
      records.push(updated)
    }
    return { ...set, records }
  } finally {
    await release()
  }
}

/**
 * Release every owned claim by appending it to the bounded release history and then removing
 * its live record. History is durable before removal, so an operation that audits after this
 * one finished still sees the released claim. Absence is idempotent; a different live token
 * rejects.
 * @param root - shared lease namespace.
 * @param set - retained claim set.
 */
export async function releaseWriteClaims(root: string, set: WriteClaimSet): Promise<void> {
  if (set.records.length === 0) return
  const directory = claimsDirectory(root)
  const now = Date.now
  const release = await lockClaims(root, undefined, now, async (ms) => { await delay(ms) })
  try {
    for (const record of [...set.records].reverse()) {
      const file = path.join(directory, record.id)
      let current: WriteClaimRecord | undefined
      try {
        current = normalizedRecord(JSON.parse(await readFile(file, 'utf8')))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw new WriteClaimStateError('cannot read an owned write claim; preserve the registry before recovery', { cause: error })
      }
      if (current === undefined) throw new WriteClaimStateError('owned write claim is corrupt; preserve the registry before recovery')
      if (current.releasedAt !== undefined) {
        await recordRelease(root, current)
        await unlink(file)
        continue
      }
      if (current.token !== set.token) throw new WriteClaimLostError(record.scope)
      await recordRelease(root, { ...current, releasedAt: new Date(now()).toISOString() })
      await unlink(file)
    }
  } finally {
    await release()
  }
}
