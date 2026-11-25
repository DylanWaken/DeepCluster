/** Merge workspace journals without changing writer order or colliding historical run identities. */
import path from 'node:path'
import { realpath } from 'node:fs/promises'
import { DashboardAccumulator, projectDashboard } from './dashboard.ts'
import { Journal, type JournalCursor, type JournalEvent } from './journal.ts'
import type { ClusterDashboardSnapshot } from './dashboard-types.ts'
import type { JournalWriterId } from './types.ts'

/** Normalize one source's records across incremental pages with stable legacy identities. */
class SourceRecords {
  private legacyRun: string
  private index = 0

  constructor(readonly root: string) { this.legacyRun = `legacy:${root}` }

  normalize(events: readonly JournalEvent[]): JournalEvent[] {
    return events.map((event) => {
      const index = this.index++
      if (event.type === 'run/start' && typeof event.data.runId !== 'string') this.legacyRun = `legacy:${this.root}:${index}`
      return { ...event, writerId: event.writerId ?? `legacy:${this.root}:${index}` as JournalWriterId,
        data: typeof event.data.runId === 'string' ? event.data : { ...event.data, runId: this.legacyRun } }
    })
  }
}

function sourceRecords(events: readonly JournalEvent[], root: string): JournalEvent[] {
  return new SourceRecords(root).normalize(events)
}

function mergeRecords(sources: readonly (readonly JournalEvent[])[]): JournalEvent[] {
  const cursors = sources.map(source => ({ source, index: 0 })), merged: JournalEvent[] = []
  while (true) {
    let selected: { cursor: typeof cursors[number]; event: JournalEvent } | undefined
    for (const cursor of cursors) {
      const event = cursor.source[cursor.index]
      if (event !== undefined && (selected === undefined || Date.parse(event.at) < Date.parse(selected.event.at))) {
        selected = { cursor, event }
      }
    }
    if (selected === undefined) return merged
    merged.push(selected.event); selected.cursor.index++
  }
}

/** Canonicalize existing roots so aliases never duplicate telemetry; absent roots retain an empty observation. */
async function journalRoot(root: string): Promise<string> {
  const absolute = path.resolve(root)
  try { return await realpath(absolute) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return absolute
    throw error
  }
}

/**
 * Project complete configured journals; only displayed timeline, outcome, and message history are bounded.
 * @param workspace - primary journal root displayed to the operator.
 * @param workspaces - additional roots; duplicate paths are read once.
 * @param eventLimit - maximum displayed timeline, outcome, and message records.
 * @returns merged recorded state; any unreadable or corrupt source rejects the entire observation.
 */
export async function readApiDashboard(
  workspace: string, workspaces: readonly string[], eventLimit: number,
): Promise<ClusterDashboardSnapshot> {
  const primary = await journalRoot(workspace)
  const roots = [...new Set([primary, ...await Promise.all(workspaces.map(journalRoot))])]
  const sources = await Promise.all(roots.map(async root => sourceRecords(await new Journal(root).read(), root)))
  return { ...projectDashboard(mergeRecords(sources), primary, eventLimit), workspaces: roots }
}

/** Maximum complete root-set observations retained by one API runtime. */
const MAX_DASHBOARD_CACHE_ENTRIES = 4
/** Events requested per incremental page; the journal also bounds every call by bytes. */
const DASHBOARD_PAGE_EVENTS = 1000

interface SourceCursor {
  readonly reader: SourceRecords
  cursor: JournalCursor | null
}

interface DashboardCacheEntry {
  readonly roots: readonly string[]
  sources: SourceCursor[]
  accumulator: DashboardAccumulator
  readonly retention: number
}

interface SourceBatch {
  readonly events: readonly JournalEvent[]
  readonly cursor: JournalCursor | null
  readonly reset: boolean
}

/**
 * Per-runtime dashboard observation cache. The first poll of a root set reads
 * complete journals once; later polls use journal cursors and fold only
 * appended complete records. A rotation or truncation resets and rebuilds the
 * affected observation. Retention is bounded to the largest requested
 * `eventLimit` for the cached root set, and at most four root sets are kept.
 */
export class DashboardCache {
  private readonly entries = new Map<string, DashboardCacheEntry>()

  /**
   * @param workspace - primary workspace root.
   * @param workspaces - additional workspace roots.
   * @param eventLimit - maximum timeline, outcome, and message rows retained for this poll.
   * @returns merged projection over the canonical root set.
   */
  async snapshot(workspace: string, workspaces: readonly string[], eventLimit: number): Promise<ClusterDashboardSnapshot> {
    const primary = await journalRoot(workspace)
    const roots = [...new Set([primary, ...await Promise.all(workspaces.map(journalRoot))])]
    const key = roots.join('\n')
    let entry = this.entries.get(key)
    if (entry === undefined || eventLimit > entry.retention) {
      entry = { roots, sources: roots.map(root => ({ reader: new SourceRecords(root), cursor: null })),
        accumulator: new DashboardAccumulator(eventLimit), retention: eventLimit }
      this.entries.set(key, entry)
    } else {
      this.entries.delete(key)
      this.entries.set(key, entry)
    }
    while (this.entries.size > MAX_DASHBOARD_CACHE_ENTRIES) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
    await this.refresh(entry)
    return { ...entry.accumulator.snapshot(primary, eventLimit), workspaces: roots }
  }

  /** Read appended pages, rebuilding the complete observation when a source rotated or truncated. */
  private async refresh(entry: DashboardCacheEntry): Promise<void> {
    let batches = await Promise.all(entry.sources.map(async source => await this.readSource(source)))
    if (batches.some(batch => batch.reset)) {
      entry.sources = entry.roots.map(root => ({ reader: new SourceRecords(root), cursor: null }))
      entry.accumulator = new DashboardAccumulator(entry.retention)
      batches = await Promise.all(entry.sources.map(async source => await this.readSource(source)))
      if (batches.some(batch => batch.reset)) throw new Error('DeepCluster dashboard journal changed repeatedly during a complete reread; retry after the writer settles.')
    }
    const normalized = batches.map((batch, index) => {
      const source = entry.sources[index] as SourceCursor
      source.cursor = batch.cursor
      return source.reader.normalize(batch.events)
    })
    entry.accumulator.append(mergeRecords(normalized))
  }

  /** Read all complete pages beyond one source cursor. */
  private async readSource(source: SourceCursor): Promise<SourceBatch> {
    const journal = new Journal(source.reader.root)
    const events: JournalEvent[] = []
    let cursor = source.cursor
    let reset = false
    for (;;) {
      const page = await journal.readAfter(cursor, { limit: DASHBOARD_PAGE_EVENTS })
      events.push(...page.events)
      reset ||= page.reset
      cursor = page.cursor
      if (!page.more) break
    }
    return { events, cursor, reset }
  }
}
