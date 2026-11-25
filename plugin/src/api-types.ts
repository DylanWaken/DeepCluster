/** Local HTTP API configuration, validated requests, and durable operation metadata. */
import path from 'node:path'
import { z } from 'zod'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { knowledgeReferenceSchema, knowledgeRevisionSchema, type KnowledgeReference } from './knowledge-types.ts'
import { clusterSessionBindingSchema, clusterSessionReferenceSchema, type ClusterSessionReference } from './native-sessions.ts'
import { policyDecisionSchema, type PolicyHook } from './policy-hooks.ts'

/** Stable identity of one accepted HTTP submission. */
export type OperationId = Branded<'DeepClusterOperationId'>

/**
 * Exclusive recovery fence in the API state directory. Recovery creates it
 * before touching the owner lock; API admission checks it before and after
 * acquiring that lock so a fresh owner cannot enter the rename window.
 */
export const API_RECOVERY_FENCE_FILE = 'api-owner.recovery'

/** Host-owned storage, admission limits, and request defaults. */
export interface ApiConfig {
  readonly stateDirectory: string
  readonly leaseRoot: string
  readonly maxBodyBytes: number
  readonly maxOperations: number
  readonly maxActiveRuns: number
  readonly maxConcurrency: number
  readonly maxTimeoutMs: number
  readonly maxAttempts: number
  readonly maxRepairs: number
  readonly requestTimeoutMs: number
  readonly maxTail: number
  /** Maximum supervisor message length accepted by the mailbox route. */
  readonly maxMessageChars: number
  /** Maximum knowledge records retained for one canonical workspace. */
  readonly maxKnowledgeRecords: number
  /** UTF-8 body budget for each document, lesson, or protocol revision. */
  readonly maxKnowledgeBodyBytes: number
  /** Maximum selected revisions or evidence references in one request. */
  readonly maxKnowledgeReferences: number
  /** Maximum serialized knowledge context admitted to one run. */
  readonly maxKnowledgeSnapshotBytes: number
  /** Native worker retention and explicit replacement context budgets. */
  readonly maxNativeSessions: number
  readonly maxSessionHandoffBytes: number
  /** One-shot wakeup retention, admission retries and timer pacing. */
  readonly maxWakeups: number
  readonly maxWakeupAttempts: number
  readonly wakeupPollIntervalMs: number
  readonly wakeupRetryDelayMs: number
  /** Host-configured decision programs; requests cannot add or modify hooks. */
  readonly policyHooks: PolicyHook[]
  readonly defaultConcurrency: number
  readonly defaultTimeoutMs: number
  readonly defaultMaxAttempts: number
  readonly defaultMaxRepairs: number
  readonly defaultLeaseTtlMs: number
  readonly defaultLeaseWaitMs: number
}

/** Validated, fully resolved run inputs; lease ownership always uses the host's configured namespace. */
export interface ApiRunRequest {
  readonly workspace: string
  readonly plans: readonly string[]
  readonly maxConcurrency: number
  readonly timeoutMs: number
  readonly maxAttempts: number
  readonly maxRepairs: number
  readonly lease: { readonly ttlMs: number; readonly waitMs: number }
  readonly knowledge?: readonly KnowledgeReference[]
  /** Exact native worker generation; omission creates disposable workers. */
  readonly session?: ClusterSessionReference
}

/** Declared HTTP refusal whose code and message are safe to return. */
export class ApiError extends Error {
  override readonly name = 'DeepClusterApiError'
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}

const absolutePath = z.string().min(1).refine(value => path.isAbsolute(value), 'must be an absolute path')

/**
 * Validate and resolve JSON request options before plan execution or filesystem mutations.
 * @param value - decoded request JSON.
 * @param config - validated deployment limits and explicit defaults.
 * @returns normalized request values used for idempotency and execution.
 */
export function resolveApiRun(value: unknown, config: ApiConfig): ApiRunRequest {
  const native = typeof value === 'object' && value !== null && 'session' in value
  const parsed = z.object({
    workspace: absolutePath,
    plans: z.array(z.string().trim().min(1)).min(1),
    knowledge: z.array(knowledgeReferenceSchema).min(1).max(config.maxKnowledgeReferences).optional(),
    session: clusterSessionReferenceSchema.optional(),
    maxConcurrency: z.number().int().min(1).max(config.maxConcurrency).default(config.defaultConcurrency),
    timeoutMs: z.number().int().min(1).max(config.maxTimeoutMs).default(config.defaultTimeoutMs),
    maxAttempts: z.number().int().min(1).max(config.maxAttempts).default(native ? 1 : config.defaultMaxAttempts),
    maxRepairs: z.number().int().min(0).max(config.maxRepairs).default(native ? 0 : config.defaultMaxRepairs),
    lease: z.object({
      ttlMs: z.number().int().min(1).max(config.maxTimeoutMs).default(config.defaultLeaseTtlMs),
      waitMs: z.number().int().min(0).max(config.maxTimeoutMs).default(config.defaultLeaseWaitMs),
    }).strict().optional(),
  }).strict().safeParse(value)
  if (!parsed.success) throw new ApiError(400, 'invalid-request', parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '))
  const { knowledge, session, ...data } = parsed.data
  return { ...data, ...knowledge === undefined ? {} : { knowledge }, ...session === undefined ? {} : { session },
    workspace: path.resolve(data.workspace), lease: data.lease ?? {
      ttlMs: config.defaultLeaseTtlMs, waitMs: config.defaultLeaseWaitMs,
    } }
}

/** Acknowledgement JSON accepted by POST /v1/ack. */
export const apiAckSchema = z.object({ workspace: absolutePath, id: z.string().min(1),
  reject: z.boolean().default(false), note: z.string().default('') }).strict()

const outcomeSchema = z.object({
  runId: z.uuid(), status: z.enum(['completed', 'needs-ack', 'failed', 'cancelled']), journalFile: z.string(),
  /** Absent on historical records; absence never proves cleanup for failed or cancelled outcomes. */
  cleanupConfirmed: z.boolean().optional(),
  steps: z.array(z.object({ stepId: z.string(), title: z.string(), role: z.enum(['developer', 'reviewer', 'tester', 'perf', 'fixer']),
    attempts: z.number().int().min(0), status: z.enum(['pass', 'fail', 'blocked']), summary: z.string(),
    /** Absent on records retained before reported checks joined the result. */
    checks: z.array(z.string()).optional(),
    /** Absent on records retained before step audits joined the result. */
    changed: z.array(z.string()).optional(), auditProblem: z.string().optional(),
    improvisation: z.object({ kind: z.enum(['deviation', 'blocker', 'addition', 'reduction']), reason: z.string(), planChange: z.string() }).optional(),
  })), openImprovisations: z.array(z.record(z.string(), z.unknown())),
  failure: z.object({ stepId: z.string(), output: z.string() }).optional(),
})

/** One bounded per-step progress entry exposed by the operation status view. */
export const apiStepProgressSchema = z.object({
  stepId: z.string(), title: z.string(), role: z.enum(['developer', 'reviewer', 'tester', 'perf', 'fixer']),
  status: z.enum(['queued', 'running', 'waiting', 'pass', 'fail', 'blocked']),
  attempt: z.number().int().min(0),
  waitingResource: z.string().optional(),
})

/** Bounded operation progress; full evidence remains in the workspace journal. */
export const apiOperationProgressSchema = z.object({
  total: z.number().int().min(0), queued: z.number().int().min(0), running: z.number().int().min(0),
  waiting: z.number().int().min(0), passed: z.number().int().min(0), failed: z.number().int().min(0),
  blocked: z.number().int().min(0), steps: z.array(apiStepProgressSchema),
  recentEvent: z.object({
    type: z.string(), at: z.iso.datetime(), stepId: z.string().optional(), detail: z.string().optional(),
  }).nullable(),
})

/** Bounded progress plus the step ids currently running or waiting. */
export type ApiOperationProgress = z.infer<typeof apiOperationProgressSchema>

/** Durable versioned metadata; active records become interrupted after an owner process exits. */
export const apiOperationSchema = z.object({
  version: z.literal(1), operationId: z.uuid().transform(value => value as OperationId),
  keyHash: z.string().regex(/^[a-f0-9]{64}$/u), requestHash: z.string().regex(/^[a-f0-9]{64}$/u),
  workspace: absolutePath, ownerPid: z.number().int().positive(),
  /** Present on current records; with the PID it distinguishes the owner from a later process. */
  ownerStartTime: z.string().min(1).optional(),
  status: z.enum(['accepted', 'running', 'cancelling', 'completed', 'needs-ack', 'failed', 'cancelled', 'interrupted']),
  runId: z.uuid().nullable(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  /** Absent on historical records; null until the first progress boundary is observed. */
  progress: apiOperationProgressSchema.nullable().default(null),
  result: outcomeSchema.nullable(), error: z.object({ code: z.string(), message: z.string() }).nullable(),
  /** Exact selected revisions; absent on runs without knowledge selections. */
  knowledge: z.array(knowledgeRevisionSchema).optional(),
  /** Native ownership committed before worker spawn; absent on disposable runs. */
  session: clusterSessionBindingSchema.optional(),
  /** Host hook decisions at admission; absence means no admission hook was configured. */
  policy: z.array(policyDecisionSchema).optional(),
}).strict()

/** Persisted operation metadata returned by submission, status, and cancellation endpoints. */
export type ApiOperation = z.infer<typeof apiOperationSchema>

/** Authenticated status response; idempotency digests and owner-process metadata remain server-local. */
export const apiOperationViewSchema = apiOperationSchema.omit({
  version: true, keyHash: true, requestHash: true, ownerPid: true, ownerStartTime: true,
})

/** Public operation response shared by HTTP clients. */
export type ApiOperationView = z.infer<typeof apiOperationViewSchema>

/**
 * Select public fields without leaking durable-store bookkeeping.
 * @param record - accepted operation metadata.
 * @returns the stable HTTP operation response.
 */
export function apiOperationView(record: ApiOperation): ApiOperationView {
  return { operationId: record.operationId, status: record.status, workspace: record.workspace, runId: record.runId,
    createdAt: record.createdAt, updatedAt: record.updatedAt, progress: record.progress, result: record.result, error: record.error,
    ...record.knowledge === undefined ? {} : { knowledge: record.knowledge },
    ...record.session === undefined ? {} : { session: record.session },
    ...record.policy === undefined ? {} : { policy: record.policy } }
}

/** Compact review projection: the evidence a supervisor needs to qualify each step, without progress noise. */
export interface ApiRunReport {
  readonly operationId: OperationId
  readonly status: ApiOperation['status']
  readonly error: string | null
  /** Terminal step evidence; before the run settles, each step's current status only. */
  readonly steps: readonly {
    readonly id: string
    readonly role: string
    readonly status: string
    readonly attempts: number
    readonly summary?: string
    readonly checks?: readonly string[]
    readonly changed?: readonly string[]
    readonly auditProblem?: string
    readonly improvisation?: { readonly kind: string; readonly reason: string; readonly planChange: string }
  }[]
  /** Improvisation ids awaiting POST /v1/ack. */
  readonly open: readonly string[]
  /** The final characters of the run's failure output, when the coordinator recorded one. */
  readonly failure?: { readonly stepId: string; readonly output: string }
}

/**
 * Project an operation onto its compact review report.
 * @param record - retained operation metadata.
 * @returns per-step status, summary, reported checks, and audit evidence; empty fields are omitted.
 */
export function apiRunReport(record: ApiOperation): ApiRunReport {
  const error = record.error === null ? null : `${record.error.code}: ${record.error.message}`
  const result = record.result
  if (result === null) {
    return { operationId: record.operationId, status: record.status, error, open: [],
      steps: (record.progress?.steps ?? [])
        .map(step => ({ id: step.stepId, role: step.role, status: step.status, attempts: step.attempt })) }
  }
  return {
    operationId: record.operationId, status: record.status, error,
    steps: result.steps.map(step => ({
      id: step.stepId, role: step.role, status: step.status, attempts: step.attempts, summary: step.summary,
      ...step.checks === undefined || step.checks.length === 0 ? {} : { checks: step.checks },
      ...step.changed === undefined || step.changed.length === 0 ? {} : { changed: step.changed },
      ...step.auditProblem === undefined ? {} : { auditProblem: step.auditProblem },
      ...step.improvisation === undefined ? {} : { improvisation: step.improvisation },
    })),
    open: result.openImprovisations.flatMap(item => typeof item.id === 'string' ? [item.id] : []),
    ...result.failure === undefined ? {} : { failure: { stepId: result.failure.stepId,
      output: result.failure.output.slice(-REPORT_FAILURE_CHARS) } },
  }
}

/** Failure output retained in a report; the operation view keeps the complete value. */
const REPORT_FAILURE_CHARS = 4000

/**
 * Identify operations that still own admitted work.
 * @param operation - current operation metadata.
 * @returns whether a worker may still be executing or completing teardown.
 */
export function isActiveOperation(operation: ApiOperation): boolean {
  return operation.status === 'accepted' || operation.status === 'running' || operation.status === 'cancelling'
}
