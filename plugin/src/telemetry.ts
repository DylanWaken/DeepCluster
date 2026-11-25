/** Optional worker-side tokenizer estimates from public live assistant-stream events. */
import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import z from '@deepseek-ai/schemastery'
import { Tokenizer } from '@huggingface/tokenizers'

/** Explicit local tokenizer assets and the worker model aliases they describe. */
export interface TelemetryConfig {
  readonly tokenizerFile: string
  readonly tokenizerConfigFile: string
  readonly tokenizer: string
  readonly models: readonly string[]
  readonly sampleIntervalMs: number
}

/** Validated worker deployment settings; no network downloads occur during a model request. */
export const Config = z.object({
  tokenizerFile: z.string().min(1),
  tokenizerConfigFile: z.string().min(1),
  tokenizer: z.string().min(1),
  models: z.array(z.string().min(1)).min(1),
  sampleIntervalMs: z.natural().min(50).max(1000).default(250),
})

/** Numeric-only stdout records consumed by the controlling DeepCluster process. */
export type TokenPacket =
  | { readonly type: 'deepcluster_tokens'; readonly tokens: number; readonly tokenizer: string; readonly basis: 'tokenizer' }
  | { readonly type: 'deepcluster_tokens_error'; readonly message: string }

interface BlockPrefix {
  text: string
  name: string
  counted: number
  dirty: boolean
}

/** Retokenizes cumulative output prefixes; token merges may produce negative corrections. */
export class StreamTokenCounter {
  readonly #attempts = new Map<AssistantStreamFrame['attemptId'], Map<number, BlockPrefix>>()

  /**
   * @param count - tokenizer token count, excluding added special tokens.
   * @param tokenizer - explicit estimate label, distinct from provider billing counts.
   * @param emit - numeric telemetry sink; never receives model text.
   */
  constructor(private readonly count: (text: string) => number, private readonly tokenizer: string,
    private readonly emit: (packet: TokenPacket) => void) {}

  /**
   * Observe one frame; unsupported model aliases publish an unavailable signal.
   * @param frame - public transient assistant-stream event.
   * @param supported - whether the configured tokenizer describes this model alias.
   */
  observe(frame: AssistantStreamFrame, supported: boolean): void {
    if (frame.type === 'start') {
      if (!supported) {
        this.emit({ type: 'deepcluster_tokens_error', message: 'Live tokenizer is not configured for this worker model.' })
        return
      }
      this.#attempts.set(frame.attemptId, new Map())
      this.sample(0)
      return
    }
    const blocks = this.#attempts.get(frame.attemptId)
    if (blocks === undefined) return
    if (frame.type === 'end') {
      this.flushAttempt(frame.attemptId, blocks)
      this.#attempts.delete(frame.attemptId)
      return
    }
    const chunk = frame.chunk
    switch (chunk.type) {
      case 'text-delta':
      case 'reasoning-delta': {
        const block = this.block(blocks, chunk.index)
        block.text += chunk.text; block.dirty = true
        break
      }
      case 'tool-call-delta': {
        const block = this.block(blocks, chunk.index)
        block.text += chunk.argumentsDelta
        if (chunk.name !== undefined) block.name = chunk.name
        block.dirty = true
        break
      }
      case 'block-end': {
        const block = this.block(blocks, chunk.index)
        switch (chunk.block.type) {
          case 'text': case 'reasoning': block.text = chunk.block.text; block.dirty = true; break
          case 'tool-call': block.text = chunk.block.arguments; block.name = chunk.block.name; block.dirty = true; break
          default: break // ContentBlockMap is merge-extensible; non-text blocks have no tokenizer estimate.
        }
        break
      }
      case 'block-start': case 'usage': case 'finish': break
      default: assertNever(chunk)
    }
  }

  /** Publish accumulated token changes for active attempts without waiting for response completion. */
  flush(): void {
    for (const [attemptId, blocks] of this.#attempts) this.flushAttempt(attemptId, blocks)
  }

  /** Drop all text prefixes when the owning plugin is disposed. */
  clear(): void {
    this.#attempts.clear()
  }

  private block(blocks: Map<number, BlockPrefix>, index: number): BlockPrefix {
    let block = blocks.get(index)
    if (block === undefined) { block = { text: '', name: '', counted: 0, dirty: false }; blocks.set(index, block) }
    return block
  }

  private sample(tokens: number): void {
    this.emit({ type: 'deepcluster_tokens', tokens, tokenizer: this.tokenizer, basis: 'tokenizer' })
  }

  private flushAttempt(attemptId: AssistantStreamFrame['attemptId'], blocks: Map<number, BlockPrefix>): void {
    let delta = 0
    try {
      for (const block of blocks.values()) {
        if (!block.dirty) continue
        const count = (block.text === '' ? 0 : this.count(block.text)) + (block.name === '' ? 0 : this.count(block.name))
        delta += count - block.counted
        block.counted = count; block.dirty = false
      }
    } catch (_error) {
      // Tokenizer diagnostics may contain model text; expose only an actionable configuration report.
      this.#attempts.delete(attemptId)
      this.emit({ type: 'deepcluster_tokens_error', message: `Live tokenizer ${this.tokenizer} failed. Verify its local tokenizer files.` })
      return
    }
    if (delta !== 0) this.sample(delta)
  }
}

/** Read the local JSON object required by the tokenizer library. */
async function readObject(file: string): Promise<object> {
  const value: unknown = JSON.parse(await readFile(file, 'utf8'))
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`Tokenizer file must contain a JSON object: ${file}`)
  return value
}

/**
 * Attach one numeric stream observer to a worker profile.
 * @param ctx - plugin lifetime; disposal removes the listener, timer, and retained prefixes.
 * @param config - explicit model aliases and locally cached tokenizer assets.
 */
export async function apply(ctx: Context, config: TelemetryConfig): Promise<void> {
  const [definition, metadata] = await Promise.all([readObject(config.tokenizerFile), readObject(config.tokenizerConfigFile)])
  const tokenizer = new Tokenizer(definition, metadata)
  tokenizer.encode('DeepCluster tokenizer initialization', { add_special_tokens: false })
  const counter = new StreamTokenCounter(text => tokenizer.encode(text, { add_special_tokens: false }).ids.length,
    config.tokenizer, (packet) => { process.stdout.write(`${JSON.stringify(packet)}\n`) })
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    counter.observe(frame, agent.options.model !== undefined && config.models.includes(agent.options.model))
  })
  ctx.effect(() => {
    const timer = setInterval(() => { counter.flush() }, config.sampleIntervalMs)
    timer.unref()
    return () => { clearInterval(timer); counter.clear() }
  })
}
