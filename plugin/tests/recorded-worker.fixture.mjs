/** Deterministic external worker responses for the real Loader and subprocess composition. */
import { writeFile } from 'node:fs/promises'

const prompt = process.argv.at(-1)
if (prompt === undefined) throw new Error('worker fixture requires a task prompt')
const emit = value => { process.stdout.write(`${JSON.stringify(value)}\n`) }
await writeFile('worker-prompt.txt', prompt)
emit({ type: 'status', phase: 'step_start', turn: 1, step: 1 })
emit({ type: 'tool_call', tool: 'write_file' })
await writeFile('worker-output.txt', 'fixture artifact\n')
emit({ type: 'tool_result' })
emit({ type: 'status', phase: 'step_end', turn: 1, step: 1, usage: { inputTokens: 500, outputTokens: 30 } })
if (prompt.includes('WAIT_FOR_CANCELLATION')) {
  setInterval(() => {}, 60_000)
} else {
  emit({ type: 'final', text: [
    '[[DEEPCLUSTER]]',
    'status: pass',
    'summary: created the fixture artifact',
    'checks:',
    '- fixture marker created: yes, wrote worker-output.txt with fixture artifact',
    'improvisation: no',
    '[[/DEEPCLUSTER]]',
  ].join('\n') })
}
