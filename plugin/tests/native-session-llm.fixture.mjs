/** Recorded native Session turns consume actual history and the current run's real inbox tool. */
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'

class NativeSessionAdapter extends LlmAdapter {
  async resolveModel(provider, model) {
    return { provider, id: model, name: model }
  }

  async * stream(options) {
    const users = options.messages.filter(message => message.role === 'user' && message.source.kind === 'user')
    const task = JSON.stringify(users.at(-1)?.content)
    const turn = task.includes('NATIVE_HANDOFF') ? 'replacement' : task.includes('NATIVE_CONTINUE') ? 'continue' : 'first'
    const callId = ToolCallId(`native-inbox-${turn}`)
    const toolResult = options.messages.findLast(message => message.role === 'tool' && message.toolCallId === callId)
    if (toolResult === undefined) {
      if (!options.tools.some(tool => tool.name === 'cluster_inbox')) throw new Error('Current team inbox tool is unavailable')
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: callId, name: 'cluster_inbox', argumentsDelta: '{}' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name: 'cluster_inbox', arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    if (toolResult.isError) throw new Error('Current team inbox failed')
    const inbox = JSON.parse(toolResult.content.filter(block => block.type === 'text').map(block => block.text).join(''))
    const text = JSON.stringify({
      turn, userTurns: users.length,
      retainedFirst: JSON.stringify(users).includes('NATIVE_FIRST_SECRET'),
      explicitHandoff: task.includes('NATIVE_HANDOFF'),
      messages: inbox.messages.map(message => message.message),
    })
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const name = 'native-session-fixture'
export const inject = ['llm']

/** Register a keyless adapter that reads only the model request and production inbox result. */
export function apply(ctx) {
  ctx.llm.registerAdapter(['native-session-fixture'], new NativeSessionAdapter())
}
