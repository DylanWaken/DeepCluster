/** Dashboard observation uses loopback HTTP, validates replies, and cancels streaming reads. */
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it } from 'vitest'
import { projectDashboard } from '../src/dashboard.ts'
import DeepClusterDashboard from '../src/web.ts'
import { listenLoopback } from './loopback-server.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const release of cleanup.splice(0).reverse()) await release() })

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'deepcluster-dashboard-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const state: { body: unknown; status: number; requests: { url: string; authorization: string | undefined }[] } = {
    body: projectDashboard([], root, 3), status: 200, requests: [],
  }
  const server = createServer((request, response) => {
    state.requests.push({ url: request.url ?? '', authorization: request.headers.authorization })
    response.writeHead(state.status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(state.body))
  })
  cleanup.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => {
      if (error === undefined) resolve()
      else reject(error)
    }))
  })
  const address = await listenLoopback(server)
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  const controller = new DeepClusterDashboard(ctx, {
    workspace: root, workspaces: [path.join(root, 'other'), path.join(root, 'other')],
    pollIntervalMs: 100, eventLimit: 3, apiEndpoint: `http://127.0.0.1:${address.port}`,
  })
  return { root, controller, state }
}

it('forwards host-selected roots through the loopback API without credentials', async () => {
  const h = await fixture()
  expect((await h.controller.snapshot(new AbortController().signal)).runs).toEqual([])
  const request = h.state.requests[0]!
  expect(request.authorization).toBeUndefined()
  const url = new URL(request.url, 'http://127.0.0.1')
  expect(url.pathname).toBe('/v1/dashboard')
  expect(url.searchParams.get('workspace')).toBe(h.root)
  expect(url.searchParams.getAll('workspaces')).toEqual([path.join(h.root, 'other')])
  expect(url.searchParams.get('eventLimit')).toBe('3')
})

it('reports API failure and invalid wire data instead of an empty dashboard', async () => {
  const h = await fixture(), signal = new AbortController().signal
  h.state.status = 503
  h.state.body = { error: { code: 'unavailable', message: 'API unavailable' } }
  await expect(h.controller.snapshot(signal)).rejects.toMatchObject({ code: 'deepCluster/observation-failed' })
  h.state.status = 200
  h.state.body = { runs: [] }
  await expect(h.controller.snapshot(signal)).rejects.toMatchObject({ code: 'deepCluster/observation-failed' })
})

it('validates explicit API ownership while retaining the null journal-only indication', async () => {
  const h = await fixture(), signal = new AbortController().signal
  expect((await h.controller.snapshot(signal)).activeRunIds).toBeNull()
  const base = projectDashboard([], h.root, 3), runId = '11111111-1111-4111-8111-111111111111'
  h.state.body = { ...base, activeRunIds: [runId] }
  expect((await h.controller.snapshot(signal)).activeRunIds).toEqual([runId])
  h.state.body = { ...base, activeRunIds: [] }
  expect((await h.controller.snapshot(signal)).activeRunIds).toEqual([])
  for (const activeRunIds of [undefined, ['not-an-api-uuid'], [42], 'running']) {
    h.state.body = { ...base, activeRunIds }
    await expect(h.controller.snapshot(signal)).rejects.toMatchObject({ code: 'deepCluster/observation-failed' })
  }
})

it('streams changed HTTP snapshots and cancels while waiting for a refresh', async () => {
  const h = await fixture(), lifetime = new AbortController()
  const stream = h.controller.watch(lifetime.signal)[Symbol.asyncIterator]()
  cleanup.push(async () => { lifetime.abort(); await stream.return?.() })
  const initial = await stream.next()
  expect(initial.done).toBe(false)
  h.state.body = projectDashboard([{ seq: 1, at: '2026-10-23T00:00:00Z', type: 'agent/activity',
    data: { runId: 'run', stepId: '1', role: 'tester', kind: 'command', detail: 'bench.exe' } }], h.root, 3)
  const update = await stream.next()
  if (update.done) throw new Error('Dashboard ended before the activity update')
  expect(update.value.tasks[0]?.activity).toBe('command')
  const pending = stream.next()
  lifetime.abort()
  expect(await pending).toEqual({ done: true, value: undefined })
})
