/** Read-only fleet summaries and live keyset pagination over retained API operations. */
import { createHash } from 'node:crypto'
import path from 'node:path'
import { z } from 'zod'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { ApiError, apiOperationSchema, type ApiOperation, type OperationId } from './api-types.ts'
import type { RunId } from './types.ts'

/** Independent recorded conditions a supervisor may need to inspect. */
export type ApiRunAttention = 'cleanup-unconfirmed' | 'interrupted' | 'needs-ack' | 'failed' | 'audit-problem'

/** Opaque live inventory position bound to its workspace, status, and attention filters. */
export type RunListCursor = Branded<'DeepClusterRunListCursor'>

/** Public operation identity and counts; detailed worker evidence stays in the operation report. */
export interface ApiRunSummary {
  readonly operationId: OperationId
  readonly workspace: string
  readonly runId: RunId | null
  readonly status: ApiOperation['status']
  readonly createdAt: string
  readonly updatedAt: string
  readonly attention: readonly ApiRunAttention[]
  readonly open: number
  readonly counts: {
    readonly total: number
    readonly queued: number
    readonly running: number
    readonly waiting: number
    readonly passed: number
    readonly failed: number
    readonly blocked: number
  } | null
}

/** One bounded live page; a null cursor means no further currently matching operation. */
export interface ApiRunsPage {
  readonly runs: readonly ApiRunSummary[]
  readonly cursor: RunListCursor | null
  readonly more: boolean
}

const cursorSchema = z.object({ version: z.literal(1), query: z.string().regex(/^[a-f0-9]{64}$/u),
  operationId: z.uuid() }).strict()

/** Select independent attention facts without deriving failure from elapsed time or resource waits. */
function attentionOf(record: ApiOperation): ApiRunAttention[] {
  const reasons: ApiRunAttention[] = []
  if (record.error?.code === 'cleanup-unconfirmed' || record.result?.cleanupConfirmed === false) reasons.push('cleanup-unconfirmed')
  if (record.status === 'interrupted') reasons.push('interrupted')
  if (record.status === 'needs-ack' || (record.result?.openImprovisations.length ?? 0) > 0) reasons.push('needs-ack')
  const hasFailedSteps = record.result === null
    ? (record.progress?.failed ?? 0) > 0 : record.result.steps.some(step => step.status === 'fail')
  if (record.status === 'failed' || hasFailedSteps) reasons.push('failed')
  if (record.result?.steps.some(step => step.auditProblem !== undefined) === true) reasons.push('audit-problem')
  return reasons
}

/** Project counters without copying raw worker output, private metadata, or step instructions. */
function summaryOf(record: ApiOperation): ApiRunSummary {
  let counts: ApiRunSummary['counts'] = null
  if (record.result !== null) {
    const steps = record.result.steps
    counts = { total: steps.length, queued: 0, running: 0, waiting: 0,
      passed: steps.filter(step => step.status === 'pass').length,
      failed: steps.filter(step => step.status === 'fail').length,
      blocked: steps.filter(step => step.status === 'blocked').length }
  } else if (record.progress !== null) {
    const { total, queued, running, waiting, passed, failed, blocked } = record.progress
    counts = { total, queued, running, waiting, passed, failed, blocked }
  }
  return { operationId: record.operationId, workspace: record.workspace, runId: record.runId as RunId | null,
    status: record.status, createdAt: record.createdAt, updatedAt: record.updatedAt,
    attention: attentionOf(record), open: record.result?.openImprovisations.length ?? 0, counts }
}

/** Compare immutable creation keys, including deterministic same-time identities. */
function compare(left: ApiOperation, right: ApiOperation): number {
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? 1 : -1
  return left.operationId === right.operationId ? 0 : left.operationId < right.operationId ? 1 : -1
}

/**
 * Read a bounded page ordered by descending creation time and operation identifier.
 * Filters are live: status changes do not move records, and a newly matching record
 * ahead of the cursor requires a fresh scan. New same-time records behind the cursor
 * can enter later pages. This inventory is not a change feed or frozen snapshot.
 * @param operations - retained operations, read under the store's serialization owner.
 * @param query - optional workspace, exact status, attention boolean, limit, and after cursor.
 * @param maximum - configured maximum number of summaries; omitted limit uses this bound.
 * @returns current summaries and a filter-bound cursor; reads never acknowledge or dispatch work.
 */
export function listApiRuns(operations: ReadonlyMap<OperationId, ApiOperation>, query: URLSearchParams, maximum: number): ApiRunsPage {
  const allowed = ['workspace', 'status', 'attention', 'limit', 'after']
  for (const name of query.keys()) {
    if (!allowed.includes(name) || query.getAll(name).length !== 1) {
      throw new ApiError(400, 'invalid-query', `Unexpected or repeated query parameter: ${name}`)
    }
  }
  const workspaceValue = query.get('workspace')
  if (workspaceValue !== null && !path.isAbsolute(workspaceValue)) {
    throw new ApiError(400, 'invalid-workspace', 'The workspace filter must be an absolute path.')
  }
  const workspace = workspaceValue === null ? null : path.resolve(workspaceValue)
  const statusValue = query.get('status')
  const status = statusValue === null ? null : apiOperationSchema.shape.status.safeParse(statusValue)
  if (status !== null && !status.success) throw new ApiError(400, 'invalid-query', 'The status filter must name one operation status.')
  const attentionValue = query.get('attention')
  if (attentionValue !== null && attentionValue !== 'true' && attentionValue !== 'false') {
    throw new ApiError(400, 'invalid-query', 'The attention filter must be true or false.')
  }
  const attention = attentionValue === null ? null : attentionValue === 'true'
  const limitValue = query.get('limit')
  const limit = limitValue === null ? maximum : Number(limitValue)
  if (limitValue !== null && (!/^\d+$/u.test(limitValue) || !Number.isSafeInteger(limit) || limit < 1 || limit > maximum)) {
    throw new ApiError(400, 'invalid-query', `limit must be an integer between 1 and ${String(maximum)}.`)
  }
  const statusFilter = status === null ? null : status.data
  const queryHash = createHash('sha256').update(JSON.stringify({ workspace, status: statusFilter, attention })).digest('hex')
  const after = query.get('after')
  let anchor: ApiOperation | undefined
  if (after !== null) {
    if (after.length > 512 || !/^[A-Za-z0-9_-]+$/u.test(after)) throw new ApiError(400, 'invalid-cursor', 'The run cursor is malformed; restart the inventory scan.')
    let value: unknown
    try { value = JSON.parse(Buffer.from(after, 'base64url').toString('utf8')) } catch (_error) {
      throw new ApiError(400, 'invalid-cursor', 'The run cursor is malformed; restart the inventory scan.')
    }
    const cursor = cursorSchema.safeParse(value)
    if (!cursor.success || cursor.data.query !== queryHash) {
      throw new ApiError(400, 'invalid-cursor', 'The run cursor does not match these filters; restart the inventory scan.')
    }
    anchor = operations.get(cursor.data.operationId as OperationId)
    if (anchor === undefined) throw new ApiError(400, 'invalid-cursor', 'The run cursor names an operation that is no longer retained; restart the inventory scan.')
  }
  const matches = [...operations.values()].filter(record =>
    (anchor === undefined || compare(record, anchor) > 0)
    && (workspace === null || record.workspace === workspace)
    && (statusFilter === null || record.status === statusFilter)
    && (attention === null || (attentionOf(record).length > 0) === attention)).sort(compare)
  const selected = matches.slice(0, limit)
  const more = matches.length > selected.length
  const last = selected.at(-1)
  const cursor = more && last !== undefined
    ? Buffer.from(JSON.stringify({ version: 1, query: queryHash, operationId: last.operationId })).toString('base64url') as RunListCursor
    : null
  return { runs: selected.map(summaryOf), cursor, more }
}
