/** Complete recovery fences survive controller crashes without accepting PID reuse. */
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { API_RECOVERY_FENCE_FILE } from '../src/api-types.ts'
import { ApiRecoveryFenceError, reclaimApiRecoveryFence, withApiRecoveryFence } from '../src/service-recovery-fence.ts'
import type { ApiRecoveryFenceOptions } from '../src/service-recovery-fence.ts'

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'deepcluster-fence-'))
  onTestFinished(async () => { await rm(directory, { recursive: true, force: true }) })
  const identity = { pid: process.pid, startTime: '2026-10-27T01:00:00.000Z', commandLine: 'fixture controller' }
  const options: ApiRecoveryFenceOptions = { inspectController: async () => identity, inspectProcess: async () => identity,
    inspectBoot: async () => ({ startedAt: '2026-10-27T00:00:00.000Z', observedAt: '2026-10-27T02:00:00.000Z' }) }
  const file = path.join(directory, API_RECOVERY_FENCE_FILE)
  const record = { version: 1, id: randomUUID(), startedAt: identity.startTime,
    controller: { pid: identity.pid, startTime: identity.startTime } }
  return { directory, identity, options, file, record }
}

it('publishes complete controller metadata before running and removes only the owned fence', async () => {
  const h = await fixture()
  const result = await withApiRecoveryFence(h.directory, async () => {
    expect(JSON.parse(await readFile(h.file, 'utf8'))).toMatchObject({ version: 1, controller: h.record.controller })
    return 'recovered'
  }, h.options)
  expect(result).toBe('recovered')
  await expect(readFile(h.file)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('quarantines a crashed controller fence and permits the next complete recovery', async () => {
  const h = await fixture()
  await writeFile(h.file, JSON.stringify(h.record))
  const options = { ...h.options, inspectProcess: async () => null }
  const preserved = await reclaimApiRecoveryFence(h.directory, options)
  expect(await readFile(preserved ?? '', 'utf8')).toBe(JSON.stringify(h.record))
  await expect(withApiRecoveryFence(h.directory, async () => 1, options)).resolves.toBe(1)
})

it('uses process start time to distinguish a live controller from a reused PID', async () => {
  const h = await fixture()
  await writeFile(h.file, JSON.stringify(h.record))
  await expect(reclaimApiRecoveryFence(h.directory, h.options)).rejects.toMatchObject({ code: 'active-controller' })
  expect(await readFile(h.file, 'utf8')).toBe(JSON.stringify(h.record))
  await expect(reclaimApiRecoveryFence(h.directory, { ...h.options,
    inspectProcess: async () => ({ ...h.identity, startTime: '2026-10-27T01:30:00.000Z' }),
  })).resolves.toEqual(expect.any(String))
})

it('retains unknown same-boot legacy fences but quarantines previous-boot evidence', async () => {
  const h = await fixture()
  await writeFile(h.file, JSON.stringify({ startedAt: '2026-10-27T00:30:00.000Z', controllerPid: process.pid }))
  await expect(reclaimApiRecoveryFence(h.directory, h.options)).rejects.toBeInstanceOf(ApiRecoveryFenceError)
  await writeFile(h.file, JSON.stringify({ startedAt: '2026-10-26T00:30:00.000Z', controllerPid: process.pid }))
  await expect(reclaimApiRecoveryFence(h.directory, h.options)).resolves.toEqual(expect.any(String))
})

it('preserves malformed fences and reports unknown host observations', async () => {
  const h = await fixture()
  await writeFile(h.file, '{')
  await expect(reclaimApiRecoveryFence(h.directory, h.options)).rejects.toMatchObject({ code: 'unknown-controller' })
  await writeFile(h.file, JSON.stringify(h.record))
  await expect(reclaimApiRecoveryFence(h.directory, { ...h.options, inspectProcess: async () => { throw new Error('host unavailable') } }))
    .rejects.toMatchObject({ code: 'unknown-controller' })
  expect(await readFile(h.file, 'utf8')).toBe(JSON.stringify(h.record))
})

it('preserves a replacement fence and reports both recovery and release failures', async () => {
  const h = await fixture()
  const failure = new Error('recovery failed')
  const replacement = JSON.stringify({ replacement: true })
  const outcome = await withApiRecoveryFence(h.directory, async () => {
    await rm(h.file)
    await writeFile(h.file, replacement)
    throw failure
  }, h.options).catch((error: unknown) => error)
  expect(outcome).toBeInstanceOf(AggregateError)
  if (!(outcome instanceof AggregateError)) throw new Error('Expected both failures')
  expect(outcome.errors[0]).toBe(failure)
  expect(outcome.errors[1]).toBeInstanceOf(ApiRecoveryFenceError)
  expect(await readFile(h.file, 'utf8')).toBe(replacement)
})

it('does not publish a fence without its own host identity', async () => {
  const h = await fixture()
  await expect(withApiRecoveryFence(h.directory, async () => 1, { ...h.options, inspectController: async () => null }))
    .rejects.toMatchObject({ code: 'unknown-controller' })
  await expect(readFile(h.file)).rejects.toMatchObject({ code: 'ENOENT' })
})
