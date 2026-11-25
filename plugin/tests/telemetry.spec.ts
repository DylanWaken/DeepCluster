/** Tokenizer estimates update during streams, retain merge corrections, and exclude provider billing totals. */
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import { Tokenizer } from '@huggingface/tokenizers'
import { describe, expect, it } from 'vitest'
import { StreamTokenCounter, type TokenPacket } from '../src/telemetry.ts'

type Chunk = Extract<AssistantStreamFrame, { type: 'chunk' }>['chunk']
const attemptId = 'fixture-attempt' as AssistantStreamFrame['attemptId']

function start(): AssistantStreamFrame {
  return { type: 'start', attemptId, revision: 1, turn: 1, step: 1 }
}

function chunk(value: Chunk): AssistantStreamFrame {
  return { type: 'chunk', attemptId, revision: 1, index: 0, time: 1, chunk: value }
}

function end(): AssistantStreamFrame {
  return { type: 'end', attemptId, revision: 1, index: 1, outcome: { kind: 'abandoned' } }
}

function fixture() {
  const tokenizer = new Tokenizer({
    version: '1.0', added_tokens: [], normalizer: null,
    pre_tokenizer: { type: 'Whitespace' }, post_processor: null, decoder: null,
    model: { type: 'WordPiece', unk_token: '[UNK]', continuing_subword_prefix: '##', max_input_chars_per_word: 100,
      vocab: { '[UNK]': 0, a: 1, '##b': 2, abc: 3, tool: 4 } },
  }, {})
  const packets: TokenPacket[] = []
  const counter = new StreamTokenCounter(text => tokenizer.encode(text, { add_special_tokens: false }).ids.length,
    'fixture-wordpiece', (packet) => { packets.push(packet) })
  return { counter, packets }
}

describe('live tokenizer telemetry', () => {
  it('publishes before completion and corrects cumulative token merges instead of counting chunks', () => {
    const { counter, packets } = fixture()
    counter.observe(start(), true)
    counter.observe(chunk({ type: 'text-delta', index: 0, text: 'ab' }), true)
    counter.flush()
    expect(packets.map(packet => packet.type === 'deepcluster_tokens' ? packet.tokens : packet.message)).toEqual([0, 2])
    counter.observe(chunk({ type: 'text-delta', index: 0, text: 'c' }), true)
    counter.flush()
    expect(packets.at(-1)).toMatchObject({ type: 'deepcluster_tokens', tokens: -1, basis: 'tokenizer' })
    counter.observe(end(), true)
    counter.flush()
    expect(packets).toHaveLength(3)
    expect(JSON.stringify(packets)).not.toContain('abc')
  })

  it('counts reasoning and tool arguments privately, flushes at end, and ignores provider usage', () => {
    const { counter, packets } = fixture()
    counter.observe(start(), true)
    counter.observe(chunk({ type: 'reasoning-delta', index: 0, text: 'ab' }), true)
    counter.observe(chunk({ type: 'tool-call-delta', index: 1,
      id: 'call' as Extract<Chunk, { type: 'tool-call-delta' }>['id'], name: 'tool', argumentsDelta: 'abc' }), true)
    counter.observe(chunk({ type: 'usage', usage: { inputTokens: 500, outputTokens: 900 } }), true)
    counter.observe(end(), true)
    expect(packets).toEqual([
      { type: 'deepcluster_tokens', tokens: 0, tokenizer: 'fixture-wordpiece', basis: 'tokenizer' },
      { type: 'deepcluster_tokens', tokens: 4, tokenizer: 'fixture-wordpiece', basis: 'tokenizer' },
    ])
  })

  it('stops counting an unsupported model and drops retained prefixes when disposed', () => {
    const { counter, packets } = fixture()
    counter.observe(start(), false)
    counter.observe(chunk({ type: 'text-delta', index: 0, text: 'ab' }), false)
    counter.flush()
    expect(packets).toEqual([{ type: 'deepcluster_tokens_error', message: 'Live tokenizer is not configured for this worker model.' }])
    counter.observe(start(), true)
    counter.observe(chunk({ type: 'text-delta', index: 0, text: 'ab' }), true)
    counter.clear()
    counter.flush()
    expect(packets).toHaveLength(2)
  })

  it('isolates tokenizer failure to one attempt without exposing text and recovers on the next stream', () => {
    const packets: TokenPacket[] = []
    let failing = true
    const counter = new StreamTokenCounter(() => { if (failing) throw new Error('private text'); return 1 },
      'fixture', (packet) => { packets.push(packet) })
    counter.observe(start(), true)
    counter.observe(chunk({ type: 'text-delta', index: 0, text: 'secret' }), true)
    counter.flush()
    counter.flush()
    expect(packets).toHaveLength(2)
    expect(packets[1]).toMatchObject({ type: 'deepcluster_tokens_error' })
    expect(JSON.stringify(packets)).not.toMatch(/private text|secret/u)
    failing = false
    counter.observe(start(), true)
    counter.observe(chunk({ type: 'text-delta', index: 0, text: 'secret' }), true)
    counter.flush()
    expect(packets.at(-1)).toMatchObject({ type: 'deepcluster_tokens', tokens: 1 })
  })
})
