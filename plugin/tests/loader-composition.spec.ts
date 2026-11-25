/** Real Loader, coordinator, filesystem leases and local process ownership; only the external model worker is recorded. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { expect, it, onTestFinished } from 'vitest'
import '../src/index.ts'
import { Journal } from '../src/journal.ts'
import { leaseStatus } from '../src/lease.ts'
import { masterDirectory } from '../src/master.ts'
import { parsePlan } from '../src/plan.ts'
import { knowledgeRevisionSchema } from '../src/knowledge-types.ts'

async function composition() {
  const root = await mkdtemp(path.join(tmpdir(), 'deepcluster-loader-'))
  const context = new Context()
  onTestFinished(async () => {
    await context.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  const config = path.join(root, 'cordis.yml')
  await writeFile(config, [
    '- id: worker-processes',
    "  name: '@deepseek-ai/dsh-subprocess-local'",
    '- id: cluster',
    "  name: '@deepseek-ai/dsh-experimental-deep-cluster'",
    '  config:',
    `    cliPath: ${JSON.stringify(fileURLToPath(new URL('./recorded-worker.fixture.mjs', import.meta.url)))}`,
    '    profile: recorded-worker',
    '    timeoutMs: 10000',
  ].join('\n') + '\n')
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  context.loader.internal = undefined
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await context.loader.await()
  for (const entry of context.loader.entries()) await entry.fiber?.await()
  return { root, context }
}

function fixturePlan(detail: string) {
  return parsePlan(`# Recorded worker task
goal: exercise composed worker ownership
## Step write: create the fixture artifact
role: developer
resources: none
hardware: fixture-device
acceptance:
- fixture marker created

${detail}
`)
}

it('loads the real service from cordis.yml and records worker output, activity and checked task evidence', async () => {
  const { root, context } = await composition()
  const outcome = await context.deepCluster.runPlan(fixturePlan('Create the fixture artifact and report its evidence.'), root, {
    leaseRoot: masterDirectory(root), maxRepairs: 0, maxAttempts: 1,
  })
  expect(outcome.status).toBe('completed')
  expect(await readFile(path.join(root, 'worker-output.txt'), 'utf8')).toBe('fixture artifact\n')
  expect(await readFile(path.join(root, 'worker-prompt.txt'), 'utf8')).toMatchSnapshot('worker prompt')
  const events = await new Journal(root).read()
  expect(events.map(event => ({
    type: event.type,
    ...typeof event.data.stepId === 'string' ? { stepId: event.data.stepId } : {},
    ...typeof event.data.kind === 'string' ? { kind: event.data.kind } : {},
    ...typeof event.data.status === 'string' ? { status: event.data.status } : {},
  }))).toMatchSnapshot('committed activity and outcome')
  expect(events.find(event => event.type === 'task/outcome')?.data).toMatchObject({
    status: 'pass', checks: ['fixture marker created: yes, wrote worker-output.txt with fixture artifact'],
  })
  const usage = events.find(event => event.type === 'agent/usage')?.data
  expect(usage).toMatchObject({
    runId: outcome.runId, stepId: 'write', inputTokens: 500, outputTokens: 30,
  })
  expect(usage?.elapsedMs).toBeGreaterThan(0)
  expect(usage?.tokensPerSecond).toBeGreaterThan(0)
  expect((await leaseStatus(masterDirectory(root), 'fixture-device')).held).toBeUndefined()
})

it('plugin disposal cancels and joins a live worker before making its resource available', async () => {
  const { root, context } = await composition()
  const active = Promise.withResolvers<undefined>()
  const run = context.deepCluster.runPlan(fixturePlan('WAIT_FOR_CANCELLATION'), root, {
    leaseRoot: masterDirectory(root), maxRepairs: 0, maxAttempts: 1,
    onEvent: (event) => { if (event.type === 'agent/activity') active.resolve(undefined) },
  })
  void run.then(() => { active.reject(new Error('worker finished before an activity event')) }, (error: unknown) => { active.reject(error) })
  await active.promise
  expect((await leaseStatus(masterDirectory(root), 'fixture-device')).held).toBeDefined()
  await context.fiber.dispose()
  expect((await run).status).toBe('cancelled')
  expect((await leaseStatus(masterDirectory(root), 'fixture-device')).held).toBeUndefined()
  expect(context.get('deepCluster')).toBeUndefined()
})

it('delivers the selected full knowledge revision to the composed worker and records the same selection', async () => {
  const { root, context } = await composition()
  const knowledge = [knowledgeRevisionSchema.parse({
    version: 1, id: '72e42ba8-1cd1-4bc9-bf26-6ff365354693', kind: 'document', revision: 3, previousRevision: 2,
    title: 'Fixture handoff', body: 'Retain worker-output.txt as evidence; report open questions explicitly.',
    createdAt: '2026-10-29T00:00:00.000Z', updatedAt: '2026-10-29T01:00:00.000Z',
  })]
  const outcome = await context.deepCluster.runPlan(fixturePlan('Create the fixture artifact and report its evidence.'), root, {
    leaseRoot: masterDirectory(root), maxRepairs: 0, maxAttempts: 1, knowledge,
  })
  expect(outcome.status).toBe('completed')
  const prompt = await readFile(path.join(root, 'worker-prompt.txt'), 'utf8')
  expect(prompt).toMatchSnapshot('worker prompt with selected knowledge')
  const events = await new Journal(root).read()
  expect(events.find(event => event.type === 'run/start')?.data.knowledge).toEqual(knowledge)
})
