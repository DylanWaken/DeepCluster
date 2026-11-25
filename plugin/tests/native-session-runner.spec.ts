/** Exact native Session admission and per-turn policy transport through managed workers. */
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { handoffRunner } from '../src/agents.ts'
import { resolveOptions } from '../src/assets.ts'
import type { AgentRunSpec } from '../src/coordinator.ts'
import { childEnvironment, runHandoff, type ProcessRunner } from '../src/executor.ts'
import type { RunId } from '../src/types.ts'

const sessionId = brandString<SessionId>('supervisor-session')
const options = resolveOptions({ cliPath: 'dsh' })
const spec: AgentRunSpec = {
  runId: 'native-session-run' as RunId, stepId: 'review', role: 'reviewer', prompt: 'Review the implementation',
  cwd: process.cwd(), timeoutMs: 10_000, nativeSession: { mode: 'resume', id: sessionId },
}

function outputRunner(chunks: readonly string[], code = 0, stderr = ''): ProcessRunner {
  return async (request) => {
    for (const chunk of chunks) request.onStdout?.(chunk)
    return { code, signal: null, stdout: chunks.join(''), stderr }
  }
}

describe('native worker Session identity', () => {
  it.each(['create', 'resume'] as const)('launches the exact %s identity without a fallback', async (mode) => {
    await runHandoff(options, { task: 'Inspect', nativeSession: { mode, id: sessionId }, json: true }, async (request) => {
      expect(request.args).toEqual(['--profile', options.profile, mode === 'create' ? '--new-session-id' : '--session-id', sessionId, '--json', 'Inspect'])
      return { code: 0, signal: null, stdout: '', stderr: '' }
    })
  })

  it('accepts one matching opening event split across chunks and a final line without newline', async () => {
    const runner = handoffRunner(options, outputRunner([
      'profile diagnostic\n{"type":"sess', `ion","sessionId":"${sessionId}"}\n`, '{"type":"final","text":"reviewed"}',
    ]))
    expect(await runner(spec)).toMatchObject({ ok: true, output: 'reviewed' })
  })

  it.each([
    { name: 'missing', chunks: [], code: 'worker-session-missing' },
    { name: 'wrong', chunks: ['{"type":"session","sessionId":"other"}\n'], code: 'worker-session-mismatch' },
    { name: 'missing field', chunks: ['{"type":"session"}\n'], code: 'worker-session-mismatch' },
    { name: 'duplicate', chunks: [`{"type":"session","sessionId":"${sessionId}"}\n`.repeat(2)], code: 'worker-session-duplicate' },
    { name: 'late', chunks: ['{"type":"final","text":"untrusted"}\n'], code: 'worker-session-missing' },
  ])('rejects $name identity evidence', async ({ chunks, code }) => {
    await expect(handoffRunner(options, outputRunner(chunks))(spec)).rejects.toMatchObject({ name: 'WorkerSessionError', code })
  })

  it('preserves the startup refusal when no Session can be admitted', async () => {
    const chunks = ['{"type":"error","message":"Session already exists"}\n']
    await expect(handoffRunner(options, outputRunner(chunks, 1))(spec)).rejects.toThrow('Session already exists')
    await expect(handoffRunner(options, outputRunner([], 1, 'profile unavailable'))(spec)).rejects.toThrow('profile unavailable')
  })

  it('keeps ordinary disposable workers independent of an assigned identity', async () => {
    const { nativeSession: _nativeSession, ...disposable } = spec
    expect(await handoffRunner(options, outputRunner(['{"type":"final","text":"done"}\n']))(disposable)).toMatchObject({ ok: true, output: 'done' })
  })
})

describe('worker policy input', () => {
  it('removes inherited policy files and explicitly installs the current file after sanitization', async () => {
    expect(childEnvironment({ DSH_PROFILE: 'web', DSH_DEEP_CLUSTER_POLICY_FILE: 'parent-policy', KEEP: 'value' }))
      .toEqual({ KEEP: 'value', DSH_PERMISSION_MODE: 'danger-full-access' })
    const policyFile = fileURLToPath(new URL('./current-policy.json', import.meta.url))
    const runner: ProcessRunner = async (request) => {
      expect(request.args).toEqual(['--profile', options.profile, '--patch',
        fileURLToPath(new URL('../policy.patch.yml', import.meta.url)), '--session-id', sessionId, '--json', spec.prompt])
      expect(request.env.DSH_DEEP_CLUSTER_POLICY_FILE).toBe(policyFile)
      request.onStdout?.(`{"type":"session","sessionId":"${sessionId}"}\n{"type":"final","text":"done"}\n`)
      return { code: 0, signal: null, stdout: '', stderr: '' }
    }
    expect(await handoffRunner(options, runner)({ ...spec, policyFile })).toMatchObject({ ok: true })
  })

  it('ignores an inherited policy override when no explicit policy was assigned', async () => {
    await runHandoff(options, { task: 'Inspect', env: { DSH_DEEP_CLUSTER_POLICY_FILE: 'inherited' } }, async (request) => {
      expect(request.env.DSH_DEEP_CLUSTER_POLICY_FILE).toBeUndefined()
      expect(request.args).not.toContain('--patch')
      return { code: 0, signal: null, stdout: '', stderr: '' }
    })
  })
})
