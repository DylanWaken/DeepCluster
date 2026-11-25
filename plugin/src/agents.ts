/** Worker JSON progress and plan execution adapters for the DeepCluster scheduler. */

import { coordinate, type AgentRunResult, type AgentRunner, type AgentRunSpec, type WorkerTermination } from './coordinator.ts'
import { masterDirectory } from './master.ts'
import { parsePlan } from './plan.ts'
import path from 'node:path'
import { runHandoff, type ProcessRunner } from './executor.ts'
import type { DeepClusterOptions, HandoffRequest, HandoffResult } from './types.ts'
import { WorkerProgress } from './progress.ts'

/** A native Session-bound worker did not identify the supervisor's exact conversation. */
export class WorkerSessionError extends Error {
  override readonly name = 'WorkerSessionError'

  /**
   * @param code - missing, conflicting, or repeated opening identity.
   * @param message - the Session observation that prevented a trusted result.
   */
  constructor(readonly code: 'worker-session-missing' | 'worker-session-mismatch' | 'worker-session-duplicate', message: string) {
    super(message)
  }
}

/**
 * Execute an external handoff through the same scheduler, leases and ledger as a plan command.
 * @param options - resolved worker settings.
 * @param request - task and required plan with explicit acceptance criteria.
 * @param runner - managed subprocess implementation.
 * @returns a serialized coordinator outcome; unresolved deviations require planner action.
 */
export async function runPlannedHandoff(
  options: DeepClusterOptions, request: HandoffRequest, runner: ProcessRunner,
): Promise<HandoffResult> {
  if (request.plan === undefined || request.plan.trim() === '') throw new Error('DeepCluster handoff requires a plan with explicit acceptance criteria')
  const parsed = parsePlan(request.plan)
  const workspace = path.resolve(request.cwd ?? process.cwd())
  const started = Date.now()
  const outcome = await coordinate({
    root: workspace, workspace, plan: { ...parsed, goal: `${request.task.trim()}\n${parsed.goal}` },
    runner: handoffRunner({ ...options, profile: request.profile ?? options.profile }, runner),
    leaseRoot: masterDirectory(options.dshPath),
    timeoutMs: request.timeoutMs ?? options.timeoutMs,
    permissionMode: request.permissionMode ?? options.permissionMode,
    ...request.nativeSession === undefined ? {} : { nativeSession: request.nativeSession },
    ...request.signal === undefined ? {} : { signal: request.signal },
  })
  return {
    ok: outcome.status === 'completed', exitCode: outcome.status === 'completed' ? 0 : outcome.status === 'needs-ack' ? 3 : outcome.status === 'cancelled' ? 130 : 1,
    signal: null, stdout: JSON.stringify(outcome), stderr: '', durationMs: Date.now() - started,
    command: 'dsh --profile deep-cluster coordinate',
  }
}

/** Preserve a terminated attempt's cause instead of treating missing output as a report. */
function terminationOf(spec: AgentRunSpec, result: { exitCode: number }): WorkerTermination | undefined {
  if (spec.signal?.aborted === true) return { reason: 'cancelled', phase: 'running' }
  if (result.exitCode === 130) return { reason: 'cancelled', phase: 'running' }
  if (result.exitCode === 124) return { reason: 'timeout', phase: 'running' }
  return undefined
}

/**
 * Build a runner that executes each role attempt as one harness run.
 * @param options - resolved CLI/profile settings.
 * @param runner - managed subprocess owner.
 * @returns a runner suitable for {@link coordinate}.
 */
export function handoffRunner(options: DeepClusterOptions, runner: ProcessRunner): AgentRunner {
  return async (spec: AgentRunSpec): Promise<AgentRunResult> => {
    let pending = ''
    let final = ''
    const identity = { observed: false }
    const progress = new WorkerProgress()
    const acceptLine = (line: string): void => {
      // Profile diagnostics may share stdout; only JSON objects belong to the headless event protocol.
      if (!line.trimStart().startsWith('{')) return
      const event: unknown = JSON.parse(line)
      if (spec.nativeSession !== undefined) {
        const sessionEvent = typeof event === 'object' && event !== null && 'type' in event && event.type === 'session'
        if (sessionEvent) {
          if (identity.observed) throw new WorkerSessionError('worker-session-duplicate', 'Worker emitted more than one native Session identity.')
          if (!('sessionId' in event) || event.sessionId !== spec.nativeSession.id) {
            throw new WorkerSessionError('worker-session-mismatch', 'Worker native Session identity does not match the supervisor assignment.')
          }
          identity.observed = true
        } else if (!identity.observed) {
          const diagnostic = typeof event === 'object' && event !== null && 'type' in event && event.type === 'error'
            && 'message' in event && typeof event.message === 'string' ? ` ${event.message}` : ''
          throw new WorkerSessionError('worker-session-missing', `Worker emitted a run event before its assigned native Session identity.${diagnostic}`)
        }
      }
      const text = progress.accept(event, performance.now(), spec)
      if (text !== undefined) final = text
    }
    const result = await runHandoff(options, {
      task: spec.prompt,
      cwd: spec.cwd,
      timeoutMs: spec.timeoutMs,
      json: true,
      ...spec.nativeSession === undefined ? {} : { nativeSession: spec.nativeSession },
      ...spec.policyFile === undefined ? {} : { policyFile: spec.policyFile },
      ...spec.team === undefined ? {} : { env: { DSH_DEEP_CLUSTER_TEAM: JSON.stringify(spec.team) } },
      ...spec.signal === undefined ? {} : { signal: spec.signal },
      onStdout(chunk) {
        pending += chunk
        const lines = pending.split('\n')
        pending = lines.pop() ?? ''
        for (const line of lines) acceptLine(line)
      },
      ...spec.permissionMode === undefined ? {} : { permissionMode: spec.permissionMode },
    }, runner)
    if (spec.nativeSession !== undefined) {
      if (pending.trim() !== '') acceptLine(pending)
      if (!identity.observed) {
        throw new WorkerSessionError('worker-session-missing',
          `Worker did not emit its assigned native Session identity.${result.stderr === '' ? '' : ` ${result.stderr.trim()}`}`)
      }
    }
    const termination = terminationOf(spec, result)
    return {
      ok: result.ok,
      output: final === '' && result.exitCode !== 0 ? (result.stderr || 'Worker produced no final event') : final,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      ...termination === undefined ? {} : { termination },
    }
  }
}
