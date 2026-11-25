/** Tool policy decisions reach the real waterfall, and disposal owns every running decision program. */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SubprocessRuntime, type SubprocessHandle, type SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { ProcessResult, ProcessRunner } from '../src/executor.ts'
import { Journal } from '../src/journal.ts'
import * as policy from '../src/policy.ts'

const mocked = vi.hoisted(() => ({ runner: vi.fn<ProcessRunner>() }))
vi.mock('../src/executor.ts', async original => ({
  ...await original<typeof import('../src/executor.ts')>(),
  managedProcessRunner: () => mocked.runner,
}))

class UnusedSubprocess extends SubprocessRuntime {
  resolveExecutable(): Promise<string> { return Promise.reject(new Error('Unexpected executable lookup')) }
  terminalEnvironment() { return Promise.resolve({ platform: 'posix' as const }) }
  spawn(): SubprocessHandle { throw new Error('Unexpected native spawn') }
  spawnTerminal(): Promise<SubprocessTerminalHandle> { return Promise.reject(new Error('Unexpected terminal spawn')) }
}

function output(stdout: string): ProcessResult { return { code: 0, stdout, stderr: '', signal: null } }

async function fixture(stdout: string) {
  mocked.runner.mockReset().mockResolvedValue(output(stdout))
  const root = await mkdtemp(path.join(os.tmpdir(), 'deep-cluster-tool-policy-'))
  const file = path.join(root, 'policy.json'), ctx = new Context(), executed = vi.fn(async () => 'executed')
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  })
  await writeFile(file, JSON.stringify({ workspace: root, runId: 'policy-test', terminationGraceMs: 1000,
    hooks: [{ id: 'host-policy', command: 'trusted-policy', args: [], events: ['tool'], timeoutMs: 1000,
      maxInputBytes: 4096, maxOutputBytes: 1024 }] }))
  vi.stubEnv('DSH_DEEP_CLUSTER_POLICY_FILE', file)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(UnusedSubprocess)
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'mutate', description: 'fixture side effect', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: executed })))
  await ctx.plugin(policy)
  return { root, ctx, executed, invoke: () => ctx.tools.execute({ callId: ToolCallId('policy-call'), name: 'mutate',
    arguments: {}, signal: new AbortController().signal }), journal: new Journal(root) }
}

it('delegates an allowed action and records its policy decision before tool execution', async () => {
  const h = await fixture('{"decision":"allow","reason":"Host permits this action"}')
  h.executed.mockImplementationOnce(async () => {
    expect(mocked.runner).toHaveBeenCalledOnce()
    return 'executed'
  })
  expect(await h.invoke()).toMatchObject({ content: [{ type: 'text', text: 'executed' }] })
  expect(h.executed).toHaveBeenCalledOnce()
  expect(await h.journal.read()).toMatchObject([{ type: 'policy/decision', data: {
    runId: 'policy-test', hookId: 'host-policy', event: 'tool', decision: 'allow', reason: 'Host permits this action',
  } }])
})

it.each([
  { stdout: '{"decision":"deny","reason":"Host refuses this action"}', decision: 'deny' },
  { stdout: '{"decision":"require-review","reason":"Review required"}', decision: 'require-review' },
  { stdout: 'broken decision', decision: 'error' },
])('prevents actual execution for a $decision policy result', async ({ stdout, decision }) => {
  const h = await fixture(stdout)
  const result = await h.invoke()
  expect(result.isError).toBe(true)
  expect(result.content[0]).toMatchObject({ type: 'text' })
  expect(JSON.stringify(result.content)).toContain('Policy host-policy:')
  expect(h.executed).not.toHaveBeenCalled()
  expect(await h.journal.read()).toMatchObject([{ type: 'policy/decision', data: { decision } }])
  expect(await readdir(path.join(h.root, '.deep-cluster', 'policy-inputs'))).toEqual([])
})

it('aborts and joins a running policy program before disposing its context', async () => {
  const h = await fixture('{"decision":"allow","reason":"Late response"}')
  const entered = Promise.withResolvers<{ file: string; signal: AbortSignal }>()
  const release = Promise.withResolvers<ProcessResult>()
  mocked.runner.mockImplementationOnce((spec) => {
    const file = spec.env.DEEPCLUSTER_POLICY_REQUEST_FILE
    if (file === undefined || spec.signal === undefined) throw new Error('Missing owned policy input or signal')
    entered.resolve({ file, signal: spec.signal })
    return release.promise
  })
  const work = h.invoke(), input = await entered.promise
  const abort = Promise.withResolvers<undefined>()
  input.signal.addEventListener('abort', () => { abort.resolve(undefined) }, { once: true })
  const disposing = h.ctx.fiber.dispose()
  await abort.promise
  expect(await Promise.race([disposing.then(() => 'disposed'), Promise.resolve('pending')])).toBe('pending')
  expect(JSON.parse(await readFile(input.file, 'utf8'))).toMatchObject({ event: 'tool', subject: { name: 'mutate', arguments: {} } })
  release.resolve(output('{"decision":"allow","reason":"Late response"}'))
  expect(await work).toMatchObject({ isError: true })
  await disposing
  expect(h.executed).not.toHaveBeenCalled()
  expect(await readdir(path.join(h.root, '.deep-cluster', 'policy-inputs'))).toEqual([])
})
