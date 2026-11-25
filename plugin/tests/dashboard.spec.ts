/** Recorded cluster state remains independent across concurrent runs and lease owners. */
import { describe, expect, it } from 'vitest'
import { projectDashboard } from '../src/dashboard.ts'
import type { JournalEvent } from '../src/journal.ts'
import { rollingTokenRate } from '../src/token-window.ts'

function events(rows: readonly [JournalEvent['type'], Record<string, unknown>][]): JournalEvent[] {
  return rows.map(([type, data], seq) => ({ seq, at: `2026-10-23T08:00:${String(seq).padStart(2, '0')}.000Z`, type, data }))
}

describe('cluster dashboard journal projection', () => {
  it('clears failed telemetry until a fresh sample and preserves actual worker logs and message receipts', () => {
    const sample = { runId: 'r', stepId: 'a', basis: 'tokenizer', tokenizer: 'fixture', tokens: 20, observedAt: 10000 }
    const records = events([
      ['agent/token-sample', sample],
      ['agent/token-error', { runId: 'r', stepId: 'a', message: 'Tokenizer unavailable' }],
      ['agent/log', { runId: 'r', stepId: 'a', kind: 'command', text: 'nvidia-smi' }],
      ['agent/message', { runId: 'r', stepId: 'a', fromStepId: 'b', toStepId: 'a', message: 'Reference checked', id: 'message-1', kind: 'message', phase: 'sent' }],
    ])
    const failed = projectDashboard(records, 'workspace', 20)
    expect(failed.tasks[0]?.tokenSamples).toEqual([])
    expect(failed.tasks[0]?.tokenError).toBe('Tokenizer unavailable')
    expect(failed.timeline.find(event => event.type === 'agent/log')?.detail).toBe('nvidia-smi')
    expect(failed.messages[0]).toMatchObject({ messageId: 'message-1', phase: 'sent', fromStepId: 'b', toStepId: 'a' })
    const recovered = projectDashboard([...records, ...events([['agent/token-sample', { ...sample, observedAt: 11000 }]])], 'workspace', 20)
    expect(recovered.tasks[0]?.tokenError).toBeNull()
    expect(recovered.tasks[0]?.tokenSamples).toHaveLength(1)
  })

  it('bounds live token deltas per attempt and clamps signed tokenizer corrections', () => {
    const sample = { runId: 'r', stepId: 'a', basis: 'tokenizer', tokenizer: 'fixture' }
    const records = events([
      ['agent/start', { runId: 'r', stepId: 'a', attempt: 1 }],
      ['agent/token-sample', { ...sample, tokens: 100, observedAt: 10000 }],
      ['agent/token-sample', { ...sample, tokens: -20, observedAt: 11000 }],
      ['agent/token-sample', { ...sample, tokens: 40, observedAt: 15000 }],
      ['agent/token-sample', { ...sample, tokens: 0.5, observedAt: 16000 }],
      ['agent/token-sample', { ...sample, tokens: 100, observedAt: -1 }],
    ])
    const projection = projectDashboard(records, 'workspace', 1)
    const samples = projection.tasks[0]!.tokenSamples
    expect(projection.timeline.map(event => event.type)).toEqual(['agent/start'])
    expect(samples.map(value => [value.tokens, value.observedAt])).toEqual([[-20, 11000], [40, 15000]])
    expect(rollingTokenRate(samples, 15000)).toBe(4)
    expect(rollingTokenRate(samples, 14000)).toBe(0)
    expect(rollingTokenRate(samples, 16000)).toBe(8)
    expect(rollingTokenRate(samples, 20000)).toBe(0)
    const reset = projectDashboard([...records, ...events([['agent/start', { runId: 'r', stepId: 'a', attempt: 2 }]])], 'workspace', 20)
    expect(reset.tasks[0]?.tokenSamples).toEqual([])
  })

  it('settles unfinished cards when a run ends and retains explicit worker failures', () => {
    const result = projectDashboard(events([
      ['run/start', { runId: 'r', steps: [{ id: 'failed' }, { id: 'running' }, { id: 'queued' }] }],
      ['agent/start', { runId: 'r', stepId: 'failed' }],
      ['agent/end', { runId: 'r', stepId: 'failed', exitCode: 1 }],
      ['agent/start', { runId: 'r', stepId: 'running' }],
      ['run/end', { runId: 'r', status: 'failed', reason: 'Coordinator interrupted' }],
    ]), 'workspace', 20)
    expect(result.tasks.map(task => [task.status, task.activity])).toEqual([
      ['failed', 'idle'], ['blocked', 'idle'], ['blocked', 'idle'],
    ])
  })

  it('marks every retained resource quarantined from the coordinator cleanup-failure event', () => {
    const result = projectDashboard(events([
      ['lease/acquire', { runId: 'r', stepId: 'a', resource: 'gpu0' }],
      ['lease/acquire', { runId: 'r', stepId: 'a', resource: 'workspace:repo' }],
      ['lease/acquire', { runId: 'other', stepId: 'a', resource: 'gpu1' }],
      ['lease/quarantine', { runId: 'r', stepId: 'a', resources: ['gpu0', 'workspace:repo', 'gpu1'], reason: 'Shutdown unconfirmed' }],
    ]), 'workspace', 20)
    expect(result.leases.map(lease => [lease.resource, lease.status, lease.detail])).toEqual([
      ['gpu0', 'quarantined', 'Shutdown unconfirmed'], ['workspace:repo', 'quarantined', 'Shutdown unconfirmed'], ['gpu1', 'held', ''],
    ])
  })

  it('accumulates reported token samples per worker attempt and retains the latest measured rate', () => {
    const records = events([
      ['agent/start', { runId: 'r', stepId: 'a', role: 'tester', attempt: 1 }],
      ['agent/usage', { runId: 'r', stepId: 'a', inputTokens: 100, outputTokens: 40, elapsedMs: 2000, tokensPerSecond: 20 }],
      ['agent/usage', { runId: 'r', stepId: 'a', inputTokens: 150, outputTokens: 60, elapsedMs: 1000, tokensPerSecond: 60 }],
    ])
    expect(projectDashboard(records, 'workspace', 20).tasks[0]?.usage).toEqual({ inputTokens: 250, outputTokens: 100, elapsedMs: 1000, tokensPerSecond: 60 })
    const reset = projectDashboard([...records, ...events([
      ['agent/start', { runId: 'r', stepId: 'a', role: 'tester', attempt: 2 }],
      ['agent/usage', { runId: 'r', stepId: 'a', inputTokens: 0, outputTokens: 0, elapsedMs: 0, tokensPerSecond: -1 }],
    ])], 'workspace', 20)
    expect(reset.tasks[0]?.usage).toBeNull()
  })

  it('keeps task identities, activity, dependencies, and hardware owners distinct across runs', () => {
    const result = projectDashboard(events([
      ['run/start', { runId: 'one', title: 'First plan', steps: [{ id: '1', title: 'Write kernel', role: 'developer' }] }],
      ['run/start', { runId: 'two', title: 'Second plan', steps: [{ id: '1', title: 'Measure kernel', role: 'perf', dependsOn: ['build'] }] }],
      ['agent/start', { runId: 'one', stepId: '1', role: 'developer', attempt: 1 }],
      ['agent/activity', { runId: 'one', stepId: '1', kind: 'write', detail: 'kernel.cu' }],
      ['lease/acquire', { runId: 'two', stepId: '1', resource: 'gpu0' }],
      ['lease/release', { runId: 'one', stepId: '1', resource: 'gpu0' }],
    ]), 'workspace', 3)
    expect(result.tasks.map(task => [task.id, task.activity, task.dependencies])).toEqual([
      ['one/1', 'write', []], ['two/1', 'unknown', ['build']],
    ])
    expect(result.leases).toEqual([{ resource: 'gpu0', runId: 'two', stepId: '1', acquiredAt: '2026-10-23T08:00:04.000Z', status: 'held', detail: '' }])
    expect(result.timeline.map(item => item.seq)).toEqual([5, 4, 3])
    expect(result.tasks[0]?.detail).toBe('kernel.cu')
  })

  it('records gates and outcomes without interpreting a started worker as thinking', () => {
    const result = projectDashboard(events([
      ['run/start', { runId: 'r', title: 'Plan', goal: 'Verify', steps: [{ id: 'a', role: 'tester' }] }],
      ['agent/start', { runId: 'r', stepId: 'a', role: 'tester', attempt: 1 }],
    ]), 'workspace', 20)
    expect(result.tasks[0]?.activity).toBe('unknown')
    expect(result.tasks[0]?.status).toBe('running')
    const settled = projectDashboard(events([
      ['task/outcome', { runId: 'r', stepId: 'a', title: 'Verify', role: 'tester', status: 'fail', summary: 'Mismatch', checks: ['values agree: no'] }],
    ]), 'workspace', 20)
    expect(settled.tasks[0]?.status).toBe('failed')
    expect(settled.outcomes[0]).toMatchObject({ status: 'fail', summary: 'Mismatch', checks: ['values agree: no'] })
  })

  it('separates historical logs without run ids and clears a matching lease release', () => {
    const result = projectDashboard(events([
      ['run/start', { title: 'Old run', steps: [{ id: '1' }] }],
      ['step/end', { stepId: '1', passed: true }],
      ['run/end', { status: 'completed' }],
      ['run/start', { title: 'New run', steps: [{ id: '1' }] }],
      ['lease/acquire', { stepId: '1', resource: 'gpu0' }],
      ['lease/release', { stepId: '1', resource: 'gpu0' }],
      ['step/blocked', { stepId: '1', reason: 'Dependency failed' }],
    ]).map(event => ({ ...event, seq: 0 })), 'workspace', 20)
    expect(result.tasks.map(task => task.status)).toEqual(['passed', 'blocked'])
    expect(result.runs.map(run => run.id)).toEqual(['legacy-3', 'legacy-0'])
    expect(result.leases).toEqual([])
  })

  it('bounds terminal runs and tasks while keeping active runs and quarantined leases', () => {
    const rows: [JournalEvent['type'], Record<string, unknown>][] = [
      ['run/start', { runId: 'active', title: 'Active', steps: [{ id: '1' }] }],
      ['agent/start', { runId: 'active', stepId: '1' }],
      ['lease/acquire', { runId: 'active', stepId: '1', resource: 'gpu0' }],
      ['lease/quarantine', { runId: 'active', stepId: '1', resource: 'gpu0', reason: 'Shutdown unconfirmed' }],
    ]
    for (let index = 0; index < 12; index += 1) {
      rows.push(
        ['run/start', { runId: `terminal-${String(index)}`, steps: [{ id: 'a' }, { id: 'b' }] }],
        ['task/outcome', { runId: `terminal-${String(index)}`, stepId: 'a', status: 'pass', summary: 'ok' }],
        ['task/outcome', { runId: `terminal-${String(index)}`, stepId: 'b', status: 'pass', summary: 'ok' }],
        ['run/end', { runId: `terminal-${String(index)}`, status: 'completed' }],
      )
    }
    const records: JournalEvent[] = rows.map(([type, data], seq) => ({ seq, at: '2026-10-23T08:00:00.000Z', type, data }))

    const result = projectDashboard(records, 'workspace', 3)
    expect(result.runs.map(run => run.id)).toEqual(['terminal-11', 'terminal-10', 'terminal-9', 'active'])
    expect(result.tasks.filter(task => task.runId === 'active')).toHaveLength(1)
    expect(result.tasks.length).toBe(7)
    expect(result.tasks.find(task => task.id === 'active/1')).toMatchObject({ status: 'running' })
    expect(result.timeline.length).toBeLessThanOrEqual(3)
    expect(result.outcomes.length).toBeLessThanOrEqual(3)
    expect(result.leases).toEqual([expect.objectContaining({ resource: 'gpu0', status: 'quarantined' })])
  })
})
