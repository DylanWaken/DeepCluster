/** The shipped team plugin registers real tools and removes them on disposal. */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecution } from '@deepseek-ai/dsh-tools'
import { expect, it, onTestFinished } from 'vitest'
import * as Team from '../src/team.ts'
import { createTeam, TeamMailbox } from '../src/mailbox.ts'
import type { RunId } from '../src/types.ts'
import { entryListSchema, applyEntryPatches, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { load } from 'js-yaml'

it.each(['team', 'telemetry'])('loads the shipped %s overlay as an insertion in the actual Loader YAML dialect', async (name) => {
  const source = await readFile(new URL(`../${name}.patch.yml`, import.meta.url), 'utf8')
  const patches = load(source, { schema: entryListSchema }) as PatchOptions[]
  const warnings: string[] = []
  const entries = applyEntryPatches([], patches, (message) => { warnings.push(message) })
  expect(warnings).toEqual([])
  expect(entries).toHaveLength(1)
  expect(entries[0]?.name).toBe(`@deepseek-ai/dsh-experimental-deep-cluster/${name}`)
})

it('exposes message tools through the real registry, returns retrieved evidence, and unregisters them on disposal', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'deepcluster-team-plugin-'))
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const runId = randomUUID() as RunId
  const team = { root: await createTeam(root, runId, ['one', 'two']), runId, stepId: 'one', participants: ['one', 'two'] }
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const plugin = await ctx.plugin(Team, { ...team, maxMessageChars: 100, maxInboxMessages: 10 })
  expect(ctx.tools.schemas().filter(tool => tool.name.startsWith('cluster_'))).toMatchSnapshot('model-visible team tools')
  const call = async (name: string, args: unknown) => await ctx.tools.execute({
    name, arguments: args, callId: randomUUID() as ToolExecution['callId'], signal: new AbortController().signal,
  })
  const sent = await call('cluster_message', { toStepId: 'two', message: 'tested 2x2' })
  expect(sent.content.filter(block => block.type === 'text').map(block => block.text).join('\n')).toContain('awaiting recipient inbox retrieval')
  const peer = await TeamMailbox.open({ ...team, stepId: 'two' }, 100, 10)
  expect((await peer.receive())[0]?.message).toBe('tested 2x2')
  await peer.send('one', 'acknowledged evidence')
  const received = await call('cluster_inbox', {})
  expect(received.content.filter(block => block.type === 'text').map(block => block.text).join('\n')).toContain('acknowledged evidence')
  await plugin.dispose()
  expect(ctx.tools.get('cluster_message')).toBeUndefined()
  expect(ctx.tools.get('cluster_inbox')).toBeUndefined()
})
