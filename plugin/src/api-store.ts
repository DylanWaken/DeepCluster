/** Durable idempotency records; no retained operation is automatically executed after a restart. */
import { createHash, randomUUID } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import { link, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { API_RECOVERY_FENCE_FILE, ApiError, apiOperationSchema, isActiveOperation, type ApiConfig, type ApiOperation, type ApiRunRequest, type OperationId } from './api-types.ts'
import type { KnowledgeSnapshot } from './knowledge-types.ts'
import type { ClusterSessionBinding } from './native-sessions.ts'
import type { PolicyDecision } from './policy-hooks.ts'
import { inspectProcessIdentity, sameProcessStart, type ProcessIdentity } from './process-identity.ts'
import { WorkerRecoveryStore } from './worker-recovery.ts'
import type { OwnershipGeneration } from './types.ts'
import { readRecoveryIssues, recoveryIssue, replaceRecoveryIssues, type RecoveryIssue } from './recovery-issues.ts'

/**
 * Hash opaque idempotency inputs without retaining bearer credentials or raw client keys.
 * @param value - key or normalized request JSON.
 * @returns its lowercase SHA-256 digest.
 */
export function apiHash(value: string): string { return createHash('sha256').update(value).digest('hex') }

/** Serialize durable mutations, retaining the last known record on write failure. */
export class ApiOperationStore {
  /** Validated retained submissions; writes and reads must pass through serialize after initialization. */
  readonly operations = new Map<OperationId, ApiOperation>()
  /** Unreadable retained submissions reserve their known idempotency hashes. */
  readonly blockedKeyHashes = new Set<string>()
  /** Unresolved recovery failures remain visible while unrelated requests can run. */
  readonly recoveryIssues: RecoveryIssue[] = []
  private readonly keys = new Map<string, ApiOperation>()
  private pending: Promise<void> = Promise.resolve()
  private failure: unknown
  private readonly directory: string
  private readonly owner = randomUUID()
  private ownsLock = false
  private lockIdentity: Pick<BigIntStats, 'dev' | 'ino'> | undefined
  private ownerStartTime: string | undefined
  /** Persisted native ranges for this API generation; absent when recoverable execution is disabled. */
  workerRecovery: WorkerRecoveryStore | undefined
  /**
   * @param config - durable state location and admission limits.
   * @param inspectOwner - host process identity probe; tests inject a stable or absent owner.
   * @param recoverWorkers - require durable native receipts for every admitted worker; defaults to false.
   */
  constructor(
    private readonly config: ApiConfig,
    private readonly inspectOwner: (pid: number) => Promise<ProcessIdentity | null> = inspectProcessIdentity,
    private readonly recoverWorkers = false,
  ) { this.directory = path.join(config.stateDirectory, 'operations') }

  /**
   * Load validated records and visibly settle interrupted owners without restarting their work.
   * @returns after metadata is ready for authenticated requests.
   */
  async initialize(): Promise<void> {
    const lockFile = path.join(this.config.stateDirectory, 'api-owner.lock')
    const fenceFile = path.join(this.config.stateDirectory, API_RECOVERY_FENCE_FILE)
    if (await this.recoveryFenceExists(fenceFile)) {
      throw new Error(`DeepCluster API state is under an explicit recovery fence at ${fenceFile}. Wait for that recovery to finish or inspect the preserved state; this owner did not acquire the lock or create state.`)
    }
    await mkdir(this.directory, { recursive: true })
    try { this.ownerStartTime = (await this.inspectOwner(process.pid))?.startTime } catch (error) {
      if (this.recoverWorkers) throw new Error('DeepCluster cannot initialize recoverable workers without the API process start identity.', { cause: error })
      // Without a host identity the new lock stays conservative: a later owner can
      // fall back to PID-only interruption checks, exactly as older records do.
      this.ownerStartTime = undefined
    }
    if (this.recoverWorkers && this.ownerStartTime === undefined) {
      throw new Error('DeepCluster cannot initialize recoverable workers because the API process start identity is unavailable.')
    }
    try {
      await Promise.all(['leases', 'claims'].map(name => mkdir(path.join(this.config.leaseRoot, name), { recursive: true })))
      if (this.recoverWorkers && this.ownerStartTime !== undefined) {
        this.workerRecovery = await WorkerRecoveryStore.create(this.config.stateDirectory, this.owner as OwnershipGeneration,
          { pid: process.pid, startTime: this.ownerStartTime, leaseRoot: this.config.leaseRoot })
      }
      const temporary = path.join(this.config.stateDirectory, `.api-owner-${this.owner}.tmp`)
      const handle = await open(temporary, 'wx', 0o600)
      try {
        try {
          await handle.writeFile(JSON.stringify({ owner: this.owner, pid: process.pid,
            recovery: { version: 1, leaseRoot: this.config.leaseRoot },
            ...this.workerRecovery === undefined ? {} : { workers: { version: 1, generation: this.owner } },
            ...this.ownerStartTime === undefined ? {} : { startTime: this.ownerStartTime } }))
          await handle.sync()
          this.lockIdentity = await handle.stat({ bigint: true })
        } finally { await handle.close() }
        try { await link(temporary, lockFile) } catch (error) {
          throw new Error(`DeepCluster API state is already owned or cannot be locked. Inspect ${lockFile}; run \`service recover --dry-run\` to inspect its owner before recovery, and never delete the lock directly.`, { cause: error })
        }
        this.ownsLock = true
      } finally { await unlink(temporary) }
      if (await this.recoveryFenceExists(fenceFile)) {
        throw new Error('DeepCluster API state recovery began while this owner acquired the lock; the new owner released its lock without admitting work.')
      }
      const operationIssues: RecoveryIssue[] = []
      for (const file of await readdir(this.directory)) {
        if (!file.endsWith('.json')) continue
        let value: unknown
        let record: ApiOperation
        try {
          value = JSON.parse(await readFile(path.join(this.directory, file), 'utf8'))
          record = apiOperationSchema.parse(value)
          if (file !== `${record.keyHash}.json` || this.operations.has(record.operationId) || this.keys.has(record.keyHash)) {
            const previous = this.operations.get(record.operationId)
            if (previous !== undefined) this.blockedKeyHashes.add(previous.keyHash)
            throw new Error('Retained operation identities conflict; affected request keys remain reserved.')
          }
        } catch (error) {
          const filenameHash = file.slice(0, -5)
          if (/^[0-9a-f]{64}$/u.test(filenameHash)) this.blockedKeyHashes.add(filenameHash)
          if (typeof value === 'object' && value !== null && 'keyHash' in value
            && typeof value.keyHash === 'string' && /^[0-9a-f]{64}$/u.test(value.keyHash)) this.blockedKeyHashes.add(value.keyHash)
          operationIssues.push(recoveryIssue('operation-record', file, error))
          continue
        }
        this.operations.set(record.operationId, record); this.keys.set(record.keyHash, record)
        if (isActiveOperation(record)) {
          if (!await this.ownerStillAlive(record)) {
            record.status = 'interrupted'; record.updatedAt = new Date().toISOString()
            record.error = { code: 'interrupted', message: 'The API owner stopped before settlement. Inspect this workspace journal and retained leases; this operation was not restarted.' }
            await this.save(record)
            continue
          }
          throw new Error('DeepCluster API state belongs to a live process. Stop that API instance before reusing its state directory.')
        }
      }
      await replaceRecoveryIssues(this.config.stateDirectory, 'operation-record', operationIssues)
      this.recoveryIssues.push(...await readRecoveryIssues(this.config.stateDirectory))
    } catch (error) {
      try { await this.dispose() } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'API initialization and ownership release failed') }
      throw error
    }
  }

  /** Probe the exclusive recovery fence without changing or creating it. */
  private async recoveryFenceExists(fenceFile: string): Promise<boolean> {
    try { await stat(fenceFile); return true } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  /** Compare the recorded owner PID and process start; a reused PID is not the owner. */
  private async ownerStillAlive(record: ApiOperation): Promise<boolean> {
    if (record.ownerStartTime === undefined) {
      try { process.kill(record.ownerPid, 0) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        return false
      }
      return true
    }
    const live = await this.inspectOwner(record.ownerPid)
    return sameProcessStart({ pid: record.ownerPid, startTime: record.ownerStartTime }, live)
  }

  /** Release exclusive directory ownership after the API has joined every accepted operation. */
  async dispose(): Promise<void> {
    await this.pending
    if (!this.ownsLock) return
    const lockFile = path.join(this.config.stateDirectory, 'api-owner.lock')
    const current = await stat(lockFile, { bigint: true })
    if (this.lockIdentity === undefined || current.dev !== this.lockIdentity.dev || current.ino !== this.lockIdentity.ino) {
      throw new Error('DeepCluster API state ownership changed; the replacement lock was preserved.')
    }
    const raw: unknown = JSON.parse(await readFile(lockFile, 'utf8'))
    if (typeof raw !== 'object' || raw === null || !('owner' in raw) || raw.owner !== this.owner) {
      throw new Error('DeepCluster API state ownership changed; the replacement lock was preserved.')
    }
    await unlink(lockFile); this.ownsLock = false
  }

  /**
   * Serialize one metadata or acknowledgement mutation.
   * @param action - work admitted after previous mutations settle.
   * @returns the action's result; a durable-state failure stops later operations.
   */
  async serialize<T>(action: () => T | Promise<T>): Promise<T> {
    const work = this.pending.then(async () => {
      if (this.failure !== undefined) throw new ApiError(503, 'state-unavailable', 'Operation metadata could not be saved. Inspect the API state directory and workspace journals before retrying.')
      return await action()
    })
    this.pending = work.then(() => {}, () => {})
    return await work
  }

  /**
   * Persist a record before callers report its changed state.
   * @param record - current metadata snapshot.
   * @returns after the replacement file is committed; failures stop future admission.
   */
  async save(record: ApiOperation): Promise<void> {
    const text = JSON.stringify(record), file = path.join(this.directory, `${record.keyHash}.json`)
    try {
      const temporary = `${file}.${randomUUID()}.tmp`
      await writeFile(temporary, text, { mode: 0o600 })
      await rename(temporary, file)
    } catch (error) { this.failure = error; throw error }
  }

  /**
   * Look up a retained submission without creating work; callers hold serialization.
   * @param key - original idempotency key.
   * @returns the original operation, or null when absence is established.
   */
  lookup(key: string): ApiOperation | null {
    const hash = apiHash(key)
    if (this.blockedKeyHashes.has(hash)) throw new ApiError(503, 'operation-record-damaged', 'This submission has damaged retained evidence; preserve it and inspect its outcome before proceeding.')
    return this.keys.get(hash) ?? null
  }

  /**
   * Commit one accepted identity before scheduling, or return an identical earlier submission.
   * @param key - validated Idempotency-Key header.
   * @param request - normalized run inputs.
   * @param prepare - resolve context and reserve native ownership for a fresh admission under serialization.
   * @returns the retained record and whether this process owns its first execution.
   */
  async accept(key: string, request: ApiRunRequest,
    prepare?: (operationId: OperationId) => Promise<{
      knowledge?: readonly KnowledgeSnapshot[]
      session?: ClusterSessionBinding
      policy?: readonly PolicyDecision[]
    }>): Promise<{ record: ApiOperation; fresh: boolean }> {
    return await this.serialize(async () => {
      const keyHash = apiHash(key), requestHash = apiHash(JSON.stringify(request))
      const previous = this.lookup(key)
      if (previous !== null) {
        if (previous.requestHash !== requestHash) throw new ApiError(409, 'idempotency-conflict', 'This Idempotency-Key already names a different request.')
        return { record: previous, fresh: false }
      }
      if (this.recoveryIssues.some(issue => issue.blocksAdmission === true)) {
        throw new ApiError(503, 'recovery-admission-blocked', 'The control plane is available, but unresolved ownership has no trusted resource namespace. Inspect health recovery issues before admitting work.')
      }
      if (this.operations.size >= this.config.maxOperations) {
        throw new ApiError(503, 'operation-limit', 'The operation retention limit was reached. Increase maxOperations while retaining this state directory and its idempotency records.')
      }
      if ([...this.operations.values()].filter(isActiveOperation).length >= this.config.maxActiveRuns) {
        throw new ApiError(429, 'active-run-limit', 'The API has reached its active run limit; retry after an operation settles.')
      }
      const operationId = randomUUID() as OperationId
      const context = await prepare?.(operationId)
      const at = new Date().toISOString()
      const record: ApiOperation = { version: 1, operationId, keyHash, requestHash,
        workspace: request.workspace, ownerPid: process.pid,
        ...this.ownerStartTime === undefined ? {} : { ownerStartTime: this.ownerStartTime },
        status: 'accepted', runId: null, createdAt: at, updatedAt: at, progress: null, result: null, error: null,
        ...context?.knowledge === undefined || context.knowledge.length === 0 ? {} : { knowledge: [...context.knowledge] },
        ...context?.session === undefined ? {} : { session: context.session },
        ...context?.policy === undefined || context.policy.length === 0 ? {} : { policy: [...context.policy] } }
      try { await writeFile(path.join(this.directory, `${keyHash}.json`), JSON.stringify(record), { flag: 'wx', mode: 0o600 }) } catch (error) {
        this.failure = error
        throw error
      }
      this.operations.set(record.operationId, record); this.keys.set(keyHash, record)
      return { record, fresh: true }
    })
  }
}
