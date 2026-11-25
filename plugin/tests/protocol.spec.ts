/** Exact acceptance labels retain evidence across ordinary affirmative punctuation. */
import { expect, it } from 'vitest'
import { parseAgentReport } from '../src/protocol.ts'

const criterion = 'only the requested producer comment changed'

function report(checks: string): string {
  return `[[DEEPCLUSTER]]\nstatus: pass\nsummary: Updated the producer comment.\nchecks:\n${checks}\nimprovisation: no\n[[/DEEPCLUSTER]]`
}

it.each([' ', ', ', '; ', '. ', ': ', '! '])('accepts affirmative evidence after separator %j', (separator) => {
  const check = `${criterion}: yes${separator}\`git diff --no-index\` shows exactly the requested comment change; the source hash matches the expected replacement.`
  expect(parseAgentReport(report(`- ${check}`), [criterion])).toMatchObject({ status: 'pass', checks: [check] })
})

it.each(['no. git diff shows an unrelated edit', 'yes/no. verification was inconclusive', 'yesterday the check passed',
  'yes', 'yes.', 'yes. ', 'yes, ...', 'yes: !!!', 'yes ; ...'])('rejects a negative verdict or absent evidence: %j', (verdict) => {
  expect(parseAgentReport(report(`- ${criterion}: ${verdict}`), [criterion]).status).toBe('fail')
})

it('keeps exact-label and duplicate checks mandatory for punctuated verdicts', () => {
  expect(parseAgentReport(report('- another check: yes. git diff is clean'), [criterion]).status).toBe('fail')
  expect(parseAgentReport(report(`- ${criterion}: yes. git diff is clean\n- ${criterion}: no. another edit exists`), [criterion]).status).toBe('fail')
})
