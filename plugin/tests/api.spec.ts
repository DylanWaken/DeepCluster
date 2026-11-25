/** Real loopback HTTP exercises admission, durable retries, optional idempotency, and joined cancellation. */
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import { Config } from '../src/api.ts'
import { createApiRuntime, type ApiRuntime } from '../src/api-runtime.ts'
import { apiOperationViewSchema, type ApiConfig } from '../src/api-types.ts'
import { ApiOperationStore, apiHash } from '../src/api-store.ts'
import { resolveOptions } from '../src/assets.ts'
import type { CoordinateOptions, RunOutcome } from '../src/coordinator.ts'
import { ProcessCleanupError, WorkerTerminationError } from '../src/executor.ts'
import { Journal, type JournalEventType } from '../src/journal.ts'
import { acquireLease, releaseLease } from '../src/lease.ts'
import { masterDirectory } from '../src/master.ts'
import { createTeam, TeamMailbox } from '../src/mailbox.ts'
import type { Plan } from '../src/plan.ts'
import type { RunId } from '../src/types.ts'
import { listenLoopback } from './loopback-server.ts'
import { knowledgeRevisionSchema } from '../src/knowledge-types.ts'
import { clusterSessionSchema } from '../src/native-sessions.ts'
import type DeepCluster from '../src/index.ts'

const plan = '# API test\ngoal: inspect a fixture\n## Step one: inspect\nrole: tester\nhardware: none\nacceptance:\n- inspected\n\nRead the fixture.'

async function fixture(overrides: Partial<ApiConfig> = {},
  runPlan?: (plan: Plan, workspace: string, options: Partial<CoordinateOptions>) => Promise<RunOutcome>,
  confirmCleanup = false, evaluatePolicies?: DeepCluster['evaluatePolicies']) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'deepcluster-api-')))
  const config = Config({ stateDirectory: path.join(root, 'state'), leaseRoot: masterDirectory(root), ...overrides })
  type Call = { plan: Plan; options: Partial<CoordinateOptions>; finish(): void; runId: RunId }
  const calls: Call[] = [], errors: unknown[] = [], shutdowns: number[] = []
  const state: { runtime?: ApiRuntime } = {}
  const server = createServer((request, response) => { void state.runtime?.handle(request, response) })
  const address = await listenLoopback(server)
  const origin = `http://127.0.0.1:${address.port}`
  onTestFinished(async () => {
    for (const call of calls) call.finish()
    try { await state.runtime?.dispose() } finally {
      server.closeAllConnections()
      try {
        await new Promise<void>((resolve, reject) => server.close((error) => { if (error === undefined) resolve(); else reject(error) }))
      }
      finally { await rm(root, { recursive: true, force: true }) }
    }
  })
  const service = {
    ...evaluatePolicies === undefined ? {} : { evaluatePolicies },
    options: resolveOptions({ apiEndpoint: origin, dashboardEndpoint: 'http://127.0.0.1:4788', dshPath: root,
      cliPath: 'dsh', profile: 'cluster' }),
    runPlan: runPlan ?? (async (submitted: Plan, workspace: string, options: Partial<CoordinateOptions> = {}): Promise<RunOutcome> => {
      const runId = randomUUID() as RunId
      options.onEvent?.({ seq: 0, at: new Date().toISOString(), type: 'run/start', data: { runId } })
      await new Promise<void>((resolve) => { calls.push({ plan: submitted, options, runId, finish: resolve }) })
      return { runId, status: options.signal?.aborted === true ? 'cancelled' : 'completed',
        ...confirmCleanup ? { cleanupConfirmed: true } : {},
        steps: [], journalFile: new Journal(workspace).file, openImprovisations: [] }
    }),
  }
  const runtime = await createApiRuntime(service, config, origin, (error) => { errors.push(error) }, () => { shutdowns.push(Date.now()) })
  state.runtime = runtime
  const decode = async (response: Response) => ({ status: response.status, body: await response.json() as unknown })
  const send = async (route: string, body?: unknown, extra: Record<string, string> = {}) => {
    const response = await fetch(`${origin}${route}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return await decode(response)
  }
  const sendText = async (route: string, text: string, contentType = 'text/markdown') => await decode(
    await fetch(`${origin}${route}`, { method: 'POST', headers: { 'content-type': contentType }, body: text }))
  const submit = async (key: string | undefined, extras: Record<string, unknown> = {}) => await send('/v1/runs',
    { workspace: root, plans: [plan], ...extras }, key === undefined ? {} : { 'idempotency-key': key })
  const restart = async () => {
    await state.runtime?.dispose()
    state.runtime = await createApiRuntime(service, config, origin, (error) => { errors.push(error) }, () => { shutdowns.push(Date.now()) })
  }
  return { root, config, origin, runtime, calls, errors, shutdowns, send, sendText, submit, service, restart }
}

it('continues native sessions, replaces their generation, and preserves original idempotent bindings', async () => {
  const h = await fixture({}, undefined, true), id = randomUUID()
  const create = await h.send('/v1/sessions', { id, workspace: h.root, title: 'Assigned tester', role: 'tester' })
  expect(create.status).toBe(201)
  const original = z.object({ session: clusterSessionSchema }).parse(create.body).session
  const request = { workspace: h.root, plans: [plan], session: { id, generation: 1 } }
  const first = apiOperationViewSchema.parse((await h.send('/v1/runs', request, { 'Idempotency-Key': 'native-first' })).body)
  await expect.poll(() => h.calls.length).toBe(1)
  expect(h.calls[0]?.options).toMatchObject({ nativeSession: { mode: 'create', id: original.nativeSessionId }, maxAttempts: 1, maxRepairs: 0 })
  expect((await h.send('/v1/runs', request, { 'Idempotency-Key': 'native-busy' })).status).toBe(409)
  h.calls[0]?.finish()
  const read = async () => z.object({ session: clusterSessionSchema }).parse((await h.send(`/v1/sessions/${id}`)).body).session
  await expect.poll(async () => (await read()).status).toBe('ready')
  const second = await h.send('/v1/runs', request, { 'Idempotency-Key': 'native-second' })
  expect(second.status).toBe(202)
  await expect.poll(() => h.calls.length).toBe(2)
  expect(h.calls[1]?.options.nativeSession).toEqual({ mode: 'resume', id: original.nativeSessionId })
  h.calls[1]?.finish()
  await expect.poll(async () => (await read()).status).toBe('ready')
  const replacement = await h.send(`/v1/sessions/${id}/replace`, { generation: 1, handoff: 'Continue only the verified testing work.' })
  expect(replacement.status).toBe(200)
  const successor = z.object({ session: clusterSessionSchema }).parse(replacement.body).session
  expect(successor).toMatchObject({ generation: 2, previousSessionId: original.nativeSessionId, status: 'new' })
  expect(successor.nativeSessionId).not.toBe(original.nativeSessionId)
  const replay = apiOperationViewSchema.parse((await h.send('/v1/runs', request, { 'Idempotency-Key': 'native-first' })).body)
  expect(replay.operationId).toBe(first.operationId)
  expect(replay.session).toEqual(first.session)
  expect((await h.send('/v1/runs', request, { 'Idempotency-Key': 'native-superseded' })).status).toBe(409)
  const next = { ...request, session: { id, generation: 2 } }
  expect((await h.send('/v1/runs', next)).status).toBe(202)
  await expect.poll(() => h.calls.length).toBe(3)
  expect(h.calls[2]?.options).toMatchObject({ nativeSession: { mode: 'create', id: successor.nativeSessionId }, sessionHandoff: successor.handoff })
  h.calls[2]?.finish()
  await expect.poll(async () => (await read()).status).toBe('ready')
  await h.restart()
  expect(await read()).toMatchObject({ generation: 2, nativeSessionId: successor.nativeSessionId, status: 'ready' })
  expect(h.errors).toEqual([])
})

it('fences the old native generation before replacement joins cancellation', async () => {
  const h = await fixture({}, undefined, true), id = randomUUID()
  await h.send('/v1/sessions', { id, workspace: h.root, title: 'Assigned tester', role: 'tester' })
  const input = { workspace: h.root, plans: [plan], session: { id, generation: 1 } }
  await h.send('/v1/runs', input)
  await expect.poll(() => h.calls.length).toBe(1)
  const replacement = h.send(`/v1/sessions/${id}/replace`, { generation: 1, handoff: 'Use the recorded test evidence.' })
  await expect.poll(() => h.calls[0]?.options.signal?.aborted).toBe(true)
  expect(await h.send('/v1/runs', input)).toMatchObject({ status: 409, body: { error: { code: 'session-replacing' } } })
  expect(h.calls).toHaveLength(1)
  h.calls[0]?.finish()
  expect((await replacement).status).toBe(200)
  expect((await h.send(`/v1/sessions/${id}`)).body).toMatchObject({ session: { generation: 2, status: 'new', activeOperationId: null } })
})

it('automatically wakes an assigned native session once its source operation settles and does not replay after restart', async () => {
  const h = await fixture({ wakeupPollIntervalMs: 20, wakeupRetryDelayMs: 20 }, undefined, true), id = randomUUID()
  await h.send('/v1/sessions', { id, workspace: h.root, title: 'Assigned tester', role: 'tester' })
  const run = { workspace: h.root, plans: [plan], session: { id, generation: 1 } }
  const source = apiOperationViewSchema.parse((await h.send('/v1/runs', run)).body)
  await expect.poll(() => h.calls.length).toBe(1)
  const wake = { id: randomUUID(), run, trigger: { kind: 'operation', operationId: source.operationId, when: 'settled' },
    expiresAtISO: new Date(Date.now() + 60_000).toISOString() }
  expect((await h.send('/v1/wakeups', wake)).status).toBe(202)
  h.calls[0]?.finish()
  await expect.poll(() => h.calls.length).toBe(2)
  expect(h.calls[1]?.options.nativeSession?.mode).toBe('resume')
  expect((await h.send('/v1/wakeups', wake)).status).toBe(202)
  h.calls[1]?.finish()
  const read = async () => z.object({ wakeup: z.object({ status: z.string(), operationId: z.string().nullable() }) })
    .parse((await h.send(`/v1/wakeups/${wake.id}`)).body).wakeup
  await expect.poll(async () => (await read()).status).toBe('completed')
  const acceptedId = (await read()).operationId
  await h.restart()
  expect(await read()).toMatchObject({ status: 'completed', operationId: acceptedId })
  expect((await h.send('/v1/wakeups', wake)).status).toBe(202)
  expect(h.calls).toHaveLength(2)
  expect(h.errors).toEqual([])
})

it('keeps unconfirmed native cleanup fenced across a refused replacement and restart', async () => {
  const h = await fixture({}, async () => { throw new ProcessCleanupError('worker range remains live') }), id = randomUUID()
  await h.send('/v1/sessions', { id, workspace: h.root, title: 'Assigned tester', role: 'tester' })
  const input = { workspace: h.root, plans: [plan], session: { id, generation: 1 } }
  const operation = apiOperationViewSchema.parse((await h.send('/v1/runs', input)).body)
  await expect.poll(async () => (await h.send(`/v1/runs/${operation.operationId}`)).body)
    .toMatchObject({ status: 'failed', error: { code: 'cleanup-unconfirmed' } })
  await expect.poll(async () => (await h.send(`/v1/sessions/${id}`)).body).toMatchObject({ session: { status: 'interrupted' } })
  const replacement = () => h.send(`/v1/sessions/${id}/replace`, { generation: 1, handoff: 'Verified test evidence only.' })
  expect(await replacement()).toMatchObject({ status: 409, body: { error: { code: 'cleanup-unconfirmed' } } })
  await h.restart()
  expect(await replacement()).toMatchObject({ status: 409, body: { error: { code: 'cleanup-unconfirmed' } } })
  expect((await h.send('/v1/health')).status).toBe(200)
  expect((await h.send(`/v1/sessions/${id}`)).body).toMatchObject({ session: { generation: 1, lastOperationId: operation.operationId } })
})

it('rejects native assignment changes and invalid replacement generations before dispatch', async () => {
  const h = await fixture(), id = randomUUID()
  await h.send('/v1/sessions', { id, workspace: h.root, title: 'Assigned reviewer', role: 'reviewer' })
  expect(await h.submit('wrong-role', { session: { id, generation: 1 } }))
    .toMatchObject({ status: 409, body: { error: { code: 'session-assignment' } } })
  expect(await h.submit('retries', { session: { id, generation: 1 }, maxAttempts: 2 }))
    .toMatchObject({ status: 400, body: { error: { code: 'native-turn-plan' } } })
  expect((await h.send(`/v1/sessions/${id}/replace`, { generation: Number.MAX_SAFE_INTEGER, handoff: 'Verified' })).status).toBe(400)
  expect(h.calls).toHaveLength(0)
  expect((await h.send(`/v1/sessions/${id}`)).body).toMatchObject({ session: { generation: 1, status: 'new' } })
})

it('reports shutdown during an admission policy as retryable without admitting a worker', async () => {
  const hook = { id: 'check-plan', command: process.execPath, args: [], events: ['admission' as const], timeoutMs: 1000,
    maxInputBytes: 1000, maxOutputBytes: 1000 }
  const evaluate = vi.fn<DeepCluster['evaluatePolicies']>(async (_hooks, _input, options) => await new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => { reject(new Error('Policy cancelled during shutdown', { cause: options.signal.reason })) }, { once: true })
  }))
  const h = await fixture({ policyHooks: [hook] }, undefined, false, evaluate)
  const pending = h.submit('shutting-down-policy')
  await expect.poll(() => evaluate.mock.calls.length).toBe(1)
  await h.runtime.dispose()
  expect(await pending).toMatchObject({ status: 503, body: { error: { code: 'shutting-down' } } })
  expect(h.calls).toHaveLength(0)
})

it('refuses plans through host admission hooks without dispatching or silently overriding their decision', async () => {
  const hook = { id: 'check-plan', command: process.execPath, args: [], events: ['admission' as const], timeoutMs: 1000,
    maxInputBytes: 1000, maxOutputBytes: 1000 }
  const evaluate = vi.fn<DeepCluster['evaluatePolicies']>(async () => [{ hookId: hook.id, event: 'admission', decision: 'require-review', reason: 'A reviewer must approve this change.' }])
  const h = await fixture({ policyHooks: [hook] }, undefined, false, evaluate)
  expect(await h.submit('policy-refusal')).toMatchObject({ status: 409, body: { error: { code: 'policy-require-review' } } })
  expect(h.calls).toHaveLength(0)
  expect((await new Journal(h.root).read()).some(event => event.type === 'policy/decision' && event.data.decision === 'require-review')).toBe(true)
  evaluate.mockResolvedValue([{ hookId: hook.id, event: 'admission', decision: 'allow', reason: 'Reviewed outside the hook.' }])
  const accepted = apiOperationViewSchema.parse((await h.submit('policy-refusal')).body)
  expect(accepted.policy).toMatchObject([{ hookId: hook.id, decision: 'allow' }])
  expect((await h.submit('policy-refusal')).status).toBe(202)
  expect(evaluate).toHaveBeenCalledTimes(2)
})

it('fails a wakeup once when its native generation has been replaced', async () => {
  const h = await fixture({ wakeupPollIntervalMs: 20, wakeupRetryDelayMs: 20 }), id = randomUUID()
  await h.send('/v1/sessions', { id, workspace: h.root, title: 'Assigned tester', role: 'tester' })
  const source = apiOperationViewSchema.parse((await h.submit('source')).body)
  await expect.poll(() => h.calls.length).toBe(1)
  const wake = { id: randomUUID(), run: { workspace: h.root, plans: [plan], session: { id, generation: 1 } },
    trigger: { kind: 'operation', operationId: source.operationId, when: 'settled' }, expiresAtISO: new Date(Date.now() + 60_000).toISOString() }
  expect((await h.send('/v1/wakeups', wake)).status).toBe(202)
  expect((await h.send(`/v1/sessions/${id}/replace`, { generation: 1, handoff: 'New assignment evidence' })).status).toBe(200)
  h.calls[0]?.finish()
  await expect.poll(async () => (await h.send(`/v1/wakeups/${wake.id}`)).body)
    .toMatchObject({ wakeup: { status: 'failed', attempts: 1, error: { code: 'session-generation' } } })
  expect(h.calls).toHaveLength(1)
})

it('fences further admission after a policy range cannot be confirmed empty and retains the diagnostic after restart', async () => {
  const hook = { id: 'check-plan', command: process.execPath, args: [], events: ['admission' as const], timeoutMs: 1000,
    maxInputBytes: 1000, maxOutputBytes: 1000 }
  const evaluate = vi.fn<DeepCluster['evaluatePolicies']>(async () => { throw new ProcessCleanupError('policy range remains live') })
  const h = await fixture({ policyHooks: [hook] }, undefined, false, evaluate)
  expect(await h.submit('policy-uncertain')).toMatchObject({ status: 503, body: { error: { code: 'policy-cleanup-unconfirmed' } } })
  expect(await h.submit('another-policy')).toMatchObject({ status: 503, body: { error: { code: 'recovery-admission-blocked' } } })
  await h.restart()
  expect(await h.submit('after-restart')).toMatchObject({ status: 503, body: { error: { code: 'recovery-admission-blocked' } } })
  expect((await h.send('/v1/health')).body).toMatchObject({ status: 'ready', admissionBlocked: true,
    recoveryIssues: [expect.objectContaining({ kind: 'policy-hook', blocksAdmission: true })] })
  expect(evaluate).toHaveBeenCalledTimes(1)
  expect(h.calls).toHaveLength(0)
})

it('pins adopted knowledge before admission and preserves that selection across edits, retries, and restart', async () => {
  const h = await fixture(), id = randomUUID(), workspace = encodeURIComponent(h.root)
  const content = { id, expectedRevision: 0, kind: 'protocol', title: 'Review changes', body: 'Inspect changed paths before accepting work.',
    constraints: { requireReviewAfterWrites: ['reviewer'], requiredAcceptanceLabels: ['reviewed'] } }
  const create = await h.send(`/v1/knowledge?workspace=${workspace}`, content)
  expect(create.status).toBe(200)
  expect(z.object({ record: knowledgeRevisionSchema }).parse(create.body).record).toMatchObject({ revision: 1, state: 'proposed' })
  const input = { workspace: h.root, plans: [plan], knowledge: [{ id, revision: 1 }] }
  expect((await h.send('/v1/plans/validate', input)).status).toBe(409)
  expect((await h.send('/v1/runs', input)).status).toBe(409)
  expect(h.calls).toHaveLength(0)
  expect((await h.send(`/v1/knowledge/${id}/transition?workspace=${workspace}`, { expectedRevision: 1, state: 'adopted' })).status).toBe(200)
  const invalid = { ...input, knowledge: [{ id, revision: 2 }] }
  expect(await h.send('/v1/runs', invalid)).toMatchObject({ status: 409, body: { error: { code: 'protocol-violation' } } })
  const reviewed = `${plan}\n\n## Step review: independent review\nrole: reviewer\naccess: read-only\nhardware: none\nacceptance:\n- reviewed\n\nReview the preceding changes.`
  const request = { ...invalid, plans: [reviewed] }, headers = { 'Idempotency-Key': 'pinned-knowledge' }
  expect((await h.send('/v1/plans/validate', request)).status).toBe(200)
  const accepted = apiOperationViewSchema.parse((await h.send('/v1/runs', request, headers)).body)
  await expect.poll(() => h.calls.length).toBe(1)
  expect(h.calls[0]?.options.knowledge).toEqual(accepted.knowledge)
  expect(accepted.knowledge?.[0]).toMatchObject({ id, revision: 2, state: 'adopted', body: content.body })
  expect((await h.send(`/v1/knowledge?workspace=${workspace}`, { ...content, expectedRevision: 2, body: 'Changed guidance awaiting review.' })).status).toBe(200)
  const retry = apiOperationViewSchema.parse((await h.send('/v1/runs', request, headers)).body)
  expect(retry.operationId).toBe(accepted.operationId)
  expect(retry.knowledge).toEqual(accepted.knowledge)
  expect((await h.send('/v1/runs', request, { 'Idempotency-Key': 'new-selection' })).status).toBe(409)
  expect(h.calls).toHaveLength(1)
  h.calls[0]?.finish()
  await expect.poll(async () => apiOperationViewSchema.parse((await h.send(`/v1/runs/${accepted.operationId}`)).body).status).toBe('completed')
  await h.restart()
  const retained = apiOperationViewSchema.parse((await h.send(`/v1/runs/${accepted.operationId}`)).body)
  expect(retained.knowledge).toEqual(accepted.knowledge)
  expect((await h.send(`/v1/knowledge/${id}/usage?workspace=${workspace}&revision=2`)).body).toMatchObject({ count: 1, truncated: false,
    runs: [{ operationId: accepted.operationId, status: 'completed' }] })
  expect((await h.send('/v1/runs', request, headers)).status).toBe(202)
  expect(h.calls).toHaveLength(1)
  expect(h.errors).toEqual([])
})

it('retains document history, rejects stale writes, and accepts lessons only with retained terminal evidence', async () => {
  const h = await fixture(), id = randomUUID(), workspace = encodeURIComponent(h.root)
  const content = { id, expectedRevision: 0, kind: 'document', title: 'Handoff', body: 'Verified output and open questions.' }
  expect((await h.send(`/v1/knowledge?workspace=${workspace}`, content)).status).toBe(200)
  expect((await h.send(`/v1/knowledge?workspace=${workspace}`, content)).status).toBe(409)
  expect((await h.send(`/v1/knowledge?workspace=${workspace}`, { ...content, expectedRevision: 1, body: 'Revised handoff.' })).status).toBe(200)
  expect((await h.send(`/v1/knowledge/${id}?workspace=${workspace}&revision=1`)).body).toMatchObject({ record: { body: content.body, revision: 1 } })
  expect((await h.send(`/v1/knowledge/${id}?workspace=${workspace}`)).body).toMatchObject({ record: { body: 'Revised handoff.', revision: 2 } })
  const operation = apiOperationViewSchema.parse((await h.submit('lesson-evidence')).body)
  await expect.poll(() => h.calls.length).toBe(1)
  const lesson = { id: randomUUID(), expectedRevision: 0, kind: 'lesson', title: 'Result', body: 'Inspect the recorded outcome.',
    evidence: [{ operationId: operation.operationId }] }
  expect((await h.send(`/v1/knowledge?workspace=${workspace}`, lesson)).status).toBe(400)
  h.calls[0]?.finish()
  await expect.poll(async () => apiOperationViewSchema.parse((await h.send(`/v1/runs/${operation.operationId}`)).body).status).toBe('completed')
  expect((await h.send(`/v1/knowledge?workspace=${workspace}`, lesson)).status).toBe(200)
  const badLesson = { ...lesson, id: randomUUID(), evidence: [{ operationId: operation.operationId, stepId: 'absent' }] }
  expect((await h.send(`/v1/knowledge?workspace=${workspace}`, badLesson)).status).toBe(400)
  const inventory = z.object({ records: z.array(z.object({ id: z.string() })), cursor: z.string().nullable(), more: z.boolean() })
  const first = inventory.parse((await h.send(`/v1/knowledge?workspace=${workspace}&limit=1`)).body)
  expect(first.more).toBe(true)
  const next = inventory.parse((await h.send(`/v1/knowledge?workspace=${workspace}&limit=1&after=${first.cursor}`)).body)
  expect(new Set([...first.records, ...next.records].map(record => record.id)).size).toBe(2)
  expect(next.more).toBe(false)
  const briefing = await h.send(`/v1/briefing?workspace=${workspace}&limit=1`)
  expect(briefing.status).toBe(200)
  expect(briefing.body).toMatchObject({ counts: { records: 2, lessons: 1, runs: 1 }, truncated: { records: true } })
  expect(JSON.stringify(briefing.body)).not.toContain(content.body)
  expect((await h.send(`/v1/knowledge/${randomUUID()}?workspace=${workspace}`)).status).toBe(404)
  expect((await h.send(`/v1/knowledge/${id}/usage?workspace=${workspace}`)).status).toBe(400)
  expect((await h.send(`/v1/briefing?workspace=${workspace}&limit=0`)).status).toBe(400)
  expect(h.errors).toEqual([])
})

it('rejects malformed, oversized, or cross-workspace knowledge selections before creating runs', async () => {
  const h = await fixture({ maxKnowledgeBodyBytes: 12 }), id = randomUUID(), workspace = encodeURIComponent(h.root)
  const content = { id, expectedRevision: 0, kind: 'document', title: 'short', body: 'small body' }
  expect((await h.send(`/v1/knowledge?workspace=${workspace}`, { ...content, body: 'x'.repeat(13) })).status).toBe(413)
  expect((await h.send(`/v1/knowledge?workspace=${workspace}`, { ...content, expectedRevision: undefined })).status).toBe(400)
  expect((await h.send(`/v1/knowledge?workspace=${workspace}`, content)).status).toBe(200)
  const other = path.join(h.root, 'other'); await mkdir(other)
  expect((await h.send('/v1/runs', { workspace: other, plans: [plan], knowledge: [{ id, revision: 1 }] })).status).toBe(404)
  expect((await h.send('/v1/runs', { workspace: h.root, plans: [plan], knowledge: [{ id, revision: 1 }, { id, revision: 1 }] })).status).toBe(400)
  expect((await h.send('/v1/runs', { workspace: h.root, plans: [plan], knowledge: [{ id, revision: 0 }] })).status).toBe(400)
  expect(h.calls).toHaveLength(0)
})

it('reports knowledge storage failure without cancelling an already admitted run', async () => {
  const h = await fixture()
  const operation = apiOperationViewSchema.parse((await h.submit('independent-of-knowledge')).body)
  await expect.poll(() => h.calls.length).toBe(1)
  await writeFile(path.join(h.config.stateDirectory, 'knowledge'), 'blocked collection directory')
  const mutation = await h.send(`/v1/knowledge?workspace=${encodeURIComponent(h.root)}`, {
    id: randomUUID(), expectedRevision: 0, kind: 'document', title: 'Reference', body: 'Retain this context.',
  })
  expect(mutation).toMatchObject({ status: 503, body: { error: { code: 'knowledge-state' } } })
  expect(h.errors).toHaveLength(1)
  expect(h.calls[0]?.options.signal?.aborted).toBe(false)
  h.calls[0]?.finish()
  await expect.poll(async () => apiOperationViewSchema.parse((await h.send(`/v1/runs/${operation.operationId}`)).body).status).toBe('completed')
})

it('admits ordinary plans without consuming a knowledge snapshot budget', async () => {
  const h = await fixture({ maxKnowledgeSnapshotBytes: 1 })
  expect((await h.send('/v1/plans/validate', { workspace: h.root, plans: [plan] })).status).toBe(200)
  expect((await h.submit('no-knowledge-budget')).status).toBe(202)
  await expect.poll(() => h.calls.length).toBe(1)
  expect(h.calls[0]?.options.knowledge).toBeUndefined()
})

it('lists retained runs over HTTP and preserves cursor order through settlement and API restart', async () => {
  const h = await fixture()
  const one = apiOperationViewSchema.parse((await h.submit('inventory-one')).body)
  const two = apiOperationViewSchema.parse((await h.submit('inventory-two')).body)
  const inventory = z.object({ runs: z.array(z.object({ operationId: z.string(), status: z.string() })),
    cursor: z.string().nullable(), more: z.boolean() })
  const initial = inventory.parse((await h.send('/v1/runs')).body)
  const first = inventory.parse((await h.send('/v1/runs?limit=1')).body)
  expect(first.runs).toEqual(initial.runs.slice(0, 1))
  expect(first.more).toBe(true)
  for (const call of h.calls) call.finish()
  for (const operation of [one, two]) {
    await expect.poll(async () => apiOperationViewSchema.parse((await h.send(`/v1/runs/${operation.operationId}`)).body).status).toBe('completed')
  }
  await h.restart()
  const second = inventory.parse((await h.send(`/v1/runs?after=${first.cursor}`)).body)
  expect(second.runs.map(item => item.operationId)).toEqual(initial.runs.slice(1).map(item => item.operationId))
  expect(second.runs[0]?.status).toBe('completed')
  expect(second).toMatchObject({ cursor: null, more: false })
  expect(h.calls).toHaveLength(2)
  expect((await h.send(`/v1/runs?status=completed&after=${first.cursor}`)).status).toBe(400)
  expect((await h.send('/v1/runs?attention=unknown')).status).toBe(400)
  expect((await h.send('/v1/runs?limit=0')).status).toBe(400)
  expect((await h.send('/v1/runs?limit=1&limit=2')).status).toBe(400)
  expect((await h.send('/v1/runs?after=invalid')).status).toBe(400)
  expect((await h.send('/v1/runs?unexpected=true')).status).toBe(400)
})

it('lists attention evidence without acknowledging deviations or exposing worker output and store metadata', async () => {
  const h = await fixture({}, async (_plan, workspace) => ({
    runId: randomUUID() as RunId, status: 'needs-ack', cleanupConfirmed: true,
    steps: [{ stepId: 'one', title: 'private-title', role: 'tester', attempts: 1, status: 'pass', summary: 'private-summary',
      checks: ['private-check'], changed: ['private-path'], auditProblem: 'private-audit' }],
    journalFile: path.join(workspace, 'private-journal'), openImprovisations: [{ id: 'private-open' }],
    failure: { stepId: 'one', output: 'private-output' },
  }))
  const submitted = apiOperationViewSchema.parse((await h.submit('private-idempotency-key')).body)
  const read = async () => apiOperationViewSchema.parse((await h.send(`/v1/runs/${submitted.operationId}`)).body)
  await expect.poll(async () => (await read()).status).toBe('needs-ack')
  const before = await read()
  const listed = await h.send(`/v1/runs?workspace=${encodeURIComponent(h.root)}&status=needs-ack&attention=true`)
  expect(listed.status).toBe(200)
  expect(listed.body).toMatchObject({ runs: [{ operationId: submitted.operationId, attention: ['needs-ack', 'audit-problem'], open: 1,
    counts: { total: 1, passed: 1, failed: 0, blocked: 0 } }], more: false, cursor: null })
  const text = JSON.stringify(listed.body)
  for (const omitted of ['private-', 'ownerPid', 'ownerStartTime', 'keyHash', 'requestHash', 'journalFile']) expect(text).not.toContain(omitted)
  expect(await read()).toEqual(before)
  expect((await h.send('/v1/runs?attention=false')).body).toEqual({ runs: [], cursor: null, more: false })
  expect((await h.send(`/v1/runs?workspace=${encodeURIComponent(path.join(h.root, 'other'))}`)).body).toEqual({ runs: [], cursor: null, more: false })
})

it('resolves workspace aliases and keeps removed workspaces discoverable by their recorded path', async () => {
  const h = await fixture()
  const workspace = path.join(h.root, 'physical'), alias = path.join(h.root, 'alias')
  await mkdir(workspace)
  await symlink(workspace, alias, process.platform === 'win32' ? 'junction' : 'dir')
  let operation
  try {
    operation = apiOperationViewSchema.parse((await h.submit('alias-workspace', { workspace: alias })).body)
    const query = `workspace=${encodeURIComponent(alias)}`
    expect((await h.send(`/v1/runs?${query}`)).body).toMatchObject({ runs: [{ operationId: operation.operationId, workspace: operation.workspace }] })
    expect((await h.send(`/v1/runs?${query}&${query}`)).status).toBe(400)
  } finally { await unlink(alias) }
  h.calls[0]!.finish()
  await expect.poll(async () => apiOperationViewSchema.parse((await h.send(`/v1/runs/${operation.operationId}`)).body).status).toBe('completed')
  await rm(workspace, { recursive: true, force: true })
  expect((await h.send(`/v1/runs?workspace=${encodeURIComponent(operation.workspace)}`)).body)
    .toMatchObject({ runs: [{ operationId: operation.operationId, status: 'completed' }] })
})

it('persists explicit teardown evidence for a normally failed operation', async () => {
  const h = await fixture({}, async (_plan, workspace) => ({ runId: randomUUID() as RunId, status: 'failed',
    cleanupConfirmed: true, steps: [], journalFile: new Journal(workspace).file, openImprovisations: [] }))
  const submitted = apiOperationViewSchema.parse((await h.submit('settled-failure')).body)
  await expect.poll(async () => apiOperationViewSchema.parse((await h.send(`/v1/runs/${submitted.operationId}`)).body).status).toBe('failed')
  const saved: unknown = JSON.parse(await readFile(path.join(h.config.stateDirectory, 'operations', `${apiHash('settled-failure')}.json`), 'utf8'))
  expect(saved).toMatchObject({ status: 'failed', error: null, result: { status: 'failed', cleanupConfirmed: true } })
})

it('deduplicates concurrent submissions and retains the observed run identity', async () => {
  const h = await fixture()
  const [first, second] = await Promise.all([h.submit('same-key'), h.submit('same-key')])
  expect([first.status, second.status]).toEqual([202, 202])
  const operation = apiOperationViewSchema.parse(first.body)
  expect(apiOperationViewSchema.parse(second.body).operationId).toBe(operation.operationId)
  expect(h.calls).toHaveLength(1)
  expect((await h.submit('same-key', { maxAttempts: 1 })).status).toBe(409)
  expect(h.calls[0]!.options.signal?.aborted).toBe(false)
  h.calls[0]!.finish()
  await expect.poll(async () => apiOperationViewSchema.parse((await h.send(`/v1/runs/${operation.operationId}`)).body).status).toBe('completed')
  const settled = apiOperationViewSchema.parse((await h.send(`/v1/runs/${operation.operationId}`)).body)
  expect(settled.runId).toBe(h.calls[0]!.runId)
  expect(h.errors).toEqual([])
})

it('generates an Idempotency-Key when the header is absent', async () => {
  const h = await fixture()
  const accepted = await h.submit(undefined)
  expect(accepted.status).toBe(202)
  expect(h.calls).toHaveLength(1)
  const operation = apiOperationViewSchema.parse(accepted.body)
  h.calls[0]!.finish()
  await expect.poll(async () => apiOperationViewSchema.parse((await h.send(`/v1/runs/${operation.operationId}`)).body).status).toBe('completed')
})

it('submits a Markdown plan body with run options from the query', async () => {
  const h = await fixture()
  const route = `/v1/runs?workspace=${encodeURIComponent(h.root)}&maxConcurrency=2&timeoutMs=5000&maxAttempts=1&maxRepairs=0`
  const accepted = await h.sendText(route, plan)
  expect(accepted.status).toBe(202)
  const call = h.calls[0]!
  expect(call.plan).toMatchObject({ title: 'API test', goal: 'inspect a fixture', steps: [{ id: 'one' }] })
  expect(call.options).toMatchObject({ maxConcurrency: 2, timeoutMs: 5000, maxAttempts: 1, maxRepairs: 0 })
  expect((await h.sendText(`/v1/runs?workspace=${encodeURIComponent(h.root)}&maxConcurrency=nope`, plan)).status).toBe(400)
  expect((await h.sendText('/v1/runs', plan)).status).toBe(400)
  call.finish()
})

it('holds a POST /v1/runs response until the run settles and returns the report view', async () => {
  const h = await fixture()
  let answered = false
  const pending = h.send('/v1/runs?wait=10&view=report', { workspace: h.root, plans: [plan] }).then((value) => { answered = true; return value })
  await expect.poll(() => h.calls.length).toBe(1)
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(answered).toBe(false)
  h.calls[0]!.finish()
  const report = await pending
  expect(report.status).toBe(202)
  expect(report.body).toMatchObject({ status: 'completed', error: null, steps: [], open: [] })
  expect(report.body).not.toHaveProperty('progress')
})

it('accepts wait and view=report on GET and returns the compact run report', async () => {
  let release!: () => void
  const h = await fixture({}, async (_plan, workspace, options) => {
    const runId = randomUUID() as RunId
    const step = { stepId: 'one', title: 'inspect', role: 'tester' as const }
    options.onEvent?.({ seq: 0, at: new Date().toISOString(), type: 'run/start', data: { runId } })
    options.onEvent?.({ seq: 1, at: new Date().toISOString(), type: 'step/start', data: { runId, ...step } })
    await new Promise<void>((resolve) => { release = resolve })
    options.onEvent?.({ seq: 2, at: new Date().toISOString(), type: 'step/end',
      data: { runId, ...step, attempts: 1, status: 'pass', summary: 'ok' } })
    return { runId, status: 'completed' as const,
      steps: [{ ...step, attempts: 1, status: 'pass' as const, summary: 'ok', checks: ['inspected: yes'],
        changed: ['evidence.txt'], auditProblem: 'audit note' }],
      journalFile: new Journal(workspace).file, openImprovisations: [{ id: 'deviation' }] }
  })
  const accepted = await h.send('/v1/runs?view=report', { workspace: h.root, plans: [plan] })
  expect(accepted).toMatchObject({ status: 202, body: { status: 'running', open: [] } })
  const operationId = (accepted.body as { operationId: string }).operationId
  const started = Date.now()
  const waited = await h.send(`/v1/runs/${operationId}?wait=1&view=report`)
  expect(waited).toMatchObject({ status: 200, body: { status: 'running' } })
  expect(Date.now() - started).toBeGreaterThanOrEqual(900)
  const pending = h.send(`/v1/runs/${operationId}?wait=10&view=report`)
  await new Promise(resolve => setTimeout(resolve, 50))
  release()
  const report = await pending
  expect(report.body).toEqual({
    operationId, status: 'completed', error: null,
    steps: [{ id: 'one', role: 'tester', status: 'pass', attempts: 1, summary: 'ok',
      checks: ['inspected: yes'], changed: ['evidence.txt'], auditProblem: 'audit note' }],
    open: ['deviation'],
  })
})

it('aborts admitted workers on an admission write failure and joins their delayed teardown', async () => {
  const h = await fixture()
  const operation = apiOperationViewSchema.parse((await h.submit('A')).body)
  const call = h.calls[0]!
  await mkdir(path.join(h.config.stateDirectory, 'operations', `${apiHash('B')}.json`))
  expect((await h.submit('B')).status).toBe(503)
  expect(call.options.signal?.aborted).toBe(true)
  expect(h.calls).toHaveLength(1)
  expect((await h.send(`/v1/runs/${operation.operationId}`)).status).toBe(503)
  let joined = false
  const disposal = h.runtime.dispose().then(() => { joined = true })
  const lockFile = path.join(h.config.stateDirectory, 'api-owner.lock')
  expect(await readFile(lockFile, 'utf8')).toContain('owner')
  expect(joined).toBe(false)
  call.finish(); await disposal
  expect(joined).toBe(true)
  await expect(readFile(lockFile)).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each([
  ['active capacity', { maxActiveRuns: 1 }, 429],
  ['retention capacity', { maxOperations: 1 }, 503],
] as const)('keeps admitted workers alive when %s refuses another submission', async (_name, options, status) => {
  const h = await fixture(options)
  await h.submit('A')
  expect((await h.submit('B')).status).toBe(status)
  expect(h.calls[0]!.options.signal?.aborted).toBe(false)
  expect((await h.send('/v1/health')).status).toBe(200)
})

it('validates and combines plans over loopback HTTP without retaining or dispatching a run', async () => {
  const h = await fixture()
  const body = { workspace: h.root, plans: [plan] }
  const response = await h.send('/v1/plans/validate', body)
  expect(response).toMatchInlineSnapshot(`
    {
      "body": {
        "plan": {
          "goal": "inspect a fixture",
          "hardware": [],
          "steps": [
            {
              "acceptance": [
                "inspected",
              ],
              "detail": "Read the fixture.",
              "hardware": "none",
              "id": "one",
              "role": "tester",
              "title": "inspect",
            },
          ],
          "title": "API test",
        },
      },
      "status": 200,
    }
  `)
  const batch = await h.send('/v1/plans/validate', { ...body, plans: [plan, plan] })
  expect(batch.body).toMatchObject({ plan: { title: 'Batch of 2 plans', steps: [{ id: 'plan-1.one' }, { id: 'plan-2.one' }] } })
  const markdown = await h.sendText(`/v1/plans/validate?workspace=${encodeURIComponent(h.root)}&maxAttempts=1`, plan)
  expect(markdown).toMatchObject({ status: 200, body: { plan: { title: 'API test', goal: 'inspect a fixture' } } })
  expect((await h.sendText(`/v1/plans/validate?workspace=${encodeURIComponent(h.root)}`, plan, 'text/plain')).status).toBe(200)
  expect((await h.sendText('/v1/plans/validate', plan)).status).toBe(400)
  expect(h.calls).toHaveLength(0)
  expect(await readdir(path.join(h.config.stateDirectory, 'operations'))).toEqual([])
  await expect(readFile(new Journal(h.root).file)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('applies execution workspace, plan, and budget checks to validation requests', async () => {
  const h = await fixture()
  const body = { workspace: h.root, plans: [plan] }
  expect((await h.send('/v1/plans/validate', { ...body, workspace: path.join(h.root, 'missing') })).status).toBe(400)
  expect((await h.send('/v1/plans/validate', { ...body, plans: ['invalid'] })).status).toBe(400)
  expect((await h.send('/v1/plans/validate', { ...body, maxAttempts: h.config.maxAttempts + 1 })).status).toBe(400)
  const overBudget = plan.replace('role: tester', `role: tester\nmax_attempts: ${h.config.maxAttempts + 1}`)
  expect((await h.send('/v1/plans/validate', { ...body, plans: [overBudget] })).status).toBe(400)
  expect((await h.send('/v1/plans/validate', { ...body, unknown: true })).status).toBe(400)
  expect(h.calls).toHaveLength(0)
})

it('includes active API workspaces in dashboard observations until their operations settle', async () => {
  const h = await fixture(), other = path.join(h.root, 'another-workspace')
  await mkdir(other)
  const operation = apiOperationViewSchema.parse((await h.submit('another-workspace', { workspace: other })).body)
  await new Journal(other).record('run/start', { runId: h.calls[0]!.runId, title: 'Other workspace',
    steps: [{ id: 'other', title: 'Other worker', role: 'tester' }] })
  const endpoint = `/v1/dashboard?workspace=${encodeURIComponent(h.root)}`
  const active = await h.send(endpoint)
  expect(active.body).toMatchObject({ workspaces: [h.root, other], tasks: [{ title: 'Other worker' }] })
  h.calls[0]!.finish()
  await expect.poll(async () => apiOperationViewSchema.parse((await h.send(`/v1/runs/${operation.operationId}`)).body).status).toBe('completed')
  const settled = await h.send(endpoint)
  expect(settled.body).toMatchObject({ workspaces: [h.root], tasks: [] })
})

it('forwards bounded supervisor feedback only to an exact active-run participant', async () => {
  const h = await fixture()
  const operation = apiOperationViewSchema.parse((await h.submit('messages')).body)
  const call = h.calls[0]!
  const teamRoot = await createTeam(h.root, call.runId, ['one'])
  expect((await h.send(`/v1/runs/${operation.operationId}/messages`, { toStepId: 'two', message: 'hello' })).status).toBe(409)
  expect((await h.send(`/v1/runs/${operation.operationId}/messages`, { toStepId: 'one', message: 'x'.repeat(h.config.maxMessageChars + 1) })).status).toBe(400)
  const sent = await h.send(`/v1/runs/${operation.operationId}/messages`, { toStepId: 'one', message: 'check the fixture' })
  expect(sent.status).toBe(202)
  expect(sent.body).toMatchObject({ delivery: 'explicit-inbox-retrieval', message: { toStepId: 'one', fromStepId: 'supervisor' } })
  const mailbox = await TeamMailbox.open({ root: teamRoot, runId: call.runId, stepId: 'one', participants: ['one'] }, 4000, 10)
  expect((await mailbox.receive()).map(message => message.message)).toEqual(['check the fixture'])
  call.finish()
  await expect.poll(async () => apiOperationViewSchema.parse((await h.send(`/v1/runs/${operation.operationId}`)).body).status).toBe('completed')
  expect((await h.send(`/v1/runs/${operation.operationId}/messages`, { toStepId: 'one', message: 'late' })).status).toBe(409)
})

it('reports current API run ownership without rewriting unfinished historical tasks or leases', async () => {
  const h = await fixture(), journal = new Journal(h.root), oldRun = randomUUID()
  await journal.record('run/start', { runId: oldRun, title: 'Historical run', steps: [{ id: 'old', title: 'Old worker', role: 'tester' }] })
  await journal.record('agent/start', { runId: oldRun, stepId: 'old', role: 'tester' })
  await journal.record('lease/acquire', { runId: oldRun, stepId: 'old', resource: 'old-gpu' })
  const endpoint = `/v1/dashboard?workspace=${encodeURIComponent(h.root)}`
  expect((await h.send(endpoint)).body).toMatchObject({ activeRunIds: [], tasks: [{ status: 'running' }] })
  const operation = apiOperationViewSchema.parse((await h.submit('current')).body), call = h.calls[0]!
  await journal.record('run/start', { runId: call.runId, title: 'Current run', steps: [{ id: 'new', title: 'New worker', role: 'tester' }] })
  await journal.record('agent/start', { runId: call.runId, stepId: 'new', role: 'tester' })
  await journal.record('lease/acquire', { runId: call.runId, stepId: 'new', resource: 'current-gpu' })
  expect((await h.send(endpoint)).body).toMatchObject({ activeRunIds: [call.runId],
    tasks: [{ runId: oldRun, status: 'running' }, { runId: call.runId, status: 'running' }],
    leases: [{ resource: 'old-gpu' }, { resource: 'current-gpu' }] })
  call.finish()
  await expect.poll(async () => apiOperationViewSchema.parse((await h.send(`/v1/runs/${operation.operationId}`)).body).status).toBe('completed')
  expect((await h.send(endpoint)).body).toMatchObject({ activeRunIds: [],
    tasks: [{ runId: oldRun, status: 'running' }, { runId: call.runId, status: 'running' }] })
  expect((await journal.read()).filter(event => event.type === 'run/end')).toEqual([])
})

it.each(['maxTimeoutMs', 'requestTimeoutMs', 'defaultTimeoutMs', 'defaultLeaseTtlMs', 'defaultLeaseWaitMs'] as const)(
  'rejects %s beyond the Node timer maximum', (field) => {
    const root = process.cwd()
    expect(() => Config({ stateDirectory: root, leaseRoot: root, [field]: 2_147_483_648 })).toThrow()
  },
)

it('keeps active capacity through cancellation and waits for worker teardown before replying', async () => {
  const h = await fixture({ maxActiveRuns: 1 })
  const operation = apiOperationViewSchema.parse((await h.submit('first')).body)
  const call = h.calls[0]!
  let answered = false
  const cancel = h.send(`/v1/runs/${operation.operationId}/cancel`, {}).then((value) => { answered = true; return value })
  await expect.poll(() => call.options.signal?.aborted).toBe(true)
  expect(answered).toBe(false)
  expect((await h.submit('second')).status).toBe(429)
  expect(apiOperationViewSchema.parse((await h.send(`/v1/runs/${operation.operationId}`)).body).status).toBe('cancelling')
  call.finish()
  expect(apiOperationViewSchema.parse((await cancel).body).status).toBe('cancelled')
  expect((await h.submit('second')).status).toBe(202)
})

it('reports unconfirmed cleanup in status and health and blocks shutdown until explicitly confirmed', async () => {
  const h = await fixture({}, async (_plan, _workspace, options) => {
    const runId = randomUUID() as RunId
    options.onEvent?.({ seq: 0, at: new Date().toISOString(), type: 'run/start', data: { runId } })
    await new Promise<void>((resolve) => { options.signal?.addEventListener('abort', () => { resolve() }, { once: true }) })
    throw new ProcessCleanupError('descendant termination unconfirmed')
  })
  const operation = apiOperationViewSchema.parse((await h.submit('cleanup')).body)
  await expect.poll(async () => apiOperationViewSchema.parse((await h.send(`/v1/runs/${operation.operationId}`)).body).status).toBe('running')
  const cancelled = apiOperationViewSchema.parse((await h.send(`/v1/runs/${operation.operationId}/cancel`, {})).body)
  expect(cancelled.status).toBe('cancelled')
  expect(cancelled.error).toMatchObject({ code: 'cleanup-unconfirmed' })
  expect(cancelled.error?.message).toContain('descendant cleanup could not be confirmed')
  expect((await h.send('/v1/health')).body).toMatchObject({ activeRuns: 0, cleanupUnconfirmed: 1 })
  const refused = await h.send('/v1/service/shutdown', {})
  expect(refused.status).toBe(409)
  expect(refused.body).toMatchObject({ error: { code: 'cleanup-unconfirmed' } })
  expect(h.shutdowns).toHaveLength(0)
  expect((await h.send('/v1/service/shutdown', { confirmCleanupUnconfirmed: true })).status).toBe(202)
  await expect.poll(() => h.shutdowns.length).toBe(1)
})


it('stops admission and retains directory ownership until disposal joins accepted workers', async () => {
  const h = await fixture()
  await h.submit('shutdown')
  let stopped = false
  const disposal = h.runtime.dispose().then(() => { stopped = true })
  expect(h.calls[0]!.options.signal?.aborted).toBe(true)
  expect(stopped).toBe(false)
  expect((await h.send('/v1/health')).status).toBe(503)
  await expect(createApiRuntime(h.service, h.config, h.origin, () => {})).rejects.toThrow(/already owned/u)
  h.calls[0]!.finish(); await disposal
  await expect(readFile(path.join(h.config.stateDirectory, 'api-owner.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('refuses graceful shutdown while a run is admitted, then accepts it once idle without losing state', async () => {
  const h = await fixture()
  const operation = apiOperationViewSchema.parse((await h.submit('busy')).body)
  const refused = await h.send('/v1/service/shutdown', {})
  expect(refused.status).toBe(409)
  expect(h.shutdowns).toHaveLength(0)
  expect(h.calls[0]!.options.signal?.aborted).toBe(false)
  expect((await h.send('/v1/health')).status).toBe(200)
  expect(apiOperationViewSchema.parse((await h.send(`/v1/runs/${operation.operationId}`)).body).status).toBe('running')
  h.calls[0]!.finish()
  await expect.poll(async () => apiOperationViewSchema.parse((await h.send(`/v1/runs/${operation.operationId}`)).body).status).toBe('completed')
  expect((await h.send('/v1/health')).body).toMatchObject({ activeRuns: 0 })
  expect((await h.send('/v1/service/shutdown', {})).status).toBe(202)
  await expect.poll(() => h.shutdowns.length).toBe(1)
  expect((await h.send('/v1/health')).status).toBe(503)
})

it('accepts loopback callers without credentials but refuses browser-origin, rebound-host, invalid JSON, and out-of-budget requests', async () => {
  const h = await fixture()
  expect((await h.send('/v1/health', undefined, { authorization: 'Bearer ignored' })).status).toBe(200)
  expect((await h.send('/v1/health', undefined, { origin: 'null' })).status).toBe(403)
  expect((await h.send('/v1/health', undefined, { 'sec-fetch-site': 'same-origin' })).status).toBe(403)
  const rebound = await new Promise<number | undefined>((resolve, reject) => {
    const request = httpRequest(`${h.origin}/v1/health`, { headers: {
      host: `attacker.invalid:${new URL(h.origin).port}`,
    } }, (response) => { response.resume(); response.once('end', () => { resolve(response.statusCode) }) })
    request.once('error', reject); request.end()
  })
  expect(rebound).toBe(403)
  expect((await h.submit('bad', { maxConcurrency: h.config.maxConcurrency + 1 })).status).toBe(400)
  expect((await h.submit('bad', { plans: ['bad plan'] })).status).toBe(400)
  expect((await h.submit('bad', { unknownOption: true })).status).toBe(400)
  expect((await h.send(`/v1/runs?workspace=${encodeURIComponent(h.root)}`, { workspace: h.root, plans: [plan] })).status).toBe(400)
  expect((await h.sendText(`/v1/runs?workspace=${encodeURIComponent(h.root)}`, '{', 'application/json')).status).toBe(400)
  const invalid = await fetch(`${h.origin}/v1/runs`, { method: 'POST', headers: {
    'content-type': 'application/json', 'idempotency-key': 'bad',
  }, body: '{' })
  expect(invalid.status).toBe(400)
  expect(await invalid.json()).toMatchInlineSnapshot(`
    {
      "error": {
        "code": "invalid-json",
        "message": "The request body must contain valid UTF-8 JSON.",
      },
    }
  `)
  expect(h.calls).toHaveLength(0)
})

it('bounds chunked bodies and aborts incomplete intake during disposal', async () => {
  const h = await fixture({ maxBodyBytes: 64 })
  const response = await new Promise<number | undefined>((resolve, reject) => {
    const request = httpRequest(`${h.origin}/v1/runs`, { method: 'POST', headers: {
      'content-type': 'application/json', 'idempotency-key': 'oversized',
    } }, (reply) => { reply.resume(); reply.once('end', () => { resolve(reply.statusCode) }) })
    request.once('error', reject); request.write(' '.repeat(100)); request.end()
  })
  expect(response).toBe(413)
  let started!: () => void
  const ready = new Promise<void>((resolve) => { started = resolve })
  const pending = new Promise<number | undefined>((resolve, reject) => {
    const request = httpRequest(`${h.origin}/v1/runs`, { method: 'POST', headers: {
      'content-type': 'application/json', 'idempotency-key': 'incomplete',
    } }, (reply) => { reply.resume(); reply.once('end', () => { resolve(reply.statusCode) }) })
    onTestFinished(() => { request.destroy() })
    request.once('error', reject); request.flushHeaders(); request.write('{', started)
  })
  await ready
  await h.runtime.dispose()
  expect(await pending).toBe(503)
})

it('returns journal, ledger, lease, dashboard, and idempotent acknowledgement views', async () => {
  const h = await fixture(), journal = new Journal(h.root), runId = randomUUID()
  await journal.record('run/start', { runId, title: 'HTTP fixture', steps: [] })
  await journal.record('improvisation/report', { id: 'decision', runId, kind: 'deviation', reason: 'Fixture' })
  const workspace = encodeURIComponent(h.root)
  expect(z.object({ events: z.array(z.unknown()) }).parse((await h.send(`/v1/journal?workspace=${workspace}&tail=1`)).body).events).toHaveLength(1)
  expect((await h.send(`/v1/ledger?workspace=${workspace}&tail=1`)).body).toEqual({ workspace: h.root, roles: [] })
  expect((await h.send(`/v1/dashboard?workspace=${workspace}&eventLimit=1`)).status).toBe(200)
  const lease = await acquireLease(h.config.leaseRoot, 'gpu0', { owner: 'test', waitMs: 0 })
  try {
    const response = await h.send('/v1/leases?resource=gpu0')
    expect(response.status).toBe(200)
    expect(JSON.stringify(response.body)).not.toContain(lease.token)
    expect(response.body).toMatchObject({ resource: 'gpu0', held: { owner: 'test' } })
  } finally { await releaseLease(h.config.leaseRoot, lease) }
  expect((await h.send('/v1/ack', { workspace: h.root, id: 'decision' })).body).toEqual({ id: 'decision', status: 'acknowledged' })
  expect((await h.send('/v1/ack', { workspace: h.root, id: 'decision' })).status).toBe(200)
  expect((await h.send('/v1/ack', { workspace: h.root, id: 'decision', reject: true })).status).toBe(409)
  expect((await journal.read()).filter(event => event.type === 'improvisation/ack')).toHaveLength(1)
  expect((await h.send(`/v1/journal?workspace=${workspace}&tail=0`)).status).toBe(400)
  expect((await h.send(`/v1/journal?workspace=${workspace}&workspace=${workspace}`)).status).toBe(400)
})

it('counts task/outcome events rather than raw journal events for the ledger tail', async () => {
  const h = await fixture(), journal = new Journal(h.root), runId = randomUUID()
  const outcome = (stepId: string, role: string, status: 'pass' | 'fail') => ({
    runId, stepId, title: stepId, role, status, summary: status === 'pass' ? 'ok' : 'rejected',
    acceptance: [`${stepId} checked`], checks: [`${stepId} checked: yes`], durationMs: 1,
  })
  await journal.record('run/start', { runId })
  await journal.record('task/outcome', outcome('a', 'tester', 'pass'))
  await journal.record('agent/activity', { runId, stepId: 'a', kind: 'command', detail: 'test' })
  await journal.record('task/outcome', outcome('b', 'builder', 'fail'))
  await journal.record('step/queued', { runId })
  const workspace = encodeURIComponent(h.root)
  expect((await h.send(`/v1/ledger?workspace=${workspace}&tail=1`)).body).toEqual({
    workspace: h.root,
    roles: [{ role: 'builder', passed: 0, failed: 1, blocked: 0,
      examples: [{ runId, stepId: 'b', title: 'b', role: 'builder', status: 'fail', summary: 'rejected',
        acceptance: ['b checked'], checks: ['b checked: yes'], durationMs: 1,
        at: expect.any(String) as unknown }] }],
  })
  const both = await h.send(`/v1/ledger?workspace=${workspace}&tail=2&runId=${runId}`)
  expect(both.body).toMatchObject({ roles: [
    { role: 'tester', passed: 1, examples: [{ stepId: 'a' }] },
    { role: 'builder', failed: 1, examples: [{ stepId: 'b' }] },
  ] })
})

it('settles a needs-ack operation when its last open improvisation is resolved', async () => {
  const h = await fixture({}, async (_plan, workspace, options) => {
    const runId = randomUUID() as RunId
    options.onEvent?.({ seq: 0, at: new Date().toISOString(), type: 'run/start', data: { runId } })
    const journal = new Journal(workspace)
    await journal.record('improvisation/report', { id: 'first', runId, kind: 'deviation', reason: 'first' })
    await journal.record('improvisation/report', { id: 'second', runId, kind: 'addition', reason: 'second' })
    return { runId, status: 'needs-ack' as const,
      steps: [{ stepId: 'one', title: 'inspect', role: 'tester' as const, attempts: 1, status: 'pass' as const,
        summary: 'ok', checks: ['inspected: yes'], changed: [] }],
      journalFile: journal.file, openImprovisations: [{ id: 'first' }, { id: 'second' }] }
  })
  const operation = apiOperationViewSchema.parse((await h.submit('needs-ack')).body)
  const read = async () => apiOperationViewSchema.parse((await h.send(`/v1/runs/${operation.operationId}`)).body)
  await expect.poll(async () => (await read()).status).toBe('needs-ack')
  expect((await h.send('/v1/ack', { workspace: h.root, id: 'first' })).status).toBe(200)
  expect((await read()).status).toBe('needs-ack')
  expect((await read()).result?.openImprovisations).toEqual([expect.objectContaining({ id: 'second', kind: 'addition' })])
  expect((await h.send('/v1/ack', { workspace: h.root, id: 'second' })).status).toBe(200)
  expect((await read()).status).toBe('completed')
  expect((await h.send('/v1/ack', { workspace: h.root, id: 'second' })).status).toBe(200)
  expect((await read()).status).toBe('completed')
})

it('fails a needs-ack operation as improvisation-rejected when any is rejected, including replay', async () => {
  const h = await fixture({}, async (_plan, workspace, options) => {
    const runId = randomUUID() as RunId
    options.onEvent?.({ seq: 0, at: new Date().toISOString(), type: 'run/start', data: { runId } })
    const journal = new Journal(workspace)
    await journal.record('improvisation/report', { id: 'changed-scope', runId, kind: 'deviation', reason: 'scope' })
    return { runId, status: 'needs-ack' as const,
      steps: [{ stepId: 'one', title: 'inspect', role: 'tester' as const, attempts: 1, status: 'pass' as const,
        summary: 'ok', checks: [], changed: [] }],
      journalFile: journal.file, openImprovisations: [{ id: 'changed-scope' }] }
  })
  const operation = apiOperationViewSchema.parse((await h.submit('rejected')).body)
  const read = async () => apiOperationViewSchema.parse((await h.send(`/v1/runs/${operation.operationId}`)).body)
  await expect.poll(async () => (await read()).status).toBe('needs-ack')
  expect((await h.send('/v1/ack', { workspace: h.root, id: 'changed-scope', reject: true })).status).toBe(200)
  expect(await read()).toMatchObject({ status: 'failed', error: { code: 'improvisation-rejected' },
    result: { status: 'failed', openImprovisations: [] } })
  expect((await h.send('/v1/ack', { workspace: h.root, id: 'changed-scope', reject: true })).status).toBe(200)
  expect((await read()).status).toBe('failed')
})

it('serves run-scoped incremental journal pages and rejects invalid cursors', async () => {
  const h = await fixture(), journal = new Journal(h.root), runA = randomUUID(), runB = randomUUID()
  for (let index = 0; index < 6; index++) {
    await journal.record('step/queued', { runId: index % 2 === 0 ? runA : runB, index })
  }
  const workspace = encodeURIComponent(h.root)
  const first = await h.send(`/v1/journal?workspace=${workspace}&runId=${runA}&limit=2`)
  expect(first.status).toBe(200)
  const page = first.body as { events: { data: { index: number } }[]; cursor: string; more: boolean; reset: boolean }
  expect(page.events.map(event => event.data.index)).toEqual([0, 2])
  expect(page.more).toBe(true)
  expect(page.reset).toBe(false)
  const second = await h.send(`/v1/journal?workspace=${workspace}&runId=${runA}&limit=2&after=${encodeURIComponent(page.cursor)}`)
  const next = second.body as { events: { data: { index: number } }[]; more: boolean }
  expect(next.events.map(event => event.data.index)).toEqual([4])
  expect(next.more).toBe(false)
  expect((await h.send(`/v1/journal?workspace=${workspace}&after=not-a-cursor`)).status).toBe(400)
  const ledger = await h.send(`/v1/ledger?workspace=${workspace}&runId=${runA}&limit=2`)
  expect(ledger.body).toMatchObject({ roles: [] })
  expect(typeof (ledger.body as { cursor?: unknown }).cursor).toBe('string')
})

it('reports safe execution diagnostics without connection secrets', async () => {
  const h = await fixture()
  const health = await h.send('/v1/health')
  expect(health.status).toBe(200)
  expect(health.body).toMatchObject({
    execution: {
      profile: 'cluster',
      cli: { configured: 'dsh', kind: 'path-command' },
      permission: { mode: 'danger-full-access', childProfileVerified: false },
      dshPath: { configured: h.root, exists: true },
    },
  })
  const text = JSON.stringify(health.body)
  expect(text).not.toContain('apiTokenFile')
  expect(text).not.toContain('authorization')
})

it('keeps operation status advancing with bounded progress and no per-token durable writes', async () => {
  let drive: ((type: JournalEventType, data: Record<string, unknown>) => void) | undefined
  let release!: () => void
  const h = await fixture({}, async (plan, workspace, options) => {
    void plan
    const runId = randomUUID() as RunId
    const emit = (type: JournalEventType, data: Record<string, unknown>): void => {
      options.onEvent?.({ seq: 0, at: new Date().toISOString(), type, data: { runId, ...data } })
    }
    emit('run/start', {})
    emit('step/queued', { stepId: 'one', title: 'inspect', role: 'tester' })
    emit('step/start', { stepId: 'one', title: 'inspect', role: 'tester' })
    emit('agent/start', { stepId: 'one', role: 'tester', attempt: 1 })
    emit('lease/wait', { stepId: 'one', role: 'tester', attempt: 1, resource: 'gpu0' })
    drive = emit
    await new Promise<void>((resolve) => { release = resolve })
    emit('agent/end', { stepId: 'one', role: 'tester', attempt: 1, exitCode: 0 })
    emit('step/end', { stepId: 'one', title: 'inspect', role: 'tester', attempts: 1, status: 'pass', summary: 'ok' })
    return { runId, status: 'completed' as const,
      steps: [{ stepId: 'one', title: 'inspect', role: 'tester' as const, attempts: 1, status: 'pass' as const,
        summary: 'ok', checks: ['inspected'], changed: ['evidence.txt'] }],
      journalFile: new Journal(workspace).file, openImprovisations: [] }
  })
  const saves = vi.spyOn(ApiOperationStore.prototype, 'save')
  onTestFinished(() => { saves.mockRestore() })
  const operation = apiOperationViewSchema.parse((await h.submit('progress')).body)
  await expect.poll(() => drive !== undefined).toBe(true)
  const read = async () => apiOperationViewSchema.parse((await h.send(`/v1/runs/${operation.operationId}`)).body)
  await expect.poll(async () => (await read()).progress?.waiting).toBe(1)
  const waiting = await read()
  expect(waiting.progress).toMatchObject({ total: 1, waiting: 1, running: 0,
    steps: [{ stepId: 'one', status: 'waiting', waitingResource: 'gpu0' }], recentEvent: { type: 'lease/wait', stepId: 'one' } })
  const beforeTokens = saves.mock.calls.length
  for (let index = 0; index < 100; index++) {
    drive?.('agent/token-sample', { stepId: 'one', role: 'tester', attempt: 1, tokens: index,
      observedAt: Date.now(), basis: 'tokenizer', tokenizer: 'fixture' })
  }
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(saves.mock.calls.length).toBe(beforeTokens)
  const beforeProgress = saves.mock.calls.length
  for (let index = 0; index < 20; index++) {
    drive?.('gate/fail', { stepId: 'one', role: 'tester', attempt: 1, summary: 'retry' })
  }
  await new Promise(resolve => setTimeout(resolve, 1100))
  expect(saves.mock.calls.length - beforeProgress).toBeLessThanOrEqual(2)
  const beforeUpdated = waiting.updatedAt
  await new Promise(resolve => setTimeout(resolve, 5))
  drive?.('step/end', { stepId: 'one', title: 'inspect', role: 'tester', attempts: 1, status: 'pass', summary: 'ok' })
  const passed = await read()
  expect(passed.progress).toMatchObject({ passed: 1, running: 0, recentEvent: { type: 'step/end' } })
  expect(Date.parse(passed.updatedAt)).toBeGreaterThanOrEqual(Date.parse(beforeUpdated))
  release()
  await expect.poll(async () => (await read()).status).toBe('completed')
  const completed = await read()
  expect(completed.result?.steps[0]).toMatchObject({ checks: ['inspected'], changed: ['evidence.txt'] })
})

it('keeps a structured cancelled outcome and its progress instead of a missing report', async () => {
  const h = await fixture({}, async (plan, workspace, options) => {
    void plan
    const runId = randomUUID() as RunId
    const step = { stepId: 'one', title: 'inspect', role: 'tester' as const }
    options.onEvent?.({ seq: 0, at: new Date().toISOString(), type: 'run/start', data: { runId } })
    options.onEvent?.({ seq: 1, at: new Date().toISOString(), type: 'step/start', data: { runId, ...step } })
    await new Promise<void>((resolve) => { options.signal?.addEventListener('abort', () => { resolve() }, { once: true }) })
    options.onEvent?.({ seq: 2, at: new Date().toISOString(), type: 'step/end',
      data: { runId, ...step, attempts: 1, status: 'blocked', summary: 'cancelled during running' } })
    return { runId, status: 'cancelled' as const,
      steps: [{ ...step, attempts: 1, status: 'blocked' as const, summary: 'cancelled during running',
        checks: [], changed: [] }],
      journalFile: new Journal(workspace).file, openImprovisations: [] }
  })
  const operation = apiOperationViewSchema.parse((await h.submit('structured-cancel')).body)
  await expect.poll(async () => (await h.send(`/v1/runs/${operation.operationId}`)).body).toMatchObject({ status: 'running' })
  const report = await h.send(`/v1/runs/${operation.operationId}/cancel?view=report`, {})
  expect(report.body).toMatchObject({ operationId: operation.operationId, status: 'cancelled',
    steps: [{ id: 'one', status: 'blocked', attempts: 1, summary: 'cancelled during running' }] })
  const cancelled = apiOperationViewSchema.parse((await h.send(`/v1/runs/${operation.operationId}`)).body)
  expect(cancelled.status).toBe('cancelled')
  expect(cancelled.result).toMatchObject({ status: 'cancelled',
    steps: [{ stepId: 'one', status: 'blocked', summary: 'cancelled during running', checks: [], changed: [] }] })
  expect(cancelled.progress).toMatchObject({ total: 1, blocked: 1, recentEvent: { type: 'step/end' } })
})

it('reports a typed worker termination as a structured failure, not a missing report', async () => {
  const h = await fixture({}, async () => { throw new WorkerTerminationError('timeout', 'running') })
  const operation = apiOperationViewSchema.parse((await h.submit('typed-timeout')).body)
  await expect.poll(async () => apiOperationViewSchema.parse((await h.send(`/v1/runs/${operation.operationId}`)).body))
    .toMatchObject({ status: 'failed', error: { code: 'worker-timeout' } })
  const settled = apiOperationViewSchema.parse((await h.send(`/v1/runs/${operation.operationId}`)).body)
  expect(settled.error?.message).toContain('deadline')
  expect(h.errors).toHaveLength(1)
})
