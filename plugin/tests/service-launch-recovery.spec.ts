/** Scheduled launch receipts retain exact identity across controller interruption. */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { parseSubprocessRangeReceipt } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessHandle, SubprocessOutcome, SubprocessRangeReceipt, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { cancelServiceLaunch, createServiceLaunch, listServiceLaunches, readServiceLaunch, readServiceLaunchEvidence,
  recordServiceLaunchInstance, registerServiceLaunchProcess, runServiceHost } from '../src/service-launch-recovery.ts'
import { parseServiceTaskInstanceId } from '../src/service-task-observation.ts'
import { resolveOptions } from '../src/assets.ts'
import { serviceLauncherScript, serviceLaunchInvocation } from '../src/service.ts'

const receipt = parseSubprocessRangeReceipt({ kind: 'windows-job', jobName: 'Global\\dsh-subprocess-12345678-1234-4234-8234-123456789abc' })
const owner = { pid: 42, startTime: '2026-10-27T00:00:00.000Z', commandLine: 'test service-host' }
const stopDependencies = { systemRoot: 'C:\\Windows', run: vi.fn(async () => 'stopped'), inspectProcess: async () => null }

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'deepcluster-launch-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const run = path.join(root, 'runs', 'one')
  await mkdir(run, { recursive: true })
  const commandFile = path.join(run, 'start-api.cmd'), logFile = path.join(run, 'api.log'), file = path.join(run, 'launch.json')
  await writeFile(commandFile, '@echo off\n')
  const launch = await createServiceLaunch(file, { kind: 'api', taskName: 'test-api', commandFile, logFile,
    invocation: { argv: ['node', 'dsh.js', '--profile', 'deep-cluster'], cwd: root, env: { DEPLOYMENT: 'yes' }, graceMs: 10 } })
  return { root, file, launch }
}

function provider(run: (persist: (value: SubprocessRangeReceipt) => Promise<void>) => Promise<SubprocessOutcome>) {
  const terminate = vi.fn(() => {})
  const waitForExit = vi.fn(async () => true)
  const handle: SubprocessHandle = { stdin: undefined, stdout: undefined, stderr: undefined, control: undefined,
    collected: {}, rangeScope: 'owned', done: Promise.resolve({ exitCode: 0, signal: null }),
    terminate, waitForExit }
  const spawnRecoverable = vi.fn<SubprocessRuntime['spawnRecoverable']>((_spec, persist) => ({ ...handle, done: run(persist) }))
  return { spawnRecoverable, terminate, waitForExit }
}

it('retains launch, scheduler instance, and exact process identities independently', async () => {
  const h = await fixture()
  expect(await listServiceLaunches(h.root)).toEqual([{ file: h.file, launch: h.launch }])
  const instance = parseServiceTaskInstanceId('12345678-1234-4234-8234-123456789abc')
  await recordServiceLaunchInstance(h.file, instance)
  await registerServiceLaunchProcess(h.file, 'owner', async () => owner)
  expect(await readServiceLaunchEvidence(h.file)).toMatchObject({ owner, instanceId: instance,
    range: null, cancelled: false, settled: false, recovered: false })
  await expect(registerServiceLaunchProcess(h.file, 'owner', async () => ({ ...owner, pid: 43 }))).rejects.toThrow('different ownership')
})

it('rejects modified launch commands and mismatched sidecar identities', async () => {
  const h = await fixture()
  await writeFile(`${h.file}.owner.json`, JSON.stringify({ launchId: 'wrong', owner }))
  await expect(readServiceLaunchEvidence(h.file)).rejects.toThrow()
  await writeFile(h.launch.commandFile, 'changed')
  await expect(readServiceLaunch(h.file)).rejects.toThrow('command changed')
})

it('reports damaged historical launch entries while retaining independent launch evidence', async () => {
  const h = await fixture(), damaged = path.join(h.root, 'runs', 'damaged')
  await mkdir(damaged)
  const file = path.join(damaged, 'launch.json')
  await writeFile(file, '{')
  const issues: string[] = []
  expect(await listServiceLaunches(h.root, (entry) => { issues.push(entry) })).toEqual([{ file: h.file, launch: h.launch }])
  expect(issues).toEqual([file])
  expect(await readFile(file, 'utf8')).toBe('{')
})

it('persists the native receipt before target admission and records confirmed settlement', async () => {
  const h = await fixture()
  const native = provider(async (persist) => {
    await persist(receipt)
    expect((await readServiceLaunchEvidence(h.file)).range).toEqual(receipt)
    return { exitCode: 7, signal: null }
  })
  expect(await runServiceHost(h.file, native, new AbortController().signal, async () => owner)).toBe(7)
  expect(await readServiceLaunchEvidence(h.file)).toMatchObject({ host: owner, settled: true, range: receipt })
  expect(native.spawnRecoverable.mock.calls[0]?.[0].env).toMatchObject({ DEPLOYMENT: 'yes', DEEPCLUSTER_SERVICE_LAUNCH_FILE: h.file })
  expect(native.terminate).toHaveBeenCalledOnce()
  expect(native.waitForExit).toHaveBeenCalledOnce()
  await expect(runServiceHost(h.file, native, new AbortController().signal, async () => owner)).rejects.toThrow('already been consumed')
})

it('revokes a late receipt callback before it can start a target', async () => {
  const h = await fixture()
  const entered: PromiseWithResolvers<void> = Promise.withResolvers()
  const resume: PromiseWithResolvers<void> = Promise.withResolvers()
  let started = false
  const native = provider(async (persist) => {
    entered.resolve()
    await resume.promise
    await persist(receipt)
    started = true
    return { exitCode: 0, signal: null }
  })
  let hostAlive = true
  const running = runServiceHost(h.file, native, new AbortController().signal, async () => owner)
    .finally(() => { hostAlive = false })
  const failed = expect(running).rejects.toThrow('cancelled before target start')
  await entered.promise
  const recover = vi.fn(async () => {})
  const stopped: PromiseWithResolvers<void> = Promise.withResolvers()
  const cancellation = cancelServiceLaunch(h.file, recover, undefined, {
    ...stopDependencies, inspectProcess: async () => hostAlive ? owner : null,
    run: async () => { stopped.resolve(); return 'stopped' },
  })
  await stopped.promise
  expect(recover).not.toHaveBeenCalled()
  expect((await readServiceLaunchEvidence(h.file)).recovered).toBe(false)
  resume.resolve()
  await failed
  expect(await cancellation).toEqual({ task: 'stopped', recovered: true })
  expect(recover).toHaveBeenCalledOnce()
  expect(started).toBe(false)
  expect(native.waitForExit).toHaveBeenCalledOnce()
})

it('does not record settlement when a provider reports an unconfirmed range', async () => {
  const h = await fixture()
  const native = provider(async (persist) => { await persist(receipt); return { exitCode: 0, signal: null } })
  native.waitForExit.mockResolvedValue(false)
  await expect(runServiceHost(h.file, native, new AbortController().signal, async () => owner)).rejects.toThrow('did not confirm cleanup')
  expect((await readServiceLaunchEvidence(h.file)).settled).toBe(false)
})

it('allows only one concurrent host to consume a launch even when both inspect the same identity', async () => {
  const h = await fixture()
  const both: PromiseWithResolvers<void> = Promise.withResolvers()
  let inspected = 0
  const inspect = async () => {
    inspected += 1
    if (inspected === 2) both.resolve()
    await both.promise
    return owner
  }
  const native = provider(async (persist) => {
    await persist(receipt)
    return { exitCode: 0, signal: null }
  })
  const results = await Promise.allSettled([
    runServiceHost(h.file, native, new AbortController().signal, inspect),
    runServiceHost(h.file, native, new AbortController().signal, inspect),
  ])
  expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected'])
  expect(native.spawnRecoverable).toHaveBeenCalledOnce()
})

it('closes host admission atomically when cancellation wins before process registration', async () => {
  const h = await fixture()
  const inspecting: PromiseWithResolvers<void> = Promise.withResolvers()
  const resume: PromiseWithResolvers<void> = Promise.withResolvers()
  const native = provider(async () => ({ exitCode: 0, signal: null }))
  const running = runServiceHost(h.file, native, new AbortController().signal, async () => {
    inspecting.resolve()
    await resume.promise
    return owner
  })
  const failed = expect(running).rejects.toThrow('different ownership')
  await inspecting.promise
  await cancelServiceLaunch(h.file, async () => {}, undefined, stopDependencies)
  resume.resolve()
  await failed
  expect(native.spawnRecoverable).not.toHaveBeenCalled()
  expect((await readServiceLaunchEvidence(h.file)).host).toBeNull()
})

it('records cancelled separately from recovered when native settlement fails', async () => {
  const h = await fixture()
  await writeFile(`${h.file}.range.json`, JSON.stringify({ launchId: h.launch.id, receipt }))
  const failure = new Error('native query denied')
  await expect(cancelServiceLaunch(h.file, async () => { throw failure }, undefined, stopDependencies)).rejects.toBe(failure)
  expect(await readServiceLaunchEvidence(h.file)).toMatchObject({ cancelled: true, recovered: false })
  const recover = vi.fn(async () => {})
  await cancelServiceLaunch(h.file, recover, undefined, stopDependencies)
  expect(recover).toHaveBeenCalledExactlyOnceWith(receipt, undefined)
  expect((await readServiceLaunchEvidence(h.file)).recovered).toBe(true)
})

it('keeps recovery incomplete when a registered host does not exit before cancellation', async () => {
  const h = await fixture()
  await registerServiceLaunchProcess(h.file, 'host', async () => owner)
  const controller = new AbortController()
  await expect(cancelServiceLaunch(h.file, async () => {}, controller.signal, {
    ...stopDependencies, inspectProcess: async () => { controller.abort(new Error('host deadline')); return owner },
  })).rejects.toThrow()
  expect(await readServiceLaunchEvidence(h.file)).toMatchObject({ cancelled: true, recovered: false })
})

it('preserves a replaced scheduler action while recovering the original unique native range', async () => {
  const h = await fixture()
  await writeFile(`${h.file}.range.json`, JSON.stringify({ launchId: h.launch.id, receipt }))
  const recover = vi.fn(async () => {})
  const run = vi.fn(async (_script: string) => 'replaced')
  expect(await cancelServiceLaunch(h.file, recover, undefined, { ...stopDependencies, run })).toEqual({ task: 'replaced', recovered: true })
  expect(run.mock.calls[0]?.[0]).toContain(h.launch.commandFile)
  expect(recover).toHaveBeenCalledOnce()
})

it('rejects malformed native receipts and unavailable scheduler observations', async () => {
  const h = await fixture()
  await writeFile(`${h.file}.range.json`, JSON.stringify({ launchId: h.launch.id, receipt: { kind: 'windows-job', jobName: 'unrelated' } }))
  await expect(cancelServiceLaunch(h.file, async () => {}, undefined, stopDependencies)).rejects.toThrow('Invalid subprocess recovery receipt')
  const other = await fixture()
  await expect(cancelServiceLaunch(other.file, async () => {}, undefined, { ...stopDependencies, run: async () => 'unknown' })).rejects.toThrow()
  expect((await readServiceLaunchEvidence(other.file)).recovered).toBe(false)
  await writeFile(`${other.file}.range.json`, 'null')
  await expect(readServiceLaunchEvidence(other.file)).rejects.toThrow()
})

it('builds a supported service-host command and persists only explicit deployment environment', async () => {
  const h = await fixture()
  const options = resolveOptions({ dshPath: h.root, serviceCliPath: path.join(h.root, 'cli.js') })
  const context = { kind: 'api' as const, logFile: h.launch.logFile, stateDirectory: path.join(h.root, 'api-state'),
    apiPort: 3789, dashboardPort: 3788, launchFile: h.file }
  const target = serviceLaunchInvocation(options, context)
  expect(Object.keys(target.env).sort()).toEqual(['DEEPCLUSTER_API_LEASE_ROOT', 'DEEPCLUSTER_API_PORT', 'DEEPCLUSTER_API_STATE_DIRECTORY'])
  expect(serviceLauncherScript(options, context)).toContain('--profile deep-cluster service-host --launch-file')
  expect(await readFile(h.file, 'utf8')).not.toContain('DEEPSEEK_API_KEY')
})
