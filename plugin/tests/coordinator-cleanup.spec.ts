/** Secondary journal failures preserve unconfirmed cleanup without reclassifying settled workers. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { coordinate, type AgentRunner } from '../src/coordinator.ts'
import { ProcessCleanupError } from '../src/executor.ts'
import { Journal, type JournalEventType } from '../src/journal.ts'
import { leaseStatus } from '../src/lease.ts'
import { masterDirectory } from '../src/master.ts'

async function fixture(failingEvent: JournalEventType, runner: AgentRunner) {
  const root = await mkdtemp(path.join(tmpdir(), 'deep-cluster-cleanup-journal-'))
  const failure = new Error(`Cannot write ${failingEvent}`), journal = new Journal(root)
  const original = journal.record.bind(journal)
  const writer = vi.spyOn(Journal.prototype, 'record').mockImplementation((type, data) => {
    if (type === failingEvent) throw failure
    return original(type, data)
  })
  onTestFinished(async () => { writer.mockRestore(); await rm(root, { recursive: true, force: true }) })
  const leaseRoot = masterDirectory(root)
  const run = coordinate({ root, workspace: root, leaseRoot, maxAttempts: 1, maxRepairs: 0,
    plan: { title: 'Settlement', goal: 'Inspect cleanup', hardware: ['gpu0'], steps: [{ id: 'inspect', title: 'Inspect',
      role: 'reviewer', access: 'read-only', hardware: 'gpu0', detail: '', acceptance: ['inspected'], dependsOn: [] }] }, runner })
  return { run, failure, leaseRoot }
}

it.each(['lease/quarantine', 'run/end'] as const)('preserves unconfirmed cleanup when %s cannot be recorded', async (event) => {
  const h = await fixture(event, async () => { throw new ProcessCleanupError('Descendant cleanup is unconfirmed') })
  const failure = await h.run.then(() => { throw new Error('Expected failed settlement') }, (error: unknown) => error)
  expect(failure).toBeInstanceOf(ProcessCleanupError)
  expect(failure).toHaveProperty('cause', h.failure)
  expect((await leaseStatus(h.leaseRoot, 'gpu0')).held).toBeDefined()
})

it('preserves an ordinary final journal failure after the worker and its resources have settled', async () => {
  const h = await fixture('run/end', async () => ({ ok: true, exitCode: 0, durationMs: 1,
    output: '[[DEEPCLUSTER]]\nstatus: pass\nsummary: Inspected\nchecks:\n- inspected: fixture evidence\nimprovisation: no\n[[/DEEPCLUSTER]]' }))
  await expect(h.run).rejects.toBe(h.failure)
  expect((await leaseStatus(h.leaseRoot, 'gpu0')).held).toBeUndefined()
})
