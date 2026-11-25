/** Durable HTTP identity and directory ownership survive restarts without restarting workers. */
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { Config } from '../src/api.ts'
import { ApiOperationStore, apiHash } from '../src/api-store.ts'
import { API_RECOVERY_FENCE_FILE, resolveApiRun, type OperationId } from '../src/api-types.ts'
import type { ProcessIdentity } from '../src/process-identity.ts'
import { replaceRecoveryIssues } from '../src/recovery-issues.ts'

const ownerFaults = vi.hoisted(() => new Map<string, (handle: FileHandle) => void>())
const OWNER_START = '2026-01-01T00:00:00.000Z'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args)
    if (typeof args[0] === 'string' && path.basename(args[0]).startsWith('.api-owner-')) ownerFaults.get(path.dirname(args[0]))?.(handle)
    return handle
  } }
})

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'deepcluster-api-store-'))
  const config = Config({ stateDirectory: path.join(root, 'state'), leaseRoot: path.join(root, '.deep-cluster', 'service-state') })
  const stores: ApiOperationStore[] = []
  onTestFinished(async () => {
    try { for (const store of stores) await store.dispose() } finally { await rm(root, { recursive: true, force: true }) }
  })
  const liveIdentity = async (pid: number): Promise<ProcessIdentity> => ({ pid, startTime: OWNER_START, commandLine: 'fixture api' })
  const create = (inspectOwner: (pid: number) => Promise<ProcessIdentity | null> = liveIdentity, recoverWorkers = false) => {
    const store = new ApiOperationStore(config, inspectOwner, recoverWorkers)
    stores.push(store)
    return store
  }
  return { root, config, create, input: resolveApiRun({ workspace: root, plans: ['test plan'] }, config) }
}

it('lets exactly one simultaneous API instance own an empty state directory', async () => {
  const h = await fixture(), first = h.create(), second = h.create()
  const attempts = await Promise.allSettled([first.initialize(), second.initialize()])
  expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  const rejected = attempts.find(result => result.status === 'rejected')
  if (rejected?.status !== 'rejected') throw new Error('A second owner was admitted')
  const reason: unknown = rejected.reason
  expect(reason).toBeInstanceOf(Error)
  expect(String(reason)).toContain('already owned')
  expect(JSON.parse(await readFile(path.join(h.config.stateDirectory, 'api-owner.lock'), 'utf8')))
    .toMatchObject({ recovery: { version: 1, leaseRoot: h.config.leaseRoot }, startTime: OWNER_START })
})

it.each(['write', 'sync', 'close'] as const)('never publishes its startup lock when owner metadata %s fails and permits a new owner', async (stage) => {
  const h = await fixture(), lockFile = path.join(h.config.stateDirectory, 'api-owner.lock')
  const failure = Object.assign(new Error(`owner ${stage} failed`), { code: 'ENOSPC' })
  const handles: FileHandle[] = []
  ownerFaults.set(h.config.stateDirectory, (handle) => {
    handles.push(handle)
    if (stage === 'write') vi.spyOn(handle, 'writeFile').mockRejectedValueOnce(failure)
    else if (stage === 'sync') vi.spyOn(handle, 'sync').mockRejectedValueOnce(failure)
    else {
      const close = handle.close.bind(handle)
      vi.spyOn(handle, 'close').mockImplementationOnce(async () => { await close(); throw failure })
    }
  })
  onTestFinished(() => { ownerFaults.delete(h.config.stateDirectory) })
  await expect(h.create().initialize()).rejects.toBe(failure)
  expect(handles).toHaveLength(1)
  expect(handles[0]?.fd).toBe(-1)
  await expect(readFile(lockFile)).rejects.toMatchObject({ code: 'ENOENT' })
  ownerFaults.delete(h.config.stateDirectory)
  await expect(h.create().initialize()).resolves.toBeUndefined()
})

it('preserves a competing lock when unpublished startup metadata fails', async () => {
  const h = await fixture(), lockFile = path.join(h.config.stateDirectory, 'api-owner.lock')
  const foreign = JSON.stringify({ owner: 'another-owner', pid: process.pid })
  ownerFaults.set(h.config.stateDirectory, (handle) => {
    vi.spyOn(handle, 'writeFile').mockImplementationOnce(async () => {
      await writeFile(lockFile, foreign)
      throw new Error('owner write failed after replacement')
    })
  })
  onTestFinished(() => { ownerFaults.delete(h.config.stateDirectory) })
  const store = new ApiOperationStore(h.config)
  await expect(store.initialize()).rejects.toThrow('owner write failed after replacement')
  expect(await readFile(lockFile, 'utf8')).toBe(foreign)
})

it('requires exact API identity before advertising a recoverable generation', async () => {
  const h = await fixture()
  await expect(h.create(async () => null, true).initialize()).rejects.toThrow(/start identity/u)
  await expect(readFile(path.join(h.config.stateDirectory, 'api-owner.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  const store = h.create(undefined, true)
  await store.initialize()
  const generation = store.workerRecovery?.generation
  expect(generation).toBeDefined()
  expect(JSON.parse(await readFile(path.join(h.config.stateDirectory, 'api-owner.lock'), 'utf8')))
    .toMatchObject({ workers: { version: 1, generation }, startTime: OWNER_START })
  expect(JSON.parse(await readFile(path.join(h.config.stateDirectory, 'worker-ranges', generation ?? '', 'manifest.json'), 'utf8')))
    .toMatchObject({ generation, owner: { pid: process.pid, startTime: OWNER_START, leaseRoot: h.config.leaseRoot } })
})

it('refuses admission while an explicit recovery fence exists and releases only its own lock', async () => {
  const h = await fixture(), lockFile = path.join(h.config.stateDirectory, 'api-owner.lock')
  await mkdir(h.config.stateDirectory, { recursive: true })
  await writeFile(path.join(h.config.stateDirectory, API_RECOVERY_FENCE_FILE), '{}', 'utf8')
  await expect(h.create().initialize()).rejects.toThrow(/recovery fence/u)
  await expect(readFile(lockFile)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('loads completed idempotency records and never executes an interrupted record on recovery', async () => {
  const h = await fixture(), first = h.create()
  await first.initialize()
  const completed = (await first.accept('completed', h.input)).record
  completed.status = 'completed'; await first.save(completed)
  const unfinished = (await first.accept('unfinished', h.input)).record
  expect(unfinished.ownerStartTime).toBe(OWNER_START)
  await first.dispose()
  const next = h.create(async () => null); await next.initialize()
  expect(await next.accept('completed', h.input)).toMatchObject({ fresh: false, record: { operationId: completed.operationId, status: 'completed' } })
  expect(await next.accept('unfinished', h.input)).toMatchObject({ fresh: false, record: { operationId: unfinished.operationId, status: 'interrupted' } })
  const saved = await readFile(path.join(h.config.stateDirectory, 'operations', `${apiHash('unfinished')}.json`), 'utf8')
  expect(saved).toContain('interrupted')
  expect(saved).toContain('not restarted')
})

it('treats a reused PID with a different process start as an interrupted owner', async () => {
  const h = await fixture(), first = h.create()
  await first.initialize()
  const unfinished = (await first.accept('reused', h.input)).record
  await first.dispose()
  const next = h.create(async pid => ({ pid, startTime: '2026-01-02T00:00:00.000Z', commandLine: 'another process' }))
  await next.initialize()
  expect(await next.accept('reused', h.input)).toMatchObject({ fresh: false, record: { operationId: unfinished.operationId, status: 'interrupted' } })
})

it('refuses an active record whose recorded process start still matches', async () => {
  const h = await fixture(), first = h.create()
  await first.initialize()
  await first.accept('live-owner', h.input)
  await first.dispose()
  await expect(h.create().initialize()).rejects.toThrow(/belongs to a live process/u)
})

it('loads a historical record without progress or owner start time', async () => {
  const h = await fixture(), directory = path.join(h.config.stateDirectory, 'operations')
  await mkdir(directory, { recursive: true })
  const operationId = '33333333-3333-4333-8333-333333333333'
  const keyHash = apiHash('legacy-key')
  const record = { version: 1, operationId, keyHash, requestHash: apiHash('legacy-request'),
    workspace: h.root, ownerPid: process.pid, status: 'completed', runId: null,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', result: null, error: null }
  await writeFile(path.join(directory, `${keyHash}.json`), JSON.stringify(record), 'utf8')
  const store = h.create(async () => null)
  await store.initialize()
  expect(store.operations.get(operationId as OperationId)).toMatchObject({ progress: null, status: 'completed' })
})

it('preserves corrupt durable records while reserving their key and admitting unrelated requests', async () => {
  const h = await fixture(), directory = path.join(h.config.stateDirectory, 'operations')
  await mkdir(directory, { recursive: true })
  const keyHash = apiHash('damaged'), file = path.join(directory, `${keyHash}.json`)
  await writeFile(file, '{ broken')
  const store = h.create()
  await store.initialize()
  expect(await readFile(file, 'utf8')).toBe('{ broken')
  expect(store.blockedKeyHashes.has(keyHash)).toBe(true)
  expect(store.recoveryIssues).toEqual([expect.objectContaining({ kind: 'operation-record', id: `${keyHash}.json` })])
  await expect(store.accept('damaged', h.input)).rejects.toMatchObject({ status: 503 })
  expect(await store.accept('unrelated', h.input)).toMatchObject({ fresh: true })
  expect(await readFile(file, 'utf8')).toBe('{ broken')
})

it('stops all later operations when a committed metadata replacement fails', async () => {
  const h = await fixture(), store = h.create()
  await store.initialize()
  const record = (await store.accept('write-failure', h.input)).record
  const file = path.join(h.config.stateDirectory, 'operations', `${record.keyHash}.json`)
  await unlink(file); await mkdir(file)
  record.status = 'completed'
  await expect(store.serialize(async () => { await store.save(record) })).rejects.toThrow()
  await expect(store.accept('another', h.input)).rejects.toMatchObject({ code: 'state-unavailable', status: 503 })
  await expect(store.serialize(() => record)).rejects.toMatchObject({ code: 'state-unavailable', status: 503 })
})

it('loads unscoped recovery diagnostics while refusing new work without losing retained lookups', async () => {
  const h = await fixture(), first = h.create()
  await first.initialize()
  const previous = (await first.accept('existing', h.input)).record
  previous.status = 'completed'
  await first.save(previous)
  await first.dispose()
  await replaceRecoveryIssues(h.config.stateDirectory, 'worker-generation', [{ kind: 'worker-generation',
    id: 'unknown-registry', message: 'Worker ownership namespace is unavailable', observedAt: OWNER_START, blocksAdmission: true }])
  const next = h.create()
  await next.initialize()
  expect(next.recoveryIssues[0]?.blocksAdmission).toBe(true)
  expect(await next.accept('existing', h.input)).toMatchObject({ fresh: false })
  await expect(next.accept('new', h.input)).rejects.toMatchObject({ code: 'recovery-admission-blocked', status: 503 })
})
