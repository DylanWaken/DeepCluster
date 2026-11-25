/** Plan parsing, report protocol, hardware leases, and coordinator gating. */

import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { coordinate } from '../src/coordinator.ts'
import { WorkerTerminationError } from '../src/executor.ts'
import { detectHardware } from '../src/hardware.ts'
import { masterDirectory } from '../src/master.ts'
import { acquireLease, leaseStatus, LeaseTimeoutError, releaseLease } from '../src/lease.ts'
import { parsePlan, PlanFormatError, serializePlan } from '../src/plan.ts'
import { parseAgentReport, ReportFormatError } from '../src/protocol.ts'

const temporary: string[] = []

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'deep-cluster-core-'))
  temporary.push(dir)
  return dir
}

const PLAN_TEXT = `# GEMM optimization
goal: reach the performance target
hardware: gpu0

## Step 1: implement kernel
role: developer
acceptance:
- build passes
- kernel verifies
Write an optimized kernel.

## Step 2: measure
role: perf
hardware: gpu0
acceptance:
- report achieved tflops
Run the benchmark.
`

function report(status: string, extra = ''): string {
  return [
    'work done',
    '[[DEEPCLUSTER]]',
    `status: ${status}`,
    'summary: did the thing',
    'checks:',
    '- build passes: yes, fixture command exited 0',
    '- kernel verifies: yes, fixture command exited 0',
    '- report achieved tflops: yes, fixture command exited 0',
    '- report tflops: yes, fixture command exited 0',
    '- builds: yes, fixture command exited 0',
    'improvisation: no',
    '[[/DEEPCLUSTER]]',
  ].join('\n') + extra
}

describe('parsePlan', () => {
  it('reads goal, hardware, roles, and acceptance', () => {
    const plan = parsePlan(PLAN_TEXT)
    expect(plan.title).toBe('GEMM optimization')
    expect(plan.goal).toBe('reach the performance target')
    expect(plan.hardware).toEqual(['gpu0'])
    expect(plan.steps).toHaveLength(2)
    expect(plan.steps[0]?.role).toBe('developer')
    expect(plan.steps[0]?.acceptance).toEqual(['build passes', 'kernel verifies'])
    expect(plan.steps[1]?.hardware).toBe('gpu0')
  })

  it('round-trips through serializePlan', () => {
    const plan = parsePlan(PLAN_TEXT)
    const again = parsePlan(serializePlan(plan))
    expect(again.steps.map(step => step.id)).toEqual(plan.steps.map(step => step.id))
    expect(again.steps[1]?.hardware).toBe('gpu0')
  })

  it('rejects a plan with no goal', () => {
    expect(() => parsePlan('# t\n## Step 1: x\nrole: developer\n')).toThrow(PlanFormatError)
  })

  it('rejects an unknown role', () => {
    expect(() => parsePlan('# t\ngoal: g\n## Step 1: x\nrole: wizard\n')).toThrow(/needs role/u)
  })

  it.each(['', 'acceptance:\n- ', 'acceptance:\n- repeated\n- repeated'])('rejects missing or ambiguous acceptance labels: %j', (checks) => {
    expect(() => parsePlan(`# t\ngoal: g\n## Step 1: x\nrole: developer\n${checks}\n`)).toThrow(/acceptance labels/u)
  })

  it('preserves instruction lists after the acceptance block and through serialization', () => {
    const plan = parsePlan('# t\ngoal: g\n## Step 1: x\nrole: developer\nacceptance:\n- builds\n\n- Run the compiler.\n- Do not modify bench.cu.\n')
    expect(plan.steps[0]?.acceptance).toEqual(['builds'])
    expect(plan.steps[0]?.detail).toBe('- Run the compiler.\n- Do not modify bench.cu.')
    expect(parsePlan(serializePlan(plan)).steps).toEqual(plan.steps)
  })
})

describe('parseAgentReport', () => {
  it('reads a passing report', () => {
    const parsed = parseAgentReport(report('pass'))
    expect(parsed.parsed).toBe(true)
    expect(parsed.status).toBe('pass')
    expect(parsed.checks).toContain('build passes: yes, fixture command exited 0')
    expect(parsed.improvisation).toBeUndefined()
  })

  it('flags a missing block rather than guessing', () => {
    const parsed = parseAgentReport('I did some work, trust me')
    expect(parsed.parsed).toBe(false)
    expect(parsed.status).toBe('fail')
  })

  it('reads an improvisation', () => {
    const text = [
      '[[DEEPCLUSTER]]',
      'status: pass',
      'summary: adapted',
      'improvisation: yes',
      'kind: deviation',
      'reason: tile did not fit shared memory',
      'plan_change: use a smaller tile',
      '[[/DEEPCLUSTER]]',
    ].join('\n')
    const parsed = parseAgentReport(text)
    expect(parsed.improvisation).toEqual({
      kind: 'deviation',
      reason: 'tile did not fit shared memory',
      planChange: 'use a smaller tile',
    })
  })

  it('rejects an improvisation without a reason', () => {
    const text = '[[DEEPCLUSTER]]\nstatus: pass\nsummary: s\nimprovisation: yes\nkind: deviation\n[[/DEEPCLUSTER]]'
    expect(() => parseAgentReport(text)).toThrow(ReportFormatError)
  })

  it('rejects an unclosed block', () => {
    expect(() => parseAgentReport('[[DEEPCLUSTER]]\nstatus: pass')).toThrow(/never closed/u)
  })

  it('rejects an invalid status', () => {
    expect(() => parseAgentReport('[[DEEPCLUSTER]]\nstatus: great\n[[/DEEPCLUSTER]]')).toThrow(/status must be/u)
  })
})

describe('leases', () => {
  it('grants exclusive use and releases it', async () => {
    const root = await scratch()
    const lease = await acquireLease(masterDirectory(root), 'gpu0', { owner: 'perf', ttlMs: 5_000, waitMs: 1_000 })
    expect((await leaseStatus(masterDirectory(root), 'gpu0')).held?.owner).toBe('perf')
    await releaseLease(masterDirectory(root), lease)
    expect((await leaseStatus(masterDirectory(root), 'gpu0')).held).toBeUndefined()
  })

  it('makes a second agent wait until the first releases', async () => {
    const root = await scratch()
    const first = await acquireLease(masterDirectory(root), 'gpu0', { owner: 'a', ttlMs: 5_000, waitMs: 1_000 })
    await expect(acquireLease(masterDirectory(root), 'gpu0', { owner: 'b', ttlMs: 5_000, waitMs: 100 }))
      .rejects.toBeInstanceOf(LeaseTimeoutError)
    await releaseLease(masterDirectory(root), first)
    const second = await acquireLease(masterDirectory(root), 'gpu0', { owner: 'b', ttlMs: 5_000, waitMs: 1_000 })
    expect(second.owner).toBe('b')
    await releaseLease(masterDirectory(root), second)
  })

  it('retains an expired lease until its owner releases it', async () => {
    const root = await scratch()
    const dir = path.join(masterDirectory(root), 'leases')
    await mkdir(dir, { recursive: true })
    const dead = { resource: 'gpu0', owner: 'ghost', token: 'x', pid: process.pid, acquiredAt: new Date(0).toISOString(), expiresAt: new Date(1).toISOString() }
    await writeFile(path.join(dir, 'gpu0.lock'), JSON.stringify(dead), 'utf8')
    expect((await leaseStatus(masterDirectory(root), 'gpu0')).stale).toBe(true)
    await expect(acquireLease(masterDirectory(root), 'gpu0', { owner: 'live', ttlMs: 5_000, waitMs: 0 })).rejects.toBeInstanceOf(LeaseTimeoutError)
    expect((await leaseStatus(masterDirectory(root), 'gpu0')).held?.owner).toBe('ghost')
  })

  it('refuses to release a lease someone else now holds', async () => {
    const root = await scratch()
    const first = await acquireLease(masterDirectory(root), 'gpu0', { owner: 'a', ttlMs: 5_000, waitMs: 1_000 })
    await releaseLease(masterDirectory(root), first)
    await expect(releaseLease(masterDirectory(root), first)).resolves.toBeUndefined()
  })
})

describe('automatic hardware detection', () => {
  const step = (over: Record<string, unknown>) => ({
    id: 'step-x',
    title: 't',
    role: 'developer' as const,
    detail: '',
    acceptance: [],
    ...over,
  })

  it('serializes every perf step without the plan saying so', () => {
    const found = detectHardware(step({ role: 'perf' as const, title: 'measure' }))
    expect(found.map(item => item.name)).toEqual(['gpu0'])
    expect(found[0]?.reason).toMatch(/role/u)
  })

  it('serializes a step whose text runs a profiler or benchmark', () => {
    expect(detectHardware(step({ detail: 'run ncu --set full ./bench.exe' })).map(i => i.name)).toEqual(['gpu0'])
    expect(detectHardware(step({ detail: 'then run bench.exe at 4096' })).map(i => i.name)).toEqual(['gpu0'])
  })

  it('does not serialize prose that merely names a file or a metric', () => {
    expect(detectHardware(step({ detail: 'do not modify bench.cu or kernel.h' }))).toEqual([])
    expect(detectHardware(step({ acceptance: ['reports achieved TFLOPS against the roofline'] }))).toEqual([])
  })

  it('does not serialize ordinary implementation work', () => {
    expect(detectHardware(step({ detail: 'edit kernel.cu and build with nvcc' }))).toEqual([])
  })

  it('lets an explicit declaration win over inference', () => {
    const found = detectHardware(step({ role: 'perf' as const, hardware: 'gpu1' }))
    expect(found).toEqual([{ name: 'gpu1', reason: 'declared in the plan' }])
  })

  it('leases the hardware for an undeclared perf step during a run', async () => {
    const root = await scratch()
    const plan = parsePlan(`# auto
goal: g
## Step 1: measure
role: perf
acceptance:
- report tflops
`)
    const seen: string[] = []
    const result = await coordinate({
      root,
      leaseRoot: masterDirectory(root),
      workspace: root,
      plan,
      runner: async () => {
        const status = await leaseStatus(masterDirectory(root), 'gpu0')
        seen.push(status.held === undefined ? 'free' : 'held')
        return { ok: true, output: report('pass'), exitCode: 0, durationMs: 1 }
      },
    })
    expect(seen).toEqual(['held'])
    expect(result.status).toBe('completed')
    const journal = await readFile(result.journalFile, 'utf8')
    expect(journal).toContain('"automatic":true')
    expect((await leaseStatus(masterDirectory(root), 'gpu0')).held).toBeUndefined()
  })
})

describe('self-healing', () => {
  it('keeps configured permissions when a child cannot start', async () => {
    const root = await scratch()
    const plan = parsePlan(`# esc
goal: g
## Step 1: build
role: developer
acceptance:
- builds
`)
    const modes: (string | undefined)[] = []
    const result = await coordinate({
      root,
      leaseRoot: masterDirectory(root),
      workspace: root,
      plan,
      runner: async (spec) => {
        modes.push(spec.permissionMode)
        if (modes.length === 1) {
          return { ok: false, output: 'cmd.exe - Application Error: The application was unable to start correctly (0xc0000142).', exitCode: 1, durationMs: 1 }
        }
        return { ok: true, output: report('pass'), exitCode: 0, durationMs: 1 }
      },
    })
    expect(result.status).toBe('completed')
    expect(modes.every(mode => mode === 'danger-full-access')).toBe(true)
    const journal = await readFile(result.journalFile, 'utf8')
    expect(journal).not.toContain('sandbox/escalate')
  })

  it('keeps configured permissions after a silent timeout', async () => {
    const root = await scratch()
    const plan = parsePlan(`# hang
goal: g
## Step 1: build
role: developer
acceptance:
- builds
`)
    const modes: (string | undefined)[] = []
    const result = await coordinate({
      root,
      leaseRoot: masterDirectory(root),
      workspace: root,
      plan,
      maxRepairs: 0,
      runner: async (spec) => {
        modes.push(spec.permissionMode)
        if (modes.length === 1) return { ok: false, output: 'dsh: reasoning:\n', exitCode: 124, durationMs: 1 }
        return { ok: true, output: report('pass'), exitCode: 0, durationMs: 1 }
      },
    })
    expect(result.status).toBe('completed')
    expect(modes.every(mode => mode === 'danger-full-access')).toBe(true)
    const journal = await readFile(result.journalFile, 'utf8')
    expect(journal).not.toContain('sandbox/escalate')
  })

  it('runs a repair before retrying, without consuming the attempt budget', async () => {
    const root = await scratch()
    const plan = parsePlan(`# repair
goal: g
## Step 1: build
role: developer
acceptance:
- builds
`)
    const roles: string[] = []
    const result = await coordinate({
      root,
      leaseRoot: masterDirectory(root),
      workspace: root,
      plan,
      maxAttempts: 1,
      runner: async (spec) => {
        roles.push(spec.role)
        if (spec.role === 'fixer') return { ok: true, output: report('pass'), exitCode: 0, durationMs: 1 }
        // The first developer attempt fails, the retry after repair passes.
        const isRetry = roles.filter(role => role === 'developer').length > 1
        return { ok: isRetry, output: report(isRetry ? 'pass' : 'fail'), exitCode: isRetry ? 0 : 1, durationMs: 1 }
      },
    })
    expect(result.status).toBe('completed')
    expect(roles).toEqual(['developer', 'fixer', 'developer'])
    expect(result.steps[0]?.attempts).toBe(2)
    const journal = await readFile(result.journalFile, 'utf8')
    expect(journal).toContain('repair/start')
    expect(journal).toContain('repair/end')
  })

  it.each(['reviewer', 'developer'] as const)('preserves the %s task scope and hardware allocation in repair requests', async (role) => {
    const root = await scratch()
    const plan = parsePlan(`# Scoped repair
goal: inspect only the assigned evidence
## Step inspect: inspect saved evidence
role: ${role}
resources: none
${role === 'developer' ? 'hardware: fixture-device' : ''}
acceptance:
- builds

Read only reports/result.json; do not edit files or search other directories.
`)
    let repairPrompt = ''
    const result = await coordinate({
      root, leaseRoot: masterDirectory(root), workspace: root, plan, maxAttempts: 1, maxRepairs: 1,
      runner: async (spec) => {
        if (spec.role === 'fixer') {
          repairPrompt = spec.prompt
          expect(spec.hardware ?? []).toEqual(role === 'developer' ? ['fixture-device'] : [])
          return { ok: false, output: report('blocked'), exitCode: 1, durationMs: 1 }
        }
        return { ok: false, output: 'worker deadline exceeded', exitCode: 124, durationMs: 1 }
      },
    })
    expect(result.status).toBe('failed')
    expect(repairPrompt).toContain(plan.steps[0]?.detail)
    expect(repairPrompt).toContain('read-only tasks remain read-only')
    expect(repairPrompt).toContain('Worker exit code: 124')
    expect(repairPrompt).toMatchSnapshot(`${role} repair request`)
  })

  it('gives up after the repair budget is spent', async () => {
    const root = await scratch()
    const plan = parsePlan(`# broken
goal: g
## Step 1: build
role: developer
acceptance:
- builds
`)
    const result = await coordinate({
      root,
      leaseRoot: masterDirectory(root),
      workspace: root,
      plan,
      maxAttempts: 1,
      maxRepairs: 1,
      runner: async spec => ({
        ok: false,
        output: report(spec.role === 'fixer' ? 'blocked' : 'fail'),
        exitCode: 1,
        durationMs: 1,
      }),
    })
    expect(result.status).toBe('failed')
    const journal = await readFile(result.journalFile, 'utf8')
    expect(journal).toContain('repair/end')
    expect(journal).toContain('run/blocked')
  })
})

describe('coordinate', () => {
  it('runs every step and passes the gates', async () => {
    const root = await scratch()
    const plan = parsePlan(PLAN_TEXT)
    const result = await coordinate({ root, leaseRoot: masterDirectory(root), workspace: root, plan, runner: async () => ({ ok: true, output: report('pass'), exitCode: 0, durationMs: 1 }) })
    expect(result.status).toBe('completed')
    expect(result.steps.every(step => step.status === 'pass')).toBe(true)
    expect(result.steps.every(step => step.checks.includes('build passes: yes, fixture command exited 0'))).toBe(true)
    expect(result.steps.every(step => Array.isArray(step.changed))).toBe(true)
    expect(result.steps.every(step => step.auditProblem === undefined)).toBe(true)
    expect(await readFile(path.join(root, '.deep-cluster', '.gitignore'), 'utf8')).toBe('*\n')
  })

  it('holds the hardware lease only while the hardware step runs', async () => {
    const root = await scratch()
    const plan = parsePlan(PLAN_TEXT)
    const seen: string[] = []
    await coordinate({
      root,
      leaseRoot: masterDirectory(root),
      workspace: root,
      plan,
      runner: async (spec) => {
        const status = await leaseStatus(masterDirectory(root), 'gpu0')
        seen.push(`${spec.role}:${status.held === undefined ? 'free' : 'held'}`)
        return { ok: true, output: report('pass'), exitCode: 0, durationMs: 1 }
      },
    })
    expect(seen).toEqual(['developer:free', 'perf:held'])
    expect((await leaseStatus(masterDirectory(root), 'gpu0')).held).toBeUndefined()
  })

  it('retries a failed step and records both attempts', async () => {
    const root = await scratch()
    const plan = parsePlan(PLAN_TEXT)
    let calls = 0
    const result = await coordinate({
      root,
      leaseRoot: masterDirectory(root),
      workspace: root,
      plan,
      // No repair: this test pins the attempt budget, not self-healing.
      maxRepairs: 0,
      runner: async () => {
        calls++
        return { ok: calls > 1, output: report(calls > 1 ? 'pass' : 'fail'), exitCode: calls > 1 ? 0 : 1, durationMs: 1 }
      },
    })
    expect(result.status).toBe('completed')
    expect(result.steps[0]?.attempts).toBe(2)
  })

  it('fails the run when a step exhausts its attempts', async () => {
    const root = await scratch()
    const plan = parsePlan(PLAN_TEXT)
    const result = await coordinate({
      root,
      leaseRoot: masterDirectory(root),
      workspace: root,
      plan,
      maxAttempts: 2,
      runner: async () => ({ ok: false, output: report('fail'), exitCode: 1, durationMs: 1 }),
    })
    expect(result.status).toBe('failed')
    expect(result.steps[0]?.status).toBe('fail')
    expect(result.failure?.stepId).toBe('step-1')
  })

  it('reports an improvisation to the planner and waits for acknowledgement', async () => {
    const root = await scratch()
    const plan = parsePlan(PLAN_TEXT)
    const improvised = [
      '[[DEEPCLUSTER]]',
      'status: pass',
      'summary: used a smaller tile',
      'checks:',
      '- build passes: yes, fixture command exited 0',
      '- kernel verifies: yes, fixture command exited 0',
      '- report achieved tflops: yes, fixture command exited 0',
      'improvisation: yes',
      'kind: deviation',
      'reason: shared memory limit',
      'plan_change: 128x128 tile',
      '[[/DEEPCLUSTER]]',
    ].join('\n')
    const result = await coordinate({
      root,
      leaseRoot: masterDirectory(root),
      workspace: root,
      plan,
      runner: async () => ({ ok: true, output: improvised, exitCode: 0, durationMs: 1 }),
    })
    expect(result.status).toBe('needs-ack')
    expect(result.openImprovisations).toHaveLength(2)
    const journal = await readFile(result.journalFile, 'utf8')
    expect(journal).toContain('improvisation/report')
    expect(journal).toContain('run/end')
  })

  it('treats a missing report block as a gate failure', async () => {
    const root = await scratch()
    const plan = parsePlan(PLAN_TEXT)
    const result = await coordinate({
      root,
      leaseRoot: masterDirectory(root),
      workspace: root,
      plan,
      maxAttempts: 1,
      runner: async () => ({ ok: true, output: 'all done!', exitCode: 0, durationMs: 1 }),
    })
    expect(result.status).toBe('failed')
  })

  it('reports the cancellation phase instead of parsing a missing worker report', async () => {
    const root = await scratch()
    const plan = parsePlan('# cancel\ngoal: g\n## Step 1: build\nrole: developer\nacceptance:\n- builds\n')
    const controller = new AbortController()
    const started = Promise.withResolvers<undefined>()
    const run = coordinate({
      root, leaseRoot: masterDirectory(root), workspace: root, plan, maxAttempts: 1, maxRepairs: 0, signal: controller.signal,
      runner: async (spec) => {
        started.resolve(undefined)
        await new Promise<void>((resolve) => {
          if (spec.signal?.aborted === true) { resolve(); return }
          spec.signal?.addEventListener('abort', () => { resolve() }, { once: true })
        })
        return { ok: false, exitCode: 130, durationMs: 1, output: 'UTF-16 localhost-proxy warning' }
      },
    })
    await started.promise
    controller.abort()
    const result = await run
    expect(result.status).toBe('cancelled')
    expect(result.steps[0]?.status).toBe('blocked')
    expect(result.steps[0]?.summary).toContain('cancelled during')
    expect(result.steps[0]?.summary).not.toContain('agent reported no')
    const journal = await readFile(result.journalFile, 'utf8')
    expect(journal).not.toContain('agent reported no')
    expect(journal).toContain('"cancelled":true')
    expect(journal).toContain('"status":"cancelled"')
  })

  it('preserves a typed runtime termination cause without parsing output', async () => {
    const root = await scratch()
    const plan = parsePlan('# timeout\ngoal: g\n## Step 1: build\nrole: developer\nacceptance:\n- builds\n')
    const result = await coordinate({
      root, leaseRoot: masterDirectory(root), workspace: root, plan, maxAttempts: 1, maxRepairs: 0,
      runner: async () => { throw new WorkerTerminationError('timeout', 'cleanup') },
    })
    expect(result.status).toBe('failed')
    expect(result.steps[0]?.summary).toContain('worker timeout during cleanup')
    const journal = await readFile(result.journalFile, 'utf8')
    expect(journal).toContain('"termination":{"reason":"timeout","phase":"cleanup"}')
  })

  it('retries a typed timeout termination that was not caused by an abort', async () => {
    const root = await scratch()
    const plan = parsePlan('# retry timeout\ngoal: g\n## Step 1: build\nrole: developer\nacceptance:\n- builds\n')
    let calls = 0
    const result = await coordinate({
      root, leaseRoot: masterDirectory(root), workspace: root, plan, maxAttempts: 2, maxRepairs: 0,
      runner: async () => {
        calls++
        if (calls === 1) throw new WorkerTerminationError('timeout', 'running')
        return { ok: true, output: report('pass'), exitCode: 0, durationMs: 1 }
      },
    })
    expect(result.status).toBe('completed')
    expect(result.steps[0]?.attempts).toBe(2)
  })
})
