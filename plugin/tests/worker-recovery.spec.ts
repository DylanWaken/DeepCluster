/** Worker receipt completeness and exact-generation resource recovery. */
import { randomUUID } from 'node:crypto'
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseSubprocessRangeReceipt } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessRangeReceipt } from '@deepseek-ai/dsh-subprocess'
import { expect, it, onTestFinished } from 'vitest'
import { acquireWriteClaims, listWriteClaims, renewWriteClaims } from '../src/claims.ts'
import { acquireLease, leaseStatus, renewLease } from '../src/lease.ts'
import { normalizeClaimPath } from '../src/scope.ts'
import { WorkerRecoveryStateError, WorkerRecoveryStore, parseOwnershipGeneration,
  quarantineRecoveredOwnership, recoverOrphanWorkerGenerations, recoverWorkerGeneration,
  settleRebootedWorkerGeneration, workerGenerationSettled } from '../src/worker-recovery.ts'

async function fixture(owned = false): Promise<{ root: string; store: WorkerRecoveryStore; directory: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'deepcluster-worker-recovery-'))
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
  const store = await WorkerRecoveryStore.create(root, parseOwnershipGeneration(randomUUID()),
    owned ? { pid: process.pid, startTime: '2026-10-27T01:00:00.000Z', leaseRoot: root } : undefined)
  return { root, store, directory: path.join(root, 'worker-ranges', store.generation) }
}

function receipt(): SubprocessRangeReceipt {
  return parseSubprocessRangeReceipt({ kind: 'windows-job', jobName: `Global\\dsh-subprocess-${randomUUID()}` })
}

it('publishes a manifest before accepting receipts and retains them after sequential recovery', async () => {
  const h = await fixture()
  expect(JSON.parse(await readFile(path.join(h.directory, 'manifest.json'), 'utf8')))
    .toEqual({ version: 1, generation: h.store.generation, receiptFormat: 'windows-job-id' })
  const first = receipt()
  const second = receipt()
  await Promise.all([h.store.persist(first), h.store.persist(second)])
  const before = (await readdir(h.directory)).sort()
  expect(before).toHaveLength(3)
  expect(before.some(name => name.endsWith('.tmp'))).toBe(false)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const calls: SubprocessRangeReceipt[] = []
  const recovery = recoverWorkerGeneration(h.root, h.store.generation, async (range) => {
    calls.push(range)
    if (calls.length === 1) { entered.resolve(undefined); await release.promise }
  })
  try {
    await entered.promise
    expect(calls).toHaveLength(1)
  } finally {
    release.resolve(undefined)
  }
  expect(await recovery).toEqual({ generation: h.store.generation, receiptCount: 2 })
  expect(calls).toEqual(expect.arrayContaining([first, second]))
  expect((await readdir(h.directory)).sort()).toEqual(before)
})

it('recovers a complete unpublished receipt left before the target-start acknowledgement', async () => {
  const h = await fixture()
  const range = receipt()
  const id = range.jobName.slice('Global\\dsh-subprocess-'.length)
  await writeFile(path.join(h.directory, `${id}.json.tmp`), JSON.stringify({ version: 1, generation: h.store.generation, id, range }))
  const recovered: SubprocessRangeReceipt[] = []
  expect(await recoverWorkerGeneration(h.root, h.store.generation, async (item) => { recovered.push(item) }))
    .toEqual({ generation: h.store.generation, receiptCount: 1 })
  expect(recovered).toEqual([range])
})

it('terminates the exact Job identified by a partially written staging filename', async () => {
  const h = await fixture()
  const range = receipt()
  const id = range.jobName.slice('Global\\dsh-subprocess-'.length)
  await writeFile(path.join(h.directory, `${id}.json.tmp`), '{"version":')
  const recovered: SubprocessRangeReceipt[] = []
  await recoverWorkerGeneration(h.root, h.store.generation, async (item) => { recovered.push(item) })
  expect(recovered).toEqual([range])
})

it('accepts agreeing manifest links left after publication and rejects conflicting copies', async () => {
  const h = await fixture()
  const staged = path.join(h.directory, 'manifest.json.tmp')
  await link(path.join(h.directory, 'manifest.json'), staged)
  await expect(recoverWorkerGeneration(h.root, h.store.generation, async () => {}))
    .resolves.toEqual({ generation: h.store.generation, receiptCount: 0 })
  await rm(staged)
  await writeFile(staged, JSON.stringify({ version: 1, generation: randomUUID(), receiptFormat: 'windows-job-id' }))
  await expect(recoverWorkerGeneration(h.root, h.store.generation, async () => {})).rejects.toBeInstanceOf(WorkerRecoveryStateError)
})

it.each(['broken-json', 'different-generation', 'unknown-entry', 'missing-manifest'] as const)(
  'retains ownership without terminating any range when preflight finds %s', async (failure) => {
    const h = await fixture()
    await h.store.persist(receipt())
    if (failure === 'missing-manifest') await rm(path.join(h.directory, 'manifest.json'))
    else {
      const id = randomUUID()
      const value = failure === 'broken-json' ? '{' : JSON.stringify({ version: 1,
        generation: failure === 'different-generation' ? randomUUID() : h.store.generation, id, range: receipt() })
      await writeFile(path.join(h.directory, failure === 'unknown-entry' ? 'unknown.json' : `${id}.json`), value)
    }
    let called = false
    await expect(recoverWorkerGeneration(h.root, h.store.generation, async () => { called = true })).rejects.toThrow()
    expect(called).toBe(false)
  },
)

it('propagates range-termination failure and leaves the complete receipt history', async () => {
  const h = await fixture()
  await h.store.persist(receipt())
  const failure = new Error('range still has a live descendant')
  await expect(recoverWorkerGeneration(h.root, h.store.generation, async () => { throw failure })).rejects.toBe(failure)
  expect(await readdir(h.directory)).toHaveLength(2)
})

it('does not authorize resource release if admission adds a receipt during recovery', async () => {
  const h = await fixture()
  await h.store.persist(receipt())
  await expect(recoverWorkerGeneration(h.root, h.store.generation, async () => { await h.store.persist(receipt()) }))
    .rejects.toBeInstanceOf(WorkerRecoveryStateError)
})

it('honors cancellation before returning recovery evidence', async () => {
  const h = await fixture()
  await h.store.persist(receipt())
  const controller = new AbortController()
  const failure = new Error('cancelled recovery')
  await expect(recoverWorkerGeneration(h.root, h.store.generation, async (_range, signal) => {
    expect(signal).toBe(controller.signal)
    controller.abort(failure)
  }, controller.signal)).rejects.toBe(failure)
})

it('quarantines only matching leases, claims and waiter tickets after range recovery', async () => {
  const h = await fixture()
  const namespace = path.join(h.root, 'registry')
  const lease = await acquireLease(namespace, 'gpu0', { owner: 'api', ownershipGeneration: h.store.generation, waitMs: 0 })
  expect((await renewLease(namespace, lease)).ownershipGeneration).toBe(h.store.generation)
  await acquireLease(namespace, 'legacy', { owner: 'legacy', waitMs: 0 })
  const otherGeneration = parseOwnershipGeneration(randomUUID())
  await acquireLease(namespace, 'other', { owner: 'other', ownershipGeneration: otherGeneration, waitMs: 0 })
  const claims = await acquireWriteClaims(namespace, { owner: 'api', ownershipGeneration: h.store.generation, waitMs: 0,
    requests: [{ root: h.root, scope: h.root, kind: 'path', path: normalizeClaimPath('result.txt') }] })
  expect((await renewWriteClaims(namespace, claims, 60_000)).records[0]?.ownershipGeneration).toBe(h.store.generation)
  const ticket = `gpu0.ticket-000000000000001-p${String(process.pid)}-${randomUUID()}`
  await writeFile(path.join(namespace, 'leases', ticket), JSON.stringify({ owner: 'api', pid: process.pid, ownershipGeneration: h.store.generation }))
  await writeFile(path.join(namespace, 'leases', 'malformed.lock'), JSON.stringify({ ownershipGeneration: h.store.generation }))
  await mkdir(path.join(namespace, 'claims', 'mutex'))
  await writeFile(path.join(namespace, 'claims', 'mutex', 'owner.json'), JSON.stringify({ pid: process.pid, token: 'legacy' }))
  await h.store.persist(receipt())
  let rangeStopped = false
  const proof = await recoverWorkerGeneration(h.root, h.store.generation, async () => { rangeStopped = true })
  expect(rangeStopped).toBe(true)
  const result = await quarantineRecoveredOwnership(namespace, proof)
  expect([...result.moved].sort())
    .toEqual([path.join('leases', 'gpu0.lock'), path.join('leases', ticket), path.join('claims', claims.records[0]?.id ?? '')].sort())
  expect((await leaseStatus(namespace, 'gpu0')).held).toBeUndefined()
  expect((await leaseStatus(namespace, 'legacy')).held?.owner).toBe('legacy')
  expect((await leaseStatus(namespace, 'other')).held?.ownershipGeneration).toBe(otherGeneration)
  expect(await listWriteClaims(namespace)).toEqual([])
  expect(await readFile(path.join(namespace, 'leases', 'malformed.lock'), 'utf8')).toContain(h.store.generation)
  expect(await readFile(path.join(namespace, 'claims', 'mutex', 'owner.json'), 'utf8')).toContain('legacy')
  expect(await readFile(path.join(result.quarantineDirectory ?? '', 'leases', 'gpu0.lock'), 'utf8')).toContain(lease.token)
  expect(await quarantineRecoveredOwnership(namespace, proof)).toEqual({ quarantineDirectory: null, moved: [] })
})

it('keeps dead-PID generation waiter tickets until their worker receipts are recovered', async () => {
  const h = await fixture()
  const namespace = path.join(h.root, 'registry')
  await mkdir(path.join(namespace, 'leases'), { recursive: true })
  const ticket = `gpu0.ticket-000000000000001-p2147483647-${randomUUID()}`
  await writeFile(path.join(namespace, 'leases', ticket), JSON.stringify({ owner: 'api', pid: 2_147_483_647, ownershipGeneration: h.store.generation }))
  expect((await leaseStatus(namespace, 'gpu0')).waiting).toBe(1)
  const proof = await recoverWorkerGeneration(h.root, h.store.generation, async () => {})
  expect((await quarantineRecoveredOwnership(namespace, proof)).moved).toEqual([path.join('leases', ticket)])
})

it('rejects path fragments and noncanonical generation identities', () => {
  for (const value of ['../outside', randomUUID().toUpperCase(), '', null]) expect(() => parseOwnershipGeneration(value)).toThrow(WorkerRecoveryStateError)
})

it('quarantines interrupted generation-tagged publication files and their linked live record together', async () => {
  const h = await fixture()
  const leases = path.join(h.root, 'leases')
  const held = await acquireLease(h.root, 'gpu0', { owner: 'api', ownershipGeneration: h.store.generation })
  const temporary = `gpu0.lock.generation-${h.store.generation}.${randomUUID()}.tmp`
  await link(path.join(leases, 'gpu0.lock'), path.join(leases, temporary))
  const ticket = `gpu0.ticket-000000000000001-p${String(process.pid)}-${randomUUID()}.generation-${h.store.generation}.${randomUUID()}.tmp`
  await writeFile(path.join(leases, ticket), '{')
  const other = `gpu1.lock.generation-${randomUUID()}.${randomUUID()}.tmp`
  await writeFile(path.join(leases, other), '{')
  const proof = await recoverWorkerGeneration(h.root, h.store.generation, async () => {})
  const result = await quarantineRecoveredOwnership(h.root, proof)
  expect([...result.moved].sort()).toEqual(['gpu0.lock', temporary, ticket].map(file => path.join('leases', file)).sort())
  expect(await readFile(path.join(result.quarantineDirectory ?? '', 'leases', 'gpu0.lock'), 'utf8')).toContain(held.token)
  expect(await readFile(path.join(leases, other), 'utf8')).toBe('{')
})

it('recovers orphan resources only after their exact API generation owner stopped', async () => {
  const h = await fixture(true)
  await acquireLease(h.root, 'gpu0', { owner: 'api', ownershipGeneration: h.store.generation })
  const range = receipt()
  await h.store.persist(range)
  const recovered: SubprocessRangeReceipt[] = []
  const terminate = async (item: SubprocessRangeReceipt): Promise<void> => { recovered.push(item) }
  expect(await recoverOrphanWorkerGenerations(h.root, h.root, terminate,
    async pid => ({ pid, startTime: '2026-10-27T01:00:00.000Z', commandLine: 'live owner' }))).toEqual({ recovered: [], issues: [] })
  expect(recovered).toEqual([])
  expect((await leaseStatus(h.root, 'gpu0')).held).toBeDefined()
  const results = await recoverOrphanWorkerGenerations(h.root, h.root, terminate, async () => null)
  expect(recovered).toEqual([range])
  expect(results.recovered[0]?.moved).toEqual([path.join('leases', 'gpu0.lock')])
  expect(results.issues).toEqual([])
})

it('preserves incomplete non-admitted generation directories without blocking startup', async () => {
  const h = await fixture(true)
  const directory = path.join(h.root, 'worker-ranges', randomUUID())
  await mkdir(directory)
  await writeFile(path.join(directory, 'manifest.json.tmp'), '{')
  await recoverOrphanWorkerGenerations(h.root, h.root, async () => {}, async () => null)
  expect(await readFile(path.join(directory, 'manifest.json.tmp'), 'utf8')).toBe('{')
  await writeFile(path.join(directory, `${randomUUID()}.json`), '{}')
  expect((await recoverOrphanWorkerGenerations(h.root, h.root, async () => {}, async () => null)).issues)
    .toEqual([expect.objectContaining({ kind: 'worker-generation', id: path.basename(directory) })])
})

it('isolates a failed generation while recovering another and preserving failed resource reservations', async () => {
  const h = await fixture(true)
  const second = await WorkerRecoveryStore.create(h.root, parseOwnershipGeneration(randomUUID()),
    { pid: process.pid, startTime: '2026-10-27T01:00:00.000Z', leaseRoot: h.root })
  const failedRange = receipt(), goodRange = receipt()
  await h.store.persist(failedRange)
  await second.persist(goodRange)
  await acquireLease(h.root, 'gpu0', { owner: 'failed', ownershipGeneration: h.store.generation })
  await acquireLease(h.root, 'gpu1', { owner: 'good', ownershipGeneration: second.generation })
  const report = await recoverOrphanWorkerGenerations(h.root, h.root, async (range) => {
    if (range.jobName === failedRange.jobName) throw new Error('native range still active')
  }, async () => null)
  expect(report.issues).toEqual([expect.objectContaining({ id: h.store.generation, message: 'native range still active' })])
  expect((await leaseStatus(h.root, 'gpu0')).held?.owner).toBe('failed')
  expect((await leaseStatus(h.root, 'gpu1')).held).toBeUndefined()
})

it('uses reboot evidence before reading damaged receipts and preserves matching live owners', async () => {
  const h = await fixture(true)
  await acquireLease(h.root, 'gpu0', { owner: 'old', ownershipGeneration: h.store.generation })
  await writeFile(path.join(h.directory, `${randomUUID()}.json`), '{')
  const boot = { startedAt: '2026-10-28T01:00:00.000Z', observedAt: '2026-10-28T02:00:00.000Z' }
  const noNative = async (): Promise<void> => { throw new Error('old native receipts must not be opened') }
  const live = await recoverOrphanWorkerGenerations(h.root, h.root, noNative,
    async pid => ({ pid, startTime: '2026-10-27T01:00:00.000Z', commandLine: 'live' }), undefined, boot)
  expect(live.recovered).toEqual([])
  expect((await leaseStatus(h.root, 'gpu0')).held).toBeDefined()
  const dead = await recoverOrphanWorkerGenerations(h.root, h.root, noNative, async () => null, undefined, boot)
  expect(dead.issues).toEqual([])
  expect((await leaseStatus(h.root, 'gpu0')).held).toBeUndefined()
})

it('does not re-open native Jobs for unchanged settled history and rejects a changed receipt set', async () => {
  const h = await fixture()
  expect(await workerGenerationSettled(h.root, h.store.generation)).toBe(false)
  await h.store.persist(receipt())
  expect(await workerGenerationSettled(h.root, h.store.generation)).toBe(false)
  await recoverWorkerGeneration(h.root, h.store.generation, async () => {})
  expect(await workerGenerationSettled(h.root, h.store.generation)).toBe(true)
  await expect(recoverWorkerGeneration(h.root, h.store.generation, async () => { throw new Error('already settled') }))
    .resolves.toEqual({ generation: h.store.generation, receiptCount: 1 })
  await h.store.persist(receipt())
  expect(await workerGenerationSettled(h.root, h.store.generation)).toBe(false)
  await expect(recoverWorkerGeneration(h.root, h.store.generation, async () => {})).rejects.toThrow('evidence changed')
})

it('binds reboot settlement to preserved damaged receipt bytes without requiring native Jobs', async () => {
  const h = await fixture(true), manifest = path.join(h.directory, 'manifest.json')
  await writeFile(manifest, '{')
  await acquireLease(h.root, 'gpu0', { owner: 'old', ownershipGeneration: h.store.generation })
  const boot = { startedAt: '2026-10-28T01:00:00.000Z', observedAt: '2026-10-28T02:00:00.000Z' }
  await expect(settleRebootedWorkerGeneration(h.root, h.store.generation, '2026-10-28T02:00:00.000Z', boot)).rejects.toThrow('does not predate')
  await settleRebootedWorkerGeneration(h.root, h.store.generation, '2026-10-27T01:00:00.000Z', boot)
  expect(await workerGenerationSettled(h.root, h.store.generation)).toBe(true)
  const report = await recoverOrphanWorkerGenerations(h.root, h.root, async () => { throw new Error('No native recovery after reboot') }, async () => null)
  expect(report.issues).toEqual([])
  expect((await leaseStatus(h.root, 'gpu0')).held).toBeUndefined()
  await writeFile(path.join(h.root, 'worker-settled', `${h.store.generation}.json`), '{')
  expect(await workerGenerationSettled(h.root, h.store.generation)).toBe(false)
})

it('preserves ownership when the quarantine parent redirects outside its registry', async () => {
  const h = await fixture()
  const outside = path.join(h.root, 'outside')
  const registry = path.join(h.root, 'registry')
  await mkdir(outside)
  await acquireLease(registry, 'gpu0', { owner: 'api', ownershipGeneration: h.store.generation })
  await symlink(outside, path.join(registry, 'recovered'), process.platform === 'win32' ? 'junction' : 'dir')
  try {
    const proof = await recoverWorkerGeneration(h.root, h.store.generation, async () => {})
    await expect(quarantineRecoveredOwnership(registry, proof)).rejects.toBeInstanceOf(WorkerRecoveryStateError)
    expect((await leaseStatus(registry, 'gpu0')).held?.owner).toBe('api')
    expect(await readdir(outside)).toEqual([])
  } finally { await unlink(path.join(registry, 'recovered')) }
})
