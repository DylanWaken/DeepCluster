/** Read-only supervisor knowledge projections and validation of recorded lesson citations. */
import { listApiRuns, type ApiRunAttention, type ApiRunSummary, type RunListCursor } from './api-runs.ts'
import { ApiError, isActiveOperation, type ApiOperation, type OperationId } from './api-types.ts'
import type { KnowledgeStore } from './knowledge-store.ts'
import type { KnowledgeReference, KnowledgeRevision, KnowledgeWrite } from './knowledge-types.ts'

/** Latest revision identity and title, without content, constraints, or evidence text. */
export type KnowledgeSummary = Pick<KnowledgeRevision, 'id' | 'revision' | 'kind' | 'title' | 'createdAt' | 'updatedAt'> & {
  readonly state?: 'proposed' | 'adopted' | 'retired'
}

/** Counts and independent truncation flags for each bounded briefing collection. */
type BriefingCollections<T> = { readonly runs: T; readonly records: T; readonly protocols: T; readonly lessons: T }

/** Current workspace facts; reading neither adopts guidance nor changes execution or acknowledgements. */
export interface ApiKnowledgeBriefing {
  readonly workspace: string
  readonly observationTime: string
  readonly runs: readonly ApiRunSummary[]
  readonly runCursor: RunListCursor | null
  readonly records: readonly KnowledgeSummary[]
  readonly protocols: readonly KnowledgeSummary[]
  readonly lessons: readonly KnowledgeSummary[]
  readonly counts: BriefingCollections<number>
  readonly truncated: BriefingCollections<boolean>
  readonly attention: { readonly total: number; readonly counts: Readonly<Record<ApiRunAttention, number>> }
}

/** Retained runs selecting one immutable revision; selection does not establish use or compliance. */
export interface ApiKnowledgeUsage {
  readonly reference: KnowledgeReference
  readonly runs: readonly Pick<ApiOperation, 'operationId' | 'runId' | 'status' | 'createdAt'>[]
  readonly count: number
  readonly truncated: boolean
}

/**
 * Project one record without copying its body, lesson evidence, or protocol constraints.
 * @param record - complete immutable revision.
 * @returns public summary, including lifecycle state only for protocols.
 */
export function knowledgeSummary(record: KnowledgeRevision): KnowledgeSummary {
  const { id, revision, kind, title, createdAt, updatedAt } = record
  return { id, revision, kind, title, createdAt, updatedAt,
    ...record.kind === 'protocol' ? { state: record.state } : {} }
}

/**
 * Require lesson citations to name settled, retained operations in the same workspace.
 * Failed and interrupted work is valid evidence; a citation establishes no successful outcome.
 * @param workspace - canonical workspace selected by the API.
 * @param input - validated content replacement.
 * @param operations - retained operation metadata, read under the API's serialization owner.
 * @returns normally when every citation resolves; rejects active, foreign, or absent evidence.
 */
export function validateLessonEvidence(workspace: string, input: KnowledgeWrite,
  operations: ReadonlyMap<OperationId, ApiOperation>): void {
  if (input.kind !== 'lesson') return
  for (const evidence of input.evidence) {
    const record = operations.get(evidence.operationId)
    if (record === undefined || record.workspace !== workspace) {
      throw new ApiError(400, 'invalid-evidence', `Lesson evidence ${evidence.operationId} must name a retained operation in this workspace.`)
    }
    if (isActiveOperation(record)) {
      throw new ApiError(400, 'invalid-evidence', `Lesson evidence ${evidence.operationId} is still active; wait for execution and teardown to settle.`)
    }
    const steps = record.result?.steps ?? record.progress?.steps ?? []
    if (evidence.stepId !== undefined && !steps.some(step => step.stepId === evidence.stepId)) {
      throw new ApiError(400, 'invalid-evidence', `Lesson evidence step ${evidence.stepId} is absent from operation ${evidence.operationId}.`)
    }
  }
}

/**
 * Read bounded workspace context without bodies, raw worker output, or implicit adoption.
 * Counts cover every retained match, including records omitted by the response limit.
 * @param store - workspace knowledge store owned by this API.
 * @param operations - retained operations, stable during this serialized read.
 * @param workspace - canonical workspace selected by the API.
 * @param limit - validated positive per-collection limit, at most the API's configured maximum.
 * @returns latest knowledge heads and live run summaries with independent truncation flags.
 */
export async function readKnowledgeBriefing(store: KnowledgeStore, operations: ReadonlyMap<OperationId, ApiOperation>,
  workspace: string, limit: number): Promise<ApiKnowledgeBriefing> {
  const observationTime = new Date().toISOString()
  const records = (await store.list(workspace)).map(knowledgeSummary)
  const protocols = records.filter(record => record.kind === 'protocol' && record.state === 'adopted')
  const lessons = records.filter(record => record.kind === 'lesson')
  const page = listApiRuns(operations, new URLSearchParams({ workspace, limit: String(limit) }), limit)
  const maximum = Math.max(operations.size, 1)
  const allRuns = listApiRuns(operations, new URLSearchParams({ workspace }), maximum).runs
  const attention: Record<ApiRunAttention, number> = {
    'cleanup-unconfirmed': 0, interrupted: 0, 'needs-ack': 0, failed: 0, 'audit-problem': 0,
  }
  for (const run of allRuns) for (const reason of run.attention) attention[reason]++
  return { workspace, observationTime, runs: page.runs, runCursor: page.cursor,
    records: records.slice(0, limit), protocols: protocols.slice(0, limit), lessons: lessons.slice(0, limit),
    counts: { runs: allRuns.length, records: records.length, protocols: protocols.length, lessons: lessons.length },
    truncated: { runs: page.more, records: records.length > limit, protocols: protocols.length > limit, lessons: lessons.length > limit },
    attention: { total: allRuns.filter(run => run.attention.length > 0).length, counts: attention } }
}

/**
 * Find retained selections of an exact immutable knowledge revision.
 * @param operations - retained operations, stable during this serialized read.
 * @param workspace - canonical workspace selected by the API.
 * @param reference - existing record and revision resolved by the API.
 * @param limit - validated positive maximum number of selected runs to return.
 * @returns newest runs first, total retained selections, and whether the list was truncated.
 */
export function listKnowledgeUsage(operations: ReadonlyMap<OperationId, ApiOperation>, workspace: string,
  reference: KnowledgeReference, limit: number): ApiKnowledgeUsage {
  const matches = [...operations.values()].filter(record => record.workspace === workspace &&
    record.knowledge?.some(selected => selected.id === reference.id && selected.revision === reference.revision) === true)
    .sort((left, right) => left.createdAt === right.createdAt
      ? left.operationId === right.operationId ? 0 : left.operationId < right.operationId ? 1 : -1
      : left.createdAt < right.createdAt ? 1 : -1)
  return { reference: { ...reference }, runs: matches.slice(0, limit).map(({ operationId, runId, status, createdAt }) =>
    ({ operationId, runId, status, createdAt })), count: matches.length, truncated: matches.length > limit }
}
