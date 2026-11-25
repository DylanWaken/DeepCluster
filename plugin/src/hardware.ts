/**
 * Exclusive hardware requirements from explicit declarations or conservative role/text heuristics.
 * Text matches can include saved reports and prohibited commands; they do not establish actual device use.
 * Plan authors can set `hardware: none` for CPU-only steps, including reviews of saved GPU evidence.
 *
 * @module @deepseek-ai/dsh-experimental-deep-cluster/hardware
 */

import { withoutPlanWide, type PlanStep, type RoleId } from './plan.ts'

/** One resource and the role/text rules that infer an exclusive requirement. */
export interface HardwareRule {
  /** Resource name used in leases and the journal, e.g. `gpu0`. */
  readonly name: string
  /** Roles assigned this resource when the step omits an explicit hardware declaration. */
  readonly roles?: readonly RoleId[]
  /** Patterns matched against the step's title, detail, and acceptance checks. */
  readonly patterns?: readonly RegExp[]
  /** Lease lifetime for this resource; defaults to the run setting. */
  readonly ttlMs?: number
}

/** A detected requirement and why it was detected. */
export interface HardwareRequirement {
  readonly name: string
  /** Human-readable declaration or heuristic match recorded for the planner. */
  readonly reason: string
}

/**
 * Built-in GPU heuristics matched against the step's role and text.
 * Tool names and executable references can match even when the task only reviews saved output.
 * Bare filenames, `tflops`, and `roofline` do not match these patterns.
 */
export const DEFAULT_HARDWARE_RULES: readonly HardwareRule[] = [
  {
    name: 'gpu0',
    roles: ['perf'],
    patterns: [
      /\bncu(?:\.exe)?\b/iu,
      /\bnsys(?:\.exe)?\b/iu,
      /\bnvidia-smi\b/iu,
      /\bcompute-sanitizer\b/iu,
      /\bcuda-memcheck\b/iu,
      /\bcuobjdump\b/iu,
      /\bnvdisasm\b/iu,
      // Nearby run verbs and executable names trigger the text heuristic.
      /\b(?:run|runs|running|execute|executes|invoke|profile|measure|benchmark)\b[^\n]{0,60}?\bbench(?:mark)?(?:\.exe)?\b/iu,
      /\b(?:run|runs|running|execute|executes|invoke)\b[^\n]{0,60}?\.exe\b/iu,
    ],
  },
]

/** Text a rule is matched against for one step; copied plan-wide prose is transport, not step intent. */
function stepText(step: PlanStep): string {
  return [step.title, withoutPlanWide(step.detail), ...step.acceptance].join('\n')
}

/**
 * Decide which exclusive resources a step needs.
 *
 * An explicit resource suppresses inference; `hardware: none` selects no hardware resources.
 * Omission applies the role/text rules, which do not inspect executed commands.
 * @param step - the step about to run.
 * @param rules - resource rules; defaults to the built-in GPU rule.
 * @returns requirements in stable name order, so concurrent agents can never
 *   deadlock by acquiring the same pair in opposite orders.
 */
export function detectHardware(
  step: PlanStep,
  rules: readonly HardwareRule[] = DEFAULT_HARDWARE_RULES,
): HardwareRequirement[] {
  if (step.hardware !== undefined) {
    if (step.hardware === 'none') return []
    return [{ name: step.hardware, reason: 'declared in the plan' }]
  }
  const text = stepText(step)
  const found = new Map<string, string>()
  for (const rule of rules) {
    if (rule.roles?.includes(step.role) === true) {
      found.set(rule.name, `role "${step.role}" uses ${rule.name}`)
      continue
    }
    for (const pattern of rule.patterns ?? []) {
      const match = pattern.exec(text)
      if (match !== null) {
        found.set(rule.name, `step text matches /${pattern.source}/ ("${match[0]}")`)
        break
      }
    }
  }
  return [...found.entries()]
    .map(([name, reason]) => ({ name, reason }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * Resolve declared or inferred hardware requirements for planning output.
 * @param steps - the plan's steps.
 * @param rules - role/text heuristics used when a step omits its hardware declaration.
 * @returns the requirements keyed by step id.
 */
export function planHardware(
  steps: readonly PlanStep[],
  rules: readonly HardwareRule[] = DEFAULT_HARDWARE_RULES,
): Map<string, HardwareRequirement[]> {
  return new Map(steps.map(step => [step.id, detectHardware(step, rules)]))
}
