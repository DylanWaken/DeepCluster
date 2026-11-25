/** Runtime launch diagnostics, structured termination, and containment proof. */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { resolveOptions } from '../src/assets.ts'
import {
  describeExecution, managedProcessRunner, ProcessCleanupError, resolveInvocation, runHandoff,
  WorkerTerminationError,
} from '../src/executor.ts'

const temporary: string[] = []
afterEach(async () => { await Promise.all(temporary.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'deep-cluster-runtime-'))
  temporary.push(dir)
  return dir
}

interface FakeHandle extends SubprocessHandle {
  readonly stdout: PassThrough
  readonly stderr: PassThrough
  readonly exited: { promise: Promise<SubprocessOutcome>; resolve: (value: SubprocessOutcome) => void }
  readonly quiescent: { promise: Promise<boolean>; resolve: (value: boolean) => void }
  readonly terminateSpy: ReturnType<typeof vi.fn>
}

/** One fake provider handle whose range proof is independently controlled. */
function fakeHandle(rangeScope: 'owned' | 'direct-child' | undefined): FakeHandle {
  const exited = Promise.withResolvers<SubprocessOutcome>()
  const quiescent = Promise.withResolvers<boolean>()
  const terminateSpy = vi.fn()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  return {
    stdin: undefined, stdout, stderr, control: undefined, collected: {}, done: exited.promise,
    ...rangeScope === undefined ? {} : { rangeScope },
    terminate: () => { terminateSpy() }, waitForExit: () => quiescent.promise, exited, quiescent, terminateSpy,
  }
}

describe('containment proof', () => {
  it('accepts an empty owned range', async () => {
    const handle = fakeHandle('owned')
    const runner = managedProcessRunner({ spawn: () => handle, resolveExecutable: async value => value },
      { maxOutputBytes: 1024, terminationGraceMs: 100 })
    const work = runner({ command: 'worker', args: [], cwd: '.', timeoutMs: 10_000, env: {} })
    handle.stdout.end('ok'); handle.stderr.end(); handle.exited.resolve({ exitCode: 0, signal: null }); handle.quiescent.resolve(true)
    await expect(work).resolves.toMatchObject({ code: 0, stdout: 'ok' })
  })

  it('quarantines a direct-child provider even when its direct child is gone', async () => {
    const handle = fakeHandle('direct-child')
    const runner = managedProcessRunner({ spawn: () => handle, resolveExecutable: async value => value },
      { maxOutputBytes: 1024, terminationGraceMs: 100 })
    const work = runner({ command: 'worker', args: [], cwd: '.', timeoutMs: 10_000, env: {} })
    const rejected = expect(work).rejects.toBeInstanceOf(ProcessCleanupError)
    handle.stdout.end(); handle.stderr.end(); handle.exited.resolve({ exitCode: 0, signal: null }); handle.quiescent.resolve(true)
    await rejected
    expect(handle.terminateSpy).toHaveBeenCalled()
  })

  it('quarantines a provider that omits the range declaration', async () => {
    const handle = fakeHandle(undefined)
    const runner = managedProcessRunner({ spawn: () => handle, resolveExecutable: async value => value },
      { maxOutputBytes: 1024, terminationGraceMs: 100 })
    const work = runner({ command: 'worker', args: [], cwd: '.', timeoutMs: 10_000, env: {} })
    const rejected = expect(work).rejects.toBeInstanceOf(ProcessCleanupError)
    handle.stdout.end(); handle.stderr.end(); handle.exited.resolve({ exitCode: 0, signal: null }); handle.quiescent.resolve(true)
    await rejected
    expect(handle.terminateSpy).toHaveBeenCalled()
  })

  it('reports unconfirmed cleanup when the range is not empty', async () => {
    const handle = fakeHandle('owned')
    const runner = managedProcessRunner({ spawn: () => handle, resolveExecutable: async value => value },
      { maxOutputBytes: 1024, terminationGraceMs: 100 })
    const work = runner({ command: 'worker', args: [], cwd: '.', timeoutMs: 10_000, env: {} })
    const rejected = expect(work).rejects.toBeInstanceOf(ProcessCleanupError)
    handle.stdout.end(); handle.stderr.end(); handle.exited.resolve({ exitCode: 0, signal: null }); handle.quiescent.resolve(false)
    await rejected
  })

  it('quarantines a direct-child range while a real grandchild still runs', async () => {
    const root = await scratch()
    const pidFile = path.join(root, 'grandchild.pid')
    const fixture = path.join(import.meta.dirname, 'runtime-survivor.fixture.mjs')
    const child = spawn(process.execPath, [fixture, pidFile], {
      cwd: tmpdir(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    })
    const done = new Promise<SubprocessOutcome>((resolve, reject) => {
      child.once('exit', (exitCode, signal) => { resolve({ exitCode, signal }) })
      child.once('error', reject)
    })
    const handle: SubprocessHandle = {
      stdin: undefined, stdout: child.stdout ?? undefined, stderr: child.stderr ?? undefined,
      control: undefined, collected: {},
      rangeScope: 'direct-child', done,
      terminate: () => { /* the direct-child range has no descendant handle */ },
      waitForExit: async () => { await done.catch(() => {}); return true },
    }
    const runner = managedProcessRunner({ spawn: () => handle, resolveExecutable: async value => value },
      { maxOutputBytes: 4096, terminationGraceMs: 100 })
    let grandchild: number | undefined
    try {
      await expect(runner({ command: process.execPath, args: [], cwd: root, timeoutMs: 10_000, env: {} }))
        .rejects.toBeInstanceOf(ProcessCleanupError)
      grandchild = Number((await readFile(pidFile, 'utf8')).trim())
      expect(Number.isSafeInteger(grandchild) && grandchild > 0).toBe(true)
      expect(pidAlive(grandchild)).toBe(true)
    } finally {
      if (grandchild !== undefined) await terminatePid(grandchild)
      await rm(root, { recursive: true, force: true })
    }
  })
})

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function terminatePid(pid: number): Promise<void> {
  try { process.kill(pid, 'SIGKILL') } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
  for (let attempt = 0; attempt < 100 && pidAlive(pid); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  expect(pidAlive(pid)).toBe(false)
}

describe('structured termination', () => {
  function abortableRunner(rangeScope: 'owned' | 'direct-child' | undefined = 'owned'): { runner: ReturnType<typeof managedProcessRunner>; spawn: ReturnType<typeof vi.fn> } {
    const spawn = vi.fn((request: SubprocessSpawnSpec): SubprocessHandle => {
      const exited = Promise.withResolvers<SubprocessOutcome>()
      const stdout = new PassThrough(), stderr = new PassThrough()
      stdout.end(); stderr.end()
      request.signal?.addEventListener('abort', () => { exited.resolve({ exitCode: 1, signal: null }) }, { once: true })
      return { stdin: undefined, stdout, stderr, control: undefined, collected: {},
        ...rangeScope === undefined ? {} : { rangeScope },
        done: exited.promise, terminate: () => {}, waitForExit: async () => true }
    })
    return { spawn, runner: managedProcessRunner({ spawn, resolveExecutable: async value => value },
      { maxOutputBytes: 1024, terminationGraceMs: 100 }) }
  }

  it('classifies a deadline as a timeout while running', async () => {
    const { runner } = abortableRunner()
    await expect(runner({ command: 'worker', args: [], cwd: '.', timeoutMs: 20, env: {} }))
      .rejects.toMatchObject({ name: 'WorkerTerminationError', reason: 'timeout', phase: 'running' })
  })

  it('classifies an external abort as cancellation while running', async () => {
    const { runner } = abortableRunner()
    const controller = new AbortController()
    const work = runner({ command: 'worker', args: [], cwd: '.', timeoutMs: 10_000, env: {}, signal: controller.signal })
    setTimeout(() => { controller.abort() }, 20)
    await expect(work).rejects.toMatchObject({ name: 'WorkerTerminationError', reason: 'cancelled', phase: 'running' })
  })

  it('rejects an already-cancelled run before spawning', async () => {
    const { runner, spawn } = abortableRunner()
    const controller = new AbortController()
    controller.abort()
    await expect(runner({ command: 'worker', args: [], cwd: '.', timeoutMs: 10_000, env: {}, signal: controller.signal }))
      .rejects.toMatchObject({ name: 'WorkerTerminationError', reason: 'cancelled', phase: 'before-spawn' })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('quarantines cancellation when the provider cannot prove descendant termination', async () => {
    const { runner } = abortableRunner('direct-child')
    const controller = new AbortController()
    const work = runner({ command: 'worker', args: [], cwd: '.', timeoutMs: 10_000, env: {}, signal: controller.signal })
    setTimeout(() => { controller.abort() }, 20)
    await expect(work).rejects.toBeInstanceOf(ProcessCleanupError)
  })

  it('carries a printable, cause-specific message without output contents', async () => {
    const error = new WorkerTerminationError('output-limit', 'running')
    expect(error.message).toContain('output byte limit')
    expect(error.reason).toBe('output-limit')
    expect(error.phase).toBe('running')
  })
})

describe('cli resolution', () => {
  it('runs built JavaScript under the current Node binary', () => {
    const invocation = resolveInvocation('D:\\dsh\\apps\\cli\\lib\\bin.js')
    expect(invocation.command).toBe(process.execPath)
    expect(invocation.prefixArgs[0]).toMatch(/bin\.js$/u)
  })

  it('accepts an executable and a bare PATH command', () => {
    expect(resolveInvocation('C:\\tools\\dsh.exe')).toEqual({ command: 'C:\\tools\\dsh.exe', prefixArgs: [] })
    expect(resolveInvocation('dsh')).toEqual({ command: 'dsh', prefixArgs: [] })
  })

  it.each([
    ['C:\\src\\bin.ts', /TypeScript source entry/u],
    ['C:\\tools\\dsh.cmd', /batch shim/u],
    ['C:\\tools\\dsh.bat', /batch shim/u],
    ['C:\\tools\\dsh.ps1', /unsupported extension/u],
  ])('rejects unsupported entry %s before launch', (value, message) => {
    expect(() => resolveInvocation(value)).toThrow(message)
  })

  it('rejects an unsupported entry before invoking the runner', async () => {
    let called = false
    await expect(runHandoff(resolveOptions({ cliPath: 'C:\\tools\\dsh.cmd' }), { task: 'work' }, async () => {
      called = true
      return { code: 0, signal: null, stdout: '', stderr: '' }
    })).rejects.toThrow(/batch shim/u)
    expect(called).toBe(false)
  })
})

describe('describeExecution', () => {
  it('reports configured profile, CLI, permission, endpoints, and containment limits', async () => {
    const root = await scratch()
    const options = resolveOptions({
      dshPath: root, cliPath: path.join(root, 'apps', 'cli', 'lib', 'bin.js'), profile: 'cluster',
      permissionMode: 'workspace-write', apiEndpoint: 'http://127.0.0.1:47890', dashboardEndpoint: 'http://127.0.0.1:47891',
    })
    const description = await describeExecution(options)
    expect(description).toMatchObject({
      profile: 'cluster',
      cli: { configured: options.cliPath, kind: 'node-entry' },
      permission: { mode: 'workspace-write', childProfileVerified: false },
      endpoints: { api: 'http://127.0.0.1:47890', dashboard: 'http://127.0.0.1:47891' },
      dshPath: { configured: root, exists: true },
    })
    expect(description.cli.launch).toContain(process.execPath)
    expect(description.containment.limits.join(' ')).toContain('WSL')
    expect(JSON.stringify(description)).not.toContain('token')
  })

  it('reports an unsupported CLI and a missing working directory without throwing', async () => {
    const missing = path.join(tmpdir(), `deep-cluster-missing-${String(Date.now())}`)
    const description = await describeExecution(resolveOptions({ dshPath: missing, cliPath: 'C:\\tools\\dsh.cmd' }))
    expect(description.cli).toMatchObject({ kind: 'unsupported', launch: null })
    expect(description.cli.diagnostic).toMatch(/batch shim/u)
    expect(description.dshPath).toEqual({ configured: missing, exists: false })
  })
})
