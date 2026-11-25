/**
 * The coordination record for a DeepCluster run.
 *
 * Every observable decision — a step starting, an agent finishing, a gate
 * passing, a lease moving between agents, a role improvising on the plan — is
 * appended to one newline-delimited JSON log. The log is the single source of
 * truth a planner reads to understand what actually happened, so anything not
 * written here did not, as far as the planner can tell, happen.
 *
 * Append-only is deliberate: a crashed or interrupted run still leaves a usable
 * history, and a later reader never sees a half-rewritten event.
 *
 * @module @deepseek-ai/dsh-experimental-deep-cluster/journal
 */

import { appendFile, mkdir, open, readFile, writeFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import path from 'node:path'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { JournalWriterId } from './types.ts'

/** Current event vocabulary, including historical records accepted on read. */
const EVENT_TYPES = [
  'run/start', 'run/end', 'step/start', 'step/end', 'step/queued', 'step/blocked',
  'agent/start', 'agent/end', 'agent/activity', 'agent/log', 'agent/message', 'agent/usage', 'agent/token-sample', 'agent/token-error', 'task/outcome', 'gate/pass', 'gate/fail',
  'lease/wait', 'lease/acquire', 'lease/release', 'lease/reclaim', 'lease/quarantine',
  'improvisation/report', 'improvisation/ack', 'improvisation/reject', 'plan/amend',
  'repair/start', 'repair/end', 'sandbox/escalate', 'run/blocked',
  'policy/decision',
] as const

/** Every event type a run can record or read from historical journals. */
export type JournalEventType = typeof EVENT_TYPES[number]

/** One recorded event. */
export interface JournalEvent {
  /** Writer identity; older journals omit this field. Sequence numbers are writer-local. */
  readonly writerId?: JournalWriterId
  readonly seq: number
  readonly at: string
  readonly type: JournalEventType
  readonly data: Record<string, unknown>
}

/** Opaque incremental position: journal file identity plus a byte offset at a line boundary. */
export type JournalCursor = Branded<'DeepClusterJournalCursor'>

/** Decoded cursor fields; byte offsets are safe integers for one journal file. */
export interface JournalCursorPosition {
  readonly dev: string
  readonly ino: string
  readonly offset: number
}

/** One incremental page of journal events. */
export interface JournalPage {
  /** Events after the requested cursor, in append order. */
  readonly events: readonly JournalEvent[]
  /** Position for the next request; null when no journal file exists yet. */
  readonly cursor: JournalCursor | null
  /** True when the file identity or a shorter file invalidated the supplied cursor. */
  readonly reset: boolean
  /** True when readable bytes remain after this page. */
  readonly more: boolean
}

/** Options for one incremental journal read. */
export interface JournalPageOptions {
  /** Maximum matched events returned. */
  readonly limit: number
  /** Restrict events to one exact `data.runId`. */
  readonly runId?: string
}

/** A caller-supplied cursor that is not a valid encoded DeepCluster journal position. */
export class JournalCursorError extends Error {
  override name = 'JournalCursorError'
}

/** Bytes read from the journal for one incremental call; bounds unrelated-history scans. */
const MAX_PAGE_BYTES = 4 * 1024 * 1024
/** Bytes retained by a tail read; one tail request never parses the full append log. */
const MAX_TAIL_BYTES = 8 * 1024 * 1024
/** A single JSON event larger than this indicates corruption or a runaway payload. */
const MAX_LINE_BYTES = 4 * 1024 * 1024
/** Chunk size for incremental reads; keeps one poll's allocation bounded. */
const READ_CHUNK_BYTES = 256 * 1024
const CURSOR_VERSION = 1

interface OpenJournal {
  readonly handle: FileHandle
  readonly dev: string
  readonly ino: string
  readonly size: number
}

/** Encode one position as an opaque cursor. */
function encodeCursor(position: JournalCursorPosition): JournalCursor {
  return Buffer.from(`${String(CURSOR_VERSION)}:${position.dev}:${position.ino}:${String(position.offset)}`, 'utf8')
    .toString('base64url') as JournalCursor
}

/**
 * Decode an opaque cursor without accepting ambiguous or unsafe offsets.
 * @param value - cursor returned by a previous page or supplied by a client.
 * @returns the file identity and byte offset.
 * @throws {JournalCursorError} when the value is not a DeepCluster journal cursor.
 */
export function parseJournalCursor(value: string): JournalCursorPosition {
  let text: string
  try { text = Buffer.from(value, 'base64url').toString('utf8') } catch (error) {
    throw new JournalCursorError('The journal cursor is not valid base64url text.', { cause: error })
  }
  const match = /^(\d+):(\d+):(\d+):(\d+)$/u.exec(text)
  const offset = match === null ? Number.NaN : Number(match[4])
  if (match === null || match[1] !== String(CURSOR_VERSION) || !Number.isSafeInteger(offset) || offset < 0) {
    throw new JournalCursorError('The journal cursor does not identify a DeepCluster journal position.')
  }
  return { dev: match[2] as string, ino: match[3] as string, offset }
}

/**
 * Create the workspace's `.deep-cluster` state directory with a `.gitignore` that ignores
 * the whole directory, so no repository has to list it; an existing `.gitignore` is kept.
 * @param root - absolute workspace root.
 * @returns the state directory path.
 */
export async function ensureStateDirectory(root: string): Promise<string> {
  const directory = path.join(root, '.deep-cluster')
  await mkdir(directory, { recursive: true })
  try {
    await writeFile(path.join(directory, '.gitignore'), '*\n', { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  return directory
}

/** The on-disk log for one workspace. */
export class Journal {
  readonly #file: string
  #seq = 0
  readonly #writerId = randomUUID() as JournalWriterId
  #pending: Promise<void> = Promise.resolve()
  #failure: Error | undefined

  /**
   * @param root - workspace root; the log lives at `.deep-cluster/journal.jsonl`.
   */
  constructor(root: string) {
    this.#file = path.join(root, '.deep-cluster', 'journal.jsonl')
  }

  /** Absolute path of the log file. */
  get file(): string {
    return this.#file
  }

  /**
   * Append one event.
   * @param type - event kind.
   * @param data - JSON-serialisable payload.
   * @returns the recorded event.
   */
  async record(type: JournalEventType, data: Record<string, unknown> = {}): Promise<JournalEvent> {
    const write = this.#pending.then(async () => {
      if (this.#failure !== undefined) throw this.#failure
      await mkdir(path.dirname(this.#file), { recursive: true })
      const event: JournalEvent = { writerId: this.#writerId, seq: this.#seq++, at: new Date().toISOString(), type, data }
      await appendFile(this.#file, `${JSON.stringify(event)}\n`, 'utf8')
      return event
    })
    this.#pending = write.then(() => {}, (error: unknown) => {
      this.#failure = error instanceof Error ? error : new Error(String(error))
    })
    return await write
  }

  /**
   * Read every event written so far.
   * @returns validated events in write order; an unfinished final append is ignored. Other corruption rejects.
   */
  async read(): Promise<JournalEvent[]> {
    let text: string
    try {
      text = await readFile(this.#file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const events: JournalEvent[] = []
    const lines = text.split('\n')
    for (const [index, line] of lines.entries()) {
      if (line.trim() === '') continue
      if (index === lines.length - 1 && !text.endsWith('\n')) break
      events.push(parseEvent(line, `at line ${String(index + 1)}`))
    }
    return events
  }

  /**
   * Read the bounded tail without parsing the complete append log.
   * @param limit - maximum events returned after the run and type filters.
   * @param runId - optional exact run identity filter.
   * @param type - optional exact event type filter.
   * @returns the newest matching events within the bounded tail window, in append order.
   */
  async tail(limit: number, runId?: string, type?: JournalEventType): Promise<JournalEvent[]> {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('limit must be a positive integer')
    const file = await this.#open()
    if (file === null || file.size === 0) return []
    try {
      const start = Math.max(0, file.size - MAX_TAIL_BYTES)
      const text = (await readRange(file.handle, start, file.size)).toString('utf8')
      const lines = text.split('\n')
      if (start > 0) lines.shift()
      if (!text.endsWith('\n') || lines.at(-1) === '') lines.pop()
      const events: JournalEvent[] = []
      for (const line of lines) {
        if (line.trim() === '') continue
        const event = parseEvent(line, `in the final ${String(file.size - start)} bytes`)
        if ((runId === undefined || event.data.runId === runId) && (type === undefined || event.type === type)) events.push(event)
      }
      return events.slice(-limit)
    } finally {
      await file.handle.close()
    }
  }

  /**
   * Read only appended events after a cursor. Interleaved writers share one
   * append log, so the file identity and byte offset cover every writer
   * without relying on writer-local sequence numbers. Rotation, truncation,
   * and a replaced file reset the page instead of returning a false gap.
   * @param cursor - previous page cursor; null starts at the first byte.
   * @param options - page size and optional exact run filter.
   * @returns events, the next cursor, and reset/more facts.
   */
  async readAfter(cursor: JournalCursor | null, options: JournalPageOptions): Promise<JournalPage> {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1) throw new RangeError('limit must be a positive integer')
    const file = await this.#open()
    if (file === null) return { events: [], cursor: null, reset: cursor !== null, more: false }
    try {
      let start = 0
      let reset = false
      if (cursor !== null) {
        const position = parseJournalCursor(cursor)
        if (position.dev === file.dev && position.ino === file.ino && position.offset <= file.size) start = position.offset
        else reset = true
      }
      const events: JournalEvent[] = []
      const decoder = new StringDecoder('utf8')
      let buffer = ''
      let readOffset = start
      let consumed = start
      let scanned = 0
      let more = false
      while (readOffset < file.size) {
        if (scanned >= MAX_PAGE_BYTES) { more = true; break }
        const length = Math.min(READ_CHUNK_BYTES, file.size - readOffset, MAX_PAGE_BYTES - scanned)
        const chunk = await readRange(file.handle, readOffset, readOffset + length)
        if (chunk.length === 0) break
        scanned += chunk.length
        readOffset += chunk.length
        buffer += decoder.write(chunk)
        let newline = buffer.indexOf('\n')
        while (newline !== -1) {
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          const lineStart = consumed
          consumed += Buffer.byteLength(line, 'utf8') + 1
          if (line.trim() !== '') {
            const event = parseEvent(line, `at byte offset ${String(lineStart)}`)
            if (options.runId === undefined || event.data.runId === options.runId) {
              events.push(event)
              if (events.length >= options.limit) {
                more = consumed < file.size
                return { events, cursor: encodeCursor({ dev: file.dev, ino: file.ino, offset: consumed }), reset, more }
              }
            }
          }
          newline = buffer.indexOf('\n')
        }
        if (Buffer.byteLength(buffer, 'utf8') > MAX_LINE_BYTES) {
          throw new Error(`DeepCluster journal has a line longer than ${String(MAX_LINE_BYTES)} bytes at offset ${String(consumed)}; preserve the file and repair it before continuing.`)
        }
      }
      more = readOffset < file.size
      return { events, cursor: encodeCursor({ dev: file.dev, ino: file.ino, offset: consumed }), reset, more }
    } finally {
      await file.handle.close()
    }
  }

  /** Open the append log and capture the identity used by cursors. */
  async #open(): Promise<OpenJournal | null> {
    let handle: FileHandle
    try {
      handle = await open(this.#file, 'r')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    try {
      const info = await handle.stat({ bigint: true })
      return { handle, dev: String(info.dev), ino: String(info.ino), size: Number(info.size) }
    } catch (error) {
      await handle.close()
      throw error
    }
  }
}

/** Validate and decode one complete journal line. */
function parseEvent(line: string, location: string): JournalEvent {
  try {
    const value: unknown = JSON.parse(line)
    if (!isEvent(value)) throw new Error('invalid event fields')
    return value
  } catch (error) {
    throw new Error(`DeepCluster journal is invalid ${location}; preserve the file and repair it before continuing.`, { cause: error })
  }
}

/** Read a byte range without changing the caller-owned file position. */
async function readRange(handle: FileHandle, start: number, end: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(Math.max(0, end - start))
  if (buffer.length === 0) return buffer
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, start)
  return buffer.subarray(0, bytesRead)
}

/** Validate the persisted fields shared by every journal event. */
function isEvent(value: unknown): value is JournalEvent {
  if (typeof value !== 'object' || value === null) return false
  return 'seq' in value && typeof value.seq === 'number' && Number.isSafeInteger(value.seq) && value.seq >= 0 &&
    (!('writerId' in value) || (typeof value.writerId === 'string' && value.writerId.length > 0)) &&
    'at' in value && typeof value.at === 'string' && Number.isFinite(Date.parse(value.at)) &&
    'type' in value && EVENT_TYPES.some(type => type === value.type) &&
    'data' in value && typeof value.data === 'object' && value.data !== null && !Array.isArray(value.data)
}

/**
 * Fold a journal into the summary a planner reads first.
 * @param events - the full log.
 * @returns counts plus the open improvisations that still need a planner decision.
 */
export function summarize(events: readonly JournalEvent[]): {
  steps: number
  gatesPassed: number
  gatesFailed: number
  openImprovisations: JournalEvent[]
  leases: string[]
} {
  let steps = 0
  let gatesPassed = 0
  let gatesFailed = 0
  const open = new Map<string, JournalEvent>()
  const leases = new Set<string>()
  for (const event of events) {
    if (event.type === 'step/start') steps++
    if (event.type === 'gate/pass') gatesPassed++
    if (event.type === 'gate/fail') gatesFailed++
    if (event.type === 'lease/acquire' && typeof event.data.resource === 'string') leases.add(event.data.resource)
    if (event.type === 'improvisation/report' && typeof event.data.id === 'string') open.set(event.data.id, event)
    if (event.type === 'improvisation/ack' || event.type === 'improvisation/reject') {
      if (typeof event.data.id === 'string') open.delete(event.data.id)
    }
  }
  return { steps, gatesPassed, gatesFailed, openImprovisations: [...open.values()], leases: [...leases] }
}
