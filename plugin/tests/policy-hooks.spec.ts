/** Trusted policy programs receive bounded private input and cannot allow actions after failure or cancellation. */
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { executePolicyHooks, type PolicyHook } from '../src/policy-hooks.ts'
import { ProcessCleanupError, type ProcessResult, type ProcessRunner } from '../src/executor.ts'

const hook: PolicyHook = { id: 'host-check', command: 'trusted-check', args: ['literal', '$not-interpolated'],
  events: ['admission', 'tool'], timeoutMs: 1234, maxInputBytes: 4096, maxOutputBytes: 1024 }

function result(stdout = '{"decision":"allow","reason":"Checked"}', code = 0): ProcessResult {
  return { code, stdout, stderr: '', signal: null }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'deep-cluster-policy-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  return { root, input: { event: 'admission' as const, workspace: root, subject: { command: 'untrusted; do not interpolate' } },
    signal: new AbortController().signal, inputs: () => readdir(path.join(root, '.deep-cluster', 'policy-inputs')) }
}

it('passes fixed argv and complete subject through a private file, then removes it after joined completion', async () => {
  const h = await fixture()
  const runner = vi.fn<ProcessRunner>(async (spec) => {
    expect(spec).toMatchObject({ command: hook.command, args: hook.args, cwd: h.root, timeoutMs: hook.timeoutMs, signal: h.signal })
    expect(spec.env.DSH_DEEP_CLUSTER_POLICY_FILE).toBeUndefined()
    const file = spec.env.DEEPCLUSTER_POLICY_REQUEST_FILE
    if (file === undefined) throw new Error('Expected private input path')
    expect(path.dirname(file)).toBe(path.join(h.root, '.deep-cluster', 'policy-inputs'))
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(h.input)
    return result()
  })
  expect(await executePolicyHooks([hook], h.input, () => runner, h.signal))
    .toEqual([{ hookId: hook.id, event: 'admission', decision: 'allow', reason: 'Checked' }])
  expect(await h.inputs()).toEqual([])
})

it.each(['deny', 'require-review'] as const)('filters events and stops at the first %s decision', async (decision) => {
  const h = await fixture(), seen: string[] = []
  const hooks = [{ ...hook, id: 'wrong-event', events: ['tool'] as const }, { ...hook, id: 'allow' },
    { ...hook, id: 'refuse' }, { ...hook, id: 'unreached' }]
  const decisions = await executePolicyHooks(hooks.map(item => ({ ...item, events: [...item.events] })), h.input, item => () => {
    seen.push(item.id)
    return Promise.resolve(result(JSON.stringify({ decision: item.id === 'allow' ? 'allow' : decision, reason: 'Host decision' })))
  }, h.signal)
  expect(seen).toEqual(['allow', 'refuse'])
  expect(decisions.map(item => item.decision)).toEqual(['allow', decision])
  expect(await h.inputs()).toEqual([])
})

it.each([
  result('not-json'), result('{"decision":"allow","reason":""}'), result('{"decision":"allow","reason":"ok","override":true}'),
  result('{"decision":"allow","reason":"ok"} trailing'), result('x'.repeat(1025)), result(undefined, 1), result(undefined, 124),
])('refuses malformed, oversized, nonzero and timeout program results', async (output) => {
  const h = await fixture()
  const decisions = await executePolicyHooks([hook], h.input, () => () => Promise.resolve(output), h.signal)
  expect(decisions).toHaveLength(1)
  expect(decisions[0]).toMatchObject({ hookId: hook.id, event: 'admission', decision: 'error' })
  expect(decisions[0]?.reason).toContain('refused')
  expect(await h.inputs()).toEqual([])
})

it('refuses input over budget before creating a file or starting a program', async () => {
  const h = await fixture(), runnerFor = vi.fn<() => ProcessRunner>()
  expect(await executePolicyHooks([{ ...hook, maxInputBytes: 1 }], h.input, runnerFor, h.signal))
    .toMatchObject([{ decision: 'error' }])
  expect(runnerFor).not.toHaveBeenCalled()
  expect(await readdir(h.root)).toEqual([])
})

it('keeps input available until an aborted managed process settles and refuses its late allow response', async () => {
  const h = await fixture(), entered = deferred<string>(), released = deferred<ProcessResult>(), abort = new AbortController()
  const runner: ProcessRunner = (spec) => {
    const file = spec.env.DEEPCLUSTER_POLICY_REQUEST_FILE
    if (file === undefined) throw new Error('Expected input file')
    entered.resolve(file)
    return released.promise
  }
  const work = executePolicyHooks([hook], h.input, () => runner, abort.signal)
  const refused = expect(work).rejects.toMatchObject({ name: 'AbortError' })
  const file = await entered.promise
  abort.abort()
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(h.input)
  released.resolve(result())
  await refused
  expect(await h.inputs()).toEqual([])
})

it('retains policy input when native process cleanup remains unconfirmed', async () => {
  const h = await fixture(), failure = new ProcessCleanupError('range may still be alive')
  await expect(executePolicyHooks([hook], h.input, () => () => Promise.reject(failure), h.signal)).rejects.toBe(failure)
  const files = await h.inputs()
  expect(files).toHaveLength(1)
  expect(JSON.parse(await readFile(path.join(h.root, '.deep-cluster', 'policy-inputs', files[0]!), 'utf8'))).toEqual(h.input)
})

it('contains ordinary program startup errors and never invokes later hooks', async () => {
  const h = await fixture(), runnerFor = vi.fn<() => ProcessRunner>(() => () => Promise.reject(new Error('private failure text')))
  expect(await executePolicyHooks([hook, { ...hook, id: 'next' }], h.input, runnerFor, h.signal)).toMatchObject([{ decision: 'error' }])
  expect(runnerFor).toHaveBeenCalledTimes(1)
  expect(await h.inputs()).toEqual([])
})
