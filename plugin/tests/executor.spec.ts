/** Worker completion requires process-range quiescence and complete acceptance evidence. */
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import { managedProcessRunner, ProcessCleanupError } from '../src/executor.ts'
import { parseAgentReport } from '../src/protocol.ts'
import { resolveOptions } from '../src/assets.ts'

function fixture(rangeScope: 'owned' | 'direct-child' | 'absent' = 'owned') {
  const exited = Promise.withResolvers<SubprocessOutcome>()
  const quiescent = Promise.withResolvers<boolean>()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const terminate = vi.fn()
  const handle: SubprocessHandle = {
    stdin: undefined, stdout, stderr, control: undefined, collected: {}, done: exited.promise,
    terminate, waitForExit: () => quiescent.promise,
    ...rangeScope === 'absent' ? {} : { rangeScope },
  }
  const runner = managedProcessRunner({ spawn: () => handle, resolveExecutable: async value => value }, {
    maxOutputBytes: 128, terminationGraceMs: 100,
  })
  const spec = { command: 'worker', args: [], cwd: '.', timeoutMs: 10000, env: {} }
  return { runner, spec, terminate, exited, quiescent, stdout, stderr }
}

describe('managed worker ownership', () => {
  it('holds completion after the direct child exits until its range is empty', async () => {
    const f = fixture()
    let complete = false
    const work = f.runner(f.spec).then((result) => { complete = true; return result })
    f.stdout.end('final'); f.stderr.end()
    f.exited.resolve({ exitCode: 0, signal: null })
    await vi.waitFor(() => { expect(f.terminate).toHaveBeenCalled() })
    expect(complete).toBe(false)
    f.quiescent.resolve(true)
    expect(await work).toMatchObject({ code: 0, stdout: 'final' })
  })

  it('quarantines a provider that does not declare an owned process range', async () => {
    const f = fixture('absent')
    const work = f.runner(f.spec)
    const rejected = expect(work).rejects.toBeInstanceOf(ProcessCleanupError)
    f.stdout.end(); f.stderr.end()
    f.exited.resolve({ exitCode: 0, signal: null })
    await vi.waitFor(() => { expect(f.terminate).toHaveBeenCalled() })
    f.quiescent.resolve(true)
    await rejected
  })

  it('quarantines a direct-child provider even after the range reports empty', async () => {
    const f = fixture('direct-child')
    const work = f.runner(f.spec)
    const rejected = expect(work).rejects.toBeInstanceOf(ProcessCleanupError)
    f.stdout.end(); f.stderr.end()
    f.exited.resolve({ exitCode: 0, signal: null })
    await vi.waitFor(() => { expect(f.terminate).toHaveBeenCalled() })
    f.quiescent.resolve(true)
    await rejected
  })

  it('applies the same owned-range proof when a provider error precedes an outcome', async () => {
    const f = fixture('direct-child')
    const rejected = expect(f.runner(f.spec)).rejects.toBeInstanceOf(ProcessCleanupError)
    f.stdout.end(); f.stderr.end()
    f.exited.reject(new Error('provider exited before reporting an outcome'))
    await vi.waitFor(() => { expect(f.terminate).toHaveBeenCalled() })
    f.quiescent.resolve(true)
    await rejected
  })

  it('applies the same owned-range proof when a stream fails before an outcome', async () => {
    const f = fixture('absent')
    const rejected = expect(f.runner(f.spec)).rejects.toBeInstanceOf(ProcessCleanupError)
    f.stdout.destroy(new Error('stream failed'))
    f.stderr.end()
    f.exited.resolve({ exitCode: 0, signal: null })
    await vi.waitFor(() => { expect(f.terminate).toHaveBeenCalled() })
    f.quiescent.resolve(true)
    await rejected
  })

  it('reports unconfirmed cleanup so the scheduler can retain leases', async () => {
    const f = fixture()
    const work = f.runner(f.spec)
    const rejected = expect(work).rejects.toBeInstanceOf(ProcessCleanupError)
    f.stdout.end(); f.stderr.end()
    f.exited.resolve({ exitCode: 0, signal: null })
    await vi.waitFor(() => { expect(f.terminate).toHaveBeenCalled() })
    f.quiescent.reject(new Error('provider unavailable'))
    await rejected
  })

  it('reports output-limit termination instead of accepting success', async () => {
    const f = fixture()
    const work = f.runner(f.spec)
    const rejected = expect(work).rejects.toMatchObject({ name: 'WorkerTerminationError', reason: 'output-limit', phase: 'running' })
    f.stdout.end('x'.repeat(129)); f.stderr.end()
    f.exited.resolve({ exitCode: 0, signal: null }); f.quiescent.resolve(true)
    await rejected
    expect(f.terminate).toHaveBeenCalled()
  })

  it('quarantines resources when the provider reports its process range is still active', async () => {
    const f = fixture()
    const rejected = expect(f.runner(f.spec)).rejects.toBeInstanceOf(ProcessCleanupError)
    f.stdout.end(); f.stderr.end()
    f.exited.resolve({ exitCode: 0, signal: null }); f.quiescent.resolve(false)
    await rejected
  })

  it('stops and joins stream observers when the provider rejects the direct-child result', async () => {
    const f = fixture()
    const observed = vi.fn()
    const rejected = expect(f.runner({ ...f.spec, onStdout: observed })).rejects.toThrow('direct result failed')
    await vi.waitFor(() => { expect(f.stdout.listenerCount('readable')).toBeGreaterThan(0) })
    f.exited.reject(new Error('direct result failed')); f.quiescent.resolve(true)
    await rejected
    expect(f.stdout.destroyed).toBe(true)
    expect(f.stderr.destroyed).toBe(true)
    f.stdout.write('after settlement')
    expect(observed).not.toHaveBeenCalled()
  })
})

describe('acceptance reports', () => {
  const report = (checks: string) => `[[DEEPCLUSTER]]\nstatus: pass\nsummary: built\nchecks:\n${checks}\nimprovisation: no\n[[/DEEPCLUSTER]]`
  it('requires evidence for every exact acceptance label', () => {
    expect(parseAgentReport(report('- builds: yes, nvcc exit 0'), ['builds']).status).toBe('pass')
    expect(parseAgentReport(report('- builds: yes'), ['builds']).status).toBe('fail')
    expect(parseAgentReport(report('- builds: no, exit 1'), ['builds']).status).toBe('fail')
    expect(parseAgentReport(report('- another check: yes, exit 0'), ['builds']).status).toBe('fail')
    expect(parseAgentReport(report('- builds: yes, exit 0\n- builds: no, exit 1'), ['builds']).status).toBe('fail')
  })
  it('rejects multiple or nonterminal reports', () => {
    expect(() => parseAgentReport(report('- builds: yes, exit 0') + '\ntrailing claim')).toThrow('terminal')
    expect(() => parseAgentReport(report('- builds: yes, exit 0').repeat(2))).toThrow('exactly one')
  })
  it('rejects invalid execution limits and unsafe skill names', () => {
    expect(() => resolveOptions({ timeoutMs: NaN })).toThrow('positive integer')
    expect(() => resolveOptions({ maxOutputBytes: 0 })).toThrow('positive integer')
    expect(() => resolveOptions({ commandName: '../escape' })).toThrow('directory-safe')
  })
})
