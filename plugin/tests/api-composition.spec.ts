/** Fleet inventory through the real Loader, HTTP API, coordinator, and recorded external worker. */
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { expect, it, onTestFinished } from 'vitest'
import { z } from 'zod'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '../src/index.ts'
import { apiOperationViewSchema } from '../src/api-types.ts'

const summarySchema = z.object({
  operationId: z.uuid(), workspace: z.string(), runId: z.uuid(), status: z.literal('completed'),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), attention: z.array(z.string()), open: z.number(),
  counts: z.object({ total: z.number(), queued: z.number(), running: z.number(), waiting: z.number(),
    passed: z.number(), failed: z.number(), blocked: z.number() }).strict(),
}).strict()

async function composition() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'deepcluster-api-composition-')))
  const workspace = path.join(root, 'workspace'), stateDirectory = path.join(root, 'state')
  const context = new Context()
  onTestFinished(async () => {
    try { await context.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) }
  })
  await mkdir(workspace)
  const config = path.join(root, 'cordis.yml')
  await writeFile(config, [
    '- id: worker-processes',
    "  name: '@deepseek-ai/dsh-subprocess-local'",
    '- id: cluster',
    "  name: '@deepseek-ai/dsh-experimental-deep-cluster'",
    '  config:',
    `    cliPath: ${JSON.stringify(fileURLToPath(new URL('./recorded-worker.fixture.mjs', import.meta.url)))}`,
    '    profile: recorded-worker',
    `    dshPath: ${JSON.stringify(root)}`,
    '    timeoutMs: 10000',
    '- id: api-server',
    "  name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    '    host: 127.0.0.1',
    '    port: 0',
    '- id: api',
    "  name: '@deepseek-ai/dsh-experimental-deep-cluster/api'",
    '  config:',
    `    stateDirectory: ${JSON.stringify(stateDirectory)}`,
    `    leaseRoot: ${JSON.stringify(path.join(root, 'ownership'))}`,
  ].join('\n') + '\n')
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  context.loader.internal = undefined
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await context.loader.await()
  for (const entry of context.loader.entries()) await entry.fiber?.await()
  return { context, workspace, stateDirectory, origin: context.webServer.getOrigin() }
}

it('discovers a completed recorded worker through the composed API without exposing its private metadata', async () => {
  const h = await composition()
  const plan = `# Fleet composition
goal: record one observable worker result
## Step write: create the fixture artifact
role: developer
access: write
hardware: none
acceptance:
- fixture marker created

Create the fixture artifact and report its evidence.
`
  const response = await fetch(`${h.origin}/v1/runs`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'composed-fleet-run' },
    body: JSON.stringify({ workspace: h.workspace, plans: [plan], maxAttempts: 1, maxRepairs: 0 }) })
  expect(response.status).toBe(202)
  const operation = apiOperationViewSchema.parse(await response.json())
  const reportResponse = await fetch(`${h.origin}/v1/runs/${operation.operationId}?wait=30&view=report`)
  expect(reportResponse.status).toBe(200)
  expect(await reportResponse.json()).toMatchObject({ status: 'completed', open: [],
    steps: [{ id: 'write', status: 'pass', checks: ['fixture marker created: yes, wrote worker-output.txt with fixture artifact'] }] })
  expect(await readFile(path.join(h.workspace, 'worker-output.txt'), 'utf8')).toBe('fixture artifact\n')
  const inventoryResponse = await fetch(`${h.origin}/v1/runs?attention=false&workspace=${encodeURIComponent(h.workspace)}&limit=1`)
  expect(inventoryResponse.status).toBe(200)
  const page = z.object({ runs: z.array(summarySchema), cursor: z.null(), more: z.literal(false) }).strict()
    .parse(await inventoryResponse.json())
  expect(page.runs).toHaveLength(1)
  const summary = page.runs[0]!
  expect(summary.operationId).toBe(operation.operationId)
  expect(summary.workspace).toBe(h.workspace)
  expect({ status: summary.status, attention: summary.attention, open: summary.open, counts: summary.counts,
    cursor: page.cursor, more: page.more }).toMatchInlineSnapshot(`
    {
      "attention": [],
      "counts": {
        "blocked": 0,
        "failed": 0,
        "passed": 1,
        "queued": 0,
        "running": 0,
        "total": 1,
        "waiting": 0,
      },
      "cursor": null,
      "more": false,
      "open": 0,
      "status": "completed",
    }
  `)
  await h.context.fiber.dispose()
  expect(h.context.get('deepCluster')).toBeUndefined()
  await expect(readFile(path.join(h.stateDirectory, 'api-owner.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
})
