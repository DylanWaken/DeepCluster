/** Supported headless creation, continuation, and replacement across changing worker team runs. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import { resolveExampleMode, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { createTeam, sendSupervisorMessage } from '../src/mailbox.ts'
import type { RunId } from '../src/types.ts'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))

function events(stdout: string): Record<string, unknown>[] {
  return stdout.split('\n').filter(line => line.startsWith('{')).map((line) => {
    const value: unknown = JSON.parse(line)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Expected a headless JSON object')
    return value as Record<string, unknown>
  })
}

it('retains the exact conversation on resume and gives replacement only its explicit handoff', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'deepcluster-native-composition-'))
  onTestFinished(async () => { await rm(cwd, { recursive: true, force: true }) })
  const patch = path.join(cwd, 'model.patch.yml')
  await writeFile(patch, JSON.stringify([
    { id: 'agent-default-model', config: { provider: 'native-session-fixture', model: 'recorded' } },
    { insert: [{ id: 'native-session-fixture', name: fileURLToPath(new URL('./native-session-llm.fixture.mjs', import.meta.url)) }] },
  ]))
  const teamPatch = path.join(cwd, 'team.patch.yml')
  const teamModule = resolveExampleMode() === 'lib' ? '../lib/team.js' : '../src/team.ts'
  const shippedTeam = await readFile(new URL('../team.patch.yml', import.meta.url), 'utf8')
  await writeFile(teamPatch, shippedTeam.replace("'@deepseek-ai/dsh-experimental-deep-cluster/team'",
    JSON.stringify(fileURLToPath(new URL(teamModule, import.meta.url)))))
  const invoke = async (turn: string, flag: string, id: string, task: string, expectedExitCode = 0) => {
    const runId = `native-${turn}` as RunId
    const root = await createTeam(cwd, runId, ['worker'])
    await sendSupervisorMessage(root, runId, 'worker', `TEAM_${turn.toUpperCase()}`, 1000)
    const result = await runLoaderSmoke({
      label: `native Session ${turn}`, cwd, configPath: patch,
      binScript: path.join(repoRoot, 'apps/cli/src/bin.ts'), tsconfigPath: path.join(repoRoot, 'tsconfig.json'), sourceImport: 'tsx/esm',
      binArgs: ['--profile', 'headless', '--patch', patch, '--patch', teamPatch, flag, id, '--json', task],
      env: { DSH_PROFILE: undefined, DSH_TELEMETRY_DISABLED: '1', DSH_TOOLS_MODE: 'native',
        DSH_DEEP_CLUSTER_POLICY_FILE: undefined,
        DSH_DEEP_CLUSTER_TEAM: JSON.stringify({ root, runId, stepId: 'worker', participants: ['worker'] }) },
      expectedExitCode, processTimeoutMs: 60_000,
    })
    return events(result.stdout)
  }
  const first = await invoke('first', '--new-session-id', 'native-original', 'NATIVE_FIRST_SECRET')
  const resumed = await invoke('continue', '--session-id', 'native-original', 'NATIVE_CONTINUE')
  const replacement = await invoke('replacement', '--new-session-id', 'native-replacement', 'NATIVE_HANDOFF: explicit summary only')
  for (const [records, id] of [[first, 'native-original'], [resumed, 'native-original'], [replacement, 'native-replacement']] as const) {
    expect(records.filter(event => event.type === 'session').map(event => event.sessionId)).toEqual([id])
  }
  expect([first, resumed, replacement].map((records) => {
    const text = records.find(event => event.type === 'final')?.text
    if (typeof text !== 'string') throw new Error('Expected the recorded model answer')
    const answer: unknown = JSON.parse(text)
    return answer
  })).toMatchInlineSnapshot(`
    [
      {
        "explicitHandoff": false,
        "messages": [
          "TEAM_FIRST",
        ],
        "retainedFirst": true,
        "turn": "first",
        "userTurns": 1,
      },
      {
        "explicitHandoff": false,
        "messages": [
          "TEAM_CONTINUE",
        ],
        "retainedFirst": true,
        "turn": "continue",
        "userTurns": 2,
      },
      {
        "explicitHandoff": true,
        "messages": [
          "TEAM_REPLACEMENT",
        ],
        "retainedFirst": false,
        "turn": "replacement",
        "userTurns": 1,
      },
    ]
  `)
  const refused = await invoke('duplicate', '--new-session-id', 'native-original', 'MUST_NOT_RUN', 1)
  expect(refused.some(event => event.type === 'error')).toBe(true)
  expect(refused.some(event => event.type === 'session' || event.type === 'final')).toBe(false)
}, 260_000)
