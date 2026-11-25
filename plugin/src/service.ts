/** Persistent local service lifecycle for the dedicated API and the browser dashboard. */

import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SubprocessRangeReceipt } from '@deepseek-ai/dsh-subprocess'
import { apiOperationSchema } from './api-types.ts'
import { resolveInvocation } from './executor.ts'
import { reclaimApiRecoveryFence, withApiRecoveryFence, type ApiRecoveryFenceOptions } from './service-recovery-fence.ts'
import { ensureStateDirectory } from './journal.ts'
import { masterDirectory } from './master.ts'
import { inspectProcessIdentity, runPowerShell, sameProcessIdentity, sameProcessStart, type ProcessIdentity } from './process-identity.ts'
import type { DeepClusterOptions, OwnershipGeneration } from './types.ts'
import { parseOwnershipGeneration, recoverWorkerGeneration, recoverOrphanWorkerGenerations, quarantineRecoveredOwnership,
  settleRebootedWorkerGeneration } from './worker-recovery.ts'
import { markServiceMutationSettled, runServiceMutationCommand, withServiceMutationIntent } from './service-intent.ts'
import { inspectWindowsBoot, predatesWindowsBoot, inspectPreviousBootOwnership, quarantinePreviousBootOwnership,
  type WindowsBootEvidence } from './boot-recovery.ts'
import { observeServiceTask, parseServiceTaskInstanceId, ServiceStartupError, type ServiceTaskInstanceId,
  type ServiceTaskLaunch } from './service-task-observation.ts'
import { createServiceLaunch, listServiceLaunches, readServiceLaunchEvidence, recordServiceLaunchInstance,
  cancelServiceLaunch, type ServiceLaunchInvocation } from './service-launch-recovery.ts'
import { parseRecoveryIssues, readRecoveryIssues, recoveryIssue, replaceRecoveryIssues, type RecoveryIssue } from './recovery-issues.ts'
import { readClaimHistory } from './claims.ts'

/** Bound for each lifecycle HTTP probe, independent of the overall startup deadline. */
const PROBE_TIMEOUT_MS = 5_000

/** Persist uncertainty before each mutating child command; a crash cannot silently release its authority. */
async function runServicePowerShell(action: string, script: string): Promise<string> {
  return await runServiceMutationCommand(action, script, runPowerShell)
}

/** Lifecycle operations accepted by the controller command. */
export type ServiceCommand = 'start' | 'status' | 'stop' | 'restart'

/** One running service process as the host reports it. */
export interface ServiceOwner {
  readonly pid: number
  /** ISO-8601 process creation time; comparing it with the PID rejects PID reuse. */
  readonly startTime: string
  readonly commandLine: string
}

/** One listener on a service port, before loopback ownership classification. */
export interface PortListener extends ServiceOwner {
  readonly address: string
  readonly loopback: boolean
}

/** Typed port conflict that prevents a lifecycle operation before any launch. */
export class ServicePortError extends Error {
  override readonly name = 'DeepClusterServicePortError'
  /**
   * @param code - conflict class.
   * @param message - actionable description including the conflicting owner.
   */
  constructor(readonly code: 'foreign-listener' | 'multiple-owners' | 'unidentified-owner', message: string) {
    super(message)
  }
}

/** Ownership metadata written by the running API inside its state lock. */
export interface ApiLockRecord {
  readonly owner: string
  readonly pid: number
  /** Present on locks written by current API builds; compared with the live process when available. */
  readonly startTime?: string
  /** API-recorded inspection scope; absent on older locks, which require operator recovery. */
  readonly recovery?: { readonly version: 1; readonly leaseRoot: string }
  /** Every worker range is durably recorded before its target starts. */
  readonly workers?: { readonly version: 1; readonly generation: OwnershipGeneration }
}

/** One preserved operation record observed while the API is not running. */
export interface PreservedOperation {
  readonly operationId: string
  readonly status: string
  readonly updatedAt: string
}

/** Exact diagnosed lock identity an operator must confirm before recovery. */
export interface ExpectedLockOwner {
  readonly owner: string
  readonly pid: number
  readonly startTime?: string
}

/** Read-only proof-oriented diagnosis of a present API ownership lock. */
export interface ApiLockDiagnosis {
  readonly lockFile: string
  readonly lock: ApiLockRecord | null
  readonly recordedOwner: OwnedService | null
  readonly livePortOwner: ServiceOwner | null
  readonly recordedProcess: ProcessIdentity | null
  /** A host reboot proves that every process from the recorded generation has stopped. */
  readonly previousBoot?: WindowsBootEvidence
  readonly interruptedOperations: readonly PreservedOperation[]
  /** True when the bounded operation scan omitted additional records. */
  readonly operationScanTruncated: boolean
  readonly retainedLeases: { readonly inspected: false; readonly reason: string }
    | { readonly inspected: true; readonly leaseRoot: string; readonly entries: readonly string[] }
  /**
   * Managed ranges require native termination before resource release. Machine proof
   * comes from a host reboot or complete settlement with no retained resource owners.
   */
  readonly recoveryProof: 'machine-proven' | 'managed-ranges' | 'operator-confirmation-required' | 'unavailable'
  /** Exact identity to echo back in an explicit operator confirmation. */
  readonly expectedOwner: ExpectedLockOwner | null
  readonly verdict: 'absent' | 'healthy' | 'stale' | 'live' | 'ambiguous'
  readonly detail: string
  /** Present only when the verdict permits the explicit recovery command. */
  readonly recoveryCommand: 'service recover' | null
}

/** Explicit operator assertion, bound to the diagnosed lock identity. */
export interface LockRecoveryConfirmation {
  readonly confirmOwner: string
  readonly expectedPid?: number
  readonly expectedStartTime?: string
}

/** Result of one explicit operator-confirmed stale-lock recovery. */
export interface ServiceLockRecovery {
  readonly recovered: boolean
  readonly quarantineFile: string
  /** Recovery relied on the operator's stopped-descendants assertion, not machine proof. */
  readonly proof: 'operator-confirmed' | 'machine-proven' | 'owner-stopped'
  readonly expectedOwner: ExpectedLockOwner
  readonly detail: string
  /** Failed worker cleanup retains resource ownership after the dead API releases its state lock. */
  readonly recoveryIssues?: readonly RecoveryIssue[]
}

/** API health fields the lifecycle must verify before reuse or shutdown. */
export interface ServiceHealth {
  readonly status: string
  readonly activeRuns: number
  /** Retained runs whose cancellation could not confirm descendant cleanup. */
  readonly cleanupUnconfirmed?: number
  /** True when the control plane is available but unscoped ownership prevents fresh work. */
  readonly admissionBlocked?: boolean
  /** Preserved startup failures; absence supports older API builds. */
  readonly recoveryIssues?: readonly RecoveryIssue[]
}

/** Proof that the authenticated dashboard served its mount, boot graph, and Remote snapshot. */
export interface DashboardProof {
  readonly authenticatedHtml: boolean
  readonly clientBoot: boolean
  readonly snapshot: boolean
}

/** A fresh browser URL captured from the launcher output and the private file holding it. */
export interface LoginUrl {
  readonly url: string
  readonly file: string
}

/** Recorded ownership of a service this controller started; used to reject unknown owners. */
export interface OwnedService {
  readonly pid: number
  readonly startTime: string
  /** The exact launch command recorded at start, compared with the live process command line. */
  readonly commandLine: string
}

/** Durable service state; the login URL itself is never stored here, only its private file path. */
export interface ServiceState {
  readonly version: 1
  readonly api: OwnedService | null
  readonly dashboard: OwnedService | null
  readonly loginUrlFile: string | null
  readonly updatedAt: string
}

/** Observed service state reported by `status`. */
export interface ServiceStatus {
  readonly api: {
    readonly endpoint: string
    readonly port: number
    readonly owner: ServiceOwner | null
    readonly health: ServiceHealth | null
  }
  readonly dashboard: {
    readonly endpoint: string
    readonly port: number
    readonly owner: ServiceOwner | null
    readonly proof: DashboardProof | null
  }
  /** A present API ownership lock without a healthy owned API blocks startup. */
  readonly apiLock: boolean
  /** Present when the ownership lock exists and the host can inspect it without changing anything. */
  readonly lockDiagnosis?: ApiLockDiagnosis
  /** Present when lock diagnosis itself failed; the lock remains untouched. */
  readonly lockDiagnosisError?: string
  readonly loginUrlFile: string | null
}

/** Host effects the lifecycle needs; tests substitute them without starting processes. */
export interface ServiceEffects {
  readonly apiEndpoint: string
  readonly dashboardEndpoint: string
  /** Reclaim exact ownership records from earlier host boots before inspecting startup. */
  prepareStart?(): Promise<void>
  inspectApi(): Promise<{ owner: ServiceOwner | null; health: ServiceHealth | null }>
  inspectDashboard(): Promise<{ owner: ServiceOwner | null; proof: DashboardProof | null }>
  /** Observe only an already captured login URL; never create launch artifacts during healthy reuse. */
  inspectDashboardReadOnly?(): Promise<{ owner: ServiceOwner | null; proof: DashboardProof | null }>
  apiLockExists(): Promise<boolean>
  startApi(): Promise<void>
  startDashboard(): Promise<void>
  /** Close the API through its authenticated shutdown route, which releases ownership normally. */
  requestApiShutdown(options?: { confirmCleanupUnconfirmed?: boolean }): Promise<void>
  /**
   * End the dashboard task. Ending a scheduled task terminates only its direct process, so a
   * verified owner is also terminated with its descendants after its identity is re-checked.
   * @param owner - dashboard listener whose identity matches the recorded service, or null when unverified.
   */
  endDashboard(owner: ServiceOwner | null): Promise<void>
  /** Read the captured URL and the private file it was captured into. */
  readLoginUrl(): Promise<LoginUrl | null>
  verifyDashboard(loginUrl: string, signal?: AbortSignal): Promise<DashboardProof | null>
  /** Read-only owner-lock diagnosis; omitted hosts report only that the lock exists. */
  diagnoseApiLock?(): Promise<ApiLockDiagnosis>
  /** Recheck machine proof under the API admission fence before quarantining an idle stale lock. */
  recoverIdleApiLock?(): Promise<ServiceLockRecovery>
  /** True only after every launch made by this start has exited without retained API ownership. */
  confirmStartRollback?(): Promise<boolean>
  /** Poll `read` until it returns a non-null value or the deadline passes; read failures are retried. */
  waitFor<T>(read: () => Promise<T | null>, timeoutMs: number): Promise<T | null>
}

/**
 * Service launch scripts, per-start logs, and recorded ownership in the master directory.
 * @param dshPath - saved DSH checkout that owns the master directory.
 * @returns `DEEPCLUSTER_SERVICE_DIRECTORY` when set, otherwise `<master>/service`.
 */
export function serviceDirectory(dshPath: string | undefined): string {
  return process.env.DEEPCLUSTER_SERVICE_DIRECTORY ?? path.join(masterDirectory(dshPath), 'service')
}

/**
 * API state directory; the launcher and the ownership-lock probe must resolve it identically.
 * @param dshPath - saved DSH checkout that owns the master directory.
 * @returns `DEEPCLUSTER_API_STATE_DIRECTORY` when set, otherwise `<master>/api-state`.
 */
export function apiStateDirectory(dshPath: string | undefined): string {
  return process.env.DEEPCLUSTER_API_STATE_DIRECTORY ?? path.join(masterDirectory(dshPath), 'api-state')
}

/**
 * State file holding ownership recorded by this controller.
 * @param dshPath - saved DSH checkout that owns the master directory.
 * @returns `service.json` in the service directory.
 */
export function serviceStatePath(dshPath: string | undefined): string {
  return path.join(serviceDirectory(dshPath), 'service.json')
}

/** On-demand task name for one endpoint port; distinct ports never share a task. */
export function serviceTaskName(kind: 'api' | 'dashboard', port: number): string {
  return `DeepCluster ${kind === 'api' ? 'API' : 'Dashboard'} ${port}`
}

/**
 * Read recorded ownership; a malformed file rejects rather than granting authority.
 * @param dshPath - saved DSH checkout that owns the master directory.
 * @returns the recorded state, or an empty state when none exists.
 */
export async function readServiceState(dshPath: string | undefined): Promise<ServiceState> {
  const file = serviceStatePath(dshPath)
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || !('version' in parsed) || parsed.version !== 1) {
      throw new Error('Unsupported DeepCluster service state version.')
    }
    return parsed as ServiceState
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, api: null, dashboard: null, loginUrlFile: null, updatedAt: new Date().toISOString() }
    }
    throw error
  }
}

/**
 * Replace the state file atomically in a current-user-only directory.
 * @param dshPath - saved DSH checkout that owns the master directory.
 * @param state - ownership to record.
 */
export async function saveServiceState(dshPath: string | undefined, state: ServiceState): Promise<void> {
  const file = serviceStatePath(dshPath)
  await privateDirectory(path.dirname(file))
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(state, undefined, 2)}\n`, { mode: 0o600 })
  await rename(temporary, file)
}

/** Compare recorded PID, creation time, and command with the live owner; a mismatch is unknown. */
function owned(record: OwnedService | null, owner: ServiceOwner | null): boolean {
  return sameProcessIdentity(record, owner)
}

/** One proof predicate for reuse, startup success, and status success. */
export function dashboardProofValid(proof: DashboardProof | null | undefined): proof is DashboardProof {
  return proof !== null && proof !== undefined && proof.authenticatedHtml && proof.clientBoot && proof.snapshot
}

/** Name missing dashboard proof fields without treating partial evidence as verified. */
function missingDashboardProof(proof: DashboardProof | null): string {
  if (proof === null) return 'no authenticated dashboard evidence was captured'
  const missing = [
    ...proof.authenticatedHtml ? [] : ['authenticated HTML'],
    ...proof.clientBoot ? [] : ['DeepCluster browser client boot'],
    ...proof.snapshot ? [] : ['authenticated dashboard snapshot'],
  ]
  return missing.join(', ')
}

/** Describe the owner that prevents stopping a service without a recorded identity. */
function unknownOwner(kind: string, owner: ServiceOwner): Error {
  return new Error(`Refusing to stop the ${kind}: PID ${owner.pid} (started ${owner.startTime}, command "${owner.commandLine}") has no matching DeepCluster ownership record. Inspect it and stop it manually only after confirming it is the DeepCluster ${kind}.`)
}

/** Refuse startup when the API ownership lock exists without a healthy API owned by this controller. */
function refuseLockedApi(status: ServiceStatus, state: ServiceState): void {
  const healthyOwned = status.api.health?.status === 'ready' && owned(state.api, status.api.owner)
  if (status.apiLock && !healthyOwned) {
    const diagnosis = status.lockDiagnosis
    const proof = diagnosis === undefined
      ? 'Run `service recover --dry-run` to prove the recorded owner and workers are gone.'
      : diagnosis.verdict === 'stale'
        ? `The recorded owner is stale: ${diagnosis.detail} Run \`service recover\` only after confirming the exact diagnosed owner and that its workers are gone; the result is operator-confirmed, then \`service start\`.`
        : `The lock owner is not provably gone (${diagnosis.verdict}): ${diagnosis.detail}`
    throw new Error(`DeepCluster API state already has an owner that this controller cannot verify. ${proof} Do not delete the lock directly; the recovery command preserves it as evidence and never replays operations.`)
  }
  if (status.api.owner !== null && status.api.health === null) {
    throw new Error(`Port ${status.api.port} is owned by PID ${status.api.owner.pid} but the API is unhealthy; refusing to start or stop it without health proof.`)
  }
}

/**
 * Persistent DeepCluster service controller: idempotent start, verified status, and safe stop.
 * The controller owns process lifetime through host effects; it never launches inside a
 * managed worker process tree.
 */
export class ServiceLifecycle {
  constructor(
    private readonly effects: ServiceEffects,
    private readonly loadState: () => Promise<ServiceState>,
    private readonly saveState: (state: ServiceState) => Promise<void>,
    private readonly startupTimeoutMs: number,
    private readonly report: (message: string) => void = () => {},
  ) {}

  /** Observe the running stack and recorded ownership without changing anything. */
  async status(): Promise<ServiceStatus> {
    const state = await this.loadState()
    const [api, dashboard, apiLock] = await Promise.all([
      this.effects.inspectApi(), this.effects.inspectDashboard(), this.effects.apiLockExists(),
    ])
    let lockDiagnosis: ApiLockDiagnosis | undefined
    let lockDiagnosisError: string | undefined
    if (apiLock && this.effects.diagnoseApiLock !== undefined) {
      try { lockDiagnosis = await this.effects.diagnoseApiLock() } catch (error) {
        lockDiagnosisError = error instanceof Error ? error.message : String(error)
      }
    }
    return {
      api: { endpoint: this.effects.apiEndpoint, port: portOf(this.effects.apiEndpoint), ...api },
      dashboard: { endpoint: this.effects.dashboardEndpoint, port: portOf(this.effects.dashboardEndpoint), ...dashboard },
      apiLock,
      ...lockDiagnosis === undefined ? {} : { lockDiagnosis },
      ...lockDiagnosisError === undefined ? {} : { lockDiagnosisError },
      loginUrlFile: state.loginUrlFile,
    }
  }

  /**
   * Verify reuse without preparing recovery, launching processes, or rewriting ownership.
   * @returns current ready observations only when both listeners match their saved process identities.
   */
  async healthyStatus(): Promise<ServiceStatus | null> {
    const state = await this.loadState()
    const [api, dashboard, apiLock] = await Promise.all([this.effects.inspectApi(),
      this.effects.inspectDashboardReadOnly?.() ?? this.effects.inspectDashboard(), this.effects.apiLockExists()])
    if (!apiLock || api.health?.status !== 'ready' || !dashboardProofValid(dashboard.proof)
      || !owned(state.api, api.owner) || !owned(state.dashboard, dashboard.owner)) return null
    return { api: { endpoint: this.effects.apiEndpoint, port: portOf(this.effects.apiEndpoint), ...api },
      dashboard: { endpoint: this.effects.dashboardEndpoint, port: portOf(this.effects.dashboardEndpoint), ...dashboard },
      apiLock, loginUrlFile: state.loginUrlFile }
  }

  /**
   * Start both services or reuse a healthy owned stack. A failed start stops only the
   * services this call started and reconciles any ownership it recorded.
   */
  async start(): Promise<ServiceState> {
    await this.effects.prepareStart?.()
    let state = await this.loadState()
    let status = await this.status()
    if (status.lockDiagnosis?.verdict === 'stale' && ['machine-proven', 'managed-ranges'].includes(status.lockDiagnosis.recoveryProof)
      && this.effects.recoverIdleApiLock !== undefined) {
      const recovery = await this.effects.recoverIdleApiLock()
      this.report(recovery.detail)
      status = await this.status()
    }
    if (status.api.health?.status === 'ready' && status.lockDiagnosis?.verdict === 'healthy'
      && status.api.owner !== null && !owned(state.api, status.api.owner)) {
      state = { ...state, api: status.api.owner, updatedAt: new Date().toISOString() }
      await this.saveState(state)
      this.report(`reconciled API PID ${String(status.api.owner.pid)} from its ownership lock`)
    }
    refuseLockedApi(status, state)
    const apiHealthy = status.api.health?.status === 'ready'
    if (apiHealthy && !owned(state.api, status.api.owner)) {
      throw new Error(`The API on ${status.api.endpoint} is healthy but was not started by this controller; refusing to adopt it.`)
    }
    if (apiHealthy && status.api.owner !== null) this.report(`reusing healthy API PID ${status.api.owner.pid}`)

    let startedApi = false
    let startedDashboard = false
    let recorded = false
    let next: ServiceState = state
    try {
      if (!apiHealthy) {
        await this.effects.startApi(); startedApi = true
        const health = await this.effects.waitFor(async () => {
          const probe = await this.effects.inspectApi()
          return probe.health?.status === 'ready' ? probe : null
        }, this.startupTimeoutMs)
        if (health === null) throw new Error('The DeepCluster API did not report ready before the startup deadline. Inspect its log; ownership was preserved.')
        const owner = health.owner
        if (owner === null) throw new Error('The DeepCluster API reported ready without a loopback listener owner.')
        next = {
          ...next,
          api: { pid: owner.pid, startTime: owner.startTime, commandLine: owner.commandLine },
          updatedAt: new Date().toISOString(),
        }
        await this.saveState(next); recorded = true
        status = await this.status()
      }

      if (status.dashboard.owner !== null) {
        if (!owned(state.dashboard, status.dashboard.owner)) {
          throw unknownOwner('dashboard', status.dashboard.owner)
        }
        if (!dashboardProofValid(status.dashboard.proof)) {
          throw new Error(`The recorded DeepCluster dashboard PID ${status.dashboard.owner.pid} is owned by this controller but its authenticated proof is incomplete: ${missingDashboardProof(status.dashboard.proof)}. It is not a verified dashboard; run \`service restart\` to relaunch it and capture a fresh login URL.`)
        }
        this.report(`reusing verified dashboard PID ${status.dashboard.owner.pid}`)
        return next
      }

      await this.effects.startDashboard(); startedDashboard = true
      const login = await this.effects.waitFor(() => this.effects.readLoginUrl(), this.startupTimeoutMs)
      if (login === null) throw new Error('The dashboard did not expose a private startup URL before the startup deadline.')
      next = { ...next, loginUrlFile: login.file, updatedAt: new Date().toISOString() }
      const proof = await this.effects.waitFor(async () => {
        const verified = await this.effects.verifyDashboard(login.url, AbortSignal.timeout(PROBE_TIMEOUT_MS))
        return dashboardProofValid(verified) ? verified : null
      }, this.startupTimeoutMs)
      if (proof === null) throw new Error('The dashboard served HTML but its browser client or authenticated snapshot did not verify; treat the browser URL as unusable.')
      const dashboard = await this.effects.inspectDashboard()
      if (dashboard.owner === null) throw new Error('The dashboard verified without a loopback listener owner.')
      next = {
        ...next,
        dashboard: { pid: dashboard.owner.pid, startTime: dashboard.owner.startTime, commandLine: dashboard.owner.commandLine },
        updatedAt: new Date().toISOString(),
      }
      await this.saveState(next); recorded = true
      return next
    } catch (error) {
      if (startedDashboard) await this.effects.endDashboard(null).catch(() => {})
      let apiReleased = !startedApi
      if (startedApi) {
        await this.effects.requestApiShutdown().catch(() => {})
        apiReleased = await this.effects.waitFor(
          async () => (await this.effects.inspectApi()).owner === null ? true : null,
          this.startupTimeoutMs,
        ).then(released => released !== null, () => false)
      }
      if (recorded) {
        if (apiReleased) {
          await this.saveState({ version: 1, api: null, dashboard: null, loginUrlFile: null, updatedAt: new Date().toISOString() })
            .catch(() => { this.report('could not reconcile the saved service ownership after rollback; inspect service.json') })
        } else {
          this.report('the API did not release its port during rollback; its recorded ownership was preserved for an explicit stop')
        }
      }
      if (await this.effects.confirmStartRollback?.().catch(() => false) === true) {
        await markServiceMutationSettled()
      }
      throw error
    }
  }

  /**
   * Stop both services. Active API runs refuse shutdown; unknown owners are never signalled,
   * and a retained ownership lock is reported instead of deleted. A retained
   * cleanup-unconfirmed run requires the operator's explicit confirmation.
   * @param options - operator attestation after verifying the unconfirmed process ranges.
   */
  async stop(options: { confirmCleanupUnconfirmed?: boolean } = {}): Promise<ServiceStatus> {
    await this.effects.prepareStart?.()
    const state = await this.loadState()
    const status = await this.status()
    if (status.api.health !== null && status.api.health.activeRuns > 0) {
      throw new Error(`Refusing to stop: the API reports ${status.api.health.activeRuns} active run(s). Wait for them to finish, then retry.`)
    }
    if (status.api.health !== null && (status.api.health.cleanupUnconfirmed ?? 0) > 0
      && options.confirmCleanupUnconfirmed !== true) {
      throw new Error(`Refusing to stop: the API reports ${String(status.api.health.cleanupUnconfirmed)} retained run(s) with unconfirmed descendant cleanup. Verify and terminate their process ranges, keep the retained leases quarantined, then retry with --confirm-cleanup-unconfirmed.`)
    }
    if (status.dashboard.owner !== null && !owned(state.dashboard, status.dashboard.owner)) {
      throw unknownOwner('dashboard', status.dashboard.owner)
    }
    if (status.api.owner !== null && !owned(state.api, status.api.owner)) {
      throw unknownOwner('API', status.api.owner)
    }

    if (status.dashboard.owner !== null) {
      await this.effects.endDashboard(status.dashboard.owner)
      const closed = await this.effects.waitFor(
        async () => (await this.effects.inspectDashboard()).owner === null ? true : null,
        this.startupTimeoutMs,
      )
      if (closed === null) {
        throw new Error(`The dashboard on port ${status.dashboard.port} did not release its listener after the scheduled task ended; ownership was preserved. Inspect the process tree and stop it through its owner.`)
      }
    }
    if (status.api.owner !== null) {
      await this.effects.requestApiShutdown({ confirmCleanupUnconfirmed: options.confirmCleanupUnconfirmed === true })
      const released = await this.effects.waitFor(
        async () => (await this.effects.inspectApi()).owner === null ? true : null,
        this.startupTimeoutMs,
      )
      if (released === null) throw new Error(`The API did not release port ${status.api.port} before the shutdown deadline; ownership was preserved.`)
    }
    await this.saveState({ version: 1, api: null, dashboard: null, loginUrlFile: null, updatedAt: new Date().toISOString() })
    const after = await this.status()
    if (after.apiLock) {
      this.report('the API ownership lock is still present after shutdown; do not delete it without confirming the owner is gone')
    }
    return after
  }

  /** Stop, then start with a fresh login URL. */
  async restart(options: { confirmCleanupUnconfirmed?: boolean } = {}): Promise<ServiceState> {
    await this.stop(options)
    return await this.start()
  }
}

/** Parse the port of a literal loopback HTTP origin. */
export function portOf(endpoint: string): number {
  const url = new URL(endpoint)
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('DeepCluster service endpoints must be literal loopback HTTP origins.')
  }
  return url.port === '' ? 80 : Number(url.port)
}

/**
 * Run one lifecycle command through the controller.
 * @param lifecycle - configured controller.
 * @param command - requested operation.
 * @param options - operator attestation forwarded to stop or restart.
 * @returns a JSON-serializable report; the login URL itself is returned only by `login-url`.
 */
export async function runServiceCommand(lifecycle: ServiceLifecycle, command: ServiceCommand,
  options: { confirmCleanupUnconfirmed?: boolean } = {}): Promise<Record<string, unknown>> {
  switch (command) {
    case 'status': {
      const status = await lifecycle.status()
      return { ok: status.api.health?.status === 'ready' && dashboardProofValid(status.dashboard.proof), ...status }
    }
    case 'start': await lifecycle.start(); return { ok: true, action: 'started', ...await lifecycle.status() }
    case 'stop': await lifecycle.stop(options); return { ok: true, action: 'stopped', ...await lifecycle.status() }
    case 'restart': await lifecycle.restart(options); return { ok: true, action: 'restarted', ...await lifecycle.status() }
  }
}

/** Convert an observed status report into the command exit code; unready is not success. */
export function serviceStatusExitCode(report: Record<string, unknown>): number {
  return report.ok === true ? 0 : 1
}

/** Create a directory only the current user can read; inherited ACLs are removed on Windows. */
async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true })
  if (process.platform !== 'win32') { await chmod(directory, 0o700); return }
  const escaped = directory.replace(/'/gu, "''")
  await runServicePowerShell('set service directory permissions', `$id=[Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe '${escaped}' /inheritance:r /grant:r ('{0}:(OI)(CI)F' -f $id) | Out-Null
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`)
}

/**
 * Query every listener on one port, including non-loopback bind addresses.
 * @param port - service port.
 * @returns all identified listeners; an empty array means the port is free.
 */
export async function queryPortListeners(port: number): Promise<PortListener[]> {
  if (process.platform !== 'win32') throw new Error('DeepCluster local service lifecycle currently requires Windows.')
  const output = await runPowerShell(`[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$listeners=@(Get-NetTCPConnection -ErrorAction Stop | Where-Object { $_.State -eq 'Listen' -and $_.LocalPort -eq ${String(port)} })
foreach ($listener in $listeners) {
  $p=Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction Stop
  $created=if ($p.CreationDate -is [datetime]) { $p.CreationDate } else { [Management.ManagementDateTimeConverter]::ToDateTime([string]$p.CreationDate) }
  Write-Output ('OK|{0}|{1}|{2}|{3}' -f $listener.LocalAddress, $p.ProcessId, $created.ToUniversalTime().ToString('o'), $p.CommandLine)
}`)
  if (output === '') return []
  const listeners: PortListener[] = []
  for (const line of output.split(/\r?\n/u)) {
    if (line.trim() === '') continue
    const [tag, address, rawPid, startTime, commandLine] = line.split('|', 5)
    if (tag !== 'OK' || address === undefined || rawPid === undefined || startTime === undefined || commandLine === undefined) {
      throw new ServicePortError('unidentified-owner', `Could not identify every listener on port ${String(port)}; refusing to guess which process owns it.`)
    }
    listeners.push({
      address,
      loopback: address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1',
      pid: Number(rawPid), startTime, commandLine,
    })
  }
  return listeners
}

/**
 * Classify all listeners on a port: a foreign bind address is a conflict, and
 * more than one loopback owner is ambiguous. One process listening on both
 * loopback families is one owner.
 * @param port - service port.
 * @param listeners - complete listener list from the host.
 * @returns the single verified loopback owner, or null when the port is free.
 */
export function classifyPortListeners(port: number, listeners: readonly PortListener[]): ServiceOwner | null {
  const foreign = listeners.filter(listener => !listener.loopback)
  if (foreign.length > 0) {
    const owners = [...new Map(foreign.map(listener => [listener.pid, listener])).values()]
      .map(listener => `PID ${String(listener.pid)} on ${listener.address} (started ${listener.startTime}, command "${listener.commandLine}")`)
    throw new ServicePortError('foreign-listener', `Port ${String(port)} is bound outside loopback by ${owners.join('; ')}. A DeepCluster API listener would fail to bind; stop that process or choose another port.`)
  }
  const owners = [...new Map(listeners.map(listener => [listener.pid, listener])).values()]
  if (owners.length === 0) return null
  if (owners.length > 1) {
    throw new ServicePortError('multiple-owners', `Multiple loopback owners listen on port ${String(port)} (${owners.map(owner => `PID ${String(owner.pid)}`).join(', ')}); refusing to guess which one is DeepCluster.`)
  }
  const owner = owners[0] as PortListener
  return { pid: owner.pid, startTime: owner.startTime, commandLine: owner.commandLine }
}

/**
 * Inspect the owner of a service port on every bind address.
 * @param port - service port.
 * @param query - injectable listener query; defaults to the Windows host query.
 * @returns the single loopback owner, or null when the port is free.
 */
export async function inspectPort(
  port: number,
  query: (port: number) => Promise<PortListener[]> = queryPortListeners,
): Promise<ServiceOwner | null> {
  return classifyPortListeners(port, await query(port))
}

/**
 * Verify authenticated dashboard HTML, its DeepCluster browser client boot entry, and the
 * Remote snapshot envelope. Transient failures return null so the caller retries.
 * @param loginUrl - fresh tokenized loopback URL captured from the launcher.
 * @param signal - bound for the complete verification; every request shares it.
 * @returns partial proof fields; callers require {@link dashboardProofValid}.
 */
export async function verifyDashboard(
  loginUrl: string,
  signal: AbortSignal = AbortSignal.timeout(PROBE_TIMEOUT_MS),
): Promise<DashboardProof | null> {
  const first = await fetch(loginUrl, { redirect: 'manual', signal })
  const cookies = first.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ')
  if (cookies === '') return null
  const origin = new URL('/', loginUrl)
  const page = await fetch(origin, { headers: { cookie: cookies }, signal })
  const html = await page.text()
  if (!page.ok || !html.includes('id="root"')) return null
  // The boot graph is injected as `window.__DSH_BOOT__`; its entries are the loaded client modules.
  const clientBoot = html.includes('deep-cluster/client.js')
  const rpcId = randomUUID()
  const snapshot = await fetch(new URL('/api/deepClusterDashboard/snapshot', origin), {
    method: 'POST', headers: { cookie: cookies, 'content-type': 'application/json' }, signal,
    body: JSON.stringify({ type: 'client-request', rpcId, method: 'deepClusterDashboard/snapshot', payload: { args: {} } }),
  })
  if (!snapshot.ok) return null
  const body: unknown = await snapshot.json()
  const result = typeof body === 'object' && body !== null && 'type' in body && body.type === 'server-response'
    && 'rpcId' in body && body.rpcId === rpcId && 'result' in body
    ? (body as { result?: unknown }).result : null
  const value = typeof result === 'object' && result !== null && 'ok' in result && result.ok === true && 'value' in result
    ? (result as { value?: unknown }).value : null
  return { authenticatedHtml: true, clientBoot,
    snapshot: typeof value === 'object' && value !== null && 'workspace' in value && Array.isArray((value as { runs?: unknown }).runs) }
}

/** Quote one value as a PowerShell single-quoted literal. */
function powerShellLiteral(value: string): string {
  return `'${value.replace(/'/gu, "''")}'`
}

/**
 * PowerShell statements that register and start one on-demand, interactive per-user task.
 * The action runs the command file under `conhost.exe --headless`, so the service console has
 * no window and no desktop Ctrl+C or window close can terminate it. The task has no trigger,
 * an unlimited execution time (`PT0S`), and keeps running when the host switches to battery.
 * @param taskName - endpoint-namespaced task name.
 * @param commandFile - absolute `cmd.exe` launcher script.
 * @returns the complete registration script.
 */
export function scheduledTaskScript(taskName: string, commandFile: string): string {
  const argument = `--headless cmd.exe /d /c "${commandFile}"`
  return `$ErrorActionPreference = 'Stop'
$action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\\conhost.exe') -Argument ${powerShellLiteral(argument)}
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive
Register-ScheduledTask -TaskName ${powerShellLiteral(taskName)} -Action $action -Settings $settings -Principal $principal -Force | Out-Null
$scheduler = New-Object -ComObject 'Schedule.Service'
$scheduler.Connect()
$registered = $scheduler.GetFolder('\\').GetTask(${powerShellLiteral(taskName)})
$instance = $registered.Run($null)
[Console]::Write($instance.InstanceGuid)`
}

/** Launch a command as an on-demand per-user scheduled task, independent of any worker tree. */
export async function runScheduledTask(taskName: string, commandFile: string): Promise<ServiceTaskInstanceId> {
  if (commandFile.includes('"')) throw new Error('DeepCluster service command file path must not contain a double quote.')
  return parseServiceTaskInstanceId(await runServicePowerShell(`start scheduled task ${taskName}`, scheduledTaskScript(taskName, commandFile)))
}

/** End a scheduled task; the task scheduler owns the process, not a DeepCluster worker. */
export async function endScheduledTask(taskName: string): Promise<void> {
  await runServicePowerShell(`end scheduled task ${taskName}`, `$out = & schtasks.exe /End /TN "${taskName}" 2>&1
if ($LASTEXITCODE -ne 0) { [Console]::Error.Write(($out | Out-String)); exit $LASTEXITCODE }`)
}

/** Extraction of the launcher's tokenized URL from captured output. */
export function startupUrlOf(text: string): string | null {
  const matches = [...text.matchAll(/^.*dsh web: (http:\/\/\S+)\s*$/gmu)]
  const last = matches.at(-1)?.[1]
  return last ?? null
}

/** Shipped overlays resolved beside this module, so installation location is not assumed. */
export function servicePatchFiles(): { readonly api: string; readonly web: string } {
  return {
    api: fileURLToPath(new URL('../api.patch.yml', import.meta.url)),
    web: fileURLToPath(new URL('../web.patch.yml', import.meta.url)),
  }
}

/** Inputs for one scheduled-task launcher script. */
export interface ServiceLaunchContext {
  readonly kind: 'api' | 'dashboard'
  readonly logFile: string
  readonly stateDirectory: string
  readonly apiPort: number
  readonly dashboardPort: number
  /** Controller working directory used when the saved configuration names no dashboard workspace. */
  readonly dashboardWorkspace?: string
  /** Durable per-run target request consumed by the supported scheduled service host. */
  readonly launchFile?: string
}

/** Quote one command-file argument without changing its value. */
function quoteCommandArgument(value: string): string {
  return /[\s"&|<>^]/u.test(value) ? `"${value.replace(/"/gu, '""')}"` : value
}

/** Resolve the service-only launcher, falling back to the worker entry only when none is saved. */
function resolveServiceInvocation(options: DeepClusterOptions): { command: string; prefixArgs: string[] } {
  return options.serviceCliPath === undefined
    ? resolveInvocation(options.cliPath)
    : resolveInvocation(options.serviceCliPath, 'serviceCliPath')
}

/**
 * Build the command-file body that launches one persistent service. The
 * configured service CLI (or `cliPath` when no separate service entry is saved)
 * and profile are used directly; shipped patches are absolute paths beside the
 * installed package, and no package-manager or monorepo path is assumed.
 * @param options - saved connection and execution settings.
 * @param context - service kind, private paths, and ports for this run.
 * @returns the complete `cmd.exe` script body.
 */
export function serviceLauncherScript(options: DeepClusterOptions, context: ServiceLaunchContext): string {
  const target = serviceLaunchInvocation(options, context)
  const invocation = resolveServiceInvocation(options)
  const argv = context.launchFile === undefined ? target.argv
    : [invocation.command, ...invocation.prefixArgs, '--profile', 'deep-cluster', 'service-host', '--launch-file', context.launchFile]
  const commandLine = argv.map(quoteCommandArgument).join(' ')
  const environment = Object.entries(target.env).map(([key, value]) => `set "${key}=${value}"`)
  return ['@echo off', `cd /d ${quoteCommandArgument(target.cwd)}`, ...environment,
    `${commandLine} > ${quoteCommandArgument(context.logFile)} 2>&1`, ''].join('\r\n')
}

/**
 * Resolve the exact API or dashboard target with deployment-only environment overrides.
 * @param options - saved service entry, roots, and termination settings.
 * @param context - service kind, private paths, and ports for this run.
 * @returns the target request persisted before Task Scheduler starts its service host.
 */
export function serviceLaunchInvocation(options: DeepClusterOptions, context: ServiceLaunchContext): ServiceLaunchInvocation {
  if (options.dshPath === undefined) throw new Error('Persistent service lifecycle requires the saved dshPath as its working directory.')
  const invocation = resolveServiceInvocation(options)
  const patches = servicePatchFiles()
  const args = context.kind === 'api'
    ? ['--profile', 'deep-cluster', '--patch', patches.api]
    : ['--profile', 'web', '--patch', patches.web, '--no-open', '--host', '127.0.0.1', '--port', String(context.dashboardPort)]
  const primaryWorkspace = options.dashboardWorkspace ?? context.dashboardWorkspace
  const extraWorkspaces = options.dashboardWorkspaces ?? []
  const env: Record<string, string> = context.kind === 'api'
    ? { DEEPCLUSTER_API_STATE_DIRECTORY: context.stateDirectory,
      DEEPCLUSTER_API_LEASE_ROOT: process.env.DEEPCLUSTER_API_LEASE_ROOT ?? masterDirectory(options.dshPath),
      DEEPCLUSTER_API_PORT: String(context.apiPort) }
    : { ...(primaryWorkspace === undefined ? {} : { DEEPCLUSTER_WORKSPACE: primaryWorkspace }),
      ...(extraWorkspaces.length === 0 ? {} : { DEEPCLUSTER_WORKSPACES: JSON.stringify(extraWorkspaces) }) }
  return { argv: [invocation.command, ...invocation.prefixArgs, ...args], cwd: options.dshPath, env,
    graceMs: options.terminationGraceMs }
}

/** Injectable host reads for read-only lock diagnosis and explicit recovery. */
export interface ServiceLockDependencies {
  readonly readState?: () => Promise<ServiceState>
  readonly inspectPort?: (port: number) => Promise<ServiceOwner | null>
  readonly inspectProcess?: (pid: number) => Promise<ProcessIdentity | null>
  readonly stateDirectory?: string
  /** Explicit resource namespace for isolated lifecycle compositions. */
  readonly leaseRoot?: string
  /** Null disables reboot evidence on a host that cannot provide it. */
  readonly inspectBoot?: () => Promise<WindowsBootEvidence | null>
  readonly inspectController?: () => Promise<ProcessIdentity | null>
  /** Resolves only when the exact provider-owned native range is empty. */
  readonly recoverRange?: (receipt: SubprocessRangeReceipt, signal?: AbortSignal) => Promise<void>
  readonly signal?: AbortSignal
}

/** Forward only explicitly supplied host probes to the admission-fence owner. */
function recoveryFenceOptions(dependencies: ServiceLockDependencies): ApiRecoveryFenceOptions {
  return {
    ...dependencies.inspectProcess === undefined ? {} : { inspectProcess: dependencies.inspectProcess },
    ...dependencies.inspectController === undefined ? {} : { inspectController: dependencies.inspectController },
    ...dependencies.inspectBoot === undefined ? {} : { inspectBoot: async () => {
      const boot = await dependencies.inspectBoot?.()
      if (boot === null || boot === undefined) throw new Error('Host boot identity is unavailable; legacy recovery evidence was preserved.')
      return boot
    } },
  }
}

/** Bound forced worker cleanup separately from the remaining service-start budget. */
function boundedWorkerRecovery(
  recover: NonNullable<ServiceLockDependencies['recoverRange']>, waitMs: number,
): NonNullable<ServiceLockDependencies['recoverRange']> {
  let budget: AbortSignal | undefined
  return async (receipt, signal) => {
    budget ??= AbortSignal.timeout(waitMs)
    await recover(receipt, signal === undefined ? budget : AbortSignal.any([signal, budget]))
  }
}

/** Unknown claim attribution prevents fresh work, while validated holders retain ordinary conflict semantics. */
async function claimRecoveryIssues(root: string): Promise<readonly RecoveryIssue[]> {
  try { await readClaimHistory(root); return [] } catch (error) {
    return [{ ...recoveryIssue('worker-generation', 'claim-registry', error), blocksAdmission: true }]
  }
}

/**
 * Reclaim an abandoned previous-boot admission fence and ownership before a fresh API starts.
 * The lifecycle caller holds the host controller pipe; the temporary fence excludes API admission.
 * @param options - configured state and resource locations.
 * @param dependencies - isolated host reads for tests.
 */
export async function prepareServiceOwnership(options: DeepClusterOptions, dependencies: ServiceLockDependencies = {}): Promise<void> {
  const directory = dependencies.stateDirectory ?? apiStateDirectory(options.dshPath)
  const fenceOptions = recoveryFenceOptions(dependencies)
  await reclaimApiRecoveryFence(directory, fenceOptions)
  if (await readApiLock(path.join(directory, 'api-owner.lock')) !== null) return
  await withApiRecoveryFence(directory, async () => {
    // A concurrent API may publish its lock after the initial absence check, but cannot admit work through the fence.
    if (await readApiLock(path.join(directory, 'api-owner.lock')) !== null) return
    const root = dependencies.leaseRoot ?? process.env.DEEPCLUSTER_API_LEASE_ROOT ?? masterDirectory(options.dshPath)
    const boot = await (dependencies.inspectBoot ?? (async () => process.platform === 'win32' ? await inspectWindowsBoot() : null))()
    const issues: RecoveryIssue[] = []
    if (dependencies.recoverRange !== undefined) {
      const report = await recoverOrphanWorkerGenerations(directory, root,
        boundedWorkerRecovery(dependencies.recoverRange, options.terminationGraceMs),
        dependencies.inspectProcess ?? inspectProcessIdentity, dependencies.signal, boot ?? undefined)
      issues.push(...report.issues)
    }
    if (boot !== null) {
      try {
        await quarantinePreviousBootOwnership(await inspectPreviousBootOwnership(root, boot))
      } catch (error) {
        dependencies.signal?.throwIfAborted()
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') issues.push(recoveryIssue('worker-generation', 'previous-boot-resources', error))
      }
    }
    issues.push(...await claimRecoveryIssues(root))
    await replaceRecoveryIssues(directory, 'worker-generation', issues)
    for (const issue of issues) process.stderr.write(`deep-cluster: retained recovery issue ${issue.id}: ${issue.message}\n`)
  }, fenceOptions)
}

/** Read and validate the API ownership lock without modifying it. */
async function readApiLock(lockFile: string): Promise<ApiLockRecord | null> {
  let raw: string
  try { raw = await readFile(lockFile, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch (error) {
    throw new Error(`DeepCluster API ownership lock ${lockFile} is not valid JSON; preserve it and diagnose the recorded owner manually.`, { cause: error })
  }
  if (typeof parsed !== 'object' || parsed === null || !('owner' in parsed) || typeof parsed.owner !== 'string' || parsed.owner === ''
    || !('pid' in parsed) || typeof parsed.pid !== 'number' || !Number.isSafeInteger(parsed.pid) || parsed.pid <= 0
    || ('startTime' in parsed && parsed.startTime !== null && typeof parsed.startTime !== 'string')) {
    throw new Error(`DeepCluster API ownership lock ${lockFile} has invalid ownership fields; preserve it and diagnose manually.`)
  }
  let recovery: ApiLockRecord['recovery']
  if ('recovery' in parsed) {
    const value = parsed.recovery
    if (typeof value !== 'object' || value === null || !('version' in value) || value.version !== 1
      || !('leaseRoot' in value) || typeof value.leaseRoot !== 'string' || !path.isAbsolute(value.leaseRoot)) {
      throw new Error(`DeepCluster API ownership lock ${lockFile} has invalid recovery metadata; preserve it and diagnose manually.`)
    }
    recovery = { version: 1, leaseRoot: value.leaseRoot }
  }
  let workers: ApiLockRecord['workers']
  if ('workers' in parsed) {
    const value = parsed.workers
    if (typeof value !== 'object' || value === null || !('version' in value) || value.version !== 1
      || !('generation' in value) || value.generation !== parsed.owner || recovery === undefined) {
      throw new Error(`DeepCluster API ownership lock ${lockFile} has invalid worker recovery metadata.`)
    }
    workers = { version: 1, generation: parseOwnershipGeneration(value.generation) }
  }
  return {
    owner: parsed.owner,
    pid: parsed.pid,
    ...('startTime' in parsed && typeof parsed.startTime === 'string' ? { startTime: parsed.startTime } : {}),
    ...recovery === undefined ? {} : { recovery },
    ...workers === undefined ? {} : { workers },
  }
}

/** Terminal operation states omitted from the historical interrupted-operation listing. */
const TERMINAL_OPERATION_STATUSES = new Set(['completed', 'needs-ack', 'failed', 'cancelled'])

/** Read preserved operation records without rewriting or replaying them. */
async function preservedOperations(directory: string, inspectProcess: (pid: number) => Promise<ProcessIdentity | null>): Promise<{
  operations: PreservedOperation[]
  liveOwner: boolean
  truncated: boolean
  settled: boolean
}> {
  let files: string[]
  try { files = (await readdir(directory)).sort() } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { operations: [], liveOwner: false, truncated: false, settled: false }
    throw error
  }
  const truncated = false
  const operations: PreservedOperation[] = []
  let liveOwner = false
  let settled = true
  const owners = new Map<number, Promise<ProcessIdentity | null>>()
  for (const file of files) {
    if (!file.endsWith('.json')) { settled = false; continue }
    let parsed: unknown
    try { parsed = JSON.parse(await readFile(path.join(directory, file), 'utf8')) } catch (error) {
      // Corrupt historical metadata prevents idle proof; exact native or reboot proof remains independent.
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code === undefined) throw error
      settled = false
      continue
    }
    if (typeof parsed !== 'object' || parsed === null || !('operationId' in parsed) || typeof parsed.operationId !== 'string'
      || !('status' in parsed) || typeof parsed.status !== 'string' || !('updatedAt' in parsed) || typeof parsed.updatedAt !== 'string') {
      settled = false
      continue
    }
    const status = parsed.status
    const validated = apiOperationSchema.safeParse(parsed)
    const outcome = validated.success ? validated.data.result : null
    const cleanOutcome = outcome?.status === 'completed' && outcome.cleanupConfirmed !== false
      || (outcome?.cleanupConfirmed === true && (outcome.status === 'failed' || outcome.status === 'cancelled' || outcome.status === 'needs-ack'))
    if (!validated.success || file !== `${validated.data.keyHash}.json`
      || !['completed', 'failed', 'cancelled', 'needs-ack'].includes(validated.data.status) || validated.data.error !== null
      || !cleanOutcome || (validated.data.status !== outcome.status
        && !(validated.data.status === 'cancelled' && outcome.status === 'failed'))) settled = false
    if (TERMINAL_OPERATION_STATUSES.has(status)) continue
    if (status !== 'interrupted' && 'ownerPid' in parsed && typeof parsed.ownerPid === 'number') {
      const ownerPid = parsed.ownerPid
      const ownerStartTime = 'ownerStartTime' in parsed && typeof parsed.ownerStartTime === 'string' ? parsed.ownerStartTime : undefined
      const inspection = owners.get(ownerPid) ?? inspectProcess(ownerPid)
      owners.set(ownerPid, inspection)
      const live = await inspection
      if (live !== null && (ownerStartTime === undefined || live.startTime === ownerStartTime)) liveOwner = true
    }
    operations.push({ operationId: parsed.operationId, status, updatedAt: parsed.updatedAt })
  }
  return { operations, liveOwner, truncated, settled }
}

/** Inspect the root recorded by the API; unreadable, missing, or retained state never proves idle. */
async function retainedOwnership(lock: ApiLockRecord): Promise<ApiLockDiagnosis['retainedLeases']> {
  if (lock.recovery === undefined) return { inspected: false,
    reason: 'This older lock does not record its API-owned lease root; explicit operator recovery is required.' }
  const leaseRoot = lock.recovery.leaseRoot
  try {
    await readdir(leaseRoot)
    const entries: string[] = []
    for (const name of ['leases', 'claims']) {
      entries.push(...(await readdir(path.join(leaseRoot, name))).map(entry => `${name}/${entry}`))
    }
    return { inspected: true, leaseRoot, entries }
  } catch (error) {
    return { inspected: false, reason: `The recorded lease root could not be inspected: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * Diagnose a present API ownership lock without changing it. A missing parent,
 * a free port, or a reused PID never proves that crash-orphaned descendants
 * stopped. Machine-safe recovery additionally requires an untruncated operation
 * scan containing only validated successful settlements, and no retained
 * lease or claim entries in the root recorded by the API. Older or uncertain
 * state requires operator confirmation.
 * @param options - saved connection settings; the API endpoint supplies the port.
 * @param dependencies - injectable host reads for isolated tests.
 * @returns recorded, live, and preserved facts plus a verdict.
 */
export async function diagnoseApiLock(
  options: DeepClusterOptions,
  dependencies: ServiceLockDependencies = {},
): Promise<ApiLockDiagnosis> {
  if (options.apiEndpoint === undefined) throw new Error('Lock diagnosis requires the saved apiEndpoint.')
  const stateDirectory = dependencies.stateDirectory ?? apiStateDirectory(options.dshPath)
  const lockFile = path.join(stateDirectory, 'api-owner.lock')
  const lock = await readApiLock(lockFile)
  const retainedLeases: ApiLockDiagnosis['retainedLeases'] = lock === null ? {
    inspected: false as const,
    reason: 'No API ownership lock records a lease root.',
  } : await retainedOwnership(lock)
  if (lock === null) {
    return { lockFile, lock: null, recordedOwner: null, livePortOwner: null, recordedProcess: null,
      interruptedOperations: [], retainedLeases, operationScanTruncated: false,
      recoveryProof: 'unavailable', expectedOwner: null, verdict: 'absent',
      detail: 'No API ownership lock is present.', recoveryCommand: null }
  }
  const expectedOwner: ExpectedLockOwner = { owner: lock.owner, pid: lock.pid,
    ...lock.startTime === undefined ? {} : { startTime: lock.startTime } }
  const readState = dependencies.readState ?? (() => readServiceState(options.dshPath))
  const inspectPortImpl = dependencies.inspectPort ?? ((port: number) => inspectPort(port))
  const inspectProcess = dependencies.inspectProcess ?? inspectProcessIdentity
  const state = await readState()
  const recordedOwner = lock.startTime === undefined ? state.api : {
    pid: lock.pid, startTime: lock.startTime,
    commandLine: state.api?.pid === lock.pid && state.api.startTime === lock.startTime ? state.api.commandLine : '',
  }
  let livePortOwner: ServiceOwner | null = null
  let portConflict: string | undefined
  try { livePortOwner = await inspectPortImpl(portOf(options.apiEndpoint)) } catch (error) {
    if (!(error instanceof ServicePortError)) throw error
    portConflict = error.message
  }
  const recordedProcess = recordedOwner === null ? null : await inspectProcess(recordedOwner.pid)
  const preserved = await preservedOperations(path.join(stateDirectory, 'operations'), inspectProcess)
  const base = { lockFile, lock, recordedOwner, livePortOwner, recordedProcess, expectedOwner,
    interruptedOperations: preserved.operations, retainedLeases, operationScanTruncated: preserved.truncated }
  if (portConflict !== undefined) {
    return { ...base, recoveryProof: 'unavailable', verdict: 'ambiguous', detail: portConflict, recoveryCommand: null }
  }
  if (livePortOwner !== null) {
    const healthy = sameProcessStart(recordedOwner, livePortOwner) && lock.pid === livePortOwner.pid
    return { ...base, recoveryProof: 'unavailable', verdict: healthy ? 'healthy' : 'live',
      detail: healthy
        ? `The recorded API PID ${String(livePortOwner.pid)} is listening with matching process identity.`
        : `Port ${String(portOf(options.apiEndpoint))} is owned by PID ${String(livePortOwner.pid)} (started ${livePortOwner.startTime}); the lock is not proven stale.`,
      recoveryCommand: null }
  }
  if (recordedOwner === null) {
    return { ...base, recoveryProof: 'unavailable', verdict: 'ambiguous',
      detail: 'The lock exists but service.json records no API owner, so the lock identity cannot be proven.',
      recoveryCommand: null }
  }
  if (lock.pid !== recordedOwner.pid) {
    return { ...base, recoveryProof: 'unavailable', verdict: 'ambiguous',
      detail: `The lock names PID ${String(lock.pid)} but service.json records the API as PID ${String(recordedOwner.pid)}.`,
      recoveryCommand: null }
  }
  if (lock.startTime !== undefined && lock.startTime !== recordedOwner.startTime) {
    return { ...base, recoveryProof: 'unavailable', verdict: 'ambiguous',
      detail: 'The lock start time differs from the recorded API owner start time; the lock belongs to another process instance.',
      recoveryCommand: null }
  }
  if (recordedProcess !== null && sameProcessStart(recordedOwner, recordedProcess)) {
    return { ...base, recoveryProof: 'unavailable', verdict: 'live',
      detail: `The recorded API process PID ${String(recordedOwner.pid)} is still running without listening; inspect its log and stop it through its own lifecycle.`,
      recoveryCommand: null }
  }
  if (preserved.liveOwner) {
    return { ...base, recoveryProof: 'unavailable', verdict: 'live',
      detail: 'A preserved operation record still names a live owner; stop that process before recovering the lock.',
      recoveryCommand: null }
  }
  const boot = await (dependencies.inspectBoot ?? (async () => process.platform === 'win32' ? await inspectWindowsBoot() : null))()
  if (boot !== null && predatesWindowsBoot(recordedOwner.startTime, boot)) {
    return { ...base, previousBoot: boot, recoveryProof: 'machine-proven', verdict: 'stale',
      detail: `The API owner predates the Windows boot at ${boot.startedAt}; its workers cannot still run. Previous-boot ownership records can be quarantined without replaying work.`,
      recoveryCommand: 'service recover' }
  }
  if (lock.workers !== undefined && dependencies.recoverRange !== undefined) {
    return { ...base, recoveryProof: 'managed-ranges', verdict: 'stale',
      detail: 'The API owner is gone. Its durable worker ranges require cleanup before their resource claims can be released; unresolved resources remain reserved.',
      recoveryCommand: 'service recover' }
  }
  const ownerEvidence = recordedProcess === null
    ? `The recorded API owner PID ${String(recordedOwner.pid)} (started ${recordedOwner.startTime}) is gone and the port is free`
    : `PID ${String(recordedOwner.pid)} was reused by another process (started ${recordedProcess.startTime}); the recorded API owner is gone`
  if (lock.startTime !== undefined && lock.startTime.trim() !== '' && lock.startTime === recordedOwner.startTime
    && preserved.settled && retainedLeases.inspected
    && retainedLeases.entries.length === 0) {
    return { ...base, recoveryProof: 'machine-proven', verdict: 'stale',
      detail: `${ownerEvidence}; every operation is inspectably settled and the recorded lease/claim root is empty.`,
      recoveryCommand: 'service recover' }
  }
  const uncertainty = [
    recordedProcess === null ? null : 'PID reuse and a free port do not prove descendants stopped',
    `${String(preserved.operations.length)} preserved operation record(s) remain`,
    preserved.settled ? null : 'operation settlement is incomplete or uncertain',
    retainedLeases.inspected ? `${String(retainedLeases.entries.length)} lease/claim entry(s) remain` : retainedLeases.reason,
  ].filter((value): value is string => value !== null)
  return { ...base, recoveryProof: 'operator-confirmation-required', verdict: 'stale',
    detail: `${ownerEvidence}; ${uncertainty.join('; ')}. Recovery requires an explicit operator confirmation bound to lock owner ${lock.owner} (PID ${String(lock.pid)}).`,
    recoveryCommand: 'service recover' }
}

/**
 * Quarantine a stale API ownership lock after machine proof or an explicit
 * operator confirmation bound to the diagnosed lock identity. The lock is renamed, never
 * unlinked; operation records are not replayed, rewritten, or deleted. An
 * exclusive recovery fence blocks API admission before and after owner-lock
 * acquisition, and a replacement is never restored over a fresh owner.
 * @param options - saved connection settings.
 * @param dependencies - injectable host reads for isolated tests.
 * @param confirmation - operator assertion bound to the exact diagnosed owner.
 * @returns the quarantine path, evidence class, and a human-readable result.
 */
export async function recoverApiLock(
  options: DeepClusterOptions,
  dependencies: ServiceLockDependencies = {},
  confirmation?: LockRecoveryConfirmation,
): Promise<ServiceLockRecovery> {
  if (options.apiEndpoint === undefined) throw new Error('Lock recovery requires the saved apiEndpoint.')
  const apiEndpoint = options.apiEndpoint
  const diagnosis = await diagnoseApiLock(options, dependencies)
  const expected = diagnosis.expectedOwner
  if (diagnosis.verdict !== 'stale' || diagnosis.recoveryCommand !== 'service recover' || expected === null
    || diagnosis.recoveryProof === 'unavailable') {
    throw new Error(`Refusing to recover the API ownership lock: ${diagnosis.detail} Nothing was changed.`)
  }
  const automatic = confirmation === undefined
  if (automatic && !['machine-proven', 'managed-ranges'].includes(diagnosis.recoveryProof)) {
    throw new Error(`Refusing automatic recovery: a dead parent, free port, or reused PID is not proof that descendants stopped. Run \`service recover --dry-run\`, verify the workers are gone, then confirm the exact owner ${expected.owner} (PID ${String(expected.pid)}) with \`service recover --confirm-lock-owner ${expected.owner}\`. Nothing was changed.`)
  }
  if (confirmation !== undefined && (confirmation.confirmOwner !== expected.owner
    || (confirmation.expectedPid !== undefined && confirmation.expectedPid !== expected.pid)
    || (confirmation.expectedStartTime !== undefined && confirmation.expectedStartTime !== expected.startTime))) {
    throw new Error(`Refusing to recover the API ownership lock: the confirmation does not match the diagnosed owner ${expected.owner} (PID ${String(expected.pid)}). Nothing was changed.`)
  }
  const inspectPortImpl = dependencies.inspectPort ?? ((port: number) => inspectPort(port))
  const live = await inspectPortImpl(portOf(apiEndpoint))
  if (live !== null) throw new Error(`Refusing to recover the API ownership lock: PID ${String(live.pid)} now owns port ${String(portOf(apiEndpoint))}. Nothing was changed.`)
  const lockFile = diagnosis.lockFile
  return await withApiRecoveryFence(path.dirname(lockFile), async () => {
    const blocked = await inspectPortImpl(portOf(apiEndpoint))
    if (blocked !== null) throw new Error(`Refusing to recover the API ownership lock: PID ${String(blocked.pid)} started listening on port ${String(portOf(apiEndpoint))} during recovery. Nothing was changed.`)
    const current = await readApiLock(lockFile)
    if (current === null || current.owner !== expected.owner || current.pid !== expected.pid
      || current.startTime !== expected.startTime
      || current.recovery?.leaseRoot !== diagnosis.lock?.recovery?.leaseRoot
      || current.workers?.generation !== diagnosis.lock?.workers?.generation) {
      throw new Error('Refusing to recover the API ownership lock: its owner changed during diagnosis. Nothing was changed.')
    }
    const identity = await stat(lockFile, { bigint: true })
    const capturedLock = await readFile(lockFile, 'utf8')
    const confirmUnchanged = async (): Promise<void> => {
      const observed = await stat(lockFile, { bigint: true })
      if (observed.dev !== identity.dev || observed.ino !== identity.ino || await readFile(lockFile, 'utf8') !== capturedLock
        || await inspectPortImpl(portOf(apiEndpoint)) !== null
        || sameProcessStart(expected.startTime === undefined ? null : { pid: expected.pid, startTime: expected.startTime },
          await (dependencies.inspectProcess ?? inspectProcessIdentity)(expected.pid))) {
        throw new Error('API ownership changed during worker recovery; the replacement and its resources were preserved.')
      }
    }
    // Admission is fenced; repeat every proof so work or ownership appearing after
    // the initial observation cannot qualify for automatic recovery.
    const fresh = await diagnoseApiLock(options, dependencies)
    if (fresh.verdict !== 'stale' || fresh.expectedOwner?.owner !== expected.owner
      || fresh.expectedOwner.pid !== expected.pid || fresh.expectedOwner.startTime !== expected.startTime
      || fresh.lock?.recovery?.leaseRoot !== current.recovery?.leaseRoot
      || fresh.lock?.workers?.generation !== current.workers?.generation
      || (automatic && !['machine-proven', 'managed-ranges'].includes(fresh.recoveryProof))) {
      throw new Error('Refusing to recover the API ownership lock: ownership or idle proof changed during recovery. Nothing was changed.')
    }
    const unchanged = await stat(lockFile, { bigint: true })
    if (unchanged.dev !== identity.dev || unchanged.ino !== identity.ino) {
      throw new Error('Refusing to recover the API ownership lock: a replacement appeared during recovery. Nothing was changed.')
    }
    const issueId = current.workers?.generation ?? `api-${current.owner}`
    const issues: RecoveryIssue[] = []
    let workerCleanupFailed = false
    try {
      if (fresh.previousBoot !== undefined && current.recovery !== undefined) {
        const inspection = await inspectPreviousBootOwnership(current.recovery.leaseRoot, fresh.previousBoot)
        await confirmUnchanged()
        if (current.workers !== undefined && expected.startTime !== undefined) {
          await settleRebootedWorkerGeneration(path.dirname(lockFile), current.workers.generation, expected.startTime, fresh.previousBoot)
        }
        await quarantinePreviousBootOwnership(inspection)
      } else if (current.workers !== undefined && current.recovery !== undefined && dependencies.recoverRange !== undefined) {
        const recovered = await recoverWorkerGeneration(path.dirname(lockFile), current.workers.generation,
          boundedWorkerRecovery(dependencies.recoverRange, options.terminationGraceMs), dependencies.signal)
        await confirmUnchanged()
        await quarantineRecoveredOwnership(current.recovery.leaseRoot, recovered)
      }
    } catch (error) {
      dependencies.signal?.throwIfAborted()
      await confirmUnchanged()
      workerCleanupFailed = true
      issues.push(recoveryIssue('worker-generation', issueId, error))
    }
    await confirmUnchanged()
    if (current.recovery !== undefined) issues.push(...await claimRecoveryIssues(current.recovery.leaseRoot))
    const retained = (await readRecoveryIssues(path.dirname(lockFile))).filter(issue =>
      issue.kind === 'worker-generation' && issue.id !== issueId && issue.id !== 'claim-registry')
    await replaceRecoveryIssues(path.dirname(lockFile), 'worker-generation', [...retained, ...issues])
    await confirmUnchanged()
    const stamp = new Date().toISOString().replace(/[-:.TZ]/gu, '')
    const quarantine = `${lockFile}.recovered-${stamp}-${randomUUID().slice(0, 8)}`
    await rename(lockFile, quarantine)
    const moved = await stat(quarantine, { bigint: true })
    if (moved.dev !== identity.dev || moved.ino !== identity.ino) {
      throw new Error(`Refusing to recover the API ownership lock: a replacement appeared during recovery and was quarantined at ${quarantine}, not restored over a possibly fresh owner. Inspect both identities manually.`)
    }
    const proof = workerCleanupFailed ? 'owner-stopped' : automatic ? 'machine-proven' : 'operator-confirmed'
    return { recovered: true, quarantineFile: quarantine, proof, expectedOwner: expected, recoveryIssues: issues,
      detail: `The stale lock for ${proof} owner ${expected.owner} (PID ${String(expected.pid)}) was quarantined at ${quarantine}. `
        + (issues.length === 0 ? 'No operation was deleted or replayed.' : workerCleanupFailed
          ? 'Worker cleanup remains unresolved; its resource claims stay active and health reports the recovery issue.'
          : 'Untrusted claim evidence remains reserved; health reports the affected admission restrictions.') }
  }, recoveryFenceOptions(dependencies))
}

/**
 * Poll a read until it yields a value or the overall deadline passes. Each
 * attempt is bounded independently, so a probe that never settles cannot hold
 * startup or shutdown past the deadline.
 * @param read - one observation attempt.
 * @param timeoutMs - overall wait bound.
 * @param probeTimeoutMs - bound for one attempt; defaults to the lifecycle probe bound.
 * @returns the first non-null value, or null at the deadline.
 */
export async function boundedWaitFor<T>(
  read: () => Promise<T | null>,
  timeoutMs: number,
  probeTimeoutMs = PROBE_TIMEOUT_MS,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const remaining = Math.max(0, deadline - Date.now())
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const value = await Promise.race<T | null>([
        read(),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => { resolve(null) }, Math.min(probeTimeoutMs, remaining))
          timer.unref()
        }),
      ])
      if (value !== null) return value
    } catch (error) {
      if (error instanceof ServiceStartupError) throw error
      // Network probes can fail while the scheduled instance is still starting.
    }
    finally { if (timer !== undefined) clearTimeout(timer) }
    if (Date.now() >= deadline) break
    const pause = Math.min(500, deadline - Date.now())
    if (pause > 0) await new Promise(resolve => setTimeout(resolve, pause))
  }
  return null
}

/**
 * Build the production host. API shutdown is a bearer-authenticated request whose owner
 * disposes the normal runtime and releases its state lock; no lock file is ever removed here.
 * @param options - saved connection settings including the DSH working directory.
 * @param dashboardWorkspace - default primary workspace the dashboard projects when the saved
 *   configuration does not name one; the launcher passes it to the overlay.
 * @param platform - host platform; tests inject a non-Windows value to prove early failure.
 * @param recovery - native range recovery and caller cancellation.
 * @returns host effects that launch through per-user on-demand scheduled tasks.
 */
export function windowsServiceEffects(
  options: DeepClusterOptions,
  dashboardWorkspace?: string,
  platform: NodeJS.Platform = process.platform,
  recovery: Pick<ServiceLockDependencies, 'recoverRange' | 'signal'> = {},
): ServiceEffects {
  if (platform !== 'win32') {
    throw new Error('DeepCluster persistent service lifecycle is supported on Windows only. No service files were created; run the API and dashboard through your own supervisor on this platform.')
  }
  if (options.apiEndpoint === undefined) {
    throw new Error('Persistent service lifecycle requires the saved apiEndpoint.')
  }
  if (options.dshPath === undefined) {
    throw new Error('Persistent service lifecycle requires the saved dshPath working directory.')
  }
  resolveServiceInvocation(options)
  const apiEndpoint = options.apiEndpoint
  const dashboardEndpoint = options.dashboardEndpoint ?? 'http://127.0.0.1:3788'
  const apiPort = portOf(apiEndpoint), dashboardPort = portOf(dashboardEndpoint)
  const directory = serviceDirectory(options.dshPath)
  const stateDirectory = apiStateDirectory(options.dshPath)
  const apiTask = serviceTaskName('api', apiPort)
  const dashboardTask = serviceTaskName('dashboard', dashboardPort)

  const health = async (): Promise<ServiceHealth | null> => {
    try {
      const response = await fetch(`${apiEndpoint}/v1/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
      if (!response.ok) return null
      const body: unknown = await response.json()
      if (typeof body !== 'object' || body === null || !('status' in body) || !('activeRuns' in body)
        || typeof body.status !== 'string' || typeof body.activeRuns !== 'number') return null
      if ('cleanupUnconfirmed' in body && body.cleanupUnconfirmed !== undefined
        && (typeof body.cleanupUnconfirmed !== 'number' || !Number.isSafeInteger(body.cleanupUnconfirmed)
          || body.cleanupUnconfirmed < 0)) return null
      if ('admissionBlocked' in body && body.admissionBlocked !== undefined && typeof body.admissionBlocked !== 'boolean') return null
      const recoveryIssues = 'recoveryIssues' in body && body.recoveryIssues !== undefined
        ? parseRecoveryIssues(body.recoveryIssues) : undefined
      return { status: body.status, activeRuns: body.activeRuns,
        ...'cleanupUnconfirmed' in body && typeof body.cleanupUnconfirmed === 'number'
          ? { cleanupUnconfirmed: body.cleanupUnconfirmed } : {},
        ...'admissionBlocked' in body && typeof body.admissionBlocked === 'boolean' ? { admissionBlocked: body.admissionBlocked } : {},
        ...recoveryIssues === undefined ? {} : { recoveryIssues } }
    } catch { return null }
  }
  /** Newest dashboard run directory, preferring one that already captured a URL. */
  const newestRun = async (): Promise<string | null> => {
    try {
      const runs = (await readdir(path.join(directory, 'runs'))).filter(name => /^\d{17}-\d{3}$/u.test(name))
      const stamped = await Promise.all(runs.map(async (name) => {
        const run = path.join(directory, 'runs', name)
        const at = await stat(path.join(run, 'dashboard.log')).then(info => info.mtimeMs, () => null)
        const captured = await stat(path.join(run, 'startup-url.txt')).then(info => info.mtimeMs, () => null)
        return at === null && captured === null ? null : { run, at: Math.max(at ?? 0, captured ?? 0) }
      }))
      return stamped.filter(entry => entry !== null).sort((left, right) => right.at - left.at)[0]?.run ?? null
    } catch { return null }
  }
  /** Capture the first launcher URL into a private per-run file without rewriting the open log. */
  const captureLogin = async (run: string): Promise<LoginUrl | null> => {
    const file = path.join(run, 'startup-url.txt')
    try {
      const captured = (await readFile(file, 'utf8')).trim()
      if (captured !== '') return { url: captured, file }
    } catch { /* not captured yet */ }
    let log: string
    try { log = await readFile(path.join(run, 'dashboard.log'), 'utf8') } catch { return null }
    const url = startupUrlOf(log)
    if (url === null) return null
    await writeFile(file, `${url}\n`, { mode: 0o600 })
    return { url, file }
  }
  let startedDashboardRun: string | null = null
  const launches = new Map<'api' | 'dashboard', ServiceTaskLaunch>()
  const launchFiles = new Map<'api' | 'dashboard', string>()
  const pendingLaunches = new Set<'api' | 'dashboard'>()
  let uncertainLaunch = false
  const observeStarting = async (kind: 'api' | 'dashboard'): Promise<void> => {
    const launch = launches.get(kind)
    if (launch === undefined || !pendingLaunches.has(kind)) return
    try { await observeServiceTask(launch) } catch (error) {
      pendingLaunches.delete(kind)
      throw error
    }
  }
  const login = async (): Promise<LoginUrl | null> => {
    const run = startedDashboardRun ?? await newestRun()
    return run === null ? null : await captureLogin(run)
  }
  const startLauncher = async (kind: 'api' | 'dashboard'): Promise<void> => {
    if (options.dshPath === undefined) throw new Error('Persistent service lifecycle requires the saved dshPath.')
    const stamp = stampNow()
    const run = path.join(directory, 'runs', stamp)
    const log = path.join(run, kind === 'api' ? 'api.log' : 'dashboard.log')
    const commandFile = path.join(run, `start-${kind}.cmd`)
    const launchFile = path.join(run, 'launch.json')
    const context = {
      kind, logFile: log, stateDirectory, apiPort, dashboardPort, launchFile,
      ...dashboardWorkspace === undefined ? {} : { dashboardWorkspace },
    }
    const text = serviceLauncherScript(options, context)
    await ensureStateDirectory(options.dshPath)
    await privateDirectory(run)
    if (kind === 'dashboard') startedDashboardRun = run
    await privateDirectory(path.dirname(commandFile))
    await writeFile(commandFile, text, { mode: 0o600 })
    const taskName = kind === 'api' ? apiTask : dashboardTask
    await createServiceLaunch(launchFile, { kind, taskName, commandFile, logFile: log,
      invocation: serviceLaunchInvocation(options, context) })
    launchFiles.set(kind, launchFile)
    uncertainLaunch = true
    const instanceId = await runScheduledTask(taskName, commandFile)
    await recordServiceLaunchInstance(launchFile, instanceId)
    launches.set(kind, { kind, taskName, instanceId, commandFile, logFile: log })
    pendingLaunches.add(kind)
    uncertainLaunch = false
  }

  const reconcileLaunches = async (): Promise<void> => {
    if (recovery.recoverRange === undefined) return
    const issues: RecoveryIssue[] = []
    for (const { file, launch } of await listServiceLaunches(directory,
      (file, error) => { issues.push(recoveryIssue('service-launch', path.basename(path.dirname(file)), error)) })) {
      if (launch.taskName !== (launch.kind === 'api' ? apiTask : dashboardTask)) continue
      try {
        let evidence = await readServiceLaunchEvidence(file)
        if (evidence.settled || evidence.recovered) continue
        const hostAlive = evidence.host !== null && sameProcessIdentity(evidence.host, await inspectProcessIdentity(evidence.host.pid))
        const saved = await readServiceState(options.dshPath)
        if (!evidence.cancelled && hostAlive && sameProcessIdentity(saved[launch.kind], evidence.owner)
          && evidence.owner !== null && sameProcessIdentity(evidence.owner, await inspectProcessIdentity(evidence.owner.pid))) {
          continue
        }
        let ready: ServiceOwner | null = null
        if (!evidence.cancelled && hostAlive) {
          const observed = await boundedWaitFor(async (): Promise<{ owner: ServiceOwner | null } | null> => {
            evidence = await readServiceLaunchEvidence(file)
            if (evidence.settled || evidence.cancelled) return { owner: null }
            const owner = await inspectPort(launch.kind === 'api' ? apiPort : dashboardPort)
            if (!sameProcessIdentity(evidence.owner, owner)) return null
            if (launch.kind === 'api') return (await health())?.status === 'ready' ? { owner } : null
            const captured = await captureLogin(path.dirname(file))
            if (captured === null) return null
            const proof = await verifyDashboard(captured.url, AbortSignal.timeout(PROBE_TIMEOUT_MS))
            return proof?.authenticatedHtml === true && proof.clientBoot ? { owner } : null
          }, options.serviceLifecycleWaitMs)
          ready = observed?.owner ?? null
        }
        if (ready !== null) {
          const state = await readServiceState(options.dshPath)
          const captured = launch.kind === 'dashboard' ? await captureLogin(path.dirname(file)) : null
          await saveServiceState(options.dshPath, { ...state, [launch.kind]: ready,
            ...captured === null ? {} : { loginUrlFile: captured.file }, updatedAt: new Date().toISOString() })
          if (launch.kind === 'dashboard') startedDashboardRun = path.dirname(file)
        } else {
          await cancelServiceLaunch(file, recovery.recoverRange, recovery.signal)
        }
      } catch (error) {
        recovery.signal?.throwIfAborted()
        issues.push(recoveryIssue('service-launch', launch.id, error))
      }
    }
    await replaceRecoveryIssues(stateDirectory, 'service-launch', issues)
    for (const issue of issues) process.stderr.write(`deep-cluster: retained service launch ${issue.id}: ${issue.message}\n`)
  }

  return {
    apiEndpoint,
    dashboardEndpoint,
    async prepareStart() {
      const saved = await readServiceState(options.dshPath)
      const listener = await inspectPort(apiPort)
      if (listener !== null && sameProcessIdentity(saved.api, listener)) return
      await reconcileLaunches()
      if (await inspectPort(apiPort) === null) await prepareServiceOwnership(options, recovery)
    },
    async inspectApi() {
      // Health first: a ready answer proves the listener is bound before the owner query runs.
      let ready = await health()
      const owner = await inspectPort(apiPort)
      const file = launchFiles.get('api')
      if (file !== undefined) {
        const evidence = await readServiceLaunchEvidence(file)
        if (!sameProcessIdentity(evidence.owner, owner)) ready = null
      }
      if (ready?.status === 'ready') pendingLaunches.delete('api')
      else await observeStarting('api')
      return { owner, health: ready }
    },
    async inspectDashboard() {
      const captured = await login()
      const owner = await inspectPort(dashboardPort)
      const file = launchFiles.get('dashboard')
      if (file !== undefined && !sameProcessIdentity((await readServiceLaunchEvidence(file)).owner, owner)) {
        await observeStarting('dashboard')
        return { owner: null, proof: null }
      }
      if (owner === null) await observeStarting('dashboard')
      return { owner, proof: captured === null ? null
        : await verifyDashboard(captured.url, AbortSignal.timeout(PROBE_TIMEOUT_MS)).catch(() => null) }
    },
    async inspectDashboardReadOnly() {
      const saved = await readServiceState(options.dshPath)
      const owner = await inspectPort(dashboardPort)
      if (saved.loginUrlFile === null) return { owner, proof: null }
      let url: string
      try { url = (await readFile(saved.loginUrlFile, 'utf8')).trim() } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { owner, proof: null }
        throw error
      }
      return { owner, proof: await verifyDashboard(url, AbortSignal.timeout(PROBE_TIMEOUT_MS)).catch(() => null) }
    },
    async apiLockExists() {
      try { await stat(path.join(stateDirectory, 'api-owner.lock')); return true } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw error
      }
    },
    diagnoseApiLock: () => diagnoseApiLock(options, recovery),
    recoverIdleApiLock: () => recoverApiLock(options, recovery),
    async confirmStartRollback() {
      if (recovery.recoverRange !== undefined) {
        for (const file of launchFiles.values()) await cancelServiceLaunch(file, recovery.recoverRange, recovery.signal)
        if (await inspectPort(apiPort) === null) {
          await prepareServiceOwnership(options, recovery)
          const diagnosis = await diagnoseApiLock(options, recovery)
          if (diagnosis.verdict === 'stale' && ['managed-ranges', 'machine-proven'].includes(diagnosis.recoveryProof)) {
            await recoverApiLock(options, recovery)
          }
        }
        return true
      }
      if (uncertainLaunch) return false
      for (const launch of launches.values()) {
        try { await observeServiceTask(launch); return false } catch (error) {
          if (!(error instanceof ServiceStartupError) || error.code !== 'startup-exited') return false
        }
        if (await inspectPort(launch.kind === 'api' ? apiPort : dashboardPort) !== null) return false
        if (launch.kind === 'api') {
          try { await stat(path.join(stateDirectory, 'api-owner.lock')); return false } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
        }
      }
      return true
    },
    startApi: () => startLauncher('api'),
    startDashboard: () => startLauncher('dashboard'),
    requestApiShutdown(options: { confirmCleanupUnconfirmed?: boolean } = {}) {
      return withServiceMutationIntent('request API shutdown', async () => {
        const file = launchFiles.get('api')
        if (file !== undefined && !sameProcessIdentity((await readServiceLaunchEvidence(file)).owner, await inspectPort(apiPort))) return
        const response = await fetch(`${apiEndpoint}/v1/service/shutdown`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(options.confirmCleanupUnconfirmed === true ? { confirmCleanupUnconfirmed: true } : {}),
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        })
        if (response.status === 404) {
          throw new Error(`The API on ${apiEndpoint} has no /v1/service/shutdown route (it predates graceful shutdown); stop it through its owning console. No lock or state was changed.`)
        }
        if (!response.ok) throw new Error(`The API refused graceful shutdown with HTTP ${response.status}.`)
      }, { processScope: 'in-process' })
    },
    async endDashboard(owner) {
      const currentLaunch = launchFiles.get('dashboard')
      if (currentLaunch !== undefined && recovery.recoverRange !== undefined) {
        await cancelServiceLaunch(currentLaunch, recovery.recoverRange, recovery.signal)
        return
      }
      if (owner !== null && recovery.recoverRange !== undefined) {
        for (const { file } of await listServiceLaunches(directory)) {
          const evidence = await readServiceLaunchEvidence(file)
          if (evidence.launch.kind === 'dashboard' && sameProcessIdentity(evidence.owner, owner)) {
            await cancelServiceLaunch(file, recovery.recoverRange, recovery.signal)
            return
          }
        }
      }
      await endScheduledTask(dashboardTask)
      if (owner === null) return
      const live = await inspectProcessIdentity(owner.pid)
      if (!sameProcessIdentity(owner, live)) return
      await runServicePowerShell(`terminate dashboard PID ${String(owner.pid)}`, `$out = & taskkill.exe /PID ${String(owner.pid)} /T /F 2>&1
if ($LASTEXITCODE -ne 0) { [Console]::Error.Write(($out | Out-String)); exit $LASTEXITCODE }`)
    },
    async readLoginUrl() {
      const value = await login()
      if (value === null) await observeStarting('dashboard')
      return value
    },
    async verifyDashboard(url, signal) {
      const file = launchFiles.get('dashboard')
      if (file !== undefined && !sameProcessIdentity((await readServiceLaunchEvidence(file)).owner, await inspectPort(dashboardPort))) {
        await observeStarting('dashboard')
        return null
      }
      const proof = await verifyDashboard(url, signal)
      if (dashboardProofValid(proof)) pendingLaunches.delete('dashboard')
      else await observeStarting('dashboard')
      return proof
    },
    waitFor: boundedWaitFor,
  }
}

let clock = 0
/** Monotonic per-process run stamp; every launch gets its own directory and log. */
function stampNow(): string {
  clock += 1
  return `${new Date().toISOString().replace(/[-:.TZ]/gu, '').slice(0, 17)}-${String(clock % 1000).padStart(3, '0')}`
}
