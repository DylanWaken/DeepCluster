/** Source-mode subprocess fixture for cross-process write-claim races. */
import { coordinate } from '../src/coordinator.ts'
import { masterDirectory } from '../src/master.ts'

const root = process.argv[2]
const claimPath = process.argv[3]
if (root === undefined || claimPath === undefined) throw new Error('claim worker requires root and claim path')

const step = {
  id: 'work',
  title: 'work',
  role: 'developer' as const,
  detail: 'Hold the claimed path until released.',
  acceptance: ['fixture claim checked'],
  dependsOn: [] as string[],
  ...claimPath === '*'
    ? {}
    : { access: 'write' as const, writes: [claimPath] },
}

let release = (): void => {}
const released = new Promise<void>((resolve) => { release = resolve })
process.once('message', () => { release() })

const outcome = await coordinate({
  root,
  workspace: root,
  leaseRoot: masterDirectory(root),
  maxConcurrency: 1,
  maxAttempts: 1,
  maxRepairs: 0,
  plan: { title: 'claim race', goal: 'hold a claim', hardware: [], steps: [step] },
  runner: async () => {
    process.send?.('started')
    await released
    return {
      ok: true,
      exitCode: 0,
      durationMs: 1,
      output: '[[DEEPCLUSTER]]\nstatus: pass\nsummary: fixture held and released\nchecks:\n- fixture claim checked: yes, the fixture held the claim\nimprovisation: no\n[[/DEEPCLUSTER]]',
    }
  },
})

if (outcome.status !== 'completed') {
  process.stderr.write(`claim fixture failed: ${outcome.status}: ${outcome.steps[0]?.summary ?? 'no step summary'}\n`)
  process.exitCode = 1
}
process.disconnect()
