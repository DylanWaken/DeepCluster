/** DeepCluster service: dependency-aware DSH worker execution and planner asset installation. */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { handoffRunner, runPlannedHandoff } from './agents.ts'
import { resolveConfiguredOptions } from './config.ts'
import { coordinate, type CoordinateOptions, type RunOutcome } from './coordinator.ts'
import { managedProcessRunner, type ProcessRunner } from './executor.ts'
import type {} from '@deepseek-ai/dsh-subprocess'
import { describeTargets, installConfiguredPlannerAssets } from './install.ts'
import { masterDirectory } from './master.ts'
import type { Plan } from './plan.ts'
import type { WorkerRecoveryStore } from './worker-recovery.ts'
import { registerServiceLaunchProcess } from './service-launch-recovery.ts'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { executePolicyHooks, type PolicyDecision, type PolicyHook, type PolicyInput } from './policy-hooks.ts'
export { default as DeepClusterDashboard } from './web.ts'
import type {
  DeepClusterConfig,
  DeepClusterOptions,
  HandoffRequest,
  HandoffResult,
  InstallReport,
  InstallTarget,
  InstallTargetId,
  PlannerId,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Task scheduling, worker ownership and planner installation. */
    deepCluster: DeepCluster
  }
}

export type {
  DeepClusterConfig,
  DeepClusterOptions,
  HandoffRequest,
  HandoffResult,
  InstallReport,
  InstallTarget,
  InstallTargetId,
  PlannerId,
}
export type { Plan, PlanStep, RoleId } from './plan.ts'
export { combinePlans, parsePlan } from './plan.ts'
export type { AgentTokenSample, AgentUsage, RunId } from './types.ts'
export type { AgentReport, Improvisation, ReportStatus } from './protocol.ts'
export type { CoordinateOptions, RunOutcome, RunStepOutcome, StepOutcome } from './coordinator.ts'

/** Owns worker cancellation and joins active plans before releasing its subprocess provider. */
export default class DeepCluster extends Service {
  static inject = ['subprocess']
  static Config = z.object({
    apiEndpoint: z.string(),
    dshPath: z.string(),
    apiRequestTimeoutMs: z.natural().min(1),
    apiPollIntervalMs: z.natural().min(1),
    serviceLifecycleWaitMs: z.natural().min(1),
    permissionMode: z.union(['danger-full-access', 'workspace-write']),
    cliPath: z.string(),
    serviceCliPath: z.string(),
    profile: z.string(),
    commandName: z.string(),
    cursorSkillsRoot: z.string(),
    codexSkillsRoot: z.string(),
    skillsRoot: z.string(),
    skillLabel: z.string(),
    timeoutMs: z.natural().min(1),
    maxOutputBytes: z.natural().min(1),
    terminationGraceMs: z.natural().min(1),
  })

  private readonly resolvedOptions: DeepClusterOptions
  private readonly runner: ProcessRunner
  private readonly subprocess: SubprocessRuntime
  private readonly abort = new AbortController()
  private readonly running = new Set<Promise<unknown>>()

  /**
   * @param ctx - plugin context; the service registers as `deepCluster`.
   * @param config - optional overrides; every field has a working default.
   */
  constructor(ctx: Context, config: DeepClusterConfig = {}) {
    super(ctx, 'deepCluster')
    this.resolvedOptions = resolveConfiguredOptions(config)
    this.subprocess = ctx.subprocess
    this.runner = managedProcessRunner(ctx.subprocess, this.resolvedOptions)
    const launchFile = process.env.DEEPCLUSTER_SERVICE_LAUNCH_FILE
    if (launchFile !== undefined) {
      ctx.effect(async () => {
        await registerServiceLaunchProcess(launchFile, 'owner')
        return () => { /* Durable process identity remains available to a later controller. */ }
      }, 'DeepCluster service launch ownership')
    }
    ctx.effect(() => async () => {
      this.abort.abort()
      await Promise.allSettled(this.running)
    }, 'DeepCluster worker teardown')
  }

  /** The resolved settings every call uses. */
  get options(): DeepClusterOptions {
    return this.resolvedOptions
  }

  /**
   * Evaluate trusted host decision programs before admitting a new plan.
   * @param hooks - deployment-owned executables and budgets.
   * @param input - fixed action subject; hook output cannot rewrite it.
   * @param controls - caller cancellation and native recovery receipts.
   * @returns recorded decisions after all invoked process ranges have settled.
   */
  async evaluatePolicies(hooks: readonly PolicyHook[], input: PolicyInput,
    controls: { signal: AbortSignal; workerRecovery?: WorkerRecoveryStore }): Promise<PolicyDecision[]> {
    const recovery = controls.workerRecovery
    const work = executePolicyHooks(hooks, input, hook => managedProcessRunner(this.subprocess, {
      maxOutputBytes: hook.maxOutputBytes, terminationGraceMs: this.resolvedOptions.terminationGraceMs,
    }, recovery === undefined ? undefined : {
      spawn: (spec, persist) => this.subprocess.spawnRecoverable(spec, persist), persist: receipt => recovery.persist(receipt),
    }), AbortSignal.any([controls.signal, this.abort.signal]))
    this.running.add(work)
    try { return await work } finally { this.running.delete(work) }
  }

  /**
   * Execute one handoff against the configured profile.
   * @param request - task plus required plan, directory, and deadline.
   * @returns the executor's outcome, including its final report.
   */
  async handoff(request: HandoffRequest): Promise<HandoffResult> {
    const work = runPlannedHandoff(this.resolvedOptions, {
      ...request,
      signal: request.signal === undefined ? this.abort.signal : AbortSignal.any([request.signal, this.abort.signal]),
    }, this.runner)
    this.running.add(work)
    try { return await work } finally { this.running.delete(work) }
  }

  /**
   * Execute a pre-written plan through the role roster.
   * @param plan - the plan to run.
   * @param workspace - directory the role agents work in; also the journal root.
   * @param overrides - budgets and observers for this run.
   * @returns the run outcome; the journal holds the full record.
   */
  async runPlan(
    plan: Plan,
    workspace: string,
    overrides: Partial<Omit<CoordinateOptions, 'root' | 'workspace' | 'plan' | 'runner'>> & {
      /** API-owned receipt store; present on Windows so every worker can be recovered after controller loss. */
      workerRecovery?: WorkerRecoveryStore
    } = {},
  ): Promise<RunOutcome> {
    const { workerRecovery, ...coordination } = overrides
    const runner = workerRecovery === undefined ? this.runner : managedProcessRunner(this.subprocess, this.resolvedOptions, {
      spawn: (spec, persist) => this.subprocess.spawnRecoverable(spec, persist),
      persist: receipt => workerRecovery.persist(receipt),
    })
    const work = coordinate({
      root: workspace,
      workspace,
      plan,
      runner: handoffRunner(this.resolvedOptions, runner),
      timeoutMs: this.resolvedOptions.timeoutMs,
      permissionMode: this.resolvedOptions.permissionMode,
      ...coordination,
      leaseRoot: coordination.leaseRoot ?? masterDirectory(this.resolvedOptions.dshPath),
      signal: overrides.signal === undefined ? this.abort.signal : AbortSignal.any([overrides.signal, this.abort.signal]),
    })
    this.running.add(work)
    try { return await work } finally { this.running.delete(work) }
  }

  /**
   * Install the configured skill into the selected targets. Omitted targets use
   * the generic root when `skillsRoot` is set, otherwise both preset planners.
   * The merged connection used to render the files is persisted.
   * @param targets - preset or generic destinations; omitted uses configured defaults.
   * @returns the files written and the files already correct.
   */
  async install(targets?: readonly InstallTargetId[]): Promise<InstallReport> {
    return await installConfiguredPlannerAssets(this.resolvedOptions, targets)
  }

  /**
   * Describe every available skill location without changing files.
   * @returns preset rows plus the generic row when `skillsRoot` is configured.
   */
  targets(): InstallTarget[] {
    return describeTargets(this.resolvedOptions)
  }
}
