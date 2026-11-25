/** Durable one-shot dispatch of supervisor-authored runs into exact native session generations. */
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { listApiRuns } from './api-runs.ts'
import { ApiError, isActiveOperation, type ApiOperation, type ApiRunRequest, type OperationId } from './api-types.ts'

/** Caller-generated identity and stable idempotency key for one scheduled delivery. */
export type WakeupId = Branded<'DeepClusterWakeupId'>

/** A fixed, already validated run targeting one supervisor-assigned session generation. */
export interface WakeupRequest {
  readonly id: WakeupId
  readonly run: ApiRunRequest & { readonly session: NonNullable<ApiRunRequest['session']> }
  readonly trigger: { readonly kind: 'at'; readonly atISO: string }
    | { readonly kind: 'operation'; readonly operationId: OperationId; readonly when: 'settled' | 'attention' }
  readonly expiresAtISO: string
}

/** Persisted delivery state; operation outcomes are observed without retrying worker execution. */
export interface WakeupRecord extends WakeupRequest {
  readonly version: 1
  status: 'pending' | 'dispatching' | 'submitted' | 'completed' | 'interrupted' | 'failed' | 'cancelled' | 'expired'
  readonly createdAt: string
  updatedAt: string
  attempts: number
  nextAttemptAt: string
  operationId: OperationId | null
  error: { readonly code: string; readonly message: string } | null
  cancellationRequested: boolean
}

/** Deployment-owned queue size, admission retry budget, polling interval, and backoff. */
export interface WakeupLimits {
  readonly maxRecords: number
  readonly maxAttempts: number
  readonly pollIntervalMs: number
  readonly retryDelayMs: number
}

/** API-owned admission and operation lookup; callbacks must not hold the wake queue's serialization lock. */
export interface WakeupAdapter {
  /** Decode resolved durable run JSON without filesystem access. @param value - stored run JSON. @returns validated run inputs. */
  resolveRun(this: void, value: unknown): ApiRunRequest
  /** Find current operation metadata. @param id - operation identity. @returns retained operation, or null. */
  getOperation(this: void, id: OperationId): Promise<ApiOperation | null>
  /**
   * Look up an idempotency key without submitting.
   * @param key - stable delivery key.
   * @returns original operation, or null after an authoritative lookup.
   */
  lookup(this: void, key: string): Promise<ApiOperation | null>
  /**
   * Admit the fixed run or return its original operation.
   * @param run - exact supervisor input.
   * @param key - stable delivery key.
   * @returns accepted or previously accepted operation.
   */
  submit(this: void, run: ApiRunRequest, key: string): Promise<ApiOperation>
  /** Cancel and await common operation teardown. @param id - exact accepted operation. @returns settled operation metadata. */
  cancel(this: void, id: OperationId): Promise<ApiOperation>
  /** Report background queue/storage failures without hiding them. @param error - failure that remains unresolved. */
  reportError(this: void, error: unknown): void
  /** Read the current time. @returns epoch milliseconds, or the real clock when omitted. */
  now?(this: void): number
}

/** Preserved invalid queue evidence reported during initialization. */
export interface WakeupIssue {
  readonly file: string
  readonly message: string
  readonly quarantinePath: string | null
}

/** A request refusal whose stable code is safe for the API to return. */
export class WakeupError extends Error {
  override readonly name = 'WakeupError'
  /** @param status - HTTP classification. @param code - stable category. @param message - affected delivery and correction. */
  constructor(readonly status: 400 | 404 | 409 | 429 | 503, readonly code: string, message: string) { super(message) }
}

const requestSchema = z.strictObject({
  id: z.uuid().transform(value => value.toLowerCase() as WakeupId), run: z.unknown(),
  trigger: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('at'), atISO: z.iso.datetime() }),
    z.strictObject({ kind: z.literal('operation'), operationId: z.uuid().transform(value => value as OperationId),
      when: z.enum(['settled', 'attention']) }),
  ]), expiresAtISO: z.iso.datetime(),
})
const recordSchema = requestSchema.extend({ version: z.literal(1),
  status: z.enum(['pending', 'dispatching', 'submitted', 'completed', 'interrupted', 'failed', 'cancelled', 'expired']),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), attempts: z.number().int().nonnegative(),
  nextAttemptAt: z.iso.datetime(), operationId: z.uuid().transform(value => value as OperationId).nullable(),
  error: z.strictObject({ code: z.string(), message: z.string() }).nullable(), cancellationRequested: z.boolean(),
})

/**
 * Decode a wake request and require its explicit native session generation.
 * @param value - untrusted HTTP or durable request JSON.
 * @param resolveRun - API's resolved run parser; no filesystem or admission effects.
 * @returns normalized fixed run and one-shot condition.
 */
export function resolveWakeupRequest(value: unknown, resolveRun: (value: unknown) => ApiRunRequest): WakeupRequest {
  const parsed = requestSchema.safeParse(value)
  if (!parsed.success) throw new WakeupError(400, 'wakeup-invalid', 'A wake-up requires a UUID, fixed run, one valid trigger, and expiry.')
  const run = resolveRun(parsed.data.run)
  if (run.session === undefined) throw new WakeupError(400, 'wakeup-session', 'A wake-up requires an exact session identity and generation.')
  if (parsed.data.trigger.kind === 'at' && Date.parse(parsed.data.trigger.atISO) >= Date.parse(parsed.data.expiresAtISO)) {
    throw new WakeupError(400, 'wakeup-expiry', 'The wake-up expiry must be later than its scheduled time.')
  }
  return { ...parsed.data, run: { ...run, session: run.session } }
}

/** Whether an accepted operation has settled its delivery, regardless of task success. */
function operationStatus(operation: ApiOperation): WakeupRecord['status'] {
  if (isActiveOperation(operation)) return 'submitted'
  switch (operation.status) {
    case 'failed': return 'failed'
    case 'cancelled': return 'cancelled'
    case 'interrupted': return 'interrupted'
    default: return 'completed'
  }
}

/** Serialize queue metadata while native submission and cancellation remain outside that lock. */
export class WakeupService {
  private readonly directory: string
  private readonly records = new Map<WakeupId, WakeupRecord>()
  private readonly blockedIds = new Set<string>()
  private readonly issues: WakeupIssue[] = []
  private readonly inFlight = new Map<WakeupId, Promise<void>>()
  private readonly cancellations = new Map<WakeupId, Promise<WakeupRecord>>()
  private tail: Promise<void> = Promise.resolve()
  private ticking: Promise<void> | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private initialized = false
  private started = false
  private disposed = false

  /**
   * @param stateRoot - API-owned durable state directory.
   * @param limits - validated deployment budgets.
   * @param adapter - shared run admission and lookups.
   */
  constructor(stateRoot: string, private readonly limits: WakeupLimits, private readonly adapter: WakeupAdapter) {
    this.directory = path.join(stateRoot, 'wakeups')
  }

  /**
   * Load retained deliveries and preserve malformed entries separately without blocking valid entries.
   * Dispatches interrupted before their response retry the same admission key; cancellation uses lookup only.
   * @returns invalid-entry diagnostics, including the evidence's quarantine path when it could be moved.
   */
  async initialize(): Promise<readonly WakeupIssue[]> {
    return await this.serialize(async () => {
      if (this.initialized) return [...this.issues]
      await mkdir(this.directory, { recursive: true })
      const recovered: WakeupRecord[] = []
      const entries = await readdir(this.directory, { withFileTypes: true })
      for (const entry of entries) {
        const blocked = /^([0-9a-f-]{36})\.blocked$/u.exec(entry.name)
        if (blocked === null) continue
        this.blockedIds.add(blocked[1] as string)
        this.issues.push({ file: path.join(this.directory, entry.name),
          message: 'This wake identity has quarantined evidence and remains reserved for inspection.', quarantinePath: null })
      }
      for (const entry of entries) {
        if (/^[0-9a-f-]{36}\.blocked$/u.test(entry.name) || this.blockedIds.has(entry.name.replace(/\.json$/u, ''))) continue
        if (/^\.[0-9a-f-]+\.tmp$/u.test(entry.name) && entry.isFile()) continue
        const file = path.join(this.directory, entry.name)
        try {
          if (!entry.isFile() || !/^[0-9a-f-]{36}\.json$/u.test(entry.name)) throw new Error('Unexpected wake queue entry.')
          const decoded = recordSchema.parse(JSON.parse(await readFile(file, 'utf8')))
          const { id, run, trigger, expiresAtISO } = decoded
          const request = resolveWakeupRequest({ id, run, trigger, expiresAtISO }, value => this.adapter.resolveRun(value))
          if (`${request.id}.json` !== entry.name) throw new Error('Wake record identity does not match its filename.')
          const record: WakeupRecord = { ...decoded, ...request }
          if ((record.status === 'submitted' || record.status === 'completed') && record.operationId === null) {
            throw new Error('Submitted wake record has no operation identity.')
          }
          if (record.status === 'dispatching' && record.attempts === 0) throw new Error('Dispatching wake record has no admission attempt.')
          if (record.status === 'dispatching') {
            record.status = 'pending'; record.nextAttemptAt = this.nowISO(); record.updatedAt = this.nowISO()
            recovered.push(record)
          }
          this.records.set(record.id, record)
        } catch (error) {
          const identity = /^([0-9a-f-]{36})\.json$/u.exec(entry.name)?.[1]
          if (identity !== undefined) this.blockedIds.add(identity)
          const quarantinePath = path.join(this.directory, '..', 'wakeup-quarantine', `${randomUUID()}-${entry.name}`)
          let moved: string | null = null
          try {
            if (identity !== undefined) {
              const marker = await open(path.join(this.directory, `${identity}.blocked`), 'wx', 0o600)
              try { await marker.writeFile(JSON.stringify({ quarantinePath })); await marker.sync() } finally { await marker.close() }
            }
            await mkdir(path.dirname(quarantinePath), { recursive: true })
            await rename(file, quarantinePath)
            moved = quarantinePath
          } catch (quarantineError) { this.adapter.reportError(quarantineError) }
          this.issues.push({ file, message: error instanceof Error ? error.message : String(error), quarantinePath: moved })
        }
      }
      for (const record of recovered) await this.save(record)
      this.initialized = true
      return [...this.issues]
    })
  }

  /**
   * Retain one supervisor-validated single-step plan; a repeated identical ID returns its record.
   * @param input - validated request, with workspace, source, plan and session checked by the API owner.
   * @returns durable delivery; changed content with an existing ID is refused.
   */
  async register(input: WakeupRequest): Promise<WakeupRecord> {
    return await this.serialize(async () => {
      this.requireReady()
      if (this.blockedIds.has(input.id)) throw new WakeupError(409, 'wakeup-corrupt', 'This wake identity has invalid retained evidence; choose a new identity after inspection.')
      const previous = this.records.get(input.id)
      if (previous !== undefined) {
        const { id, run, trigger, expiresAtISO } = previous
        if (!isDeepStrictEqual({ id, run, trigger, expiresAtISO }, input)) throw new WakeupError(409, 'wakeup-conflict', 'This wake identity already has different instructions.')
        return structuredClone(previous)
      }
      if (this.records.size + this.blockedIds.size >= this.limits.maxRecords) throw new WakeupError(429, 'wakeup-limit', 'The retained wake queue has reached its configured record limit.')
      const now = this.nowISO()
      if (Date.parse(input.expiresAtISO) <= this.now()) throw new WakeupError(400, 'wakeup-expired', 'Choose a future wake-up expiry.')
      const record: WakeupRecord = { ...structuredClone(input), version: 1, status: 'pending', createdAt: now, updatedAt: now,
        attempts: 0, nextAttemptAt: now, operationId: null, error: null, cancellationRequested: false }
      await this.save(record); this.records.set(record.id, record)
      return structuredClone(record)
    })
  }

  /** @param workspace - canonical workspace to inspect. @returns retained deliveries ordered by creation time and ID, without mutation. */
  async list(workspace: string): Promise<readonly WakeupRecord[]> {
    return await this.serialize(() => {
      this.requireInitialized()
      return structuredClone([...this.records.values()].filter(record => record.run.workspace === workspace)
        .sort((left, right) => left.createdAt === right.createdAt
          ? left.id.localeCompare(right.id) : left.createdAt.localeCompare(right.createdAt)))
    })
  }

  /** @param id - delivery identity. @returns a detached retained record, or null. */
  async get(id: WakeupId): Promise<WakeupRecord | null> {
    return await this.serialize(() => { this.requireInitialized(); return structuredClone(this.records.get(id) ?? null) })
  }

  /**
   * Persist cancellation before waiting for an uncertain submission, then cancel any accepted operation.
   * @param id - exact delivery identity.
   * @returns retained cancellation outcome; unconfirmed admission or cleanup remains visible for reconciliation.
   */
  cancel(id: WakeupId): Promise<WakeupRecord> {
    this.requireReady()
    const previous = this.cancellations.get(id)
    if (previous !== undefined) return previous
    const work = this.cancelRequested(id)
    this.cancellations.set(id, work)
    const clear = () => { if (this.cancellations.get(id) === work) this.cancellations.delete(id) }
    void work.then(clear, clear)
    return work
  }

  private async cancelRequested(id: WakeupId): Promise<WakeupRecord> {
    const changed = await this.serialize(async () => {
      this.requireReady()
      const record = structuredClone(this.required(id))
      if (record.status === 'completed' || record.status === 'failed' || record.status === 'cancelled' || record.status === 'expired') return false
      record.cancellationRequested = true; record.updatedAt = this.nowISO()
      if (record.status === 'pending' && record.attempts === 0) record.status = 'cancelled'
      await this.save(record); this.records.set(id, record)
      return true
    })
    if (changed) {
      await this.inFlight.get(id)
      await this.reconcileCancellation(id)
    }
    return (await this.get(id)) as WakeupRecord
  }

  /** Start one owned polling timer; repeated calls do not create another dispatcher. */
  start(): void {
    this.requireReady()
    if (this.started) return
    this.started = true; this.schedule()
  }

  /** Run one serialized observation/dispatch pass; overlapping calls share the same pass. */
  tick(): Promise<void> {
    if (this.ticking !== undefined) return this.ticking
    this.requireReady()
    const pass = this.poll()
    this.ticking = pass
    const clear = () => { if (this.ticking === pass) this.ticking = undefined }
    void pass.then(clear, clear)
    return pass
  }

  /** Stop future polls and await admission bookkeeping; accepted workers remain owned by common API shutdown. */
  async dispose(): Promise<void> {
    this.disposed = true; this.started = false
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    const joined = await Promise.allSettled([
      ...this.ticking === undefined ? [] : [this.ticking], ...this.inFlight.values(), ...this.cancellations.values(),
    ])
    await this.tail
    const failures: unknown[] = []
    for (const result of joined) if (result.status === 'rejected') failures.push(result.reason)
    if (failures.length > 0) throw new AggregateError(failures, 'Wake queue shutdown failed after all admission and cancellation work settled.')
  }

  private async poll(): Promise<void> {
    for (const id of [...this.records.keys()]) {
      if (this.disposed) break
      const record = await this.get(id)
      if (record === null) continue
      if (record.cancellationRequested && (record.status === 'pending' || record.status === 'dispatching' ||
        record.status === 'submitted' || (record.status === 'interrupted' && record.error?.code === 'wakeup-cancellation-unconfirmed'))) {
        await this.reconcileCancellation(id); continue
      }
      if (record.status === 'submitted') {
        const operation = await this.adapter.getOperation(record.operationId as OperationId)
        await this.update(id, (current) => {
          current.status = operation === null ? 'interrupted' : operationStatus(operation)
          current.error = operation === null ? { code: 'wakeup-operation-missing', message: 'The submitted operation is no longer retained; delivery is not replayed.' } : operation.error
        })
        continue
      }
      if (record.status !== 'pending' || Date.parse(record.nextAttemptAt) > this.now()) continue
      const work = this.dispatch(id)
      this.inFlight.set(id, work)
      try { await work } finally { this.inFlight.delete(id) }
    }
  }

  private async dispatch(id: WakeupId): Promise<void> {
    const record = await this.get(id)
    if (record === null || record.status !== 'pending' || record.cancellationRequested) return
    const key = `wakeup:${id}`
    // Lookup precedes expiry and retry limits: a lost admission response may already own a live run.
    if (record.attempts > 0) {
      const previous = await this.adapter.lookup(key)
      if (previous !== null) { await this.accepted(id, previous); return }
    }
    if (Date.parse(record.expiresAtISO) <= this.now()) { await this.update(id, (current) => { current.status = 'expired' }); return }
    if (record.attempts >= this.limits.maxAttempts) {
      await this.update(id, (current) => { current.status = 'failed'; current.error = { code: 'wakeup-attempts', message: 'The wake-up admission retry budget was exhausted.' } })
      return
    }
    if (record.trigger.kind === 'at') {
      if (Date.parse(record.trigger.atISO) > this.now()) return
    } else {
      const source = await this.adapter.getOperation(record.trigger.operationId)
      if (source === null || source.workspace !== record.run.workspace) {
        await this.update(id, (current) => { current.status = 'failed'; current.error = { code: 'wakeup-source', message: 'The trigger operation is absent from this workspace.' } })
        return
      }
      const ready = record.trigger.when === 'settled' ? !isActiveOperation(source)
        : listApiRuns(new Map([[source.operationId, source]]), new URLSearchParams(), 1).runs.some(run => run.attention.length > 0)
      if (!ready) return
    }
    const claimed = await this.serialize(async () => {
      const current = structuredClone(this.required(id))
      if (this.disposed || current.cancellationRequested || current.status !== 'pending') return false
      current.status = 'dispatching'; current.attempts++; current.updatedAt = this.nowISO()
      await this.save(current)
      this.records.set(id, current)
      return true
    })
    if (!claimed) return
    try { await this.accepted(id, await this.adapter.submit(record.run, key)) } catch (error) {
      if ((await this.get(id))?.cancellationRequested === true) { await this.reconcileCancellation(id); return }
      if (error instanceof ApiError && error.status === 503 && error.code === 'shutting-down') {
        await this.update(id, (current) => {
          current.status = 'pending'; current.attempts--
          current.nextAttemptAt = new Date(this.now() + this.limits.retryDelayMs).toISOString()
          current.error = { code: error.code, message: error.message }
        })
        return
      }
      if (error instanceof ApiError && !((error.status === 409 && error.code === 'session-busy') ||
        (error.status === 429 && error.code === 'active-run-limit') || (error.status === 503 && error.code === 'recovery-admission-blocked'))) {
        await this.update(id, (current) => { current.status = 'failed'; current.error = { code: error.code, message: error.message } })
      } else {
        await this.update(id, (current) => {
          current.status = 'pending'
          current.nextAttemptAt = new Date(this.now() + this.limits.retryDelayMs).toISOString()
          current.error = { code: error instanceof ApiError ? error.code : 'wakeup-admission-unknown',
            message: error instanceof Error ? error.message : String(error) }
        })
      }
    }
  }

  private async accepted(id: WakeupId, operation: ApiOperation): Promise<void> {
    await this.update(id, (record) => {
      record.operationId = operation.operationId; record.status = operationStatus(operation); record.error = operation.error
    })
    if ((await this.get(id))?.cancellationRequested === true) await this.reconcileCancellation(id)
  }

  private async reconcileCancellation(id: WakeupId): Promise<void> {
    const record = await this.get(id)
    if (record === null || !record.cancellationRequested || record.status === 'cancelled') return
    try {
      const operation = record.operationId === null ? await this.adapter.lookup(`wakeup:${id}`) : await this.adapter.getOperation(record.operationId)
      if (operation === null) {
        if (record.operationId !== null) throw new WakeupError(503, 'wakeup-operation-missing', 'The accepted operation is no longer retained; its cancellation cannot be confirmed.')
        await this.update(id, (current) => { current.status = 'cancelled'; current.error = null })
        return
      }
      const settled = isActiveOperation(operation) ? await this.adapter.cancel(operation.operationId) : operation
      await this.update(id, (current) => {
        current.operationId = settled.operationId; current.status = operationStatus(settled); current.error = settled.error
      })
    } catch (error) {
      await this.update(id, (current) => { current.status = 'interrupted'; current.error = {
        code: 'wakeup-cancellation-unconfirmed', message: error instanceof Error ? error.message : String(error),
      } })
    }
  }

  private schedule(): void {
    if (!this.started || this.disposed) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.tick().catch((error: unknown) => { this.adapter.reportError(error) }).finally(() => { this.schedule() })
    }, this.limits.pollIntervalMs)
    this.timer.unref()
  }

  private now(): number { return this.adapter.now?.() ?? Date.now() }
  private nowISO(): string { return new Date(this.now()).toISOString() }
  private requireReady(): void {
    this.requireInitialized()
    if (this.disposed) throw new WakeupError(503, 'wakeup-unavailable', 'The wake queue is not accepting work.')
  }
  private requireInitialized(): void {
    if (!this.initialized) throw new WakeupError(503, 'wakeup-unavailable', 'The wake queue is not initialized.')
  }
  private required(id: WakeupId): WakeupRecord {
    const record = this.records.get(id)
    if (record === undefined) throw new WakeupError(404, 'wakeup-not-found', 'No retained wake-up has this identity.')
    return record
  }
  private async update(id: WakeupId, change: (record: WakeupRecord) => void): Promise<void> {
    await this.serialize(async () => {
      const record = structuredClone(this.required(id)); change(record); record.updatedAt = this.nowISO()
      await this.save(record); this.records.set(id, record)
    })
  }
  private async serialize<T>(action: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(action)
    this.tail = result.then(() => {}, () => {})
    return await result
  }
  private async save(record: WakeupRecord): Promise<void> {
    const temporary = path.join(this.directory, `.${randomUUID()}.tmp`)
    const handle = await open(temporary, 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify(record)); await handle.sync() } finally { await handle.close() }
    try { await rename(temporary, path.join(this.directory, `${record.id}.json`)) } catch (error) {
      try { await unlink(temporary) } catch (cleanupError) { this.adapter.reportError(cleanupError) }
      throw error
    }
  }
}
