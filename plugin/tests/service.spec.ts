/** Persistent service lifecycle: ownership, private URL capture, verified stop, and rollback. */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { resolveOptions } from '../src/assets.ts'
import { masterDirectory } from '../src/master.ts'
import { apiStateDirectory, boundedWaitFor, classifyPortListeners, dashboardProofValid, diagnoseApiLock, inspectPort,
  readServiceState, recoverApiLock, saveServiceState, scheduledTaskScript, serviceDirectory, serviceLauncherScript,
  servicePatchFiles, ServicePortError, serviceStatePath, serviceStatusExitCode, serviceTaskName, ServiceLifecycle,
  startupUrlOf, runServiceCommand, verifyDashboard, windowsServiceEffects,
  type ApiLockDiagnosis, type DashboardProof, type LoginUrl, type OwnedService, type PortListener, type ServiceEffects,
  type ServiceHealth, type ServiceOwner, type ServiceState } from '../src/service.ts'

interface FakeOwner extends ServiceOwner {}

/** Injected host: records launches and never owns a child of the controller. */
class FakeHost implements ServiceEffects {
  readonly apiEndpoint = 'http://127.0.0.1:47890'
  readonly dashboardEndpoint = 'http://127.0.0.1:47891'
  apiOwner: FakeOwner | null = null
  dashboardOwner: FakeOwner | null = null
  health: ServiceHealth | null = null
  proof: DashboardProof | null = null
  login: LoginUrl | null = null
  lock = false
  readonly starts: string[] = []
  shutdowns = 0
  readonly shutdownConfirmations: boolean[] = []
  endedDashboards = 0
  readonly endedDashboardOwners: (ServiceOwner | null)[] = []
  failApiStart: Error | null = null
  failDashboardEnd: Error | null = null
  surviveDashboardEnd = false
  transientVerificationFailures = 0
  diagnosis: ApiLockDiagnosis | null = null

  async inspectApi(): Promise<{ owner: ServiceOwner | null; health: ServiceHealth | null }> {
    return { owner: this.apiOwner, health: this.health }
  }
  async inspectDashboard(): Promise<{ owner: ServiceOwner | null; proof: DashboardProof | null }> {
    return { owner: this.dashboardOwner, proof: this.proof }
  }
  async apiLockExists(): Promise<boolean> { return this.lock }
  async diagnoseApiLock(): Promise<ApiLockDiagnosis> {
    if (this.diagnosis === null) throw new Error('no diagnosis fixture')
    return this.diagnosis
  }
  async startApi(): Promise<void> {
    this.starts.push('api')
    if (this.failApiStart !== null) throw this.failApiStart
    this.apiOwner = { pid: 4801, startTime: '2026-01-01T00:00:00.000Z', commandLine: 'node apps/cli/src/bin.ts --profile deep-cluster --patch api.patch.yml' }
    this.health = { status: 'ready', activeRuns: 0 }
    this.lock = true
  }
  async startDashboard(): Promise<void> {
    this.starts.push('dashboard')
    this.dashboardOwner = { pid: 4802, startTime: '2026-01-01T00:00:01.000Z', commandLine: 'node apps/cli/src/bin.ts web --port 47891' }
    this.login = { url: 'http://127.0.0.1:47891/?token=secret-launch-token', file: 'C:/private/runs/1/startup-url.txt' }
    this.proof = { authenticatedHtml: true, clientBoot: true, snapshot: true }
  }
  async requestApiShutdown(options: { confirmCleanupUnconfirmed?: boolean } = {}): Promise<void> {
    this.shutdowns += 1
    this.shutdownConfirmations.push(options.confirmCleanupUnconfirmed === true)
    this.apiOwner = null
    this.health = null
    this.lock = false
  }
  async endDashboard(owner: ServiceOwner | null): Promise<void> {
    this.endedDashboards += 1
    this.endedDashboardOwners.push(owner)
    if (this.failDashboardEnd !== null) throw this.failDashboardEnd
    if (this.surviveDashboardEnd) return
    this.dashboardOwner = null
    this.proof = null
  }
  async readLoginUrl(): Promise<LoginUrl | null> { return this.login }
  async verifyDashboard(url: string): Promise<DashboardProof | null> {
    if (this.transientVerificationFailures > 0) {
      this.transientVerificationFailures -= 1
      throw new Error('transient fetch failure')
    }
    return url === this.login?.url ? this.proof : null
  }  async waitFor<T>(read: () => Promise<T | null>, _timeoutMs: number, attempts = 3): Promise<T | null> {
    for (let index = 0; index < attempts; index += 1) {
      try {
        const value = await read()
        if (value !== null) return value
      } catch { /* retry like the production loop */ }
    }
    return null
  }
}

function lifecycle(host: FakeHost, states: ServiceState[]): ServiceLifecycle {
  return new ServiceLifecycle(host, async () => states.at(-1) ?? emptyState(), async (state) => { states.push(state) }, 100)
}

function emptyState(): ServiceState {
  return { version: 1, api: null, dashboard: null, loginUrlFile: null, updatedAt: '2026-01-01T00:00:00.000Z' }
}

function owned(pid: number, startTime: string, commandLine: string): OwnedService { return { pid, startTime, commandLine } }

it('verifies a healthy saved stack without recovery, ownership writes, or service mutations', async () => {
  const host = new FakeHost(), states = [emptyState()], controller = lifecycle(host, states)
  await controller.start()
  const saved = states.length
  host.starts.length = 0
  const prepare = vi.fn(async () => { throw new Error('historical recovery must not run during reuse') })
  Object.assign(host, { prepareStart: prepare,
    inspectDashboardReadOnly: async () => ({ owner: host.dashboardOwner, proof: host.proof }) })
  vi.spyOn(host, 'inspectDashboard').mockRejectedValue(new Error('reuse must not capture a login URL'))
  expect(await controller.healthyStatus()).toMatchObject({ api: { health: { status: 'ready' } } })
  expect(prepare).not.toHaveBeenCalled()
  expect(states).toHaveLength(saved)
  expect(host.starts).toEqual([])
  host.apiOwner = { ...host.apiOwner!, startTime: '2026-01-02T00:00:00.000Z' }
  expect(await controller.healthyStatus()).toBeNull()
  expect(host.shutdowns).toBe(0)
})

it('launches both services once and survives the launching worker, reusing the healthy owner', async () => {
  const host = new FakeHost(), states = [emptyState()], controller = lifecycle(host, states)
  const first = await controller.start()
  expect(host.starts).toEqual(['api', 'dashboard'])
  expect(first.api).toEqual(owned(4801, '2026-01-01T00:00:00.000Z', 'node apps/cli/src/bin.ts --profile deep-cluster --patch api.patch.yml'))
  expect(first.dashboard).toEqual(owned(4802, '2026-01-01T00:00:01.000Z', 'node apps/cli/src/bin.ts web --port 47891'))
  // The controller holds no child and performs no teardown when the launching worker exits.
  expect(host.apiOwner?.pid).toBe(4801)
  expect(host.endedDashboards).toBe(0)

  const second = await controller.start()
  expect(host.starts).toEqual(['api', 'dashboard'])
  expect(second.api).toEqual(first.api)
})

it('records the captured startup URL privately and keeps the token out of the service report', async () => {
  const host = new FakeHost(), states = [emptyState()], controller = lifecycle(host, states)
  const report = await runServiceCommand(controller, 'start')
  expect(states.at(-1)?.loginUrlFile).toBe('C:/private/runs/1/startup-url.txt')
  expect(report.loginUrlFile).toBe('C:/private/runs/1/startup-url.txt')
  expect(JSON.stringify(report)).not.toContain('secret-launch-token')
  expect(host.login?.url).toContain('token=secret-launch-token')
})

it.each(['absent', 'stale'] as const)('reconciles a healthy API from its exact lock when saved service ownership is %s', async (saved) => {
  const host = new FakeHost(), api = ownedApi()
  const states = [saved === 'absent' ? emptyState() : serviceState({ ...api, startTime: '2025-12-01T00:00:00.000Z' })]
  host.apiOwner = api
  host.health = { status: 'ready', activeRuns: 1 }
  host.lock = true
  host.diagnosis = { lockFile: 'fixture/api-owner.lock', lock: { owner: 'api-owner', pid: api.pid, startTime: api.startTime },
    recordedOwner: api, livePortOwner: api, recordedProcess: api, interruptedOperations: [], operationScanTruncated: false,
    retainedLeases: { inspected: true, leaseRoot: 'fixture', entries: [] }, recoveryProof: 'unavailable',
    expectedOwner: { owner: 'api-owner', pid: api.pid, startTime: api.startTime }, verdict: 'healthy',
    detail: 'matching API lock identity', recoveryCommand: null }
  const started = await lifecycle(host, states).start()
  expect(started.api).toEqual(api)
  expect(states.at(-1)?.api).toEqual(api)
  expect(host.starts).toEqual(['dashboard'])
  expect(host.shutdowns).toBe(0)
  expect(host.health.activeRuns).toBe(1)
})

it('retries a transient dashboard verification failure instead of aborting the start', async () => {
  const host = new FakeHost(), states = [emptyState()]
  host.transientVerificationFailures = 1
  const started = await lifecycle(host, states).start()
  expect(started.dashboard?.pid).toBe(4802)
  expect(host.transientVerificationFailures).toBe(0)
})

it('rolls back the recorded API owner when the dashboard never exposes a URL', async () => {
  const host = new FakeHost(), states = [emptyState()]
  host.startDashboard = async (): Promise<void> => { host.starts.push('dashboard') }
  await expect(lifecycle(host, states).start()).rejects.toThrow('private startup URL')
  expect(host.shutdowns).toBe(1)
  expect(host.endedDashboardOwners).toEqual([null])
  expect(states.at(-1)).toMatchObject({ api: null, dashboard: null, loginUrlFile: null })
})

it('refuses startup while an unverifiable API ownership lock exists', async () => {
  const host = new FakeHost(), states = [emptyState()]
  host.lock = true
  await expect(lifecycle(host, states).start()).rejects.toThrow('Do not delete the lock')
  expect(host.starts).toEqual([])
})

it('surfaces a native task launch failure instead of waiting for readiness', async () => {
  const host = new FakeHost(), states = [emptyState()]
  host.failApiStart = new Error('PowerShell command failed with exit 1: ERROR: The task name is invalid.')
  await expect(lifecycle(host, states).start()).rejects.toThrow('PowerShell command failed with exit 1')
  expect(host.starts).toEqual(['api'])
  expect(states.at(-1)?.api).toBeNull()
})

it('rechecks and recovers a machine-proven idle lock before starting once', async () => {
  const host = new FakeHost(), states = [serviceState(ownedApi())]
  host.lock = true
  host.diagnosis = { lockFile: 'fixture/api-owner.lock', lock: { owner: 'idle-owner', pid: 4801 },
    recordedOwner: ownedApi(), livePortOwner: null, recordedProcess: null, interruptedOperations: [],
    operationScanTruncated: false, retainedLeases: { inspected: true, leaseRoot: 'fixture', entries: [] },
    recoveryProof: 'machine-proven', expectedOwner: { owner: 'idle-owner', pid: 4801 }, verdict: 'stale',
    detail: 'idle fixture', recoveryCommand: 'service recover' }
  const recovery = vi.fn(async () => {
    host.lock = false
    host.diagnosis = null
    return { recovered: true as const, quarantineFile: 'fixture/quarantined', proof: 'machine-proven' as const,
      expectedOwner: { owner: 'idle-owner', pid: 4801 }, detail: 'fixture quarantined' }
  })
  Object.assign(host, { recoverIdleApiLock: recovery })
  const controller = lifecycle(host, states)
  await controller.start(); await controller.start()
  expect(recovery).toHaveBeenCalledTimes(1)
  expect(host.starts).toEqual(['api', 'dashboard'])
})

it('refuses shutdown while the API reports active runs and preserves state', async () => {
  const host = new FakeHost(), states = [emptyState()], controller = lifecycle(host, states)
  await controller.start()
  const before = states.at(-1)
  host.health = { status: 'ready', activeRuns: 2 }
  await expect(controller.stop()).rejects.toThrow('2 active run(s)')
  expect(host.shutdowns).toBe(0)
  expect(states.at(-1)).toEqual(before)
})

it('refuses stop while descendant cleanup is unconfirmed and forwards only explicit confirmation', async () => {
  const host = new FakeHost(), states = [emptyState()], controller = lifecycle(host, states)
  await controller.start()
  const before = states.at(-1)
  host.health = { status: 'ready', activeRuns: 0, cleanupUnconfirmed: 1 }
  await expect(controller.stop()).rejects.toThrow('--confirm-cleanup-unconfirmed')
  expect(host.shutdowns).toBe(0)
  expect(states.at(-1)).toEqual(before)
  await controller.stop({ confirmCleanupUnconfirmed: true })
  expect(host.shutdownConfirmations).toEqual([true])
  expect(host.shutdowns).toBe(1)
})

it('fails stop and preserves ownership when the dashboard survives the scheduled-task end', async () => {
  const host = new FakeHost(), states = [emptyState()], controller = lifecycle(host, states)
  await controller.start()
  const before = states.at(-1)
  host.surviveDashboardEnd = true
  await expect(controller.stop()).rejects.toThrow('did not release its listener')
  expect(host.shutdowns).toBe(0)
  expect(states.at(-1)).toEqual(before)
  expect(states.at(-1)?.dashboard?.pid).toBe(4802)
})

it('surfaces a native scheduled-task end failure and preserves ownership', async () => {
  const host = new FakeHost(), states = [emptyState()], controller = lifecycle(host, states)
  await controller.start()
  const before = states.at(-1)
  host.failDashboardEnd = new Error('PowerShell command failed with exit 1: ERROR: The system cannot find the file specified.')
  await expect(controller.stop()).rejects.toThrow('cannot find the file')
  expect(states.at(-1)).toEqual(before)
})

it('refuses to stop an owner whose command line does not match the recorded identity', async () => {
  const host = new FakeHost(), states = [emptyState()]
  host.apiOwner = { pid: 4801, startTime: '2026-01-01T00:00:00.000Z', commandLine: 'node C:/other/api.js' }
  host.health = { status: 'ready', activeRuns: 0 }
  host.lock = true
  states.push({ ...emptyState(), api: owned(4801, '2026-01-01T00:00:00.000Z', 'node apps/cli/src/bin.ts --profile deep-cluster --patch api.patch.yml') })
  await expect(lifecycle(host, states).stop()).rejects.toThrow('no matching DeepCluster ownership record')
  expect(host.shutdowns).toBe(0)
})

it('stops recorded owners through graceful shutdown and clears ownership only after both ports close', async () => {
  const host = new FakeHost(), states = [emptyState()], controller = lifecycle(host, states)
  await controller.start()
  const status = await controller.stop()
  expect(host.shutdowns).toBe(1)
  expect(host.endedDashboards).toBe(1)
  expect(host.endedDashboardOwners).toEqual([{ pid: 4802, startTime: '2026-01-01T00:00:01.000Z',
    commandLine: 'node apps/cli/src/bin.ts web --port 47891' }])
  expect(status.api.owner).toBeNull()
  expect(status.dashboard.owner).toBeNull()
  expect(states.at(-1)).toMatchObject({ api: null, dashboard: null, loginUrlFile: null })
})

it('namespaces scheduled tasks by endpoint port so isolated controllers cannot collide', () => {
  expect(serviceTaskName('api', 47890)).toBe('DeepCluster API 47890')
  expect(serviceTaskName('dashboard', 47891)).toBe('DeepCluster Dashboard 47891')
  expect(serviceTaskName('api', 47890)).not.toBe(serviceTaskName('api', 3789))
})

it('registers a hidden, unlimited scheduled task that starts on demand and on battery', () => {
  const script = scheduledTaskScript('DeepCluster API 47890', 'C:\\state\\start-api-47890.cmd')
  expect(script).toContain("Join-Path $env:SystemRoot 'System32\\conhost.exe'")
  expect(script).toContain('--headless cmd.exe /d /c "C:\\state\\start-api-47890.cmd"')
  expect(script).toContain('-AllowStartIfOnBatteries')
  expect(script).toContain('-DontStopIfGoingOnBatteries')
  expect(script).toContain('-ExecutionTimeLimit ([TimeSpan]::Zero)')
  expect(script).toContain("-TaskName 'DeepCluster API 47890'")
  expect(script).toContain('Register-ScheduledTask')
  expect(script).toContain('$registered.Run($null)')
  expect(script).toContain('$instance.InstanceGuid')
  expect(script).toContain('-LogonType Interactive')
  expect(script).not.toContain('-Trigger')
})

it('resolves the master directory and service state from the saved DSH checkout', async () => {
  const root = await scratch()
  for (const name of ['DEEPCLUSTER_SERVICE_DIRECTORY', 'DEEPCLUSTER_API_STATE_DIRECTORY']) {
    const previous = process.env[name]
    Reflect.deleteProperty(process.env, name)
    onTestFinished(() => { if (previous !== undefined) process.env[name] = previous })
  }
  expect(masterDirectory(root)).toBe(path.join(root, '.deep-cluster', 'service-state'))
  expect(() => masterDirectory(undefined)).toThrow(/saved dshPath/u)
  expect(serviceDirectory(root)).toBe(path.join(masterDirectory(root), 'service'))
  expect(apiStateDirectory(root)).toBe(path.join(masterDirectory(root), 'api-state'))
  expect(serviceStatePath(root)).toBe(path.join(masterDirectory(root), 'service', 'service.json'))
  const state: ServiceState = { version: 1, api: null, dashboard: null, loginUrlFile: null,
    updatedAt: '2026-01-01T00:00:00.000Z' }
  await saveServiceState(root, state)
  expect(await readServiceState(root)).toEqual(state)
  await expect(readServiceState(path.join(root, 'missing'))).resolves.toMatchObject({ api: null, dashboard: null, loginUrlFile: null })
})

it('extracts the fresh tokenized URL from launcher output and ignores unrelated lines', () => {
  const output = [
    'dsh web: http://127.0.0.1:47891/?token=old',
    'some other line',
    'dsh web: http://127.0.0.1:47891/?token=fresh',
  ].join('\n')
  expect(startupUrlOf(output)).toBe('http://127.0.0.1:47891/?token=fresh')
  expect(startupUrlOf('dsh web: opening the default browser; pass --no-open to disable')).toBeNull()
})

it('reports an unready status as a failing exit code', async () => {
  const host = new FakeHost(), states = [emptyState()]
  host.apiOwner = { pid: 9, startTime: '2026-01-01T00:00:00.000Z', commandLine: 'node unknown' }
  host.health = { status: 'starting', activeRuns: 0 }
  host.dashboardOwner = { pid: 10, startTime: '2026-01-01T00:00:00.000Z', commandLine: 'node unknown' }
  const report = await runServiceCommand(lifecycle(host, states), 'status')
  expect(report.ok).toBe(false)
  expect(serviceStatusExitCode(report)).toBe(1)
})

/** Decode a recorded dashboard request body that the fetch stub always writes as JSON text. */
function requestBody(init: RequestInit | undefined): unknown {
  const body = init?.body
  if (typeof body !== 'string') throw new Error('dashboard request body is not JSON text')
  return JSON.parse(body)
}

/** Read the request correlation id the dashboard gateway must echo. */
function requestRpcId(init: RequestInit | undefined): string {
  const body = requestBody(init)
  if (typeof body !== 'object' || body === null || !('rpcId' in body) || typeof body.rpcId !== 'string') {
    throw new Error('dashboard request body has no string rpcId')
  }
  return body.rpcId
}

it('verifies the gateway request envelope and reads result.ok/result.value, not a bare snapshot', async () => {
  const html = '<div id="root"></div><script type="module" src="/plugins/??@deepseek-ai/dsh-experimental-deep-cluster/client.js&amp;rev=1"></script>'
  const reply = (body: unknown, headers: Record<string, string> = {}): Response => new Response(JSON.stringify(body),
    { status: 200, headers: { 'content-type': 'application/json', ...headers } })
  const requests: Array<{ url: string; init?: RequestInit }> = []
  vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit): Promise<Response> => {
    requests.push({ url: String(url), ...init === undefined ? {} : { init } })
    if (requests.length === 1) return new Response('', { status: 303, headers: { 'set-cookie': 'dsh=1; Path=/' } })
    if (requests.length === 2) return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } })
    const sent = requestRpcId(init)
    return reply({ type: 'server-response', rpcId: sent, result: { ok: true, value: { workspace: 'D:/w', runs: [] } } })
  })
  onTestFinished(() => { vi.unstubAllGlobals() })
  const proof = await verifyDashboard('http://127.0.0.1:47891/?token=secret')
  expect(proof).toEqual({ authenticatedHtml: true, clientBoot: true, snapshot: true })
  const body: unknown = requestBody(requests[2]?.init)
  expect(body).toMatchObject({ type: 'client-request', method: 'deepClusterDashboard/snapshot', payload: { args: {} } })
  expect(typeof (body as { rpcId?: unknown }).rpcId).toBe('string')

  vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit): Promise<Response> => {
    requests.push({ url: String(url), ...init === undefined ? {} : { init } })
    if (requests.length % 3 === 1) return new Response('', { status: 303, headers: { 'set-cookie': 'dsh=1; Path=/' } })
    if (requests.length % 3 === 2) return new Response(html, { status: 200 })
    return reply({ workspace: 'D:/w', runs: [] })
  })
  expect((await verifyDashboard('http://127.0.0.1:47891/?token=secret'))?.snapshot).toBe(false)
})

async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'deep-cluster-service-'))
  onTestFinished(async () => { await rm(dir, { recursive: true, force: true }) })
  return dir
}

it('requires every dashboard proof field before reuse or a successful status', async () => {
  const host = new FakeHost(), states = [emptyState()], controller = lifecycle(host, states)
  await controller.start()
  const before = host.starts.slice()
  host.proof = { authenticatedHtml: true, clientBoot: false, snapshot: true }
  const report = await runServiceCommand(controller, 'status')
  expect(report.ok).toBe(false)
  await expect(controller.start()).rejects.toThrow(/browser client/u)
  expect(host.starts).toEqual(before)
  expect(dashboardProofValid(null)).toBe(false)
  expect(dashboardProofValid(host.proof)).toBe(false)
  expect(dashboardProofValid({ authenticatedHtml: true, clientBoot: true, snapshot: true })).toBe(true)
})

it('reports a foreign non-loopback listener before launching the API', async () => {
  const owner = { pid: 9, startTime: '2026-01-01T00:00:00.000Z', commandLine: 'node foreign.js' }
  const foreign: PortListener = { ...owner, address: '0.0.0.0', loopback: false }
  expect(() => classifyPortListeners(47890, [foreign])).toThrow(ServicePortError)
  await expect(inspectPort(47890, async () => [foreign])).rejects.toThrow(/outside loopback.*PID 9/u)
  const loop = (pid: number, address = '127.0.0.1'): PortListener => ({
    pid, startTime: 'start', commandLine: 'command', address, loopback: true,
  })
  expect(classifyPortListeners(47890, [])).toBeNull()
  expect(classifyPortListeners(47890, [loop(1), loop(1, '::1')])).toEqual({ pid: 1, startTime: 'start', commandLine: 'command' })
  expect(() => classifyPortListeners(47890, [loop(1), loop(2)])).toThrow(/Multiple loopback owners/u)

  const host = new FakeHost(), states = [emptyState()]
  host.inspectApi = async () => { throw new ServicePortError('foreign-listener', 'Port 47890 is bound outside loopback by PID 9') }
  await expect(lifecycle(host, states).start()).rejects.toThrow(/outside loopback/u)
  expect(host.starts).toEqual([])
})

it('bounds every probe so a hanging listener cannot hold startup or shutdown', async () => {
  const started = Date.now()
  expect(await boundedWaitFor(() => new Promise<null>(() => {}), 120, 20)).toBeNull()
  expect(Date.now() - started).toBeLessThan(2000)
  let attempts = 0
  expect(await boundedWaitFor(async () => {
    attempts++
    if (attempts < 3) throw new Error('transient')
    return 'ready'
  }, 5000, 100)).toBe('ready')

  const server = createServer((_request, _response) => { /* accept and never answer */ })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  onTestFinished(() => { server.closeAllConnections(); server.close() })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture requires a TCP listener')
  const hanging = `http://127.0.0.1:${address.port}/?token=secret`
  const hangStarted = Date.now()
  await expect(verifyDashboard(hanging, AbortSignal.timeout(100))).rejects.toThrow()
  expect(Date.now() - hangStarted).toBeLessThan(3000)
})

it('builds the launcher from the installed package and configured CLI without monorepo paths', async () => {
  const root = await scratch()
  const previousLeaseRoot = process.env.DEEPCLUSTER_API_LEASE_ROOT
  delete process.env.DEEPCLUSTER_API_LEASE_ROOT
  onTestFinished(() => { if (previousLeaseRoot !== undefined) process.env.DEEPCLUSTER_API_LEASE_ROOT = previousLeaseRoot })
  const cli = path.join(root, 'apps', 'cli', 'lib', 'bin.js')
  await mkdir(path.dirname(cli), { recursive: true })
  await writeFile(cli, '', 'utf8')
  const options = resolveOptions({ dshPath: root, cliPath: cli, apiEndpoint: 'http://127.0.0.1:47890',
    dashboardEndpoint: 'http://127.0.0.1:47891' })
  const patches = servicePatchFiles()
  expect(existsSync(patches.api)).toBe(true)
  expect(existsSync(patches.web)).toBe(true)
  const context = { kind: 'api' as const, logFile: path.join(root, 'api.log'),
    stateDirectory: path.join(root, 'state'), apiPort: 47890, dashboardPort: 47891, dashboardWorkspace: root }
  const api = serviceLauncherScript(options, context)
  expect(api).toContain(patches.api)
  expect(api).toContain('--profile deep-cluster')
  expect(api).toContain(process.execPath)
  expect(api).toContain(`set "DEEPCLUSTER_API_LEASE_ROOT=${masterDirectory(root)}"`)
  expect(api).not.toContain('pnpm')
  expect(api).toContain(cli)
  const web = serviceLauncherScript(options, { ...context, kind: 'dashboard' })
  expect(web).toContain(patches.web)
  expect(web).toContain('--profile web')
  expect(web).toContain('--no-open')
  expect(web).toContain('--port 47891')
  expect(web).toContain(`set "DEEPCLUSTER_WORKSPACE=${root}"`)
  expect(() => serviceLauncherScript(resolveOptions({ dshPath: root, cliPath: 'C:\\tools\\dsh.cmd' }), context))
    .toThrow(/batch shim/u)
})

it('uses serviceCliPath for both persistent services and keeps the worker wrapper out of their scripts', async () => {
  const root = await scratch()
  const serviceCli = path.join(root, 'apps', 'cli', 'lib', 'bin.js')
  await mkdir(path.dirname(serviceCli), { recursive: true })
  await writeFile(serviceCli, '', 'utf8')
  const workerWrapper = 'C:\\tools\\worker-wrapper.exe'
  const options = resolveOptions({ dshPath: root, cliPath: workerWrapper, serviceCliPath: serviceCli,
    apiEndpoint: 'http://127.0.0.1:47890', dashboardEndpoint: 'http://127.0.0.1:47891' })
  const context = { kind: 'api' as const, logFile: path.join(root, 'api.log'),
    stateDirectory: path.join(root, 'state'), apiPort: 47890, dashboardPort: 47891, dashboardWorkspace: root }
  for (const kind of ['api', 'dashboard'] as const) {
    const script = serviceLauncherScript(options, { ...context, kind })
    expect(script).toContain(process.execPath)
    expect(script).toContain(serviceCli)
    expect(script).not.toContain(workerWrapper)
    expect(script).toContain(kind === 'api' ? '--profile deep-cluster' : '--profile web')
  }
})

it('falls back to cliPath for the service only when serviceCliPath is absent', async () => {
  const root = await scratch()
  const cli = path.join(root, 'apps', 'cli', 'lib', 'bin.js')
  await mkdir(path.dirname(cli), { recursive: true })
  await writeFile(cli, '', 'utf8')
  const options = resolveOptions({ dshPath: root, cliPath: cli, apiEndpoint: 'http://127.0.0.1:47890',
    dashboardEndpoint: 'http://127.0.0.1:47891' })
  const context = { kind: 'api' as const, logFile: path.join(root, 'api.log'),
    stateDirectory: path.join(root, 'state'), apiPort: 47890, dashboardPort: 47891, dashboardWorkspace: root }
  expect(serviceLauncherScript(options, context)).toContain(cli)
  expect(serviceLauncherScript(options, { ...context, kind: 'dashboard' })).toContain(cli)
})

it('validates the service launcher independently of the worker wrapper', async () => {
  const root = await scratch()
  const options = resolveOptions({ dshPath: root, cliPath: 'C:\\tools\\worker-wrapper.cmd',
    serviceCliPath: 'C:\\tools\\dsh.exe', apiEndpoint: 'http://127.0.0.1:47890' })
  expect(() => windowsServiceEffects(options, undefined, 'win32')).not.toThrow()
  const invalid = resolveOptions({ dshPath: root, cliPath: 'C:\\tools\\worker-wrapper.exe',
    serviceCliPath: 'C:\\tools\\dsh.cmd', apiEndpoint: 'http://127.0.0.1:47890' })
  expect(() => windowsServiceEffects(invalid, undefined, 'win32')).toThrow(/serviceCliPath.*batch shim/u)
})

it('fails an unsupported service platform before creating service files', async () => {
  const root = await scratch()
  const directory = path.join(root, 'service')
  vi.stubEnv('DEEPCLUSTER_SERVICE_DIRECTORY', directory)
  onTestFinished(() => { vi.unstubAllEnvs() })
  const options = resolveOptions({ dshPath: root, apiEndpoint: 'http://127.0.0.1:47890' })
  expect(() => windowsServiceEffects(options, undefined, 'linux')).toThrow(/Windows only/u)
  expect(existsSync(directory)).toBe(false)
})

function ownedApi(pid = 4801, startTime = '2026-01-01T00:00:00.000Z'): OwnedService {
  return { pid, startTime, commandLine: 'node api.js' }
}

function serviceState(api: OwnedService | null): ServiceState {
  return { version: 1, api, dashboard: null, loginUrlFile: null, updatedAt: '2026-01-01T00:00:00.000Z' }
}

it('diagnoses and quarantines only a proven stale API lock, preserving operation records', async () => {
  const root = await scratch(), stateDirectory = path.join(root, 'state')
  await mkdir(path.join(stateDirectory, 'operations'), { recursive: true })
  const lockFile = path.join(stateDirectory, 'api-owner.lock')
  const owner = ownedApi()
  await writeFile(lockFile, JSON.stringify({ owner: 'lock-owner', pid: owner.pid, startTime: owner.startTime }), 'utf8')
  const interrupted = { operationId: '11111111-1111-4111-8111-111111111111', status: 'interrupted',
    updatedAt: '2026-01-01T00:00:00.000Z', ownerPid: owner.pid, ownerStartTime: owner.startTime }
  await writeFile(path.join(stateDirectory, 'operations', 'interrupted.json'), JSON.stringify(interrupted), 'utf8')
  const options = resolveOptions({ apiEndpoint: 'http://127.0.0.1:47890' })
  const dependencies = {
    stateDirectory,
    readState: async () => serviceState(owner),
    inspectPort: async () => null,
    inspectProcess: async () => null,
    inspectBoot: async () => null,
  }
  const diagnosis = await diagnoseApiLock(options, dependencies)
  expect(diagnosis).toMatchObject({ verdict: 'stale', recoveryCommand: 'service recover',
    recoveryProof: 'operator-confirmation-required', expectedOwner: { owner: 'lock-owner', pid: owner.pid } })
  expect(diagnosis.detail).toContain('operator confirmation')
  expect(diagnosis.interruptedOperations.map(operation => operation.status)).toEqual(['interrupted'])
  expect(await readFile(lockFile, 'utf8')).toContain('lock-owner')
  await expect(recoverApiLock(options, dependencies)).rejects.toThrow(/automatic recovery|explicit operator/u)
  expect(await readFile(lockFile, 'utf8')).toContain('lock-owner')
  const recovered = await recoverApiLock(options, dependencies, { confirmOwner: 'lock-owner' })
  expect(recovered.recovered).toBe(true)
  expect(recovered.proof).toBe('operator-confirmed')
  expect(recovered.detail).toContain('operator-confirmed')
  await expect(readFile(lockFile)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(recovered.quarantineFile, 'utf8')).toContain('lock-owner')
  expect(await readFile(path.join(stateDirectory, 'operations', 'interrupted.json'), 'utf8')).toContain('interrupted')
})

it('inspects all retained records without accepting malformed history as idle proof', async () => {
  const root = await scratch(), stateDirectory = path.join(root, 'state'), operations = path.join(stateDirectory, 'operations')
  await mkdir(operations, { recursive: true })
  const owner = ownedApi()
  await writeFile(path.join(stateDirectory, 'api-owner.lock'),
    JSON.stringify({ owner: 'lock-owner', pid: owner.pid, startTime: owner.startTime }), 'utf8')
  await Promise.all(Array.from({ length: 1001 }, async (_unused, index) => {
    await writeFile(path.join(operations, `${String(index).padStart(4, '0')}.json`), JSON.stringify({
      operationId: `operation-${String(index)}`, status: 'completed', updatedAt: '2026-01-01T00:00:00.000Z',
    }), 'utf8')
  }))
  const options = resolveOptions({ apiEndpoint: 'http://127.0.0.1:47890' })
  const dependencies = { stateDirectory, readState: async () => serviceState(owner),
    inspectPort: async () => null, inspectProcess: async () => null, inspectBoot: async () => null }
  const diagnosis = await diagnoseApiLock(options, dependencies)
  expect(diagnosis).toMatchObject({ verdict: 'stale', operationScanTruncated: false,
    recoveryProof: 'operator-confirmation-required', recoveryCommand: 'service recover' })
  await expect(recoverApiLock(options, dependencies)).rejects.toThrow(/Refusing automatic recovery/u)
  expect(await readFile(path.join(stateDirectory, 'api-owner.lock'), 'utf8')).toContain('lock-owner')
})

it('never restores a replacement over a fresh lock and refuses a second recovery fence', async () => {
  const root = await scratch(), stateDirectory = path.join(root, 'state')
  await mkdir(stateDirectory, { recursive: true })
  const lockFile = path.join(stateDirectory, 'api-owner.lock')
  const owner = ownedApi()
  await writeFile(lockFile, JSON.stringify({ owner: 'lock-owner', pid: owner.pid, startTime: owner.startTime }), 'utf8')
  const options = resolveOptions({ apiEndpoint: 'http://127.0.0.1:47890' })
  let ports = 0
  const dependencies = {
    stateDirectory, readState: async () => serviceState(owner),
    inspectPort: async () => {
      ports++
      if (ports === 2) {
        await writeFile(lockFile, JSON.stringify({ owner: 'fresh-owner', pid: 7777, startTime: 'fresh' }), 'utf8')
      }
      return null
    },
    inspectProcess: async () => null,
  }
  await expect(recoverApiLock(options, dependencies, { confirmOwner: 'lock-owner' }))
    .rejects.toThrow(/changed during diagnosis/u)
  expect(await readFile(lockFile, 'utf8')).toContain('fresh-owner')

  await writeFile(lockFile, JSON.stringify({ owner: 'lock-owner', pid: owner.pid, startTime: owner.startTime }), 'utf8')
  await writeFile(path.join(stateDirectory, 'api-owner.recovery'), '{}', 'utf8')
  await expect(recoverApiLock(options, { stateDirectory, readState: async () => serviceState(owner),
    inspectPort: async () => null, inspectProcess: async () => null }, { confirmOwner: 'lock-owner' }))
    .rejects.toThrow(/recovery fence/u)
  expect(await readFile(lockFile, 'utf8')).toContain('lock-owner')
})

it('preserves live owners and treats a start-time-qualified lock as authoritative', async () => {
  const root = await scratch(), stateDirectory = path.join(root, 'state')
  await mkdir(stateDirectory, { recursive: true })
  const lockFile = path.join(stateDirectory, 'api-owner.lock')
  const owner = ownedApi()
  await writeFile(lockFile, JSON.stringify({ owner: 'lock-owner', pid: owner.pid, startTime: owner.startTime }), 'utf8')
  const options = resolveOptions({ apiEndpoint: 'http://127.0.0.1:47890' })
  const base = { stateDirectory, readState: async () => serviceState(owner), inspectPort: async () => null,
    inspectBoot: async () => null }
  const live = await diagnoseApiLock(options, { ...base,
    inspectProcess: async pid => ({ pid, startTime: owner.startTime, commandLine: owner.commandLine }) })
  expect(live.verdict).toBe('live')
  await expect(recoverApiLock(options, { ...base,
    inspectProcess: async pid => ({ pid, startTime: owner.startTime, commandLine: owner.commandLine }) }))
    .rejects.toThrow(/Refusing to recover/u)
  expect(await readFile(lockFile, 'utf8')).toContain('lock-owner')

  const reused = await diagnoseApiLock(options, { ...base,
    inspectProcess: async pid => ({ pid, startTime: '2026-02-02T00:00:00.000Z', commandLine: 'other process' }) })
  expect(reused.verdict).toBe('stale')
  expect(reused.detail).toContain('reused')

  await writeFile(lockFile, JSON.stringify({ owner: 'lock-owner', pid: 9999, startTime: owner.startTime }), 'utf8')
  const mismatch = await diagnoseApiLock(options, { ...base, inspectProcess: async () => null })
  expect(mismatch.verdict).toBe('stale')
  await expect(recoverApiLock(options, { ...base, inspectProcess: async () => null })).rejects.toThrow(/Refusing automatic recovery/u)

  await writeFile(lockFile, JSON.stringify({ owner: 'lock-owner', pid: owner.pid, startTime: owner.startTime }), 'utf8')
  const operation = { operationId: '22222222-2222-4222-8222-222222222222', status: 'running',
    updatedAt: '2026-01-01T00:00:00.000Z', ownerPid: 5000, ownerStartTime: 'worker-start' }
  await mkdir(path.join(stateDirectory, 'operations'), { recursive: true })
  await writeFile(path.join(stateDirectory, 'operations', 'live.json'), JSON.stringify(operation), 'utf8')
  const activelyOwned = await diagnoseApiLock(options, { ...base,
    inspectProcess: async pid => pid === 5000 ? { pid, startTime: 'worker-start', commandLine: 'worker' } : null })
  expect(activelyOwned).toMatchObject({ verdict: 'live', recoveryCommand: null })
})

it('reports no lock as absent without changing state', async () => {
  const root = await scratch(), stateDirectory = path.join(root, 'state')
  await mkdir(stateDirectory, { recursive: true })
  const diagnosis = await diagnoseApiLock(resolveOptions({ apiEndpoint: 'http://127.0.0.1:47890' }), {
    stateDirectory, readState: async () => serviceState(null), inspectPort: async () => null, inspectProcess: async () => null,
  })
  expect(diagnosis).toMatchObject({ verdict: 'absent', lock: null, recoveryCommand: null })
})

it('includes read-only lock diagnosis in status and refuses stale start with the recovery command', async () => {
  const host = new FakeHost(), states = [emptyState()]
  host.lock = true
  const diagnosis: ApiLockDiagnosis = {
    lockFile: 'C:/private/state/api-owner.lock', lock: { owner: 'lock-owner', pid: 4801 },
    recordedOwner: { pid: 4801, startTime: '2026-01-01T00:00:00.000Z', commandLine: 'node api.js' },
    livePortOwner: null, recordedProcess: null, interruptedOperations: [], operationScanTruncated: false,
    retainedLeases: { inspected: false, reason: 'API-owned while down' },
    recoveryProof: 'operator-confirmation-required',
    expectedOwner: { owner: 'lock-owner', pid: 4801, startTime: '2026-01-01T00:00:00.000Z' },
    verdict: 'stale', detail: 'The recorded API owner is gone and the port is free.',
    recoveryCommand: 'service recover',
  }
  host.diagnosis = diagnosis
  const controller = lifecycle(host, states)
  const status = await controller.status()
  expect(status.lockDiagnosis).toEqual(diagnosis)
  await expect(controller.start()).rejects.toThrow(/recorded owner is stale.*service recover/u)
  expect(host.starts).toEqual([])
  expect(host.diagnosis).toBe(diagnosis)
})
