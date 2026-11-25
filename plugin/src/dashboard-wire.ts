/** Validation for dashboard snapshots crossing the local HTTP API. */
import { z } from 'zod'
import type { ClusterDashboardSnapshot, ClusterTaskId, ClusterRecordId } from './dashboard-types.ts'
import type { RunId, TeamMessageId } from './types.ts'

const runId = z.string().transform(value => value as RunId)
const taskId = z.string().transform(value => value as ClusterTaskId)
const recordId = z.string().transform(value => value as ClusterRecordId)
const activity = z.enum(['thinking', 'command', 'read', 'write', 'tool', 'idle', 'unknown'])
const usage = z.object({ inputTokens: z.number().nonnegative(), outputTokens: z.number().nonnegative(),
  elapsedMs: z.number().nonnegative(), tokensPerSecond: z.number().nonnegative() })
const schema: z.ZodType<ClusterDashboardSnapshot> = z.object({
  workspace: z.string(), workspaces: z.array(z.string()), updatedAt: z.string().nullable(),
  activeRunIds: z.array(z.uuid().transform(value => value as RunId)).nullable(),
  runs: z.array(z.object({ id: runId, title: z.string(), goal: z.string(), status: z.string(), startedAt: z.string() })),
  tasks: z.array(z.object({
    id: taskId, runId, stepId: z.string(), title: z.string(), role: z.string(),
    status: z.enum(['queued', 'running', 'waiting', 'passed', 'failed', 'blocked']), activity,
    detail: z.string(), attempt: z.number().int().nonnegative(), dependencies: z.array(z.string()),
    resources: z.array(z.string()), usage: usage.nullable(),
    tokenSamples: z.array(z.object({ tokens: z.number().int(), observedAt: z.number().nonnegative(),
      basis: z.literal('tokenizer'), tokenizer: z.string() })),
    tokenError: z.string().nullable(), waitingResource: z.string().nullable(), updatedAt: z.string(),
  })),
  leases: z.array(z.object({ resource: z.string(), runId, stepId: z.string(), acquiredAt: z.string(),
    status: z.enum(['held', 'quarantined']), detail: z.string() })),
  timeline: z.array(z.object({ id: recordId, seq: z.number().int().nonnegative(), at: z.string(), type: z.string(),
    runId, stepId: z.string(), role: z.string(), activity, detail: z.string() })),
  outcomes: z.array(z.object({ id: recordId, runId, title: z.string(), role: z.string(), status: z.string(),
    summary: z.string(), checks: z.array(z.string()) })),
  messages: z.array(z.object({ id: recordId, runId, fromStepId: z.string(), toStepId: z.string(), kind: z.string(),
    phase: z.string(), messageId: z.string().transform(value => value as TeamMessageId).nullable(),
    message: z.string(), at: z.string() })),
})

/**
 * Validate a received dashboard before forwarding it to a browser.
 * @param value - decoded HTTP response.
 * @returns the validated snapshot, or throws for malformed fields.
 */
export function parseDashboardSnapshot(value: unknown): ClusterDashboardSnapshot {
  return schema.parse(value)
}
