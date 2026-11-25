/** Evidence citations, bounded supervisor context, and exact selected-revision lookup. */
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { knowledgeSummary, listKnowledgeUsage, readKnowledgeBriefing, validateLessonEvidence } from '../src/api-knowledge.ts'
import { apiOperationSchema, type ApiOperation } from '../src/api-types.ts'
import { KnowledgeStore } from '../src/knowledge-store.ts'
import { knowledgeRevisionSchema, knowledgeWriteSchema, type KnowledgeRevision } from '../src/knowledge-types.ts'

const workspace = path.resolve('knowledge-fixture-workspace')
const otherWorkspace = path.resolve('other-knowledge-fixture-workspace')

function id(number: number): string { return `00000000-0000-4000-8000-${String(number).padStart(12, '0')}` }

function operation(number: number, overrides: Partial<ApiOperation> = {}): ApiOperation {
  return apiOperationSchema.parse({ version: 1, operationId: id(number),
    keyHash: 'a'.repeat(64), requestHash: 'b'.repeat(64), workspace, ownerPid: 123,
    status: 'completed', runId: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    progress: null, result: null, error: null, ...overrides })
}

function records(...items: ApiOperation[]) { return new Map(items.map(item => [item.operationId, item])) }

function revision(number: number, extra: Record<string, unknown> = {}): KnowledgeRevision {
  return knowledgeRevisionSchema.parse({ version: 1, id: id(number), revision: 1, previousRevision: null,
    title: `Record ${String(number)}`, body: 'Private knowledge body', kind: 'document',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...extra })
}

function lesson(operationId: string, stepId?: string) {
  return knowledgeWriteSchema.parse({ id: id(99), expectedRevision: 0, kind: 'lesson', title: 'A lesson', body: 'Observed failure',
    evidence: [{ operationId, ...stepId === undefined ? {} : { stepId } }] })
}

function progress(): NonNullable<ApiOperation['progress']> {
  return { total: 1, queued: 0, running: 0, waiting: 0, passed: 0, failed: 1, blocked: 0, recentEvent: null,
    steps: [{ stepId: 'failed-step', title: 'Failed work', role: 'developer', status: 'fail', attempt: 1 }] }
}

function outcome(): NonNullable<ApiOperation['result']> {
  return { runId: id(40), status: 'failed', journalFile: 'journal.jsonl', openImprovisations: [], cleanupConfirmed: true,
    steps: [{ stepId: 'result-step', title: 'Recorded work', role: 'developer', status: 'fail', attempts: 1, summary: 'Raw worker output' }] }
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'deep-cluster-api-knowledge-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, 'state'))
  const store = new KnowledgeStore(path.join(root, 'state'), {
    maxRecords: 20, maxBodyBytes: 4096, maxReferences: 20, maxSnapshotBytes: 32768,
  })
  return { root, store }
}

it.each(['completed', 'failed', 'cancelled', 'interrupted', 'needs-ack'] as const)(
  'accepts recorded %s work as a lesson without asserting success', (status) => {
    const record = operation(1, { status, progress: progress() })
    const before = structuredClone(record)
    expect(() => { validateLessonEvidence(workspace, lesson(record.operationId, 'failed-step'), records(record)) }).not.toThrow()
    expect(record).toEqual(before)
  })

it.each(['accepted', 'running', 'cancelling'] as const)('rejects lesson evidence while its operation is %s', (status) => {
  const record = operation(1, { status })
  expect(() => { validateLessonEvidence(workspace, lesson(record.operationId), records(record)) })
    .toThrow(expect.objectContaining({ status: 400, code: 'invalid-evidence' }))
})

it('rejects absent operations and operations from another workspace', () => {
  const foreign = operation(1, { workspace: otherWorkspace })
  for (const evidence of [lesson(id(2)), lesson(foreign.operationId)]) {
    expect(() => { validateLessonEvidence(workspace, evidence, records(foreign)) })
      .toThrow(expect.objectContaining({ code: 'invalid-evidence' }))
  }
})

it('resolves a step against the terminal result when available, else the retained progress', () => {
  const record = operation(1, { progress: progress(), result: outcome() })
  expect(() => { validateLessonEvidence(workspace, lesson(record.operationId, 'result-step'), records(record)) }).not.toThrow()
  for (const stepId of ['failed-step', 'absent']) {
    expect(() => { validateLessonEvidence(workspace, lesson(record.operationId, stepId), records(record)) })
      .toThrow(expect.objectContaining({ code: 'invalid-evidence' }))
  }
  const empty = operation(2)
  expect(() => { validateLessonEvidence(workspace, lesson(empty.operationId, 'absent'), records(empty)) }).toThrow('absent')
})

it('checks every lesson citation and leaves ordinary content validation to the knowledge parser', () => {
  const settled = operation(1), active = operation(2, { status: 'running' })
  const input = lesson(settled.operationId)
  if (input.kind !== 'lesson') throw new Error('Expected lesson fixture')
  input.evidence.push({ operationId: active.operationId })
  expect(() => { validateLessonEvidence(workspace, input, records(settled, active)) }).toThrow('still active')
  const document = knowledgeWriteSchema.parse({ id: id(10), expectedRevision: 0, kind: 'document', title: 'Interface', body: 'Details' })
  expect(() => { validateLessonEvidence(workspace, document, records()) }).not.toThrow()
})

it('summarizes protocol state without copying bodies, constraints, or lesson evidence', () => {
  const protocol = revision(1, { kind: 'protocol', state: 'adopted', constraints: { requireReviewAfterWrites: ['reviewer'] } })
  const summary = knowledgeSummary(protocol)
  expect(summary).toEqual({ id: protocol.id, revision: 1, kind: 'protocol', state: 'adopted', title: protocol.title,
    createdAt: protocol.createdAt, updatedAt: protocol.updatedAt })
  expect(knowledgeSummary(revision(2, { kind: 'lesson', evidence: [{ operationId: id(9) }] })))
    .not.toHaveProperty('evidence')
  expect(knowledgeSummary(revision(3))).not.toHaveProperty('state')
})

it('briefs latest heads and counts attention beyond its bounded run page without mutating the store', async () => {
  const { root, store } = await fixture()
  const selectedWorkspace = root
  for (const number of [1, 2]) {
    await store.write(selectedWorkspace, knowledgeWriteSchema.parse({ id: id(number), expectedRevision: 0,
      kind: 'protocol', title: `Protocol ${String(number)}`, body: 'Hidden rules' }))
    await store.transition(selectedWorkspace, revision(number).id, { expectedRevision: 1, state: 'adopted' })
  }
  await store.transition(selectedWorkspace, revision(2).id, { expectedRevision: 2, state: 'retired' })
  for (const number of [3, 4]) {
    await store.write(selectedWorkspace, knowledgeWriteSchema.parse({ ...lesson(id(1)), id: id(number) }))
  }
  const old = operation(1, { workspace: selectedWorkspace, status: 'failed', result: { ...outcome(), cleanupConfirmed: false,
    openImprovisations: [{ id: 'decision' }], steps: [{ ...outcome().steps[0]!, auditProblem: 'Private audit detail' }] } })
  const newer = operation(2, { workspace: selectedWorkspace, status: 'running' })
  const foreign = operation(3, { workspace: otherWorkspace, status: 'interrupted' })
  const retained = records(old, newer, foreign), before = structuredClone([...retained.values()])
  const filesBefore = await readdir(path.join(root, 'state'), { recursive: true })
  const knowledgeBefore = await store.list(selectedWorkspace)
  const briefing = await readKnowledgeBriefing(store, retained, selectedWorkspace, 1)
  expect(briefing.runs.map(run => run.operationId)).toEqual([newer.operationId])
  expect(briefing.runCursor).not.toBeNull()
  expect(briefing.counts).toEqual({ runs: 2, records: 4, protocols: 1, lessons: 2 })
  expect(briefing.truncated).toEqual({ runs: true, records: true, protocols: false, lessons: true })
  expect(briefing.attention).toEqual({ total: 1, counts: { 'cleanup-unconfirmed': 1, interrupted: 0,
    'needs-ack': 1, failed: 1, 'audit-problem': 1 } })
  expect(briefing.protocols).toEqual([expect.objectContaining({ id: id(1), revision: 2, state: 'adopted' })])
  expect(briefing.records).toHaveLength(1)
  expect(briefing.lessons).toHaveLength(1)
  expect(Number.isFinite(Date.parse(briefing.observationTime))).toBe(true)
  expect(JSON.stringify(briefing)).not.toMatch(/Hidden rules|Observed failure|Private audit detail|Raw worker output/)
  expect([...retained.values()]).toEqual(before)
  expect(await store.list(selectedWorkspace)).toEqual(knowledgeBefore)
  expect(await readdir(path.join(root, 'state'), { recursive: true })).toEqual(filesBefore)
})

it('returns an empty briefing without creating knowledge directories', async () => {
  const { root, store } = await fixture()
  const briefing = await readKnowledgeBriefing(store, records(), root, 2)
  expect(briefing).toMatchObject({ runs: [], records: [], protocols: [], lessons: [], runCursor: null,
    counts: { runs: 0, records: 0, protocols: 0, lessons: 0 },
    truncated: { runs: false, records: false, protocols: false, lessons: false }, attention: { total: 0 } })
  expect(await readdir(path.join(root, 'state'))).toEqual([])
})

it('lists exact revision selections once per run, with stable newest-first bounds', () => {
  const selected = revision(10), next = revision(10, { revision: 2, previousRevision: 1 })
  const one = operation(1, { knowledge: [selected, selected] })
  const two = operation(2, { status: 'failed', knowledge: [selected] })
  const newer = operation(3, { status: 'running', knowledge: [selected], createdAt: '2026-01-02T00:00:00.000Z' })
  const retained = records(one, two, newer, operation(4, { knowledge: [next] }),
    operation(5, { knowledge: [selected], workspace: otherWorkspace }), operation(6))
  const before = structuredClone([...retained.values()])
  const reference = { id: selected.id, revision: selected.revision }
  const usage = listKnowledgeUsage(retained, workspace, reference, 2)
  expect(usage).toEqual({ reference, count: 3, truncated: true, runs: [newer, two].map(record => ({
    operationId: record.operationId, runId: record.runId, status: record.status, createdAt: record.createdAt,
  })) })
  expect(listKnowledgeUsage(retained, workspace, reference, 10)).toMatchObject({ count: 3, truncated: false })
  expect(listKnowledgeUsage(retained, workspace, { id: revision(11).id, revision: 1 }, 1))
    .toMatchObject({ runs: [], count: 0, truncated: false })
  expect([...retained.values()]).toEqual(before)
})
