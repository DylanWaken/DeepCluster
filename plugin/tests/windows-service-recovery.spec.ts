/** Windows service observations preserve live owners and reject unrelated listeners. */
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { resolveOptions } from '../src/assets.ts'
import { createServiceLaunch, readServiceLaunch, type ServiceLaunchEvidence } from '../src/service-launch-recovery.ts'
import { withServiceMutationTransaction } from '../src/service-intent.ts'
import { serviceStatePath, serviceTaskName, windowsServiceEffects, type ServiceOwner } from '../src/service.ts'

const host = vi.hoisted(() => ({
  inspect: vi.fn<typeof import('../src/process-identity.ts').inspectProcessIdentity>(),
  powershell: vi.fn<typeof import('../src/process-identity.ts').runPowerShell>(),
  list: vi.fn<typeof import('../src/service-launch-recovery.ts').listServiceLaunches>(),
  evidence: vi.fn<typeof import('../src/service-launch-recovery.ts').readServiceLaunchEvidence>(),
  cancel: vi.fn<typeof import('../src/service-launch-recovery.ts').cancelServiceLaunch>(),
  record: vi.fn<typeof import('../src/service-launch-recovery.ts').recordServiceLaunchInstance>(),
  observe: vi.fn<typeof import('../src/service-task-observation.ts').observeServiceTask>(),
}))

vi.mock('../src/process-identity.ts', async original => ({
  ...await original<typeof import('../src/process-identity.ts')>(),
  inspectProcessIdentity: host.inspect,
  runPowerShell: host.powershell,
}))
vi.mock('../src/service-launch-recovery.ts', async original => ({
  ...await original<typeof import('../src/service-launch-recovery.ts')>(),
  listServiceLaunches: host.list,
  readServiceLaunchEvidence: host.evidence,
  cancelServiceLaunch: host.cancel,
  recordServiceLaunchInstance: host.record,
}))
vi.mock('../src/service-task-observation.ts', async original => ({
  ...await original<typeof import('../src/service-task-observation.ts')>(),
  observeServiceTask: host.observe,
}))

beforeEach(() => { vi.resetAllMocks() })

async function endpoint() {
  const requests: string[] = []
  let healthStatus = 503
  let healthBody: Record<string, unknown> = { status: 'ready', activeRuns: 2 }
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`)
    response.writeHead(request.url === '/v1/health' ? healthStatus : 200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(healthBody))
  })
  onTestFinished(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error === undefined) resolve(); else reject(error) })
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Missing fixture listener address')
  return { url: `http://127.0.0.1:${String(address.port)}`, port: address.port, requests,
    ready(body?: Record<string, unknown>) { healthStatus = 200; if (body !== undefined) healthBody = body } }
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'deepcluster-windows-service-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  vi.stubEnv('DEEPCLUSTER_SERVICE_DIRECTORY', path.join(root, 'service'))
  vi.stubEnv('DEEPCLUSTER_API_STATE_DIRECTORY', path.join(root, 'api-state'))
  vi.stubEnv('DEEPCLUSTER_API_LEASE_ROOT', path.join(root, 'ownership'))
  onTestFinished(() => { vi.unstubAllEnvs() })
  const api = await endpoint(), dashboard = await endpoint()
  const apiOwner: ServiceOwner = { pid: 4801, startTime: '2026-01-01T00:00:00.000Z', commandLine: 'fixture API' }
  const dashboardOwner: ServiceOwner = { pid: 4802, startTime: '2026-01-01T00:00:01.000Z', commandLine: 'fixture dashboard' }
  const controller: ServiceOwner = { pid: 4803, startTime: '2026-01-01T00:00:02.000Z', commandLine: 'fixture service host' }
  const owners = new Map<number, ServiceOwner>([[api.port, apiOwner], [dashboard.port, dashboardOwner]])
  const identities = new Map([apiOwner, dashboardOwner, controller].map(owner => [owner.pid, owner]))
  const evidence = new Map<string, ServiceLaunchEvidence>()
  const options = resolveOptions({ dshPath: root, cliPath: path.join(root, 'dsh.js'), apiEndpoint: api.url,
    dashboardEndpoint: dashboard.url, serviceLifecycleWaitMs: 1 })
  const recoverRange = vi.fn(async () => {})
  host.inspect.mockImplementation(async pid => identities.get(pid) ?? null)
  host.list.mockResolvedValue([])
  host.cancel.mockResolvedValue({ task: 'stopped', recovered: true })
  host.observe.mockResolvedValue('running')
  host.evidence.mockImplementation(async (file) => {
    const value = evidence.get(file)
    if (value === undefined) throw new Error(`Missing fixture launch evidence ${file}`)
    return value
  })
  host.record.mockImplementation(async (file) => {
    const launch = await readServiceLaunch(file)
    evidence.set(file, { launch, host: controller, owner: launch.kind === 'api' ? apiOwner : dashboardOwner,
      range: null, instanceId: null, cancelled: false, recovered: false, settled: false })
  })
  host.powershell.mockImplementation(async (script) => {
    if (script.includes('Get-NetTCPConnection')) {
      const port = Number(/\$_.LocalPort -eq (\d+)/u.exec(script)?.[1])
      const owner = owners.get(port)
      return owner === undefined ? '' : `OK|127.0.0.1|${String(owner.pid)}|${owner.startTime}|${owner.commandLine}`
    }
    if (script.includes('Register-ScheduledTask')) return randomUUID()
    if (script.includes('icacls.exe')) return ''
    throw new Error('Unexpected fixture PowerShell operation')
  })
  const effects = windowsServiceEffects(options, root, 'win32', { recoverRange })
  const mutate = async <T>(run: () => Promise<T>): Promise<T> =>
    withServiceMutationTransaction('fixture service mutation', run,
      { file: path.join(root, 'intent.json'), inspectController: async () => controller })
  return { root, api, dashboard, apiOwner, dashboardOwner, controller, owners, identities,
    evidence, options, effects, recoverRange, mutate }
}

// The production adapter deliberately rejects non-Windows hosts before any service effects.
it.skipIf(process.platform !== 'win32').each(['api', 'dashboard'] as const)(
  'preserves a saved live %s without probing failing readiness or cancelling its active range', async (kind) => {
    const h = await fixture(), owner = kind === 'api' ? h.apiOwner : h.dashboardOwner
    const commandFile = path.join(h.root, 'launch.cmd'), file = path.join(h.root, 'launch.json')
    await writeFile(commandFile, 'fixture command')
    const launch = await createServiceLaunch(file, { kind, commandFile, logFile: path.join(h.root, 'launch.log'),
      taskName: serviceTaskName(kind, kind === 'api' ? h.api.port : h.dashboard.port),
      invocation: { argv: [process.execPath], cwd: h.root, env: {}, graceMs: 1 } })
    h.evidence.set(file, { launch, host: h.controller, owner, range: null, instanceId: null,
      cancelled: false, recovered: false, settled: false })
    host.list.mockResolvedValue([{ file, launch }])
    const stateFile = serviceStatePath(h.root)
    await mkdir(path.dirname(stateFile), { recursive: true })
    const state = { version: 1, api: kind === 'api' ? owner : null, dashboard: kind === 'dashboard' ? owner : null,
      loginUrlFile: null, updatedAt: owner.startTime }
    await writeFile(stateFile, JSON.stringify(state))
    await h.effects.prepareStart?.()
    expect(host.cancel).not.toHaveBeenCalled()
    expect(h.recoverRange).not.toHaveBeenCalled()
    expect(h.api.requests).toEqual([])
    expect(h.dashboard.requests).toEqual([])
    expect(await readFile(stateFile, 'utf8')).toBe(JSON.stringify(state))
  },
)

it.skipIf(process.platform !== 'win32').each(['other-pid', 'reused-pid', 'changed-command'] as const)(
  'rejects a ready API listener with %s and never sends it shutdown', async (mismatch) => {
    const h = await fixture()
    await h.mutate(() => h.effects.startApi())
    h.api.ready()
    const foreign = mismatch === 'other-pid' ? { ...h.apiOwner, pid: h.apiOwner.pid + 10 }
      : mismatch === 'reused-pid' ? { ...h.apiOwner, startTime: '2026-01-02T00:00:00.000Z' }
        : { ...h.apiOwner, commandLine: 'foreign API' }
    h.owners.set(h.api.port, foreign)
    expect(await h.effects.inspectApi()).toEqual({ owner: foreign, health: null })
    await h.mutate(() => h.effects.requestApiShutdown())
    expect(h.api.requests).toEqual(['GET /v1/health'])
    expect(host.observe).toHaveBeenCalledTimes(1)
    expect(host.cancel).not.toHaveBeenCalled()
  },
)

it.skipIf(process.platform !== 'win32')('preserves a recorded live API without consulting damaged historical launches', async () => {
  const h = await fixture(), stateFile = serviceStatePath(h.root)
  await mkdir(path.dirname(stateFile), { recursive: true })
  await writeFile(stateFile, JSON.stringify({ version: 1, api: h.apiOwner, dashboard: null,
    loginUrlFile: null, updatedAt: h.apiOwner.startTime }))
  host.list.mockRejectedValue(new Error('unrelated historical launch is damaged'))
  await h.effects.prepareStart?.()
  expect(host.list).not.toHaveBeenCalled()
  expect(host.cancel).not.toHaveBeenCalled()
  expect(h.recoverRange).not.toHaveBeenCalled()
})

it.skipIf(process.platform !== 'win32')('leaves a missing login artifact absent during read-only reuse inspection', async () => {
  const h = await fixture(), stateFile = serviceStatePath(h.root), loginUrlFile = path.join(h.root, 'missing-url.txt')
  await mkdir(path.dirname(stateFile), { recursive: true })
  await writeFile(stateFile, JSON.stringify({ version: 1, api: h.apiOwner, dashboard: h.dashboardOwner,
    loginUrlFile, updatedAt: h.apiOwner.startTime }))
  expect(await h.effects.inspectDashboardReadOnly?.()).toEqual({ owner: h.dashboardOwner, proof: null })
  await expect(readFile(loginUrlFile)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(host.list).not.toHaveBeenCalled()
  expect(h.dashboard.requests).toEqual([])
})

it.skipIf(process.platform !== 'win32').each([
  { extra: {}, valid: true },
  { extra: { admissionBlocked: true, recoveryIssues: [{ kind: 'worker-generation', id: 'claim-registry',
    message: 'Claim evidence is unreadable', observedAt: '2026-10-29T01:00:00.000Z', blocksAdmission: true }] }, valid: true },
  { extra: { admissionBlocked: 'true' }, valid: false },
  { extra: { recoveryIssues: [{ kind: 'worker-generation', id: 'missing-fields' }] }, valid: false },
])('projects only validated optional recovery health fields: $valid, $extra', async ({ extra, valid }) => {
  const h = await fixture(), body = { status: 'ready', activeRuns: 2, ...extra }
  h.api.ready(body)
  expect((await h.effects.inspectApi()).health).toEqual(valid ? body : null)
})

it.skipIf(process.platform !== 'win32')('rejects a foreign dashboard before authentication and cancels only its own launch', async () => {
  const h = await fixture()
  await h.mutate(() => h.effects.startDashboard())
  const ownFile = [...h.evidence.keys()][0]
  if (ownFile === undefined) throw new Error('Missing recorded fixture launch')
  const foreign = { ...h.dashboardOwner, pid: h.dashboardOwner.pid + 10 }
  h.owners.set(h.dashboard.port, foreign)
  expect(await h.effects.inspectDashboard()).toEqual({ owner: null, proof: null })
  expect(await h.effects.verifyDashboard(`${h.dashboard.url}/?token=fixture`)).toBeNull()
  await h.mutate(() => h.effects.endDashboard(foreign))
  expect(h.dashboard.requests).toEqual([])
  expect(host.cancel).toHaveBeenCalledWith(ownFile, h.recoverRange, undefined)
  expect(host.powershell.mock.calls.every(([script]) => !script.includes('taskkill.exe') && !script.includes('schtasks.exe /End'))).toBe(true)
})
