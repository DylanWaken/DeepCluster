/** Explicit CPU-only plans bypass conservative text-based hardware inference. */
import { expect, it } from 'vitest'
import { detectHardware, planHardware } from '../src/hardware.ts'
import { combinePlans, parsePlan, serializePlan, type PlanStep } from '../src/plan.ts'

function planText(stepHardware: string, header = ''): string {
  return `# Saved report review\ngoal: Review recorded measurements\n${header}\n## Step 1: Review NCU and SASS evidence\nrole: reviewer\n${stepHardware}\nacceptance:\n- counters match the saved report\n\nRead saved ncu, cuobjdump and nvdisasm reports only.\n`
}

const step: PlanStep = { id: 'review', title: 'Review saved NCU report', role: 'reviewer',
  detail: 'Read cuobjdump and nvdisasm output.', acceptance: ['saved counters checked'] }

it('preserves a CPU-only override through parsing, rendering, and batch composition', () => {
  const plan = parsePlan(planText('hardware: none', 'hardware: none'))
  expect(plan.steps[0]?.hardware).toBe('none')
  expect(plan.hardware).toEqual([])
  expect(detectHardware(plan.steps[0]!)).toEqual([])
  expect(serializePlan(plan)).toContain('role: reviewer\nhardware: none\n')
  expect(parsePlan(serializePlan(plan))).toEqual(plan)
  const named = parsePlan(planText('hardware: gpu2'))
  const combined = combinePlans([plan, named])
  expect(combined.hardware).toEqual(['gpu2'])
  expect(combined.steps[0]?.hardware).toBe('none')
  expect([...planHardware(combined.steps).values()]).toEqual([[], [{ name: 'gpu2', reason: 'declared in the plan' }]])
})

it('lets explicit none suppress role and custom-rule inference', () => {
  expect(detectHardware({ ...step, role: 'perf', hardware: 'none' })).toEqual([])
  expect(detectHardware({ ...step, hardware: 'none' }, [{ name: 'gpu1', roles: ['reviewer'] }])).toEqual([])
})

it('retains explicit named leases and ordinary role/text inference without an override', () => {
  expect(detectHardware({ ...step, hardware: 'gpu2' })).toEqual([{ name: 'gpu2', reason: 'declared in the plan' }])
  expect(detectHardware({ ...step, role: 'perf', title: 'Measure throughput', detail: '' })).toEqual([
    { name: 'gpu0', reason: 'role "perf" uses gpu0' },
  ])
  expect(detectHardware(step)).toMatchObject([{ name: 'gpu0' }])
})

it.each(['hardware:', 'hardware: gpu0, gpu1', 'hardware: none, gpu0'])('rejects ambiguous step hardware: %s', (declaration) => {
  expect(() => parsePlan(planText(declaration))).toThrow('hardware must name one resource or none')
})

it('rejects mixing none with named resources in the plan header', () => {
  expect(() => parsePlan(planText('hardware: none', 'hardware: gpu0, none'))).toThrow('hardware: none cannot be combined with resource names')
})
