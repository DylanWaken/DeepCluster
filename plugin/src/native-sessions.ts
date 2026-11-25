/** Durable worker identities and replacement generations; the API owns serialization and worker admission. */
import { randomUUID } from 'node:crypto'
import { mkdir, open, readdir, readFile, rename, link, unlink } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ApiOperation, OperationId } from './api-types.ts'
import type { WorkerSession } from './types.ts'
import type { OwnershipGeneration } from './types.ts'

/** Stable supervisor-assigned worker identity, distinct from each native conversation. */
export type ClusterSessionId = Branded<'DeepClusterSessionId'>
const idSchema = z.uuid().transform(value => value.toLowerCase() as ClusterSessionId)
const generation = z.number().int().positive().max(Number.MAX_SAFE_INTEGER - 1)
const role = z.enum(['developer', 'reviewer', 'tester', 'perf'])

/** Exact generation selected by the supervisor for one single-step run. */
export const clusterSessionReferenceSchema = z.object({ id: idSchema, generation }).strict()
/** Exact generation selected for one native turn. */
export type ClusterSessionReference = z.infer<typeof clusterSessionReferenceSchema>

/** Full native identity retained with the accepted operation before process launch. */
export const clusterSessionBindingSchema = clusterSessionReferenceSchema.extend({
  nativeSession: z.object({ mode: z.enum(['create', 'resume']), id: z.string().min(1).transform(value => value as SessionId) }).strict(),
  handoff: z.string(),
  workerGeneration: z.uuid().transform(value => value as OwnershipGeneration).optional(),
}).strict()
/** Admitted native identity and explicit replacement context. */
export type ClusterSessionBinding = z.infer<typeof clusterSessionBindingSchema>

/** A generation's latest execution state; superseded generations remain readable on disk. */
export const clusterSessionSchema = z.object({
  version: z.literal(1), id: idSchema, generation, workspace: z.string().refine(value => path.isAbsolute(value)),
  title: z.string().min(1), role, handoff: z.string(), nativeSessionId: z.string().min(1).transform(value => value as SessionId),
  previousSessionId: z.string().nullable(), status: z.enum(['new', 'ready', 'busy', 'replacing', 'interrupted']),
  activeOperationId: z.uuid().transform(value => value as OperationId).nullable(),
  lastOperationId: z.uuid().transform(value => value as OperationId).nullable(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
}).strict()
/** Durable supervisor-assigned worker generation. */
export type ClusterSession = z.infer<typeof clusterSessionSchema>

/** Fresh worker assignment; creation does not start a model or allocate tasks. */
export const clusterSessionCreateSchema = z.object({ id: idSchema, workspace: z.string().refine(value => path.isAbsolute(value)),
  title: z.string().trim().min(1).max(200), role, handoff: z.string().default('') }).strict()
/** Validated fresh assignment. */
export type ClusterSessionCreate = z.infer<typeof clusterSessionCreateSchema>

/** Generation mutation or storage refusal; independent runs may continue. */
export class ClusterSessionError extends Error {
  override readonly name = 'ClusterSessionError'
  /**
   * @param status - HTTP failure classification.
   * @param code - stable refusal identity.
   * @param message - affected identity and recovery action.
   * @param options - original storage failure, when present.
   */
  constructor(readonly status: number, readonly code: string, message: string, options?: ErrorOptions) { super(message, options) }
}

/** API-state-owned native identities; every public mutation requires the API store's serialization. */
export class ClusterSessionStore {
  /** Latest validated generation of each worker, read under API serialization. */
  readonly sessions = new Map<ClusterSessionId, ClusterSession>()
  /** Invalid records remain on disk and prevent only their own identity from being reused. */
  readonly issues: { id: string; message: string }[] = []
  private readonly blocked = new Set<string>()
  private readonly root: string
  /**
   * @param stateDirectory - exclusive API state root.
   * @param limits - assignment retention and explicit handoff limits.
   */
  constructor(stateDirectory: string, private readonly limits: { maxRecords: number; maxHandoffBytes: number }) {
    this.root = path.join(stateDirectory, 'native-sessions')
  }

  /** Load valid generations and fence interrupted turns without restarting any model. */
  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true })
    const latest = new Map<string, { file: string; generation: number }>()
    for (const file of await readdir(this.root)) {
      if (file.endsWith('.tmp')) continue
      const match = /^([0-9a-f-]{36})\.([1-9]\d*)\.json$/u.exec(file)
      if (match === null) { this.issues.push({ id: file, message: 'Unrecognized native session record retained for inspection.' }); continue }
      const id = match[1] as string, value = Number(match[2])
      if ((latest.get(id)?.generation ?? 0) < value) latest.set(id, { file, generation: value })
    }
    for (const [id, entry] of latest) {
      try {
        const record = clusterSessionSchema.parse(JSON.parse(await readFile(path.join(this.root, entry.file), 'utf8')))
        if (record.id !== id || record.generation !== entry.generation) throw new Error('Native identity disagrees with its filename')
        if (record.status === 'busy' || record.status === 'replacing') {
          record.status = 'interrupted'; record.lastOperationId = record.activeOperationId ?? record.lastOperationId; record.activeOperationId = null
          record.updatedAt = new Date().toISOString(); await this.save(record)
        } else this.sessions.set(record.id, record)
      } catch (error) {
        this.blocked.add(id)
        this.issues.push({ id, message: error instanceof Error ? error.message : 'Native session state is unreadable.' })
      }
    }
  }

  /**
   * Resolve a retained identity without opening its private conversation.
   * @param id - stable worker identity.
   * @returns the latest generation or a typed identity-specific refusal.
   */
  get(id: ClusterSessionId): ClusterSession {
    if (this.blocked.has(id)) throw new ClusterSessionError(503, 'session-storage', 'This native worker record is damaged; preserve it and create a new worker identity.')
    const record = this.sessions.get(id)
    if (record === undefined) throw new ClusterSessionError(404, 'session-not-found', 'The native worker identity does not exist.')
    return record
  }

  /**
   * Allocate a fresh native identity without starting a worker.
   * @param input - canonical workspace and supervisor-assigned role.
   * @returns the first unstarted generation.
   */
  async create(input: ClusterSessionCreate): Promise<ClusterSession> {
    this.checkHandoff(input.handoff)
    if (this.sessions.has(input.id) || this.blocked.has(input.id)) throw new ClusterSessionError(409, 'session-conflict', 'This worker identity already exists; read it before retrying creation.')
    if (this.sessions.size + this.blocked.size >= this.limits.maxRecords) throw new ClusterSessionError(503, 'session-limit', 'The configured native worker retention limit was reached.')
    const now = new Date().toISOString()
    const record: ClusterSession = { ...input, version: 1, generation: 1, nativeSessionId: this.allocate(), previousSessionId: null,
      status: 'new', activeOperationId: null, lastOperationId: null, createdAt: now, updatedAt: now }
    await this.save(record, true)
    return record
  }

  /**
   * Validate an exact assignment before admission or replacement.
   * @param reference - supervisor-selected generation.
   * @returns its current record, including any active operation that must be joined.
   */
  selected(reference: ClusterSessionReference): ClusterSession {
    const record = this.get(reference.id)
    if (record.generation !== reference.generation) throw new ClusterSessionError(409, 'session-generation', 'The native worker was replaced; select its current generation explicitly.')
    return record
  }

  /**
   * Persist exclusive turn ownership before the operation or native process is published.
   * @param reference - exact generation.
   * @param operationId - preallocated idempotent operation identity.
   * @returns native create/resume selection and the supervisor's handoff.
   */
  async reserve(reference: ClusterSessionReference, operationId: OperationId): Promise<ClusterSessionBinding> {
    const record = this.selected(reference)
    if (record.status === 'replacing') throw new ClusterSessionError(409, 'session-replacing', 'This generation is being replaced; select the successor explicitly after replacement settles.')
    if (record.status === 'busy') throw new ClusterSessionError(409, 'session-busy', 'The native worker already owns a turn; queue a wakeup or wait for it to settle.')
    if (record.status === 'interrupted') throw new ClusterSessionError(409, 'session-interrupted', 'The previous native turn has an uncertain outcome; replace this generation with an explicit handoff.')
    const nativeSession: WorkerSession = { id: record.nativeSessionId, mode: record.status === 'new' ? 'create' : 'resume' }
    await this.save({ ...record, status: 'busy', activeOperationId: operationId, updatedAt: new Date().toISOString() })
    return { ...reference, nativeSession, handoff: record.handoff }
  }

  /**
   * Release only the generation and operation that owned the settled turn.
   * @param binding - retained admission selection.
   * @param operation - terminal operation after joined worker teardown.
   */
  async settle(binding: ClusterSessionBinding, operation: ApiOperation): Promise<void> {
    const record = this.get(binding.id)
    if (record.generation !== binding.generation || record.activeOperationId !== operation.operationId) return
    const ready = (operation.status === 'completed' || operation.status === 'needs-ack') && operation.result?.cleanupConfirmed === true
    await this.save({ ...record, status: record.status === 'replacing' ? 'replacing' : ready ? 'ready' : 'interrupted', activeOperationId: null,
      lastOperationId: operation.operationId, updatedAt: new Date().toISOString() })
  }

  /**
   * Fence new turns before the caller cancels and joins the previous generation.
   * @param reference - exact generation to replace.
   * @param handoff - replacement context checked before changing ownership.
   * @returns the operation that must be joined, or null when this generation is idle.
   */
  async beginReplacement(reference: ClusterSessionReference, handoff: string): Promise<OperationId | null> {
    this.checkHandoff(handoff)
    const record = this.selected(reference)
    await this.save({ ...record, status: 'replacing', updatedAt: new Date().toISOString() })
    return record.activeOperationId
  }

  /**
   * Replace a joined generation with a fresh conversation; private session history remains untouched.
   * @param reference - generation whose active operation has already joined.
   * @param handoff - explicit supervisor context for the replacement.
   * @returns the next unstarted generation; old completion cannot mutate it.
   */
  async replace(reference: ClusterSessionReference, handoff: string): Promise<ClusterSession> {
    this.checkHandoff(handoff)
    const record = this.selected(reference)
    if (record.activeOperationId !== null) throw new ClusterSessionError(409, 'session-busy', 'Join the current native turn before replacing this worker.')
    if (record.generation >= Number.MAX_SAFE_INTEGER - 1) throw new ClusterSessionError(409, 'session-generation', 'The generation counter is exhausted; create a new worker identity.')
    const next: ClusterSession = { ...record, generation: record.generation + 1, nativeSessionId: this.allocate(),
      previousSessionId: record.nativeSessionId, handoff, status: 'new', activeOperationId: null, lastOperationId: null, updatedAt: new Date().toISOString() }
    await this.save(next, true)
    return next
  }

  private allocate(): SessionId { return `session-${randomUUID()}` as SessionId }
  private checkHandoff(value: string): void {
    if (Buffer.byteLength(value, 'utf8') > this.limits.maxHandoffBytes) throw new ClusterSessionError(413, 'session-handoff-limit', 'The native handoff exceeds its configured byte limit.')
  }
  private async save(record: ClusterSession, fresh = false): Promise<void> {
    const file = path.join(this.root, `${record.id}.${String(record.generation)}.json`), temporary = `${file}.${randomUUID()}.tmp`
    try {
      const handle = await open(temporary, 'wx', 0o600)
      try { await handle.writeFile(`${JSON.stringify(record)}\n`); await handle.sync() } finally { await handle.close() }
      if (fresh) { await link(temporary, file); await unlink(temporary) } else await rename(temporary, file)
      this.sessions.set(record.id, record)
    } catch (error) {
      this.blocked.add(record.id)
      throw new ClusterSessionError(503, 'session-storage', 'Native worker ownership could not be saved; no new turn may start for this identity.', { cause: error })
    }
  }
}
