/** Journal projection shared by the Web Remote and its deterministic presentation tests. */
import type { JournalEvent } from './journal.ts'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { ClusterActivity, ClusterDashboardSnapshot, ClusterLeaseView, ClusterMessageView, ClusterOutcomeView, ClusterRunView, ClusterTaskView, ClusterTimelineEntry, ClusterTaskId, ClusterRecordId } from './dashboard-types.ts'
import type { RunId, TeamMessageId } from './types.ts'
import { TOKEN_WINDOW_MS } from './token-window.ts'

const text = (value: unknown): string => typeof value === 'string' ? value : ''
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const activity = (value: unknown): ClusterActivity => {
  switch (value) {
    case 'thinking': case 'command': case 'read': case 'write': case 'tool': case 'idle': return value
    default: return 'unknown'
  }
}

/**
 * Incremental journal fold. It retains bounded timeline, outcome, and message
 * arrays, the newest `retention` terminal runs with their tasks, and every
 * live run with its tasks and lease state, so repeated polls never retain the
 * complete raw event log or every historical run. Active and quarantined state
 * is never dropped because of age.
 */
export class DashboardAccumulator {
  private readonly runs = new Map<string, ClusterRunView>()
  private readonly tasks = new Map<string, ClusterTaskView>()
  private readonly leases = new Map<string, ClusterLeaseView>()
  private readonly outcomes: ClusterOutcomeView[] = []
  private readonly timeline: ClusterTimelineEntry[] = []
  private readonly messages: ClusterMessageView[] = []
  private readonly terminalRuns: string[] = []
  private readonly settledRuns = new Set<string>()
  private offset = 0
  private legacyRun = 'legacy'
  private updatedAt: string | null = null

  /**
   * @param retention - maximum timeline, outcome, and message rows retained per kind.
   */
  constructor(private readonly retention: number) {
    if (!Number.isSafeInteger(retention) || retention < 1) throw new RangeError('retention must be a positive integer')
  }

  /**
   * Fold the next committed records, preserving run and lease ownership identities.
   * @param events - validated journal records in observed append order.
   */
  append(events: readonly JournalEvent[]): void {
    for (const event of events) {
      const data = event.data
      const offset = this.offset++
      this.updatedAt = event.at
      if (event.type === 'run/start' && typeof data.runId !== 'string') this.legacyRun = `legacy-${String(offset)}`
      const runId = (text(data.runId) || this.legacyRun) as RunId
      const eventId = (event.writerId === undefined ? `record-${String(offset)}` : `${event.writerId}/${String(event.seq)}`) as ClusterRecordId
      const stepId = text(data.stepId)
      const id = `${runId}/${stepId}` as ClusterTaskId
      const role = text(data.role)
      if (event.type === 'run/start') {
        this.runs.set(runId, { id: runId, title: text(data.title), goal: text(data.goal), status: 'running', startedAt: event.at })
        if (Array.isArray(data.steps)) {
          const steps: readonly unknown[] = data.steps
          for (const value of steps) {
            if (typeof value !== 'object' || value === null || !('id' in value) || typeof value.id !== 'string') continue
            const step = value as Record<string, unknown>
            const taskId = `${runId}/${value.id}` as ClusterTaskId
            this.tasks.set(taskId, { id: taskId, runId, stepId: value.id, title: text(step.title) || value.id,
              role: text(step.role), status: 'queued', activity: 'unknown', detail: '', attempt: 0,
              dependencies: strings(step.dependsOn), resources: strings(step.resources ?? step.hardware),
              usage: null, tokenSamples: [], tokenError: null, waitingResource: null, updatedAt: event.at })
          }
        }
      }
      if (event.type === 'run/end' || event.type === 'run/blocked') {
        const run = this.runs.get(runId)
        if (run !== undefined) this.runs.set(runId, { ...run, status: event.type === 'run/blocked' ? 'blocked' : text(data.status) })
        this.settleRun(runId)
      }
      if (event.type === 'run/end') {
        for (const [taskId, task] of this.tasks) {
          if (task.runId === runId && (task.status === 'running' || task.status === 'waiting' || task.status === 'queued')) {
            this.tasks.set(taskId, { ...task, status: 'blocked', activity: 'idle', detail: text(data.reason), updatedAt: event.at })
          }
        }
      }
      if (stepId !== '') {
        const previous = this.tasks.get(id) ?? { id, runId, stepId, title: text(data.title) || stepId, role,
          status: 'queued' as const, activity: 'unknown' as const, detail: '', attempt: 0,
          dependencies: [], resources: [], usage: null, tokenSamples: [], tokenError: null, waitingResource: null, updatedAt: event.at }
        let next: ClusterTaskView = { ...previous, updatedAt: event.at }
        switch (event.type) {
          case 'step/queued': next = { ...next, title: text(data.title) || next.title, role: role || next.role,
            dependencies: strings(data.dependsOn), resources: strings(data.resources) }; break
          case 'step/start': next = { ...next, status: 'running', title: text(data.title) || next.title }; break
          case 'lease/wait': next = { ...next, status: 'waiting', activity: 'idle', detail: text(data.resource), waitingResource: text(data.resource) }; break
          case 'agent/start': next = { ...next, status: 'running', activity: 'unknown', detail: '', role: role || next.role,
            usage: null, tokenSamples: [], tokenError: null, waitingResource: null,
            attempt: typeof data.attempt === 'number' ? data.attempt : next.attempt }; break
          case 'agent/activity': next = { ...next, activity: activity(data.kind), detail: text(data.detail) }; break
          case 'agent/token-sample':
            if (typeof data.tokens === 'number' && Number.isSafeInteger(data.tokens) && nonnegative(data.observedAt)
              && data.basis === 'tokenizer' && typeof data.tokenizer === 'string' && data.tokenizer !== '') {
              const latest = next.tokenSamples.reduce((at, sample) => Math.max(at, sample.observedAt), data.observedAt)
              next = { ...next, tokenError: null, tokenSamples: [
                ...next.tokenSamples, { tokens: data.tokens, observedAt: data.observedAt, basis: 'tokenizer' as const, tokenizer: data.tokenizer },
              ].filter(sample => sample.observedAt > latest - TOKEN_WINDOW_MS) }
            }
            break
          case 'agent/token-error': next = { ...next, tokenSamples: [], tokenError: text(data.message) }; break
          case 'agent/usage':
            if (nonnegative(data.inputTokens) && nonnegative(data.outputTokens) && nonnegative(data.elapsedMs)
              && data.elapsedMs > 0 && nonnegative(data.tokensPerSecond)) {
              next = { ...next, usage: {
                inputTokens: (next.usage?.inputTokens ?? 0) + data.inputTokens,
                outputTokens: (next.usage?.outputTokens ?? 0) + data.outputTokens,
                elapsedMs: data.elapsedMs, tokensPerSecond: data.tokensPerSecond,
              } }
            }
            break
          case 'agent/end': next = { ...next, activity: 'idle', detail: '',
            status: data.status === 'failed' || data.status === 'fail' || (typeof data.exitCode === 'number' && data.exitCode !== 0)
              ? 'failed' : next.status }; break
          case 'step/end': next = { ...next, status: data.passed === true ? 'passed' : 'failed', activity: 'idle' }; break
          case 'step/blocked': next = { ...next, status: 'blocked', activity: 'idle', detail: text(data.reason) }; break
          case 'task/outcome': next = { ...next, status: data.status === 'pass' ? 'passed' : data.status === 'blocked' ? 'blocked' : 'failed', activity: 'idle', detail: text(data.summary) }; break
          case 'run/start': case 'run/end': case 'run/blocked':
          case 'gate/pass': case 'gate/fail':
          case 'agent/log': case 'agent/message':
          case 'lease/acquire': case 'lease/release': case 'lease/reclaim': case 'lease/quarantine':
          case 'improvisation/report': case 'improvisation/ack': case 'improvisation/reject':
          case 'plan/amend': case 'repair/start': case 'repair/end': case 'sandbox/escalate': case 'policy/decision':
            break
          default: assertNever(event.type)
        }
        this.tasks.set(id, next)
      }
      const resource = text(data.resource)
      if (event.type === 'lease/acquire' && resource !== '') this.leases.set(resource, { resource, runId, stepId, acquiredAt: event.at, status: 'held', detail: '' })
      if (event.type === 'lease/quarantine') {
        const retained = resource === '' ? strings(data.resources) : [resource]
        for (const name of retained) {
          const held = this.leases.get(name)
          if (held?.runId === runId && held.stepId === stepId) this.leases.set(name, { ...held, status: 'quarantined', detail: text(data.reason) })
        }
      }
      if ((event.type === 'lease/release' || event.type === 'lease/reclaim') && resource !== '') {
        const held = this.leases.get(resource)
        if (held?.runId === runId && held.stepId === stepId) this.leases.delete(resource)
      }
      if (event.type === 'task/outcome') this.pushBounded(this.outcomes, { id: eventId, runId,
        title: text(data.title) || stepId, role, status: text(data.status), summary: text(data.summary), checks: strings(data.checks) })
      if (event.type === 'agent/message') this.pushBounded(this.messages, { id: eventId, runId,
        fromStepId: text(data.fromStepId), toStepId: text(data.toStepId), kind: text(data.kind), phase: text(data.phase),
        messageId: typeof data.id === 'string' ? data.id as TeamMessageId : null,
        message: text(data.message), at: event.at })
      if (event.type !== 'agent/token-sample') this.pushBounded(this.timeline, { id: eventId, seq: event.seq, at: event.at, type: event.type, runId, stepId, role,
        activity: event.type === 'agent/activity' ? activity(data.kind) : 'unknown',
        detail: text(data.detail) || text(data.text) || text(data.message) || text(data.summary)
          || text(data.reason) || resource || text(data.title) })
    }
  }

  /** Keep repeated polls bounded by discarding the oldest retained rows of each kind. */
  private pushBounded<T>(rows: T[], row: T): void {
    rows.push(row)
    if (rows.length > this.retention) rows.splice(0, rows.length - this.retention)
  }

  /** Remember a terminal run once and prune its run and task rows beyond retention. */
  private settleRun(runId: string): void {
    if (this.settledRuns.has(runId)) return
    this.settledRuns.add(runId)
    this.terminalRuns.push(runId)
    while (this.terminalRuns.length > this.retention) {
      const oldest = this.terminalRuns.shift() as string
      this.settledRuns.delete(oldest)
      this.runs.delete(oldest)
      for (const [taskId, task] of this.tasks) if (task.runId === oldest) this.tasks.delete(taskId)
    }
  }

  /**
   * Project the accumulated state.
   * @param workspace - configured journal root displayed to the operator.
   * @param eventLimit - maximum timeline, outcome, and message rows returned.
   * @returns the latest recorded state, without interpreting an unfinished run as proof of process liveness.
   */
  snapshot(workspace: string, eventLimit: number): ClusterDashboardSnapshot {
    return { workspace, workspaces: [workspace], activeRunIds: null, updatedAt: this.updatedAt,
      runs: [...this.runs.values()].reverse(), tasks: [...this.tasks.values()], leases: [...this.leases.values()],
      timeline: this.timeline.slice(-eventLimit).reverse(), outcomes: this.outcomes.slice(-eventLimit).reverse(),
      messages: this.messages.slice(-eventLimit).reverse() }
  }
}

/**
 * Fold committed records, preserving simultaneous runs and separating lease release from other owners.
 * @param events - validated journal records in append order.
 * @param workspace - configured journal root displayed to the operator.
 * @param eventLimit - maximum timeline and outcome entries returned; task state uses the complete log.
 * @returns the latest recorded state, without interpreting an unfinished run as proof of process liveness.
 */
export function projectDashboard(events: readonly JournalEvent[], workspace: string, eventLimit: number): ClusterDashboardSnapshot {
  const accumulator = new DashboardAccumulator(Math.max(1, eventLimit))
  accumulator.append(events)
  return accumulator.snapshot(workspace, eventLimit)
}
