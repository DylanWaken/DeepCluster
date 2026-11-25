/** Same-computer asynchronous HTTP operations whose lifetime includes worker and metadata teardown. */
import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { z } from 'zod'
import type DeepCluster from './index.ts'
import { combinePlans, parsePlan, PlanFormatError, type Plan } from './plan.ts'
import { ensureStateDirectory, Journal, JournalCursorError, summarize, type JournalCursor, type JournalEvent } from './journal.ts'
import { capabilityLedger } from './ledger.ts'
import { leaseStatus } from './lease.ts'
import { DashboardCache } from './api-dashboard.ts'
import { ApiOperationStore } from './api-store.ts'
import { listApiRuns } from './api-runs.ts'
import { sendSupervisorMessage, type TeamMessage } from './mailbox.ts'
import { admitApiRequest, readApiJson, readApiRunBody, sendApiJson } from './api-http.ts'
import { ApiError, apiAckSchema, apiOperationView, apiRunReport, isActiveOperation, resolveApiRun,
  type ApiConfig, type ApiOperation, type ApiOperationProgress, type ApiRunRequest, type OperationId } from './api-types.ts'
import { describeExecution, ProcessCleanupError, WorkerTerminationError } from './executor.ts'
import type { RunId } from './types.ts'
import { KnowledgeStore, KnowledgeStoreError } from './knowledge-store.ts'
import { knowledgeReferenceSchema, resolveKnowledgeWrite, resolveKnowledgeTransition } from './knowledge-types.ts'
import { KnowledgeConstraintError, validateKnowledgePlan } from './knowledge-bindings.ts'
import { knowledgeSummary, listKnowledgeUsage, readKnowledgeBriefing, validateLessonEvidence } from './api-knowledge.ts'
import { ClusterSessionError, ClusterSessionStore, clusterSessionCreateSchema, clusterSessionReferenceSchema,
  type ClusterSessionId } from './native-sessions.ts'
import { WakeupError, WakeupService, resolveWakeupRequest, type WakeupId } from './wakeups.ts'
import { policyHookSchema } from './policy-hooks.ts'
import { workerGenerationSettled } from './worker-recovery.ts'
import { recoveryIssue, replaceRecoveryIssues } from './recovery-issues.ts'
import { isOwnershipGeneration } from './ownership-generation.ts'

/** Request owner retained until all admitted workers and response handlers have settled. */
export interface ApiRuntime {
  /** Dispatch one request; declared failures are serialized as HTTP JSON. */
  handle(request: IncomingMessage, response: ServerResponse): Promise<void>
  /** Stop admission, abort intake and workers, and join their completion. */
  dispose(): Promise<void>
}

interface Job { readonly abort: AbortController; done: Promise<void>; phase: 'running' | 'settling' }

/** Preserve the same declared admission failures for HTTP callers and durable wakeups. */
function declaredApiFailure(error: unknown): ApiError | null {
  if (error instanceof ApiError) return error
  if (error instanceof KnowledgeStoreError || error instanceof ClusterSessionError || error instanceof WakeupError) {
    return new ApiError(error.status, error.code, error.message)
  }
  return error instanceof KnowledgeConstraintError ? new ApiError(409, 'protocol-violation', error.message) : null
}

/** Validate an authenticated workspace before admitting a run or acknowledging its journal. */
async function existingWorkspace(value: string): Promise<string> {
  try {
    const root = await realpath(value)
    if (!(await stat(root)).isDirectory()) throw new ApiError(400, 'invalid-workspace', 'The workspace must be an existing directory.')
    return root
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError(400, 'invalid-workspace', 'The workspace must be an accessible existing directory.')
  }
}

/** Resolve the same workspace, plan graph, and budgets for validation and execution. */
async function validateRunInput(value: unknown, config: ApiConfig): Promise<{ input: ApiRunRequest; plan: Plan }> {
  const resolved = resolveApiRun(value, config)
  const input = { ...resolved, workspace: await existingWorkspace(resolved.workspace) }
  let plan: Plan
  try { plan = combinePlans(input.plans.map(parsePlan)) } catch (error) {
    if (error instanceof PlanFormatError) throw new ApiError(400, 'invalid-plan', error.message)
    throw error
  }
  if (plan.steps.some(step => step.maxAttempts !== undefined && step.maxAttempts > config.maxAttempts)) {
    throw new ApiError(400, 'invalid-plan', `A plan step exceeds the API maxAttempts limit of ${config.maxAttempts}.`)
  }
  return { input, plan }
}

function query(url: URL, allowed: readonly string[], repeated: readonly string[] = []): void {
  for (const name of url.searchParams.keys()) {
    if (!allowed.includes(name) || (!repeated.includes(name) && url.searchParams.getAll(name).length !== 1)) {
      throw new ApiError(400, 'invalid-query', `Unexpected or repeated query parameter: ${name}`)
    }
  }
}

function workspaceQuery(url: URL): string {
  const workspace = url.searchParams.get('workspace')
  if (workspace === null || !path.isAbsolute(workspace)) throw new ApiError(400, 'invalid-workspace', 'An absolute workspace query parameter is required.')
  return path.resolve(workspace)
}

function boundedQuery(url: URL, name: string, maximum: number): number {
  const raw = url.searchParams.get(name)
  if (raw === null) return maximum
  if (!/^\d+$/u.test(raw) || Number(raw) < 1 || Number(raw) > maximum) {
    throw new ApiError(400, 'invalid-query', `${name} must be an integer between 1 and ${maximum}.`)
  }
  return Number(raw)
}

/** Run options a Markdown plan submission carries as query parameters, named as in the JSON request. */
const RUN_QUERY = ['workspace', 'maxConcurrency', 'timeoutMs', 'maxAttempts', 'maxRepairs'] as const

/** Maximum step entries in one status response; counts always cover the complete plan. */
const PROGRESS_STEP_LIMIT = 16
/** Durable progress writes are coalesced to at most one per second, never per activity event. */
const PROGRESS_WRITE_INTERVAL_MS = 1000

type ProgressStatus = 'queued' | 'running' | 'waiting' | 'pass' | 'fail' | 'blocked'
type StepRole = ApiOperationProgress['steps'][number]['role']

interface ProgressStep {
  readonly stepId: string
  readonly title: string
  readonly role: StepRole
  status: ProgressStatus
  attempt: number
  waitingResource?: string
}

interface ProgressState {
  readonly total: number
  readonly order: readonly string[]
  readonly steps: Map<string, ProgressStep>
  recentEvent: ApiOperationProgress['recentEvent']
}

/** Start every planned step queued so status is useful before the first coordinator event. */
function initialProgress(plan: Plan): ProgressState {
  const steps = new Map<string, ProgressStep>()
  for (const step of plan.steps) {
    steps.set(step.id, { stepId: step.id, title: step.title, role: step.role, status: 'queued', attempt: 0 })
  }
  return { total: plan.steps.length, order: plan.steps.map(step => step.id), steps, recentEvent: null }
}

/** Fold one coordinator journal event into the bounded progress projection. */
function updateProgress(state: ProgressState, event: JournalEvent): boolean {
  const data = event.data
  const stepId = typeof data.stepId === 'string' ? data.stepId : undefined
  if (stepId === undefined) return false
  const step = state.steps.get(stepId)
  if (step === undefined) return false
  const attempt = typeof data.attempt === 'number' && Number.isSafeInteger(data.attempt) && data.attempt >= 0
    ? data.attempt : step.attempt
  let changed = true
  switch (event.type) {
    case 'step/queued': step.status = 'queued'; break
    case 'step/start': step.status = 'running'; break
    case 'step/blocked': step.status = 'blocked'; break
    case 'step/end':
      if (data.status === 'pass' || data.status === 'fail' || data.status === 'blocked') step.status = data.status
      else changed = false
      break
    case 'agent/start': step.status = 'running'; step.attempt = attempt; break
    case 'lease/wait':
      step.status = 'waiting'; step.attempt = attempt
      if (typeof data.resource === 'string') step.waitingResource = data.resource.slice(0, 200)
      else delete step.waitingResource
      break
    case 'lease/acquire':
      delete step.waitingResource
      if (step.status === 'waiting') step.status = 'running'
      step.attempt = attempt
      break
    case 'lease/release':
    case 'lease/quarantine':
      delete step.waitingResource
      if (step.status === 'waiting') step.status = 'running'
      break
    case 'gate/pass':
    case 'gate/fail':
    case 'repair/start':
      break
    default: changed = false
  }
  if (!changed) return false
  state.recentEvent = { type: event.type, at: event.at, stepId,
    ...step.waitingResource === undefined ? {} : { detail: `waiting for ${step.waitingResource}` } }
  return true
}

/** Serialize the bounded public projection; active and waiting steps sort first. */
function progressView(state: ProgressState): ApiOperationProgress {
  const counts = { queued: 0, running: 0, waiting: 0, pass: 0, fail: 0, blocked: 0 }
  const steps = [...state.steps.values()]
  for (const step of steps) counts[step.status]++
  const priority: Record<ProgressStatus, number> = { running: 0, waiting: 1, queued: 2, fail: 3, blocked: 4, pass: 5 }
  steps.sort((left, right) => priority[left.status] - priority[right.status])
  return {
    total: state.total, queued: counts.queued, running: counts.running, waiting: counts.waiting,
    passed: counts.pass, failed: counts.fail, blocked: counts.blocked,
    steps: steps.slice(0, PROGRESS_STEP_LIMIT).map(step => ({
      stepId: step.stepId, title: step.title, role: step.role, status: step.status, attempt: step.attempt,
      ...step.waitingResource === undefined ? {} : { waitingResource: step.waitingResource },
    })),
    recentEvent: state.recentEvent,
  }
}

/**
 * Acquire the local API without starting workers; the caller owns route registration and disposal.
 * @param service - configured worker coordinator; request overrides never select a different worker profile.
 * @param config - resolved storage locations, defaults, and admission limits.
 * @param origin - actual dedicated loopback listener origin.
 * @param reportError - host diagnostic sink for failures whose details are not returned over HTTP.
 * @param requestShutdown - close the owning application after this response when no run is active.
 * @returns an authenticated handler and awaited shutdown operation.
 */
export async function createApiRuntime(service: Pick<DeepCluster, 'runPlan' | 'options'> & Partial<Pick<DeepCluster, 'evaluatePolicies'>>, config: ApiConfig,
  origin: string, reportError: (error: unknown) => void, requestShutdown: () => void = () => {}): Promise<ApiRuntime> {
  const store = new ApiOperationStore(config, undefined, process.platform === 'win32')
  const hooks = config.policyHooks.map(hook => policyHookSchema.parse(hook))
  if (new Set(hooks.map(hook => hook.id)).size !== hooks.length) throw new Error('DeepCluster policy hook IDs must be unique')
  if (hooks.some(hook => hook.events.includes('admission')) && service.evaluatePolicies === undefined) {
    throw new Error('The configured DeepCluster service must provide executable policy evaluation')
  }
  await store.initialize()
  try {
    const unresolved = []
    for (const issue of store.recoveryIssues) {
      if (issue.kind !== 'policy-hook' || !isOwnershipGeneration(issue.id) || !await workerGenerationSettled(config.stateDirectory, issue.id)) unresolved.push(issue)
    }
    if (unresolved.length !== store.recoveryIssues.length) {
      await replaceRecoveryIssues(config.stateDirectory, 'policy-hook', unresolved.filter(issue => issue.kind === 'policy-hook'))
      store.recoveryIssues.splice(0, store.recoveryIssues.length, ...unresolved)
    }
  } catch (error) { await store.dispose(); throw error }
  for (const issue of store.recoveryIssues) reportError(new Error(issue.message))
  const sessions = new ClusterSessionStore(config.stateDirectory, {
    maxRecords: config.maxNativeSessions, maxHandoffBytes: config.maxSessionHandoffBytes,
  })
  try { await sessions.initialize() } catch (error) { await store.dispose(); throw error }
  for (const issue of sessions.issues) reportError(new Error(`Native session ${issue.id}: ${issue.message}`))
  const knowledgeLimits = { maxRecords: config.maxKnowledgeRecords, maxBodyBytes: config.maxKnowledgeBodyBytes,
    maxReferences: config.maxKnowledgeReferences, maxSnapshotBytes: config.maxKnowledgeSnapshotBytes }
  const knowledgeStore = new KnowledgeStore(config.stateDirectory, knowledgeLimits)
  const dashboardCache = new DashboardCache()
  const jobs = new Map<OperationId, Job>(), requests = new Set<Promise<void>>(), shutdown = new AbortController()
  let closing = false, disposed: Promise<void> | undefined, admissions = 0
  const isClosing = (): boolean => closing

  const mutateState = async <T>(action: () => Promise<T>): Promise<T> => {
    try { return await action() } catch (error) {
      if ((!(error instanceof ApiError) && !(error instanceof KnowledgeStoreError) && !(error instanceof KnowledgeConstraintError)
        && !(error instanceof ClusterSessionError))
        || (error instanceof ApiError && error.code === 'state-unavailable')) {
        for (const job of jobs.values()) job.abort.abort(error)
      }
      throw error
    }
  }
  const save = async (record: ApiOperation): Promise<void> => {
    await mutateState(() => store.serialize(() => store.save(record)))
  }
  /**
   * Re-derive a retained `needs-ack` operation from its journal decisions; callers hold the store
   * serialization. With no open improvisation left, any rejection fails the run, otherwise it completes.
   */
  const settleAcknowledgedRun = async (events: readonly JournalEvent[], runId: unknown): Promise<void> => {
    const record = [...store.operations.values()].find(operation => operation.runId === runId && operation.status === 'needs-ack')
    if (record === undefined || record.result === null) return
    const runEvents = events.filter(event => event.data.runId === runId)
    const remaining = summarize(runEvents).openImprovisations.map(event => event.data)
    const rejected = remaining.length === 0 && runEvents.some(event => event.type === 'improvisation/reject')
    const status = remaining.length > 0 ? 'needs-ack' : rejected ? 'failed' : 'completed'
    if (status === 'needs-ack' && remaining.length === record.result.openImprovisations.length) return
    record.result = { ...record.result, status, openImprovisations: remaining }
    record.status = status
    if (rejected) {
      record.error = { code: 'improvisation-rejected', message: 'The supervisor rejected a reported plan deviation; amend the plan and submit a new run.' }
    }
    record.updatedAt = new Date().toISOString()
    await store.save(record)
  }
  const launch = (record: ApiOperation, request: ApiRunRequest, plan: Plan): void => {
    const job: Job = { abort: new AbortController(), done: Promise.resolve(), phase: 'running' }
    jobs.set(record.operationId, job)
    const progress = initialProgress(plan)
    record.progress = progressView(progress)
    job.done = (async () => {
      let metadata: Promise<void> = Promise.resolve()
      let progressTimer: ReturnType<typeof setTimeout> | undefined
      let progressDirty = false
      let progressWrite: Promise<void> = Promise.resolve()
      const flushProgress = (): void => {
        if (progressTimer !== undefined) { clearTimeout(progressTimer); progressTimer = undefined }
        if (!progressDirty) return
        progressDirty = false
        const next = progressWrite.then(() => save(record))
        progressWrite = next.catch((error: unknown) => { job.abort.abort(error) })
        void next.catch(() => {})
      }
      const scheduleProgress = (): void => {
        progressDirty = true
        if (progressTimer !== undefined) return
        progressTimer = setTimeout(flushProgress, PROGRESS_WRITE_INTERVAL_MS)
        progressTimer.unref()
      }
      try {
        record.status = 'running'; record.updatedAt = new Date().toISOString(); await save(record)
        const result = await service.runPlan(plan, request.workspace, {
          maxConcurrency: request.maxConcurrency, timeoutMs: request.timeoutMs, maxAttempts: request.maxAttempts,
          maxRepairs: request.maxRepairs, leaseRoot: config.leaseRoot,
          ...record.knowledge === undefined ? {} : { knowledge: record.knowledge },
          ...record.session === undefined ? {} : { nativeSession: record.session.nativeSession, sessionHandoff: record.session.handoff },
          policyHooks: hooks.filter(hook => hook.events.includes('tool')), policyTerminationGraceMs: service.options.terminationGraceMs,
          ...record.policy === undefined ? {} : { policyDecisions: record.policy },
          ...store.workerRecovery === undefined ? {} : {
            workerRecovery: store.workerRecovery, ownershipGeneration: store.workerRecovery.generation,
          },
          leaseTtlMs: request.lease.ttlMs, leaseWaitMs: request.lease.waitMs, signal: job.abort.signal,
          onEvent: (event) => {
            if (event.type === 'run/start' && typeof event.data.runId === 'string') {
              record.runId = event.data.runId; record.updatedAt = new Date().toISOString()
              metadata = save(record).catch((error: unknown) => { job.abort.abort(error); throw error })
              // The coordinator's observer is synchronous; completion below joins this owned write.
              void metadata.catch(() => {})
              return
            }
            if (!updateProgress(progress, event)) return
            record.progress = progressView(progress)
            record.updatedAt = new Date().toISOString()
            scheduleProgress()
          },
        })
        job.phase = 'settling'
        if (progressTimer !== undefined) { clearTimeout(progressTimer); progressTimer = undefined }
        record.progress = progressView(progress)
        await metadata
        await progressWrite
        record.result = { ...result, steps: result.steps.map(step => ({ ...step, checks: [...step.checks], changed: [...step.changed] })),
          openImprovisations: [...result.openImprovisations] }
        record.runId = result.runId
        record.status = result.status === 'failed' && job.abort.signal.aborted ? 'cancelled' : result.status
      } catch (error) {
        job.phase = 'settling'
        if (progressTimer !== undefined) { clearTimeout(progressTimer); progressTimer = undefined }
        await metadata.catch(() => {})
        await progressWrite
        record.progress = progressView(progress)
        if (error instanceof ProcessCleanupError) {
          record.status = job.abort.signal.aborted ? 'cancelled' : 'failed'
          record.error = { code: 'cleanup-unconfirmed', message: 'The run joined, but descendant cleanup could not be confirmed. Inspect the workspace journal and retained leases before restarting; nothing was replayed.' }
        } else if (job.abort.signal.aborted) {
          record.status = 'cancelled'
          record.error = { code: 'cancelled', message: 'Cancellation joined worker teardown before a complete outcome. Inspect the workspace journal for the recorded step and lease evidence.' }
        } else if (error instanceof WorkerTerminationError) {
          record.status = 'failed'
          record.error = { code: `worker-${error.reason}`, message: error.message }
        } else {
          record.status = 'failed'
          record.error = { code: 'run-failed', message: 'The run did not settle successfully. Inspect the workspace journal and lease status before retrying.' }
        }
        reportError(error)
      }
      record.updatedAt = new Date().toISOString()
      try { await save(record) } catch (error) { reportError(error) }
      const binding = record.session
      if (binding !== undefined) {
        try { await store.serialize(() => sessions.settle(binding, record)) } catch (error) { reportError(error) }
      }
    })().finally(() => { jobs.delete(record.operationId) })
  }

  const validateSession = (input: ApiRunRequest, plan: Plan): void => {
    if (input.session === undefined) return
    if (plan.steps.length !== 1 || input.maxAttempts !== 1 || input.maxRepairs !== 0 || (plan.steps[0]?.maxAttempts ?? 1) !== 1) {
      throw new ApiError(400, 'native-turn-plan', 'A native session turn requires exactly one step, maxAttempts: 1, and maxRepairs: 0.')
    }
    const selected = sessions.selected(input.session)
    if (selected.workspace !== input.workspace || selected.role !== plan.steps[0]?.role) {
      throw new ApiError(409, 'session-assignment', 'The plan must use the native worker’s assigned workspace and role.')
    }
  }

  const cancelOperation = async (id: OperationId): Promise<ApiOperation> => {
    const record = store.operations.get(id)
    if (record === undefined) throw new ApiError(404, 'operation-not-found', 'No retained operation has this identifier.')
    const job = jobs.get(id)
    if (job !== undefined) {
      if (job.phase === 'running') {
        record.status = 'cancelling'; record.updatedAt = new Date().toISOString(); job.abort.abort()
        await save(record)
      }
      await job.done
    }
    return record
  }

  const admitRun = async (key: string, input: ApiRunRequest, plan: Plan): Promise<ApiOperation> => {
    if (isClosing()) throw new ApiError(503, 'shutting-down', 'The API is shutting down.')
    const prior = await store.serialize(() => store.lookup(key))
    if (prior !== null) return (await store.accept(key, input)).record
    if (admissions >= config.maxActiveRuns) throw new ApiError(429, 'active-run-limit', 'The API has reached its concurrent admission limit.')
    admissions += 1
    try {
      await store.serialize(() => {
        if (store.recoveryIssues.some(issue => issue.blocksAdmission === true)) {
          throw new ApiError(503, 'recovery-admission-blocked', 'Recovery could not identify the affected resource namespace. Inspect the reported recovery issues before admitting new work.')
        }
        validateSession(input, plan)
      })
      if (hooks.some(hook => hook.events.includes('admission'))) await ensureStateDirectory(input.workspace)
      const policy = service.evaluatePolicies === undefined || !hooks.some(hook => hook.events.includes('admission')) ? []
        : await service.evaluatePolicies(hooks, { event: 'admission', workspace: input.workspace, subject: { plan, session: input.session } }, {
          signal: shutdown.signal, ...store.workerRecovery === undefined ? {} : { workerRecovery: store.workerRecovery },
        })
      for (const decision of policy) await new Journal(input.workspace).record('policy/decision', decision)
      const refusal = policy.find(decision => decision.decision !== 'allow')
      if (refusal !== undefined) throw new ApiError(409, `policy-${refusal.decision}`, `Policy ${refusal.hookId}: ${refusal.reason}`)
      if (isClosing()) throw new ApiError(503, 'shutting-down', 'The API is shutting down.')
      const accepted = await mutateState(() => store.accept(key, input, async (operationId) => {
        validateSession(input, plan)
        const knowledge = await knowledgeStore.pin(input.workspace, input.knowledge ?? [])
        validateKnowledgePlan(plan, knowledge)
        const session = input.session === undefined ? undefined : await sessions.reserve(input.session, operationId)
        return { knowledge, policy, ...session === undefined ? {} : { session: { ...session,
          ...store.workerRecovery === undefined ? {} : { workerGeneration: store.workerRecovery.generation } } } }
      }))
      const record = accepted.record
      if (accepted.fresh) {
        if (isClosing()) {
          record.status = 'cancelled'; record.updatedAt = new Date().toISOString(); await save(record)
          const binding = record.session
          if (binding !== undefined) await store.serialize(() => sessions.settle(binding, record))
        } else launch(record, input, plan)
      }
      return record
    } catch (error) {
      if (error instanceof ProcessCleanupError) {
        const issue = { ...recoveryIssue('policy-hook', store.workerRecovery?.generation ?? 'untracked-policy-range',
          new Error('An admission policy command has unconfirmed cleanup. Restart the service to recover its recorded range before admitting more work.')),
        blocksAdmission: true as const }
        store.recoveryIssues.push(issue)
        try { await store.serialize(() => replaceRecoveryIssues(config.stateDirectory, 'policy-hook', store.recoveryIssues.filter(item => item.kind === 'policy-hook'))) }
        catch (failure) { reportError(failure) }
        reportError(error)
        throw new ApiError(503, 'policy-cleanup-unconfirmed', issue.message)
      }
      if (isClosing()) throw new ApiError(503, 'shutting-down', 'The API is shutting down.')
      throw error
    } finally { admissions -= 1 }
  }

  const wakeups = new WakeupService(config.stateDirectory, { maxRecords: config.maxWakeups, maxAttempts: config.maxWakeupAttempts,
    pollIntervalMs: config.wakeupPollIntervalMs, retryDelayMs: config.wakeupRetryDelayMs }, {
    resolveRun: value => resolveApiRun(value, config),
    getOperation: async id => await store.serialize(() => store.operations.get(id) ?? null),
    lookup: async key => await store.serialize(() => store.lookup(key)),
    submit: async (request, key) => {
      try {
        const prior = await store.serialize(() => store.lookup(key))
        if (prior !== null) return (await store.accept(key, request)).record
        const { input, plan } = await validateRunInput(request, config)
        return await admitRun(key, input, plan)
      } catch (error) { throw declaredApiFailure(error) ?? error }
    }, cancel: cancelOperation, reportError,
  })
  let wakeupIssues
  try { wakeupIssues = await wakeups.initialize() } catch (error) { await store.dispose(); throw error }
  for (const issue of wakeupIssues) reportError(new Error(`Wakeup ${issue.file}: ${issue.message}`))

  /** Decode a JSON run request, or one Markdown plan whose run options arrive as query parameters. */
  const runSubmission = async (request: IncomingMessage, url: URL): Promise<unknown> => {
    const body = await readApiRunBody(request, config, shutdown.signal)
    const options = RUN_QUERY.filter(name => url.searchParams.has(name))
    if (body.kind === 'json') {
      if (options.length > 0) throw new ApiError(400, 'invalid-query', `A JSON submission carries ${options.join(', ')} in its body.`)
      return body.value
    }
    const value: Record<string, unknown> = { workspace: url.searchParams.get('workspace') ?? '', plans: [body.text] }
    for (const name of options) {
      if (name === 'workspace') continue
      const raw = url.searchParams.get(name) as string
      if (!/^\d+$/u.test(raw)) throw new ApiError(400, 'invalid-query', `${name} must be a nonnegative integer.`)
      value[name] = Number(raw)
    }
    return value
  }
  const waitQuery = (url: URL): number => {
    if (!url.searchParams.has('wait')) return 0
    const raw = url.searchParams.get('wait') as string, maximum = Math.floor(config.maxTimeoutMs / 1000)
    if (!/^\d+$/u.test(raw) || Number(raw) > maximum) throw new ApiError(400, 'invalid-query', `wait must be an integer number of seconds between 0 and ${String(maximum)}.`)
    return Number(raw) * 1000
  }
  const viewQuery = (url: URL): boolean => {
    const view = url.searchParams.get('view')
    if (view !== null && view !== 'report') throw new ApiError(400, 'invalid-query', 'view accepts only report.')
    return view === 'report'
  }
  /** Hold the response until the operation's job settles, the wait elapses, or the API shuts down. */
  const settle = async (record: ApiOperation, waitMs: number): Promise<void> => {
    const job = jobs.get(record.operationId)
    if (waitMs === 0 || job === undefined) return
    let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined
    await Promise.race([job.done, new Promise<void>((resolve) => {
      timer = setTimeout(resolve, waitMs); timer.unref()
      abort = resolve; shutdown.signal.addEventListener('abort', abort, { once: true })
    })])
    clearTimeout(timer)
    if (abort !== undefined) shutdown.signal.removeEventListener('abort', abort)
  }
  const sendOperation = async (response: ServerResponse, record: ApiOperation, report: boolean, status: number): Promise<void> => {
    sendApiJson(response, status, await store.serialize(() => report ? apiRunReport(record) : apiOperationView(record)))
  }

  const route = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    admitApiRequest(request, origin)
    if (isClosing()) throw new ApiError(503, 'shutting-down', 'The API is shutting down.')
    await store.serialize(() => {})
    const url = new URL(request.url ?? '/', origin), method = request.method
    if (method === 'GET' && url.pathname === '/v1/health') {
      query(url, [])
      const execution = await describeExecution(service.options)
      sendApiJson(response, 200, { version: 1, status: 'ready', activeRuns: [...store.operations.values()].filter(isActiveOperation).length,
        admissionBlocked: store.recoveryIssues.some(issue => issue.blocksAdmission === true),
        recoveryIssues: store.recoveryIssues, nativeSessionIssues: sessions.issues, wakeupIssues,
        cleanupUnconfirmed: [...store.operations.values()].filter(operation => operation.error?.code === 'cleanup-unconfirmed').length,
        limits: { maxBodyBytes: config.maxBodyBytes, maxActiveRuns: config.maxActiveRuns, maxConcurrency: config.maxConcurrency,
          maxTimeoutMs: config.maxTimeoutMs, maxAttempts: config.maxAttempts, maxRepairs: config.maxRepairs, maxTail: config.maxTail,
          knowledge: knowledgeLimits },
        execution })
      return
    }
    if (url.pathname === '/v1/sessions' && (method === 'GET' || method === 'POST')) {
      query(url, method === 'GET' ? ['workspace', 'limit'] : [])
      if (method === 'POST') {
        const parsed = clusterSessionCreateSchema.safeParse(await readApiJson(request, config, shutdown.signal))
        if (!parsed.success) throw new ApiError(400, 'session-invalid', 'A native worker requires a UUID, workspace, title, role, and optional handoff.')
        const input = { ...parsed.data, workspace: await existingWorkspace(parsed.data.workspace) }
        sendApiJson(response, 201, { session: await store.serialize(() => sessions.create(input)) })
      } else {
        const workspace = await existingWorkspace(workspaceQuery(url)), limit = boundedQuery(url, 'limit', config.maxTail)
        const selected = await store.serialize(() => [...sessions.sessions.values()].filter(record => record.workspace === workspace))
        sendApiJson(response, 200, { sessions: selected.slice(0, limit).map(({ handoff: _handoff, ...summary }) => summary),
          count: selected.length, truncated: selected.length > limit })
      }
      return
    }
    const sessionMatch = /^\/v1\/sessions\/([a-f0-9-]+)(\/replace)?$/u.exec(url.pathname)
    if (sessionMatch !== null && ((method === 'GET' && sessionMatch[2] === undefined) || (method === 'POST' && sessionMatch[2] === '/replace'))) {
      query(url, [])
      const id = z.uuid().safeParse(sessionMatch[1])
      if (!id.success) throw new ApiError(400, 'session-invalid', 'A native worker identity must be a UUID.')
      if (method === 'GET') sendApiJson(response, 200, { session: await store.serialize(() => sessions.get(id.data as ClusterSessionId)) })
      else {
        const value = z.object({ generation: clusterSessionReferenceSchema.shape.generation, handoff: z.string() }).strict()
          .safeParse(await readApiJson(request, config, shutdown.signal))
        if (!value.success) throw new ApiError(400, 'session-invalid', 'Replacement requires the current generation and an explicit handoff.')
        const reference = clusterSessionReferenceSchema.parse({ id: id.data, generation: value.data.generation })
        const operationId = await store.serialize(() => sessions.beginReplacement(reference, value.data.handoff))
        if (operationId !== null) await cancelOperation(operationId)
        const previous = await store.serialize(() => {
          const record = sessions.selected(reference)
          if (record.lastOperationId === null) return undefined
          const operation = store.operations.get(record.lastOperationId)
          if (operation === undefined) throw new ApiError(409, 'session-operation-missing', 'The previous native turn has no readable operation record. This generation stays fenced; inspect its retained evidence before assigning a new worker identity.')
          return operation
        })
        if (previous?.status === 'interrupted' || previous?.error?.code === 'cleanup-unconfirmed' || previous?.result?.cleanupConfirmed === false) {
          const generation = previous.session?.workerGeneration
          if (generation === undefined || !await workerGenerationSettled(config.stateDirectory, generation)) {
            throw new ApiError(409, 'cleanup-unconfirmed', 'The previous worker range is unconfirmed. This generation stays fenced; restart the service to recover its recorded range before replacement.')
          }
        }
        const replacement = await store.serialize(() => sessions.replace(reference, value.data.handoff))
        sendApiJson(response, 200, { session: replacement })
      }
      return
    }
    if (url.pathname === '/v1/wakeups' && (method === 'GET' || method === 'POST')) {
      query(url, method === 'GET' ? ['workspace', 'limit'] : [])
      if (method === 'GET') {
        const workspace = await existingWorkspace(workspaceQuery(url)), limit = boundedQuery(url, 'limit', config.maxTail)
        const records = await wakeups.list(workspace)
        sendApiJson(response, 200, { wakeups: records.slice(0, limit)
          .map(({ run, ...record }) => ({ ...record, session: run.session, workspace: run.workspace })),
        count: records.length, truncated: records.length > limit })
      } else {
        const wakeRequest = resolveWakeupRequest(await readApiJson(request, config, shutdown.signal), value => resolveApiRun(value, config))
        if (await wakeups.get(wakeRequest.id) === null) {
          const { input, plan } = await validateRunInput(wakeRequest.run, config)
          await store.serialize(async () => {
            validateSession(input, plan)
            validateKnowledgePlan(plan, await knowledgeStore.pin(input.workspace, input.knowledge ?? []))
            if (wakeRequest.trigger.kind === 'operation') {
              const source = store.operations.get(wakeRequest.trigger.operationId)
              if (source === undefined || source.workspace !== input.workspace) {
                throw new ApiError(400, 'wakeup-source', 'A wakeup trigger must name a retained operation in the assigned workspace.')
              }
            }
          })
          if (input.workspace !== wakeRequest.run.workspace) throw new ApiError(400, 'wakeup-workspace', 'Use the canonical native worker workspace in a wakeup request.')
        }
        sendApiJson(response, 202, { wakeup: await wakeups.register(wakeRequest) })
      }
      return
    }
    const wakeupMatch = /^\/v1\/wakeups\/([a-f0-9-]+)(\/cancel)?$/u.exec(url.pathname)
    if (wakeupMatch !== null && ((method === 'GET' && wakeupMatch[2] === undefined) || (method === 'POST' && wakeupMatch[2] === '/cancel'))) {
      query(url, [])
      const parsed = z.uuid().safeParse(wakeupMatch[1])
      if (!parsed.success) throw new ApiError(400, 'wakeup-invalid', 'A wakeup identity must be a UUID.')
      const id = parsed.data as WakeupId
      if (method === 'POST') {
        if (!z.object({}).strict().safeParse(await readApiJson(request, config, shutdown.signal)).success) {
          throw new ApiError(400, 'invalid-request', 'Wakeup cancellation accepts an empty JSON object.')
        }
        sendApiJson(response, 200, { wakeup: await wakeups.cancel(id) })
      } else {
        const record = await wakeups.get(id)
        if (record === null) throw new ApiError(404, 'wakeup-not-found', 'No retained wakeup has this identity.')
        sendApiJson(response, 200, { wakeup: record })
      }
      return
    }
    if (method === 'GET' && url.pathname === '/v1/briefing') {
      query(url, ['workspace', 'limit'])
      const workspace = await existingWorkspace(workspaceQuery(url))
      const limit = boundedQuery(url, 'limit', config.maxTail)
      sendApiJson(response, 200, await store.serialize(() => readKnowledgeBriefing(knowledgeStore, store.operations, workspace, limit)))
      return
    }
    if (url.pathname === '/v1/knowledge' && (method === 'GET' || method === 'POST')) {
      query(url, method === 'GET' ? ['workspace', 'limit', 'after'] : ['workspace'])
      const workspace = await existingWorkspace(workspaceQuery(url))
      if (method === 'GET') {
        const limit = boundedQuery(url, 'limit', config.maxTail), after = url.searchParams.get('after')
        const page = await store.serialize(async () => {
          const records = [...await knowledgeStore.list(workspace)]
            .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
          const position = after === null ? -1 : records.findIndex(record => record.id === after)
          if (after !== null && position < 0) {
            throw new ApiError(400, 'invalid-cursor', 'The knowledge cursor must name a retained record in this workspace.')
          }
          const selected = records.slice(position + 1, position + 1 + limit)
          const more = position + 1 + selected.length < records.length
          return { records: selected.map(knowledgeSummary), cursor: more ? selected.at(-1)?.id ?? null : null, more }
        })
        sendApiJson(response, 200, page)
      } else {
        const input = resolveKnowledgeWrite(await readApiJson(request, config, shutdown.signal), knowledgeLimits)
        const record = await mutateState(() => store.serialize(async () => {
          validateLessonEvidence(workspace, input, store.operations)
          return await knowledgeStore.write(workspace, input)
        }))
        sendApiJson(response, 200, { record })
      }
      return
    }
    const knowledgeMatch = /^\/v1\/knowledge\/([a-f0-9-]+)(\/transition|\/usage)?$/u.exec(url.pathname)
    if (knowledgeMatch !== null && ((method === 'GET' && knowledgeMatch[2] !== '/transition')
      || (method === 'POST' && knowledgeMatch[2] === '/transition'))) {
      const usage = knowledgeMatch[2] === '/usage'
      query(url, method === 'POST' ? ['workspace'] : usage ? ['workspace', 'revision', 'limit'] : ['workspace', 'revision'])
      const workspace = await existingWorkspace(workspaceQuery(url))
      const rawRevision = url.searchParams.get('revision')
      if (rawRevision !== null && !/^[1-9]\d*$/u.test(rawRevision)) throw new ApiError(400, 'invalid-revision', 'revision must be a positive integer.')
      if (usage && rawRevision === null) throw new ApiError(400, 'invalid-revision', 'Knowledge usage requires an exact revision.')
      const parsed = knowledgeReferenceSchema.safeParse({ id: knowledgeMatch[1], revision: rawRevision === null ? 1 : Number(rawRevision) })
      if (!parsed.success) throw new ApiError(400, 'invalid-knowledge-reference', 'A knowledge reference requires a UUID and positive safe-integer revision.')
      const reference = parsed.data
      if (method === 'POST') {
        const input = resolveKnowledgeTransition(await readApiJson(request, config, shutdown.signal))
        const record = await mutateState(() => store.serialize(() => knowledgeStore.transition(workspace, reference.id, input)))
        sendApiJson(response, 200, { record })
      } else {
        const limit = usage ? boundedQuery(url, 'limit', config.maxTail) : 1
        const result = await store.serialize(async () => {
          const record = await knowledgeStore.read(workspace, reference.id, rawRevision === null ? undefined : reference.revision)
          if (record === null) throw new ApiError(404, 'knowledge-not-found', 'No retained knowledge revision has this identifier in this workspace.')
          return usage ? listKnowledgeUsage(store.operations, workspace, reference, limit) : { record }
        })
        sendApiJson(response, 200, result)
      }
      return
    }
    if (method === 'POST' && url.pathname === '/v1/plans/validate') {
      query(url, RUN_QUERY)
      const { input, plan } = await validateRunInput(await runSubmission(request, url), config)
      const knowledge = await store.serialize(async () => {
        validateSession(input, plan)
        const selected = await knowledgeStore.pin(input.workspace, input.knowledge ?? [])
        validateKnowledgePlan(plan, selected)
        return selected
      })
      sendApiJson(response, 200, { plan, ...knowledge.length === 0 ? {} : { knowledge } }); return
    }
    if (method === 'GET' && url.pathname === '/v1/runs') {
      query(url, ['workspace', 'status', 'attention', 'limit', 'after'])
      if (url.searchParams.has('workspace')) {
        const workspace = workspaceQuery(url)
        try { url.searchParams.set('workspace', await realpath(workspace)) } catch (error) {
          // Removed workspaces remain discoverable by their recorded absolute path.
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new ApiError(400, 'invalid-workspace', 'The workspace filter could not be resolved.')
          url.searchParams.set('workspace', workspace)
        }
      }
      const page = await store.serialize(() => listApiRuns(store.operations, url.searchParams, config.maxTail))
      sendApiJson(response, 200, page); return
    }
    if (method === 'POST' && url.pathname === '/v1/runs') {
      query(url, [...RUN_QUERY, 'wait', 'view'])
      const header = request.headers['idempotency-key']
      if (header !== undefined && (typeof header !== 'string' || !/^[\x21-\x7e]{1,128}$/u.test(header))) {
        throw new ApiError(400, 'idempotency-key', 'An Idempotency-Key header must contain 1 to 128 printable ASCII characters.')
      }
      const key = header ?? `generated:${randomUUID()}`
      const wait = waitQuery(url), report = viewQuery(url)
      const { input, plan } = await validateRunInput(await runSubmission(request, url), config)
      const record = await admitRun(key, input, plan)
      await settle(record, wait)
      await sendOperation(response, record, report, 202)
      return
    }
    const match = /^\/v1\/runs\/([a-f0-9-]+)(\/cancel)?$/u.exec(url.pathname)
    if (match !== null && ((method === 'GET' && match[2] === undefined) || (method === 'POST' && match[2] === '/cancel'))) {
      query(url, method === 'GET' ? ['wait', 'view'] : ['view'])
      const parsed = z.uuid().safeParse(match[1])
      if (!parsed.success) throw new ApiError(400, 'invalid-operation', 'The operation identifier must be a UUID.')
      const record = store.operations.get(parsed.data as OperationId)
      if (record === undefined) throw new ApiError(404, 'operation-not-found', 'No retained operation has this identifier.')
      if (method === 'POST') {
        const body = z.object({}).strict().safeParse(await readApiJson(request, config, shutdown.signal))
        if (!body.success) throw new ApiError(400, 'invalid-request', 'Cancellation accepts an empty JSON object.')
        await cancelOperation(record.operationId)
      } else await settle(record, waitQuery(url))
      await sendOperation(response, record, viewQuery(url), 200); return
    }
    const messageMatch = /^\/v1\/runs\/([a-f0-9-]+)\/messages$/u.exec(url.pathname)
    if (method === 'POST' && messageMatch !== null) {
      query(url, [])
      const parsed = z.uuid().safeParse(messageMatch[1])
      if (!parsed.success) throw new ApiError(400, 'invalid-operation', 'The operation identifier must be a UUID.')
      const record = store.operations.get(parsed.data as OperationId)
      if (record === undefined) throw new ApiError(404, 'operation-not-found', 'No retained operation has this identifier.')
      if (record.runId === null) throw new ApiError(409, 'run-not-started', 'The operation has not published a run identity yet; retry after its journal records run/start.')
      const runId = record.runId as RunId
      if (record.status === 'cancelling') throw new ApiError(409, 'cancellation-in-progress', 'The operation is cancelling; supervisor feedback is no longer admitted.')
      if (!isActiveOperation(record)) throw new ApiError(409, 'operation-terminal', 'The operation is terminal; supervisor feedback is not admitted.')
      const body = z.object({
        toStepId: z.string().min(1).max(200),
        message: z.string().min(1).max(config.maxMessageChars).refine(value => value.trim() !== '', 'must not be blank'),
      }).strict().safeParse(await readApiJson(request, config, shutdown.signal))
      if (!body.success) throw new ApiError(400, 'invalid-request', body.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '))
      let message: TeamMessage
      try {
        message = await sendSupervisorMessage(path.join(record.workspace, '.deep-cluster', 'teams', runId),
          runId, body.data.toStepId, body.data.message, config.maxMessageChars)
      } catch (error) {
        throw new ApiError(409, 'message-rejected', error instanceof Error ? error.message : 'The supervisor message was rejected.')
      }
      sendApiJson(response, 202, { message, delivery: 'explicit-inbox-retrieval',
        note: 'The recipient must call its inbox tool. Supervisor feedback does not wake a worker, grant permissions, change a dependency, or transfer a lease.' })
      return
    }
    if (method === 'GET' && (url.pathname === '/v1/journal' || url.pathname === '/v1/ledger')) {
      query(url, ['workspace', 'tail', 'after', 'limit', 'runId'])
      const workspace = workspaceQuery(url), runId = url.searchParams.get('runId') ?? undefined
      if (runId === '') throw new ApiError(400, 'invalid-query', 'runId must not be empty.')
      const journal = new Journal(workspace)
      if (url.searchParams.has('after')) {
        if (url.searchParams.has('tail')) throw new ApiError(400, 'invalid-query', 'Use after with limit, not with tail.')
        const after = url.searchParams.get('after') as string
        if (after === '') throw new ApiError(400, 'invalid-cursor', 'The after cursor must not be empty.')
        const limit = boundedQuery(url, 'limit', config.maxTail)
        let page
        try {
          page = await journal.readAfter(after as JournalCursor, { limit, ...runId === undefined ? {} : { runId } })
        } catch (error) {
          if (error instanceof JournalCursorError) throw new ApiError(400, 'invalid-cursor', error.message)
          throw error
        }
        if (url.pathname === '/v1/journal') sendApiJson(response, 200, { workspace, ...page })
        else sendApiJson(response, 200, { workspace, roles: capabilityLedger(page.events, limit),
          cursor: page.cursor, reset: page.reset, more: page.more })
        return
      }
      if (url.searchParams.has('limit')) {
        const limit = boundedQuery(url, 'limit', config.maxTail)
        const page = await journal.readAfter(null, { limit, ...runId === undefined ? {} : { runId } })
        if (url.pathname === '/v1/journal') sendApiJson(response, 200, { workspace, ...page })
        else sendApiJson(response, 200, { workspace, roles: capabilityLedger(page.events, limit),
          cursor: page.cursor, reset: page.reset, more: page.more })
        return
      }
      const tail = boundedQuery(url, 'tail', config.maxTail)
      if (url.pathname === '/v1/journal') {
        sendApiJson(response, 200, { workspace, events: await journal.tail(tail, runId) }); return
      }
      sendApiJson(response, 200, { workspace, roles: capabilityLedger(await journal.tail(tail, runId, 'task/outcome'), tail) }); return
    }
    if (method === 'GET' && url.pathname === '/v1/dashboard') {
      query(url, ['workspace', 'workspaces', 'eventLimit'], ['workspaces'])
      const roots = url.searchParams.getAll('workspaces')
      if (roots.some(root => !path.isAbsolute(root))) throw new ApiError(400, 'invalid-workspace', 'Additional workspace paths must be absolute.')
      const activeRoots = [...store.operations.values()].filter(isActiveOperation).map(operation => operation.workspace)
      const snapshot = await dashboardCache.snapshot(workspaceQuery(url), [...roots, ...activeRoots],
        boundedQuery(url, 'eventLimit', config.maxTail))
      const activeRunIds = await store.serialize(() => [...store.operations.values()].filter(isActiveOperation)
        .flatMap(operation => operation.runId === null ? [] : [operation.runId as RunId]))
      sendApiJson(response, 200, { ...snapshot, activeRunIds }); return
    }
    if (method === 'GET' && url.pathname === '/v1/leases') {
      query(url, ['resource'])
      const resource = url.searchParams.get('resource') ?? 'gpu0'
      if (resource.trim() === '') throw new ApiError(400, 'invalid-resource', 'The resource name must not be empty.')
      const status = await leaseStatus(config.leaseRoot, resource)
      const held = status.held === undefined ? null : { resource: status.held.resource, owner: status.held.owner,
        pid: status.held.pid, acquiredAt: status.held.acquiredAt, expiresAt: status.held.expiresAt,
        ...(status.held.note === undefined ? {} : { note: status.held.note }) }
      sendApiJson(response, 200, { resource, ...status, held }); return
    }
    if (method === 'POST' && url.pathname === '/v1/ack') {
      query(url, [])
      const parsed = apiAckSchema.safeParse(await readApiJson(request, config, shutdown.signal))
      if (!parsed.success) throw new ApiError(400, 'invalid-request', parsed.error.message)
      const input = parsed.data, workspace = await existingWorkspace(input.workspace)
      await store.serialize(async () => {
        const journal = new Journal(workspace), events = await journal.read()
        const open = summarize(events).openImprovisations.find(event => event.data.id === input.id)
        const type = input.reject ? 'improvisation/reject' : 'improvisation/ack'
        if (open === undefined) {
          const previous = events.findLast(event => event.data.id === input.id
            && (event.type === 'improvisation/ack' || event.type === 'improvisation/reject'))
          if (previous?.type !== type) {
            throw new ApiError(previous === undefined ? 404 : 409, 'ack-conflict', 'No matching open improvisation can receive this acknowledgement.')
          }
          await settleAcknowledgedRun(events, previous.data.runId)
          return
        }
        const decision = await journal.record(type, { id: input.id, runId: open.data.runId, note: input.note })
        await settleAcknowledgedRun([...events, decision], open.data.runId)
      })
      sendApiJson(response, 200, { id: input.id, status: input.reject ? 'rejected' : 'acknowledged' }); return
    }
    if (method === 'POST' && url.pathname === '/v1/service/shutdown') {
      query(url, [])
      const body = z.object({ confirmCleanupUnconfirmed: z.boolean().optional() }).strict()
        .safeParse(await readApiJson(request, config, shutdown.signal))
      if (!body.success) throw new ApiError(400, 'invalid-request', 'Service shutdown accepts only an optional confirmCleanupUnconfirmed boolean.')
      const unconfirmed = [...store.operations.values()].filter(operation => operation.error?.code === 'cleanup-unconfirmed')
      if (unconfirmed.length > 0 && body.data.confirmCleanupUnconfirmed !== true) {
        throw new ApiError(409, 'cleanup-unconfirmed', `${String(unconfirmed.length)} retained run(s) could not confirm descendant cleanup. Verify and terminate their process ranges, then retry with confirmCleanupUnconfirmed: true; this API does not claim those workers stopped.`)
      }
      if (jobs.size > 0 || admissions > 0) {
        throw new ApiError(409, 'active-runs', 'The API still owns active runs or an admission in progress; finish or cancel them before shutdown.')
      }
      closing = true
      response.once('finish', () => { requestShutdown() })
      sendApiJson(response, 202, { status: 'stopping', cleanupUnconfirmed: unconfirmed.length }); return
    }
    throw new ApiError(404, 'route-not-found', 'No DeepCluster API endpoint matches this method and path.')
  }

  wakeups.start()
  return {
    handle(request, response) {
      const work = route(request, response).catch((error: unknown) => {
        const declared = declaredApiFailure(error)
        if (declared === null || declared.status >= 500) reportError(error)
        const failure = declared ?? new ApiError(503, 'operation-unavailable', 'The operation could not be completed. Inspect the API log and affected workspace before retrying.')
        sendApiJson(response, failure.status, { error: { code: failure.code, message: failure.message } })
      }).finally(() => { requests.delete(work) })
      requests.add(work); return work
    },
    dispose() {
      disposed ??= (async () => {
        closing = true; shutdown.abort()
        for (const job of jobs.values()) job.abort.abort()
        try { await wakeups.dispose() } catch (error) { reportError(error) }
        await Promise.allSettled(requests)
        await Promise.allSettled([...jobs.values()].map(job => job.done))
        await store.dispose()
      })()
      return disposed
    },
  }
}
