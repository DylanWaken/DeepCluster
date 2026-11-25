/** Bounded incremental journal access across writers, rotations, and partial appends. */
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ensureStateDirectory, Journal, JournalCursorError, parseJournalCursor, type JournalCursor, type JournalEvent,
  type JournalPage,
} from '../src/journal.ts'

const temporary: string[] = []
afterEach(async () => { await Promise.all(temporary.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'deep-cluster-journal-'))
  temporary.push(dir)
  return dir
}

/** Page from a cursor (or the start) until no more events remain. */
async function collect(journal: Journal, cursor: JournalCursor | null, limit: number, runId?: string): Promise<{
  events: JournalEvent[]
  cursor: JournalCursor | null
  pages: number
}> {
  const events: JournalEvent[] = []
  let current = cursor, pages = 0
  for (let guard = 0; guard < 100; guard++) {
    const page: JournalPage = await journal.readAfter(current, { limit, ...runId === undefined ? {} : { runId } })
    events.push(...page.events); current = page.cursor; pages++
    if (!page.more) break
  }
  return { events, cursor: current, pages }
}

describe('state directory', () => {
  it('creates a self-ignoring .deep-cluster once and keeps an existing .gitignore', async () => {
    const root = await scratch()
    const directory = await ensureStateDirectory(root)
    expect(directory).toBe(path.join(root, '.deep-cluster'))
    expect(await readFile(path.join(directory, '.gitignore'), 'utf8')).toBe('*\n')
    await writeFile(path.join(directory, '.gitignore'), 'custom\n')
    expect(await ensureStateDirectory(root)).toBe(directory)
    expect(await readFile(path.join(directory, '.gitignore'), 'utf8')).toBe('custom\n')
  })
})

describe('incremental cursor', () => {
  it('returns every interleaved writer event exactly once without writer-local sequence collisions', async () => {
    const root = await scratch()
    const first = new Journal(root), second = new Journal(root)
    for (let index = 0; index < 6; index++) {
      await first.record('step/queued', { runId: 'run-a', index })
      await second.record('step/queued', { runId: 'run-b', index })
    }
    const { events, pages } = await collect(new Journal(root), null, 4)
    expect(events.map(event => `${String(event.data.runId)}:${String(event.data.index)}`)).toEqual([
      'run-a:0', 'run-b:0', 'run-a:1', 'run-b:1', 'run-a:2', 'run-b:2',
      'run-a:3', 'run-b:3', 'run-a:4', 'run-b:4', 'run-a:5', 'run-b:5',
    ])
    expect(new Set(events.map(event => `${String(event.writerId)}:${String(event.seq)}`)).size).toBe(12)
    expect(pages).toBeGreaterThan(1)
  })

  it('keeps concurrently appended writers readable without a torn or duplicated event', async () => {
    const root = await scratch()
    const first = new Journal(root), second = new Journal(root)
    await Promise.all(Array.from({ length: 40 }, async (_unused, index) => {
      await Promise.all([
        first.record('step/queued', { runId: 'run-a', index }),
        second.record('step/queued', { runId: 'run-b', index }),
      ])
    }))
    const { events } = await collect(new Journal(root), null, 7)
    expect(events).toHaveLength(80)
    expect(new Set(events.map(event => `${String(event.writerId)}:${String(event.seq)}`)).size).toBe(80)
    expect(events.filter(event => event.data.runId === 'run-a').map(event => event.data.index).sort((a, b) => Number(a) - Number(b)))
      .toEqual(Array.from({ length: 40 }, (_unused, index) => index))
    expect(events.filter(event => event.data.runId === 'run-b').map(event => event.data.index).sort((a, b) => Number(a) - Number(b)))
      .toEqual(Array.from({ length: 40 }, (_unused, index) => index))
  })

  it('filters by run while advancing past unrelated history', async () => {
    const root = await scratch()
    const journal = new Journal(root)
    for (let index = 0; index < 10; index++) {
      await journal.record(index % 2 === 0 ? 'step/queued' : 'step/blocked',
        { runId: index % 2 === 0 ? 'run-a' : 'run-b', index })
    }
    const { events } = await collect(new Journal(root), null, 2, 'run-a')
    expect(events).toHaveLength(5)
    expect(events.every(event => event.data.runId === 'run-a')).toBe(true)
    expect(events.map(event => event.data.index)).toEqual([0, 2, 4, 6, 8])
  })

  it('ignores an unfinished final append and reads it after the newline arrives', async () => {
    const root = await scratch()
    const journal = new Journal(root)
    await journal.record('step/queued', { runId: 'run-a', index: 1 })
    await journal.record('step/queued', { runId: 'run-a', index: 2 })
    const file = journal.file
    const complete: JournalEvent = { writerId: 'partial-writer' as NonNullable<JournalEvent['writerId']>, seq: 7,
      at: new Date().toISOString(), type: 'step/queued', data: { runId: 'run-a', index: 3 } }
    const completeJson = JSON.stringify(complete)
    const split = Math.floor(completeJson.length / 2)
    await appendFile(file, completeJson.slice(0, split), 'utf8')
    const first = await new Journal(root).readAfter(null, { limit: 10 })
    expect(first.events.map(event => event.data.index)).toEqual([1, 2])
    expect(first.more).toBe(false)
    const partialCursor = first.cursor
    expect(partialCursor).not.toBeNull()
    expect((await new Journal(root).readAfter(partialCursor, { limit: 10 })).events).toEqual([])
    await appendFile(file, `${completeJson.slice(split)}\n`, 'utf8')
    expect((await new Journal(root).readAfter(partialCursor, { limit: 10 })).events.map(event => event.data.index)).toEqual([3])
  })

  it('ignores a partial UTF-8 line and returns the decoded value after completion', async () => {
    const root = await scratch()
    await mkdir(path.join(root, '.deep-cluster'), { recursive: true })
    const file = new Journal(root).file
    const event = { writerId: 'utf8-writer', seq: 0, at: new Date().toISOString(), type: 'agent/log',
      data: { runId: 'run-utf8', text: 'tokén-🙂-sentinel' } }
    const complete = `${JSON.stringify(event)}\n`
    const bytes = Buffer.from(complete, 'utf8')
    const emoji = Buffer.from('🙂', 'utf8')
    const split = bytes.indexOf(emoji) + 2
    await writeFile(file, bytes.subarray(0, split))
    const first = await new Journal(root).readAfter(null, { limit: 10 })
    expect(first.events).toEqual([])
    expect(first.more).toBe(false)
    await appendFile(file, bytes.subarray(split))
    const page = await new Journal(root).readAfter(first.cursor, { limit: 10 })
    expect(page.events.map(value => value.data.text)).toEqual(['tokén-🙂-sentinel'])
  })

  it('resets on rotation instead of reporting a false gap', async () => {
    const root = await scratch()
    const journal = new Journal(root)
    await journal.record('step/queued', { runId: 'old', index: 1 })
    const first = await new Journal(root).readAfter(null, { limit: 10 })
    expect(first.cursor).not.toBeNull()
    await rename(journal.file, `${journal.file}.rotated`)
    await writeFile(journal.file, `${JSON.stringify({
      writerId: 'rotated-writer', seq: 0, at: new Date().toISOString(), type: 'step/queued', data: { runId: 'new', index: 9 },
    })}\n`, 'utf8')
    const page = await new Journal(root).readAfter(first.cursor, { limit: 10 })
    expect(page.reset).toBe(true)
    expect(page.events.map(event => event.data.index)).toEqual([9])
  })

  it('resets after truncation of the same file', async () => {
    const root = await scratch()
    const journal = new Journal(root)
    await journal.record('step/queued', { runId: 'run', index: 1 })
    await journal.record('step/queued', { runId: 'run', index: 2 })
    const first = await new Journal(root).readAfter(null, { limit: 10 })
    await writeFile(journal.file, '', 'utf8')
    const page = await new Journal(root).readAfter(first.cursor, { limit: 10 })
    expect(page.reset).toBe(true)
    expect(page.events).toEqual([])
  })

  it('accepts historical events without a writer identity in the bounded tail', async () => {
    const root = await scratch()
    await mkdir(path.join(root, '.deep-cluster'), { recursive: true })
    const legacy = { seq: 0, at: new Date().toISOString(), type: 'run/start', data: { runId: 'legacy', title: 'old' } }
    await writeFile(path.join(root, '.deep-cluster', 'journal.jsonl'), `${JSON.stringify(legacy)}\n`, 'utf8')
    expect(await new Journal(root).tail(5)).toEqual([legacy])
    expect((await new Journal(root).readAfter(null, { limit: 5 })).events).toEqual([legacy])
  })

  it('fails loud on a corrupt complete line', async () => {
    const root = await scratch()
    const file = new Journal(root).file
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, '{"seq":0}\n', 'utf8')
    await expect(new Journal(root).readAfter(null, { limit: 5 })).rejects.toThrow(/journal is invalid at byte offset/u)
  })

  it('rejects malformed cursors', () => {
    expect(() => parseJournalCursor('not-a-cursor')).toThrow(JournalCursorError)
    expect(() => parseJournalCursor(Buffer.from('1:1:2:not-a-number').toString('base64url'))).toThrow(JournalCursorError)
    expect(() => parseJournalCursor(Buffer.from('2:1:2:3').toString('base64url'))).toThrow(JournalCursorError)
  })
})

describe('bounded tail', () => {
  it('returns only the requested newest records without a complete-history read', async () => {
    const root = await scratch()
    const journal = new Journal(root)
    for (let index = 0; index < 300; index++) await journal.record('step/queued', { runId: 'run', index })
    const tail = await new Journal(root).tail(5)
    expect(tail.map(event => event.data.index)).toEqual([295, 296, 297, 298, 299])
    expect((await new Journal(root).tail(5, 'run')).map(event => event.data.index)).toEqual([295, 296, 297, 298, 299])
    expect(await new Journal(root).tail(5, 'missing')).toEqual([])
  })
})
