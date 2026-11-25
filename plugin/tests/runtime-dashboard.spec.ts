/** Dashboard polling is incremental, bounded, and correct across rotation and partial appends. */
import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DashboardCache } from '../src/api-dashboard.ts'
import { Journal } from '../src/journal.ts'

const temporary: string[] = []
afterEach(async () => { await Promise.all(temporary.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'deep-cluster-dashboard-cache-'))
  temporary.push(dir)
  return dir
}

describe('dashboard observation cache', () => {
  it('reads complete history once and only appended records on repeated polls', async () => {
    const root = await scratch(), journal = new Journal(root)
    await journal.record('run/start', { runId: 'run-1', title: 'Cached', steps: [{ id: 'one', role: 'tester' }] })
    await journal.record('agent/start', { runId: 'run-1', stepId: 'one', role: 'tester' })
    const cache = new DashboardCache()
    const readAfter = vi.spyOn(Journal.prototype, 'readAfter')
    const fullRead = vi.spyOn(Journal.prototype, 'read')
    const first = await cache.snapshot(root, [], 20)
    expect(first.tasks[0]).toMatchObject({ runId: 'run-1', status: 'running' })
    expect(readAfter.mock.calls.every(call => call[0] === null)).toBe(true)
    expect(fullRead).not.toHaveBeenCalled()

    readAfter.mockClear()
    await journal.record('agent/activity', { runId: 'run-1', stepId: 'one', kind: 'write', detail: 'kernel.cu' })
    const second = await cache.snapshot(root, [], 20)
    expect(second.tasks[0]).toMatchObject({ activity: 'write', detail: 'kernel.cu' })
    expect(readAfter.mock.calls.length).toBeGreaterThan(0)
    expect(readAfter.mock.calls.every(call => call[0] !== null)).toBe(true)
    expect(fullRead).not.toHaveBeenCalled()
    readAfter.mockRestore(); fullRead.mockRestore()
  })

  it('rebuilds after rotation instead of keeping the replaced history', async () => {
    const root = await scratch(), journal = new Journal(root)
    await journal.record('run/start', { runId: 'old', title: 'Old', steps: [{ id: 'old', role: 'tester' }] })
    const cache = new DashboardCache()
    expect((await cache.snapshot(root, [], 20)).tasks[0]?.runId).toBe('old')
    await rename(journal.file, `${journal.file}.rotated`)
    await writeFile(journal.file, `${JSON.stringify({ writerId: 'rotated', seq: 0, at: new Date().toISOString(),
      type: 'run/start', data: { runId: 'new', title: 'New', steps: [{ id: 'new', role: 'tester' }] } })}\n`, 'utf8')
    const rotated = await cache.snapshot(root, [], 20)
    expect(rotated.runs.map(run => run.id)).toEqual(['new'])
    expect(rotated.tasks.map(task => task.runId)).toEqual(['new'])
  })

  it('ignores a partial final append and reads it exactly once after completion', async () => {
    const root = await scratch(), journal = new Journal(root)
    await journal.record('run/start', { runId: 'run-2', title: 'Partial', steps: [{ id: 'one', role: 'tester' }] })
    const cache = new DashboardCache()
    expect((await cache.snapshot(root, [], 20)).tasks).toHaveLength(1)
    const event = { writerId: 'partial', seq: 2, at: new Date().toISOString(), type: 'agent/start',
      data: { runId: 'run-2', stepId: 'one', role: 'tester' } }
    const text = JSON.stringify(event)
    const split = text.indexOf('"data"')
    await appendFile(journal.file, text.slice(0, split), 'utf8')
    expect((await cache.snapshot(root, [], 20)).tasks[0]?.status).toBe('queued')
    await appendFile(journal.file, `${text.slice(split)}\n`, 'utf8')
    const completed = await cache.snapshot(root, [], 20)
    expect(completed.tasks[0]?.status).toBe('running')
    expect((await cache.snapshot(root, [], 20)).tasks[0]?.status).toBe('running')
  })

  it('retains only the requested number of timeline rows across repeated polls', async () => {
    const root = await scratch(), journal = new Journal(root)
    await journal.record('run/start', { runId: 'run-3', title: 'Bounded', steps: [{ id: 'one', role: 'tester' }] })
    const cache = new DashboardCache()
    for (let index = 0; index < 30; index++) {
      await journal.record('agent/activity', { runId: 'run-3', stepId: 'one', kind: 'thinking', detail: String(index) })
      const snapshot = await cache.snapshot(root, [], 5)
      expect(snapshot.timeline.length).toBe(Math.min(index + 2, 5))
      expect(snapshot.timeline[0]?.detail).toBe(String(index))
    }
    expect((await cache.snapshot(root, [], 5)).timeline).toHaveLength(5)
  })

  it('rebuilds when a later poll asks for a larger retention', async () => {
    const root = await scratch(), journal = new Journal(root)
    await journal.record('run/start', { runId: 'run-4', title: 'Retention', steps: [{ id: 'one', role: 'tester' }] })
    for (let index = 0; index < 8; index++) {
      await journal.record('agent/activity', { runId: 'run-4', stepId: 'one', kind: 'thinking', detail: String(index) })
    }
    const cache = new DashboardCache()
    expect((await cache.snapshot(root, [], 2)).timeline.map(row => row.detail)).toEqual(['7', '6'])
    expect((await cache.snapshot(root, [], 8)).timeline.map(row => row.detail)).toEqual(['7', '6', '5', '4', '3', '2', '1', '0'])
  })

  it('merges additional workspace roots and drops a removed root set from the bounded cache', async () => {
    const root = await scratch(), other = path.join(root, 'other')
    await mkdir(other)
    await new Journal(root).record('run/start', { runId: 'primary', title: 'Primary', steps: [{ id: 'one', role: 'tester' }] })
    await new Journal(other).record('run/start', { runId: 'other', title: 'Other', steps: [{ id: 'two', role: 'tester' }] })
    const cache = new DashboardCache()
    expect((await cache.snapshot(root, [other], 20)).tasks.map(task => task.runId).sort()).toEqual(['other', 'primary'])
    expect((await cache.snapshot(root, [], 20)).tasks.map(task => task.runId)).toEqual(['primary'])
  })
})
