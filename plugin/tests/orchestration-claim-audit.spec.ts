/** Write-audit attribution across concurrent claims, released history and Git index identity. */
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, it, onTestFinished } from 'vitest'
import { coordinate, type AgentRunResult } from '../src/coordinator.ts'
import { Journal } from '../src/journal.ts'
import { masterDirectory } from '../src/master.ts'
import type { PlanStep } from '../src/plan.ts'

const exec = promisify(execFile)

async function scratch(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'deep-cluster-claim-audit-'))
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
  return root
}

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

function deferred(): { promise: Promise<undefined>; resolve: () => void } {
  const pending = Promise.withResolvers<undefined>()
  return { promise: pending.promise, resolve: () => { pending.resolve(undefined) } }
}

function step(id: string, extra: Partial<PlanStep> = {}): PlanStep {
  return { id, title: id, role: 'developer', detail: 'collect data', acceptance: ['result checked'],
    dependsOn: [], resources: [], ...extra }
}

function result(ok = true): AgentRunResult {
  return { ok, exitCode: ok ? 0 : 1, durationMs: 10, output:
    `[[DEEPCLUSTER]]\nstatus: ${ok ? 'pass' : 'fail'}\nsummary: fixture result\nchecks:\n- result checked: yes, fixture command exited 0\nimprovisation: no\n[[/DEEPCLUSTER]]` }
}

it('does not reject concurrent legitimate edits of separate pre-existing dirty files', async () => {
  const root = await scratch()
  await writeFile(path.join(root, 'left.txt'), 'left work\n')
  await writeFile(path.join(root, 'right.txt'), 'right work\n')
  const bothWritten = deferred()
  let written = 0
  const outcome = await coordinate({
    root, workspace: root, leaseRoot: masterDirectory(root), maxConcurrency: 2, maxAttempts: 1, maxRepairs: 0,
    plan: { title: 'concurrent dirty work', goal: 'preserve each writer', hardware: [], steps: [
      step('left', { access: 'write', writes: ['left.txt'] }),
      step('right', { access: 'write', writes: ['right.txt'] }),
    ] },
    runner: async (spec) => {
      await writeFile(path.join(root, spec.stepId === 'left' ? 'left.txt' : 'right.txt'), `${spec.stepId} edit\n`)
      written++
      if (written === 2) bothWritten.resolve()
      await bothWritten.promise
      return result()
    },
  })
  expect(outcome.status).toBe('completed')
  expect(outcome.steps.map(item => item.status)).toEqual(['pass', 'pass'])
  const events = await new Journal(root).read()
  for (const stepId of ['left', 'right']) {
    const audit = events.find(event => event.type === 'task/outcome' && event.data.stepId === stepId)?.data.audit
    expect(audit).toMatchObject({ complete: true, violations: [] })
  }
})

it('attributes a short operation released entirely inside a long operation', async () => {
  const root = await scratch()
  const longStarted = deferred()
  const shortReleased = deferred()
  const outcome = await coordinate({
    root, workspace: root, leaseRoot: masterDirectory(root), maxConcurrency: 2, maxAttempts: 1, maxRepairs: 0,
    plan: { title: 'nested operations', goal: 'attribute the short writer', hardware: [], steps: [
      step('long', { role: 'reviewer', access: 'read-only' }),
      step('short', { access: 'write', writes: ['short.txt'] }),
    ] },
    onEvent: (event) => {
      if (event.type === 'lease/release' && event.data.stepId === 'short' && event.data.kind === 'write-claim') {
        shortReleased.resolve()
      }
    },
    runner: async (spec) => {
      if (spec.stepId === 'long') {
        longStarted.resolve()
        await shortReleased.promise
        return result()
      }
      await longStarted.promise
      await writeFile(path.join(root, 'short.txt'), 'written inside the long operation\n')
      return result()
    },
  })
  expect(outcome.status).toBe('completed')
  const events = await new Journal(root).read()
  const longAudit = events.find(event => event.type === 'task/outcome' && event.data.stepId === 'long')?.data.audit
  expect(longAudit).toMatchObject({ complete: true, violations: [] })
})

it('authorizes a nested scope alias by canonical absolute path during auditing', async () => {
  const parent = await scratch()
  const child = path.join(parent, 'child')
  await mkdir(child, { recursive: true })
  const aWritten = deferred()
  const bWritten = deferred()
  const [parentOutcome, childOutcome] = await Promise.all([
    coordinate({
      root: parent, workspace: parent, leaseRoot: masterDirectory(parent), maxConcurrency: 1, maxAttempts: 1, maxRepairs: 0,
      plan: { title: 'parent writer', goal: 'write the child path', hardware: [],
        steps: [step('a', { access: 'write', writes: ['child/a.txt'] })] },
      runner: async () => {
        await writeFile(path.join(child, 'a.txt'), 'parent claim\n')
        aWritten.resolve()
        await bWritten.promise
        return result()
      },
    }),
    coordinate({
      root: child, workspace: child, leaseRoot: masterDirectory(parent), maxConcurrency: 1, maxAttempts: 1, maxRepairs: 0,
      plan: { title: 'child writer', goal: 'write its own path', hardware: [],
        steps: [step('b', { access: 'write', writes: ['b.txt'] })] },
      runner: async () => {
        await aWritten.promise
        await writeFile(path.join(child, 'b.txt'), 'child claim\n')
        bWritten.resolve()
        return result()
      },
    }),
  ])
  expect(parentOutcome.status).toBe('completed')
  expect(childOutcome.status).toBe('completed')
})

it('reports pruned claim history as unattributable instead of naming a writer', async () => {
  const root = await scratch()
  const outcome = await coordinate({
    root, workspace: root, leaseRoot: masterDirectory(root), maxConcurrency: 1, maxAttempts: 1, maxRepairs: 0,
    plan: { title: 'incomplete evidence', goal: 'report uncertainty', hardware: [],
      steps: [step('a', { role: 'reviewer', access: 'read-only' })] },
    runner: async () => {
      await writeFile(path.join(root, 'outside.txt'), 'unattributable\n')
      await mkdir(masterDirectory(root), { recursive: true })
      await writeFile(path.join(masterDirectory(root), 'claim-history.json'),
        JSON.stringify({ records: [], prunedThrough: new Date().toISOString() }))
      return result()
    },
  })
  expect(outcome.status).toBe('failed')
  expect(outcome.steps[0]?.summary).toContain('claim history was pruned through')
  const audit = (await new Journal(root).read())
    .find(event => event.type === 'task/outcome' && event.data.stepId === 'a')?.data.audit
  expect(audit).toMatchObject({ complete: false, violations: [] })
  expect(String((audit as { error?: unknown }).error)).toContain('cannot be attributed')
})

it('detects re-staging changed content of an already-staged file as an undeclared Git mutation', async () => {
  const root = await gitRepository()
  await writeFile(path.join(root, 'tracked.txt'), 'staged one\n')
  await exec('git', ['-C', root, 'add', 'tracked.txt'], { windowsHide: true })
  const outcome = await coordinate({
    root, workspace: root, leaseRoot: masterDirectory(root), maxConcurrency: 1, maxAttempts: 1, maxRepairs: 0,
    plan: { title: 'index drift', goal: 'audit the index', hardware: [],
      steps: [step('a', { access: 'write', writes: ['tracked.txt'] })] },
    runner: async () => {
      await writeFile(path.join(root, 'tracked.txt'), 'staged two\n')
      await exec('git', ['-C', root, 'add', 'tracked.txt'], { windowsHide: true })
      return result()
    },
  })
  expect(outcome.status).toBe('failed')
  expect(outcome.steps[0]?.summary).toContain('git-mutation')
  expect(outcome.steps[0]?.summary).toContain('tracked.txt')
})
