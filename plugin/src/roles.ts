/** Specialist task instructions and independent implementation, verification and measurement roles. */

import type { PlanStep, RoleId, StepWriteMode } from './plan.ts'
import { REPORT_CONTRACT } from './protocol.ts'

/** What a role is for, and the rules that keep it honest. */
export interface RoleSpec {
  readonly id: RoleId
  readonly title: string
  /** One line the planner reads in summaries. */
  readonly mission: string
  /** Behavioural rules appended to the role prompt. */
  readonly rules: readonly string[]
}

/** The built-in roster. */
export const ROLES: Record<RoleId, RoleSpec> = {
  developer: {
    id: 'developer',
    title: 'Developer',
    mission: 'Write or change the code this step needs, and nothing else.',
    rules: [
      'You own implementation only. Do not review your own work, and do not run performance measurements — other roles own those.',
      'Prefer the smallest change that satisfies the step. Do not refactor unrelated code.',
      'If the plan is wrong or impossible, do not silently substitute your own design: do the best available thing, and report the improvisation with kind, reason, and plan_change.',
      'Leave the workspace building. A step that does not compile is a failed step.',
    ],
  },
  tester: {
    id: 'tester',
    title: 'Tester',
    mission: 'Check this step\'s stated acceptance independently using the assigned commands and artifacts.',
    rules: [
      'Run the commands and checks requested by this step yourself; never accept "it should work" as evidence. Add checks only for a concrete unresolved failure or risk.',
      'Report the exact command you ran and its outcome.',
      'If a test is missing and the step requires one, write it — and report that as an improvisation if the plan did not ask for it.',
      'A crash, a wrong result, or a tolerance failure is a fail, not a warning.',
    ],
  },
  reviewer: {
    id: 'reviewer',
    title: 'Reviewer',
    mission: 'Review the assigned artifacts for the stated correctness risks, hidden costs, and plan drift.',
    rules: [
      'You own judgement, not edits. Reading and static analysis only; do not rewrite the code.',
      'Within the assigned files or reports, look for relevant failures such as races, precision loss, resource leaks, or incorrect hardware assumptions. Expand investigation only for a concrete unresolved risk.',
      'Judge whether the implementation still matches the plan. Call out plan drift as an improvisation even when the code works.',
      'Block on real defects. Do not block on style preferences.',
    ],
  },
  perf: {
    id: 'perf',
    title: 'Performance analyst',
    mission: 'Measure against the stated target and report where the time actually goes.',
    rules: [
      'You own measurement. Use the profiler this environment provides; do not estimate from source code.',
      'Report achieved value, the reference value, the percentage, and the evidence (tool output, metric names).',
      'You hold exclusive use of the hardware. Finish the measurement and release it promptly — other agents are waiting.',
      'If the target is not met, state the largest measured bottleneck and the next concrete change. Do not declare victory on a projected number.',
    ],
  },
  fixer: {
    id: 'fixer',
    title: 'Failure engineer',
    mission: 'Turn a broken environment or toolchain back into a working one, and prove it works.',
    rules: [
      'You own diagnosis and repair of failures, not the feature work. Find the root cause before changing anything.',
      'A failure is evidence, not a verdict. Reproduce it, isolate which layer actually failed, fix that layer, then re-run the exact failing command to prove the fix.',
      'Original task instructions and role restrictions also apply to repairs. Edit build scripts, wrappers, or configuration only within that assigned scope; read-only tasks remain read-only.',
      'A timeout, missing report, or failed acceptance check does not establish a toolchain defect. Without a concrete failure that can be repaired within scope, report blocked.',
      'If a fix requires weakening a security boundary (for example running outside the sandbox), say so explicitly and record it as an improvisation rather than doing it silently.',
      'Report pass only when the previously failing command now succeeds, with the command and its output as evidence. If the failure is genuinely unresolvable in this environment, report blocked with exactly what is missing.',
    ],
  },
}

/** Read-only workspace facts a worker must preserve and stay inside. */
export interface WorkspacePromptContext {
  readonly kind: 'git' | 'directory'
  /** Commit id; absent outside Git or on an unborn branch. */
  readonly head?: string
  /** Branch name; absent outside Git or on an unborn branch. */
  readonly branch?: string
  readonly staged: readonly string[]
  readonly modified: readonly string[]
  readonly untracked: readonly string[]
  /** True when a bounded scan omitted pre-existing paths; preservation then covers the whole tree. */
  readonly truncated: boolean
  /** Resolved write declaration for this step. */
  readonly writeMode: StepWriteMode
  /** True only for an explicit `git: write` declaration. */
  readonly gitWrite: boolean
}

/** Everything a role needs to start work. */
export interface RolePromptInput {
  readonly role: RoleSpec
  /** The step being executed. */
  readonly step: PlanStep
  readonly planTitle: string
  readonly planGoal: string
  /** Which attempt this is, 1-based. */
  readonly attempt: number
  /** Previous failure text, when retrying. */
  readonly feedback?: string
  /** Named exclusive resources this attempt holds. */
  readonly hardware?: readonly string[]
  /** Read-only Git/worktree facts and this step's write scope. */
  readonly workspace?: WorkspacePromptContext
  /** True for a diagnostic step admitted with `dependency_policy: settled`. */
  readonly settled?: boolean
}

/** Bound a path list for a prompt while keeping the omission visible. */
function pathList(paths: readonly string[], limit = 30): string {
  const shown = paths.slice(0, limit).map(item => `\`${item}\``).join(', ')
  return paths.length > limit ? `${shown} and ${String(paths.length - limit)} more` : shown
}

/** Render the preservation and ownership block shared by role and repair prompts. */
function workspaceSection(workspace: WorkspacePromptContext): string[] {
  const branch = workspace.branch ?? 'detached'
  const head = workspace.head === undefined ? 'no commit' : workspace.head.slice(0, 12)
  const lines = [
    '## Workspace and Git context',
    workspace.kind === 'git'
      ? `Git worktree on branch \`${branch}\` at HEAD \`${head}\`.`
      : 'Plain directory with no Git repository.',
    workspace.gitWrite
      ? 'This step declared git: write; stage or commit only within your write scope. Do not reset, clean, rebase, or discard other work.'
      : 'Do not run git commit, reset, checkout, stash, clean, rebase, merge, cherry-pick or add, or any other command that changes the index, HEAD or history.',
  ]
  switch (workspace.writeMode.kind) {
    case 'whole':
      lines.push('Write scope: the whole physical worktree under an exclusive claim; no other DeepCluster step may write it concurrently.')
      break
    case 'read-only':
      lines.push('Write scope: read-only. Do not create, modify or delete source files or Git state.')
      break
    case 'paths':
      lines.push(`Write scope: only these repository-relative paths: ${pathList(workspace.writeMode.paths)}.`)
      break
  }
  const preExisting = [...workspace.staged, ...workspace.modified, ...workspace.untracked]
  if (preExisting.length === 0 && !workspace.truncated) {
    lines.push('No pre-existing staged, modified or untracked work was recorded in this worktree.')
  } else {
    lines.push('Preserve this pre-existing work byte-for-byte; it is not yours to change:')
    if (workspace.staged.length > 0) lines.push(`- Staged: ${pathList(workspace.staged)}`)
    if (workspace.modified.length > 0) lines.push(`- Modified: ${pathList(workspace.modified)}`)
    if (workspace.untracked.length > 0) lines.push(`- Untracked: ${pathList(workspace.untracked)}`)
    if (workspace.truncated) lines.push('- The changed-path scan was truncated; preserve every pre-existing file not named in your write scope.')
  }
  return lines
}

/**
 * Build the complete prompt for one role attempt.
 * @param input - role, step, plan context, and retry feedback.
 * @returns prompt text ending with the report contract.
 */
export function buildRolePrompt(input: RolePromptInput): string {
  const { role, step } = input
  const lines: string[] = [
    `# DeepCluster — ${role.title}`,
    '',
    `Plan: ${input.planTitle}`,
    `Goal: ${input.planGoal}`,
    `Step ${step.id}: ${step.title}`,
    '',
    '## Your mission',
    role.mission,
    '',
    '## Instructions for this step',
    step.detail === '' ? '(no extra detail was given)' : step.detail,
  ]
  if (step.acceptance.length > 0) {
    lines.push('', '## Acceptance checks', ...step.acceptance.map(item => `- ${item}`))
  }
  if (input.workspace !== undefined) lines.push('', ...workspaceSection(input.workspace))
  lines.push('', '## Rules', ...role.rules.map(rule => `- ${rule}`))
  if (input.settled === true) {
    lines.push('- This is a settled diagnostic step: prerequisites may have failed. Inspect their evidence, report your own checks truthfully, and do not attempt to turn the overall failed run green.')
  }
  lines.push(
    '- Step instructions and acceptance checks define your scope; generic role rules do not authorize broader work.',
    '- Finish after the listed acceptance checks have evidence. Add checks only for a concrete unresolved failure or risk.',
    '- Do not run repository-wide builds, test suites, inventories, or profiling unless this step requests them or a concrete unresolved defect requires them.',
    '- Use rg with the assigned paths for searches. Avoid repository-wide inventories when the relevant files are already named.',
    '- Keep commands in the foreground and await their completion. Do not leave detached processes or background device work.',
  )
  if (input.hardware !== undefined && input.hardware.length > 0) {
    const names = input.hardware.map(name => `\`${name}\``).join(', ')
    lines.push(
      '',
      `You hold ${names} for this attempt. Other DeepCluster tasks using the same host resource names must wait.`,
      'Release happens automatically when your attempt ends; do not start work you cannot finish in one attempt.',
    )
  } else {
    lines.push('No hardware lease is assigned. Do not execute GPU workloads; report missing resource requirements to the planner.')
  }
  if (input.feedback !== undefined) {
    lines.push('', `## Task evidence for attempt ${String(input.attempt)}`, input.feedback)
  }
  lines.push('', REPORT_CONTRACT)
  return lines.join('\n')
}

/** Everything the fixer needs to repair a failed attempt. */
export interface RepairPromptInput {
  /** Original instructions and acceptance criteria remain in force during repair. */
  readonly step: PlanStep
  /** The role whose attempt failed. */
  readonly failedRole: RoleId
  readonly planTitle: string
  readonly planGoal: string
  /** The failing attempt's complete output, already truncated by the caller. */
  readonly failureOutput: string
  readonly exitCode: number
  /** Named hardware resources acquired for the repair attempt. */
  readonly hardware: readonly string[]
  /** Sandbox mode the failing attempt ran under. */
  readonly permissionMode: string
  /** Read-only Git/worktree facts and the original step's write scope. */
  readonly workspace?: WorkspacePromptContext
}

/**
 * Build the prompt for a repair attempt.
 *
 * Repair workers inherit the original task's file scope, role restrictions, and hardware allocation.
 * @param input - the failed step and its output.
 * @returns prompt text ending with the report contract.
 */
export function buildRepairPrompt(input: RepairPromptInput): string {
  const role = ROLES.fixer
  const tail = input.failureOutput.trim().split(/\r?\n/u).slice(-60).join('\n')
  const lines: string[] = [
    `# DeepCluster — ${role.title}`,
    '',
    `Plan: ${input.planTitle}`,
    `Goal: ${input.planGoal}`,
    'A task attempt failed. Diagnose a concrete failure within its original scope before proposing repair.',
    '',
    `Step ${input.step.id}: ${input.step.title}`,
    `Failing role: ${input.failedRole}`,
    `Worker exit code: ${String(input.exitCode)}`,
    `Sandbox mode of the failing attempt: ${input.permissionMode}`,
    '',
    '## Original task instructions',
    input.step.detail === '' ? '(no extra detail was given)' : input.step.detail,
    '',
    '## Original task acceptance',
    ...input.step.acceptance.map(item => `- ${item}`),
    'Repair success does not pass these checks; the original role must verify them in its next attempt.',
    '',
    '## Original role restrictions',
    ...ROLES[input.failedRole].rules.map(rule => `- ${rule}`),
    '',
    input.hardware.length === 0
      ? 'No hardware lease is assigned. Do not execute GPU workloads; report missing resource requirements to the planner.'
      : `This repair holds these hardware leases: ${input.hardware.join(', ')}. Do not use other hardware.`,
    ...input.workspace === undefined ? [] : ['', ...workspaceSection(input.workspace)],
    '',
    '## What went wrong',
    '```',
    tail === '' ? '(the attempt produced no output)' : tail,
    '```',
    '',
    '## Your mission',
    role.mission,
    '',
    '## How to work',
    '1. Reproduce the failure with the smallest command that shows it.',
    '2. Decide which layer failed: the program itself, its toolchain, the shell, or the sandbox.',
    '3. Repair only changes authorized by the original task and role. For a read-only task, report the diagnosis and requested planner action without editing.',
    '4. Re-run the exact failing command and capture its output as proof.',
    '',
    '## Rules',
    ...role.rules.map(rule => `- ${rule}`),
    '- Keep commands in the foreground and await their completion. Do not leave detached processes or background device work.',
    '- Search only assigned files unless the original task explicitly permits broader investigation.',
    '',
    '## Process failures',
    '- Diagnose the actual exit status and stderr before changing invocation or toolchain settings.',
    '- Keep the same permissions. A sandbox denial requires a planner decision; never bypass it.',
    '- On Windows, distinguish a failed nested shell from a compiler or program failure.',
    '',
    REPORT_CONTRACT,
  ]
  return lines.join('\n')
}
