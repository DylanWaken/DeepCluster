/** Exact Scheduler instance observation and bounded, URL-redacted startup diagnostics. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { observeServiceTask, parseServiceTaskInstanceId, ServiceStartupError, type ServiceTaskLaunch } from '../src/service-task-observation.ts'

const instance = '1644b2e4-b129-4f79-918e-aa87d1fecc32'

async function launch(): Promise<ServiceTaskLaunch> {
  const root = await mkdtemp(path.join(tmpdir(), 'deepcluster-task-observation-'))
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
  return { kind: 'api', taskName: 'DeepCluster fixture', instanceId: parseServiceTaskInstanceId(instance),
    commandFile: path.join(root, 'start.cmd'), logFile: path.join(root, 'api.log') }
}

function observed(value: ServiceTaskLaunch, instances = [{ id: `{${instance.toUpperCase()}}`, state: 4 }]) {
  return { kind: 'observed', actions: [{ execute: 'C:\\Windows\\System32\\conhost.exe',
    arguments: `--headless cmd.exe /d /c "${value.commandFile}"` }], instances, lastTaskResult: 0 }
}

function host(value: unknown) {
  return { systemRoot: 'C:\\Windows', runPowerShell: async () => JSON.stringify(value) }
}

it('normalizes Scheduler GUID output and rejects malformed invocation identities', () => {
  expect(parseServiceTaskInstanceId(` {${instance.toUpperCase()}}\r\n`)).toBe(instance)
  expect(parseServiceTaskInstanceId(instance)).toBe(instance)
  for (const value of [null, 12, '', '{}', `{${instance}`, 'not-a-guid']) {
    expect(() => parseServiceTaskInstanceId(value)).toThrow()
  }
})

it.each([[2, 'queued'], [4, 'running']] as const)('observes the exact active invocation state %s', async (state, expected) => {
  const value = await launch()
  const result = await observeServiceTask(value, host(observed(value, [{ id: instance, state }])))
  expect(result).toBe(expected)
})

it('fails when the expected instance ended even if the task returned zero and another invocation is running', async () => {
  const value = await launch()
  await writeFile(value.logFile, 'listen EACCES: permission denied 127.0.0.1:3789\n')
  const promise = observeServiceTask(value, host(observed(value, [{ id: '0b922716-83ef-4b1c-8d58-7a4718c7642c', state: 4 }])))
  await expect(promise).rejects.toMatchObject({ code: 'startup-exited', taskResult: 0,
    logTail: 'listen EACCES: permission denied 127.0.0.1:3789' })
  await expect(promise).rejects.toThrow('descendant cleanup is not confirmed')
})

it('reports missing and replaced task actions without assuming process cleanup', async () => {
  const value = await launch()
  await expect(observeServiceTask(value, host({ kind: 'missing' }))).rejects.toMatchObject({ code: 'startup-task-missing', logTail: null })
  const changed = observed(value)
  changed.actions[0]!.arguments = '--headless cmd.exe /d /c "other.cmd"'
  await expect(observeServiceTask(value, host(changed))).rejects.toMatchObject({ code: 'startup-task-replaced' })
  changed.actions[0]!.arguments = `--headless cmd.exe /d /c "${value.commandFile}"`
  changed.actions[0]!.execute = 'D:\\Other\\conhost.exe'
  await expect(observeServiceTask(value, host(changed))).rejects.toMatchObject({ code: 'startup-task-replaced' })
  await expect(observeServiceTask(value, host({ ...observed(value), actions: [] }))).rejects.toMatchObject({ code: 'startup-task-replaced' })
})

it('contains malformed or unavailable host observations as typed startup errors', async () => {
  const value = await launch()
  const commandFailure = new Error('host observation failed')
  await expect(observeServiceTask(value, { systemRoot: 'C:\\Windows', runPowerShell: async () => { throw commandFailure } }))
    .rejects.toMatchObject({ code: 'startup-observation-unavailable', cause: commandFailure })
  for (const result of [{ kind: 'unavailable' }, {}, observed(value, [{ id: 'invalid', state: 4 }]), observed(value, [{ id: instance, state: 0 }])]) {
    await expect(observeServiceTask(value, host(result))).rejects.toMatchObject({ code: 'startup-observation-unavailable' })
  }
  await expect(observeServiceTask(value, { ...host(observed(value)), systemRoot: undefined }))
    .rejects.toMatchObject({ code: 'startup-observation-unavailable' })
})

it('bounds the complete diagnostic tail and removes URLs including a cropped login URL', async () => {
  const value = { ...await launch(), kind: 'dashboard' as const }
  await writeFile(value.logFile, `dsh web: http://127.0.0.1:3788/?token=${'secret'.repeat(2000)}\n`
    + 'x'.repeat(3000) + '\nComplete failure: http://127.0.0.1:3788/?token=private-token\n')
  let failure: ServiceStartupError | undefined
  try { await observeServiceTask(value, host(observed(value, []))) } catch (error) {
    if (!(error instanceof ServiceStartupError)) throw error
    failure = error
  }
  expect(failure?.logTail?.length).toBeLessThanOrEqual(4096)
  expect(failure?.logTail).toContain('Complete failure: <redacted-url>')
  expect(failure?.message).not.toMatch(/secret|private-token|https?:/u)
  expect(failure?.launch.instanceId).toBe(instance)
})

it('retains an empty readable log distinctly from an unavailable log', async () => {
  const value = await launch()
  await writeFile(value.logFile, '')
  await expect(observeServiceTask(value, host(observed(value, [])))).rejects.toMatchObject({ logTail: '' })
  await writeFile(value.logFile, `http://127.0.0.1/?token=${'private-token'.repeat(2000)}`)
  await expect(observeServiceTask(value, host(observed(value, [])))).rejects.toMatchObject({ logTail: '' })
})
