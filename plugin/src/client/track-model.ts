/**
 * Track-view model: per-worker activity clips, recorded connectors between workers, and observed token-rate history.
 * Every value derives from recorded journal rows; an open clip extends to the observation time only while its task is
 * still recorded as unfinished.
 */
import type { ClusterMessageView, ClusterTaskId, ClusterTaskView, ClusterTimelineEntry } from '../dashboard-types.ts'

/** What a worker was recorded doing during one clip. */
export type ClipKind = 'queued' | 'waiting' | 'starting' | 'thinking' | 'command' | 'read' | 'write' | 'tool' | 'idle'
/** One contiguous recorded state of a worker. */
export interface TrackClip {
  readonly kind: ClipKind
  readonly start: number
  readonly end: number
  readonly open: boolean
  readonly detail: string
}
/** A point event drawn on a track. */
export interface TrackMark { readonly id: string; readonly at: number; readonly type: string; readonly passed: boolean }
/** All recorded clips and marks of one worker. */
export interface TrackRow {
  readonly id: ClusterTaskId
  readonly clips: readonly TrackClip[]
  readonly marks: readonly TrackMark[]
  readonly start: number
  readonly end: number
}
/** Lane id of the controller, which sends messages but owns no task. */
export const CONTROLLER_LANE = 'controller'
/** A recorded relation between two lanes at specific times. */
export interface TrackConnector {
  readonly id: string
  readonly kind: 'message' | 'dependency'
  readonly from: ClusterTaskId | typeof CONTROLLER_LANE
  readonly to: ClusterTaskId
  readonly fromAt: number
  readonly toAt: number
  readonly phase: string
  readonly messageKind: string
  readonly text: string
}
/** One token-rate step; `at` starts a constant rate that lasts until the next point. */
export interface RatePoint { readonly at: number; readonly rate: number }

const MARK_TYPES = new Set(['gate/pass', 'gate/fail', 'task/outcome', 'improvisation/report', 'repair/start', 'lease/acquire'])
const ACTIVITY_CLIPS: Readonly<Record<ClusterTimelineEntry['activity'], ClipKind>> = {
  thinking: 'thinking', command: 'command', read: 'read', write: 'write', tool: 'tool', idle: 'idle', unknown: 'starting',
}

/**
 * Fold recorded events into clips for each task.
 * @param tasks - tasks to lay out, in display order.
 * @param timeline - retained timeline rows in any order.
 * @param now - observation time in milliseconds.
 * @returns one row per task; tasks without retained events have no clips.
 */
export function trackRows(tasks: readonly ClusterTaskView[], timeline: readonly ClusterTimelineEntry[], now: number): TrackRow[] {
  const byTask = new Map<string, ClusterTimelineEntry[]>()
  for (const entry of timeline) {
    if (entry.stepId === '') continue
    const key = `${entry.runId}/${entry.stepId}`
    const list = byTask.get(key)
    if (list === undefined) byTask.set(key, [entry]); else list.push(entry)
  }
  return tasks.map((task) => {
    const events = (byTask.get(task.id) ?? []).slice().sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.seq - b.seq)
    const clips: TrackClip[] = []
    const marks: TrackMark[] = []
    let open: { kind: ClipKind; start: number; detail: string } | null = null
    const close = (at: number): void => {
      if (open !== null && at > open.start) {
        const previous = clips[clips.length - 1]
        if (previous !== undefined && previous.kind === open.kind && previous.end >= open.start) {
          clips[clips.length - 1] = { ...previous, end: at }
        }
        else clips.push({ kind: open.kind, start: open.start, end: at, open: false, detail: open.detail })
      }
      open = null
    }
    const begin = (kind: ClipKind, at: number, detail: string): void => {
      if (open?.kind === kind) { open.detail = detail || open.detail; return }
      close(at)
      open = { kind, start: at, detail }
    }
    for (const event of events) {
      const at = Date.parse(event.at)
      if (!Number.isFinite(at)) continue
      if (MARK_TYPES.has(event.type)) marks.push({ id: event.id, at, type: event.type, passed: event.type !== 'gate/fail' })
      switch (event.type) {
        case 'step/queued': begin('queued', at, ''); break
        case 'lease/wait': begin('waiting', at, event.detail); break
        case 'step/start': case 'agent/start': case 'lease/acquire': case 'repair/start': begin('starting', at, ''); break
        case 'agent/activity': begin(ACTIVITY_CLIPS[event.activity], at, event.detail); break
        case 'agent/end': begin('idle', at, ''); break
        case 'step/end': case 'step/blocked': case 'task/outcome': close(at); break
        default: break
      }
    }
    const unfinished = task.status === 'running' || task.status === 'waiting' || task.status === 'queued'
    const pending = open as { kind: ClipKind; start: number; detail: string } | null
    if (pending !== null) {
      const end = unfinished ? Math.max(now, pending.start) : Math.max(pending.start, Date.parse(task.updatedAt) || pending.start)
      if (end > pending.start || unfinished) {
        clips.push({ kind: pending.kind, start: pending.start, end, open: unfinished, detail: pending.detail })
      }
    }
    const start = clips[0]?.start ?? marks[0]?.at ?? (Date.parse(task.updatedAt) || now)
    const end = Math.max(clips[clips.length - 1]?.end ?? start, marks[marks.length - 1]?.at ?? start)
    return { id: task.id, clips, marks, start, end }
  })
}

/**
 * Recorded dependency waits and messages between displayed lanes.
 * @param tasks - displayed tasks.
 * @param rows - rows from {@link trackRows} for the same tasks.
 * @param messages - recorded messages.
 * @param now - observation time used for a dependent that has not started.
 * @returns connectors whose endpoints are both displayed, deduplicated by message record.
 */
export function trackConnectors(tasks: readonly ClusterTaskView[], rows: readonly TrackRow[], messages: readonly ClusterMessageView[],
  now: number): TrackConnector[] {
  const rowOf = new Map(rows.map(row => [row.id as string, row]))
  const taskAt = new Map(tasks.map(task => [`${task.runId}/${task.stepId}`, task]))
  const connectors: TrackConnector[] = []
  for (const task of tasks) {
    const row = rowOf.get(task.id)
    for (const dependency of task.dependencies) {
      const predecessor = taskAt.get(`${task.runId}/${dependency}`)
      const before = predecessor === undefined ? undefined : rowOf.get(predecessor.id)
      if (predecessor === undefined || before === undefined || row === undefined) continue
      const started = row.clips.find(clip => clip.kind !== 'queued' && clip.kind !== 'waiting')
      connectors.push({ id: `dependency:${task.id}:${dependency}`, kind: 'dependency', from: predecessor.id, to: task.id,
        fromAt: before.end, toAt: started?.start ?? Math.max(now, before.end), phase: started === undefined ? 'pending' : 'released', messageKind: '', text: '' })
    }
  }
  for (const message of messages) {
    const recipient = taskAt.get(`${message.runId}/${message.toStepId}`)
    if (recipient === undefined) continue
    const sender = message.fromStepId === CONTROLLER_LANE ? CONTROLLER_LANE : taskAt.get(`${message.runId}/${message.fromStepId}`)?.id
    const at = Date.parse(message.at)
    if (sender === undefined || !Number.isFinite(at)) continue
    connectors.push({ id: `message:${message.id}`, kind: 'message', from: sender, to: recipient.id, fromAt: at, toAt: at,
      phase: message.phase, messageKind: message.kind, text: message.message })
  }
  return connectors
}

/** Accumulates timeline rows across journal snapshots, each of which retains only the newest rows, while the page is open. */
export class TimelineRecorder {
  readonly #entries = new Map<string, ClusterTimelineEntry>()
  #view: readonly ClusterTimelineEntry[] = []
  /** @param limit - maximum retained rows; the oldest rows are dropped first. */
  constructor(private readonly limit = 20_000) {}
  /**
   * Merge one snapshot.
   * @param timeline - rows of the latest snapshot in any order.
   * @returns every retained row, oldest first; the previous array when the snapshot added no row.
   */
  record(timeline: readonly ClusterTimelineEntry[]): readonly ClusterTimelineEntry[] {
    let added = false
    for (const entry of timeline) {
      if (this.#entries.has(entry.id)) continue
      this.#entries.set(entry.id, entry)
      added = true
    }
    if (!added) return this.#view
    const view = [...this.#entries.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.seq - b.seq)
    for (const dropped of view.splice(0, Math.max(0, view.length - this.limit))) this.#entries.delete(dropped.id)
    this.#view = view
    return view
  }
}

/** Buckets and sample identities retained for one task. */
interface RateState {
  readonly buckets: Map<number, number>
  readonly seen: Map<string, number>
  newest: number
  cached: readonly RatePoint[] | null
}

/** Stable series of a task with no samples ever seen. */
const EMPTY_RATE_POINTS: readonly RatePoint[] = []

/** Retains each task's tokens per wall-clock second observed while the page is open; completed seconds never change. */
export class RateRecorder {
  readonly #states = new Map<ClusterTaskId, RateState>()
  /** @param limit - maximum retained buckets per task; the oldest buckets are dropped first. */
  constructor(private readonly limit = 1800) {}
  /**
   * Add newly observed samples to their wall-clock second.
   * @param tasks - tasks with their retained samples.
   * @returns true when any bucket changed.
   */
  record(tasks: readonly ClusterTaskView[]): boolean {
    let changed = false
    for (const task of tasks) {
      if (task.tokenSamples.length === 0) continue
      let state = this.#states.get(task.id)
      if (state === undefined) {
        state = { buckets: new Map(), seen: new Map(), newest: -Infinity, cached: null }
        this.#states.set(task.id, state)
      }
      for (const sample of task.tokenSamples) {
        const identity = `${String(sample.observedAt)}:${String(sample.tokens)}`
        if (state.seen.has(identity)) continue
        state.seen.set(identity, sample.observedAt)
        const second = Math.floor(sample.observedAt / 1000) * 1000
        state.buckets.set(second, (state.buckets.get(second) ?? 0) + sample.tokens)
        state.newest = Math.max(state.newest, sample.observedAt)
        state.cached = null
        changed = true
      }
      const cutoff = state.newest - 10_000
      for (const [identity, observedAt] of state.seen) {
        if (observedAt < cutoff) state.seen.delete(identity)
      }
      while (state.buckets.size > Math.max(0, this.limit)) {
        state.buckets.delete(Math.min(...state.buckets.keys()))
        state.cached = null
        changed = true
      }
    }
    return changed
  }
  /**
   * Per-second history of one task as a step series: each completed second keeps its total, and a missing next
   * second ends the step with a zero.
   * @param id - task id.
   * @returns points in time order; empty when no samples were observed.
   */
  series(id: ClusterTaskId): readonly RatePoint[] {
    const state = this.#states.get(id)
    if (state === undefined) return EMPTY_RATE_POINTS
    if (state.cached !== null) return state.cached
    const points: RatePoint[] = []
    for (const second of [...state.buckets.keys()].sort((a, b) => a - b)) {
      points.push({ at: second, rate: Math.max(0, state.buckets.get(second) as number) })
      if (!state.buckets.has(second + 1000)) points.push({ at: second + 1000, rate: 0 })
    }
    state.cached = points
    return points
  }
  /**
   * Largest per-second rate of the given tasks.
   * @param ids - task ids to inspect.
   * @returns the largest series rate, or 0 when none is retained.
   */
  peak(ids: readonly ClusterTaskId[]): number {
    let peak = 0
    for (const id of ids) {
      for (const point of this.series(id)) if (point.rate > peak) peak = point.rate
    }
    return peak
  }
}

/**
 * Mean of a step series over a time interval.
 * @param series - points in time order; each rate lasts until the next point, and 0 precedes the first point.
 * @param from - interval start in milliseconds, inclusive.
 * @param to - interval end in milliseconds, exclusive.
 * @returns the mean rate over `[from, to)`, or the rate at `from` when the interval is empty.
 */
export function averageRate(series: readonly RatePoint[], from: number, to: number): number {
  let low = 0
  let high = series.length
  let index = -1
  while (low < high) {
    const mid = (low + high) >>> 1
    if ((series[mid] as RatePoint).at <= from) {
      index = mid
      low = mid + 1
    } else high = mid
  }
  let value = index < 0 ? 0 : (series[index] as RatePoint).rate
  if (to <= from) return value
  let total = 0
  let cursor = from
  while (cursor < to) {
    const next = series[index + 1]
    const end = next === undefined ? to : Math.min(to, next.at)
    total += value * (end - cursor)
    if (next === undefined || end === to) break
    cursor = next.at
    value = next.rate
    index += 1
  }
  return total / (to - from)
}
