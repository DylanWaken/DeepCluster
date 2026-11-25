/** Persistent native turn ownership, exact-generation replacement, and damaged-record containment. */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { apiOperationSchema, type ApiOperation } from '../src/api-types.ts'
import { ClusterSessionStore, clusterSessionCreateSchema, type ClusterSession } from '../src/native-sessions.ts'

function id(number: number): string { return `00000000-0000-4000-8000-${String(number).padStart(12, '0')}` }

function operation(number: number, workspace: string, status: ApiOperation['status'] = 'completed', cleanupConfirmed = true): ApiOperation {
  return apiOperationSchema.parse({ version: 1, operationId: id(number), keyHash: 'a'.repeat(64), requestHash: 'b'.repeat(64),
    workspace, ownerPid: 123, status, runId: id(number + 100), createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    progress: null, result: { runId: id(number + 100), status: status === 'interrupted' ? 'failed' : status, journalFile: 'journal.jsonl',
      cleanupConfirmed, steps: [], openImprovisations: [] }, error: null })
}

async function fixture(limits = { maxRecords: 10, maxHandoffBytes: 1024 }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'deep-cluster-native-session-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const store = new ClusterSessionStore(root, limits)
  await store.initialize()
  const create = (number = 1, handoff = 'Assigned evidence only') => store.create(clusterSessionCreateSchema.parse({
    id: id(number), workspace: root, title: 'Reviewer', role: 'reviewer', handoff,
  }))
  const file = (record: ClusterSession) => path.join(root, 'native-sessions', `${record.id}.${String(record.generation)}.json`)
  return { root, store, create, file, restart: () => new ClusterSessionStore(root, limits) }
}

it('creates durable idle assignments without starting a native turn', async () => {
  const h = await fixture(), seat = await h.create()
  expect(seat).toMatchObject({ generation: 1, status: 'new', activeOperationId: null, previousSessionId: null })
  expect(JSON.parse(await readFile(h.file(seat), 'utf8'))).toEqual(seat)
  const restored = h.restart()
  await restored.initialize()
  expect(restored.get(seat.id)).toEqual(seat)
  await expect(h.create()).rejects.toMatchObject({ code: 'session-conflict' })
})

it('reserves one exact turn, then resumes the same native conversation after confirmed completion', async () => {
  const h = await fixture(), seat = await h.create(), run = operation(10, h.root)
  const binding = await h.store.reserve(seat, run.operationId)
  expect(binding).toMatchObject({ id: seat.id, generation: 1, nativeSession: { mode: 'create', id: seat.nativeSessionId }, handoff: seat.handoff })
  expect(JSON.parse(await readFile(h.file(seat), 'utf8'))).toMatchObject({ status: 'busy', activeOperationId: run.operationId })
  await expect(h.store.reserve(seat, operation(11, h.root).operationId)).rejects.toMatchObject({ code: 'session-busy' })
  await h.store.settle(binding, run)
  expect(h.store.get(seat.id)).toMatchObject({ status: 'ready', activeOperationId: null, lastOperationId: run.operationId })
  expect(await h.store.reserve(seat, operation(12, h.root).operationId)).toMatchObject({ nativeSession: { mode: 'resume', id: seat.nativeSessionId } })
})

it.each(['failed', 'cancelled', 'interrupted'] as const)('keeps %s turns interrupted even when cleanup is confirmed', async (status) => {
  const h = await fixture(), seat = await h.create(), run = operation(10, h.root, status)
  const binding = await h.store.reserve(seat, run.operationId)
  await h.store.settle(binding, run)
  expect(h.store.get(seat.id)).toMatchObject({ status: 'interrupted', lastOperationId: run.operationId })
  await expect(h.store.reserve(seat, operation(11, h.root).operationId)).rejects.toMatchObject({ code: 'session-interrupted' })
})

it('requires confirmed cleanup for reuse while allowing settled business acknowledgements', async () => {
  const h = await fixture(), first = await h.create(1), second = await h.create(2)
  const unknown = operation(10, h.root, 'completed', false), needsAck = operation(11, h.root, 'needs-ack')
  await h.store.settle(await h.store.reserve(first, unknown.operationId), unknown)
  await h.store.settle(await h.store.reserve(second, needsAck.operationId), needsAck)
  expect(h.store.get(first.id).status).toBe('interrupted')
  expect(h.store.get(second.id).status).toBe('ready')
})

it('fences replacement, requires joined ownership, and ignores old completions after the successor is published', async () => {
  const h = await fixture(), seat = await h.create(), run = operation(10, h.root, 'cancelled')
  const binding = await h.store.reserve(seat, run.operationId)
  expect(await h.store.beginReplacement(seat, 'Fresh explicit handoff')).toBe(run.operationId)
  await expect(h.store.reserve(seat, operation(11, h.root).operationId)).rejects.toMatchObject({ code: 'session-replacing' })
  await expect(h.store.replace(seat, 'Fresh explicit handoff')).rejects.toMatchObject({ code: 'session-busy' })
  await h.store.settle(binding, run)
  expect(h.store.get(seat.id)).toMatchObject({ status: 'replacing', activeOperationId: null })
  const replacement = await h.store.replace(seat, 'Fresh explicit handoff')
  expect(replacement).toMatchObject({ id: seat.id, generation: 2, status: 'new', previousSessionId: seat.nativeSessionId, handoff: 'Fresh explicit handoff' })
  expect(replacement.nativeSessionId).not.toBe(seat.nativeSessionId)
  expect(await readdir(path.join(h.root, 'native-sessions'))).toEqual([`${seat.id}.1.json`, `${seat.id}.2.json`])
  await h.store.settle(binding, run)
  expect(h.store.get(seat.id)).toEqual(replacement)
  await expect(h.store.reserve(seat, operation(12, h.root).operationId)).rejects.toMatchObject({ code: 'session-generation' })
  expect((await h.store.reserve(replacement, operation(13, h.root).operationId)).nativeSession.mode).toBe('create')
})

it('ignores completion from an operation that does not own the generation', async () => {
  const h = await fixture(), seat = await h.create(), run = operation(10, h.root)
  const binding = await h.store.reserve(seat, run.operationId)
  const before = await readFile(h.file(seat), 'utf8')
  await h.store.settle(binding, operation(11, h.root))
  expect(await readFile(h.file(seat), 'utf8')).toBe(before)
  expect(h.store.get(seat.id).activeOperationId).toBe(run.operationId)
})

it.each(['busy', 'replacing'] as const)('fences a retained %s generation after owner restart', async (status) => {
  const h = await fixture(), seat = await h.create(), run = operation(10, h.root)
  await h.store.reserve(seat, run.operationId)
  if (status === 'replacing') await h.store.beginReplacement(seat, 'Replacement context')
  const restored = h.restart()
  await restored.initialize()
  expect(restored.get(seat.id)).toMatchObject({ status: 'interrupted', activeOperationId: null, lastOperationId: run.operationId })
  await expect(restored.reserve(seat, operation(11, h.root).operationId)).rejects.toMatchObject({ code: 'session-interrupted' })
})

it('enforces handoff bytes before fencing and counts retained assignments', async () => {
  const h = await fixture({ maxRecords: 1, maxHandoffBytes: 5 }), seat = await h.create(1, 'ok')
  await expect(h.store.beginReplacement(seat, '界界')).rejects.toMatchObject({ code: 'session-handoff-limit' })
  expect(h.store.get(seat.id).status).toBe('new')
  await expect(h.store.replace(seat, '界界')).rejects.toMatchObject({ code: 'session-handoff-limit' })
  await expect(h.create(2, 'ok')).rejects.toMatchObject({ code: 'session-limit' })
})

it('retains the last operation when an idle replacement is interrupted by restart', async () => {
  const h = await fixture(), seat = await h.create(), run = operation(10, h.root, 'failed', false)
  await h.store.settle(await h.store.reserve(seat, run.operationId), run)
  expect(await h.store.beginReplacement(seat, 'Verified evidence')).toBeNull()
  const restored = h.restart()
  await restored.initialize()
  expect(restored.get(seat.id)).toMatchObject({ status: 'interrupted', activeOperationId: null, lastOperationId: run.operationId })
})

it('preserves a damaged latest generation and refuses fallback without blocking unrelated identities', async () => {
  const h = await fixture(), seat = await h.create()
  await writeFile(path.join(h.root, 'native-sessions', `${seat.id}.2.json`), '{damaged')
  const restored = h.restart()
  await restored.initialize()
  expect(restored.issues).toHaveLength(1)
  expect(() => restored.get(seat.id)).toThrow(expect.objectContaining({ code: 'session-storage' }))
  expect(await readFile(path.join(h.root, 'native-sessions', `${seat.id}.2.json`), 'utf8')).toBe('{damaged')
  expect(JSON.parse(await readFile(h.file(seat), 'utf8'))).toEqual(seat)
  await expect(restored.create(clusterSessionCreateSchema.parse({ id: id(2), workspace: h.root, title: 'Other', role: 'tester' })))
    .resolves.toMatchObject({ status: 'new' })
})
