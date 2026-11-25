/** Multi-workspace API projection preserves source-local history and fails visibly on corrupt sources. */
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { readApiDashboard } from '../src/api-dashboard.ts'
import { Journal } from '../src/journal.ts'

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'deepcluster-api-dashboard-')))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  return { root, other: path.join(root, 'other') }
}

it('separates equal step identifiers and legacy runs across workspace sources', async () => {
  const h = await fixture()
  for (const [root, runId] of [[h.root, 'primary'], [h.other, 'other']]) {
    const journal = new Journal(root!)
    await journal.record('run/start', { runId, title: runId, steps: [{ id: 'same', title: runId, role: 'tester' }] })
    await journal.record('run/start', { title: `legacy ${runId}`, steps: [{ id: 'same', title: `legacy ${runId}`, role: 'tester' }] })
  }
  const snapshot = await readApiDashboard(h.root, [h.other, h.other], 1)
  expect(snapshot.workspaces).toEqual([h.root, h.other])
  expect(new Set(snapshot.tasks.map(task => task.id)).size).toBe(4)
  expect(snapshot.tasks.map(task => task.title).sort()).toEqual(['legacy other', 'legacy primary', 'other', 'primary'])
  expect(snapshot.timeline).toHaveLength(1)
})

it('reads canonical and aliased workspace roots once without doubling token usage', async () => {
  const h = await fixture(), alias = path.join(h.root, 'alias'), journal = new Journal(h.root)
  await symlink(h.root, alias, process.platform === 'win32' ? 'junction' : 'dir')
  await journal.record('run/start', { runId: 'single', title: 'Single source', steps: [{ id: 'worker', role: 'tester' }] })
  await journal.record('agent/usage', { runId: 'single', stepId: 'worker', role: 'tester',
    inputTokens: 20, outputTokens: 10, elapsedMs: 1000, tokensPerSecond: 10 })
  const snapshot = await readApiDashboard(h.root, [alias], 10)
  expect(snapshot.workspaces).toEqual([h.root])
  expect(snapshot.timeline).toHaveLength(2)
  expect(snapshot.tasks[0]?.usage?.outputTokens).toBe(10)
})

it('preserves source append order when a journal timestamp moves backwards', async () => {
  const h = await fixture(), journal = new Journal(h.root)
  await mkdir(path.dirname(journal.file), { recursive: true })
  await writeFile(journal.file, [
    { seq: 1, at: '2026-10-23T02:00:00Z', type: 'run/start', data: { runId: 'ordered', title: 'Order' } },
    { seq: 2, at: '2026-10-23T01:00:00Z', type: 'run/end', data: { runId: 'ordered', status: 'completed' } },
  ].map(event => JSON.stringify(event)).join('\n') + '\n')
  expect((await readApiDashboard(h.root, [h.other], 10)).runs[0]?.status).toBe('completed')
})

it('accepts absent journals but rejects committed corruption in any requested source', async () => {
  const h = await fixture()
  expect((await readApiDashboard(h.root, [h.other], 10)).runs).toEqual([])
  const journal = new Journal(h.other)
  await mkdir(path.dirname(journal.file), { recursive: true }); await writeFile(journal.file, '{broken}\n')
  await expect(readApiDashboard(h.root, [h.other], 10)).rejects.toThrow()
})
