/** Browser-safe projections of recorded DeepCluster work; no model reasoning text is included. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { AgentTokenSample, RunId, TeamMessageId } from './types.ts'

/** A step identity paired with its owning run. */
export type ClusterTaskId = Branded<'DeepClusterTaskId'>

/** One append-only journal record identity used by the timeline and outcomes. */
export type ClusterRecordId = Branded<'DeepClusterRecordId'>

/** Activity observed in worker events, or unknown when the worker has not reported it. */
export type ClusterActivity = 'thinking' | 'command' | 'read' | 'write' | 'tool' | 'idle' | 'unknown'

/** Scheduling and gate state of one planned step. */
export type ClusterTaskStatus = 'queued' | 'running' | 'waiting' | 'passed' | 'failed' | 'blocked'

/** Reported token totals for one worker attempt, with its latest completed response measurement. */
export interface ClusterUsageView {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly elapsedMs: number
  readonly tokensPerSecond: number
}

/** One step, identified within its run. */
export interface ClusterTaskView {
  readonly id: ClusterTaskId
  readonly runId: RunId
  readonly stepId: string
  readonly title: string
  readonly role: string
  readonly status: ClusterTaskStatus
  readonly activity: ClusterActivity
  readonly detail: string
  readonly attempt: number
  readonly dependencies: readonly string[]
  readonly resources: readonly string[]
  readonly usage: ClusterUsageView | null
  readonly tokenSamples: readonly AgentTokenSample[]
  readonly tokenError: string | null
  readonly waitingResource: string | null
  readonly updatedAt: string
}

/** One recorded execution of a plan. */
export interface ClusterRunView {
  readonly id: RunId
  readonly title: string
  readonly goal: string
  readonly status: string
  readonly startedAt: string
}

/** Exclusive resource ownership at the last journal event. */
export interface ClusterLeaseView {
  readonly resource: string
  readonly runId: RunId
  readonly stepId: string
  readonly acquiredAt: string
  readonly status: 'held' | 'quarantined'
  readonly detail: string
}

/** A bounded activity entry; sequence identifies the committed journal record. */
export interface ClusterTimelineEntry {
  readonly id: ClusterRecordId
  readonly seq: number
  readonly at: string
  readonly type: string
  readonly runId: RunId
  readonly stepId: string
  readonly role: string
  readonly activity: ClusterActivity
  readonly detail: string
}

/** A task result and its reported acceptance evidence, retained for delegation decisions. */
export interface ClusterOutcomeView {
  readonly id: ClusterRecordId
  readonly runId: RunId
  readonly title: string
  readonly role: string
  readonly status: string
  readonly summary: string
  readonly checks: readonly string[]
}

/** A recorded handoff or feedback message delivered to a worker invocation. */
export interface ClusterMessageView {
  readonly id: ClusterRecordId
  readonly runId: RunId
  readonly fromStepId: string
  readonly toStepId: string
  readonly kind: string
  readonly phase: string
  readonly messageId: TeamMessageId | null
  readonly message: string
  readonly at: string
}

/** Read-only dashboard snapshot folded from the configured workspace journals. */
export interface ClusterDashboardSnapshot {
  readonly workspace: string
  readonly workspaces: readonly string[]
  /** Runs currently owned by the serving API; null means only journal history was observed. */
  readonly activeRunIds: readonly RunId[] | null
  readonly updatedAt: string | null
  readonly runs: readonly ClusterRunView[]
  readonly tasks: readonly ClusterTaskView[]
  readonly leases: readonly ClusterLeaseView[]
  readonly timeline: readonly ClusterTimelineEntry[]
  readonly outcomes: readonly ClusterOutcomeView[]
  readonly messages: readonly ClusterMessageView[]
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The configured coordination journal could not be read. */
    'deepCluster/journal-unavailable': Record<string, never>
    /** The dashboard stream ended before observation could resume. */
    'deepCluster/observation-failed': Record<string, never>
  }
}
