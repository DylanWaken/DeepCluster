/** Deterministic task scheduling, cancellation, retained ownership, and durable capability evidence. */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { rm } from 'node:fs/promises'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { coordinate, type AgentRunResult } from '../src/coordinator.ts'
import { ProcessCleanupError, WorkerTerminationError } from '../src/executor.ts'
import { Journal } from '../src/journal.ts'
import { capabilityLedger } from '../src/ledger.ts'
import { acquireLease, leaseStatus, LeaseLostError, LeaseStateError, LeaseTimeoutError, releaseLease } from '../src/lease.ts'
import { masterDirectory } from '../src/master.ts'
import { combinePlans, parsePlan, type PlanStep, planDependencies, serializePlan } from '../src/plan.ts'
import { sendSupervisorMessage, SUPERVISOR_STEP_ID, TeamMailbox, type TeamMessageReceipt } from '../src/mailbox.ts'
import { WorkerProgress } from '../src/progress.ts'
import type { RunId } from '../src/types.ts'

const exec = promisify(execFile)

async function gitRepository(): Promise<string> {
  const root = await scratch()
  const run = async (...args: string[]): Promise<void> => { await exec('git', ['-C', root, ...args], { windowsHide: true }) }
  await run('init', '-q')
  await run('symbolic-ref', 'HEAD', 'refs/heads/main')
  await run('config', 'user.email', 'deep-cluster@example.invalid')
  await run('config', 'user.name', 'DeepCluster Test')
  await writeFile(path.join(root, 'tracked.txt'), 'base\n')
  await run('add', 'tracked.txt')
  await run('commit', '-q', '-m', 'base')
  return root
}

function deferred(): { promise: Promise<undefined>; resolve: () => void; reject: (error: Error) => void } {
  const pending = Promise.withResolvers<undefined>()
  return { promise: pending.promise, resolve: () => { pending.resolve(undefined) }, reject: (error) => { pending.reject(error) } }
}

async function scratch(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'deep-cluster-scheduler-'))
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
  return root
}

function step(id: string, extra: Partial<PlanStep> = {}): PlanStep {
  return { id, title: id, role: 'developer', detail: 'collect data', acceptance: ['result checked'],
    dependsOn: [], resources: [], ...extra }
}

function result(ok = true): AgentRunResult {
  return { ok, exitCode: ok ? 0 : 1, durationMs: 10, output:
    `[[DEEPCLUSTER]]\nstatus: ${ok ? 'pass' : 'fail'}\nsummary: fixture result\nchecks:\n- result checked: yes, fixture command exited 0\nimprovisation: no\n[[/DEEPCLUSTER]]` }
}

describe('task graphs', () => {
  it('runs independent plans in one batch without cross-plan prerequisite edges', async () => {
    const root = await scratch()
    const plan = (title: string) => parsePlan(`# ${title}\ngoal: inspect ${title}\n## Step 1: inspect\nrole: reviewer\naccess: read-only\nresources: none\nacceptance:\n- result checked\n\nCollect facts.\n## Step 2: verify\nrole: reviewer\naccess: read-only\nresources: none\nacceptance:\n- result checked\n\nVerify the preceding findings.\n`)
    const batch = combinePlans([plan('alpha'), plan('beta')])
    expect(planDependencies(batch).get('plan-2.step-1')).toEqual([])
    expect(planDependencies(batch).get('plan-2.step-2')).toEqual(['plan-2.step-1'])
    const bothStarted = deferred()
    const release = deferred()
    const started: string[] = []
    const run = coordinate({
      root, workspace: root, leaseRoot: masterDirectory(root), plan: batch, maxConcurrency: 2, maxAttempts: 1, maxRepairs: 0,
      runner: async (spec) => {
        started.push(spec.stepId)
        if (spec.stepId.endsWith('.step-1')) {
          if (started.length === 2) bothStarted.resolve()
          await release.promise
        }
        expect(spec.prompt).toContain(spec.stepId.startsWith('plan-1.') ? 'Goal: inspect alpha' : 'Goal: inspect beta')
        return result()
      },
    })
    let beforeRelease: string[] = []
    try {
      await bothStarted.promise
      beforeRelease = [...started]
    } finally {
      release.resolve()
    }
    const outcome = await run
    expect([...beforeRelease].sort()).toEqual(['plan-1.step-1', 'plan-2.step-1'])
    expect(outcome.status).toBe('completed')
    const events = await new Journal(root).read()
    expect(events.filter(event => event.type === 'task/outcome').map(event => event.data.planTitle).sort())
      .toEqual(['alpha', 'alpha', 'beta', 'beta'])
  })

  it('keeps shared hardware exclusive across batched task plans', async () => {
    const root = await scratch()
    const plans = ['alpha', 'beta'].map(title => ({ title, goal: title, hardware: ['gpu0'], steps: [step('same', { hardware: 'gpu0' })] }))
    let active = 0
    let maximum = 0
    const outcome = await coordinate({
      root, workspace: root, leaseRoot: masterDirectory(root), plan: combinePlans(plans), maxConcurrency: 2, maxRepairs: 0,
      runner: async () => {
        active++
        maximum = Math.max(maximum, active)
        expect((await leaseStatus(masterDirectory(root), 'gpu0')).held).toBeDefined()
        active--
        return result()
      },
    })
    expect(outcome.status).toBe('completed')
    expect(maximum).toBe(1)
    expect(() => combinePlans([])).toThrow('at least one plan')
  })

  it.each(['hardware', 'workspace'])('records a pending %s reservation wait while the owner is still running', async (resourceKind) => {
    const root = await scratch()
    const ownerStarted = deferred()
    const waiting = deferred()
    const release = deferred()
    const requirement: Partial<PlanStep> = resourceKind === 'hardware' ? { hardware: 'gpu0' } : { resources: ['shared-output'] }
    const run = coordinate({ root, workspace: root, leaseRoot: masterDirectory(root), maxConcurrency: 2, maxRepairs: 0,
      plan: { title: 'wait visibility', goal: 'share', hardware: [], steps: [step('a', requirement), step('b', requirement), step('c')] },
      onEvent: (event) => {
        if (event.type === 'lease/wait' && event.data.stepId === 'b' && event.data.reason === 'local reservation') waiting.resolve()
      },
      runner: async (spec) => {
        if (spec.stepId === 'a') { ownerStarted.resolve(); await release.promise }
        return result()
      },
    })
    try {
      await Promise.all([ownerStarted.promise, waiting.promise])
      const events = await new Journal(root).read()
      expect(events.some(event => event.type === 'agent/end' && event.data.stepId === 'a')).toBe(false)
      expect(events.find(event => event.type === 'lease/wait' && event.data.stepId === 'b')?.data.ownerStepId).toBe('a')
    } finally { release.resolve() }
    expect((await run).status).toBe('completed')
    expect((await new Journal(root).read()).filter(event => event.type === 'lease/wait'
      && event.data.stepId === 'b' && event.data.reason === 'local reservation')).toHaveLength(1)
  })

  it('round-trips independent tasks and normalized dependency references', () => {
    const plan = parsePlan('# tasks\ngoal: collect\n## Step 1: first\nrole: developer\ndepends_on: none\nresources: none\nacceptance:\n- result checked\n## Step 2: second\nrole: tester\ndepends_on: 1\nresources: fixtures\nacceptance:\n- result checked\n')
    expect(plan.steps[0]?.dependsOn).toEqual([])
    expect(plan.steps[1]?.dependsOn).toEqual(['step-1'])
    expect(parsePlan(serializePlan(plan)).steps.map(item => [item.dependsOn, item.resources]))
      .toEqual([[[], []], [['step-1'], ['fixtures']]])
  })

  it.each([
    [step('same'), step('same')],
    [step('one', { dependsOn: ['absent'] })],
    [step('one', { dependsOn: ['two'] }), step('two', { dependsOn: ['one'] })],
    [step('one', { maxAttempts: 0 })],
    [step('one', { acceptance: [] })],
    [step('one', { acceptance: [' '] })],
    [step('one', { acceptance: ['same', 'same'] })],
  ])('rejects invalid graphs before a worker starts: %j', (...steps) => {
    expect(() => planDependencies({ title: 'invalid', goal: 'g', hardware: [], steps })).toThrow()
  })

  it('overlaps independent workers within the concurrency bound and passes dependency evidence', async () => {
    const root = await scratch()
    const bothStarted = deferred()
    const finish = deferred()
    const started: string[] = []
    let active = 0
    let maximum = 0
    let finalPrompt = ''
    const run = coordinate({
      root, workspace: root, leaseRoot: masterDirectory(root), maxConcurrency: 2, maxRepairs: 0,
      plan: { title: 'parallel', goal: 'collect', hardware: [], steps: [
        step('a', { access: 'write', writes: ['a.txt'] }),
        step('b', { access: 'write', writes: ['b.txt'] }),
        step('c', { dependsOn: ['a', 'b'], access: 'read-only' }),
      ] },
      runner: async (spec) => {
        started.push(spec.stepId)
        active++
        maximum = Math.max(active, maximum)
        if (spec.stepId !== 'c') {
          if (active === 2) bothStarted.resolve()
          await finish.promise
        } else finalPrompt = spec.prompt
        active--
        return result()
      },
    })
    try {
      await bothStarted.promise
    } finally {
      finish.resolve()
    }
    const outcome = await run
    expect(outcome.status).toBe('completed')
    expect(started.slice(0, 2).sort()).toEqual(['a', 'b'])
    expect(started[2]).toBe('c')
    expect(maximum).toBe(2)
    expect(finalPrompt).toContain('Completed prerequisite evidence')
    expect(finalPrompt).toContain('fixture command exited 0')
    expect(finalPrompt).toContain('Team tasks: a, b, c')
    expect((await new Journal(root).read()).filter(event => event.type === 'agent/message').map(event => event.data))
      .toMatchObject([
        { fromStepId: 'a', toStepId: 'c', kind: 'handoff', phase: 'sent' },
        { fromStepId: 'b', toStepId: 'c', kind: 'handoff', phase: 'sent' },
      ])
  })

  it('records sends and retrievals only for the worker identity assigned to the run', async () => {
    const root = await scratch()
    const outcome = await coordinate({ root, workspace: root, leaseRoot: masterDirectory(root), maxRepairs: 0,
      plan: { title: 'team', goal: 'share evidence', hardware: [], steps: [step('a'), step('b')] },
      runner: async (spec) => {
        if (spec.team === undefined) throw new Error('missing team assignment')
        const mailbox = await TeamMailbox.open(spec.team, 100, 10)
        if (spec.stepId === 'a') spec.onMessage?.({ ...await mailbox.send('b', 'checked result'), phase: 'sent' })
        else {
          const message = (await mailbox.receive())[0]
          if (message === undefined) throw new Error('missing message')
          spec.onMessage?.({ ...message, phase: 'delivered' })
          spec.onMessage?.({ ...message, fromStepId: 'b', toStepId: 'a', phase: 'delivered' })
        }
        return result()
      },
    })
    expect(outcome.status).toBe('failed')
    expect(outcome.failure?.output).toContain('does not match')
    expect((await new Journal(root).read()).filter(event => event.type === 'agent/message').map(event => event.data.phase))
      .toEqual(['sent', 'delivered'])
  })

  it('accepts authenticated supervisor feedback through the worker mailbox and receipt path', async () => {
    const root = await scratch()
    const progress = new WorkerProgress()
    const feedback = 'Confirm the fixture result before reporting.'
    const outcome = await coordinate({
      root, workspace: root, leaseRoot: masterDirectory(root), maxRepairs: 0,
      plan: { title: 'supervisor feedback', goal: 'accept feedback', hardware: [], steps: [step('one')] },
      runner: async (spec) => {
        if (spec.team === undefined || spec.onMessage === undefined) throw new Error('missing team assignment')
        const sent = await sendSupervisorMessage(spec.team.root, spec.team.runId, 'one', feedback, 200)
        const mailbox = await TeamMailbox.open(spec.team, 200, 10)
        const message = (await mailbox.receive())[0]
        if (message === undefined || message.id !== sent.id) throw new Error('missing supervisor message')
        progress.accept({ type: 'deepcluster_message', receipt: { ...message, phase: 'delivered' } }, Date.now(),
          { onMessage: spec.onMessage })
        return result()
      },
    })
    expect(outcome.status).toBe('completed')
    expect(outcome.steps[0]?.status).toBe('pass')
    const events = (await new Journal(root).read()).filter(event => event.type === 'agent/message')
    expect(events).toHaveLength(1)
    expect(events[0]?.data).toMatchObject({
      runId: outcome.runId, fromStepId: SUPERVISOR_STEP_ID, toStepId: 'one',
      message: feedback, phase: 'delivered',
      stepId: 'one', role: 'developer', attempt: 1, kind: 'message',
    })
    expect(typeof events[0]?.data.id).toBe('string')
    expect(typeof events[0]?.data.sentAt).toBe('string')
  })

  it('rejects supervisor receipts that are not a delivery to the assigned worker in the same run', async () => {
    const cases: { name: string; override: Partial<TeamMessageReceipt> }[] = [
      { name: 'supervisor send claim', override: { phase: 'sent' } },
      { name: 'misaddressed delivery', override: { toStepId: 'two' } },
      { name: 'unknown sender', override: { fromStepId: 'intruder' } },
      { name: 'cross-run delivery', override: { runId: 'other-run' as RunId } },
      { name: 'supervisor recipient', override: { toStepId: SUPERVISOR_STEP_ID } },
    ]
    for (const item of cases) {
      const root = await scratch()
      const outcome = await coordinate({
        root, workspace: root, leaseRoot: masterDirectory(root), maxRepairs: 0,
        plan: { title: item.name, goal: 'reject invalid feedback', hardware: [], steps: [step('one')] },
        runner: async (spec) => {
          if (spec.team === undefined || spec.onMessage === undefined) throw new Error('missing team assignment')
          const sent = await sendSupervisorMessage(spec.team.root, spec.team.runId, 'one', 'fixture feedback', 200)
          const mailbox = await TeamMailbox.open(spec.team, 200, 10)
          const message = (await mailbox.receive())[0]
          if (message === undefined || message.id !== sent.id) throw new Error('missing supervisor message')
          spec.onMessage({ ...message, phase: 'delivered', ...item.override })
          return result()
        },
      })
      expect(outcome.status).toBe('failed')
      expect(outcome.steps[0]?.status).toBe('fail')
      expect(outcome.failure?.output).toContain('does not match')
      const events = await new Journal(root).read()
      expect(events.filter(event => event.type === 'agent/message')).toEqual([])
      expect(events.filter(event => event.type === 'run/end').map(event => event.data))
        .toEqual([expect.objectContaining({ status: 'failed' })])
    }
  })

  it('keeps an internal receipt rejection as failed evidence instead of external cancellation', async () => {
    const root = await scratch()
    const outcome = await coordinate({
      root, workspace: root, leaseRoot: masterDirectory(root), maxRepairs: 0, maxAttempts: 2,
      plan: { title: 'internal rejection', goal: 'reject forged feedback', hardware: [], steps: [step('one')] },
      runner: async (spec) => {
        if (spec.team === undefined || spec.onMessage === undefined) throw new Error('missing team assignment')
        const sent = await sendSupervisorMessage(spec.team.root, spec.team.runId, 'one', 'fixture feedback', 200)
        const mailbox = await TeamMailbox.open(spec.team, 200, 10)
        const message = (await mailbox.receive())[0]
        if (message === undefined || message.id !== sent.id) throw new Error('missing supervisor message')
        spec.onMessage({ ...message, phase: 'delivered', fromStepId: 'intruder' })
        if (spec.signal?.aborted !== true) throw new Error('internal rejection did not abort the worker')
        throw new WorkerTerminationError('cancelled', 'running')
      },
    })
    expect(outcome.status).toBe('failed')
    expect(outcome.steps[0]).toMatchObject({ status: 'fail', attempts: 1 })
    expect(outcome.failure?.output).toContain('Worker message receipt does not match')
    expect(outcome.failure?.output).not.toContain('external cancellation')
    const events = await new Journal(root).read()
    const runEnd = events.find(event => event.type === 'run/end')
    expect(runEnd?.data).toMatchObject({ status: 'failed' })
    expect(runEnd?.data).not.toHaveProperty('cancelled')
    expect(events.find(event => event.type === 'gate/fail')?.data).toMatchObject({
      status: 'fail', summary: 'Worker message receipt does not match its assigned run and task',
    })
    expect(JSON.stringify(events)).not.toContain('external cancellation')
  })

  it('keeps the whole-worktree claim when a step declares custom named resources', async () => {
    const root = await scratch()
    const firstStarted = deferred()
    const release = deferred()
    const started: string[] = []
    let active = 0
    let maximum = 0
    const run = coordinate({
      root, workspace: root, leaseRoot: masterDirectory(root), maxConcurrency: 2, maxRepairs: 0,
      plan: { title: 'named resources', goal: 'collect', hardware: [], steps: [
        step('default'),
        step('explicit', { resources: ['fixtures'] }),
      ] },
      runner: async (spec) => {
        started.push(spec.stepId)
        active++
        maximum = Math.max(maximum, active)
        if (spec.stepId === 'default') { firstStarted.resolve(); await release.promise }
        active--
        return result()
      },
    })
    let beforeRelease: string[] = []
    try {
      await firstStarted.promise
      await new Promise(resolve => setTimeout(resolve, 50))
      beforeRelease = [...started]
    } finally { release.resolve() }
    expect((await run).status).toBe('completed')
    expect(beforeRelease).toEqual(['default'])
    expect(maximum).toBe(1)
  })

  it('runs disjoint literal write claims concurrently and serializes whole-worktree fallback', async () => {
    const root = await scratch()
    const bothStarted = deferred()
    const finish = deferred()
    let active = 0
    let maximum = 0
    const defaultTask: PlanStep = { id: 'default', title: 'default', role: 'developer', detail: 'collect data',
      acceptance: ['result checked'], dependsOn: [] }
    const run = coordinate({
      root, workspace: root, leaseRoot: masterDirectory(root), maxConcurrency: 2, maxRepairs: 0,
      plan: { title: 'write claims', goal: 'collect', hardware: [], steps: [
        step('left', { access: 'write', writes: ['left/'] }),
        step('right', { access: 'write', writes: ['right/'] }),
        defaultTask,
      ] },
      runner: async (spec) => {
        active++
        maximum = Math.max(maximum, active)
        if (spec.stepId !== 'default') {
          if (active === 2) bothStarted.resolve()
          await finish.promise
        }
        active--
        return result()
      },
    })
    try {
      await bothStarted.promise
    } finally { finish.resolve() }
    const outcome = await run
    expect(outcome.status).toBe('completed')
    expect(maximum).toBe(2)
  })

  it('keeps prerequisite evidence and the latest failure in a dependent worker retry', async () => {
    const root = await scratch()
    let attempts = 0
    const outcome = await coordinate({
      root, workspace: root, leaseRoot: masterDirectory(root), maxAttempts: 2, maxRepairs: 0,
      plan: { title: 'retry evidence', goal: 'collect', hardware: [], steps: [step('a'), step('b', { dependsOn: ['a'] })] },
      runner: async (spec) => {
        if (spec.stepId === 'a') return { ...result(), output: result().output.replace('fixture result', 'prerequisite evidence marker') }
        if (++attempts === 1) return { ...result(false), output: result(false).output.replace('fixture result', 'latest failure marker') }
        expect(spec.prompt).toContain('prerequisite evidence marker')
        expect(spec.prompt).toContain('latest failure marker')
        return result()
      },
    })
    expect(outcome.status).toBe('completed')
    expect(outcome.steps[1]?.attempts).toBe(2)
  })

  it('continues independent tasks and blocks failed descendants including forward references', async () => {
    const root = await scratch()
    const started: string[] = []
    const outcome = await coordinate({
      root, workspace: root, leaseRoot: masterDirectory(root), maxConcurrency: 2, maxAttempts: 1, maxRepairs: 0,
      plan: { title: 'contained', goal: 'collect', hardware: [], steps: [
        step('grandchild', { dependsOn: ['child'] }), step('child', { dependsOn: ['bad'] }),
        step('bad'), step('independent'),
      ] },
      runner: async (spec) => { started.push(spec.stepId); return result(spec.stepId !== 'bad') },
    })
    expect(started).toEqual(['bad', 'independent'])
    expect(outcome.steps.map(item => item.status)).toEqual(['blocked', 'blocked', 'fail', 'pass'])
    const ledger = capabilityLedger(await new Journal(root).read())
    expect(ledger[0]).toMatchObject({ passed: 1, failed: 1, blocked: 2 })
  })

  it('serializes declared hardware and workspace resources despite independent dependencies', async () => {
    const root = await scratch()
    let active = 0
    let maximum = 0
    const outcome = await coordinate({
      root, workspace: root, leaseRoot: masterDirectory(root), maxConcurrency: 3, maxRepairs: 0,
      plan: { title: 'resources', goal: 'collect', hardware: ['gpu0'],
        steps: [step('a', { hardware: 'gpu0' }), step('b', { hardware: 'gpu0' }), step('c', { hardware: 'gpu0' })] },
      runner: async () => {
        active++
        maximum = Math.max(maximum, active)
        expect((await leaseStatus(masterDirectory(root), 'gpu0')).held).toBeDefined()
        active--
        return result()
      },
    })
    expect(outcome.status).toBe('completed')
    expect(maximum).toBe(1)
    expect((await leaseStatus(masterDirectory(root), 'gpu0')).held).toBeUndefined()
  })

  it('retains a resource through cancellation until the worker reports teardown complete', async () => {
    const root = await scratch()
    const controller = new AbortController()
    const started = deferred()
    const tornDown = deferred()
    const run = coordinate({
      root, workspace: root, leaseRoot: masterDirectory(root), maxRepairs: 0, signal: controller.signal,
      plan: { title: 'cancel', goal: 'collect', hardware: ['gpu0'], steps: [step('a', { hardware: 'gpu0' }), step('b')] },
      runner: async (spec) => {
        started.resolve()
        await tornDown.promise
        expect(spec.signal?.aborted).toBe(true)
        return result(false)
      },
    })
    try {
      await started.promise
      controller.abort()
      expect((await leaseStatus(masterDirectory(root), 'gpu0')).held).toBeDefined()
      await expect(acquireLease(masterDirectory(root), 'gpu0', { owner: 'contender', waitMs: 0 })).rejects.toBeInstanceOf(LeaseTimeoutError)
    } finally {
      tornDown.resolve()
    }
    expect((await run).status).toBe('cancelled')
    expect((await run).cleanupConfirmed).toBe(true)
    const outcome = (await run).steps[0]
    expect(outcome?.status).toBe('blocked')
    expect(outcome?.summary).toContain('cancelled during')
    expect(outcome?.summary).not.toContain('agent reported no')
    expect((await leaseStatus(masterDirectory(root), 'gpu0')).held).toBeUndefined()
  })

  it('quarantines resources and stops scheduling when descendant cleanup is unconfirmed', async () => {
    const root = await scratch()
    const started: string[] = []
    const outcome = await coordinate({
      root, workspace: root, leaseRoot: masterDirectory(root), maxRepairs: 0,
      plan: { title: 'cleanup', goal: 'collect', hardware: ['gpu0'], steps: [step('a', { hardware: 'gpu0' }), step('b')] },
      runner: async (spec) => { started.push(spec.stepId); throw new ProcessCleanupError('descendant termination unconfirmed') },
    })
    expect(started).toEqual(['a'])
    expect(outcome.steps.map(item => item.status)).toEqual(['fail', 'blocked'])
    expect(outcome.cleanupConfirmed).toBe(false)
    expect((await leaseStatus(masterDirectory(root), 'gpu0')).held).toBeDefined()
    expect((await new Journal(root).read()).some(event => event.type === 'lease/quarantine')).toBe(true)
  })

  it('distinguishes ordinary failed steps from unconfirmed teardown without resource leases', async () => {
    const root = await scratch()
    const options = { root, workspace: root, leaseRoot: masterDirectory(root), maxRepairs: 0, maxAttempts: 1,
      plan: { title: 'read-only cleanup', goal: 'inspect', hardware: [], steps: [step('read', { access: 'read-only' as const })] } }
    const ordinary = await coordinate({ ...options, runner: async () => result(false) })
    expect(ordinary).toMatchObject({ status: 'failed', cleanupConfirmed: true })
    const uncertain = await coordinate({ ...options,
      runner: async () => { throw new ProcessCleanupError('read-only descendant termination unconfirmed') } })
    expect(uncertain).toMatchObject({ status: 'failed', cleanupConfirmed: false })
  })

  it('records ordered activity and usage before completion and scopes improvisations to their run', async () => {
    const root = await scratch()
    const prior = new Journal(root)
    await prior.record('improvisation/report', { runId: 'older', id: 'older:step', reason: 'old deviation' })
    const outcome = await coordinate({
      root, workspace: root, leaseRoot: masterDirectory(root), maxRepairs: 0,
      plan: { title: 'activity', goal: 'collect', hardware: [], steps: [step('a')] },
      runner: async (spec) => {
        spec.onActivity?.({ kind: 'read', detail: 'read_file' })
        spec.onUsage?.({ inputTokens: 100, outputTokens: 20, elapsedMs: 2000, tokensPerSecond: 10 })
        spec.onUsage?.({ inputTokens: 120, outputTokens: 30, elapsedMs: 1500, tokensPerSecond: 20 })
        spec.onTokenSample?.({ tokens: 3, observedAt: 1000, basis: 'tokenizer', tokenizer: 'fixture' })
        spec.onTokenError?.('fixture unavailable')
        spec.onLog?.({ kind: 'command', text: 'nvcc kernel.cu' })
        return result()
      },
    })
    expect(outcome.status).toBe('completed')
    const events = await new Journal(root).read()
    const activity = events.find(event => event.type === 'agent/activity')
    expect(activity?.data).toMatchObject({ runId: outcome.runId, stepId: 'a', kind: 'read', detail: 'read_file' })
    expect(events.find(event => event.type === 'agent/token-sample')?.data).toMatchObject({
      runId: outcome.runId, stepId: 'a', tokens: 3, observedAt: 1000, tokenizer: 'fixture', basis: 'tokenizer',
    })
    expect(events.filter(event => event.type === 'agent/usage').map(event => event.data)).toEqual([
      { runId: outcome.runId, stepId: 'a', role: 'developer', attempt: 1, inputTokens: 100, outputTokens: 20, elapsedMs: 2000, tokensPerSecond: 10 },
      { runId: outcome.runId, stepId: 'a', role: 'developer', attempt: 1, inputTokens: 120, outputTokens: 30, elapsedMs: 1500, tokensPerSecond: 20 },
    ])
    expect(events.filter(event => event.type.startsWith('agent/')).map(event => event.type)).toEqual([
      'agent/start', 'agent/activity', 'agent/usage', 'agent/usage', 'agent/token-sample', 'agent/token-error', 'agent/log', 'agent/end',
    ])
    const evidence = capabilityLedger(events)
    expect(evidence[0]?.examples[0]).toMatchObject({ runId: outcome.runId, status: 'pass', durationMs: 10 })
  })

  it('records repository context and delivers preservation rules to a worker', async () => {
    const root = await gitRepository()
    await writeFile(path.join(root, 'tracked.txt'), 'user edit\n')
    await writeFile(path.join(root, 'staged.txt'), 'staged\n')
    await exec('git', ['-C', root, 'add', 'staged.txt'], { windowsHide: true })
    await writeFile(path.join(root, 'untracked.txt'), 'untracked\n')
    let prompt = ''
    const outcome = await coordinate({
      root, workspace: root, leaseRoot: masterDirectory(root), maxConcurrency: 1, maxAttempts: 1, maxRepairs: 0,
      plan: { title: 'preserve', goal: 'inspect context', hardware: [], steps: [step('a', { role: 'reviewer', access: 'read-only' })] },
      runner: async (spec) => { prompt = spec.prompt; return result() },
    })
    expect(outcome.status).toBe('completed')
    expect(prompt).toContain('Git worktree on branch `main`')
    expect(prompt).toContain('Write scope: read-only')
    expect(prompt).toContain('Modified: `tracked.txt`')
    expect(prompt).toContain('Staged: `staged.txt`')
    expect(prompt).toContain('Untracked: `untracked.txt`')
    expect(prompt).toContain('Do not run git commit')
    const repository = (await new Journal(root).read()).find(event => event.type === 'run/start')?.data.repository
    expect(repository).toMatchObject({ kind: 'git', branch: 'main', modified: ['tracked.txt'],
      staged: ['staged.txt'], untracked: ['untracked.txt'], complete: true })
    expect(typeof (repository as { head?: unknown }).head).toBe('string')
  })

  it('fails a step that writes outside its literal claim', async () => {
    const root = await scratch()
    const outcome = await coordinate({
      root, workspace: root, leaseRoot: masterDirectory(root), maxConcurrency: 1, maxAttempts: 1, maxRepairs: 0,
      plan: { title: 'undeclared', goal: 'audit writes', hardware: [], steps: [step('a', { access: 'write', writes: ['allowed.txt'] })] },
      runner: async () => {
        await writeFile(path.join(root, 'outside.txt'), 'not claimed\n')
        return result()
      },
    })
    expect(outcome.status).toBe('failed')
    expect(outcome.steps[0]?.summary).toContain('write audit failed')
    expect(outcome.steps[0]?.summary).toContain('outside.txt')
    expect(outcome.steps[0]?.auditProblem).toContain('outside.txt')
    expect(outcome.steps[0]?.changed).toEqual(['outside.txt'])
    const events = await new Journal(root).read()
    const audit = events.find(event => event.type === 'task/outcome')?.data.audit
    expect(audit).toMatchObject({
      complete: true,
      violations: [{ path: 'outside.txt', kind: 'undeclared-write' }],
    })
  })

  it('flags changed pre-existing work unless the step declares that exact path', async () => {
    const root = await scratch()
    await writeFile(path.join(root, 'existing.txt'), 'user work\n')
    const blocked = await coordinate({
      root, workspace: root, leaseRoot: masterDirectory(root), maxConcurrency: 1, maxAttempts: 1, maxRepairs: 0,
      plan: { title: 'preserve', goal: 'preserve dirty work', hardware: [], steps: [step('a')] },
      runner: async () => { await writeFile(path.join(root, 'existing.txt'), 'worker edit\n'); return result() },
    })
    expect(blocked.status).toBe('failed')
    expect(blocked.steps[0]?.summary).toContain('dirty-change')
    expect(await readFile(path.join(root, 'existing.txt'), 'utf8')).toBe('worker edit\n')

    const allowed = await coordinate({
      root, workspace: root, leaseRoot: masterDirectory(root), maxConcurrency: 1, maxAttempts: 1, maxRepairs: 0,
      plan: { title: 'declare', goal: 'edit the declared file', hardware: [],
        steps: [step('a', { access: 'write', writes: ['existing.txt'] })] },
      runner: async () => { await writeFile(path.join(root, 'existing.txt'), 'declared edit\n'); return result() },
    })
    expect(allowed.status).toBe('completed')
  })

  it('attributes parallel changes across the union of live claims', async () => {
    const root = await scratch()
    const bothStarted = deferred()
    const written = deferred()
    let started = 0
    const outcome = await coordinate({
      root, workspace: root, leaseRoot: masterDirectory(root), maxConcurrency: 2, maxAttempts: 1, maxRepairs: 0,
      plan: { title: 'attribution', goal: 'share the worktree', hardware: [], steps: [
        step('a', { access: 'write', writes: ['a.txt'] }),
        step('b', { access: 'write', writes: ['b.txt'] }),
      ] },
      runner: async (spec) => {
        started++
        if (started === 2) bothStarted.resolve()
        await bothStarted.promise
        if (spec.stepId === 'a') {
          await writeFile(path.join(root, 'b.txt'), 'written by a\n')
          written.resolve()
        } else {
          await written.promise
        }
        return result()
      },
    })
    expect(outcome.status).toBe('completed')
    expect(await readFile(path.join(root, 'b.txt'), 'utf8')).toBe('written by a\n')
    expect(outcome.steps.map(item => item.checks)).toEqual([
      ['result checked: yes, fixture command exited 0'], ['result checked: yes, fixture command exited 0'],
    ])
    expect(outcome.steps.find(item => item.stepId === 'a')?.changed).toContain('b.txt')
  })

  it('runs a settled diagnostic after a failed prerequisite without turning the run green', async () => {
    const root = await scratch()
    let reviewerPrompt = ''
    const outcome = await coordinate({
      root, workspace: root, leaseRoot: masterDirectory(root), maxConcurrency: 1, maxAttempts: 1, maxRepairs: 0,
      plan: { title: 'settled', goal: 'diagnose failure', hardware: [], steps: [
        step('bad'),
        step('review', { role: 'reviewer', dependsOn: ['bad'], dependencyPolicy: 'settled', access: 'read-only' }),
      ] },
      runner: async (spec) => {
        if (spec.stepId === 'bad') return { ...result(false), output: result(false).output.replace('fixture result', 'prerequisite broke') }
        reviewerPrompt = spec.prompt
        return result()
      },
    })
    expect(outcome.status).toBe('failed')
    expect(outcome.steps.map(item => item.status)).toEqual(['fail', 'pass'])
    expect(reviewerPrompt).toContain('prerequisite broke')
    expect(reviewerPrompt).toContain('settled diagnostic step')
    const events = await new Journal(root).read()
    expect(events.find(event => event.type === 'step/start' && event.data.stepId === 'review')?.data)
      .toMatchObject({ dependencyPolicy: 'settled', failedPrerequisites: ['bad'] })
  })

  it('fails an undeclared Git mutation and permits a declared git: write step', async () => {
    const root = await gitRepository()
    const auditFailure = await coordinate({
      root, workspace: root, leaseRoot: masterDirectory(root), maxConcurrency: 1, maxAttempts: 1, maxRepairs: 0,
      plan: { title: 'git mutation', goal: 'audit history', hardware: [], steps: [step('a')] },
      runner: async () => {
        await exec('git', ['-C', root, 'commit', '--allow-empty', '-q', '-m', 'worker commit'], { windowsHide: true })
        return result()
      },
    })
    expect(auditFailure.status).toBe('failed')
    expect(auditFailure.steps[0]?.summary).toContain('git-mutation')

    const declared = await coordinate({
      root, workspace: root, leaseRoot: masterDirectory(root), maxConcurrency: 1, maxAttempts: 1, maxRepairs: 0,
      plan: { title: 'declared git', goal: 'commit declared work', hardware: [], steps: [step('a', { git: 'write' })] },
      runner: async () => {
        await writeFile(path.join(root, 'declared.txt'), 'declared\n')
        await exec('git', ['-C', root, 'add', 'declared.txt'], { windowsHide: true })
        await exec('git', ['-C', root, 'commit', '-q', '-m', 'declared commit'], { windowsHide: true })
        return result()
      },
    })
    expect(declared.status).toBe('completed')
  })
})

describe('lease integrity and journals', () => {
  it('excludes workers in independent processes sharing one host namespace', async () => {
    const root = await scratch()
    const start = (owner: string) => {
      const child = spawn(process.execPath, ['--import', 'tsx/esm', fileURLToPath(new URL('./lease-worker.fixture.ts', import.meta.url)), masterDirectory(root), owner], {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
      })
      const acquired = deferred()
      let stderr = ''
      const stderrStream = child.stderr
      if (stderrStream === null) throw new Error('lease fixture requires stderr pipe')
      stderrStream.on('data', (data: Buffer) => { stderr += data.toString() })
      child.on('message', (message) => { if (message === 'acquired') acquired.resolve() })
      child.on('error', (error) => { acquired.reject(error) })
      const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
        child.once('exit', (code, signal) => { resolve({ code, signal }) })
      })
      onTestFinished(async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill()
        await exited
      })
      return { child, acquired: acquired.promise, exited, stderr: () => stderr }
    }
    const first = start('first')
    await first.acquired
    const second = start('second')
    await expect.poll(async () => (await leaseStatus(masterDirectory(root), 'gpu0')).waiting).toBe(1)
    expect((await leaseStatus(masterDirectory(root), 'gpu0')).held?.owner).toBe('first')
    first.child.send('release')
    expect(await first.exited, first.stderr()).toEqual({ code: 0, signal: null })
    await second.acquired
    expect((await leaseStatus(masterDirectory(root), 'gpu0')).held?.owner).toBe('second')
    second.child.send('release')
    expect(await second.exited, second.stderr()).toEqual({ code: 0, signal: null })
    expect((await leaseStatus(masterDirectory(root), 'gpu0')).held).toBeUndefined()
  })

  it('does not hand off an expired live lease and does not delete a different owner token', async () => {
    const root = await scratch()
    const first = await acquireLease(masterDirectory(root), 'gpu0', { owner: 'first', ttlMs: 1, now: () => 0 })
    await expect(acquireLease(masterDirectory(root), 'gpu0', { owner: 'second', waitMs: 0 })).rejects.toBeInstanceOf(LeaseTimeoutError)
    await releaseLease(masterDirectory(root), first)
    const second = await acquireLease(masterDirectory(root), 'gpu0', { owner: 'second' })
    await expect(releaseLease(masterDirectory(root), first)).rejects.toBeInstanceOf(LeaseLostError)
    expect((await leaseStatus(masterDirectory(root), 'gpu0')).held?.token).toBe(second.token)
    await releaseLease(masterDirectory(root), second)
  })

  it('refuses corrupt ownership and cancels queued acquisitions without removing the holder', async () => {
    const root = await scratch()
    const first = await acquireLease(masterDirectory(root), 'gpu0', { owner: 'first' })
    const controller = new AbortController()
    controller.abort()
    await expect(acquireLease(masterDirectory(root), 'gpu0', { owner: 'second', signal: controller.signal })).rejects.toThrow()
    expect((await leaseStatus(masterDirectory(root), 'gpu0')).held?.token).toBe(first.token)
    await releaseLease(masterDirectory(root), first)
    await writeFile(path.join(masterDirectory(root), 'leases', 'gpu0.lock'), '{')
    await expect(acquireLease(masterDirectory(root), 'gpu0', { owner: 'second', waitMs: 0 })).rejects.toBeInstanceOf(LeaseStateError)
  })

  it('serializes concurrent appends and keeps writer identities distinct across restarts', async () => {
    const root = await scratch()
    const journal = new Journal(root)
    await Promise.all(Array.from({ length: 20 }, (_, index) => journal.record('step/queued', { index })))
    const another = new Journal(root)
    await another.record('run/end')
    const events = await journal.read()
    expect(events.slice(0, 20).map(event => event.seq)).toEqual(Array.from({ length: 20 }, (_, index) => index))
    expect(events[0]?.writerId).not.toBe(events[20]?.writerId)
  })

  it('ignores only an unfinished final append and reports committed corruption', async () => {
    const root = await scratch()
    const journal = new Journal(root)
    await journal.record('run/start')
    const complete = await readFile(journal.file, 'utf8')
    await writeFile(journal.file, complete + '{')
    expect(await journal.read()).toHaveLength(1)
    await writeFile(journal.file, complete + '{}\n')
    await expect(journal.read()).rejects.toThrow('invalid at line 2')
  })

  it.each([{ type: 'future/unknown' }, { writerId: 42 }, { seq: -1 }])('rejects unsupported persisted event fields %j', async (fields) => {
    const root = await scratch()
    const journal = new Journal(root)
    const event = await journal.record('run/start')
    await writeFile(journal.file, JSON.stringify({ ...event, ...fields }) + '\n')
    await expect(journal.read()).rejects.toThrow('invalid at line 1')
  })
})
