/** Lease diagnostics, active renewal and fail-closed renewal loss. */
import { mkdtemp, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { coordinate } from '../src/coordinator.ts'
import { Journal } from '../src/journal.ts'
import { acquireLease, leaseStatus, releaseLease } from '../src/lease.ts'
import { masterDirectory } from '../src/master.ts'
import { listWriteClaims } from '../src/claims.ts'
import type { PlanStep } from '../src/plan.ts'

async function scratch(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'deep-cluster-lease-status-'))
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
  return root
}

function step(extra: Partial<PlanStep> = {}): PlanStep {
  return { id: 'work', title: 'work', role: 'developer', detail: '', acceptance: ['result checked'], dependsOn: [], ...extra }
}

function result(): { ok: boolean; exitCode: number; durationMs: number; output: string } {
  return { ok: true, exitCode: 0, durationMs: 1,
    output: '[[DEEPCLUSTER]]\nstatus: pass\nsummary: fixture result\nchecks:\n- result checked: yes, fixture exited 0\nimprovisation: no\n[[/DEEPCLUSTER]]' }
}

it('renews a held lease while a worker runs past the original diagnostic lifetime', async () => {
  const root = await scratch()
  const started = Promise.withResolvers<undefined>()
  const run = coordinate({
    root, workspace: root, leaseRoot: masterDirectory(root), maxConcurrency: 1, maxAttempts: 1, maxRepairs: 0,
    leaseTtlMs: 240, leaseWaitMs: 1_000,
    plan: { title: 'heartbeat', goal: 'stay fresh', hardware: ['gpu0'], steps: [step({ hardware: 'gpu0', access: 'read-only' })] },
    runner: async () => {
      started.resolve(undefined)
      await new Promise(resolve => setTimeout(resolve, 900))
      return result()
    },
  })
  await started.promise
  await new Promise(resolve => setTimeout(resolve, 500))
  const status = await leaseStatus(masterDirectory(root), 'gpu0')
  expect(status.held).toBeDefined()
  expect(status.stale).toBe(false)
  expect(status.expired).toBe(false)
  expect(status.ownerAlive).toBe(true)
  expect(Date.parse(status.held?.expiresAt ?? '')).toBeGreaterThan(Date.now())
  expect((await run).status).toBe('completed')
  expect((await leaseStatus(masterDirectory(root), 'gpu0')).held).toBeUndefined()
})

it('keeps separate expired and ownerAlive diagnostics without reclaiming', async () => {
  const root = await scratch()
  const held = await acquireLease(masterDirectory(root), 'gpu0', { owner: 'fixture', ttlMs: 1 })
  await new Promise(resolve => setTimeout(resolve, 15))
  const status = await leaseStatus(masterDirectory(root), 'gpu0')
  expect(status.expired).toBe(true)
  expect(status.ownerAlive).toBe(true)
  expect(status.stale).toBe(true)
  expect(status.held?.token).toBe(held.token)
  await releaseLease(masterDirectory(root), held)
})

it('quarantines ownership and fails the run when a claim renewal loses its token', async () => {
  const root = await scratch()
  const started = Promise.withResolvers<undefined>()
  const run = coordinate({
    root, workspace: root, leaseRoot: masterDirectory(root), maxConcurrency: 1, maxAttempts: 1, maxRepairs: 0,
    leaseTtlMs: 240, leaseWaitMs: 1_000,
    plan: { title: 'renewal loss', goal: 'fail closed', hardware: ['gpu0'],
      steps: [step({ hardware: 'gpu0', access: 'write', writes: ['out.txt'] })] },
    runner: async (spec) => {
      started.resolve(undefined)
      await new Promise<void>((resolve) => {
        if (spec.signal?.aborted === true) { resolve(); return }
        spec.signal?.addEventListener('abort', () => { resolve() }, { once: true })
      })
      return { ...result(), ok: false, exitCode: 1 }
    },
  })
  await started.promise
  await new Promise(resolve => setTimeout(resolve, 150))
  const records = await listWriteClaims(masterDirectory(root))
  expect(records.length).toBeGreaterThan(0)
  for (const record of records) await unlink(path.join(masterDirectory(root), 'claims', record.id))
  const outcome = await run
  expect(outcome.status).toBe('failed')
  expect(outcome.steps[0]?.summary).toContain('renewal failed')
  const events = await new Journal(root).read()
  expect(events.some(event => event.type === 'lease/quarantine')).toBe(true)
  expect(events.some(event => event.type === 'lease/release' && event.data.stepId === 'work')).toBe(false)
  expect((await leaseStatus(masterDirectory(root), 'gpu0')).held).toBeDefined()
})
