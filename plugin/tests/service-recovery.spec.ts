/** Automatic recovery requires positive idle proof and preserves uncertain ownership. */
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { parseSubprocessRangeReceipt, type SubprocessRangeReceipt } from '@deepseek-ai/dsh-subprocess'
import { resolveOptions } from '../src/assets.ts'
import { diagnoseApiLock, prepareServiceOwnership, recoverApiLock, type ServiceLockDependencies } from '../src/service.ts'
import { parseOwnershipGeneration, WorkerRecoveryStore, workerGenerationSettled } from '../src/worker-recovery.ts'
import { masterDirectory } from '../src/master.ts'
import { API_RECOVERY_FENCE_FILE } from '../src/api-types.ts'
import { readRecoveryIssues } from '../src/recovery-issues.ts'

async function fixture(cleanupTimeoutMs?: number) {
  const root = await mkdtemp(path.join(tmpdir(), 'deepcluster-idle-recovery-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }), cleanupTimeoutMs)
  const stateDirectory = path.join(root, 'state'), leaseRoot = path.join(root, 'ownership')
  const operations = path.join(stateDirectory, 'operations'), lockFile = path.join(stateDirectory, 'api-owner.lock')
  await mkdir(operations, { recursive: true })
  await Promise.all(['leases', 'claims'].map(name => mkdir(path.join(leaseRoot, name), { recursive: true })))
  const owner = { pid: 4801, startTime: '2026-01-01T00:00:00.000Z', commandLine: 'node api.js' }
  const lock = { owner: 'idle-owner', pid: owner.pid, startTime: owner.startTime, recovery: { version: 1, leaseRoot } }
  await writeFile(lockFile, JSON.stringify(lock))
  const apiEndpoint = 'http://127.0.0.1:47890'
  const options = resolveOptions({ apiEndpoint })
  const dependencies: ServiceLockDependencies = { stateDirectory,
    readState: async () => ({ version: 1, api: owner, dashboard: null, loginUrlFile: null, updatedAt: owner.startTime }),
    inspectPort: async () => null, inspectProcess: async () => null, inspectBoot: async () => null,
    inspectController: async () => ({ pid: 4901, startTime: '2026-01-04T00:00:00.000Z', commandLine: 'fixture recovery controller' }) }
  const runId = randomUUID()
  const record = { version: 1, operationId: randomUUID(), keyHash: 'a'.repeat(64), requestHash: 'b'.repeat(64),
    workspace: root, ownerPid: owner.pid, ownerStartTime: owner.startTime, status: 'completed', runId,
    createdAt: owner.startTime, updatedAt: owner.startTime, progress: null, error: null,
    result: { runId, status: 'completed', journalFile: path.join(root, 'journal.jsonl'), steps: [], openImprovisations: [] } }
  const operationFile = path.join(operations, `${record.keyHash}.json`)
  return { root, stateDirectory, leaseRoot, operations, lockFile, owner, lock, apiEndpoint, options, dependencies, record, operationFile }
}

it.each([false, true])('automatically quarantines an idle new lock with completed history=%s', async (history) => {
  const h = await fixture()
  if (history) await writeFile(h.operationFile, JSON.stringify(h.record))
  expect(await diagnoseApiLock(h.options, h.dependencies)).toMatchObject({ verdict: 'stale', recoveryProof: 'machine-proven' })
  const result = await recoverApiLock(h.options, h.dependencies)
  expect(result.proof).toBe('machine-proven')
  expect(JSON.parse(await readFile(result.quarantineFile, 'utf8'))).toEqual(h.lock)
  await expect(readFile(h.lockFile)).rejects.toMatchObject({ code: 'ENOENT' })
  if (history) expect(JSON.parse(await readFile(h.operationFile, 'utf8'))).toEqual(h.record)
})

it.each(['accepted', 'running', 'cancelling', 'interrupted', 'failed', 'cancelled', 'needs-ack'])('preserves uncertain %s operation state', async (status) => {
  const h = await fixture()
  await writeFile(h.operationFile, JSON.stringify({ ...h.record, status,
    error: status === 'cancelled' ? { code: 'cleanup-unconfirmed', message: 'descendants may survive' } : null }))
  await expect(recoverApiLock(h.options, h.dependencies)).rejects.toThrow('Refusing automatic recovery')
  expect(JSON.parse(await readFile(h.lockFile, 'utf8'))).toEqual(h.lock)
})

it.each(['leases', 'claims'])('preserves retained %s ownership', async (directory) => {
  const h = await fixture()
  await writeFile(path.join(h.leaseRoot, directory, 'retained.lock'), '{}')
  await expect(recoverApiLock(h.options, h.dependencies)).rejects.toThrow('Refusing automatic recovery')
  expect(JSON.parse(await readFile(h.lockFile, 'utf8'))).toEqual(h.lock)
})

it.each(['failed', 'cancelled', 'needs-ack'])('recovers %s records only with explicit confirmed teardown', async (status) => {
  const h = await fixture()
  const record = { ...h.record, status, result: { ...h.record.result, status, cleanupConfirmed: true } }
  await writeFile(h.operationFile, JSON.stringify({ ...record, result: { ...h.record.result, status } }))
  await expect(recoverApiLock(h.options, h.dependencies)).rejects.toThrow('Refusing automatic recovery')
  await writeFile(h.operationFile, JSON.stringify(record))
  expect(await diagnoseApiLock(h.options, h.dependencies)).toMatchObject({ recoveryProof: 'machine-proven' })
  await writeFile(h.operationFile, JSON.stringify({ ...record, result: { ...record.result, cleanupConfirmed: false } }))
  await expect(recoverApiLock(h.options, h.dependencies)).rejects.toThrow('Refusing automatic recovery')
  await writeFile(h.operationFile, JSON.stringify({ ...record, error: { code: 'cleanup-unconfirmed', message: 'unknown' } }))
  await expect(recoverApiLock(h.options, h.dependencies)).rejects.toThrow('Refusing automatic recovery')
  await writeFile(h.operationFile, JSON.stringify(record))
  expect((await recoverApiLock(h.options, h.dependencies)).proof).toBe('machine-proven')
})

it.each(['missing', 'other-pid', 'other-start'] as const)('uses the API lock identity when controller state is %s', async (state) => {
  const h = await fixture()
  const api = state === 'missing' ? null : state === 'other-pid'
    ? { ...h.owner, pid: h.owner.pid + 1 } : { ...h.owner, startTime: '2026-01-02T00:00:00.000Z' }
  const dependencies: ServiceLockDependencies = { ...h.dependencies,
    readState: async () => ({ version: 1, api, dashboard: null, loginUrlFile: null, updatedAt: h.owner.startTime }) }
  const result = await recoverApiLock(h.options, dependencies)
  expect(result).toMatchObject({ proof: 'machine-proven', expectedOwner: {
    owner: h.lock.owner, pid: h.owner.pid, startTime: h.owner.startTime,
  } })
  expect(JSON.parse(await readFile(result.quarantineFile, 'utf8'))).toEqual(h.lock)
  await expect(readFile(h.lockFile)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('preserves a legacy lock without process creation time when controller state is missing', async () => {
  const h = await fixture(), legacy = { owner: h.lock.owner, pid: h.owner.pid, recovery: h.lock.recovery }
  await writeFile(h.lockFile, JSON.stringify(legacy))
  await expect(recoverApiLock(h.options, { ...h.dependencies,
    readState: async () => ({ version: 1, api: null, dashboard: null, loginUrlFile: null, updatedAt: h.owner.startTime }) }))
    .rejects.toThrow('lock identity cannot be proven')
  expect(JSON.parse(await readFile(h.lockFile, 'utf8'))).toEqual(legacy)
})

it('preserves a live API identity even when controller state is absent', async () => {
  const h = await fixture()
  await expect(recoverApiLock(h.options, { ...h.dependencies, inspectProcess: async () => h.owner,
    readState: async () => ({ version: 1, api: null, dashboard: null, loginUrlFile: null, updatedAt: h.owner.startTime }) }))
    .rejects.toThrow('still running')
  expect(JSON.parse(await readFile(h.lockFile, 'utf8'))).toEqual(h.lock)
})

// The real 1,001-file scans and teardown share Windows filesystem contention with concurrent build and documentation jobs.
it('checks settled history beyond one thousand records before recovering the owner', { timeout: 30_000 }, async () => {
  const h = await fixture(30_000), records = Array.from({ length: 1001 }, (_, index) => {
    const keyHash = index.toString(16).padStart(64, '0')
    return { ...h.record, operationId: randomUUID(), keyHash }
  })
  for (let offset = 0; offset < records.length; offset += 100) {
    await Promise.all(records.slice(offset, offset + 100).map(record =>
      writeFile(path.join(h.operations, `${record.keyHash}.json`), JSON.stringify(record))))
  }
  const last = records.at(-1)!
  const lastFile = path.join(h.operations, `${last.keyHash}.json`)
  await writeFile(lastFile, JSON.stringify({ ...last, status: 'running' }))
  await expect(recoverApiLock(h.options, h.dependencies)).rejects.toThrow('Refusing automatic recovery')
  expect(await readdir(h.operations)).toHaveLength(records.length)
  await writeFile(lastFile, JSON.stringify(last))
  expect(await diagnoseApiLock(h.options, h.dependencies)).toMatchObject({ operationScanTruncated: false, recoveryProof: 'machine-proven' })
  expect((await recoverApiLock(h.options, h.dependencies)).proof).toBe('machine-proven')
  expect(await readdir(h.operations)).toHaveLength(records.length)
  expect(JSON.parse(await readFile(lastFile, 'utf8'))).toEqual(last)
})

const boot = { startedAt: '2026-01-03T00:00:00.000Z', observedAt: '2026-01-04T00:00:00.000Z' }

it('recovers a previous-boot API and its stale ownership while preserving interrupted work and reused PIDs', async () => {
  const h = await fixture(), previous = h.owner.startTime
  const owner = { ...h.owner, pid: process.pid }, lock = { ...h.lock, pid: owner.pid }
  await writeFile(h.lockFile, JSON.stringify(lock))
  const interrupted = { ...h.record, ownerPid: owner.pid, status: 'interrupted', result: null,
    error: { code: 'interrupted', message: 'Retained operation' } }
  const operationText = JSON.stringify(interrupted)
  await writeFile(h.operationFile, operationText)
  const lease = { resource: 'gpu0', owner: 'old-run', token: 'old-token', pid: owner.pid,
    acquiredAt: previous, expiresAt: '2026-01-02T00:00:00.000Z' }
  const ticket = `leases/gpu0.ticket-${String(Date.parse(previous)).padStart(15, '0')}-p${String(owner.pid)}-abc123`
  const entries = {
    'leases/gpu0.lock': lease,
    [ticket]: { owner: lease.owner, pid: lease.pid },
    'claims/claim.json': { id: 'claim.json', scope: h.root, root: h.root, kind: 'path', path: 'src/', directory: true,
      owner: lease.owner, token: lease.token, pid: lease.pid, acquiredAt: previous, expiresAt: lease.expiresAt },
    'claims/mutex/owner.json': { pid: lease.pid, token: lease.token, at: previous },
  }
  for (const [relative, value] of Object.entries(entries)) {
    const file = path.join(h.leaseRoot, relative)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify(value))
  }
  const history = path.join(h.leaseRoot, 'claim-history.json')
  await writeFile(history, 'retained history')
  const dependencies: ServiceLockDependencies = { ...h.dependencies, inspectBoot: async () => boot,
    inspectProcess: async () => ({ ...owner, startTime: boot.observedAt }),
    readState: async () => ({ version: 1, api: null, dashboard: null, loginUrlFile: null, updatedAt: previous }) }
  expect(await diagnoseApiLock(h.options, dependencies)).toMatchObject({ previousBoot: boot,
    interruptedOperations: [{ operationId: interrupted.operationId, status: 'interrupted' }] })
  const result = await recoverApiLock(h.options, dependencies)
  expect(result.proof).toBe('machine-proven')
  expect(JSON.parse(await readFile(result.quarantineFile, 'utf8'))).toEqual(lock)
  expect(await readFile(h.operationFile, 'utf8')).toBe(operationText)
  expect(await readFile(history, 'utf8')).toBe('retained history')
  expect(await readdir(path.join(h.leaseRoot, 'leases'))).toEqual([])
  expect(await readdir(path.join(h.leaseRoot, 'claims'))).toEqual([])
  const recovered = path.join(h.leaseRoot, 'recovered'), directories = await readdir(recovered)
  expect(directories).toHaveLength(1)
  for (const [relative, value] of Object.entries(entries)) {
    expect(JSON.parse(await readFile(path.join(recovered, directories[0]!, relative), 'utf8'))).toEqual(value)
  }
  expect(process.kill(process.pid, 0)).toBe(true)
})

it('retains current-boot resource ownership when an unrelated previous-boot API lock is recovered', async () => {
  const h = await fixture(), leaseFile = path.join(h.leaseRoot, 'leases', 'gpu0.lock')
  const currentLease = { resource: 'gpu0', owner: 'current-run', token: 'current-token', pid: process.pid,
    acquiredAt: boot.startedAt, expiresAt: boot.observedAt }
  await writeFile(leaseFile, JSON.stringify(currentLease))
  expect((await recoverApiLock(h.options, { ...h.dependencies, inspectBoot: async () => boot })).proof).toBe('machine-proven')
  expect(JSON.parse(await readFile(leaseFile, 'utf8'))).toEqual(currentLease)
})

it('does not use boot evidence to replace a matching live API controller', async () => {
  const h = await fixture()
  await expect(recoverApiLock(h.options, { ...h.dependencies, inspectBoot: async () => boot,
    inspectProcess: async () => h.owner })).rejects.toThrow('still running')
  expect(JSON.parse(await readFile(h.lockFile, 'utf8'))).toEqual(h.lock)
})

it('refuses missing, partial and corrupt inspection evidence', async () => {
  const h = await fixture()
  await writeFile(path.join(h.operations, 'pending.tmp'), 'partial')
  await expect(recoverApiLock(h.options, h.dependencies)).rejects.toThrow('Refusing automatic recovery')
  await rm(path.join(h.operations, 'pending.tmp'))
  await writeFile(h.operationFile, '{')
  await expect(recoverApiLock(h.options, h.dependencies)).rejects.toThrow('Refusing automatic recovery')
  await rm(h.operations, { recursive: true })
  await expect(recoverApiLock(h.options, h.dependencies)).rejects.toThrow('Refusing automatic recovery')
  await mkdir(h.operations)
  await rm(h.leaseRoot, { recursive: true })
  await expect(recoverApiLock(h.options, h.dependencies)).rejects.toThrow('Refusing automatic recovery')
})

it('does not treat failed process inspection or a changed command as proof of a dead owner', async () => {
  const h = await fixture()
  await expect(recoverApiLock(h.options, { ...h.dependencies,
    inspectProcess: async () => { throw new Error('identity query denied') } })).rejects.toThrow('identity query denied')
  await expect(recoverApiLock(h.options, { ...h.dependencies,
    inspectPort: async () => { throw new Error('port query denied') } })).rejects.toThrow('port query denied')
  await expect(recoverApiLock(h.options, { ...h.dependencies,
    inspectProcess: async () => ({ ...h.owner, commandLine: 'changed command' }) })).rejects.toThrow('still running')
  expect(JSON.parse(await readFile(h.lockFile, 'utf8'))).toEqual(h.lock)
})

it('rejects work or a replacement owner appearing between diagnosis and fenced recovery', async () => {
  const h = await fixture()
  let observations = 0
  await expect(recoverApiLock(h.options, { ...h.dependencies, inspectPort: async () => {
    observations++
    if (observations === 2) await writeFile(h.operationFile, JSON.stringify({ ...h.record, status: 'running' }))
    return null
  } })).rejects.toThrow('idle proof changed')
  expect(JSON.parse(await readFile(h.lockFile, 'utf8'))).toEqual(h.lock)
  await rm(h.operationFile)
  observations = 0
  await expect(recoverApiLock(h.options, { ...h.dependencies, inspectPort: async () => {
    observations++
    if (observations === 2) await writeFile(h.lockFile, JSON.stringify({ ...h.lock, owner: 'replacement-owner' }))
    return null
  } })).rejects.toThrow('owner changed')
  expect(await readFile(h.lockFile, 'utf8')).toContain('replacement-owner')
})

async function managedFixture() {
  const h = await fixture(), generation = parseOwnershipGeneration(randomUUID())
  const lock = { ...h.lock, owner: generation, workers: { version: 1, generation } }
  await writeFile(h.lockFile, JSON.stringify(lock))
  const store = await WorkerRecoveryStore.create(h.stateDirectory, generation)
  const receipt = parseSubprocessRangeReceipt({ kind: 'windows-job', jobName: `Global\\dsh-subprocess-${randomUUID()}` })
  await store.persist(receipt)
  const interrupted = { ...h.record, status: 'interrupted', result: null, error: { code: 'interrupted', message: 'owner exited' } }
  const operationText = JSON.stringify(interrupted)
  await writeFile(h.operationFile, operationText)
  const lease = { ownershipGeneration: generation, resource: 'gpu0', owner: 'old-run', token: 'old-token', pid: h.owner.pid,
    acquiredAt: h.owner.startTime, expiresAt: '2026-01-02T00:00:00.000Z' }
  const claim = { ...lease, id: 'claim.json', root: h.root, scope: h.root, kind: 'path', path: 'src/', directory: true }
  const leaseFile = path.join(h.leaseRoot, 'leases', 'gpu0.lock'), claimFile = path.join(h.leaseRoot, 'claims', 'claim.json')
  await writeFile(leaseFile, JSON.stringify(lease))
  await writeFile(claimFile, JSON.stringify(claim))
  return { ...h, lock, generation, store, receipt, operationText, lease, claim, leaseFile, claimFile }
}

it('recovers a dead same-boot API generation only after its recorded ranges are empty', async () => {
  const h = await managedFixture(), ranges: SubprocessRangeReceipt[] = []
  const currentLease = { ...h.lease, ownershipGeneration: parseOwnershipGeneration(randomUUID()), owner: 'current-run', pid: process.pid }
  const currentFile = path.join(h.leaseRoot, 'leases', 'gpu1.lock')
  await writeFile(currentFile, JSON.stringify(currentLease))
  const history = path.join(h.leaseRoot, 'claim-history.json')
  const historyText = JSON.stringify({ records: [] })
  await writeFile(history, historyText)
  const signal = new AbortController().signal
  const dependencies: ServiceLockDependencies = { ...h.dependencies, signal,
    inspectProcess: async () => ({ ...h.owner, startTime: '2026-01-02T00:00:00.000Z' }),
    recoverRange: async (receipt, receivedSignal) => {
      expect(receivedSignal).not.toBe(signal)
      expect(receivedSignal?.aborted).toBe(false)
      expect(await readFile(h.leaseFile, 'utf8')).toBe(JSON.stringify(h.lease))
      expect(await readFile(h.claimFile, 'utf8')).toBe(JSON.stringify(h.claim))
      ranges.push(receipt)
    } }
  expect(await diagnoseApiLock(h.options, dependencies)).toMatchObject({ verdict: 'stale', recoveryProof: 'managed-ranges' })
  const result = await recoverApiLock(h.options, dependencies)
  expect(result.proof).toBe('machine-proven')
  expect(ranges).toEqual([h.receipt])
  await expect(readFile(h.lockFile)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(result.quarantineFile, 'utf8')).toBe(JSON.stringify(h.lock))
  expect(await readFile(h.operationFile, 'utf8')).toBe(h.operationText)
  expect(await readFile(history, 'utf8')).toBe(historyText)
  expect(await readFile(currentFile, 'utf8')).toBe(JSON.stringify(currentLease))
  await expect(readFile(h.leaseFile)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readFile(h.claimFile)).rejects.toMatchObject({ code: 'ENOENT' })
  const recovered = path.join(h.leaseRoot, 'recovered'), directories = await readdir(recovered)
  expect(directories).toHaveLength(1)
  expect(JSON.parse(await readFile(path.join(recovered, directories[0]!, 'leases/gpu0.lock'), 'utf8'))).toEqual(h.lease)
  expect(JSON.parse(await readFile(path.join(recovered, directories[0]!, 'claims/claim.json'), 'utf8'))).toEqual(h.claim)
})

it.each(['failure', 'cancelled'] as const)('preserves resource ownership after native recovery %s', async (mode) => {
  const h = await managedFixture(), controller = new AbortController(), failure = new Error('native recovery stopped')
  const recovery = recoverApiLock(h.options, { ...h.dependencies, signal: controller.signal,
    recoverRange: async () => {
      if (mode === 'cancelled') controller.abort(failure)
      else throw failure
    } })
  if (mode === 'cancelled') {
    await expect(recovery).rejects.toBe(failure)
    expect(await readFile(h.lockFile, 'utf8')).toBe(JSON.stringify(h.lock))
  } else {
    expect(await recovery).toMatchObject({ proof: 'owner-stopped', recoveryIssues: [expect.objectContaining({ id: h.generation })] })
    await expect(readFile(h.lockFile)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readRecoveryIssues(h.stateDirectory)).toEqual([expect.objectContaining({ message: failure.message })])
  }
  expect(await readFile(h.leaseFile, 'utf8')).toBe(JSON.stringify(h.lease))
  expect(await readFile(h.claimFile, 'utf8')).toBe(JSON.stringify(h.claim))
  expect(await readFile(h.operationFile, 'utf8')).toBe(h.operationText)
})

it('releases dead API ownership while retaining resources with missing durable receipts', async () => {
  const h = await managedFixture()
  await rm(path.join(h.stateDirectory, 'worker-ranges', h.generation, 'manifest.json'))
  expect(await recoverApiLock(h.options, { ...h.dependencies,
    recoverRange: async () => { throw new Error('Unexpected native recovery') } })).toMatchObject({ proof: 'owner-stopped' })
  await expect(readFile(h.lockFile)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(h.leaseFile, 'utf8')).toBe(JSON.stringify(h.lease))
  expect(await readRecoveryIssues(h.stateDirectory)).toEqual([expect.objectContaining({ id: h.generation })])
})

it('recovers rebooted API ownership without opening damaged native receipts', async () => {
  const h = await managedFixture()
  await writeFile(path.join(h.stateDirectory, 'worker-ranges', h.generation, 'manifest.json'), '{')
  const result = await recoverApiLock(h.options, { ...h.dependencies, inspectBoot: async () => boot,
    recoverRange: async () => { throw new Error('Unexpected native receipt recovery after reboot') } })
  expect(result).toMatchObject({ proof: 'machine-proven', recoveryIssues: [] })
  expect(await workerGenerationSettled(h.stateDirectory, h.generation)).toBe(true)
  await expect(readFile(h.leaseFile)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('joins timed-out worker recovery while preserving the caller startup budget and active resources', async () => {
  const h = await managedFixture(), controller = new AbortController()
  let joined = false
  const options = resolveOptions({ ...h.options, terminationGraceMs: 1 })
  const result = await recoverApiLock(options, { ...h.dependencies, signal: controller.signal,
    recoverRange: async (_range, signal) => {
      if (signal === undefined) throw new Error('Missing bounded recovery signal')
      try {
        await new Promise<void>((_resolve, reject) => {
          const aborted = (): void => { reject(signal.reason instanceof Error ? signal.reason : new Error('Recovery was cancelled')) }
          if (signal.aborted) aborted()
          else signal.addEventListener('abort', aborted, { once: true })
        })
      } finally { joined = true }
    } })
  expect(joined).toBe(true)
  expect(controller.signal.aborted).toBe(false)
  expect(result).toMatchObject({ proof: 'owner-stopped', recoveryIssues: [expect.objectContaining({ id: h.generation })] })
  expect(await readFile(h.leaseFile, 'utf8')).toBe(JSON.stringify(h.lease))
  await expect(readFile(h.lockFile)).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each(['process', 'listener'] as const)('preserves a live managed API %s before native recovery', async (live) => {
  const h = await managedFixture()
  await expect(recoverApiLock(h.options, { ...h.dependencies,
    inspectProcess: async () => live === 'process' ? h.owner : null,
    inspectPort: async () => live === 'listener' ? h.owner : null,
    recoverRange: async () => { throw new Error('Unexpected native recovery') } })).rejects.toThrow('Refusing to recover')
  expect(await readFile(h.lockFile, 'utf8')).toBe(JSON.stringify(h.lock))
  expect(await readFile(h.leaseFile, 'utf8')).toBe(JSON.stringify(h.lease))
})

it('preserves a replacement API owner published during native range recovery', async () => {
  const h = await managedFixture(), generation = parseOwnershipGeneration(randomUUID())
  const replacement = { ...h.lock, owner: generation, workers: { version: 1, generation } }
  await expect(recoverApiLock(h.options, { ...h.dependencies,
    recoverRange: async () => { await writeFile(h.lockFile, JSON.stringify(replacement)) } })).rejects.toThrow()
  expect(await readFile(h.lockFile, 'utf8')).toBe(JSON.stringify(replacement))
  expect(await readFile(h.leaseFile, 'utf8')).toBe(JSON.stringify(h.lease))
  expect(await readFile(h.claimFile, 'utf8')).toBe(JSON.stringify(h.claim))
})

async function orphanFixture() {
  const h = await fixture(), leaseRoot = masterDirectory(h.root), generation = parseOwnershipGeneration(randomUUID())
  await rm(h.lockFile)
  await Promise.all(['leases', 'claims'].map(name => mkdir(path.join(leaseRoot, name), { recursive: true })))
  const store = await WorkerRecoveryStore.create(h.stateDirectory, generation,
    { pid: h.owner.pid, startTime: h.owner.startTime, leaseRoot })
  const receipt = parseSubprocessRangeReceipt({ kind: 'windows-job', jobName: `Global\\dsh-subprocess-${randomUUID()}` })
  await store.persist(receipt)
  const lease = { ownershipGeneration: generation, resource: 'gpu0', owner: 'orphan-run', token: 'orphan-token', pid: h.owner.pid,
    acquiredAt: h.owner.startTime, expiresAt: '2026-01-02T00:00:00.000Z' }
  const leaseFile = path.join(leaseRoot, 'leases', 'gpu0.lock')
  await writeFile(leaseFile, JSON.stringify(lease))
  const operationText = JSON.stringify({ ...h.record, status: 'interrupted', result: null })
  await writeFile(h.operationFile, operationText)
  return { ...h, leaseRoot, generation, receipt, lease, leaseFile, operationText,
    dependencies: { ...h.dependencies, leaseRoot },
    options: resolveOptions({ apiEndpoint: h.apiEndpoint, dshPath: h.root }) }
}

it('prepares a fresh API by recovering a stopped orphan generation without changing operation history', async () => {
  const h = await orphanFixture(), ranges: SubprocessRangeReceipt[] = []
  await prepareServiceOwnership(h.options, { ...h.dependencies, recoverRange: async (receipt) => { ranges.push(receipt) } })
  expect(ranges).toEqual([h.receipt])
  await expect(readFile(h.leaseFile)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(h.operationFile, 'utf8')).toBe(h.operationText)
  await expect(readFile(h.lockFile)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readFile(path.join(h.stateDirectory, API_RECOVERY_FENCE_FILE))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('preserves an orphan generation whose exact controller remains live', async () => {
  const h = await orphanFixture()
  await prepareServiceOwnership(h.options, { ...h.dependencies, inspectProcess: async () => h.owner,
    recoverRange: async () => { throw new Error('Unexpected native recovery') } })
  expect(await readFile(h.leaseFile, 'utf8')).toBe(JSON.stringify(h.lease))
  expect(await readFile(h.operationFile, 'utf8')).toBe(h.operationText)
})

it('persists scoped orphan cleanup failure while preparing startup and clears it after later recovery', async () => {
  const h = await orphanFixture()
  await prepareServiceOwnership(h.options, { ...h.dependencies,
    recoverRange: async () => { throw new Error('range cleanup unavailable') } })
  const issues = await readRecoveryIssues(h.stateDirectory)
  expect(issues).toEqual([expect.objectContaining({ id: h.generation, message: 'range cleanup unavailable' })])
  expect(issues[0]?.blocksAdmission).toBeUndefined()
  expect(await readFile(h.leaseFile, 'utf8')).toBe(JSON.stringify(h.lease))
  await expect(readFile(path.join(h.stateDirectory, API_RECOVERY_FENCE_FILE))).rejects.toMatchObject({ code: 'ENOENT' })
  await prepareServiceOwnership(h.options, { ...h.dependencies, recoverRange: async () => {} })
  expect(await readRecoveryIssues(h.stateDirectory)).toEqual([])
  await expect(readFile(h.leaseFile)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('reports untrusted claim history before admission without deleting it or valid resource holders', async () => {
  const h = await orphanFixture(), history = path.join(h.leaseRoot, 'claim-history.json')
  const current = path.join(h.leaseRoot, 'claims', `${randomUUID()}.json`)
  const claim = { ...h.lease, ownershipGeneration: randomUUID(), id: path.basename(current),
    owner: 'another live generation', root: h.root, scope: h.root, kind: 'path', path: 'other/', directory: true }
  await writeFile(current, JSON.stringify(claim))
  await writeFile(history, '{')
  await prepareServiceOwnership(h.options, { ...h.dependencies, recoverRange: async () => {} })
  expect(await readRecoveryIssues(h.stateDirectory)).toEqual([
    expect.objectContaining({ id: 'claim-registry', blocksAdmission: true }),
  ])
  expect(await readFile(history, 'utf8')).toBe('{')
  expect(await readFile(current, 'utf8')).toBe(JSON.stringify(claim))
  await writeFile(history, JSON.stringify({ records: [] }))
  await prepareServiceOwnership(h.options, { ...h.dependencies, recoverRange: async () => {} })
  expect(await readRecoveryIssues(h.stateDirectory)).toEqual([])
  expect(await readFile(current, 'utf8')).toBe(JSON.stringify(claim))
})

it('rechecks API ownership after fencing before preparing orphan recovery', async () => {
  const h = await orphanFixture()
  await prepareServiceOwnership(h.options, { ...h.dependencies,
    inspectController: async () => {
      await writeFile(h.lockFile, JSON.stringify(h.lock))
      return { pid: 4901, startTime: '2026-01-04T00:00:00.000Z', commandLine: 'fixture recovery controller' }
    }, recoverRange: async () => { throw new Error('Unexpected native recovery') } })
  expect(await readFile(h.lockFile, 'utf8')).toBe(JSON.stringify(h.lock))
  expect(await readFile(h.leaseFile, 'utf8')).toBe(JSON.stringify(h.lease))
})

it('prepares previous-boot ownership without requiring a surviving API lock', async () => {
  const h = await orphanFixture()
  await prepareServiceOwnership(h.options, { ...h.dependencies, inspectBoot: async () => boot })
  await expect(readFile(h.leaseFile)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(h.operationFile, 'utf8')).toBe(h.operationText)
})

it('reclaims a stopped-controller fence and uses reboot proof without opening native ranges', async () => {
  const h = await orphanFixture()
  const fence = { version: 1, id: randomUUID(), startedAt: h.owner.startTime,
    controller: { pid: h.owner.pid, startTime: h.owner.startTime } }
  await writeFile(path.join(h.stateDirectory, API_RECOVERY_FENCE_FILE), JSON.stringify(fence))
  await prepareServiceOwnership(h.options, { ...h.dependencies,
    recoverRange: async () => { throw new Error('Unexpected native recovery after reboot') },
    inspectBoot: async () => {
      expect(await readFile(h.leaseFile, 'utf8')).toBe(JSON.stringify(h.lease))
      return boot
    } })
  await expect(readFile(h.leaseFile)).rejects.toMatchObject({ code: 'ENOENT' })
  const quarantined = (await readdir(h.stateDirectory)).filter(name => name.startsWith(`${API_RECOVERY_FENCE_FILE}.recovered-`))
  expect(quarantined).toHaveLength(1)
  expect(JSON.parse(await readFile(path.join(h.stateDirectory, quarantined[0]!), 'utf8'))).toEqual(fence)
  await expect(readFile(path.join(h.stateDirectory, API_RECOVERY_FENCE_FILE))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(h.operationFile, 'utf8')).toBe(h.operationText)
})
