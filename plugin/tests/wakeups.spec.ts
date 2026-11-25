/** Durable fixed-plan wake delivery, idempotent recovery, bounded admission retries, and cancellation races. */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { Config } from '../src/api.ts'
import { ApiError, apiOperationSchema, resolveApiRun, type ApiOperation, type ApiRunRequest } from '../src/api-types.ts'
import { resolveWakeupRequest, WakeupService, type WakeupAdapter, type WakeupLimits, type WakeupRequest } from '../src/wakeups.ts'

function id(number: number): string { return `00000000-0000-4000-8000-${String(number).padStart(12, '0')}` }

function operation(number: number, workspace: string, status: ApiOperation['status'] = 'running'): ApiOperation {
  return apiOperationSchema.parse({ version: 1, operationId: id(number), keyHash: 'a'.repeat(64), requestHash: 'b'.repeat(64),
    workspace, ownerPid: 123, status, runId: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    progress: null, result: null, error: null })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

async function fixture(overrides: Partial<WakeupLimits> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'deep-cluster-wake-'))
  const services: WakeupService[] = []
  onTestFinished(async () => {
    try { for (const service of services) await service.dispose() } finally { await rm(root, { recursive: true, force: true }) }
  })
  const config = Config({ stateDirectory: root, leaseRoot: path.join(root, 'leases') })
  const clock = { now: Date.parse('2026-01-01T00:00:00.000Z') }
  const operations = new Map<ApiOperation['operationId'], ApiOperation>()
  const accepted = new Map<string, ApiOperation>()
  const submissions: { run: ApiRunRequest; key: string }[] = []
  const cancelled: ApiOperation['operationId'][] = []
  const errors: unknown[] = []
  const adapter: WakeupAdapter = {
    now: () => clock.now,
    resolveRun: value => resolveApiRun(value, config),
    getOperation: vi.fn<WakeupAdapter['getOperation']>(operationId => Promise.resolve(operations.get(operationId) ?? null)),
    lookup: vi.fn<WakeupAdapter['lookup']>(key => Promise.resolve(accepted.get(key) ?? null)),
    submit: vi.fn<WakeupAdapter['submit']>((run, key) => {
      submissions.push({ run, key })
      const previous = accepted.get(key)
      if (previous !== undefined) return Promise.resolve(previous)
      const record = operation(submissions.length + 100, root)
      accepted.set(key, record); operations.set(record.operationId, record)
      return Promise.resolve(record)
    }),
    cancel: vi.fn<WakeupAdapter['cancel']>((operationId) => {
      cancelled.push(operationId)
      const record = operations.get(operationId)
      if (record === undefined) throw new Error('Missing fixture operation')
      record.status = 'cancelled'
      return Promise.resolve(record)
    }),
    reportError: (error) => { errors.push(error) },
  }
  const limits = { maxRecords: 20, maxAttempts: 2, pollIntervalMs: 1000, retryDelayMs: 100, ...overrides }
  const create = () => {
    const service = new WakeupService(root, limits, adapter)
    services.push(service)
    return service
  }
  const service = create()
  await service.initialize()
  function request(number = 1, extra: Partial<WakeupRequest> = {}): WakeupRequest {
    return resolveWakeupRequest({ id: id(number), run: { workspace: root, plans: ['# Fixed plan\ngoal: inspect\n## Step one: inspect\nrole: reviewer\naccess: read-only\nhardware: none\nacceptance:\n- inspected\n\nRead assigned evidence.'],
      session: { id: id(90), generation: 1 } }, trigger: { kind: 'at', atISO: new Date(clock.now).toISOString() },
    expiresAtISO: new Date(clock.now + 60_000).toISOString(), ...extra }, adapter.resolveRun)
  }
  return { root, service, create, request, adapter, operations, accepted, submissions, cancelled, errors, clock }
}

it('validates exact sessions and scheduling dates before queue admission', async () => {
  const h = await fixture(), request = h.request()
  const { session: _session, ...withoutSession } = request.run
  expect(() => resolveWakeupRequest({ ...request, run: withoutSession }, h.adapter.resolveRun)).toThrow('session')
  expect(() => resolveWakeupRequest({ ...request, trigger: { kind: 'at', atISO: request.expiresAtISO } }, h.adapter.resolveRun)).toThrow('expiry')
  expect(() => resolveWakeupRequest({ ...request, ignored: true }, h.adapter.resolveRun)).toThrow('requires')
})

it('retains an identical registration, refuses changed instructions and enforces queue capacity', async () => {
  const h = await fixture({ maxRecords: 1 }), request = h.request()
  const first = await h.service.register(request)
  expect(await h.service.register(request)).toEqual(first)
  await expect(h.service.register({ ...request, run: { ...request.run, plans: ['different'] } })).rejects.toMatchObject({ code: 'wakeup-conflict' })
  await expect(h.service.register(h.request(2))).rejects.toMatchObject({ code: 'wakeup-limit' })
  expect(h.submissions).toEqual([])
  const listed = await h.service.list(h.root)
  expect(listed).toHaveLength(1)
  listed[0]!.status = 'failed'
  expect((await h.service.get(request.id))?.status).toBe('pending')
  expect(await h.service.list(path.join(h.root, 'other'))).toEqual([])
})

it('waits until the scheduled instant and submits once across overlapping polls', async () => {
  const h = await fixture(), request = h.request(1, { trigger: { kind: 'at', atISO: new Date(h.clock.now + 1000).toISOString() } })
  await h.service.register(request)
  await h.service.tick()
  expect(h.submissions).toEqual([])
  h.clock.now += 1000
  const pass = h.service.tick()
  expect(h.service.tick()).toBe(pass)
  await pass
  await h.service.tick()
  expect(h.submissions).toEqual([{ run: request.run, key: `wakeup:${request.id}` }])
  expect((await h.service.get(request.id))?.status).toBe('submitted')
})

it.each(['settled', 'attention'] as const)('dispatches a one-shot %s source condition without changing the plan', async (when) => {
  const h = await fixture(), source = operation(50, h.root)
  h.operations.set(source.operationId, source)
  const request = h.request(1, { trigger: { kind: 'operation', operationId: source.operationId, when } })
  await h.service.register(request)
  await h.service.tick()
  expect(h.submissions).toEqual([])
  source.status = 'failed'
  await h.service.tick(); await h.service.tick()
  expect(h.submissions).toHaveLength(1)
  expect(h.submissions[0]!.run).toEqual(request.run)
})

it('fails absent or foreign source operations without dispatching', async () => {
  const h = await fixture(), source = operation(50, path.join(h.root, 'other'), 'completed')
  h.operations.set(source.operationId, source)
  for (const number of [50, 51]) {
    const request = h.request(number, { trigger: { kind: 'operation', operationId: operation(number, h.root).operationId, when: 'settled' } })
    await h.service.register(request)
  }
  await h.service.tick()
  expect((await h.service.list(h.root)).map(record => record.error?.code)).toEqual(['wakeup-source', 'wakeup-source'])
  expect(h.submissions).toEqual([])
})

it.each([{ status: 409, code: 'session-busy' }, { status: 429, code: 'active-run-limit' }, { status: 503, code: 'recovery-admission-blocked' }])(
  'bounds admission retries for $code and waits for configured backoff', async ({ status, code }) => {
    const h = await fixture(), request = h.request()
    h.adapter.submit = vi.fn(() => Promise.reject(new ApiError(status, code, 'busy')))
    await h.service.register(request)
    await h.service.tick(); await h.service.tick()
    expect(h.adapter.submit).toHaveBeenCalledTimes(1)
    h.clock.now += 100
    await h.service.tick()
    expect(h.adapter.submit).toHaveBeenCalledTimes(2)
    h.clock.now += 100
    await h.service.tick()
    expect(await h.service.get(request.id)).toMatchObject({ status: 'failed', attempts: 2, error: { code: 'wakeup-attempts' } })
  })

it('does not retry a generation mismatch or a submitted worker failure', async () => {
  const h = await fixture(), request = h.request()
  h.adapter.submit = vi.fn(() => Promise.reject(new ApiError(409, 'session-generation', 'superseded')))
  await h.service.register(request)
  await h.service.tick(); h.clock.now += 100; await h.service.tick()
  expect(h.adapter.submit).toHaveBeenCalledTimes(1)
  expect(await h.service.get(request.id)).toMatchObject({ status: 'failed', error: { code: 'session-generation' } })
  expect(await h.service.cancel(request.id)).toMatchObject({ status: 'failed', error: { code: 'session-generation' } })
  const failed = operation(110, h.root, 'failed')
  h.adapter.submit = vi.fn(() => Promise.resolve(failed))
  await h.service.register(h.request(2))
  await h.service.tick(); await h.service.tick()
  expect(h.adapter.submit).toHaveBeenCalledTimes(1)
  expect((await h.service.list(h.root))[1]).toMatchObject({ status: 'failed', operationId: failed.operationId })
})

it('recovers an accepted operation after a lost response before expiry or retry budgets can discard it', async () => {
  const h = await fixture({ maxAttempts: 1 }), request = h.request()
  const accepted = operation(110, h.root)
  h.operations.set(accepted.operationId, accepted)
  h.adapter.submit = vi.fn<WakeupAdapter['submit']>((_run, key) => {
    h.accepted.set(key, accepted)
    return Promise.reject(new Error('response lost'))
  })
  await h.service.register(request)
  await h.service.tick()
  h.clock.now += 120_000
  await h.service.tick()
  expect(h.adapter.submit).toHaveBeenCalledTimes(1)
  expect(await h.service.get(request.id)).toMatchObject({ status: 'submitted', operationId: accepted.operationId })
})

it('recovers dispatching records using the original admission key after restart', async () => {
  const h = await fixture(), request = h.request()
  const saved = await h.service.register(request)
  await h.service.dispose()
  await writeFile(path.join(h.root, 'wakeups', `${request.id}.json`), JSON.stringify({ ...saved, status: 'dispatching', attempts: 1 }))
  const accepted = operation(110, h.root)
  h.accepted.set(`wakeup:${request.id}`, accepted); h.operations.set(accepted.operationId, accepted)
  const restored = h.create()
  expect(await restored.initialize()).toEqual([])
  await restored.tick()
  expect(h.submissions).toEqual([])
  expect(await restored.get(request.id)).toMatchObject({ status: 'submitted', operationId: accepted.operationId })
})

it('retries a dispatch that never reached admission with the same key after restart', async () => {
  const h = await fixture(), request = h.request()
  const saved = await h.service.register(request)
  await h.service.dispose()
  await writeFile(path.join(h.root, 'wakeups', `${request.id}.json`), JSON.stringify({ ...saved, status: 'dispatching', attempts: 1 }))
  const restored = h.create()
  await restored.initialize(); await restored.tick()
  expect(h.submissions).toEqual([{ run: request.run, key: `wakeup:${request.id}` }])
})

it('preserves a shutdown-refused submission for restart without consuming its retry budget', async () => {
  const h = await fixture({ maxAttempts: 1 }), request = h.request()
  const entered = deferred<undefined>(), release = deferred<undefined>()
  const originalSubmit = h.adapter.submit
  h.adapter.submit = vi.fn(async () => {
    entered.resolve(undefined)
    await release.promise
    throw new ApiError(503, 'shutting-down', 'The API is shutting down.')
  })
  await h.service.register(request)
  const pass = h.service.tick()
  await entered.promise
  const disposing = h.service.dispose()
  release.resolve(undefined)
  await Promise.all([pass, disposing])
  expect(await h.service.get(request.id)).toMatchObject({ status: 'pending', attempts: 0, error: { code: 'shutting-down' } })
  h.adapter.submit = originalSubmit
  h.clock.now += 100
  const restored = h.create()
  await restored.initialize(); await restored.tick()
  expect(h.submissions).toEqual([{ run: request.run, key: `wakeup:${request.id}` }])
})

it('expires only unsubmitted requests and reports missing accepted operation history without replay', async () => {
  const h = await fixture(), request = h.request()
  await h.service.register(request)
  h.clock.now += 60_000
  await h.service.tick()
  expect((await h.service.get(request.id))?.status).toBe('expired')
  expect(h.submissions).toEqual([])
  const next = h.request(2)
  await h.service.register(next); await h.service.tick()
  h.operations.clear(); await h.service.tick()
  expect(await h.service.get(next.id)).toMatchObject({ status: 'interrupted', error: { code: 'wakeup-operation-missing' } })
  expect(h.submissions).toHaveLength(1)
})

it('cancels pending work without admission and joins cancellation of a late accepted submission', async () => {
  const h = await fixture(), pending = h.request()
  await h.service.register(pending)
  expect((await h.service.cancel(pending.id)).status).toBe('cancelled')
  await h.service.tick()
  expect(h.submissions).toEqual([])
  const request = h.request(2), entered = deferred<undefined>(), release = deferred<ApiOperation>()
  h.adapter.submit = vi.fn(() => { entered.resolve(undefined); return release.promise })
  await h.service.register(request)
  const pass = h.service.tick()
  await entered.promise
  const cancellation = h.service.cancel(request.id)
  const accepted = operation(110, h.root)
  h.operations.set(accepted.operationId, accepted)
  release.resolve(accepted)
  await pass
  expect(await cancellation).toMatchObject({ status: 'cancelled', cancellationRequested: true, operationId: accepted.operationId })
  expect(h.cancelled).toEqual([accepted.operationId])
})

it.each([false, true])('reconciles cancelled uncertain dispatch after restart without new submission (accepted=%s)', async (wasAccepted) => {
  const h = await fixture(), request = h.request()
  const saved = await h.service.register(request)
  await h.service.dispose()
  await writeFile(path.join(h.root, 'wakeups', `${request.id}.json`), JSON.stringify({ ...saved,
    status: 'dispatching', attempts: 1, cancellationRequested: true }))
  const accepted = operation(110, h.root)
  if (wasAccepted) { h.accepted.set(`wakeup:${request.id}`, accepted); h.operations.set(accepted.operationId, accepted) }
  const restored = h.create()
  await restored.initialize(); await restored.tick()
  expect((await restored.get(request.id))?.status).toBe('cancelled')
  expect(h.submissions).toEqual([])
  expect(h.cancelled).toEqual(wasAccepted ? [accepted.operationId] : [])
})

it('retains cancellation uncertainty and retries lookup without submitting', async () => {
  const h = await fixture(), request = h.request()
  await h.service.register(request); await h.service.tick()
  h.adapter.cancel = vi.fn(() => Promise.reject(new Error('cleanup unknown')))
  expect(await h.service.cancel(request.id)).toMatchObject({ status: 'interrupted', cancellationRequested: true,
    error: { code: 'wakeup-cancellation-unconfirmed' } })
  await h.service.tick()
  expect(h.adapter.cancel).toHaveBeenCalledTimes(2)
  expect(h.submissions).toHaveLength(1)
})

it('does not report confirmed cancellation when known accepted operation history is missing', async () => {
  const h = await fixture(), request = h.request()
  await h.service.register(request); await h.service.tick()
  h.operations.clear()
  expect(await h.service.cancel(request.id)).toMatchObject({ status: 'interrupted', cancellationRequested: true,
    error: { code: 'wakeup-cancellation-unconfirmed' } })
  expect(h.cancelled).toEqual([])
  expect(h.submissions).toHaveLength(1)
})

it('isolates malformed queue evidence while preserving and dispatching valid entries', async () => {
  const h = await fixture(), request = h.request()
  await h.service.register(request); await h.service.dispose()
  await writeFile(path.join(h.root, 'wakeups', `${id(2)}.json`), '{broken')
  const restored = h.create(), issues = await restored.initialize()
  expect(issues).toHaveLength(1)
  expect(issues[0]!.quarantinePath).not.toBeNull()
  expect(await readFile(issues[0]!.quarantinePath!, 'utf8')).toBe('{broken')
  await expect(restored.register(h.request(2))).rejects.toMatchObject({ code: 'wakeup-corrupt' })
  await restored.tick()
  expect(h.submissions).toHaveLength(1)
  expect(await readdir(path.join(h.root, 'wakeups'))).toEqual([`${request.id}.json`, `${id(2)}.blocked`])
  await restored.dispose()
  const restarted = h.create()
  await restarted.initialize()
  await expect(restarted.register(h.request(2))).rejects.toMatchObject({ code: 'wakeup-corrupt' })
})

it('joins a direct cancellation before disposal releases queue ownership', async () => {
  const h = await fixture(), request = h.request(), entered = deferred<undefined>(), release = deferred<ApiOperation>()
  await h.service.register(request); await h.service.tick()
  const record = await h.service.get(request.id)
  if (record?.operationId === null || record?.operationId === undefined) throw new Error('Expected admitted fixture')
  h.adapter.cancel = vi.fn(() => { entered.resolve(undefined); return release.promise })
  const cancellation = h.service.cancel(request.id)
  await entered.promise
  let disposed = false
  const disposing = h.service.dispose().then(() => { disposed = true })
  await Promise.resolve()
  expect(disposed).toBe(false)
  release.resolve(operation(101, h.root, 'cancelled'))
  await Promise.all([cancellation, disposing])
  expect(await h.service.get(request.id)).toMatchObject({ status: 'cancelled' })
  expect(JSON.parse(await readFile(path.join(h.root, 'wakeups', `${request.id}.json`), 'utf8'))).toMatchObject({ status: 'cancelled' })
})

it('joins cancellation even when another queued update fails during disposal', async () => {
  const h = await fixture(), first = h.request(), second = h.request(2)
  await h.service.register(first); await h.service.register(second); await h.service.tick()
  const entered = deferred<undefined>(), release = deferred<ApiOperation>()
  h.adapter.cancel = vi.fn(() => { entered.resolve(undefined); return release.promise })
  const cancellation = h.service.cancel(second.id)
  await entered.promise
  const failedFile = path.join(h.root, 'wakeups', `${first.id}.json`)
  await rm(failedFile); await mkdir(failedFile)
  const pass = h.service.tick()
  const passFailure = expect(pass).rejects.toThrow()
  let disposed = false
  const disposing = h.service.dispose().finally(() => { disposed = true })
  const disposalFailure = expect(disposing).rejects.toThrow('after all admission and cancellation work settled')
  await passFailure
  expect(disposed).toBe(false)
  release.resolve(operation(102, h.root, 'cancelled'))
  await Promise.all([cancellation, disposalFailure])
  expect(await h.service.get(second.id)).toMatchObject({ status: 'cancelled' })
})

it('owns one timer and finishes admitted bookkeeping before disposal returns', async () => {
  const h = await fixture(), request = h.request(), entered = deferred<undefined>(), release = deferred<ApiOperation>()
  h.adapter.submit = vi.fn(() => { entered.resolve(undefined); return release.promise })
  await h.service.register(request)
  vi.useFakeTimers()
  try {
    h.service.start(); h.service.start()
    expect(vi.getTimerCount()).toBe(1)
    const pass = h.service.tick()
    await entered.promise
    const disposing = h.service.dispose()
    release.resolve(operation(110, h.root))
    await Promise.all([pass, disposing])
    expect(vi.getTimerCount()).toBe(0)
    expect((await h.service.get(request.id))?.status).toBe('submitted')
    await expect(h.service.register(h.request(2))).rejects.toMatchObject({ code: 'wakeup-unavailable' })
  } finally { vi.useRealTimers() }
})

it('automatically polls without overlapping a delayed admission', async () => {
  const h = await fixture(), request = h.request(), entered = deferred<undefined>(), release = deferred<ApiOperation>()
  h.adapter.submit = vi.fn(() => { entered.resolve(undefined); return release.promise })
  await h.service.register(request)
  vi.useFakeTimers()
  try {
    h.service.start()
    await vi.advanceTimersByTimeAsync(1000)
    await entered.promise
    await vi.advanceTimersByTimeAsync(3000)
    expect(h.adapter.submit).toHaveBeenCalledTimes(1)
    release.resolve(operation(110, h.root))
    await h.service.tick()
    await h.service.dispose()
    expect(vi.getTimerCount()).toBe(0)
    expect(h.errors).toEqual([])
  } finally { vi.useRealTimers() }
})
