/** Immutable knowledge history under one API-owned state directory, partitioned by physical workspace. */
import { createHash, randomUUID } from 'node:crypto'
import { link, lstat, mkdir, open, readdir, realpath, unlink } from 'node:fs/promises'
import path from 'node:path'
import { comparisonKey } from './scope.ts'
import { assertKnowledgeLimits, KnowledgeStoreError, knowledgeRevisionSchema } from './knowledge-types.ts'
import type { KnowledgeLimits, KnowledgeRecordId, KnowledgeReference, KnowledgeRevision,
  KnowledgeSnapshot, KnowledgeTransition, KnowledgeWrite } from './knowledge-types.ts'

export { KnowledgeStoreError } from './knowledge-types.ts'

/**
 * The API owner serializes mutations and admission while holding its exclusive state lock.
 * Exclusive next-revision publication also rejects concurrent edits using the same base.
 * Independent API state directories intentionally keep separate knowledge collections.
 */
export class KnowledgeStore {
  /**
   * @param stateDirectory - state root exclusively owned by the serving API.
   * @param limits - deployment admission budgets.
   */
  constructor(private readonly stateDirectory: string, private readonly limits: KnowledgeLimits) {}

  /**
   * List the latest complete revision of every record in one workspace.
   * @param workspace - existing physical workspace or an alias to it.
   * @returns records ordered by stable ID; staging files are never published revisions.
   */
  async list(workspace: string): Promise<KnowledgeRevision[]> {
    return await storage(async () => await this.listStored(workspace))
  }

  private async listStored(workspace: string): Promise<KnowledgeRevision[]> {
    const root = await this.workspaceRoot(workspace)
    const records: KnowledgeRevision[] = []
    if (!await this.collectionExists(root)) return records
    for (const entry of await entries(root)) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(entry.name) || !entry.isDirectory()) {
        throw new KnowledgeStoreError(503, 'knowledge-state', 'The knowledge registry contains an unrecognized record entry; preserve it for inspection.')
      }
      const revisions = await this.history(root, entry.name as KnowledgeRecordId)
      const latest = revisions.at(-1)
      if (latest !== undefined) records.push(latest)
    }
    return records.sort((left, right) => left.id.localeCompare(right.id))
  }

  /**
   * Read an exact revision, or the latest published revision when omitted.
   * @param workspace - workspace whose collection owns the record.
   * @param id - validated stable record identity.
   * @param revision - immutable revision number; omission reads the head.
   * @returns the record, or null when the requested identity has no published revision.
   */
  async read(workspace: string, id: KnowledgeRecordId, revision?: number): Promise<KnowledgeRevision | null> {
    return await storage(async () => await this.readStored(workspace, id, revision))
  }

  private async readStored(workspace: string, id: KnowledgeRecordId, revision?: number): Promise<KnowledgeRevision | null> {
    const records = await this.history(await this.workspaceRoot(workspace), id)
    return (revision === undefined ? records.at(-1) : records.find(record => record.revision === revision)) ?? null
  }

  /**
   * Publish a full content replacement without overwriting any committed revision.
   * @param workspace - workspace collection.
   * @param input - validated content and expected current revision; zero creates the stable ID.
   * @returns the new immutable revision; a competing writer produces a conflict.
   */
  async write(workspace: string, input: KnowledgeWrite): Promise<KnowledgeRevision> {
    return await storage(async () => await this.writeStored(workspace, input))
  }

  private async writeStored(workspace: string, input: KnowledgeWrite): Promise<KnowledgeRevision> {
    const root = await this.workspaceRoot(workspace)
    const current = (await this.history(root, input.id)).at(-1)
    requireExpected(current, input.expectedRevision)
    if (current !== undefined && current.kind !== input.kind) throw new KnowledgeStoreError(409, 'knowledge-conflict', 'A knowledge record cannot change its kind.')
    if (current === undefined && (await this.list(workspace)).length >= this.limits.maxRecords) {
      throw new KnowledgeStoreError(413, 'knowledge-limit', 'This workspace has reached its configured knowledge record limit.')
    }
    const now = new Date().toISOString()
    const { expectedRevision, ...content } = input
    const record = knowledgeRevisionSchema.parse({ ...content, version: 1, revision: expectedRevision + 1,
      previousRevision: expectedRevision === 0 ? null : expectedRevision, createdAt: current?.createdAt ?? now, updatedAt: now,
      ...input.kind === 'protocol' ? { state: 'proposed' } : {} })
    this.checkRecordBudget(record)
    await this.publish(root, record)
    return record
  }

  /**
   * Adopt or retire a protocol without changing its selected content.
   * @param workspace - workspace collection.
   * @param id - protocol identity.
   * @param change - expected head and explicit lifecycle decision.
   * @returns the new lifecycle revision; repeated current-state decisions return the current revision.
   */
  async transition(workspace: string, id: KnowledgeRecordId, change: KnowledgeTransition): Promise<KnowledgeRevision> {
    return await storage(async () => await this.transitionStored(workspace, id, change))
  }

  private async transitionStored(workspace: string, id: KnowledgeRecordId, change: KnowledgeTransition): Promise<KnowledgeRevision> {
    const root = await this.workspaceRoot(workspace)
    const current = (await this.history(root, id)).at(-1)
    requireExpected(current, change.expectedRevision)
    if (current?.kind !== 'protocol') throw new KnowledgeStoreError(400, 'knowledge-invalid', 'Only protocols have adoption and retirement states.')
    if (current.state === change.state) return current
    if (current.state === 'retired' && change.state === 'adopted') {
      throw new KnowledgeStoreError(409, 'knowledge-conflict', 'Create a new proposed revision before adopting a retired protocol.')
    }
    const record: KnowledgeRevision = { ...current, revision: current.revision + 1, previousRevision: current.revision,
      state: change.state, updatedAt: new Date().toISOString() }
    this.checkRecordBudget(record)
    await this.publish(root, record)
    return record
  }

  /**
   * Resolve explicitly selected immutable revisions before run admission.
   * @param workspace - workspace collection.
   * @param references - exact supervisor choices in prompt order.
   * @returns full snapshots; protocols must be the currently adopted head.
   */
  async pin(workspace: string, references: readonly KnowledgeReference[]): Promise<KnowledgeSnapshot[]> {
    return await storage(async () => await this.pinStored(workspace, references))
  }

  private async pinStored(workspace: string, references: readonly KnowledgeReference[]): Promise<KnowledgeSnapshot[]> {
    if (references.length === 0) return []
    if (references.length > this.limits.maxReferences) throw new KnowledgeStoreError(413, 'knowledge-limit', 'Too many knowledge references were selected.')
    const root = await this.workspaceRoot(workspace)
    const ids = new Set<KnowledgeRecordId>()
    const snapshots: KnowledgeSnapshot[] = []
    for (const reference of references) {
      if (ids.has(reference.id)) throw new KnowledgeStoreError(400, 'knowledge-invalid', 'Select only one revision of each knowledge record.')
      ids.add(reference.id)
      const history = await this.history(root, reference.id)
      const selected = history.find(record => record.revision === reference.revision)
      if (selected === undefined) throw new KnowledgeStoreError(404, 'knowledge-not-found', 'A selected knowledge revision does not exist in this workspace.')
      if (selected.kind === 'protocol' && (selected.state !== 'adopted' || history.at(-1)?.revision !== selected.revision)) {
        throw new KnowledgeStoreError(409, 'knowledge-conflict', 'A selected protocol must be its currently adopted revision.')
      }
      snapshots.push(selected)
    }
    if (Buffer.byteLength(JSON.stringify(snapshots), 'utf8') > this.limits.maxSnapshotBytes) {
      throw new KnowledgeStoreError(413, 'knowledge-limit', 'Selected knowledge exceeds the configured snapshot byte limit.')
    }
    return snapshots
  }

  /** Hash canonical workspace identity without exposing it in filenames. */
  private async workspaceRoot(workspace: string): Promise<string> {
    const canonical = await realpath(workspace)
    const identity = comparisonKey(canonical)
    return path.join(this.stateDirectory, 'knowledge', createHash('sha256').update(identity).digest('hex'))
  }

  /** Validate every committed link before trusting the next revision number or an exact old snapshot. */
  private async history(root: string, id: KnowledgeRecordId): Promise<KnowledgeRevision[]> {
    if (!await this.collectionExists(root)) return []
    const directory = path.join(root, id)
    const files = (await entries(directory)).filter(entry => !/^\.[1-9]\d*\.[0-9a-f-]{36}\.tmp$/u.test(entry.name))
    if (files.some(entry => !entry.isFile() || !/^[1-9]\d*\.json$/u.test(entry.name))) {
      throw new KnowledgeStoreError(503, 'knowledge-state', 'Knowledge history contains an unrecognized entry; preserve it for inspection.')
    }
    files.sort((left, right) => Number(left.name.slice(0, -5)) - Number(right.name.slice(0, -5)))
    const records: KnowledgeRevision[] = []
    for (const entry of files) {
      const file = path.join(directory, entry.name)
      const before = await lstat(file, { bigint: true })
      if (!before.isFile() || before.isSymbolicLink()) throw new KnowledgeStoreError(503, 'knowledge-state', 'Knowledge revisions must be physical files.')
      const handle = await open(file, 'r')
      let record: KnowledgeRevision
      try {
        const stat = await handle.stat({ bigint: true })
        if (stat.dev !== before.dev || stat.ino !== before.ino) throw new Error('knowledge file replaced while opening')
        record = knowledgeRevisionSchema.parse(JSON.parse(await handle.readFile('utf8')))
      } catch (error) {
        throw new KnowledgeStoreError(503, 'knowledge-state', 'A knowledge revision is unreadable or malformed; preserve its history.', { cause: error })
      } finally { await handle.close() }
      const previous = records.at(-1)
      if (record.id !== id || entry.name !== `${String(record.revision)}.json` || record.revision !== records.length + 1 ||
        record.previousRevision !== (previous?.revision ?? null) ||
        (previous !== undefined && (record.kind !== previous.kind || record.createdAt !== previous.createdAt))) {
        throw new KnowledgeStoreError(503, 'knowledge-state', 'Knowledge revision identities or history links disagree; preserve the collection.')
      }
      records.push(record)
    }
    return records
  }

  private checkRecordBudget(record: KnowledgeRevision): void {
    assertKnowledgeLimits(record, this.limits)
  }

  private async collectionExists(root: string): Promise<boolean> {
    for (const directory of [path.join(this.stateDirectory, 'knowledge'), root]) {
      try { await physicalDirectory(directory) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw error
      }
    }
    return true
  }

  /** Fsync file content before exclusive publication; directory power-loss durability is not promised. */
  private async publish(root: string, record: KnowledgeRevision): Promise<void> {
    const directory = path.join(root, record.id)
    for (const entry of [path.join(this.stateDirectory, 'knowledge'), root, directory]) {
      try { await mkdir(entry) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      await physicalDirectory(entry)
    }
    const temporary = path.join(directory, `.${String(record.revision)}.${randomUUID()}.tmp`)
    const handle = await open(temporary, 'wx', 0o600)
    try { await handle.writeFile(`${JSON.stringify(record)}\n`); await handle.sync() } finally { await handle.close() }
    try {
      await link(temporary, path.join(directory, `${String(record.revision)}.json`))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new KnowledgeStoreError(409, 'knowledge-conflict', 'The expected knowledge revision changed; read its current head and retry.', { cause: error })
      }
      throw new KnowledgeStoreError(503, 'knowledge-state', 'Knowledge publication failed; inspect the retained revision before retrying.', { cause: error })
    } finally { await unlink(temporary) }
  }
}

function requireExpected(current: KnowledgeRevision | undefined, expected: number): void {
  if ((current?.revision ?? 0) !== expected) throw new KnowledgeStoreError(409, 'knowledge-conflict', 'The expected knowledge revision does not match its current head.')
}

async function physicalDirectory(directory: string): Promise<void> {
  const stat = await lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new KnowledgeStoreError(503, 'knowledge-state', 'Knowledge directories must not redirect through links.')
}

async function entries(directory: string) {
  try { await physicalDirectory(directory); return await readdir(directory, { withFileTypes: true }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/** Registry I/O failure stops dependent admission without invalidating snapshots held by running workers. */
async function storage<T>(action: () => Promise<T>): Promise<T> {
  try { return await action() } catch (error) {
    if (!(error instanceof KnowledgeStoreError) && error instanceof Error && 'code' in error && typeof error.code === 'string') {
      throw new KnowledgeStoreError(503, 'knowledge-state', 'Knowledge storage is unavailable; existing run snapshots remain retained.', { cause: error })
    }
    throw error
  }
}
