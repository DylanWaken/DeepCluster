/** Immutable workspace knowledge, explicit protocol adoption, and compare-and-swap publication. */
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { KnowledgeStore } from '../src/knowledge-store.ts'
import { knowledgeReferenceSchema, knowledgeRevisionSchema, resolveKnowledgeTransition,
  resolveKnowledgeWrite } from '../src/knowledge-types.ts'
import type { KnowledgeLimits, KnowledgeRecordId } from '../src/knowledge-types.ts'

const limits: KnowledgeLimits = { maxRecords: 8, maxBodyBytes: 1024, maxReferences: 4, maxSnapshotBytes: 8192 }

const faults = vi.hoisted(() => new Map<string, Error>())
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
    const failure = typeof args[0] === 'string' ? faults.get(args[0]) : undefined
    if (failure !== undefined) throw failure
    return await actual.mkdir(...args)
  } }
})

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'deepcluster-knowledge-'))
  const state = path.join(root, 'state'), workspace = path.join(root, 'workspace')
  await mkdir(state)
  await mkdir(workspace)
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
  return { root, state, workspace, store: new KnowledgeStore(state, limits) }
}

function id(): KnowledgeRecordId { return knowledgeReferenceSchema.parse({ id: randomUUID(), revision: 1 }).id }

function content(recordId = id(), expectedRevision = 0, body = 'Shared background') {
  return resolveKnowledgeWrite({ id: recordId, expectedRevision, kind: 'document', title: 'Build notes', body }, limits)
}

async function recordDirectory(state: string, recordId: KnowledgeRecordId): Promise<string> {
  const workspaces = await readdir(path.join(state, 'knowledge'))
  if (workspaces.length !== 1) throw new Error('Expected one fixture collection')
  return path.join(state, 'knowledge', workspaces[0] ?? '', recordId)
}

it('retains exact old revisions while latest content advances and another store restarts', async () => {
  const h = await fixture(), first = await h.store.write(h.workspace, content())
  const pinned = await h.store.pin(h.workspace, [{ id: first.id, revision: 1 }])
  const second = await h.store.write(h.workspace, content(first.id, 1, 'Updated background'))
  const restarted = new KnowledgeStore(h.state, limits)
  expect(await restarted.list(h.workspace)).toEqual([second])
  expect(await restarted.read(h.workspace, first.id, 1)).toEqual(first)
  expect(await restarted.read(h.workspace, first.id, 99)).toBeNull()
  expect(pinned).toEqual([first])
  expect(second).toMatchObject({ revision: 2, previousRevision: 1, createdAt: first.createdAt })
})

it('admits only the currently adopted protocol and keeps existing snapshots after editing and retirement', async () => {
  const h = await fixture()
  const input = resolveKnowledgeWrite({ id: id(), expectedRevision: 0, kind: 'protocol', title: 'Review', body: 'Review every write.',
    constraints: { requireReviewAfterWrites: ['reviewer'], requiredAcceptanceLabels: ['Tests passed'] } }, limits)
  const proposed = await h.store.write(h.workspace, input)
  await expect(h.store.pin(h.workspace, [{ id: proposed.id, revision: 1 }])).rejects.toMatchObject({ status: 409 })
  const adopted = await h.store.transition(h.workspace, proposed.id, { expectedRevision: 1, state: 'adopted' })
  const pinned = await h.store.pin(h.workspace, [{ id: proposed.id, revision: 2 }])
  expect(pinned).toEqual([adopted])
  const edited = await h.store.write(h.workspace, { ...input, expectedRevision: 2, body: 'Review new checks.' })
  expect(edited).toMatchObject({ revision: 3, state: 'proposed' })
  await expect(h.store.pin(h.workspace, [{ id: proposed.id, revision: 2 }])).rejects.toMatchObject({ status: 409 })
  await h.store.transition(h.workspace, proposed.id, { expectedRevision: 3, state: 'adopted' })
  const retired = await h.store.transition(h.workspace, proposed.id, { expectedRevision: 4, state: 'retired' })
  await expect(h.store.pin(h.workspace, [{ id: proposed.id, revision: 5 }])).rejects.toMatchObject({ status: 409 })
  await expect(h.store.transition(h.workspace, proposed.id, { expectedRevision: 5, state: 'adopted' })).rejects.toMatchObject({ status: 409 })
  expect(await h.store.transition(h.workspace, proposed.id, { expectedRevision: 5, state: 'retired' })).toEqual(retired)
  expect(pinned).toEqual([adopted])
})

it('lets only one competing writer publish the next revision from the same base', async () => {
  const h = await fixture(), first = await h.store.write(h.workspace, content())
  const competitor = new KnowledgeStore(h.state, limits)
  const results = await Promise.allSettled([
    h.store.write(h.workspace, content(first.id, 1, 'First writer')),
    competitor.write(h.workspace, content(first.id, 1, 'Second writer')),
  ])
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  const failed = results.find(result => result.status === 'rejected')
  expect(failed).toMatchObject({ status: 'rejected', reason: { status: 409, code: 'knowledge-conflict' } })
  expect(await h.store.read(h.workspace, first.id, 1)).toEqual(first)
  expect((await readdir(await recordDirectory(h.state, first.id))).sort()).toEqual(['1.json', '2.json'])
})

it('keeps stable creation IDs and rejects kind changes or stale supervisor decisions', async () => {
  const h = await fixture(), input = content(), first = await h.store.write(h.workspace, input)
  await expect(h.store.write(h.workspace, input)).rejects.toMatchObject({ status: 409 })
  await expect(h.store.write(h.workspace, resolveKnowledgeWrite({ ...input, expectedRevision: 1, kind: 'protocol' }, limits)))
    .rejects.toMatchObject({ status: 409 })
  await expect(h.store.transition(h.workspace, first.id, { expectedRevision: 1, state: 'adopted' })).rejects.toMatchObject({ status: 400 })
  await expect(h.store.write(h.workspace, content(id(), 1))).rejects.toMatchObject({ status: 409 })
})

it('rejects inconsistent predecessor metadata in an independently persisted run snapshot', async () => {
  const h = await fixture(), first = await h.store.write(h.workspace, content())
  expect(knowledgeRevisionSchema.safeParse({ ...first, revision: 2, previousRevision: null }).success).toBe(false)
  expect(knowledgeRevisionSchema.safeParse({ ...first, revision: 1, previousRevision: 1 }).success).toBe(false)
})

it('shares a workspace alias while keeping other workspaces and API state roots separate', async () => {
  const h = await fixture(), first = await h.store.write(h.workspace, content())
  const alias = path.join(h.root, 'alias'), other = path.join(h.root, 'other'), otherState = path.join(h.root, 'other-state')
  await mkdir(other)
  await mkdir(otherState)
  await symlink(h.workspace, alias, process.platform === 'win32' ? 'junction' : 'dir')
  try {
    expect(await h.store.read(alias, first.id)).toEqual(first)
    expect(await h.store.read(other, first.id)).toBeNull()
    expect(await new KnowledgeStore(otherState, limits).read(h.workspace, first.id)).toBeNull()
    await expect(h.store.pin(other, [{ id: first.id, revision: 1 }])).rejects.toMatchObject({ status: 404 })
  } finally { await unlink(alias) }
})

it('pins complete lesson evidence without claiming that the lesson has been validated or applied', async () => {
  const h = await fixture()
  const lesson = await h.store.write(h.workspace, resolveKnowledgeWrite({ id: id(), expectedRevision: 0,
    kind: 'lesson', title: 'Observed failure', body: 'A hypothesis to verify next time.',
    evidence: [{ operationId: randomUUID(), stepId: 'verify' }] }, limits))
  expect(await h.store.pin(h.workspace, [{ id: lesson.id, revision: 1 }])).toEqual([lesson])
  expect(lesson).not.toHaveProperty('applied')
  expect(lesson).not.toHaveProperty('approvedBy')
})

it('ignores incomplete staging files but rejects corrupt or missing committed history', async () => {
  const h = await fixture(), first = await h.store.write(h.workspace, content())
  const directory = await recordDirectory(h.state, first.id)
  const staged = path.join(directory, `.2.${randomUUID()}.tmp`)
  await writeFile(staged, '{')
  expect(await h.store.read(h.workspace, first.id)).toEqual(first)
  await writeFile(path.join(directory, '3.json'), JSON.stringify({ ...first, revision: 3, previousRevision: 2 }))
  await expect(h.store.read(h.workspace, first.id)).rejects.toMatchObject({ status: 503 })
  await unlink(path.join(directory, '3.json'))
  await writeFile(path.join(directory, '2.json'), '{')
  await expect(h.store.list(h.workspace)).rejects.toMatchObject({ status: 503 })
  expect(await readFile(staged, 'utf8')).toBe('{')
})

it('enforces byte and reference budgets without making retained history unreadable after limits decrease', async () => {
  const h = await fixture(), first = await h.store.write(h.workspace, content())
  const narrow = new KnowledgeStore(h.state, { ...limits, maxRecords: 1, maxBodyBytes: 1, maxReferences: 1, maxSnapshotBytes: 64 })
  expect(await narrow.read(h.workspace, first.id)).toEqual(first)
  await expect(narrow.write(h.workspace, content())).rejects.toMatchObject({ status: 413 })
  await expect(narrow.write(h.workspace, content(first.id, 1))).rejects.toMatchObject({ status: 413 })
  await expect(narrow.pin(h.workspace, [{ id: first.id, revision: 1 }])).rejects.toMatchObject({ status: 413 })
  await expect(h.store.pin(h.workspace, [{ id: first.id, revision: 1 }, { id: first.id, revision: 1 }]))
    .rejects.toMatchObject({ status: 400 })
  expect(() => resolveKnowledgeWrite({ ...content(), body: '界'.repeat(400) }, limits)).toThrow(/byte limit/u)
})

it.each([
  { expectedRevision: 0, kind: 'protocol', constraints: { requiredAcceptanceLabels: ['checked'] } },
  { expectedRevision: 0, kind: 'protocol', constraints: { requireReviewAfterWrites: ['reviewer', 'reviewer'] } },
  { expectedRevision: 0, kind: 'lesson', evidence: [] },
  { kind: 'document' },
  { expectedRevision: -1, kind: 'document' },
  { expectedRevision: 0, kind: 'document', script: 'unrecognized executable field' },
])('rejects invalid wire mutation %j', (fields) => {
  expect(() => resolveKnowledgeWrite({ id: id(), title: 'Title', body: 'Body', ...fields }, limits)).toThrow()
})

it('validates lifecycle wire fields and refuses linked collection parents before writing', async () => {
  expect(() => resolveKnowledgeTransition({ expectedRevision: 1, state: 'proposed' })).toThrow()
  expect(resolveKnowledgeTransition({ expectedRevision: 1, state: 'adopted' })).toEqual({ expectedRevision: 1, state: 'adopted' })
  const h = await fixture(), outside = path.join(h.root, 'outside'), linked = path.join(h.state, 'knowledge')
  await mkdir(outside)
  await symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir')
  try {
    await expect(h.store.write(h.workspace, content())).rejects.toMatchObject({ status: 503 })
    expect(await readdir(outside)).toEqual([])
  } finally { await unlink(linked) }
})

it('reports filesystem write failure as unavailable knowledge while preserving the admitted snapshot', async () => {
  const h = await fixture(), first = await h.store.write(h.workspace, content())
  const pinned = await h.store.pin(h.workspace, [{ id: first.id, revision: first.revision }])
  const directory = path.join(h.state, 'knowledge')
  const failure = Object.assign(new Error('device has no space'), { code: 'ENOSPC' })
  faults.set(directory, failure)
  onTestFinished(() => { faults.delete(directory) })
  await expect(h.store.write(h.workspace, content(first.id, 1, 'Unpublished change')))
    .rejects.toMatchObject({ status: 503, code: 'knowledge-state', cause: failure })
  expect(pinned).toEqual([first])
  expect(await h.store.read(h.workspace, first.id)).toEqual(first)
})
