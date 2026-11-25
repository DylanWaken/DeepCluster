/** A dead controller cannot silently authorize another mutation while its child may still run. */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import { parseSubprocessRangeReceipt, type SubprocessRangeReceipt } from '@deepseek-ai/dsh-subprocess'
import { assertNoPendingServiceMutation, markServiceMutationSettled, readServiceMutationIntent, recoverServiceMutationIntent,
  recoverStaleServiceMutation, runServiceMutationCommand, withServiceMutationIntent, withServiceMutationTransaction, type ServiceMutationIntent } from '../src/service-intent.ts'
import { withServiceLifecycleLock } from '../src/service-lock.ts'

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'deepcluster-intent-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'intent.json')
  const controller = { pid: 4801, startTime: '2026-01-01T00:00:00.000Z', commandLine: 'fixture controller' }
  return { root, file, controller, options: { file, inspectController: async () => controller } }
}

it('removes only a successfully joined mutation intent', async () => {
  const h = await fixture()
  const value = await withServiceMutationIntent('successful fixture', async () => {
    expect(await readServiceMutationIntent(h.file)).toMatchObject({ action: 'successful fixture', controller: h.controller })
    return 42
  }, h.options)
  expect(value).toBe(42)
  expect(await readServiceMutationIntent(h.file)).toBeNull()
})

it('retains failed commands and requires exact confirmation with a dead controller', async () => {
  const h = await fixture()
  await expect(withServiceMutationIntent('uncertain fixture', async () => { throw new Error('command failed') }, h.options))
    .rejects.toThrow('command failed')
  const intent = await readServiceMutationIntent(h.file)
  if (intent === null) throw new Error('Missing retained intent')
  await expect(assertNoPendingServiceMutation(h.file)).rejects.toThrow('recover-controller')
  await expect(recoverServiceMutationIntent('wrong-id', { file: h.file, inspectProcess: async () => null }))
    .rejects.toThrow('does not match')
  await expect(recoverServiceMutationIntent(intent.id, { file: h.file, inspectProcess: async () => h.controller }))
    .rejects.toThrow('still running')
  await expect(recoverServiceMutationIntent(intent.id, { file: h.file,
    inspectProcess: async () => { throw new Error('inspection denied') } })).rejects.toThrow('inspection denied')
  const recovered = await recoverServiceMutationIntent(intent.id, { file: h.file, inspectProcess: async () => null })
  expect(recovered.proof).toBe('operator-confirmed')
  expect(JSON.parse(await readFile(recovered.quarantineFile, 'utf8'))).toEqual(intent)
  expect(await readServiceMutationIntent(h.file)).toBeNull()
})

it('creates no intent for healthy reuse or a preflight refusal', async () => {
  const h = await fixture()
  await expect(withServiceMutationTransaction('healthy reuse', async () => 'healthy', h.options)).resolves.toBe('healthy')
  await expect(withServiceMutationTransaction('preflight refusal', async () => { throw new Error('active runs') }, h.options))
    .rejects.toThrow('active runs')
  expect(await readServiceMutationIntent(h.file)).toBeNull()
})

it('retires a durably settled rollback before propagating the action failure and admitting a retry', async () => {
  const h = await fixture(), failure = new Error('readiness failed')
  await expect(withServiceMutationTransaction('service start', async () => {
    await withServiceMutationIntent('launch fixture', async () => {})
    await withServiceMutationIntent('rollback fixture', async () => {})
    await markServiceMutationSettled()
    expect(await readServiceMutationIntent(h.file)).toMatchObject({ settled: true })
    throw failure
  }, h.options)).rejects.toBe(failure)
  expect(await readServiceMutationIntent(h.file)).toBeNull()
  await expect(withServiceMutationIntent('retry', async () => 42, h.options)).resolves.toBe(42)
})

it('durably revokes settlement before a subsequent external effect starts', async () => {
  const h = await fixture(), failure = new Error('later command failed')
  await expect(withServiceMutationTransaction('service start', async () => {
    await withServiceMutationIntent('first command', async () => {})
    await markServiceMutationSettled()
    await withServiceMutationIntent('later command', async () => {
      expect(await readServiceMutationIntent(h.file)).toMatchObject({ settled: false })
      throw failure
    })
  }, h.options)).rejects.toBe(failure)
  expect(await readServiceMutationIntent(h.file)).toMatchObject({ settled: false })
  await expect(assertNoPendingServiceMutation(h.file)).rejects.toThrow('did not confirm completion')
})

it('preserves a replacement intent when settlement is recorded', async () => {
  const h = await fixture()
  let replacement: ServiceMutationIntent | undefined
  await expect(withServiceMutationTransaction('service start', async () => {
    await withServiceMutationIntent('launch fixture', async () => {})
    const current = await readServiceMutationIntent(h.file)
    if (current === null) throw new Error('Missing intent')
    replacement = { ...current, id: randomUUID() }
    await writeFile(h.file, JSON.stringify(replacement))
    await markServiceMutationSettled()
  }, h.options)).rejects.toThrow('replacement was preserved')
  expect(await readServiceMutationIntent(h.file)).toEqual(replacement)
})

it('retains the action failure and replacement evidence when settled-marker retirement fails', async () => {
  const h = await fixture(), failure = new Error('readiness failed')
  let replacement: ServiceMutationIntent | undefined
  await expect(withServiceMutationTransaction('service start', async () => {
    await withServiceMutationIntent('launch fixture', async () => {})
    await markServiceMutationSettled()
    const current = await readServiceMutationIntent(h.file)
    if (current === null) throw new Error('Missing intent')
    replacement = { ...current, id: randomUUID() }
    await writeFile(h.file, JSON.stringify(replacement))
    throw failure
  }, h.options)).rejects.toMatchObject({ cause: failure, errors: [failure, expect.any(Error)] })
  expect(await readServiceMutationIntent(h.file)).toEqual(replacement)
})

async function retainedIntent(h: Awaited<ReturnType<typeof fixture>>, values: Partial<ServiceMutationIntent> = {}) {
  const intent: ServiceMutationIntent = { version: 1, id: randomUUID(), action: 'service start',
    createdAt: '2026-01-02T00:00:00.000Z', controller: h.controller, ...values }
  await writeFile(h.file, JSON.stringify(intent))
  return intent
}

const nextBoot = { startedAt: '2026-01-03T00:00:00.000Z', observedAt: '2026-01-04T00:00:00.000Z' }
const currentBoot = { startedAt: '2025-12-01T00:00:00.000Z', observedAt: '2026-12-01T00:00:00.000Z' }

async function retainedManagedIntent(h: Awaited<ReturnType<typeof fixture>>) {
  const receipt = parseSubprocessRangeReceipt({ kind: 'windows-job', jobName: `Global\\dsh-subprocess-${randomUUID()}` })
  await expect(withServiceMutationTransaction('managed start', async () => {
    await runServiceMutationCommand('native launch', 'fixture command', async () => { throw new Error('Unexpected fallback') })
    throw new Error('controller interrupted')
  }, { ...h.options, managedCommands: async (_script, persistReceipt) => { await persistReceipt(receipt); return 'done' } }))
    .rejects.toThrow('controller interrupted')
  const intent = await readServiceMutationIntent(h.file)
  if (intent?.commands === undefined) throw new Error('Missing native command ownership')
  return { intent, receipt, directory: path.join(intent.commands.stateDirectory, 'worker-ranges', intent.id) }
}

it('publishes complete ownership before the native command and persists its receipt before target execution', async () => {
  const h = await fixture()
  await expect(withServiceMutationTransaction('managed start', async () => {
    expect(await runServiceMutationCommand('launch', 'fixture command', async () => { throw new Error('Unexpected fallback') })).toBe('output')
    await markServiceMutationSettled()
    await runServiceMutationCommand('next launch', 'fixture command', async () => { throw new Error('Unexpected fallback') })
  }, { ...h.options, managedCommands: async (script, persistReceipt) => {
    const receipt = parseSubprocessRangeReceipt({ kind: 'windows-job', jobName: `Global\\dsh-subprocess-${randomUUID()}` })
    expect(script).toBe('fixture command')
    const intent = await readServiceMutationIntent(h.file)
    expect(intent).toMatchObject({ commands: { version: 1, complete: true } })
    expect(intent?.settled).not.toBe(true)
    if (intent?.commands === undefined) throw new Error('Missing command manifest')
    const directory = path.join(intent.commands.stateDirectory, 'worker-ranges', intent.id)
    expect(JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'))).toMatchObject({ version: 1, generation: intent.id })
    await persistReceipt(receipt)
    const files = (await readdir(directory)).filter(name => name !== 'manifest.json')
    expect(files.length).toBeGreaterThan(0)
    expect(await Promise.all(files.map(async (name) => {
      const value: unknown = JSON.parse(await readFile(path.join(directory, name), 'utf8'))
      return value
    })))
      .toEqual(expect.arrayContaining([expect.objectContaining({ generation: intent.id, range: receipt })]))
    return 'output'
  } })).resolves.toBeUndefined()
  expect(await readServiceMutationIntent(h.file)).toBeNull()
})

it('recovers exact recorded native ranges after a same-boot controller crash while preserving receipt history', async () => {
  const h = await fixture(), { intent, receipt, directory } = await retainedManagedIntent(h)
  const before = await readdir(directory), recoveredRanges: SubprocessRangeReceipt[] = []
  const signal = new AbortController().signal
  const recovered = await recoverStaleServiceMutation({ file: h.file, inspectBoot: async () => currentBoot,
    inspectProcess: async () => ({ ...h.controller, startTime: '2026-01-02T00:00:00.000Z' }), signal,
    recoverRange: async (range, receivedSignal) => {
      expect(receivedSignal).toBe(signal)
      expect(await readServiceMutationIntent(h.file)).toEqual(intent)
      recoveredRanges.push(range)
    } })
  expect(recoveredRanges).toEqual([receipt])
  expect(recovered).toMatchObject({ proof: 'commands', intent })
  expect(await readdir(directory)).toEqual(before)
  expect(await readServiceMutationIntent(h.file)).toBeNull()
})

it('recovers complete native commands without depending on a Windows boot query', async () => {
  const h = await fixture(), { intent, receipt } = await retainedManagedIntent(h), ranges: SubprocessRangeReceipt[] = []
  await expect(recoverStaleServiceMutation({ file: h.file, inspectProcess: async () => null,
    inspectBoot: async () => { throw new Error('Boot query unavailable') },
    recoverRange: async (range) => { ranges.push(range) } })).resolves.toMatchObject({ proof: 'commands', intent })
  expect(ranges).toEqual([receipt])
  expect(await readServiceMutationIntent(h.file)).toBeNull()
})

it.each([false, true])('revokes complete native command ownership before an untracked effect after settlement=%s', async (settled) => {
  const h = await fixture()
  await expect(withServiceMutationTransaction('managed start', async () => {
    await runServiceMutationCommand('launch', 'fixture command', async () => 'fallback')
    if (settled) await markServiceMutationSettled()
    await withServiceMutationIntent('untracked command', async () => {
      expect(await readServiceMutationIntent(h.file)).toMatchObject({ settled: false, commands: { complete: false } })
      throw new Error('untracked failure')
    })
  }, { ...h.options, managedCommands: async () => 'output' })).rejects.toThrow('untracked failure')
  await expect(recoverStaleServiceMutation({ file: h.file, inspectBoot: async () => currentBoot,
    inspectProcess: async () => null, recoverRange: async () => { throw new Error('Unexpected native recovery') } }))
    .rejects.toThrow('no confirmed settlement')
})

it('preserves complete command ownership for explicitly child-free effects', async () => {
  const h = await fixture()
  await expect(withServiceMutationTransaction('managed start', async () => {
    await withServiceMutationIntent('HTTP shutdown', async () => { throw new Error('response lost') }, { processScope: 'in-process' })
  }, { ...h.options, managedCommands: async () => 'output' })).rejects.toThrow('response lost')
  expect(await readServiceMutationIntent(h.file)).toMatchObject({ commands: { complete: true } })
  await expect(recoverStaleServiceMutation({ file: h.file, inspectBoot: async () => currentBoot, inspectProcess: async () => null,
    recoverRange: async () => { throw new Error('No command was launched') } })).resolves.toMatchObject({ proof: 'commands' })
})

it('retains fallback execution without advertising native command ownership', async () => {
  const h = await fixture()
  await expect(withServiceMutationTransaction('fallback start', async () => {
    await runServiceMutationCommand('launch', 'fixture command', async (script) => {
      expect(script).toBe('fixture command')
      throw new Error('fallback failed')
    })
  }, h.options)).rejects.toThrow('fallback failed')
  expect((await readServiceMutationIntent(h.file))?.commands).toBeUndefined()
})

it('retains the exact intent when native range recovery fails', async () => {
  const h = await fixture(), { intent } = await retainedManagedIntent(h)
  await expect(recoverStaleServiceMutation({ file: h.file, inspectBoot: async () => currentBoot, inspectProcess: async () => null,
    recoverRange: async () => { throw new Error('native access denied') } })).rejects.toThrow('native access denied')
  expect(await readServiceMutationIntent(h.file)).toEqual(intent)
})

it('retains ownership when the command receipt manifest is missing', async () => {
  const h = await fixture(), { intent, directory } = await retainedManagedIntent(h)
  await rm(path.join(directory, 'manifest.json'))
  await expect(recoverStaleServiceMutation({ file: h.file, inspectBoot: async () => currentBoot, inspectProcess: async () => null,
    recoverRange: async () => { throw new Error('Unexpected native recovery') } })).rejects.toThrow('manifest is missing')
  expect(await readServiceMutationIntent(h.file)).toEqual(intent)
})

it('preserves a replacement intent during native command recovery', async () => {
  const h = await fixture(), { intent } = await retainedManagedIntent(h), replacement = { ...intent, id: randomUUID() }
  await expect(recoverStaleServiceMutation({ file: h.file, inspectBoot: async () => currentBoot, inspectProcess: async () => null,
    recoverRange: async () => { await writeFile(h.file, JSON.stringify(replacement)) } })).rejects.toThrow('replacement was preserved')
  expect(await readServiceMutationIntent(h.file)).toEqual(replacement)
})

it('refuses native recovery while the original controller is still live', async () => {
  const h = await fixture(), { intent } = await retainedManagedIntent(h)
  await expect(recoverStaleServiceMutation({ file: h.file, inspectBoot: async () => currentBoot,
    inspectProcess: async () => h.controller, recoverRange: async () => { throw new Error('Unexpected native recovery') } }))
    .rejects.toThrow('still running')
  expect(await readServiceMutationIntent(h.file)).toEqual(intent)
})

it('quarantines a previous-boot intent automatically and preserves the recorded evidence', async () => {
  const h = await fixture(), intent = await retainedIntent(h)
  const recovered = await recoverStaleServiceMutation({ file: h.file, inspectBoot: async () => nextBoot,
    inspectProcess: async () => null })
  expect(recovered).toMatchObject({ proof: 'previous-boot', intent })
  if (recovered === null) throw new Error('Missing recovery')
  expect(JSON.parse(await readFile(recovered.quarantineFile, 'utf8'))).toEqual(intent)
  expect(await readServiceMutationIntent(h.file)).toBeNull()
})

it.each([false, true])('recovers settled current-boot work without confusing reused PID=%s for the controller', async (reused) => {
  const h = await fixture(), intent = await retainedIntent(h, { settled: true })
  const recovered = await recoverStaleServiceMutation({ file: h.file,
    inspectBoot: async () => { throw new Error('Settled work does not require boot evidence') },
    inspectProcess: async () => reused ? { ...h.controller, startTime: '2026-01-02T01:00:00.000Z' } : null })
  expect(recovered).toMatchObject({ proof: 'settled', intent })
  expect(await readServiceMutationIntent(h.file)).toBeNull()
})

it('does not inspect host processes when no intent exists', async () => {
  const h = await fixture()
  await expect(recoverStaleServiceMutation({ file: h.file,
    inspectBoot: async () => { throw new Error('Unexpected boot query') },
    inspectProcess: async () => { throw new Error('Unexpected process query') } })).resolves.toBeNull()
  await expect(markServiceMutationSettled()).resolves.toBeUndefined()
})

it.each(['createdAt', 'controller'] as const)('preserves current-boot uncertainty in %s', async (field) => {
  const h = await fixture(), intent = await retainedIntent(h, field === 'createdAt'
    ? { createdAt: nextBoot.startedAt } : { controller: { ...h.controller, startTime: nextBoot.startedAt } })
  await expect(recoverStaleServiceMutation({ file: h.file, inspectBoot: async () => nextBoot,
    inspectProcess: async () => null })).rejects.toThrow('no confirmed settlement')
  expect(await readServiceMutationIntent(h.file)).toEqual(intent)
})

it.each([false, true])('preserves a live matching controller with settlement=%s', async (settled) => {
  const h = await fixture(), intent = await retainedIntent(h, { settled })
  await expect(recoverStaleServiceMutation({ file: h.file, inspectBoot: async () => nextBoot,
    inspectProcess: async () => h.controller })).rejects.toThrow('still running')
  expect(await readServiceMutationIntent(h.file)).toEqual(intent)
})

it('preserves uncertainty when inspection fails or the boot changes during recovery', async () => {
  const h = await fixture(), intent = await retainedIntent(h)
  await expect(recoverStaleServiceMutation({ file: h.file, inspectBoot: async () => nextBoot,
    inspectProcess: async () => { throw new Error('process query denied') } })).rejects.toThrow('process query denied')
  await expect(recoverStaleServiceMutation({ file: h.file,
    inspectBoot: async () => { throw new Error('boot query denied') }, inspectProcess: async () => null }))
    .rejects.toThrow('boot query denied')
  let observations = 0
  await expect(recoverStaleServiceMutation({ file: h.file, inspectProcess: async () => null,
    inspectBoot: async () => ++observations === 1 ? nextBoot : { ...nextBoot, startedAt: '2026-01-03T01:00:00.000Z' } }))
    .rejects.toThrow('boot evidence changed')
  expect(await readServiceMutationIntent(h.file)).toEqual(intent)
})

it('preserves an intent replaced during automatic recovery', async () => {
  const h = await fixture(), intent = await retainedIntent(h), replacement = { ...intent, id: randomUUID() }
  let observations = 0
  await expect(recoverStaleServiceMutation({ file: h.file, inspectBoot: async () => nextBoot,
    inspectProcess: async () => {
      if (++observations === 2) await writeFile(h.file, JSON.stringify(replacement))
      return null
    } })).rejects.toThrow('replacement was preserved')
  expect(await readServiceMutationIntent(h.file)).toEqual(replacement)
})

it('rechecks the controller before automatic recovery changes the marker', async () => {
  const h = await fixture(), intent = await retainedIntent(h)
  let observations = 0
  await expect(recoverStaleServiceMutation({ file: h.file, inspectBoot: async () => nextBoot,
    inspectProcess: async () => ++observations === 1 ? null : h.controller })).rejects.toThrow('became live')
  expect(await readServiceMutationIntent(h.file)).toEqual(intent)
})

it('retains one intent through command completion until readiness and ownership persistence finish', async () => {
  const h = await fixture(), commandFinished = Promise.withResolvers<undefined>(), ready = Promise.withResolvers<undefined>()
  const transaction = withServiceMutationTransaction('service start', async () => {
    await withServiceMutationIntent('launcher', async () => {})
    commandFinished.resolve(undefined)
    await ready.promise
    await withServiceMutationIntent('save owner permissions', async () => {})
  }, h.options)
  await commandFinished.promise
  expect(await readServiceMutationIntent(h.file)).toMatchObject({ action: 'service start' })
  await expect(assertNoPendingServiceMutation(h.file)).rejects.toThrow('did not confirm completion')
  ready.resolve(undefined); await transaction
  expect(await readServiceMutationIntent(h.file)).toBeNull()
})

it.skipIf(process.platform !== 'win32').each(['during-command', 'after-command'])('blocks a new controller after a crash %s', { timeout: 30_000 }, async (mode) => {
  const h = await fixture(), endpoint = `\\\\.\\pipe\\deepcluster-intent-test-${randomUUID()}`
  const finishedFile = path.join(h.root, 'finished.txt')
  const script = fileURLToPath(new URL('./fixtures/service-intent-child.ts', import.meta.url))
  const child = spawn(process.execPath, ['--import', 'tsx/esm', script, endpoint, h.file, finishedFile, mode],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true })
  let stderr = ''
  child.stderr?.on('data', (data: Buffer) => { stderr += data.toString() })
  const ended = new Promise<void>((resolve) => { child.once('close', () => { resolve() }) })
  onTestFinished(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await ended })
  await new Promise<void>((resolve, reject) => {
    child.once('message', (message) => { if (message === 'mutating') resolve(); else reject(new Error('unexpected fixture message')) })
    child.once('error', reject)
    child.once('exit', () => { reject(new Error(`controller exited before mutation: ${stderr}`)) })
  })
  child.kill(); await ended
  let mutated = false
  await expect(withServiceLifecycleLock(async () => {
    await assertNoPendingServiceMutation(h.file)
    mutated = true
  }, { pipeName: endpoint, timeoutMs: 5_000 })).rejects.toThrow('did not confirm completion')
  expect(mutated).toBe(false)
  await expect.poll(async () => readFile(finishedFile, 'utf8').catch(() => ''), { timeout: 5_000 }).toBe('finished')
  // Even observing the fixture's output is not general descendant-cleanup proof.
  await expect(assertNoPendingServiceMutation(h.file)).rejects.toThrow('did not confirm completion')
})
