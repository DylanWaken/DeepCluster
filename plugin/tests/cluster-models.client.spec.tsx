// @vitest-environment jsdom
/** Observable behavior of grid routing, track modeling, motion curves, and control-room chrome. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClusterMessageView, ClusterRecordId, ClusterTaskId, ClusterTaskView, ClusterTimelineEntry } from '../src/dashboard-types.ts'
import type { AgentTokenSample, RunId } from '../src/types.ts'
import { CELL, cellCenter, cellSlot, routeClearance, routeLink, type RouteNode } from '../src/client/routing.ts'
import {
  averageRate, CONTROLLER_LANE, RateRecorder, TimelineRecorder, trackConnectors, trackRows, type RatePoint,
} from '../src/client/track-model.ts'
import { elementAt, entryOf, present } from '../src/client/invariant.ts'
import { EASE_OUT_CSS, easeInOut, easeOut, frameClock, reducedMotion, spring, stepSpring, tweenProgress } from '../src/client/motion.ts'
import {
  Bracket, Chip, Ghost, Grain, Halftone, PlateSelect, RegCross, Roll, useScramble, type PlateOption,
} from '../src/client/chrome.tsx'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  StubResizeObserver.instances.length = 0
})

const RUN = 'run' as RunId
const BASE = Date.parse('2026-10-23T08:00:00.000Z')
let sequence = 0

function at(second: number): string { return new Date(BASE + second * 1000).toISOString() }

function task(stepId: string, overrides: Partial<ClusterTaskView> = {}): ClusterTaskView {
  return {
    id: `${RUN}/${stepId}` as ClusterTaskId,
    runId: RUN,
    stepId,
    title: `Task ${stepId}`,
    role: 'worker',
    status: 'running',
    activity: 'thinking',
    detail: '',
    attempt: 1,
    dependencies: [],
    resources: [],
    usage: null,
    tokenSamples: [],
    tokenError: null,
    waitingResource: null,
    updatedAt: at(10),
    ...overrides,
  }
}

function event(stepId: string, type: string, second: number, overrides: Partial<ClusterTimelineEntry> = {}): ClusterTimelineEntry {
  sequence += 1
  return {
    id: `${stepId}:${String(sequence)}` as ClusterRecordId,
    seq: sequence,
    at: at(second),
    type,
    runId: RUN,
    stepId,
    role: 'worker',
    activity: 'unknown',
    detail: '',
    ...overrides,
  }
}

function message(id: string, fromStepId: string, toStepId: string, overrides: Partial<ClusterMessageView> = {}): ClusterMessageView {
  return {
    id: id as ClusterRecordId,
    runId: RUN,
    fromStepId,
    toStepId,
    kind: 'handoff',
    phase: 'sent',
    messageId: null,
    message: `note ${id}`,
    at: at(3),
    ...overrides,
  }
}

function token(tokens: number, observedAt: number): AgentTokenSample {
  return { tokens, observedAt, basis: 'tokenizer', tokenizer: 'fixture' }
}

function node(id: string, i: number, j: number, half = 1.6): RouteNode { return { id, cell: { i, j }, half } }

function axisDistance(point: { x: number; z: number }, center: { x: number; z: number }): number {
  return Math.hypot(point.x - center.x, point.z - center.z)
}

interface FrameHarness {
  readonly callbacks: Map<number, FrameRequestCallback>
  readonly cancelled: number[]
  run(now: number): void
  pending(): number
}

function installFrames(): FrameHarness {
  const callbacks = new Map<number, FrameRequestCallback>()
  const cancelled: number[] = []
  let next = 1
  const harness: FrameHarness = {
    callbacks,
    cancelled,
    pending: () => callbacks.size,
    run(now) {
      const due = [...callbacks.values()]
      callbacks.clear()
      for (const callback of due) callback(now)
    },
  }
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { const id = next; next += 1; callbacks.set(id, callback); return id })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { cancelled.push(id); callbacks.delete(id) })
  return harness
}

class StubResizeObserver implements ResizeObserver {
  static readonly instances: StubResizeObserver[] = []
  readonly disconnect = vi.fn()
  readonly unobserve = vi.fn()
  readonly observed: Element[] = []
  constructor(readonly callback: ResizeObserverCallback) { StubResizeObserver.instances.push(this) }
  observe(target: Element): void { this.observed.push(target) }
}

function Scramble({ text, duration }: { readonly text: string; readonly duration?: number | undefined }) {
  return <span data-testid="scramble">{useScramble(text, duration)}</span>
}

const VIEW_OPTIONS: readonly PlateOption<string>[] = [
  { id: 'map', label: 'Map', index: '01' },
  { id: 'tracks', label: 'Tracks', mark: true },
  { id: 'log', label: 'Log' },
]

describe('routing', () => {
  beforeEach(() => { sequence = 0 })

  it('places successive slots on square rings without moving earlier ones', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8].map(cellSlot)).toEqual([
      { i: 0, j: 0 }, { i: 1, j: 0 }, { i: 0, j: 1 }, { i: 1, j: 1 }, { i: 2, j: 0 },
      { i: 2, j: 1 }, { i: 0, j: 2 }, { i: 1, j: 2 }, { i: 2, j: 2 },
    ])
    const slots = Array.from({ length: 100 }, (_, index) => cellSlot(index))
    expect(new Set(slots.map(slot => `${String(slot.i)},${String(slot.j)}`)).size).toBe(100)
    expect(slots.slice(0, 9)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8].map(cellSlot))
    expect(cellCenter({ i: 2, j: 3 })).toEqual({ x: 2 * CELL, z: 3 * CELL })
  })

  it('returns no route when either endpoint is missing or both are the same node', () => {
    const nodes = [node('a', 0, 0), node('b', 1, 0)]
    expect(routeLink(nodes, 'missing', 'b')).toBeNull()
    expect(routeLink(nodes, 'a', 'missing')).toBeNull()
    expect(routeLink(nodes, 'a', 'a')).toBeNull()
  })

  it('connects adjacent faces through their shared lane point', () => {
    const a = node('a', 0, 0), b = node('b', 1, 0)
    expect(routeLink([a, b], 'a', 'b')).toEqual([{ x: 1.6, z: 0 }, { x: 6.4, z: 0 }])
  })

  it('bends a smooth route around an occupied cell and keeps every footprint clear', () => {
    const nodes = [node('a', 0, 0), node('blocker', 1, 0), node('b', 2, 0)]
    const points = routeLink(nodes, 'a', 'b')
    expect(points).not.toBeNull()
    const route = points!
    expect(route.length).toBeGreaterThan(8)
    for (let index = 1; index < route.length; index++) {
      const previous = route[index - 1]!, point = route[index]!
      expect(Math.hypot(point.x - previous.x, point.z - previous.z)).toBeGreaterThan(0)
    }
    expect(axisDistance(route[0]!, cellCenter(nodes[0]!.cell))).toBeCloseTo(nodes[0]!.half)
    expect(axisDistance(route.at(-1)!, cellCenter(nodes[2]!.cell))).toBeCloseTo(nodes[2]!.half)
    expect(route.some(point => point.z !== 0)).toBe(true)
    expect(routeClearance(route, nodes, ['a', 'b'])).toBeGreaterThan(1)
  })

  it('shifts parallel routes sideways and clamps the shift to the lane clearance', () => {
    const nodes = [node('a', 0, 0), node('blocker', 1, 0), node('b', 2, 0)]
    const center = routeLink(nodes, 'a', 'b')!
    const shifted = routeLink(nodes, 'a', 'b', 0.9, 1.2)!
    expect(shifted).not.toEqual(center)
    expect(routeClearance(shifted, nodes, ['a', 'b'])).toBeGreaterThan(0)
    expect(routeLink(nodes, 'a', 'b', 5)).toEqual(routeLink(nodes, 'a', 'b', 1.2))
    expect(routeLink(nodes, 'a', 'b', -5)).toEqual(routeLink(nodes, 'a', 'b', -1.2))
  })

  it('collapses a route between touching footprints to the shared contact point', () => {
    const points = routeLink([node('a', 0, 0, 4), node('b', 1, 0, 4)], 'a', 'b')
    expect(points).toEqual([{ x: 4, z: 0 }, { x: 4, z: 0 }])
  })

  it('measures the smallest gap from sampled points to every non-endpoint footprint', () => {
    const footprint = node('a', 0, 0, 2)
    expect(routeClearance([], [footprint], [])).toBe(Infinity)
    expect(routeClearance([{ x: 5, z: 0 }], [footprint], [])).toBe(3)
    expect(routeClearance([{ x: 0, z: 5 }], [footprint], [])).toBe(3)
    expect(routeClearance([{ x: 0.5, z: 0.5 }], [footprint], [])).toBe(-1.5)
    expect(routeClearance([{ x: 5, z: 0 }], [footprint], ['a'])).toBe(Infinity)
  })
})

describe('track rows', () => {
  beforeEach(() => { sequence = 0 })

  it('folds recorded events into closed clips, marks, and one open clip', () => {
    const timeline = [
      event('1', 'step/end', 20),
      event('1', 'agent/activity', 5, { activity: 'command', detail: 'run tests' }),
      event('1', 'step/queued', 1),
      event('1', 'gate/fail', 14),
      event('1', 'agent/activity', 7, { activity: 'read', detail: 'src/a.ts' }),
      event('1', 'lease/wait', 2, { detail: 'gpu0' }),
      event('1', 'agent/activity', 6, { activity: 'command', detail: '' }),
      event('1', 'step/start', 3),
      event('1', 'agent/activity', 4, { activity: 'thinking', detail: 'plan' }),
      event('1', 'agent/activity', 8, { activity: 'write', detail: 'src/b.ts' }),
      event('1', 'agent/activity', 9, { activity: 'tool', detail: 'bash' }),
      event('1', 'agent/activity', 10, { activity: 'idle' }),
      event('1', 'agent/activity', 11, { activity: 'unknown' }),
      event('1', 'lease/acquire', 12),
      event('1', 'gate/pass', 13),
      event('1', 'improvisation/report', 15),
      event('1', 'repair/start', 16),
      event('1', 'task/outcome', 17),
      event('1', 'agent/start', 18),
      event('1', 'agent/end', 19),
      event('1', 'step/blocked', 21),
      event('1', 'gate/pass', 22),
      event('1', 'agent/activity', 22, { activity: 'thinking', detail: 'next' }),
      event('1', 'agent/activity', 99, { at: 'not-a-time' }),
    ]
    const rows = trackRows([task('1')], timeline, Date.parse(at(60)))
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.id).toBe('run/1')
    expect(row.clips.map(clip => [clip.kind, clip.start, clip.end, clip.open])).toEqual([
      ['queued', Date.parse(at(1)), Date.parse(at(2)), false],
      ['waiting', Date.parse(at(2)), Date.parse(at(3)), false],
      ['starting', Date.parse(at(3)), Date.parse(at(4)), false],
      ['thinking', Date.parse(at(4)), Date.parse(at(5)), false],
      ['command', Date.parse(at(5)), Date.parse(at(7)), false],
      ['read', Date.parse(at(7)), Date.parse(at(8)), false],
      ['write', Date.parse(at(8)), Date.parse(at(9)), false],
      ['tool', Date.parse(at(9)), Date.parse(at(10)), false],
      ['idle', Date.parse(at(10)), Date.parse(at(11)), false],
      ['starting', Date.parse(at(11)), Date.parse(at(17)), false],
      ['starting', Date.parse(at(18)), Date.parse(at(19)), false],
      ['idle', Date.parse(at(19)), Date.parse(at(20)), false],
      ['thinking', Date.parse(at(22)), Date.parse(at(60)), true],
    ])
    expect(row.clips[4]!.detail).toBe('run tests')
    expect(row.clips[1]!.detail).toBe('gpu0')
    expect(row.marks.map(mark => [mark.type, mark.passed])).toEqual([
      ['lease/acquire', true], ['gate/pass', true], ['gate/fail', false], ['improvisation/report', true],
      ['repair/start', true], ['task/outcome', true], ['gate/pass', true],
    ])
    expect(row.start).toBe(Date.parse(at(1)))
    expect(row.end).toBe(Date.parse(at(60)))
  })

  it('merges a reopened clip into its neighbor and ignores closes that do not advance time', () => {
    const timeline = [
      event('2', 'step/end', 2),
      event('2', 'agent/activity', 2, { activity: 'thinking' }),
      event('2', 'agent/activity', 1, { activity: 'thinking' }),
      event('2', 'step/end', 3),
      event('2', 'step/queued', 5),
      event('2', 'step/end', 5),
      event('2', 'gate/pass', 7),
    ]
    const row = trackRows([task('2', { status: 'passed' })], timeline, Date.parse(at(20)))[0]!
    expect(row.clips).toEqual([
      { kind: 'thinking', start: Date.parse(at(1)), end: Date.parse(at(3)), open: false, detail: '' },
    ])
    expect(row.marks.map(mark => mark.type)).toEqual(['gate/pass'])
    expect(row.start).toBe(Date.parse(at(1)))
    expect(row.end).toBe(Date.parse(at(7)))
  })

  it('extends open clips only while the task is recorded as unfinished', () => {
    const statuses = ['running', 'waiting', 'queued', 'passed', 'failed', 'blocked'] as const
    const tasks = statuses.map((status, index) => task(String(index + 1), { status, updatedAt: at(10) }))
    const rows = trackRows(tasks, tasks.map(candidate => event(candidate.stepId, 'agent/activity', 1, { activity: 'thinking' })), Date.parse(at(20)))
    expect(rows.map(row => row.clips.map(clip => [clip.end, clip.open]))).toEqual([
      [[Date.parse(at(20)), true]],
      [[Date.parse(at(20)), true]],
      [[Date.parse(at(20)), true]],
      [[Date.parse(at(10)), false]],
      [[Date.parse(at(10)), false]],
      [[Date.parse(at(10)), false]],
    ])
  })

  it('falls back to the recorded update time or observation time for tasks without retained clips', () => {
    const rows = trackRows([
      task('1', { status: 'passed', updatedAt: at(5) }),
      task('2', { status: 'passed', updatedAt: 'invalid' }),
      task('3', { status: 'passed', updatedAt: 'invalid' }),
    ], [
      event('2', 'agent/activity', 4, { activity: 'write' }),
      event('', 'step/start', 1),
      event('3', 'gate/pass', 6),
    ], Date.parse(at(60)))
    expect(rows[0]!.clips).toEqual([])
    expect(rows[0]!.start).toBe(Date.parse(at(5)))
    expect(rows[0]!.end).toBe(Date.parse(at(5)))
    expect(rows[1]!.clips).toEqual([])
    expect(rows[1]!.start).toBe(Date.parse(at(60)))
    expect(rows[1]!.end).toBe(Date.parse(at(60)))
    expect(rows[2]!.clips).toEqual([])
    expect(rows[2]!.marks).toHaveLength(1)
    expect(rows[2]!.start).toBe(Date.parse(at(6)))
    expect(rows[2]!.end).toBe(Date.parse(at(6)))
  })
})

describe('track connectors', () => {
  beforeEach(() => { sequence = 0 })

  it('draws dependency waits and recorded messages between displayed lanes', () => {
    const tasks = [
      task('1', { status: 'queued', dependencies: ['2'] }),
      task('2', { status: 'running' }),
      task('4', { dependencies: ['1'] }),
      task('3', { dependencies: ['9'] }),
    ]
    const timeline = [
      event('1', 'step/queued', 2),
      event('2', 'agent/activity', 1, { activity: 'thinking' }),
      event('4', 'step/start', 3),
    ]
    const now = Date.parse(at(20))
    const rows = trackRows(tasks, timeline, now)
    const connectors = trackConnectors(tasks, rows, [
      message('m1', CONTROLLER_LANE, '1'),
      message('m2', '2', '1', { phase: 'delivered', kind: 'feedback' }),
      message('m3', '2', '9'),
      message('m4', '9', '1'),
      message('m5', '2', '1', { at: 'not-a-time' }),
    ], now)
    expect(connectors).toEqual([
      { id: 'dependency:run/1:2', kind: 'dependency', from: 'run/2', to: 'run/1', fromAt: now, toAt: now, phase: 'pending', messageKind: '', text: '' },
      { id: 'dependency:run/4:1', kind: 'dependency', from: 'run/1', to: 'run/4', fromAt: now, toAt: Date.parse(at(3)), phase: 'released', messageKind: '', text: '' },
      { id: 'message:m1', kind: 'message', from: CONTROLLER_LANE, to: 'run/1', fromAt: Date.parse(at(3)), toAt: Date.parse(at(3)), phase: 'sent', messageKind: 'handoff', text: 'note m1' },
      { id: 'message:m2', kind: 'message', from: 'run/2', to: 'run/1', fromAt: Date.parse(at(3)), toAt: Date.parse(at(3)), phase: 'delivered', messageKind: 'feedback', text: 'note m2' },
    ])
  })

  it('drops dependency connectors whose lane or target row is absent', () => {
    const dependent = task('1', { dependencies: ['2'] })
    const predecessor = task('2')
    const now = Date.parse(at(20))
    expect(trackConnectors([dependent, predecessor], [], [], now)).toEqual([])
    expect(trackConnectors([dependent, predecessor], [trackRows([predecessor], [], now)[0]!], [], now)).toEqual([])
    expect(trackConnectors([dependent, predecessor], trackRows([dependent, predecessor], [], now), [], now)).toEqual([
      { id: 'dependency:run/1:2', kind: 'dependency', from: 'run/2', to: 'run/1', fromAt: Date.parse(at(10)), toAt: now, phase: 'pending', messageKind: '', text: '' },
    ])
  })
})

describe('timeline recorder', () => {
  beforeEach(() => { sequence = 0 })

  it('merges snapshots by record id, sorts oldest first, and keeps the previous array without new rows', () => {
    const recorder = new TimelineRecorder()
    const first = event('1', 'step/queued', 3)
    const second = event('2', 'step/start', 1)
    const third = event('3', 'agent/end', 1, { seq: 9 })
    expect(recorder.record([])).toEqual([])
    const merged = recorder.record([first, third, second])
    expect(merged.map(item => item.id)).toEqual([second.id, third.id, first.id])
    expect(recorder.record([first])).toBe(merged)
    expect(recorder.record([])).toBe(merged)
    expect(recorder.record([{ ...first, type: 'step/end' }])).toBe(merged)
  })

  it('drops the oldest rows beyond the limit and accepts a dropped row again', () => {
    const recorder = new TimelineRecorder(2)
    const first = event('1', 'step/queued', 1)
    const second = event('2', 'step/queued', 2)
    const third = event('3', 'step/queued', 3)
    expect(recorder.record([first, second])).toEqual([first, second])
    const limited = recorder.record([third])
    expect(limited.map(item => item.id)).toEqual([second.id, third.id])
    expect(recorder.record([third, second])).toBe(limited)
    expect(recorder.record([first])).toEqual([second, third])
  })
})

describe('typed invariants', () => {
  it('names the violated invariant when a supposedly present value is absent', () => {
    expect(() => elementAt([], 0)).toThrow('required element 0 is outside a sequence of 0')
    expect(() => entryOf(new Map<string, number>(), 'missing')).toThrow('required map entry missing is missing')
    expect(() => present(null, 'worker')).toThrow('required worker is missing')
  })
})

const RATE_TASK = 'run/1' as ClusterTaskId
const RATE_TASK_2 = 'run/2' as ClusterTaskId
const MISSING_TASK = 'run/missing' as ClusterTaskId

describe('rate recorder', () => {
  it('buckets unseen samples by wall-clock second and ignores a repeated snapshot', () => {
    const recorder = new RateRecorder()
    expect(recorder.record([])).toBe(false)
    expect(recorder.record([task('1')])).toBe(false)
    expect(recorder.series(RATE_TASK)).toEqual([])
    const first = task('1', { tokenSamples: [token(10, BASE + 200), token(5, BASE + 700)] })
    expect(recorder.record([first])).toBe(true)
    const retained = recorder.series(RATE_TASK)
    expect(retained).toEqual([{ at: BASE, rate: 15 }, { at: BASE + 1000, rate: 0 }])
    expect(recorder.series(RATE_TASK)).toBe(retained)
    expect(recorder.record([first])).toBe(false)
    expect(recorder.series(RATE_TASK)).toBe(retained)
    expect(recorder.record([task('1', { tokenSamples: [token(10, BASE + 200), token(5, BASE + 700), token(4, BASE + 1500)] })])).toBe(true)
    expect(recorder.series(RATE_TASK)).toEqual([
      { at: BASE, rate: 15 }, { at: BASE + 1000, rate: 4 }, { at: BASE + 2000, rate: 0 },
    ])
  })

  it('forgets sample identities older than ten seconds before the newest observation', () => {
    const recorder = new RateRecorder()
    expect(recorder.record([task('1', { tokenSamples: [token(10, BASE)] })])).toBe(true)
    expect(recorder.record([task('1', { tokenSamples: [token(10, BASE)] })])).toBe(false)
    expect(recorder.record([task('1', { tokenSamples: [token(20, BASE + 11_000)] })])).toBe(true)
    expect(recorder.series(RATE_TASK)).toEqual([
      { at: BASE, rate: 10 }, { at: BASE + 1000, rate: 0 },
      { at: BASE + 11_000, rate: 20 }, { at: BASE + 12_000, rate: 0 },
    ])
    expect(recorder.record([task('1', { tokenSamples: [token(10, BASE)] })])).toBe(true)
    expect(recorder.series(RATE_TASK)[0]).toEqual({ at: BASE, rate: 20 })
  })

  it('keeps only the newest buckets under the limit', () => {
    const recorder = new RateRecorder(2)
    for (const second of [0, 1, 2]) {
      expect(recorder.record([task('1', { tokenSamples: [token(10 * (second + 1), BASE + second * 1000)] })])).toBe(true)
    }
    expect(recorder.series(RATE_TASK)).toEqual([
      { at: BASE + 1000, rate: 20 }, { at: BASE + 2000, rate: 30 }, { at: BASE + 3000, rate: 0 },
    ])
  })

  it('clamps negative bucket totals to zero and retains zero-token buckets', () => {
    const recorder = new RateRecorder()
    expect(recorder.record([task('1', {
      tokenSamples: [token(-9, BASE + 100), token(4, BASE + 900), token(0, BASE + 1500)],
    })])).toBe(true)
    expect(recorder.series(RATE_TASK)).toEqual([
      { at: BASE, rate: 0 }, { at: BASE + 1000, rate: 0 }, { at: BASE + 2000, rate: 0 },
    ])
  })

  it('reports the largest per-second rate across tasks', () => {
    const recorder = new RateRecorder()
    expect(recorder.peak([RATE_TASK])).toBe(0)
    expect(recorder.record([
      task('1', { tokenSamples: [token(10, BASE), token(20, BASE + 100)] }),
      task('2', { tokenSamples: [token(400, BASE)] }),
    ])).toBe(true)
    expect(recorder.peak([RATE_TASK])).toBe(30)
    expect(recorder.peak([RATE_TASK_2])).toBe(400)
    expect(recorder.peak([MISSING_TASK])).toBe(0)
    expect(recorder.peak([RATE_TASK, RATE_TASK_2])).toBe(400)
  })
})

describe('step averages', () => {
  const series: readonly RatePoint[] = [
    { at: BASE, rate: 10 }, { at: BASE + 1000, rate: 20 }, { at: BASE + 2000, rate: 0 },
  ]

  it('averages the step function across partial and multiple seconds', () => {
    expect(averageRate(series, BASE, BASE + 2000)).toBe(15)
    expect(averageRate(series, BASE + 500, BASE + 1500)).toBe(15)
    expect(averageRate(series, BASE + 1500, BASE + 2500)).toBe(10)
    expect(averageRate(series, BASE + 250, BASE + 750)).toBe(10)
    expect(averageRate(series, BASE - 500, BASE + 500)).toBeCloseTo(5)
  })

  it('returns the value at an empty interval and zero before the first point', () => {
    expect(averageRate(series, BASE + 500, BASE + 500)).toBe(10)
    expect(averageRate(series, BASE + 500, BASE + 100)).toBe(10)
    expect(averageRate(series, BASE + 3000, BASE + 3000)).toBe(0)
    expect(averageRate(series, BASE + 3000, BASE + 2000)).toBe(0)
    expect(averageRate(series, BASE - 1000, BASE - 500)).toBe(0)
    expect(averageRate([], BASE, BASE + 1000)).toBe(0)
  })

  it('walks across step changes and ends at the interval boundary', () => {
    expect(averageRate(series, BASE, BASE + 500)).toBe(10)
    expect(averageRate(series, BASE + 500, BASE + 1500)).toBe(15)
    expect(averageRate(series, BASE + 1000, BASE + 2000)).toBe(20)
  })
})

describe('motion curves', () => {
  it('eases with the shared curves and clamps tween progress', () => {
    expect(EASE_OUT_CSS).toBe('cubic-bezier(.16, 1, .3, 1)')
    expect(easeOut(0)).toBe(0)
    expect(easeOut(0.5)).toBeCloseTo(1 - 2 ** -5)
    expect(easeOut(1)).toBe(1)
    expect(easeOut(2)).toBe(1)
    expect(easeInOut(0)).toBe(0)
    expect(easeInOut(0.25)).toBeCloseTo(4 * 0.25 ** 3)
    expect(easeInOut(0.75)).toBeCloseTo(1 - (-2 * 0.75 + 2) ** 3 / 2)
    expect(easeInOut(1)).toBe(1)
    expect(tweenProgress({ start: 0, duration: 100 }, -50, false)).toBe(0)
    expect(tweenProgress({ start: 0, duration: 100 }, 50, false)).toBeCloseTo(easeOut(0.5))
    expect(tweenProgress({ start: 0, duration: 100 }, 150, false)).toBe(1)
    expect(tweenProgress({ start: 0, duration: 0 }, 150, false)).toBe(1)
    expect(tweenProgress({ start: 0, duration: 100 }, 50, true)).toBe(1)
    expect(tweenProgress({ start: 0, duration: 100 }, 50, false, t => t)).toBeCloseTo(0.5)
  })

  it('reports reduced motion only when the platform query matches', () => {
    expect(reducedMotion()).toBe(false)
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: true, media: query }))
    expect(reducedMotion()).toBe(true)
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query }))
    expect(reducedMotion()).toBe(false)
  })

  it('settles a critically damped spring and snaps to its target when motion is reduced', () => {
    const moving = spring(0, 10, 0.01)
    expect(moving).toEqual({ x: 0, v: 0, to: 0, w: 10, eps: 0.01 })
    moving.to = 100
    expect(stepSpring(moving, 0.016, false)).toBe(true)
    expect(moving.x).toBeGreaterThan(0)
    let steps = 0
    while (stepSpring(moving, 0.016, false) && steps < 2000) steps += 1
    expect(moving.x).toBe(100)
    expect(moving.v).toBe(0)
    const resting: typeof moving = { x: 4.999, v: 40, to: 5, w: 9, eps: 0.002 }
    expect(stepSpring(resting, 0.016, false)).toBe(true)
    const reduced = spring(1)
    reduced.to = 5
    expect(stepSpring(reduced, 0.016, true)).toBe(false)
    expect(reduced).toEqual({ x: 5, v: 0, to: 5, w: 9, eps: 0.002 })
  })

  it('drives animation frames only while the update reports motion', () => {
    const frames = installFrames()
    vi.spyOn(performance, 'now').mockReturnValue(1000)
    const update = vi.fn<(dt: number, now: number) => boolean>()
    update.mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValueOnce(false)
    const clock = frameClock(update)
    clock.wake()
    clock.wake()
    expect(frames.pending()).toBe(1)
    frames.run(2000)
    expect(update).toHaveBeenLastCalledWith(0.05, 2000)
    expect(frames.pending()).toBe(1)
    frames.run(1900)
    expect(update).toHaveBeenLastCalledWith(0, 1900)
    expect(frames.pending()).toBe(1)
    frames.run(1910)
    expect(update).toHaveBeenLastCalledWith(0.01, 1910)
    expect(frames.pending()).toBe(0)
    clock.wake()
    expect(frames.pending()).toBe(1)
    clock.stop()
    expect(frames.pending()).toBe(0)
    expect(frames.cancelled).toHaveLength(1)
    clock.stop()
    expect(frames.cancelled).toHaveLength(1)
    clock.wake()
    clock.stop()
    expect(frames.cancelled).toHaveLength(2)
  })
})

describe('chrome', () => {
  it('resolves a scrambled title from left to right and cancels pending frames on unmount', () => {
    vi.useFakeTimers()
    const frames = installFrames()
    let now = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const view = render(<Scramble text="AB CD" duration={400} />)
    expect(view.getByTestId('scramble').textContent).toBe('AB CD')
    expect(frames.pending()).toBe(1)
    act(() => { frames.run(1200) })
    const partial = view.getByTestId('scramble').textContent
    expect(partial).toMatch(/^AB C./u)
    expect(partial[2]).toBe(' ')
    expect(partial).not.toBe('AB CD')
    expect(frames.pending()).toBe(1)
    act(() => { frames.run(1400) })
    expect(view.getByTestId('scramble').textContent).toBe('AB CD')
    expect(frames.pending()).toBe(0)
    now = 1400
    view.rerender(<Scramble text="EF" duration={400} />)
    expect(frames.pending()).toBe(1)
    view.rerender(<Scramble text="GH" duration={400} />)
    expect(frames.cancelled).toHaveLength(2)
    expect(frames.pending()).toBe(1)
    act(() => { frames.run(2000) })
    expect(view.getByTestId('scramble').textContent).toBe('GH')
    expect(frames.pending()).toBe(0)
    view.unmount()
    expect(frames.cancelled).toHaveLength(3)
  })

  it('shows the final title immediately when the user prefers reduced motion', () => {
    const frames = installFrames()
    const matchMedia = vi.fn((query: string) => ({ matches: true, media: query }))
    vi.stubGlobal('matchMedia', matchMedia)
    const view = render(<Scramble text="TITLE" />)
    expect(view.getByTestId('scramble').textContent).toBe('TITLE')
    expect(frames.pending()).toBe(0)
    expect(matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)')
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    render(<Scramble text="MOTION" />)
    expect(frames.pending()).toBe(1)
  })

  it('rolls changed digits and swaps other glyphs in place', () => {
    vi.useFakeTimers()
    const view = render(<Roll value="12" />)
    expect(view.getByLabelText('12').textContent).toBe('12')
    view.rerender(<Roll value="13" />)
    const changed = view.getByLabelText('13')
    expect(changed.textContent).toBe('123')
    expect(changed.children).toHaveLength(2)
    expect(changed.children[0]!.textContent).toBe('1')
    expect(changed.children[1]!.textContent).toBe('23')
    view.rerender(<Roll value="13" />)
    expect(view.getByLabelText('13').textContent).toBe('123')
    view.rerender(<Roll value="1x" />)
    expect(view.getByLabelText('1x').textContent).toBe('1x')
    view.rerender(<Roll value="7x" />)
    expect(view.getByLabelText('7x').textContent).toBe('17x')
    view.rerender(<Roll value="9" />)
    expect(view.getByLabelText('9').textContent).toBe('x9')
  })

  it('slides a measured plate to the selected option and moves selection by arrow keys', () => {
    vi.useFakeTimers()
    vi.stubGlobal('ResizeObserver', StubResizeObserver)
    const onChange = vi.fn<(value: string) => void>()
    const view = render(<PlateSelect label="Views" options={VIEW_OPTIONS} value="ghost" onChange={onChange} />)
    expect(screen.getAllByRole('radio')).toHaveLength(3)
    expect(StubResizeObserver.instances).toHaveLength(0)
    expect(view.container.querySelectorAll('button')).toHaveLength(3)
    view.rerender(<PlateSelect label="Views" options={VIEW_OPTIONS} value="map" onChange={onChange} />)
    expect(StubResizeObserver.instances).toHaveLength(1)
    const observer = StubResizeObserver.instances[0]!
    const map = screen.getByRole('radio', { name: /Map/u })
    expect(observer.observed).toEqual([map])
    expect(view.container.querySelectorAll('button')).toHaveLength(6)
    expect(screen.getAllByRole('radio')).toHaveLength(3)
    Object.defineProperties(map, {
      offsetLeft: { configurable: true, value: 14 },
      offsetWidth: { configurable: true, value: 52 },
    })
    act(() => { observer.callback([], observer) })
    expect(view.container.querySelector('[style*="translateX(14px)"]')).toBeTruthy()
    expect(view.container.querySelector('[style*="translateX(-14px)"]')).toBeTruthy()
    expect(view.container.querySelector('[style*="width: 52px"]')).toBeTruthy()
    fireEvent.keyDown(map, { key: 'ArrowRight' })
    expect(onChange).toHaveBeenLastCalledWith('tracks')
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: /Tracks/u }))
    fireEvent.keyDown(map, { key: 'ArrowLeft' })
    expect(onChange).toHaveBeenLastCalledWith('log')
    expect(onChange).toHaveBeenCalledTimes(2)
    expect(fireEvent.keyDown(map, { key: 'Enter' })).toBe(true)
    expect(onChange).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('radio', { name: /Log/u }))
    expect(onChange).toHaveBeenLastCalledWith('log')
    expect(onChange).toHaveBeenCalledTimes(3)
    view.rerender(<PlateSelect label="Views" options={VIEW_OPTIONS.slice(0, 2)} value="tracks" onChange={onChange} variant="toggle" />)
    expect(StubResizeObserver.instances).toHaveLength(2)
    expect(observer.disconnect).toHaveBeenCalled()
    expect(view.container.querySelector('[data-variant="toggle"]')).toBeTruthy()
    view.unmount()
    expect(StubResizeObserver.instances[1]!.disconnect).toHaveBeenCalled()
  })

  it('renders registration crosses, typed chips, a bracketed heading, and texture layers', () => {
    const view = render(<>
      <Chip>Default</Chip>
      <Chip kind="inverse" title="Inverse tip">Inverse</Chip>
      <Chip kind="accent">Accent</Chip>
      <RegCross corner="tl" /><RegCross corner="tr" /><RegCross corner="bl" /><RegCross corner="br" />
      <Bracket label="Resources" value="03" />
      <Ghost text="07" />
      <Halftone />
      <Halftone height={120} />
      <Grain />
    </>)
    const chips = [...view.container.querySelectorAll('[data-kind]')]
    expect(chips.map(chip => chip.getAttribute('data-kind'))).toEqual(['plain', 'inverse', 'accent'])
    expect(chips[1]!.getAttribute('title')).toBe('Inverse tip')
    expect(chips[2]!.querySelector('i')).not.toBeNull()
    expect([...view.container.querySelectorAll('[data-corner]')].map(cross => cross.getAttribute('data-corner')))
      .toEqual(['tl', 'tr', 'bl', 'br'])
    expect(screen.getByText('Resources')).toBeTruthy()
    expect(screen.getByLabelText('03')).toBeTruthy()
    const ghost = screen.getByText('07')
    expect(ghost.getAttribute('aria-hidden')).toBe('true')
    expect(view.container.querySelector('[style*="height: 220px"]')).toBeTruthy()
    expect(view.container.querySelector('[style*="height: 120px"]')).toBeTruthy()
    expect(view.container.querySelectorAll('span[aria-hidden="true"]').length).toBeGreaterThanOrEqual(4)
  })
})
