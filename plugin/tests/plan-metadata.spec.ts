/** Step metadata ends before acceptance; instruction examples remain worker-visible text. */
import { expect, it } from 'vitest'
import { detectHardware } from '../src/hardware.ts'
import { combinePlans, parsePlan, planDependencies, serializePlan, stepGitWrite, stepWriteMode } from '../src/plan.ts'
import { buildRepairPrompt, buildRolePrompt, ROLES } from '../src/roles.ts'

const header = '# Recorded report review\ngoal: Check saved measurements\n'

function review(metadata: string, detail: string): string {
  return `## Step 2: Review saved ncu report\n${metadata}\nacceptance:\n- saved measurements agree\n\n${detail}\n`
}

it('retains metadata-looking instructions without changing omitted step settings', () => {
  const detail = 'Review this example only:\nrole: perf\nhardware: none\nmax_attempts: 99\ndepends_on: none\nresources: none'
  const plan = parsePlan(`${header}## Step 1: Collect references\nrole: reviewer\nacceptance:\n- references collected\n\n${review('role: reviewer', detail)}`)
  expect(plan.steps[1]).toEqual({ id: 'step-2', title: 'Review saved ncu report', role: 'reviewer',
    acceptance: ['saved measurements agree'], detail })
  expect(plan.hardware).toEqual([])
  expect(planDependencies(plan).get('step-2')).toEqual(['step-1'])
  expect(detectHardware(plan.steps[1]!)).toMatchObject([{ name: 'gpu0' }])
  expect(parsePlan(serializePlan(plan))).toEqual(plan)
})

it('does not accept an instruction example as the required role declaration', () => {
  expect(() => parsePlan(header + review('', 'role: reviewer'))).toThrow('needs role:')
})

it('reserves the supervisor sender identity from plan step ids', () => {
  expect(() => parsePlan('# Plan\ngoal: reserved identity\n## Step supervisor: report\nrole: developer\nacceptance:\n- done\n\nWork.\n'))
    .toThrow('reserved for authenticated supervisor feedback')
})

it.each(['hardware:', 'hardware: gpu0, gpu1', 'max_attempts: invalid', 'depends_on: missing', 'resources: none'])(
  'does not validate instruction text as metadata: %s', (detail) => {
    const plan = parsePlan(header + review('role: reviewer', detail))
    expect(plan.steps[0]).toEqual({ id: 'step-2', title: 'Review saved ncu report', role: 'reviewer',
      acceptance: ['saved measurements agree'], detail })
  },
)

it('retains explicit metadata before acceptance and roundtrips conflicting instruction examples', () => {
  const metadata = 'role: reviewer\nhardware: none\nmax_attempts: 2\ndepends_on: none\nresources: references'
  const detail = 'role: perf\nhardware: gpu0\nmax_attempts: 99\ndepends_on: missing\nresources: none'
  const plan = parsePlan(header + review(metadata, detail))
  expect(plan.steps[0]).toEqual({ id: 'step-2', title: 'Review saved ncu report', role: 'reviewer',
    hardware: 'none', maxAttempts: 2, dependsOn: [], resources: ['references'], acceptance: ['saved measurements agree'], detail })
  expect(parsePlan(serializePlan(plan))).toEqual(plan)
})

const PLAN_WIDE = 'Plan-wide constraints for every step:\n- Work only inside D:/fixture.\n- Do not edit generated reports.\n\nSecond paragraph: report every command with its exit code.'

function scopedPlan(): string {
  return `# Scope delivery
goal: deliver the plan-wide constraints
hardware: none

${PLAN_WIDE}

## Step one: inspect
role: reviewer
acceptance:
- fixture inspected

Inspect the fixture.

## Step two: apply
role: developer
acceptance:
- fixture updated

Apply the fix.
`
}

it('delivers multi-paragraph pre-step constraints to every normal and repair prompt once', () => {
  const plan = parsePlan(scopedPlan())
  expect(plan.steps.map(step => step.id)).toEqual(['one', 'two'])
  for (const step of plan.steps) {
    expect(step.detail).toContain(PLAN_WIDE)
    expect(step.detail.indexOf('[Plan-wide instructions')).toBeLessThan(step.detail.indexOf('[This step\'s instructions]'))
    expect(step.detail).not.toContain('goal: deliver the plan-wide constraints')
  }
  const inspect = plan.steps[0]!
  const normal = buildRolePrompt({ role: ROLES[inspect.role], step: inspect, planTitle: plan.title, planGoal: plan.goal, attempt: 1 })
  expect(normal).toContain(PLAN_WIDE)
  expect(normal).toContain('Inspect the fixture.')
  expect(normal.split('Work only inside D:/fixture.').length - 1).toBe(1)
  const apply = plan.steps[1]!
  const repair = buildRepairPrompt({ step: apply, failedRole: apply.role, planTitle: plan.title, planGoal: plan.goal,
    failureOutput: 'fixture command exited 1', exitCode: 1, hardware: [], permissionMode: 'danger-full-access' })
  expect(repair).toContain(PLAN_WIDE)
  expect(repair).toContain('Apply the fix.')
  expect(repair.split('Work only inside D:/fixture.').length - 1).toBe(1)
})

it('keeps plans without preamble prose behaviorally unchanged', () => {
  const plan = parsePlan('# Plain\ngoal: plain goal\nhardware: none\n\n## Step 1: work\nrole: developer\nacceptance:\n- done\n\nDo it.\n')
  expect(plan.steps[0]?.detail).toBe('Do it.')
  expect(serializePlan(plan)).not.toContain('Plan-wide')
  expect(parsePlan(serializePlan(plan))).toEqual(plan)
})

it('round-trips plan-wide prose exactly once', () => {
  const plan = parsePlan(scopedPlan())
  const serialized = serializePlan(plan)
  const reparsed = parsePlan(serialized)
  expect(reparsed).toEqual(plan)
  expect((reparsed.steps[0]?.detail.split('[Plan-wide instructions').length ?? 1) - 1).toBe(1)
  expect(serializePlan(reparsed)).toBe(serialized)
})

it('keeps each preamble inside its own plan when DAGs are combined', () => {
  const alpha = parsePlan('# Alpha\ngoal: alpha goal\n\nALPHA SCOPE: stay in alpha.\n\n## Step 1: alpha task\nrole: developer\nacceptance:\n- alpha checked\n\nApply alpha.\n')
  const beta = parsePlan('# Beta\ngoal: beta goal\n\nBETA SCOPE: stay in beta.\n\n## Step 1: beta task\nrole: reviewer\nacceptance:\n- beta checked\n\nApply beta.\n')
  const batch = combinePlans([alpha, beta])
  const details = new Map(batch.steps.map(step => [step.id, step.detail] as const))
  expect(details.get('plan-1.step-1')).toContain('ALPHA SCOPE')
  expect(details.get('plan-1.step-1')).not.toContain('BETA SCOPE')
  expect(details.get('plan-2.step-1')).toContain('BETA SCOPE')
  expect(details.get('plan-2.step-1')).not.toContain('ALPHA SCOPE')
  expect(planDependencies(batch).get('plan-2.step-1')).toEqual([])
  const serialized = serializePlan(batch)
  expect(serialized.split('\n').some(line => line.startsWith('Beta: beta goal'))).toBe(false)
  const reparsed = parsePlan(serialized)
  expect(reparsed.steps.map(step => step.detail)).toEqual(batch.steps.map(step => step.detail))
  expect(reparsed.goal).toContain('Alpha: alpha goal')
  expect(reparsed.goal).toContain('Beta: beta goal')
  for (const step of reparsed.steps) expect(step.detail).not.toContain('Beta: beta goal')
})

function stepPrompts(plan: ReturnType<typeof parsePlan>, index: number): { normal: string; repair: string } {
  const step = plan.steps[index]!
  return {
    normal: buildRolePrompt({ role: ROLES[step.role], step, planTitle: plan.title, planGoal: plan.goal, attempt: 1 }),
    repair: buildRepairPrompt({ step, failedRole: step.role, planTitle: plan.title, planGoal: plan.goal,
      failureOutput: 'fixture command exited 1', exitCode: 1, hardware: [], permissionMode: 'danger-full-access' }),
  }
}

it('preserves header prose before, between, and after actual goal/hardware metadata', () => {
  const plan = parsePlan(`# Scope delivery
Do not read /example/unrelated-project.
goal: Inspect exactly the named fixture.
Preserve every user file.
hardware: none
Use only the named input paths.

## Step 1: inspect
role: reviewer
acceptance:
- fixture inspected

Inspect the fixture.
`)
  const step = plan.steps[0]!
  const prose = ['Do not read /example/unrelated-project.', 'Preserve every user file.', 'Use only the named input paths.']
  expect(plan.title).toBe('Scope delivery')
  expect(plan.goal).toBe('Inspect exactly the named fixture.')
  expect(plan.hardware).toEqual([])
  for (const line of prose) expect(step.detail.split(line).length - 1).toBe(1)
  expect(step.detail.indexOf(prose[0]!)).toBeLessThan(step.detail.indexOf(prose[1]!))
  expect(step.detail.indexOf(prose[1]!)).toBeLessThan(step.detail.indexOf(prose[2]!))
  expect(step.detail).not.toContain('goal: Inspect exactly the named fixture.')
  expect(step.detail).not.toContain('hardware: none')
  const { normal, repair } = stepPrompts(plan, 0)
  for (const prompt of [normal, repair]) {
    for (const line of prose) expect(prompt.split(line).length - 1).toBe(1)
  }
})

it('delivers metadata-looking prose instead of truncating at the last-looking line', () => {
  const plan = parsePlan(`# Scope
goal: real goal
hardware: none

SCOPE BEFORE.
Goal: preserve the public API.
Hardware: do not touch gpu1.
SCOPE AFTER.

## Step 1: work
role: reviewer
acceptance:
- work checked

Do the work.
`)
  const step = plan.steps[0]!
  const prose = ['SCOPE BEFORE.', 'Goal: preserve the public API.', 'Hardware: do not touch gpu1.', 'SCOPE AFTER.']
  expect(plan.goal).toBe('real goal')
  expect(plan.hardware).toEqual([])
  for (const line of prose) expect(step.detail.split(line).length - 1).toBe(1)
  expect(step.detail.indexOf(prose[0]!)).toBeLessThan(step.detail.indexOf(prose[1]!))
  expect(step.detail.indexOf(prose[1]!)).toBeLessThan(step.detail.indexOf(prose[2]!))
  expect(step.detail.indexOf(prose[2]!)).toBeLessThan(step.detail.indexOf(prose[3]!))
  expect(step.detail).not.toContain('goal: real goal')
  expect(step.detail).not.toContain('hardware: none')
  const { normal, repair } = stepPrompts(plan, 0)
  for (const prompt of [normal, repair]) {
    for (const line of prose) expect(prompt.split(line).length - 1).toBe(1)
  }
})

it('keeps metadata-only and untitled preambles from changing legacy detail', () => {
  const plain = parsePlan('goal: plain goal\nhardware: none\n\n## Step 1: work\nrole: developer\nacceptance:\n- done\n\nDo it.\n')
  expect(plain.title).toBe('Untitled plan')
  expect(plain.steps[0]?.detail).toBe('Do it.')

  const untitled = parsePlan(`goal: untitled goal
Do not edit generated reports.
hardware: none
Keep paths exact.

## Step 1: work
role: developer
acceptance:
- done

Do it.
`)
  expect(untitled.goal).toBe('untitled goal')
  expect(untitled.hardware).toEqual([])
  expect(untitled.steps[0]?.detail).toContain('Do not edit generated reports.\nKeep paths exact.')
  expect(untitled.steps[0]?.detail).toContain('Do it.')
})

it('keeps plan-wide prohibitions out of hardware inference without disabling own-step inference', () => {
  const plan = parsePlan(`# CPU review
goal: review saved reports

Never run nvidia-smi on this host; review saved reports.

## Step 1: review report
role: reviewer
acceptance:
- report reviewed

Read the saved report.
`)
  const step = plan.steps[0]!
  expect(step.detail).toContain('Never run nvidia-smi on this host; review saved reports.')
  expect(detectHardware(step)).toEqual([])
  expect(detectHardware({ ...step, detail: 'Read the saved report.' })).toEqual([])
  const { normal, repair } = stepPrompts(plan, 0)
  expect(normal).toContain('Never run nvidia-smi on this host; review saved reports.')
  expect(repair).toContain('Never run nvidia-smi on this host; review saved reports.')

  const own = parsePlan(`# GPU action
goal: inspect device

Never run nvidia-smi unless the step says so.

## Step 1: inspect device
role: reviewer
acceptance:
- device inspected

Run nvidia-smi once and save its output.
`)
  const ownStep = own.steps[0]!
  expect(detectHardware(ownStep)).toMatchObject([{ name: 'gpu0' }])
  expect(detectHardware({ ...ownStep, hardware: 'none' })).toEqual([])
  expect(detectHardware({ ...ownStep, hardware: 'gpu0' })).toEqual([{ name: 'gpu0', reason: 'declared in the plan' }])
  expect(detectHardware({ ...ownStep, hardware: 'gpu7' })).toEqual([{ name: 'gpu7', reason: 'declared in the plan' }])
  expect(detectHardware({ ...ownStep, role: 'perf', detail: 'Read the saved report.' })).toMatchObject([{ name: 'gpu0' }])
})

it('keeps metadata and dependency semantics when preamble prose is present', () => {
  const plan = parsePlan(`# Metadata and scope
goal: check metadata
hardware: gpu9

Global rule: do not use more than one GPU.

## Step 1: prepare
role: developer
hardware: gpu9
max_attempts: 2
depends_on: none
resources: shared-output
acceptance:
- prepared

Prepare the inputs.

## Step 2: verify
role: tester
depends_on: 1
acceptance:
- verified

Verify the inputs.
`)
  expect(plan.title).toBe('Metadata and scope')
  expect(plan.goal).toBe('check metadata')
  expect(plan.hardware).toEqual(['gpu9'])
  expect(plan.steps[0]).toMatchObject({ role: 'developer', hardware: 'gpu9', maxAttempts: 2, dependsOn: [], resources: ['shared-output'] })
  expect(plan.steps[1]?.dependsOn).toEqual(['step-1'])
  expect(planDependencies(plan).get('step-2')).toEqual(['step-1'])
  for (const step of plan.steps) {
    expect(step.detail).toContain('Global rule: do not use more than one GPU.')
    expect(step.detail).not.toContain('# Metadata and scope')
    expect(step.detail).not.toContain('goal: check metadata')
    expect(step.detail).not.toContain('hardware: gpu9')
  }
  expect(plan.steps[0]?.detail).toContain('Prepare the inputs.')
  expect(plan.steps[1]?.detail).toContain('Verify the inputs.')
})

it('parses and round-trips write-claim, Git and dependency-policy metadata', () => {
  const plan = parsePlan(`# Claims
goal: harden scheduling
## Step 1: edit
role: developer
access: write
writes: src/plan.ts, tests/
max_attempts: 2
depends_on: none
dependency_policy: settled
resources: fixtures
acceptance:
- claim checked

Edit only the declared paths.
`)
  expect(plan.steps[0]).toMatchObject({
    access: 'write', writes: ['src/plan.ts', 'tests/'], dependencyPolicy: 'settled', resources: ['fixtures'],
  })
  expect(stepWriteMode(plan.steps[0]!)).toEqual({ kind: 'paths', paths: ['src/plan.ts', 'tests/'] })
  expect(stepGitWrite(plan.steps[0]!)).toBe(false)
  expect(parsePlan(serializePlan(plan))).toEqual(plan)

  const gitPlan = parsePlan(`# Git write
goal: commit declared work
## Step 1: commit
role: developer
git: write
acceptance:
- committed
`)
  expect(gitPlan.steps[0]).toMatchObject({ git: 'write' })
  expect(stepWriteMode(gitPlan.steps[0]!)).toEqual({ kind: 'whole' })
  expect(stepGitWrite(gitPlan.steps[0]!)).toBe(true)
  expect(parsePlan(serializePlan(gitPlan))).toEqual(gitPlan)
})

it('keeps omitted write metadata as an exclusive whole-worktree claim', () => {
  const plan = parsePlan('# Default\ngoal: write everything\n## Step 1: work\nrole: developer\nacceptance:\n- done\n\nWork.\n')
  expect(plan.steps[0]?.access).toBeUndefined()
  expect(stepWriteMode(plan.steps[0]!)).toEqual({ kind: 'whole' })
  expect(stepGitWrite(plan.steps[0]!)).toBe(false)
  const readOnly = parsePlan('# Read\ngoal: inspect\n## Step 1: work\nrole: reviewer\naccess: read-only\nacceptance:\n- done\n\nInspect.\n')
  expect(stepWriteMode(readOnly.steps[0]!)).toEqual({ kind: 'read-only' })
})

it.each([
  'access: execute',
  'access: read-only\nwrites: src/a.ts',
  'writes: src/a.ts',
  'access: write\ngit: read',
  'access: write\nwrites: src/a.ts\ngit: write',
  'dependency_policy: always',
])('rejects incompatible or unknown ownership metadata: %s', (metadata) => {
  const plan = `# Invalid\ngoal: reject\n## Step 1: work\nrole: developer\n${metadata}\nacceptance:\n- done\n\nWork.\n`
  expect(() => parsePlan(plan)).toThrow()
})

it.each(['writes: /absolute.ts', 'writes: C:/drive.ts', 'writes: src/*.ts', 'writes: ../escape.ts', 'writes: .git/config'])(
  'rejects an unsafe write declaration at parse time: %s', (metadata) => {
    const plan = `# Unsafe\ngoal: reject\ngoal: reject\n## Step 1: work\nrole: developer\naccess: write\n${metadata}\nacceptance:\n- done\n\nWork.\n`
    expect(() => parsePlan(plan)).toThrow()
  },
)

it('delivers write scope and preservation context in role and repair prompts', () => {
  const plan = parsePlan('# Scope\ngoal: own files\n## Step 1: edit\nrole: developer\naccess: write\nwrites: src/a.ts\nacceptance:\n- done\n\nEdit.\n')
  const step = plan.steps[0]!
  const workspace = {
    kind: 'git' as const, head: 'a'.repeat(40), branch: 'main',
    staged: ['staged.ts'], modified: ['dirty.ts'], untracked: ['new.ts'], truncated: false,
    writeMode: stepWriteMode(step), gitWrite: false,
  }
  const normal = buildRolePrompt({ role: ROLES.developer, step, planTitle: plan.title, planGoal: plan.goal, attempt: 1, workspace })
  expect(normal).toContain('Write scope: only these repository-relative paths: `src/a.ts`')
  expect(normal).toContain('Preserve this pre-existing work byte-for-byte')
  expect(normal).toContain('Staged: `staged.ts`')
  expect(normal).toContain('Do not run git commit')
  const repair = buildRepairPrompt({ step, failedRole: 'developer', planTitle: plan.title, planGoal: plan.goal,
    failureOutput: 'failed', exitCode: 1, hardware: [], permissionMode: 'danger-full-access', workspace })
  expect(repair).toContain('Write scope: only these repository-relative paths: `src/a.ts`')
})
