/**
 * The pre-written plan that a DeepCluster run executes.
 *
 * A plan is authored by the planner (an AI planner or a human) before any agent
 * starts. It names, per step, which role owns the work, what "done" means, and
 * whether the step needs exclusive hardware. Keeping the plan as a document the
 * planner wrote — rather than instructions assembled at runtime — is what makes
 * "did the plan get followed?" answerable afterwards.
 *
 * @module @deepseek-ai/dsh-experimental-deep-cluster/plan
 */

import { ClaimPathError, normalizeClaimPath } from './scope.ts'
import { SUPERVISOR_STEP_ID } from './mailbox.ts'

/** The roles a step can be assigned to. */
export type RoleId = 'developer' | 'reviewer' | 'tester' | 'perf' | 'fixer'

/** How a step may write to the worktree. */
export type StepAccess = 'read-only' | 'write'

/** How a diagnostic step treats failed prerequisites. */
export type DependencyPolicy = 'success' | 'settled'

/** One unit of work in the plan. */
export interface PlanStep {
  /** Stable id, e.g. `step-1`; used in the journal and in improvisation reports. */
  readonly id: string
  readonly title: string
  /** Which specialist agent runs this step. */
  readonly role: RoleId
  /**
   * Free-text instructions the role agent receives. When the plan has preamble prose,
   * this begins with a marked plan-wide block copied from that preamble.
   */
  readonly detail: string
  /** At least one nonblank, unique check label; the agent reports evidence for each one. */
  readonly acceptance: readonly string[]
  /** One exclusive resource name, e.g. `gpu0`; `none` disables hardware inference, while omission applies role/text heuristics. */
  readonly hardware?: string
  /** Attempt budget for this step. Defaults to the run's setting. */
  readonly maxAttempts?: number
  /** Prerequisite step ids. Omission depends on the previous step; an empty list is independent. */
  readonly dependsOn?: readonly string[]
  /**
   * Write access declaration. Omission reserves the whole physical worktree exclusively.
   * `read-only` declares no source writes. `write` without `writes` also reserves the
   * whole worktree; `write` with `writes` permits disjoint concurrent writers.
   */
  readonly access?: StepAccess
  /**
   * Literal repository-relative paths this step may change. A trailing `/` declares a
   * directory and its descendants. Globs, absolute paths, `..` escapes, `.git` and
   * coordinator metadata are rejected. Requires `access: write`.
   */
  readonly writes?: readonly string[]
  /**
   * `write` declares that this step may mutate Git metadata. It requires whole-worktree
   * access and serializes with other Git-writing worktrees through the shared common-directory
   * lock. Omission forbids commit, reset, stash, clean, add and similar mutations.
   */
  readonly git?: 'write'
  /**
   * Prerequisite settlement. `success` (default) requires every prerequisite to pass.
   * `settled` waits for terminal prerequisite outcomes and runs even after failure so a
   * diagnostic can inspect the evidence; it never turns an overall failed run green.
   */
  readonly dependencyPolicy?: DependencyPolicy
  /** Exclusive exact-match names added to this step's write claim; never replaces that claim. */
  readonly resources?: readonly string[]
  /** Source plan title when several plans are dispatched as one batch. */
  readonly planTitle?: string
  /** Source plan goal retained for the worker and task ledger in a batch. */
  readonly planGoal?: string
}

/** A complete plan. */
export interface Plan {
  readonly title: string
  /** The outcome the whole plan must produce. */
  readonly goal: string
  /** Named resources declared anywhere in the plan, excluding the step override `none`. */
  readonly hardware: readonly string[]
  readonly steps: readonly PlanStep[]
}

/** Resolved write scope of one step. */
export type StepWriteMode =
  | { readonly kind: 'whole' }
  | { readonly kind: 'read-only' }
  | { readonly kind: 'paths'; readonly paths: readonly string[] }

/**
 * Resolve a step's write declaration.
 * @param step - plan step with optional access/writes metadata.
 * @returns whole-worktree when undeclared, read-only when declared, or the literal path list.
 */
export function stepWriteMode(step: PlanStep): StepWriteMode {
  if (step.access === 'read-only') return { kind: 'read-only' }
  if (step.access === 'write' && (step.writes?.length ?? 0) > 0) return { kind: 'paths', paths: step.writes ?? [] }
  return { kind: 'whole' }
}

/**
 * Whether the step declared a Git metadata mutation.
 * @param step - plan step.
 * @returns true only for an explicit `git: write` declaration.
 */
export function stepGitWrite(step: PlanStep): boolean {
  return step.git === 'write'
}

const ROLES: readonly RoleId[] = ['developer', 'reviewer', 'tester', 'perf', 'fixer']

/** Markers that separate copied plan-preamble prose from a step's own instructions. */
const PLAN_WIDE_OPEN = '[Plan-wide instructions — apply to every step]'
const PLAN_WIDE_CLOSE = '[End of plan-wide instructions]'
const STEP_OWN_OPEN = '[This step\'s instructions]'

/** Raised when a plan document cannot be understood. */
export class PlanFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlanFormatError'
  }
}

/** Normalize numeric step references in headings and dependency lists. */
function stepId(value: string): string {
  return /^\d+$/u.test(value) ? `step-${value}` : value
}

/** Read a comma-separated list; `none` and `[]` explicitly select no entries. */
function list(value: string): string[] {
  if (value === 'none' || value === '[]' || value === '') return []
  return value.split(',').map(item => item.trim()).filter(Boolean)
}

/**
 * Resolve and validate task dependencies before starting workers.
 * @param plan - plan whose ids, dependency edges, attempt budgets, access and claim paths are checked.
 * @returns prerequisite ids for every step; throws for duplicate ids, cycles, or missing references.
 */
export function planDependencies(plan: Plan): ReadonlyMap<string, readonly string[]> {
  const dependencies = new Map<string, readonly string[]>()
  for (const [index, step] of plan.steps.entries()) {
    if (dependencies.has(step.id)) throw new PlanFormatError(`duplicate step id "${step.id}"`)
    if (step.id === SUPERVISOR_STEP_ID) {
      throw new PlanFormatError(`step id "${step.id}" is reserved for authenticated supervisor feedback`)
    }
    const labels = step.acceptance.map(label => label.trim())
    if (labels.length === 0 || labels.some(label => label === '') || new Set(labels).size !== labels.length) {
      throw new PlanFormatError(`step "${step.id}" needs nonempty, unique acceptance labels`)
    }
    if (step.maxAttempts !== undefined && (!Number.isSafeInteger(step.maxAttempts) || step.maxAttempts < 1)) {
      throw new PlanFormatError(`step "${step.id}" max_attempts must be a positive integer`)
    }
    const writes = step.writes ?? []
    if (step.access === 'read-only' && writes.length > 0) {
      throw new PlanFormatError(`step "${step.id}" declares access: read-only and cannot declare writes`)
    }
    if (writes.length > 0 && step.access !== 'write') {
      throw new PlanFormatError(`step "${step.id}" needs access: write to declare writes`)
    }
    for (const write of writes) {
      try {
        normalizeClaimPath(write)
      } catch (error) {
        if (error instanceof ClaimPathError) throw new PlanFormatError(`step "${step.id}" ${error.message}`)
        throw error
      }
    }
    if (step.git === 'write') {
      if (step.access === 'read-only') throw new PlanFormatError(`step "${step.id}" declares git: write and cannot be read-only`)
      if (writes.length > 0) throw new PlanFormatError(`step "${step.id}" git: write requires whole-worktree access, not disjoint writes`)
    }
    const previous = plan.steps[index - 1]
    dependencies.set(step.id, step.dependsOn ?? (previous === undefined ? [] : [previous.id]))
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new PlanFormatError(`dependency cycle includes step "${id}"`)
    if (visited.has(id)) return
    const required = dependencies.get(id)
    if (required === undefined) throw new PlanFormatError(`dependency references missing step "${id}"`)
    visiting.add(id)
    for (const dependency of required) visit(dependency)
    visiting.delete(id)
    visited.add(id)
  }
  for (const step of plan.steps) visit(step.id)
  return dependencies
}

/**
 * Combine independent plans without creating dependency edges between their roots.
 * @param plans - parsed plans; each plan retains its own dependency and resource declarations.
 * @returns one graph with namespaced step ids and original task context; a single plan is unchanged.
 */
export function combinePlans(plans: readonly Plan[]): Plan {
  const first = plans[0]
  if (first === undefined) throw new PlanFormatError('a batch needs at least one plan')
  const dependencies = plans.map(plan => planDependencies(plan))
  if (plans.length === 1) return first
  const steps = plans.flatMap((plan, index) => {
    const prefix = `plan-${String(index + 1)}.`
    return plan.steps.map(step => ({
      ...step,
      id: prefix + step.id,
      dependsOn: (dependencies[index]?.get(step.id) ?? []).map(id => prefix + id),
      planTitle: step.planTitle ?? plan.title,
      planGoal: step.planGoal ?? plan.goal,
    }))
  })
  return {
    title: `Batch of ${String(plans.length)} plans`,
    goal: plans.map(plan => `${plan.title}: ${plan.goal}`).join('\n'),
    hardware: [...new Set(plans.flatMap(plan => plan.hardware))],
    steps,
  }
}

/** Read `key: value` from a step header block. */
function field(lines: readonly string[], key: string): string | undefined {
  const prefix = `${key}:`
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.toLowerCase().startsWith(prefix)) return trimmed.slice(prefix.length).trim()
  }
  return undefined
}

/** Locate the metadata end and acceptance list, preserving subsequent instructions as task detail. */
function acceptanceBlock(lines: readonly string[]): { items: string[]; start: number; end: number } {
  const start = lines.findIndex(line => line.trim().toLowerCase() === 'acceptance:')
  if (start < 0) return { items: [], start: lines.length, end: lines.length }
  const items: string[] = []
  let end = start + 1
  for (const line of lines.slice(end)) {
    const trimmed = line.trim()
    if (trimmed === '' && items.length === 0) { end++; continue }
    if (!trimmed.startsWith('-')) break
    items.push(trimmed.slice(1).trim())
    end++
  }
  return { items, start, end }
}

/**
 * Read free-form instructions from the plan header.
 * The title and the first `goal:`/`hardware:` lines stay metadata; every other header line,
 * including later metadata-looking prose, is preserved in its original order.
 * @param header - lines before the first step heading.
 * @param titleIndex - index of the plan title line, or -1 when the document has no title.
 * @returns preamble prose with internal blank lines preserved; empty when there is none.
 */
function headerPreface(header: readonly string[], titleIndex: number): string {
  const seenMetadata = new Set<string>()
  const prose: string[] = []
  for (const [index, line] of header.entries()) {
    if (index === titleIndex) continue
    const key = line.trim().toLowerCase()
    if (key.startsWith('goal:') && !seenMetadata.has('goal')) {
      seenMetadata.add('goal')
      continue
    }
    if (key.startsWith('hardware:') && !seenMetadata.has('hardware')) {
      seenMetadata.add('hardware')
      continue
    }
    prose.push(line)
  }
  return prose.join('\n').trim()
}

/**
 * Prepend plan-wide prose to a step's own instructions without dropping either part.
 * @param preface - free-form text from the plan header.
 * @param detail - the step's own text after its acceptance list.
 * @returns a marked plan-wide block followed by the step's instructions, or `detail` when there is no preface.
 */
function withPlanWide(preface: string, detail: string): string {
  if (preface === '') return detail
  const block = `${PLAN_WIDE_OPEN}\n${preface}\n${PLAN_WIDE_CLOSE}`
  return detail === '' ? block : `${block}\n\n${STEP_OWN_OPEN}\n${detail}`
}

/**
 * Remove the copied plan-wide block from a step's instructions.
 * Text heuristics use this so header prose cannot change a step's inferred hardware.
 * @param detail - the step's effective instructions.
 * @returns the step's own instructions; text without a copied block is unchanged.
 */
export function withoutPlanWide(detail: string): string {
  const open = `${PLAN_WIDE_OPEN}\n`
  if (!detail.startsWith(open)) return detail
  const close = `\n${PLAN_WIDE_CLOSE}`
  const closeIndex = detail.indexOf(close, open.length)
  if (closeIndex < 0) return detail
  let own = detail.slice(closeIndex + close.length)
  if (own.startsWith('\n\n')) own = own.slice(2)
  const marker = `${STEP_OWN_OPEN}\n`
  if (own.startsWith(marker)) own = own.slice(marker.length)
  return own
}

/**
 * Parse a plan document.
 * Step metadata precedes `acceptance:`; text after the acceptance list is retained as worker instructions.
 * Free-form header text other than the title and the first `goal:`/`hardware:` lines is copied
 * into every step's instructions as a marked plan-wide block, ahead of that step's own text.
 *
 * Format:
 * ```
 * # Title
 * goal: one sentence
 * hardware: gpu0, gpu1
 *
 * Plan-wide instructions for every step...
 *
 * ## Step 1: title
 * role: developer
 * hardware: gpu0
 * acceptance:
 * - build passes
 * - kernel verifies
 * Free text instructions...
 * ```
 * @param text - the plan document.
 * @returns the parsed plan.
 */
export function parsePlan(text: string): Plan {
  const lines = text.split(/\r?\n/u)
  const titleIndex = lines.findIndex(line => line.trim().startsWith('# '))
  const title = titleIndex < 0 ? 'Untitled plan' : (lines[titleIndex] as string).trim().slice(2).trim()
  const firstStep = lines.findIndex(line => line.trim().startsWith('## '))
  const header = firstStep < 0 ? lines : lines.slice(0, firstStep)
  const preface = headerPreface(header, titleIndex)
  const goal = field(header, 'goal')
  if (goal === undefined || goal === '') throw new PlanFormatError('plan needs a "goal:" line')
  const hardwareText = field(header, 'hardware') ?? ''
  const hardware = (hardwareText === 'none' ? '' : hardwareText)
    .split(',')
    .map(item => item.trim())
    .filter(item => item !== '')
  if (hardware.includes('none')) throw new PlanFormatError('hardware: none cannot be combined with resource names')

  const steps: PlanStep[] = []
  let current: string[] | undefined
  const flush = (block: readonly string[]): void => {
    const heading = block.find(line => line.trim().startsWith('## '))
    if (heading === undefined) return
    const headingText = heading.trim().slice(3).trim()
    const match = /^(?:Step\s+)?([\w.-]+)\s*:\s*(.+)$/iu.exec(headingText)
    if (match === null) throw new PlanFormatError(`step heading needs "## Step <id>: <title>", got "${headingText}"`)
    // A bare number is normalised to `step-<n>` so journal and improvisation ids
    // are unambiguous and stable regardless of how the planner wrote the heading.
    const rawId = match[1] as string
    const id = stepId(rawId)
    const stepTitle = (match[2] as string).trim()
    const acceptance = acceptanceBlock(block)
    const metadata = block.slice(0, acceptance.start)
    const roleText = (field(metadata, 'role') ?? '').toLowerCase()
    if (!ROLES.includes(roleText as RoleId)) {
      throw new PlanFormatError(`step "${id}" needs role: one of ${ROLES.join(', ')}`)
    }
    const stepHardware = field(metadata, 'hardware')
    if (stepHardware !== undefined && (stepHardware === '' || stepHardware.includes(','))) {
      throw new PlanFormatError(`step "${id}" hardware must name one resource or none`)
    }
    const maxAttemptsText = field(metadata, 'max_attempts')
    const dependencies = field(metadata, 'depends_on')
    const resources = field(metadata, 'resources')
    const accessText = field(metadata, 'access')?.toLowerCase()
    if (accessText !== undefined && accessText !== 'read-only' && accessText !== 'write') {
      throw new PlanFormatError(`step "${id}" access must be read-only or write; got "${accessText}"`)
    }
    const writesText = field(metadata, 'writes')
    const gitText = field(metadata, 'git')?.toLowerCase()
    if (gitText !== undefined && gitText !== 'write') {
      throw new PlanFormatError(`step "${id}" git must be write when declared; got "${gitText}"`)
    }
    const policyText = field(metadata, 'dependency_policy')?.toLowerCase()
    if (policyText !== undefined && policyText !== 'success' && policyText !== 'settled') {
      throw new PlanFormatError(`step "${id}" dependency_policy must be success or settled; got "${policyText}"`)
    }
    const detail = withPlanWide(preface, block.slice(acceptance.end).join('\n').trim())
    steps.push({
      id,
      title: stepTitle,
      role: roleText as RoleId,
      detail,
      acceptance: acceptance.items,
      ...stepHardware === undefined ? {} : { hardware: stepHardware },
      ...maxAttemptsText === undefined ? {} : { maxAttempts: Number(maxAttemptsText) },
      ...dependencies === undefined ? {} : { dependsOn: list(dependencies).map(stepId) },
      ...resources === undefined ? {} : { resources: list(resources) },
      ...accessText === undefined ? {} : { access: accessText },
      ...writesText === undefined ? {} : { writes: list(writesText) },
      ...gitText === undefined ? {} : { git: 'write' as const },
      ...policyText === undefined ? {} : { dependencyPolicy: policyText },
    })
  }
  for (const line of lines) {
    if (line.trim().startsWith('## ')) {
      if (current !== undefined) flush(current)
      current = [line]
    } else if (current !== undefined) {
      current.push(line)
    }
  }
  if (current !== undefined) flush(current)
  if (steps.length === 0) throw new PlanFormatError('plan has no "## Step <id>: <title>" sections')

  const declared = new Set(hardware)
  for (const step of steps) if (step.hardware !== undefined && step.hardware !== 'none') declared.add(step.hardware)
  const plan = { title, goal, hardware: [...declared], steps }
  planDependencies(plan)
  return plan
}

/**
 * Render a plan goal as single-line metadata.
 * `combinePlans` keeps each source goal on its own line; flattening them with a separator keeps
 * every goal word without emitting a secondary goal-looking line that `parsePlan` would treat as
 * plan-wide prose. This pre-existing format limitation only loses the original line breaks.
 */
function goalMetadata(goal: string): string {
  return goal.split(/\r?\n/u).map(line => line.trim()).filter(line => line !== '').join(' | ')
}

/**
 * Render a plan back to its document form.
 * @param plan - the plan to render.
 * @returns a document `parsePlan` accepts.
 */
export function serializePlan(plan: Plan): string {
  const out: string[] = [`# ${plan.title}`, `goal: ${goalMetadata(plan.goal)}`, `hardware: ${plan.hardware.join(', ')}`, '']
  for (const step of plan.steps) {
    out.push(`## Step ${step.id}: ${step.title}`)
    out.push(`role: ${step.role}`)
    if (step.hardware !== undefined) out.push(`hardware: ${step.hardware}`)
    if (step.access !== undefined) out.push(`access: ${step.access}`)
    if (step.writes !== undefined) out.push(`writes: ${step.writes.length === 0 ? 'none' : step.writes.join(', ')}`)
    if (step.git !== undefined) out.push(`git: ${step.git}`)
    if (step.maxAttempts !== undefined) out.push(`max_attempts: ${String(step.maxAttempts)}`)
    if (step.dependsOn !== undefined) out.push(`depends_on: ${step.dependsOn.length === 0 ? 'none' : step.dependsOn.join(', ')}`)
    if (step.dependencyPolicy !== undefined) out.push(`dependency_policy: ${step.dependencyPolicy}`)
    if (step.resources !== undefined) out.push(`resources: ${step.resources.length === 0 ? 'none' : step.resources.join(', ')}`)
    if (step.acceptance.length > 0) {
      out.push('acceptance:')
      for (const item of step.acceptance) out.push(`- ${item}`)
    }
    if (step.detail !== '') out.push('', step.detail)
    out.push('')
  }
  return out.join('\n')
}

/**
 * Find the first uncompleted step with all prerequisites completed.
 * @param plan - task graph to inspect.
 * @param completed - successfully completed step ids.
 * @returns the first ready step, or undefined when no step is ready.
 */
export function nextStep(plan: Plan, completed: ReadonlySet<string>): PlanStep | undefined {
  const dependencies = planDependencies(plan)
  return plan.steps.find(step => !completed.has(step.id) && dependencies.get(step.id)?.every(id => completed.has(id)))
}
