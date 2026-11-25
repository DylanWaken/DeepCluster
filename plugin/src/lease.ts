/**
 * Cooperative host-local resource leases. Expiration is diagnostic: even dead
 * coordinators may leave live descendants. Recovery requires verified termination.
 */
import { mkdir, readFile, readdir, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { LeaseToken, OwnershipGeneration } from './types.ts'
import { isOwnershipGeneration, publishOwnershipRecord } from './ownership-generation.ts'

/** Ownership record retained until the worker and all descendants stop. */
export interface LeaseRecord {
  readonly resource: string
  readonly owner: string
  readonly token: LeaseToken
  readonly pid: number
  readonly note?: string
  readonly acquiredAt: string
  readonly expiresAt: string
  /** Worker receipt generation required before reclaiming this record. */
  readonly ownershipGeneration?: OwnershipGeneration
}

/** Ownership token required to renew or release a resource. */
export interface Lease {
  readonly resource: string
  readonly owner: string
  readonly token: LeaseToken
  readonly record: LeaseRecord
}

/** Acquisition settings; expiry never revokes ownership. */
export interface AcquireOptions {
  readonly ttlMs?: number
  readonly waitMs?: number
  readonly note?: string
  readonly owner: string
  readonly signal?: AbortSignal
  readonly ownershipGeneration?: OwnershipGeneration
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
}

/** Another worker retained ownership through the wait budget. */
export class LeaseTimeoutError extends Error {
  constructor(resource: string, waitedMs: number, holder: string) {
    super(`lease "${resource}" was not free after ${String(waitedMs)}ms (held by ${holder}); inspect its worker before recovery`)
    this.name = 'LeaseTimeoutError'
  }
}

/** A token no longer owns the resource. */
export class LeaseLostError extends Error {
  constructor(resource: string) {
    super(`lease "${resource}" is no longer held by this agent`)
    this.name = 'LeaseLostError'
  }
}

/** Ownership cannot be established; the resource remains unavailable. */
export class LeaseStateError extends Error {
  constructor(file: string, cause: unknown) {
    super(`cannot establish ownership from ${file}; preserve the lease and confirm worker termination before recovery`, { cause })
    this.name = 'LeaseStateError'
  }
}

/** Directory shared by coordinators using this master directory. */
function directory(root: string): string {
  return path.join(root, 'leases')
}

/** Encode identifiers so they cannot traverse directories. */
function lockPath(root: string, resource: string): string {
  return path.join(directory(root), `${encodeURIComponent(resource)}.lock`)
}

/**
 * Whether a recorded process still exists.
 * @param pid - positive process identifier.
 * @returns false only for ESRCH; EPERM and other failures remain conservatively alive.
 */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/** Validate persisted ownership before exposing it to the scheduler. */
function isRecord(value: unknown): value is LeaseRecord {
  if (typeof value !== 'object' || value === null) return false
  return 'resource' in value && typeof value.resource === 'string' &&
    'owner' in value && typeof value.owner === 'string' &&
    'token' in value && typeof value.token === 'string' && value.token.length > 0 &&
    'pid' in value && typeof value.pid === 'number' && Number.isSafeInteger(value.pid) && value.pid > 0 &&
    'acquiredAt' in value && typeof value.acquiredAt === 'string' && Number.isFinite(Date.parse(value.acquiredAt)) &&
    'expiresAt' in value && typeof value.expiresAt === 'string' && Number.isFinite(Date.parse(value.expiresAt)) &&
    (!('ownershipGeneration' in value) || isOwnershipGeneration(value.ownershipGeneration))
}

/** Absence permits acquisition; corruption and access failures never do. */
async function readLock(file: string): Promise<LeaseRecord | undefined> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new LeaseStateError(file, error)
  }
  try {
    const value: unknown = JSON.parse(text)
    if (!isRecord(value)) throw new Error('invalid lease fields')
    return value
  } catch (error) {
    throw new LeaseStateError(file, error)
  }
}

/** Absence is the only ignorable failure when removing an owned path. */
async function removeOwned(file: string): Promise<void> {
  try {
    await unlink(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

/** Read live waiter tickets without treating access failures as an empty queue. */
async function ticketsFor(root: string, resource: string): Promise<string[]> {
  let entries: string[]
  try {
    entries = await readdir(directory(root))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const live: string[] = []
  for (const name of entries.filter(item => item.startsWith(`${encodeURIComponent(resource)}.ticket-`) && !item.endsWith('.tmp'))) {
    let ticket: unknown
    try {
      ticket = JSON.parse(await readFile(path.join(directory(root), name), 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw new LeaseStateError(path.join(directory(root), name), error)
    }
    const match = /\.ticket-\d+-p(\d+)-/u.exec(name)
    const generationOwned = typeof ticket === 'object' && ticket !== null && 'ownershipGeneration' in ticket
    if (!generationOwned && match !== null && !processAlive(Number(match[1]))) await removeOwned(path.join(directory(root), name))
    else live.push(name)
  }
  return live.sort()
}

/**
 * Acquire a resource using oldest-ticket admission and atomic exclusive creation.
 * @param root - host-shared lease namespace, independent of worker workspaces.
 * @param resource - hardware or workspace resource identifier.
 * @param options - owner, wait budget, diagnostic lifetime, and cancellation.
 * @returns lease retained by the caller until worker teardown completes.
 */
export async function acquireLease(root: string, resource: string, options: AcquireOptions): Promise<Lease> {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? (async (ms: number) => { await delay(ms, undefined, { signal: options.signal }) })
  const ttlMs = options.ttlMs ?? 15 * 60_000
  const waitMs = options.waitMs ?? 5 * 60_000
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || !Number.isFinite(waitMs) || waitMs < 0) {
    throw new RangeError('lease ttlMs must be positive and waitMs must be nonnegative')
  }
  options.signal?.throwIfAborted()
  const started = now()
  const token = randomUUID() as LeaseToken
  await mkdir(directory(root), { recursive: true })
  const ticket = path.join(directory(root), `${encodeURIComponent(resource)}.ticket-${String(started).padStart(15, '0')}-p${String(process.pid)}-${token}`)
  await publishOwnershipRecord(ticket, { owner: options.owner, pid: process.pid,
    ...options.ownershipGeneration === undefined ? {} : { ownershipGeneration: options.ownershipGeneration },
  }, options.ownershipGeneration)
  let lastHolder = 'unknown'
  try {
    for (;;) {
      options.signal?.throwIfAborted()
      const file = lockPath(root, resource)
      const held = await readLock(file)
      if (held !== undefined) lastHolder = `${held.owner}#${String(held.pid)}`
      else if ((await ticketsFor(root, resource))[0] === path.basename(ticket)) {
        const record: LeaseRecord = {
          resource, owner: options.owner, token, pid: process.pid,
          ...options.note === undefined ? {} : { note: options.note },
          ...options.ownershipGeneration === undefined ? {} : { ownershipGeneration: options.ownershipGeneration },
          acquiredAt: new Date(now()).toISOString(), expiresAt: new Date(now() + ttlMs).toISOString(),
        }
        try {
          await publishOwnershipRecord(file, record, options.ownershipGeneration)
          return { resource, owner: options.owner, token, record }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        }
      }
      if (now() - started >= waitMs) throw new LeaseTimeoutError(resource, waitMs, lastHolder)
      await sleep(Math.min(100, Math.max(1, waitMs - (now() - started))))
    }
  } finally {
    await removeOwned(ticket)
  }
}

/**
 * Extend a diagnostic deadline without interrupting ownership observations.
 * @param root - namespace used at acquisition.
 * @param lease - held token; renewal and release must not overlap for this token.
 * @param ttlMs - diagnostic lifetime in milliseconds.
 * @returns updated persisted record.
 */
export async function renewLease(root: string, lease: Lease, ttlMs = 15 * 60_000): Promise<LeaseRecord> {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new RangeError('ttlMs must be positive')
  const file = lockPath(root, lease.resource)
  const current = await readLock(file)
  if (current?.token !== lease.token) throw new LeaseLostError(lease.resource)
  const updated: LeaseRecord = { ...current, expiresAt: new Date(Date.now() + ttlMs).toISOString() }
  await publishOwnershipRecord(file, updated, updated.ownershipGeneration, true)
  return updated
}

/**
 * Release ownership after all worker processes terminate. Absence is idempotent.
 * @param root - namespace used at acquisition.
 * @param lease - token of the quiescent owner.
 * @returns when the resource is available; a different current token rejects.
 */
export async function releaseLease(root: string, lease: Lease): Promise<void> {
  const file = lockPath(root, lease.resource)
  const current = await readLock(file)
  if (current === undefined) return
  if (current.token !== lease.token) throw new LeaseLostError(lease.resource)
  await removeOwned(file)
}

/**
 * Inspect ownership; stale means investigation, never permission to steal.
 * `expired` reports only the diagnostic deadline, and `ownerAlive` reports the recorded
 * process identity. Neither flag permits reclamation.
 * @param root - shared lease namespace.
 * @param resource - resource identifier.
 * @returns current holder, diagnostic flags, and live waiter count.
 */
export async function leaseStatus(root: string, resource: string): Promise<{
  held: LeaseRecord | undefined
  stale: boolean
  expired: boolean
  ownerAlive: boolean
  waiting: number
}> {
  const held = await readLock(lockPath(root, resource))
  const tickets = await ticketsFor(root, resource)
  const expired = held !== undefined && Date.parse(held.expiresAt) <= Date.now()
  const ownerAlive = held !== undefined && processAlive(held.pid)
  const stale = held !== undefined && (expired || !ownerAlive)
  return { held, stale, expired, ownerAlive, waiting: tickets.length }
}
