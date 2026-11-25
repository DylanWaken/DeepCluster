/** Handoff, installation, and MCP-protocol contracts for DeepCluster. */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { load } from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveOptions, skillMarkdown } from '../src/assets.ts'
import { buildPrompt, childEnvironment, resolveInvocation, runHandoff } from '../src/executor.ts'
import { describeTargets, installPlannerAssets } from '../src/install.ts'
import { dispatch, serveStdio } from '../src/mcp.ts'
import type { DeepClusterOptions, HandoffRequest, HandoffResult } from '../src/types.ts'

const temporary: string[] = []

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'deep-cluster-'))
  temporary.push(dir)
  return dir
}

function optionsIn(root: string, overrides: Partial<DeepClusterOptions> = {}): DeepClusterOptions {
  return {
    ...resolveOptions(),
    cursorSkillsRoot: path.join(root, 'cursor'),
    codexSkillsRoot: path.join(root, 'codex'),
    ...overrides,
  }
}

it('keeps the packaged skill aligned with the default installer output', async () => {
  const packaged = await readFile(new URL('../skills/DeepCluster/SKILL.md', import.meta.url), 'utf8')
  expect(packaged).toBe(skillMarkdown(resolveOptions()))
})

it('packages the single-request service, plan, and review contract', async () => {
  const packaged = await readFile(new URL('../skills/DeepCluster/SKILL.md', import.meta.url), 'utf8')
  for (const required of [
    '## Ensure the service',
    'service start',
    'without credentials',
    '## Delegate in one request',
    'text/markdown',
    'view=report',
    '`wait` holds the response',
    '## Plan format',
    'acceptance:',
    '## Review the report',
    'checks',
    'changed',
    'auditProblem',
    '/v1/ack',
    '/v1/ledger',
    'serviceCliPath',
    '## Saved connection',
  ]) expect(packaged).toContain(required)
})

const defaultDescription = 'Delegate small tasks and routine operations to local DSH workers, including file discovery, focused reads, searches, routine edits, tests, builds, lint, data collection, log inspection and profiling. Use when asked to delegate or when a worker can perform a bounded task whose result you can check.'

function parseFrontmatter(markdown: string): Record<string, unknown> {
  const match = /^---\n([\s\S]*?)\n---\n/u.exec(markdown)
  if (match?.[1] === undefined) throw new Error('skill markdown has no YAML frontmatter')
  return load(match[1]) as Record<string, unknown>
}

it('provides the same client-neutral description in the generated and packaged skills', async () => {
  const packaged = await readFile(new URL('../skills/DeepCluster/SKILL.md', import.meta.url), 'utf8')
  for (const markdown of [skillMarkdown(resolveOptions(), 'codex'), packaged]) {
    expect(parseFrontmatter(markdown)).toEqual({ name: 'DeepCluster', description: defaultDescription })
  }
})

describe('buildPrompt', () => {
  it('returns a bare task unchanged', () => {
    expect(buildPrompt({ task: '  run the tests  ' })).toBe('run the tests')
  })

  it('puts the plan under an execution preamble', () => {
    const prompt = buildPrompt({ task: 'add a flag', plan: '1. edit cli.ts\n2. run tests' })
    expect(prompt).toContain('add a flag')
    expect(prompt).toContain('An approved plan follows')
    expect(prompt.indexOf('An approved plan')).toBeLessThan(prompt.indexOf('1. edit cli.ts'))
  })

  it('rejects a blank task', () => {
    expect(() => buildPrompt({ task: '   ' })).toThrow(/non-blank task/u)
  })
})

describe('resolveInvocation', () => {
  it('runs a JavaScript entry under the current Node binary', () => {
    const invocation = resolveInvocation('D:\\dsh\\apps\\cli\\lib\\bin.js')
    expect(invocation.command).toBe(process.execPath)
    expect(invocation.prefixArgs).toHaveLength(1)
    expect(invocation.prefixArgs[0]).toMatch(/bin\.js$/u)
  })

  it('treats a bare name as a command from PATH', () => {
    expect(resolveInvocation('dsh')).toEqual({ command: 'dsh', prefixArgs: [] })
  })

  it('accepts an executable entry', () => {
    expect(resolveInvocation('C:\\tools\\dsh.exe')).toEqual({ command: 'C:\\tools\\dsh.exe', prefixArgs: [] })
  })

  it.each([
    ['C:\\src\\bin.ts', /TypeScript source entry/u],
    ['C:\\tools\\dsh.cmd', /batch shim/u],
    ['C:\\tools\\dsh.bat', /batch shim/u],
    ['C:\\tools\\dsh.ps1', /unsupported extension/u],
  ])('rejects unsupported entry %s before launch', (value, message) => {
    expect(() => resolveInvocation(value)).toThrow(message)
  })

  it('rejects a blank entry', () => {
    expect(() => resolveInvocation('  ')).toThrow(/cliPath must not be blank/u)
  })
})

it('accepts a separate service CLI entry and rejects a blank one', () => {
  const options = resolveOptions({ cliPath: 'C:\\tools\\worker-wrapper.exe', serviceCliPath: 'C:\\tools\\dsh.exe' })
  expect(options.cliPath).toBe('C:\\tools\\worker-wrapper.exe')
  expect(options.serviceCliPath).toBe('C:\\tools\\dsh.exe')
  expect(() => resolveOptions({ serviceCliPath: '   ' })).toThrow(/serviceCliPath must not be blank/u)
})

describe('childEnvironment', () => {
  it('drops an inherited DSH_PROFILE so the executor keeps its own profile', () => {
    const env = childEnvironment({ DSH_PROFILE: 'web', PATH: '/bin' })
    expect(env.DSH_PROFILE).toBeUndefined()
    expect(env.PATH).toBe('/bin')
  })

  it('defaults DeepCluster workers to full access independently of the parent profile', () => {
    expect(childEnvironment({}).DSH_PERMISSION_MODE).toBe('danger-full-access')
    expect(childEnvironment({ DSH_PERMISSION_MODE: 'workspace-write' }).DSH_PERMISSION_MODE).toBe('danger-full-access')
  })

  it('keeps an explicit mode', () => {
    expect(childEnvironment({}, 'workspace-write').DSH_PERMISSION_MODE).toBe('workspace-write')
  })
})

describe('runHandoff', () => {
  it('passes the task, plan, profile, and directory to the runner', async () => {
    const seen: { command: string; args: readonly string[]; cwd: string; timeoutMs: number }[] = []
    const options = resolveOptions({ cliPath: 'dsh', profile: 'cluster', timeoutMs: 5_000 })
    const result = await runHandoff(options, { task: 'do it', plan: '1. go', cwd: tmpdir() }, async (spec) => {
      seen.push({ command: spec.command, args: spec.args, cwd: spec.cwd, timeoutMs: spec.timeoutMs })
      return { code: 0, signal: null, stdout: 'done\n', stderr: '' }
    })
    expect(result.ok).toBe(true)
    expect(result.stdout).toBe('done\n')
    const call = seen[0]
    expect(call?.command).toBe('dsh')
    expect(call?.args.slice(0, 2)).toEqual(['--profile', 'cluster'])
    expect(call?.args.at(-1)).toContain('1. go')
    expect(call?.timeoutMs).toBe(5_000)
  })

  it('keeps worker execution on cliPath when a separate service CLI is configured', async () => {
    const seen: { command: string; args: readonly string[] }[] = []
    const options = resolveOptions({ cliPath: 'C:\\tools\\worker-wrapper.exe',
      serviceCliPath: 'C:\\tools\\dsh.exe', profile: 'cluster' })
    await runHandoff(options, { task: 'do it' }, async (spec) => {
      seen.push({ command: spec.command, args: spec.args })
      return { code: 0, signal: null, stdout: 'done\n', stderr: '' }
    })
    expect(seen[0]?.command).toBe('C:\\tools\\worker-wrapper.exe')
    expect(seen[0]?.args.slice(0, 2)).toEqual(['--profile', 'cluster'])
  })

  it('reports a failed run as not ok and keeps its code', async () => {
    const options = resolveOptions({ cliPath: 'dsh' })
    const result = await runHandoff(options, { task: 'do it' }, async () => ({
      code: 1,
      signal: null,
      stdout: '',
      stderr: 'boom',
    }))
    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toBe('boom')
  })

  it('forwards --json only when asked', async () => {
    const options = resolveOptions({ cliPath: 'dsh' })
    const calls: (readonly string[])[] = []
    const record = async (spec: { args: readonly string[] }) => {
      calls.push(spec.args)
      return { code: 0, signal: null, stdout: '', stderr: '' }
    }
    await runHandoff(options, { task: 'a' }, record)
    await runHandoff(options, { task: 'a', json: true }, record)
    expect(calls[0]).not.toContain('--json')
    expect(calls[1]).toContain('--json')
  })
})

describe('installPlannerAssets', () => {
  it('writes one skill per planner and reports it', async () => {
    const root = await scratch()
    const options = optionsIn(root)
    const report = await installPlannerAssets(options)
    expect(report.written).toHaveLength(2)
    const expected = describeTargets(options).map(target => target.file)
    expect(new Set(report.written)).toEqual(new Set(expected))
    const body = await readFile(expected[0] as string, 'utf8')
    expect(parseFrontmatter(body).name).toBe('DeepCluster')
  })

  it('is idempotent', async () => {
    const root = await scratch()
    const options = optionsIn(root, { serviceCliPath: path.join(root, 'dsh.exe') })
    await installPlannerAssets(options, ['cursor'])
    const second = await installPlannerAssets(options, ['cursor'])
    expect(second.written).toEqual([])
    expect(second.unchanged).toHaveLength(1)
  })

  it('can target a single planner', async () => {
    const root = await scratch()
    const report = await installPlannerAssets(optionsIn(root), ['codex'])
    expect(report.written[0]).toContain('codex')
  })

  it('preserves an installed connection that the caller did not supply', async () => {
    const root = await scratch()
    const options = optionsIn(root)
    const file = describeTargets(options)[1]!.file
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, [
      '## Saved connection', '',
      'apiEndpoint: http://127.0.0.1:4999',
      'dashboardEndpoint: http://127.0.0.1:4998',
      'dshPath: D:/saved/checkout',
      'dashboardWorkspace: D:/saved/workspace',
      'dashboardWorkspaces: ["D:/saved/extra"]',
      '## Ensure the service',
      'keep the user first-use URL preference', '',
    ].join('\n'))
    await installPlannerAssets(options, ['codex'])
    const body = await readFile(file, 'utf8')
    expect(body).toContain('apiEndpoint: http://127.0.0.1:4999')
    expect(body).toContain('dshPath: D:/saved/checkout')
    expect(body).toContain('dashboardWorkspace: D:/saved/workspace')
    expect(body).toContain('dashboardWorkspaces: ["D:/saved/extra"]')
    expect(body).toContain('## Ensure the service')
  })
})

describe('skillMarkdown', () => {
  it('names the configured command and keeps the planner from editing', () => {
    const text = skillMarkdown(resolveOptions({ commandName: 'cluster-develop' }), 'cursor')
    expect(parseFrontmatter(text).name).toBe('cluster-develop')
    expect(text).toContain('You own scope, acceptance, verification, and the final answer')
    expect(text).toContain('<apiEndpoint>/v1/runs')
    expect(text).toContain('view=report')
    expect(text).not.toContain('dsh --profile deep-cluster coordinate')
  })

  it('differs per planner', () => {
    const options = resolveOptions()
    expect(skillMarkdown(options, 'cursor')).not.toBe(skillMarkdown(options, 'codex'))
  })
})

describe('MCP dispatch', () => {
  const options = resolveOptions({ profile: 'cluster', cliPath: 'dsh' })

  const fakeRun = async (request: HandoffRequest): Promise<HandoffResult> => ({
    ok: true,
    exitCode: 0,
    signal: null,
    stdout: `executed: ${request.task}`,
    stderr: '',
    durationMs: 1,
    command: 'dsh cluster ...',
  })

  it('answers initialize with a protocol version and tools capability', async () => {
    const response = await dispatch({ options, run: fakeRun }, { jsonrpc: '2.0', id: 1, method: 'initialize' })
    expect(response?.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} } })
  })

  it('lists cluster_run and cluster_info', async () => {
    const response = await dispatch({ options, run: fakeRun }, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const names = (response?.result as { tools: { name: string }[] }).tools.map(tool => tool.name)
    expect(names).toEqual(['cluster_run', 'cluster_info'])
  })

  it('runs a handoff and returns its output', async () => {
    const response = await dispatch({ options, run: fakeRun }, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'cluster_run', arguments: { task: 'refactor auth', plan: '# Test\ngoal: refactor' } },
    })
    const result = response?.result as { content: { text: string }[]; isError: boolean }
    expect(result.isError).toBe(false)
    expect(result.content[0]?.text).toBe('executed: refactor auth')
  })

  it('rejects an unknown tool without throwing', async () => {
    const response = await dispatch({ options, run: fakeRun }, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'nope', arguments: {} },
    })
    expect(response?.error?.code).toBe(-32602)
  })

  it('preserves the caller submission key and structured task fields for an HTTP retry', async () => {
    const requests: HandoffRequest[] = []
    const args = { task: 'inspect evidence', plan: '# Evidence\ngoal: inspect', cwd: '/fixture', timeoutMs: 2000,
      idempotencyKey: 'same-request-key' }
    const response = await dispatch({ options, run: async (request) => { requests.push(request); return await fakeRun(request) } }, {
      jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'cluster_run', arguments: args },
    })
    expect(requests).toEqual([args])
    expect(response?.result).toMatchObject({ isError: false })
  })

  it.each(['', 'key with spaces', 'x'.repeat(129), 'key\nheader'])('rejects invalid submission key %j before dispatch', async (idempotencyKey) => {
    let called = false
    const response = await dispatch({ options, run: async (request) => { called = true; return await fakeRun(request) } }, {
      jsonrpc: '2.0', id: 10, method: 'tools/call',
      params: { name: 'cluster_run', arguments: { task: 'inspect', plan: 'plan', idempotencyKey } },
    })
    expect(called).toBe(false)
    expect(response?.result).toMatchObject({ isError: true })
  })

  it('ignores notifications', async () => {
    expect(await dispatch({ options, run: fakeRun }, { jsonrpc: '2.0', method: 'notifications/initialized' }))
      .toBeUndefined()
  })

  it('rejects malformed envelopes and continues with the next complete request', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let text = ''
    output.on('data', (chunk) => { text += String(chunk) })
    const work = serveStdio({ options, run: fakeRun }, input, output)
    input.end('null\n{broken\n{"jsonrpc":"2.0","id":7,"method":"ping"}\n')
    await work
    const responses = text.trim().split('\n').map((line): unknown => JSON.parse(line))
    expect(responses).toMatchObject([
      { error: { code: -32600 } }, { error: { code: -32700 } }, { id: 7, result: {} },
    ])
  })

  it('stops waiting for idle input when its owner is disposed', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const abort = new AbortController()
    const work = serveStdio({ options, run: fakeRun }, input, output, abort.signal)
    abort.abort()
    await work
    expect(input.listenerCount('data')).toBe(0)
    input.destroy(); output.destroy()
  })

  it('rejects invalid timeout arguments instead of silently using a default', async () => {
    const response = await dispatch({ options, run: fakeRun }, {
      jsonrpc: '2.0', id: 8, method: 'tools/call',
      params: { name: 'cluster_run', arguments: { task: 'test', plan: 'plan', timeoutMs: -1 } },
    })
    expect(response?.result).toMatchObject({ isError: true })
  })
})
