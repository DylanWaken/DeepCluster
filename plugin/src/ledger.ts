/** Capability evidence projected from completed tasks in the append-only coordinator journal. */

import type { JournalEvent } from './journal.ts'
import type { RunId } from './types.ts'

/** One observed task outcome; passing is a checked worker report, not an independent factual guarantee. */
export interface TaskExample {
  readonly runId: RunId
  readonly stepId: string
  readonly title: string
  readonly role: string
  readonly status: 'pass' | 'fail' | 'blocked'
  readonly summary: string
  readonly acceptance: readonly string[]
  readonly checks: readonly string[]
  readonly durationMs: number
  readonly at: string
  /** Source task-plan context, retained when several plans share one coordinator run. */
  readonly planTitle?: string
  readonly goal?: string
}

/** Observed evidence for one worker role, without extrapolated capability scores. */
export interface CapabilityEvidence {
  readonly role: string
  readonly passed: number
  readonly failed: number
  readonly blocked: number
  readonly examples: readonly TaskExample[]
}

/** Validate string lists read from durable JSON. */
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

/**
 * Project successful and failed tasks for a planner deciding what to delegate.
 * @param events - journal records; only terminal task outcomes contribute evidence.
 * @param limitPerRole - maximum recent examples retained per role; counts include all outcomes.
 * @returns observed role-level counts and examples, ordered by first role occurrence.
 */
export function capabilityLedger(events: readonly JournalEvent[], limitPerRole = 20): CapabilityEvidence[] {
  if (!Number.isSafeInteger(limitPerRole) || limitPerRole < 1) throw new RangeError('limitPerRole must be a positive integer')
  const roles = new Map<string, { role: string; passed: number; failed: number; blocked: number; examples: TaskExample[] }>()
  for (const event of events) {
    if (event.type !== 'task/outcome') continue
    const data = event.data
    if (typeof data.runId !== 'string' || typeof data.stepId !== 'string' || typeof data.title !== 'string' ||
      typeof data.role !== 'string' || typeof data.summary !== 'string' ||
      (data.status !== 'pass' && data.status !== 'fail' && data.status !== 'blocked') ||
      !strings(data.acceptance) || !strings(data.checks) || typeof data.durationMs !== 'number') {
      throw new Error('DeepCluster task/outcome has invalid evidence fields; inspect the journal before using its capability ledger.')
    }
    const role = roles.get(data.role) ?? { role: data.role, passed: 0, failed: 0, blocked: 0, examples: [] }
    switch (data.status) {
      case 'pass': role.passed++; break
      case 'fail': role.failed++; break
      case 'blocked': role.blocked++; break
    }
    role.examples.push({
      runId: data.runId as RunId, stepId: data.stepId, title: data.title, role: data.role, status: data.status,
      summary: data.summary, acceptance: data.acceptance, checks: data.checks, durationMs: data.durationMs, at: event.at,
      ...typeof data.planTitle === 'string' ? { planTitle: data.planTitle } : {},
      ...typeof data.goal === 'string' ? { goal: data.goal } : {},
    })
    if (role.examples.length > limitPerRole) role.examples.shift()
    roles.set(role.role, role)
  }
  return [...roles.values()]
}
