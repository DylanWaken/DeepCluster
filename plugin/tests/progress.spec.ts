/** Throughput uses reported tokens and response observation time, excluding later tool execution. */
import { describe, expect, it } from 'vitest'
import { WorkerProgress } from '../src/progress.ts'
import type { AgentActivity, AgentLog, AgentTokenSample, AgentUsage } from '../src/types.ts'

describe('worker telemetry', () => {
  it('logs argument names, safe paths, and result keys without raw tool payloads', () => {
    const entries: AgentLog[] = []
    const progress = new WorkerProgress()
    const observers = { onLog: (entry: AgentLog) => { entries.push(entry) } }
    progress.accept({ type: 'thinking', text: 'private reasoning' }, 0, observers)
    progress.accept({ type: 'tool_call', tool: 'pwsh', input: { command: 'nvcc kernel.cu' } }, 1, observers)
    progress.accept({ type: 'tool_result', status: 'completed', result: 'Compiled kernel' }, 2, observers)
    progress.accept({ type: 'text', text: 'x'.repeat(3000) }, 3, observers)
    expect(entries).toEqual([
      { kind: 'command', text: 'pwsh\narguments: command' },
      { kind: 'tool', text: 'completed' },
      { kind: 'output', text: 'x'.repeat(2000) },
    ])
    expect(JSON.stringify(entries)).not.toContain('private reasoning')
    expect(JSON.stringify(entries)).not.toContain('nvcc kernel.cu')
    expect(JSON.stringify(entries)).not.toContain('Compiled kernel')
  })

  it('never publishes sentinel secrets from write, patch, shell, or file-result payloads', () => {
    const secret = 'synthetic private test content'
    const entries: AgentLog[] = []
    const progress = new WorkerProgress()
    const observers = { onLog: (entry: AgentLog) => { entries.push(entry) } }
    progress.accept({ type: 'tool_call', tool: 'write_file', input: { path: 'D:/work/output.txt', content: secret } }, 0, observers)
    progress.accept({ type: 'tool_call', tool: 'apply_patch', input: `*** Begin Patch\n+${secret}\n*** End Patch` }, 1, observers)
    progress.accept({ type: 'tool_call', tool: 'pwsh', input: { command: `curl -H "Authorization: Bearer ${secret}"`, cwd: 'D:/work' } }, 2, observers)
    progress.accept({ type: 'tool_call', tool: 'read_file', input: JSON.stringify({ file_path: 'D:/work/input.txt' }) }, 3, observers)
    progress.accept({ type: 'tool_result', status: 'completed', result: secret }, 4, observers)
    progress.accept({ type: 'tool_result', status: 'completed', result: { content: secret } }, 5, observers)
    progress.accept({ type: 'tool_call', tool: 'grep', input: { pattern: secret, path: 'D:/work/input.txt' } }, 6, observers)
    progress.accept({ type: 'tool_call', tool: 'web_search', input: { query: secret, file_path: 'D:/work/search.txt' } }, 7, observers)
    progress.accept({ type: 'tool_call', tool: 'glob', input: { glob: `**/*${secret}*`, path: 'D:/work' } }, 8, observers)
    const text = JSON.stringify(entries)
    expect(text).not.toContain(secret)
    expect(text).toContain('D:/work/output.txt')
    expect(text).toContain('D:/work')
    expect(text).toContain('file_path=D:/work/input.txt')
    expect(text).toContain('arguments: pattern, path')
    expect(text).toContain('arguments: query, file_path')
    expect(text).toContain('arguments: glob, path')
  })
  it('reports live tokenizer failures without exposing an invalid error packet', () => {
    const errors: string[] = []
    const progress = new WorkerProgress()
    const observers = { onTokenError: (message: string) => { errors.push(message) } }
    progress.accept({ type: 'deepcluster_tokens_error', message: 'Tokenizer unavailable' }, 100, observers)
    progress.accept({ type: 'deepcluster_tokens_error', message: 12 }, 200, observers)
    progress.accept({ type: 'deepcluster_tokens_error', message: '  ' }, 300, observers)
    expect(errors).toEqual(['Tokenizer unavailable'])
  })
  it('observes streaming tokenizer increments before the response completes', () => {
    const samples: AgentTokenSample[] = []
    const progress = new WorkerProgress()
    const observers = { onTokenSample: (sample: AgentTokenSample) => { samples.push(sample) } }
    progress.accept({ type: 'deepcluster_tokens', tokens: 12, basis: 'tokenizer', tokenizer: 'configured-model' }, 100, observers, 1500)
    progress.accept({ type: 'deepcluster_tokens', tokens: -1, basis: 'tokenizer', tokenizer: 'configured-model' }, 200, observers, 1600)
    progress.accept({ type: 'deepcluster_tokens', tokens: 'invalid', basis: 'tokenizer', tokenizer: 'configured-model' }, 300, observers, 1700)
    expect(samples).toEqual([
      { tokens: 12, observedAt: 1500, basis: 'tokenizer', tokenizer: 'configured-model' },
      { tokens: -1, observedAt: 1600, basis: 'tokenizer', tokenizer: 'configured-model' },
    ])
  })
  it('measures response throughput and does not include a long subsequent tool run', () => {
    const usage: AgentUsage[] = []
    const progress = new WorkerProgress()
    const observers = { onUsage: (sample: AgentUsage) => { usage.push(sample) } }
    progress.accept({ type: 'status', phase: 'step_start', turn: 1, step: 1 }, 100, observers)
    progress.accept({ type: 'thinking', text: 'private' }, 1100, observers)
    progress.accept({ type: 'tool_call', tool: 'pwsh' }, 1101, observers)
    progress.accept({ type: 'tool_result' }, 9000, observers)
    progress.accept({ type: 'status', phase: 'step_end', turn: 1, step: 1, usage: { inputTokens: 200, outputTokens: 40 } }, 9100, observers)
    expect(usage).toEqual([{ inputTokens: 200, outputTokens: 40, elapsedMs: 1000, tokensPerSecond: 40 }])
  })

  it('leaves missing or invalid provider usage unknown and ignores duplicate step ends', () => {
    const usage: AgentUsage[] = []
    const progress = new WorkerProgress()
    const observers = { onUsage: (sample: AgentUsage) => { usage.push(sample) } }
    for (const sample of [undefined, { inputTokens: 2, outputTokens: -1 }, { inputTokens: 2, outputTokens: NaN }]) {
      progress.accept({ type: 'status', phase: 'step_start', turn: 1, step: 1 }, 0, observers)
      progress.accept({ type: 'status', phase: 'step_end', turn: 1, step: 1, usage: sample }, 1000, observers)
    }
    progress.accept({ type: 'status', phase: 'step_end', turn: 1, step: 1, usage: { inputTokens: 2, outputTokens: 10 } }, 2000, observers)
    expect(usage).toEqual([])
  })

  it('distinguishes file work from web and job tools without exposing reasoning', () => {
    const activity: AgentActivity[] = []
    const progress = new WorkerProgress()
    const observers = { onActivity: (sample: AgentActivity) => { activity.push(sample) } }
    for (const tool of ['pwsh', 'read_file', 'apply_patch', 'web_search', 'job_list']) {
      progress.accept({ type: 'tool_call', tool }, 100, observers)
    }
    progress.accept({ type: 'thinking', text: 'private' }, 200, observers)
    expect(activity.map(item => item.kind)).toEqual(['command', 'read', 'write', 'tool', 'tool'])
    expect(JSON.stringify(activity)).not.toContain('private')
  })
})
