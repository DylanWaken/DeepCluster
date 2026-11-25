/** Deterministic inventory ordering, query validation, and independent attention evidence. */
import path from 'node:path'
import { expect, it } from 'vitest'
import { listApiRuns } from '../src/api-runs.ts'
import { apiOperationSchema, type ApiOperation } from '../src/api-types.ts'

function record(number: number, overrides: Partial<ApiOperation> = {}): ApiOperation {
  return apiOperationSchema.parse({ version: 1,
    operationId: `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`,
    keyHash: 'a'.repeat(64), requestHash: 'b'.repeat(64), workspace: path.resolve('fixture-workspace'),
    ownerPid: 123, status: 'running', runId: null,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    progress: null, result: null, error: null, ...overrides })
}

function page(records: readonly ApiOperation[], query = '') {
  return listApiRuns(new Map(records.map(item => [item.operationId, item])), new URLSearchParams(query), 10)
}

it('uses immutable creation keys and accepts a different page size for the same filters', () => {
  const records = [record(1), record(2), record(3)]
  const first = page(records, 'limit=1')
  expect(first.runs.map(item => item.operationId)).toEqual([records[2]!.operationId])
  expect(first.more).toBe(true)
  records[0]!.updatedAt = '2026-02-01T00:00:00.000Z'
  records.push(record(4, { createdAt: '2026-02-01T00:00:00.000Z' }))
  const second = page(records, `limit=2&after=${first.cursor}`)
  expect(second.runs.map(item => item.operationId)).toEqual([records[1]!.operationId, records[0]!.operationId])
  expect(second).toMatchObject({ more: false, cursor: null })
})

it('keeps filters live and reports newly matching records only on a fresh scan when ahead of the cursor', () => {
  const records = [record(1, { status: 'failed' }), record(2, { status: 'failed' }), record(3)]
  const first = page(records, 'attention=true&limit=1')
  records[2]!.status = 'failed'
  expect(page(records, `attention=true&after=${first.cursor}`).runs.map(item => item.operationId)).toEqual([records[0]!.operationId])
  expect(page(records, 'attention=true').runs.map(item => item.operationId)).toEqual([records[2]!.operationId, records[1]!.operationId, records[0]!.operationId])
  expect(page(records, 'attention=false').runs).toEqual([])
})

it('reports cleanup, acknowledgement, failure and audit evidence independently', () => {
  const operation = record(1, { status: 'failed', result: {
    runId: '00000000-0000-4000-8000-000000000099', status: 'failed', journalFile: 'private-journal', cleanupConfirmed: false,
    steps: [{ stepId: 'one', title: 'private-title', role: 'tester', attempts: 1, status: 'fail', summary: 'private-summary',
      checks: ['private-check'], auditProblem: 'private-audit', changed: ['private-change'] }],
    openImprovisations: [{ id: 'private-open', reason: 'private-reason' }], failure: { stepId: 'one', output: 'private-output' },
  } })
  expect(page([operation]).runs[0]).toEqual({
    operationId: operation.operationId, workspace: operation.workspace, runId: null, status: 'failed',
    createdAt: operation.createdAt, updatedAt: operation.updatedAt,
    attention: ['cleanup-unconfirmed', 'needs-ack', 'failed', 'audit-problem'], open: 1,
    counts: { total: 1, queued: 0, running: 0, waiting: 0, passed: 0, failed: 1, blocked: 0 },
  })
  const cancelled = record(2, { status: 'cancelled', error: { code: 'cleanup-unconfirmed', message: 'private-error' } })
  expect(page([cancelled]).runs[0]?.attention).toEqual(['cleanup-unconfirmed'])
  expect(page([record(3, { status: 'interrupted' })]).runs[0]?.attention).toEqual(['interrupted'])
  expect(page([record(4, { status: 'needs-ack' })]).runs[0]?.attention).toEqual(['needs-ack'])
})

it('returns only counts from active progress and supports exact workspace and status filters', () => {
  const operation = record(1, { progress: { total: 3, queued: 1, running: 1, waiting: 1, passed: 0, failed: 0, blocked: 0,
    steps: [{ stepId: 'private-step', title: 'private-title', role: 'tester', status: 'running', attempt: 1 }],
    recentEvent: { type: 'private-type', at: '2026-01-01T00:00:00.000Z', detail: 'private-detail' } } })
  const result = page([operation], `workspace=${encodeURIComponent(operation.workspace)}&status=running&attention=false`)
  expect(result.runs[0]?.counts).toEqual({ total: 3, queued: 1, running: 1, waiting: 1, passed: 0, failed: 0, blocked: 0 })
  expect(JSON.stringify(result)).not.toContain('private-')
  expect(page([operation], 'status=completed').runs).toEqual([])
  expect(page([operation], `workspace=${encodeURIComponent(path.resolve('other-workspace'))}`).runs).toEqual([])
  operation.progress!.failed = 1
  expect(page([operation], 'attention=true').runs[0]?.attention).toEqual(['failed'])
})

it.each(['unknown=yes', 'status=running&status=failed', 'attention=1', 'status=unknown', 'workspace=relative',
  'limit=0', 'limit=11', 'limit=-1', 'limit=1.5', 'limit=', 'after=', 'after=garbage', `after=${'a'.repeat(513)}`])(
  'refuses invalid inventory query %s', (query) => {
    expect(() => page([record(1)], query)).toThrow()
  },
)

it('refuses cursor filter changes and anchors no longer retained', () => {
  const records = [record(1), record(2)]
  const cursor = page(records, 'limit=1').cursor
  expect(() => page(records, `status=running&after=${cursor}`)).toThrow('does not match these filters')
  expect(() => page([records[0]!], `after=${cursor}`)).toThrow('no longer retained')
  const invalid = Buffer.from(JSON.stringify({ version: 1, query: 'a'.repeat(64), operationId: '../private-path' })).toString('base64url')
  expect(() => page(records, `after=${invalid}`)).toThrow('does not match these filters')
})
