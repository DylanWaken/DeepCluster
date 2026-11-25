/** DSH command and MCP adapters; operational requests use the dedicated local HTTP API. */
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-cmdline'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { managedProcessRunner } from './executor.ts'
import { apiRequest, submitAndWait, type ApiSubmission } from './api-client.ts'
import { configPath, loadConfig, resolveConfiguredOptions } from './config.ts'
import { describeTargets, installConfiguredPlannerAssets } from './install.ts'
import { parsePlan, serializePlan } from './plan.ts'
import {
  diagnoseApiLock,
  readServiceState,
  recoverApiLock,
  runServiceCommand,
  saveServiceState,
  ServiceLifecycle,
  serviceStatusExitCode,
  windowsServiceEffects,
} from './service.ts'
import { serveStdio, type McpHandoffRequest } from './mcp.ts'
import { withServiceLifecycleLock } from './service-lock.ts'
import { runServiceHost } from './service-launch-recovery.ts'
import { assertNoPendingServiceMutation, readServiceMutationIntent, recoverServiceMutationIntent, recoverStaleServiceMutation, withServiceMutationTransaction } from './service-intent.ts'
import type { DeepClusterConfig, DeepClusterOptions, HandoffResult, InstallTargetId } from './types.ts'

const HELP = `deep-cluster — authenticated local HTTP API client

Usage: dsh --profile deep-cluster <command> [options]
Commands: coordinate, run, install, serve (MCP adapter), journal, ledger,
          lease status, ack <id>, doctor (API health),
          service start|status|stop|restart|login-url

Persistent service (outside any worker process tree, Windows only):
  service start   launch API and dashboard through the saved dsh profiles
  service status  report verified API health, dashboard snapshot and owners
  service stop    refuse active runs and unconfirmed cleanup; stop only
    recorded, verified owners
  service restart stop then start with a fresh private browser login URL
  --confirm-cleanup-unconfirmed  with stop/restart: assert you verified and
    terminated the process ranges reported by cleanupUnconfirmed
  service login-url  print the fresh URL for the controller to give the user
  service recover [--dry-run]  diagnose a stale API ownership lock
  service recover --confirm-lock-owner <owner>  quarantine it after verifying the
    diagnosed owner is gone and confirming its exact identity; the result is
    operator-confirmed, not machine-proven
  service recover-controller --dry-run  inspect an interrupted external mutation
  service recover-controller --confirm-controller-intent <id>  quarantine its
    exact intent only after verifying the controller and all descendants stopped

Connection (saved by install):
  --api-endpoint <url>   literal loopback HTTP origin
  --dashboard-endpoint <url>  dashboard loopback origin (default 127.0.0.1:3788)
  --dsh-path <dir>       user-provided DSH checkout for API startup
Run options:
  --cwd <dir>           workspace (default: current directory)
  --plan <file>         plan Markdown; repeat for parallel independent plans
  --plan-text <text>    inline plan Markdown
  --timeout <ms>        per-worker deadline
  --concurrency <n>     simultaneous ready tasks
  --max-attempts <n>    ordinary attempt budget
  --max-repairs <n>     separate repair budget; 0 disables repairs
  --lease-ttl <ms>      heartbeat lifetime; never permits takeover
  --lease-wait <ms>     hardware acquisition deadline
  --request-id <id>     retained Idempotency-Key for identical retries
  --dry-run            validate plans through the API; with service recover, diagnose only
Inspection: --tail <n>, --resource <name> (default gpu0)
Acknowledgement: --reject, --note <text>
Installation: --cli <path>, --service-cli <path>, --profile <name>,
              --command-name <name>, --planner cursor|codex|all
              --cli starts workers; --service-cli starts only the persistent
              API and dashboard (default: saved cliPath)
              --skills-root <absolute-dir>  install for any harness at
                                            <dir>/<command-name>/SKILL.md
              --label <text>                harness name for a generic install
Install for any harness: install --skills-root <absolute-dir>
  --skills-root and --planner cannot be combined; --label requires --skills-root.

Exit codes: 0 completed, 1 failed or interrupted, 2 usage error, 3 needs acknowledgement.
Workers and lease namespaces are configured on the API server.
`

interface Parsed {
  command: string
  launchFile?: string
  cwd?: string
  plans: string[]
  planText: string
  config: DeepClusterConfig
  planner?: string
  skillsRoot?: string
  label?: string
  timeout?: number
  maxAttempts?: number
  maxRepairs?: number
  concurrency?: number
  leaseTtl?: number
  leaseWait?: number
  requestId?: string
  resource?: string
  note?: string
  reject?: boolean
  dryRun?: boolean
  confirmLockOwner?: string
  confirmControllerIntent?: string
  confirmCleanupUnconfirmed?: boolean
  tail?: number
  words: string[]
}

/** A command input the caller can correct. */
class UsageError extends Error {}

/** Separate connection settings from server-owned execution options. */
function parse(argv: readonly string[]): Parsed {
  const parsed: Parsed = { command: argv[0] ?? 'help', plans: [], planText: '', config: {}, words: [] }
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i] as string
    const value = (): string => {
      const next = argv[++i]
      if (next === undefined) throw new UsageError(`${arg} needs a value`)
      return next
    }
    const integer = (minimum = 1): number => {
      const number = Number(value())
      if (!Number.isSafeInteger(number) || number < minimum || number > 2_147_483_647) throw new UsageError(`${arg} must be an integer from ${minimum} to 2147483647`)
      return number
    }
    switch (arg) {
      case '--launch-file': {
        const file = value()
        if (!path.isAbsolute(file)) throw new UsageError('--launch-file must be an absolute path')
        parsed.launchFile = file
        break
      }
      case '--cwd': parsed.cwd = value(); break
      case '--plan': parsed.plans.push(value()); break
      case '--plan-text': parsed.planText += `\n${value()}`; break
      case '--api-endpoint': parsed.config.apiEndpoint = value(); break
      case '--dashboard-endpoint': parsed.config.dashboardEndpoint = value(); break
      case '--dsh-path': parsed.config.dshPath = value(); break
      case '--profile': parsed.config.profile = value(); break
      case '--cli': parsed.config.cliPath = value(); break
      case '--service-cli': parsed.config.serviceCliPath = value(); break
      case '--command-name': parsed.config.commandName = value(); break
      case '--planner': parsed.planner = value(); break
      case '--skills-root': {
        const root = value()
        if (!path.isAbsolute(root)) throw new UsageError('--skills-root must be an absolute directory')
        parsed.skillsRoot = root
        break
      }
      case '--label': parsed.label = value(); break
      case '--timeout': parsed.timeout = integer(); break
      case '--concurrency': parsed.concurrency = integer(); break
      case '--max-attempts': parsed.maxAttempts = integer(); break
      case '--max-repairs': parsed.maxRepairs = integer(0); break
      case '--lease-ttl': parsed.leaseTtl = integer(); break
      case '--lease-wait': parsed.leaseWait = integer(0); break
      case '--request-id': parsed.requestId = value(); break
      case '--resource': parsed.resource = value(); break
      case '--note': parsed.note = value(); break
      case '--reject': parsed.reject = true; break
      case '--dry-run': parsed.dryRun = true; break
      case '--confirm-lock-owner': parsed.confirmLockOwner = value(); break
      case '--confirm-controller-intent': parsed.confirmControllerIntent = value(); break
      case '--confirm-cleanup-unconfirmed': parsed.confirmCleanupUnconfirmed = true; break
      case '--tail': parsed.tail = integer(); break
      case '--lease-root': throw new UsageError('--lease-root is server-owned; configure the dedicated API leaseRoot')
      case '-h':
      case '--help': parsed.command = 'help'; break
      default:
        if (arg.startsWith('--')) throw new UsageError(`unknown option ${arg}`)
        parsed.words.push(arg)
    }
  }
  return parsed
}

/** Consume task or plan text from standard input. */
async function readStream(): Promise<string> {
  let text = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) text += chunk as string
  return text
}

/** Read each plan independently, preserving batch document boundaries. */
async function collectPlans(parsed: Parsed): Promise<string[]> {
  if (parsed.plans.filter(file => file === '-').length > 1) throw new UsageError('stdin may provide only one plan')
  const documents: string[] = []
  for (const file of parsed.plans) documents.push(file === '-' ? await readStream() : await readFile(path.resolve(file), 'utf8'))
  if (parsed.planText.trim() !== '') documents.push(parsed.planText)
  if (documents.length === 0) throw new UsageError('a structured --plan or --plan-text with acceptance checks is required')
  return documents
}

/** Construct explicit run JSON; defaults remain owned by the server. */
function submission(parsed: Parsed, plans: readonly string[]): ApiSubmission {
  return {
    workspace: path.resolve(parsed.cwd ?? process.cwd()), plans,
    ...parsed.timeout === undefined ? {} : { timeoutMs: parsed.timeout },
    ...parsed.concurrency === undefined ? {} : { maxConcurrency: parsed.concurrency },
    ...parsed.maxAttempts === undefined ? {} : { maxAttempts: parsed.maxAttempts },
    ...parsed.maxRepairs === undefined ? {} : { maxRepairs: parsed.maxRepairs },
    ...parsed.leaseTtl === undefined && parsed.leaseWait === undefined ? {} : { lease: {
      ...parsed.leaseTtl === undefined ? {} : { ttlMs: parsed.leaseTtl },
      ...parsed.leaseWait === undefined ? {} : { waitMs: parsed.leaseWait },
    } },
  }
}

/** Preserve task context in the serialized plan goal. */
function taskPlan(document: string, task: string): string {
  const plan = parsePlan(document)
  return serializePlan({ ...plan, goal: `${task.trim().replace(/\s+/gu, ' ')}; ${plan.goal}` })
}

/** Forward planned MCP work through HTTP operation ownership. */
async function apiHandoff(options: DeepClusterOptions, request: McpHandoffRequest, signal: AbortSignal): Promise<HandoffResult> {
  if (request.plan === undefined) throw new UsageError('a structured plan is required')
  const started = Date.now()
  const operation = await submitAndWait(options, {
    workspace: path.resolve(request.cwd ?? process.cwd()), plans: [taskPlan(request.plan, request.task)],
    ...request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs },
  }, { signal, ...request.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey } })
  const exitCode = operation.status === 'completed' ? 0 : operation.status === 'needs-ack' ? 3 : 1
  return { ok: exitCode === 0, exitCode, signal: null, stdout: JSON.stringify(operation), stderr: '',
    durationMs: Date.now() - started, command: `POST ${options.apiEndpoint}/v1/runs` }
}

/** Install connection-aware assets without discarding saved execution settings. */
async function commandInstall(parsed: Parsed): Promise<number> {
  if (parsed.skillsRoot !== undefined && parsed.planner !== undefined) {
    throw new UsageError('--skills-root and --planner select different targets; use one')
  }
  if (parsed.label !== undefined && parsed.skillsRoot === undefined) {
    throw new UsageError('--label requires --skills-root')
  }
  // Describe the saved targets before an override hides the previous skills root.
  const saved = resolveConfiguredOptions(loadConfig())
  const previousTargets = describeTargets(saved)
  if (parsed.skillsRoot !== undefined) parsed.config.skillsRoot = parsed.skillsRoot
  if (parsed.label !== undefined) parsed.config.skillLabel = parsed.label
  const options = resolveConfiguredOptions(parsed.config)
  let targets: readonly InstallTargetId[] | undefined
  if (parsed.skillsRoot !== undefined) targets = ['custom']
  else if (parsed.planner !== undefined) {
    if (parsed.planner === 'all') targets = ['cursor', 'codex']
    else if (parsed.planner === 'cursor' || parsed.planner === 'codex') targets = [parsed.planner]
    else throw new UsageError('--planner must be cursor, codex, or all')
  }
  const report = await installConfiguredPlannerAssets(options, targets, configPath(), previousTargets)
  print({ ...report, configFile: configPath() })
  return 0
}

/** Print JSON without reading bearer-token contents into diagnostics. */
function print(value: unknown): void { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`) }

/** Manage the persistent API and dashboard outside any worker process tree. */
async function commandService(parsed: Parsed, subprocess: SubprocessRuntime, signal: AbortSignal): Promise<number> {
  const action = parsed.words[0] ?? 'status'
  const options = resolveConfiguredOptions(parsed.config)
  const lifecycleSignal = AbortSignal.any([signal, AbortSignal.timeout(options.serviceLifecycleWaitMs)])
  if (action === 'login-url') {
    const state = await readServiceState(options.dshPath)
    if (state.loginUrlFile === null) throw new UsageError('no fresh dashboard login URL is recorded; run service start or service restart first')
    print({ loginUrlFile: state.loginUrlFile, loginUrl: (await readFile(state.loginUrlFile, 'utf8')).trim() })
    return 0
  }
  if (action === 'recover') {
    if (process.platform !== 'win32') {
      throw new UsageError('service recover is supported on Windows only; no lock or service file was changed')
    }
    const diagnosis = await diagnoseApiLock(options)
    if (parsed.dryRun === true) {
      print({ dryRun: true, diagnosis })
      return diagnosis.verdict === 'stale' || diagnosis.verdict === 'absent' ? 0 : 1
    }
    const confirmOwner = parsed.confirmLockOwner
    if (confirmOwner === undefined) {
      throw new UsageError(
        'service recover requires an explicit operator confirmation. Run `service recover --dry-run`, '
        + 'verify the recorded owner and its workers are gone, then pass --confirm-lock-owner with the diagnosed owner token.',
      )
    }
    print(await withServiceLifecycleLock(async () => {
      await assertNoPendingServiceMutation()
      return await recoverApiLock(options, {}, { confirmOwner })
    }, { timeoutMs: options.serviceLifecycleWaitMs, signal }))
    return 0
  }
  if (action === 'recover-controller') {
    if (process.platform !== 'win32') throw new UsageError('service recover-controller is supported on Windows only')
    if (parsed.dryRun === true) { print({ dryRun: true, intent: await readServiceMutationIntent() }); return 0 }
    const confirmId = parsed.confirmControllerIntent
    if (confirmId === undefined) throw new UsageError('Inspect service recover-controller --dry-run and confirm the controller and its descendants stopped before passing --confirm-controller-intent <id>.')
    print(await withServiceLifecycleLock(() => recoverServiceMutationIntent(confirmId), {
      timeoutMs: options.serviceLifecycleWaitMs, signal,
    }))
    return 0
  }
  if (action !== 'start' && action !== 'status' && action !== 'stop' && action !== 'restart') {
    throw new UsageError('service supports start, status, stop, restart, recover, recover-controller, or login-url')
  }
  if (parsed.confirmCleanupUnconfirmed === true && action !== 'stop' && action !== 'restart') {
    throw new UsageError('--confirm-cleanup-unconfirmed applies only to service stop or restart')
  }
  const lifecycle = new ServiceLifecycle(
    windowsServiceEffects(options, path.resolve(parsed.cwd ?? process.cwd()), process.platform, {
      recoverRange: (receipt, abort) => subprocess.recoverRange(receipt, abort), signal: lifecycleSignal,
    }),
    () => readServiceState(options.dshPath),
    state => saveServiceState(options.dshPath, state),
    120_000,
    message => process.stderr.write(`deep-cluster: ${message}\n`),
  )
  const run = () => runServiceCommand(lifecycle, action,
    parsed.confirmCleanupUnconfirmed === true ? { confirmCleanupUnconfirmed: true } : {})
  const report = action === 'status' ? await run() : await withServiceLifecycleLock(async () => {
    if (action === 'start') {
      const healthy = await lifecycle.healthyStatus()
      if (healthy !== null) return { ok: true, action: 'reused', ...healthy }
    }
    if (action === 'start' || action === 'restart') {
      const recovered = await recoverStaleServiceMutation({
        recoverRange: (receipt, abort) => subprocess.recoverRange(receipt, abort), signal: lifecycleSignal,
      })
      if (recovered !== null) process.stderr.write(`deep-cluster: recovered ${recovered.proof} controller intent\n`)
    }
    return await withServiceMutationTransaction(`service ${action}`, run, {
      managedCommands: async (script, persist) => {
        const execute = managedProcessRunner(subprocess, options, {
          spawn: (spec, save) => subprocess.spawnRecoverable(spec, save), persist,
        })
        const result = await execute({ command: 'powershell.exe',
          args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
          cwd: options.dshPath ?? process.cwd(), timeoutMs: options.serviceLifecycleWaitMs,
          env: process.env, signal: lifecycleSignal })
        if (result.code !== 0) throw new Error(`Service command failed with exit ${String(result.code)}: ${result.stderr.trim()}`)
        return result.stdout.trim()
      },
    })
  }, { timeoutMs: options.serviceLifecycleWaitMs, signal })
  print(report)
  return action === 'status' ? serviceStatusExitCode(report) : 0
}

/** Submit one batch and follow its server-owned lifetime. */
async function commandCoordinate(parsed: Parsed, signal: AbortSignal): Promise<number> {
  let documents = await collectPlans(parsed)
  if (parsed.command === 'run') {
    let task = parsed.words.join(' ').trim()
    if (task === '' && !parsed.plans.includes('-') && !process.stdin.isTTY) task = (await readStream()).trim()
    if (task === '') throw new UsageError('run requires task words or task text on stdin')
    documents = documents.map(document => taskPlan(document, task))
  }
  if (parsed.config.profile !== undefined || parsed.config.cliPath !== undefined) throw new UsageError('worker profile and CLI are configured on the API server; these flags apply only to install')
  const options = resolveConfiguredOptions(parsed.config)
  const body = submission(parsed, documents)
  if (parsed.dryRun === true) {
    const validation = await apiRequest(options, { method: 'POST', path: '/v1/plans/validate', body, signal })
    if (typeof validation !== 'object' || validation === null || !('plan' in validation)) {
      throw new Error('DeepCluster API validation response is missing its plan')
    }
    print(validation.plan)
    return 0
  }
  const requestId = parsed.requestId ?? randomUUID()
  process.stderr.write(`deep-cluster: Idempotency-Key ${requestId}\n`)
  const operation = await submitAndWait(options, body, {
    signal, idempotencyKey: requestId,
    onAccepted: accepted => process.stderr.write(`deep-cluster: operation ${accepted.operationId}\n`),
  })
  print(operation)
  return operation.status === 'completed' ? 0 : operation.status === 'needs-ack' ? 3 : 1
}

/** Dispatch API requests or local asset installation. */
async function main(argv: readonly string[], signal: AbortSignal, subprocess: SubprocessRuntime): Promise<number> {
  const parsed = parse(argv)
  if (['help', '-h', '--help'].includes(parsed.command)) { process.stdout.write(HELP); return 0 }
  if (parsed.command === 'service-host') {
    if (parsed.launchFile === undefined) throw new UsageError('service-host requires --launch-file')
    return await runServiceHost(parsed.launchFile, subprocess, signal)
  }
  if (parsed.command === 'install') return await commandInstall(parsed)
  if (parsed.command === 'service') return await commandService(parsed, subprocess, signal)
  if (parsed.command === 'coordinate' || parsed.command === 'run') return await commandCoordinate(parsed, signal)
  const options = resolveConfiguredOptions(parsed.config)
  if (parsed.command === 'serve') {
    await serveStdio({ options, run: request => apiHandoff(options, request, signal) }, process.stdin, process.stdout, signal)
    return 0
  }
  const query = new URLSearchParams({ workspace: path.resolve(parsed.cwd ?? process.cwd()) })
  if (parsed.tail !== undefined) query.set('tail', String(parsed.tail))
  switch (parsed.command) {
    case 'journal':
    case 'ledger': print(await apiRequest(options, { method: 'GET', path: `/v1/${parsed.command}?${query}`, signal })); return 0
    case 'doctor': print(await apiRequest(options, { method: 'GET', path: '/v1/health', signal })); return 0
    case 'lease': {
      if ((parsed.words[0] ?? 'status') !== 'status') throw new UsageError('lease supports only status')
      print(await apiRequest(options, { method: 'GET', path: `/v1/leases?${new URLSearchParams({ resource: parsed.resource ?? 'gpu0' })}`, signal }))
      return 0
    }
    case 'ack': {
      const id = parsed.words[0]
      if (id === undefined) throw new UsageError('ack requires an improvisation id from the API journal')
      print(await apiRequest(options, { method: 'POST', path: '/v1/ack', signal,
        body: { workspace: path.resolve(parsed.cwd ?? process.cwd()), id, reject: parsed.reject ?? false, note: parsed.note ?? '' } }))
      return 0
    }
    default: throw new UsageError(`unknown command ${parsed.command}\n\n${HELP}`)
  }
}

/** Stable command plugin name. */
export const name = 'deep-cluster-command'
/** Launcher arguments; execution belongs to the independently running API server. */
export const inject = ['cmdlineArgs', 'subprocess']

/**
 * Register the HTTP command adapter and await cancellation confirmation on disposal.
 * @param ctx - supported DSH launcher context.
 */
export function apply(ctx: Context): void {
  const args = ctx.get('cmdlineArgs')
  const exit = ctx.get('appExit')
  const ready = ctx.get('appReady')
  const subprocess = ctx.get('subprocess')
  if (args === undefined || exit === undefined || ready === undefined || subprocess === undefined) throw new Error('DeepCluster requires the dsh launcher and subprocess provider')
  const abort = new AbortController()
  let work: Promise<void> | undefined
  ctx.effect(() => {
    const cancelReady = ready.onReady(() => {
      work = main(args.get(), abort.signal, subprocess).then(exit, (error: unknown) => {
        process.stderr.write(`deep-cluster: ${error instanceof Error ? error.message : String(error)}\n`)
        exit(error instanceof UsageError ? 2 : 1)
      })
    })
    return async () => { cancelReady(); abort.abort(); await work }
  }, 'DeepCluster HTTP command requests')
}
