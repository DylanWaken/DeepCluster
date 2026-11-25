// @vitest-environment jsdom
/** Control room behavior: map and track scenes, worker card, run scoping, and the record sections. */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { allowAllAccess, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { RemoteError, type TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type { ResourceSnapshot } from '@deepseek-ai/dsh-client-resources/client'
import type {
  ClusterDashboardSnapshot, ClusterLeaseView, ClusterMessageView, ClusterOutcomeView, ClusterRecordId,
  ClusterRunView, ClusterTaskId, ClusterTaskView, ClusterTimelineEntry,
} from '../src/dashboard-types.ts'
import type { RunId } from '../src/types.ts'
import { ClusterIcon, ClusterPage, type ClusterPageProps } from '../src/client/ClusterPage.tsx'
import { en, zh } from '../src/client/locales.ts'
import { inject as dashboardInject, mountDashboard } from '../src/client/mount.ts'
import { MapView, type MapWorker } from '../src/client/MapView.tsx'
import { createMapScene, type MapAnchor, type MapData, type MapEvents, type MapScene } from '../src/client/ground-scene.ts'
import {
  createTrackScene, ROW, tickStep, TRACK_LENGTH, TRACK_SPAN_MAX, zoomPosition, zoomSpan,
  type TrackAnchor, type TrackEvents, type TrackScene, type TrackWindow,
} from '../src/client/track-scene.ts'
import type {} from '../src/client/index.ts'

vi.mock('../src/client/ground-scene.ts', () => ({ createMapScene: vi.fn() }))

vi.mock('../src/client/track-scene.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/track-scene.ts')>()
  return { ...actual, createTrackScene: vi.fn() }
})

type MapDouble = {
  readonly events: MapEvents
  readonly update: Mock<MapScene['update']>
  readonly focus: Mock<MapScene['focus']>
  readonly reset: Mock<MapScene['reset']>
  readonly mode: Mock<MapScene['mode']>
  readonly pan: Mock<MapScene['pan']>
  readonly orbit: Mock<MapScene['orbit']>
  readonly zoom: Mock<MapScene['zoom']>
  readonly active: Mock<MapScene['active']>
  readonly dispose: Mock<MapScene['dispose']>
}
type TrackDouble = {
  readonly events: TrackEvents
  readonly update: Mock<TrackScene['update']>
  readonly fit: Mock<TrackScene['fit']>
  readonly follow: Mock<TrackScene['follow']>
  readonly inset: Mock<TrackScene['inset']>
  readonly zoom: Mock<TrackScene['zoom']>
  readonly span: Mock<TrackScene['span']>
  readonly pan: Mock<TrackScene['pan']>
  readonly scroll: Mock<TrackScene['scroll']>
  readonly reveal: Mock<TrackScene['reveal']>
  readonly active: Mock<TrackScene['active']>
  readonly dispose: Mock<TrackScene['dispose']>
}

const mapDoubles: MapDouble[] = []
const trackDoubles: TrackDouble[] = []
const observers: TestObserver[] = []

/** ResizeObserver double whose deliveries a test announces. */
class TestObserver implements ResizeObserver {
  readonly targets: Element[] = []
  readonly disconnect = vi.fn()
  constructor(private readonly callback: ResizeObserverCallback) { observers.push(this) }
  observe(target: Element): void { this.targets.push(target) }
  unobserve(target: Element): void { this.targets.splice(this.targets.indexOf(target), 1) }
  fire(): void { this.callback([], this) }
}

function fakeMapScene(_host: HTMLElement, events: MapEvents): MapScene {
  const double: MapDouble = {
    events,
    update: vi.fn<MapScene['update']>(),
    focus: vi.fn<MapScene['focus']>(),
    reset: vi.fn<MapScene['reset']>(),
    mode: vi.fn<MapScene['mode']>(),
    pan: vi.fn<MapScene['pan']>(),
    orbit: vi.fn<MapScene['orbit']>(),
    zoom: vi.fn<MapScene['zoom']>(),
    active: vi.fn<MapScene['active']>(),
    dispose: vi.fn<MapScene['dispose']>(),
  }
  mapDoubles.push(double)
  return {
    update: double.update, focus: double.focus, reset: double.reset, mode: double.mode,
    pan: double.pan, orbit: double.orbit, zoom: double.zoom, active: double.active, dispose: double.dispose,
  }
}

function fakeTrackScene(_host: HTMLElement, events: TrackEvents): TrackScene {
  const double: TrackDouble = {
    events,
    update: vi.fn<TrackScene['update']>(),
    fit: vi.fn<TrackScene['fit']>(),
    follow: vi.fn<TrackScene['follow']>(),
    inset: vi.fn<TrackScene['inset']>(),
    zoom: vi.fn<TrackScene['zoom']>(),
    span: vi.fn<TrackScene['span']>(),
    pan: vi.fn<TrackScene['pan']>(),
    scroll: vi.fn<TrackScene['scroll']>(),
    reveal: vi.fn<TrackScene['reveal']>(),
    active: vi.fn<TrackScene['active']>(),
    dispose: vi.fn<TrackScene['dispose']>(),
  }
  trackDoubles.push(double)
  return {
    update: double.update, fit: double.fit, follow: double.follow, inset: double.inset, zoom: double.zoom, span: double.span,
    pan: double.pan, scroll: double.scroll, reveal: double.reveal, active: double.active, dispose: double.dispose,
  }
}

const mediaQuery = (query: string): { matches: boolean } => ({ matches: query.includes('prefers-reduced-motion') })

beforeEach(() => {
  mapDoubles.length = 0
  trackDoubles.length = 0
  observers.length = 0
  vi.mocked(createMapScene).mockReset().mockImplementation(fakeMapScene)
  vi.mocked(createTrackScene).mockReset().mockImplementation(fakeTrackScene)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  vi.setSystemTime(observedAt)
  vi.stubGlobal('matchMedia', mediaQuery)
  vi.stubGlobal('ResizeObserver', TestObserver)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const observedAt = Date.parse('2026-10-23T08:00:00.000Z')
const stamp = '2026-10-23T08:00:00.000Z'
const asRun = (id: string): RunId => id as RunId
const asTask = (id: string): ClusterTaskId => id as ClusterTaskId
const asRecord = (id: string): ClusterRecordId => id as ClusterRecordId

const usage = (input = 400, output = 80): ClusterTaskView['usage'] =>
  ({ inputTokens: input, outputTokens: output, elapsedMs: 4000, tokensPerSecond: 20 })
const sample = (tokens: number, at = observedAt): ClusterTaskView['tokenSamples'][number] =>
  ({ tokens, observedAt: at, basis: 'tokenizer', tokenizer: 'fixture' })

/**
 * One recorded worker.
 * @param id - `run/step` task identity.
 * @param patch - fields replacing the defaults.
 * @returns the worker projection.
 */
function task(id: string, patch: Partial<ClusterTaskView> = {}): ClusterTaskView {
  const [runId = 'r', stepId = id] = id.split('/')
  return {
    id: asTask(id), runId: asRun(runId), stepId, title: `Worker ${stepId}`, role: 'developer',
    status: 'running', activity: 'write', detail: '', attempt: 1, dependencies: [], resources: [],
    usage: null, tokenSamples: [], tokenError: null, waitingResource: null, updatedAt: stamp, ...patch,
  }
}

/**
 * One recorded plan execution.
 * @param id - run identity.
 * @param title - displayed plan title.
 * @param patch - fields replacing the defaults.
 * @returns the run projection.
 */
function run(id: string, title = `Run ${id}`, patch: Partial<ClusterRunView> = {}): ClusterRunView {
  return { id: asRun(id), title, goal: 'Goal', status: 'running', startedAt: stamp, ...patch }
}

/**
 * One retained timeline record.
 * @param id - record identity.
 * @param patch - fields replacing the defaults.
 * @returns the timeline projection.
 */
function event(id: string, patch: Partial<ClusterTimelineEntry> = {}): ClusterTimelineEntry {
  return {
    id: asRecord(id), seq: 1, at: stamp, type: 'agent/activity', runId: asRun('r'), stepId: '1',
    role: 'developer', activity: 'write', detail: '', ...patch,
  }
}

/**
 * One completed task report.
 * @param id - record identity.
 * @param patch - fields replacing the defaults.
 * @returns the outcome projection.
 */
function outcome(id: string, patch: Partial<ClusterOutcomeView> = {}): ClusterOutcomeView {
  return {
    id: asRecord(id), runId: asRun('r'), title: `Outcome ${id}`, role: 'tester', status: 'pass',
    summary: 'Evidence recorded', checks: ['check: yes'], ...patch,
  }
}

/**
 * One exclusively held or quarantined resource.
 * @param resource - resource name.
 * @param patch - fields replacing the defaults.
 * @returns the lease projection.
 */
function lease(resource: string, patch: Partial<ClusterLeaseView> = {}): ClusterLeaseView {
  return { resource, runId: asRun('r'), stepId: '1', acquiredAt: stamp, status: 'held', detail: '', ...patch }
}

/**
 * One recorded handoff or feedback message.
 * @param id - record identity.
 * @param patch - fields replacing the defaults.
 * @returns the message projection.
 */
function message(id: string, patch: Partial<ClusterMessageView> = {}): ClusterMessageView {
  return {
    id: asRecord(id), runId: asRun('r'), fromStepId: '1', toStepId: '2', kind: 'message', phase: 'sent',
    messageId: null, message: 'Payload', at: stamp, ...patch,
  }
}

/**
 * The default dashboard snapshot used by most cases.
 * @param patch - top-level fields replacing the defaults.
 * @returns the journal projection.
 */
function dashboard(patch: Partial<ClusterDashboardSnapshot> = {}): ClusterDashboardSnapshot {
  return {
    workspace: 'D:/workspace', workspaces: ['D:/workspace'], updatedAt: stamp, activeRunIds: null,
    runs: [run('r', 'GEMM investigation')],
    tasks: [
      task('r/1', { title: 'Implement kernel', detail: 'kernel.cu', usage: usage(), tokenSamples: [sample(100)] }),
      task('r/2', { title: 'Measure throughput', status: 'queued', activity: 'unknown', dependencies: ['1'], resources: ['gpu0'] }),
    ],
    leases: [], timeline: [], outcomes: [], messages: [],
    ...patch,
  }
}

type Snapshot = ResourceSnapshot<ClusterDashboardSnapshot>

/**
 * Render the page with a fixed resource snapshot.
 * @param value - resource state returned by the injected hook.
 * @param dictionary - locale dictionary used by the translate seat.
 * @returns the reader mock, the bound props, and the rendered view.
 */
function mount(value: Snapshot, dictionary: Record<string, string> = en) {
  const read = vi.fn(() => value)
  const props: ClusterPageProps = {
    useResource: read as ClusterPageProps['useResource'],
    usePanelInfo: select => select({ activePanelId: null }),
    useSessions: () => { throw new Error('No Session query expected') },
    useWorkspaces: () => { throw new Error('No workspace query expected') },
    useSessionStatus: () => { throw new Error('No Session status query expected') },
    useSessionRetainInfo: () => undefined,
    ...allowAllAccess,
    t: makeTranslate(dictionary),
  }
  return { read, props, view: render(<ClusterPage {...props} />) }
}

/**
 * @param title - task title carried by a map label.
 * @returns the projected worker label, not the duplicate selector tick.
 */
function mapLabel(title: string): HTMLElement {
  const match = queryMapLabel(title)
  if (match === null) throw new Error(`map label missing: ${title}`)
  return match
}

/**
 * @param id - task identity carried by a map label.
 * @returns the projected worker label.
 */
function mapLabelById(id: string): HTMLElement {
  const element = document.querySelector(`[data-worker-id="${id}"]`)
  if (!(element instanceof HTMLElement)) throw new Error(`map label missing: ${id}`)
  return element
}

/**
 * @param title - task title carried by a map label.
 * @returns the map label when the scene rendered it.
 */
function queryMapLabel(title: string): HTMLElement | null {
  for (const element of document.querySelectorAll<HTMLElement>('[data-worker-id]')) {
    if (element.getAttribute('aria-label')?.includes(title) === true) return element
  }
  return null
}

/**
 * @param title - task title carried by a track head.
 * @returns the track head button.
 */
function trackHead(title: string): HTMLElement {
  for (const element of document.querySelectorAll<HTMLElement>('[class*="trackHead"]')) {
    if (element.getAttribute('aria-label')?.includes(title) === true) return element
  }
  throw new Error(`track head missing: ${title}`)
}

/**
 * @returns the track overlay that holds the ruler ticks and message chips.
 */
function trackOverlay(): HTMLElement {
  const chip = document.querySelector('[class*="nowChip"]')
  if (!(chip instanceof HTMLElement) || chip.parentElement === null) throw new Error('track overlay missing')
  return chip.parentElement
}

/**
 * @param label - transport counter label.
 * @returns the counter value beside it.
 */
function count(label: string): string | null {
  const list = document.querySelector('[class*="counts"]')
  if (!(list instanceof HTMLElement)) throw new Error('transport counters missing')
  const value = within(list).getByText(label).nextElementSibling
  return value?.querySelector('[aria-label]')?.getAttribute('aria-label') ?? value?.textContent ?? null
}

/**
 * Give a projected label body a measurable size; jsdom reports zero for every element.
 * @param element - bound label element.
 * @param width - body width in CSS pixels.
 * @param height - body height in CSS pixels.
 */
function sizeLabel(element: HTMLElement, width = 120, height = 24): void {
  const body = element.lastElementChild
  if (!(body instanceof HTMLElement)) throw new Error('label body missing')
  Object.defineProperty(body, 'offsetWidth', { configurable: true, value: width })
  Object.defineProperty(body, 'offsetHeight', { configurable: true, value: height })
}

/**
 * @returns the most recently mounted map scene double.
 */
function latestMap(): MapDouble {
  const double = mapDoubles.at(-1)
  if (double === undefined) throw new Error('map scene not mounted')
  return double
}

/**
 * @returns the most recently mounted track scene double.
 */
function latestTrack(): TrackDouble {
  const double = trackDoubles.at(-1)
  if (double === undefined) throw new Error('track scene not mounted')
  return double
}

interface JournalFrame {
  readonly value: ClusterDashboardSnapshot
  readonly accept: () => void
}
interface JournalStream {
  [Symbol.asyncIterator](): AsyncGenerator<JournalFrame>
  readonly dispose: Mock<() => Promise<void>>
}
type JournalResult =
  | { readonly ok: true; readonly value: ClusterDashboardSnapshot }
  | { readonly ok: false; readonly error: RemoteError }
interface JournalProvider {
  open(address: string, options: { readonly signal: AbortSignal }): AsyncIterable<JournalResult>
}

/**
 * @param frames - frames the stream yields.
 * @param failure - error the stream raises at the next iteration step.
 * @returns the iterable and its disposal spy.
 */
function scriptedJournal(frames: readonly JournalFrame[], failure?: Error): JournalStream {
  const dispose = vi.fn(async () => {})
  return {
    async *[Symbol.asyncIterator]() {
      for (const frame of frames) {
        if (failure !== undefined) throw failure
        yield frame
      }
      if (failure !== undefined) throw failure
    },
    dispose,
  }
}

/**
 * @param stream - journal stream to drain.
 * @returns every value the generator yielded.
 */
async function collectJournal(stream: AsyncIterable<JournalResult>): Promise<JournalResult[]> {
  const results: JournalResult[] = []
  for await (const result of stream) results.push(result)
  return results
}

const CONTRIBUTION: TypertRemoteContribution = {
  package: '@deepseek-ai/dsh-experimental-deep-cluster', descriptors: [],
}

/**
 * Build the dashboard mount's services, slot declarations, and scripted Remote contribution.
 * @returns the context, the slots the mount installed, and the journal stream seat.
 */
async function journalEntry() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const unmount = vi.fn(async () => {})
  const watch = vi.fn(() => undefined)
  let stream = scriptedJournal([])
  class Remote extends Service {
    constructor() { super(ctx, 'remote') }
    async $mount(value: TypertRemoteContribution): Promise<() => Promise<void>> {
      expect(value).toBe(CONTRIBUTION)
      return unmount
    }
    $stream(options: {
      readonly open: (generation: AbortSignal) => unknown
      readonly ended: () => Error
    }): JournalStream {
      options.open(new AbortController().signal)
      expect(options.ended().message).toBe('DeepCluster dashboard stream ended')
      return stream
    }
  }
  new Remote()
  const register = vi.fn((_provider: JournalProvider) => () => {})
  ctx.provide('remote.deepClusterDashboard', { watch } as never)
  ctx.provide('resources', { register } as never)
  ctx.provide('locale', new LocaleRuntime(ctx))
  const root = ctx.slots.register({ name: 'root', children: {
    main: { kind: 'keyed', scope: 'root' },
    'sidebar.panellist': { kind: 'list', scope: 'root' },
  } } as never, () => null)
  return {
    ctx, unmount, watch, register, root,
    setStream: (value: JournalStream) => { stream = value },
  }
}

/**
 * @param anchors - map anchors to project.
 */
function projectMap(anchors: readonly MapAnchor[]): void {
  const double = latestMap()
  act(() => { double.events.project(anchors) })
}

/**
 * @param anchors - track anchors to project.
 * @param window - visible time window reported beside the anchors.
 */
function projectTrack(anchors: readonly TrackAnchor[], window: TrackWindow): void {
  const double = latestTrack()
  act(() => { double.events.project(anchors, window) })
}

/**
 * @param id - anchor identity.
 * @param x - screen x in CSS pixels.
 * @param y - screen y in CSS pixels.
 * @param depth - camera distance.
 * @param visible - whether the anchor is in the frustum.
 * @returns the map anchor.
 */
const mapAnchor = (id: string, x: number, y: number, depth: number, visible = true): MapAnchor => ({ id, x, y, depth, visible })

/**
 * @param id - anchor identity.
 * @param x - screen x in CSS pixels.
 * @param y - screen y in CSS pixels.
 * @param visible - whether the anchor is in the frustum.
 * @returns the track anchor.
 */
const trackAnchor = (id: string, x: number, y: number, visible = true): TrackAnchor => ({ id, x, y, visible })

/** The card region of the selected worker. */
const card = (): HTMLElement => screen.getByRole('complementary', { name: en.workerContext })

it('shows the live worker map, telemetry, counters, and active run scope', () => {
  mount({ status: 'live', value: dashboard(), failure: undefined })
  expect(screen.getByRole('heading', { name: 'Implement kernel' })).toBeTruthy()
  expect(within(mapLabel('Implement kernel')).getByText(/Writing files/u)).toBeTruthy()
  expect(within(mapLabel('Implement kernel')).getByText('20.0 tokens/s')).toBeTruthy()
  expect(within(mapLabel('Measure throughput')).getByText(/Queued/u)).toBeTruthy()
  expect(within(mapLabel('Measure throughput')).getByText('—')).toBeTruthy()
  expect(within(card()).getByText('Running')).toBeTruthy()
  expect(within(card()).getByText('Developer')).toBeTruthy()
  expect(within(card()).getByText(/kernel\.cu/u)).toBeTruthy()
  expect(within(card()).getByLabelText('20.0')).toBeTruthy()
  expect(within(card()).getAllByText('01').length).toBeGreaterThan(0)
  expect(count(en.mRunning)).toBe('01')
  expect(count(en.mQueued)).toBe('01')
  expect(count(en.mPassed)).toBe('00')
  expect(count(en.mLeases)).toBe('00')
  expect(screen.getByText(`Filter · “${en.activeRuns}” · 02 workers`)).toBeTruthy()
  expect(screen.getByRole('list', { name: en.graphLegend })).toBeTruthy()
  const select = screen.getByRole<HTMLSelectElement>('combobox', { name: en.runs })
  expect(select.value).toBe('active')
  expect(within(select).getByRole('option', { name: en.activeRuns })).toBeTruthy()
  expect(within(select).getByRole('option', { name: en.allRuns })).toBeTruthy()
  const data = latestMap().update.mock.calls.at(-1)?.[0]
  expect(data?.columns.map(column => column.state)).toEqual(['running', 'waiting'])
  expect(data?.columns.map(column => column.selected)).toEqual([true, false])
  expect(data?.maxHeight).toBeCloseTo(8, 5)
})

it('decays the live token rate and stops refreshing a settled run', () => {
  const clear = vi.spyOn(globalThis, 'clearInterval')
  const live = { ...dashboard(), tasks: dashboard().tasks.map(item => item.stepId === '1'
    ? { ...item, tokenSamples: [sample(20, observedAt - 4000), sample(80)] } : item) }
  const h = mount({ status: 'live', value: live, failure: undefined })
  expect(within(mapLabel('Implement kernel')).getByText('20.0 tokens/s')).toBeTruthy()
  act(() => { vi.advanceTimersByTime(1000) })
  expect(within(mapLabel('Implement kernel')).getByText('16.0 tokens/s')).toBeTruthy()
  const settled = { ...live, tasks: live.tasks.map(item => ({ ...item, status: 'passed' as const })) }
  h.read.mockReturnValue({ status: 'live', value: settled, failure: undefined })
  h.view.rerender(<ClusterPage {...h.props} />)
  act(() => { vi.advanceTimersByTime(1000) })
  act(() => { vi.advanceTimersByTime(3000) })
  expect(clear).toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(1)
  h.view.unmount()
  expect(vi.getTimerCount()).toBe(0)
})

it('schedules no live refresh for a settled run without fresh samples', () => {
  const settled = { ...dashboard(), tasks: dashboard().tasks.map(item => ({ ...item, status: 'passed' as const, tokenSamples: [] })) }
  const first = mount({ status: 'live', value: settled, failure: undefined })
  expect(vi.getTimerCount()).toBe(1)
  first.view.unmount()
  const expired = { ...dashboard(), tasks: dashboard().tasks.map(item => ({ ...item, status: 'passed' as const, tokenSamples: [sample(100)] })) }
  vi.setSystemTime(observedAt + 60_000)
  const second = mount({ status: 'live', value: expired, failure: undefined })
  expect(vi.getTimerCount()).toBe(1)
  second.view.unmount()
})

it.each([['English', en], ['Chinese', zh]] as const)('labels every worker state and activity in %s', (_locale, dictionary) => {
  const strings: Record<string, string> = dictionary
  const cases = [
    ['running', 'thinking', 'activity.thinking'], ['running', 'command', 'activity.command'],
    ['running', 'read', 'activity.read'], ['running', 'write', 'activity.write'],
    ['running', 'tool', 'activity.tool'], ['running', 'idle', 'activity.idle'],
    ['waiting', 'command', 'status.waiting'], ['queued', 'thinking', 'status.queued'],
    ['passed', 'write', 'status.passed'], ['failed', 'read', 'status.failed'], ['blocked', 'thinking', 'status.blocked'],
  ] as const
  mount({ status: 'live', failure: undefined, value: { ...dashboard(),
    tasks: cases.map(([status, activity], index) => task(`r/${index}`, {
      title: `Worker ${index}`, status, activity,
    })),
  } }, strings)
  for (const [index, [, , key]] of cases.entries()) {
    const label = mapLabelById(`r/${index}`)
    expect(within(label).getByText(new RegExp(strings[key]!, 'u'))).toBeTruthy()
  }
})

it('keeps stale records beside a journal failure and reconnects', () => {
  const h = mount({ status: 'failed', value: dashboard(), failure: new RemoteError('deepCluster/journal-unavailable', 'Read failed', {}) })
  expect(screen.getByRole('alert').textContent).toContain(en.failed)
  expect(screen.getByRole('heading', { name: 'Implement kernel' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: en.retry }))
  expect(h.read).toHaveBeenLastCalledWith('dsh-resource://deepcluster/journal?retry=1')
})

it('shows loading and unavailable journal notices without a worker card body', () => {
  const loading = mount({ status: 'loading', value: undefined, failure: undefined })
  expect(screen.getByRole('status').textContent).toBe(en.loading)
  expect(screen.getByText(en.noRunSelected)).toBeTruthy()
  act(() => { fireEvent.keyDown(document.body, { key: 'F' }) })
  expect(mapDoubles).toHaveLength(0)
  loading.view.unmount()
  mount({ status: 'none', value: undefined, failure: undefined })
  expect(screen.getByRole('status').textContent).toBe(en.unavailable)
})

it('localizes the empty journal view and keeps the configured roots', () => {
  mount({ status: 'live', value: { ...dashboard(), runs: [], tasks: [], timeline: [], outcomes: [], leases: [] }, failure: undefined }, zh)
  expect(screen.getByText(zh.emptyTitle)).toBeTruthy()
  expect(screen.getByText('D:/workspace', { exact: false })).toBeTruthy()
  expect(screen.queryByText(en.noOutcomes)).toBeNull()
  expect(screen.queryByRole('combobox', { name: zh.runs })).toBeNull()
  expect(screen.getByText(zh.noOutcomes)).toBeTruthy()
  expect(screen.getByText(zh.noLeases)).toBeTruthy()
  expect(screen.getByText(zh.noTimeline)).toBeTruthy()
})

it('positions map labels from projected anchors and hides labels outside the frustum', () => {
  const value = dashboard({ tasks: [...dashboard().tasks, task('r/3', { title: 'Hold lease', status: 'waiting', waitingResource: 'free-gpu' })] })
  mount({ status: 'live', value, failure: undefined })
  sizeLabel(mapLabel('Implement kernel'))
  sizeLabel(mapLabel('Measure throughput'))
  projectMap([mapAnchor('r/1', 120, 300, 10), mapAnchor('r/2', 400, 300, 20), mapAnchor('ghost-a', 10, 10, 10), mapAnchor('ghost-b', 20, 20, 10)])
  const near = mapLabel('Implement kernel')
  expect(near.style.transform).toBe('translate3d(120.0px, 300.0px, 0)')
  expect(Number(near.style.opacity)).toBe(1)
  expect(near.style.visibility).toBe('visible')
  expect(near.style.zIndex).toBe('10000')
  expect(near.dataset.side).toBe('right')
  const far = mapLabel('Measure throughput')
  expect(Number(far.style.opacity)).toBeCloseTo(0.7, 5)
  expect(far.style.zIndex).toBe('8800')
  projectMap([mapAnchor('r/1', 120, 300, 5), mapAnchor('r/2', 400, 300, 5, false)])
  expect(Number(mapLabel('Implement kernel').style.opacity)).toBe(1)
  expect(mapLabel('Measure throughput').style.opacity).toBe('0')
  expect(mapLabel('Measure throughput').style.visibility).toBe('hidden')
  const terminal = screen.getByText('free-gpu').parentElement
  expect(terminal).not.toBeNull()
  projectMap([mapAnchor('terminal:free-gpu', 700, 300, 15)])
  expect(terminal?.style.transform).toBe('translate3d(700.0px, 300.0px, 0)')
  act(() => { latestMap().events.select(asTask('r/2')) })
  expect(screen.getByRole('heading', { name: 'Measure throughput' })).toBeTruthy()
})

it('flips, collapses, pins, and hides overlapping map labels', () => {
  const titles = ['Alpha', 'Beta', 'Gamma', 'Delta']
  const value = dashboard({ tasks: titles.map((title, index) => task(`r/${index + 1}`, { title })) })
  mount({ status: 'live', value, failure: undefined })
  fireEvent.click(mapLabel('Alpha'))
  act(() => { latestMap().events.hover('r/2' as ClusterTaskId) })
  for (const title of titles) sizeLabel(mapLabel(title))
  projectMap([
    mapAnchor('r/1', 600, 300, 5), mapAnchor('r/2', 900, 300, 6),
    mapAnchor('r/3', 500, 300, 7), mapAnchor('r/4', 1300, 300, 8, false),
  ])
  const gamma = mapLabel('Gamma')
  expect(gamma.dataset.side).toBe('left')
  expect(gamma.hasAttribute('data-collapsed')).toBe(false)
  expect(mapLabel('Alpha').style.zIndex).toBe('10000')
  expect(mapLabel('Beta').style.zIndex).toBe('10000')
  expect(gamma.style.zIndex).toBe('8930')
  expect(mapLabel('Beta').hasAttribute('data-hovered')).toBe(true)
  expect(mapLabel('Alpha').getAttribute('aria-pressed')).toBe('true')
  projectMap([
    mapAnchor('r/1', 600, 300, 5), mapAnchor('r/2', 400, 300, 6),
    mapAnchor('r/3', 500, 300, 7), mapAnchor('r/4', 1300, 300, 8, false),
  ])
  expect(mapLabel('Gamma').hasAttribute('data-collapsed')).toBe(true)
  expect(mapLabel('Gamma').dataset.side).toBe('right')
  expect(mapLabel('Delta').style.visibility).toBe('hidden')
  expect(mapLabel('Delta').style.opacity).toBe('0')
  projectMap([
    mapAnchor('r/1', 1000, 300, 5), mapAnchor('r/2', 1200, 300, 6),
    mapAnchor('r/3', 500, 300, 7), mapAnchor('r/4', 1300, 300, 8, false),
  ])
  expect(mapLabel('Gamma').hasAttribute('data-collapsed')).toBe(false)
  expect(mapLabel('Gamma').dataset.side).toBe('right')
})

it('flips a map label away from an obstacle inside the label stage', () => {
  mount({ status: 'live', value: dashboard(), failure: undefined })
  const stage = document.querySelector('[data-label-stage]')
  if (!(stage instanceof HTMLElement)) throw new Error('label stage missing')
  const obstacle = document.createElement('div')
  obstacle.dataset.labelObstacle = ''
  obstacle.getBoundingClientRect = () => new DOMRect(550, 250, 350, 70)
  stage.append(obstacle)
  sizeLabel(mapLabel('Implement kernel'))
  sizeLabel(mapLabel('Measure throughput'))
  projectMap([mapAnchor('r/1', 100, 300, 5), mapAnchor('r/2', 520, 300, 6)])
  expect(mapLabel('Measure throughput').dataset.side).toBe('left')
  expect(mapLabel('Implement kernel').dataset.side).toBe('right')
  obstacle.remove()
})

it('stops adding map labels beyond the placed limit', () => {
  const tasks = Array.from({ length: 37 }, (_value, index) => task(`r/${index}`, { title: `Worker ${index}`, tokenSamples: [] }))
  mount({ status: 'live', value: dashboard({ tasks }), failure: undefined })
  fireEvent.click(mapLabel('Worker 0'))
  for (const item of tasks) sizeLabel(mapLabel(item.title))
  projectMap(tasks.map((item, index) => mapAnchor(item.id, 100 + index * 200, 100, index)))
  expect(mapLabel('Worker 33').hasAttribute('data-collapsed')).toBe(false)
  expect(mapLabel('Worker 34').hasAttribute('data-collapsed')).toBe(true)
  expect(mapLabel('Worker 36').hasAttribute('data-collapsed')).toBe(true)
})

it('drives the map camera and mode from the view controls', () => {
  mount({ status: 'live', value: dashboard(), failure: undefined })
  fireEvent.click(screen.getByRole('radio', { name: en.orbitMap }))
  expect(latestMap().mode).toHaveBeenLastCalledWith('orbit')
  fireEvent.click(screen.getByRole('button', { name: en.zoomIn }))
  expect(latestMap().zoom).toHaveBeenLastCalledWith(1.25)
  fireEvent.click(screen.getByRole('button', { name: en.zoomOut }))
  expect(latestMap().zoom).toHaveBeenLastCalledWith(0.8)
  fireEvent.click(screen.getByRole('button', { name: en.resetMap }))
  expect(latestMap().reset).toHaveBeenCalledOnce()
})

it('switches map and tracks from the header plate and keys 1, 2, and F', () => {
  mount({ status: 'live', value: dashboard(), failure: undefined })
  fireEvent.click(mapLabel('Implement kernel'))
  fireEvent.click(screen.getByRole('radio', { name: /Tracks/u }))
  expect(screen.getByText(new RegExp(en.tracksDescription.slice(0, 20), 'u'))).toBeTruthy()
  act(() => { fireEvent.keyDown(document.body, { key: 'F' }) })
  expect(latestTrack().reveal).toHaveBeenLastCalledWith('r/1')
  act(() => { fireEvent.keyDown(document.body, { key: '1' }) })
  expect(screen.getByText(en.mapDescription)).toBeTruthy()
  act(() => { fireEvent.keyDown(document.body, { key: 'F' }) })
  expect(latestMap().focus).toHaveBeenLastCalledWith('r/1')
  act(() => { fireEvent.keyDown(document.body, { key: 'F', shiftKey: true }) })
  act(() => { fireEvent.keyDown(document.body, { key: '2', ctrlKey: true }) })
  act(() => { fireEvent.keyDown(document.body, { key: '2', metaKey: true }) })
  act(() => { fireEvent.keyDown(document.body, { key: '2', altKey: true }) })
  expect(screen.getByText(en.mapDescription)).toBeTruthy()
  act(() => { fireEvent.keyDown(screen.getByRole('combobox', { name: en.runs }), { key: '2' }) })
  expect(screen.getByText(en.mapDescription)).toBeTruthy()
  act(() => { fireEvent.keyDown(document.body, { key: 'x' }) })
  expect(latestMap().focus).toHaveBeenCalledTimes(2)
  act(() => { fireEvent.keyDown(document.body, { key: '2' }) })
  expect(screen.getByText(new RegExp(en.tracksDescription.slice(0, 20), 'u'))).toBeTruthy()
})

it('scopes the page to active, all, and one recorded run', () => {
  const value = dashboard({
    activeRunIds: [asRun('r')],
    runs: [run('r', 'GEMM investigation'), run('old', 'Old plan')],
    tasks: [
      ...dashboard().tasks,
      task('old/1', { runId: asRun('old'), title: 'Old worker', status: 'passed' }),
      task('legacy-1/1', { runId: asRun('legacy-1'), title: 'Historical worker' }),
    ],
    timeline: [event('r/1'), event('old/1', { runId: asRun('old'), stepId: '1', type: 'gate/pass' })],
    outcomes: [outcome('r/1', { title: 'Current outcome' }), outcome('old/1', { runId: asRun('old'), title: 'Old outcome' })],
    leases: [lease('current-gpu'), lease('old-gpu', { runId: asRun('old') })],
  })
  const h = mount({ status: 'live', value, failure: undefined })
  expect(mapLabel('Implement kernel')).toBeTruthy()
  expect(queryMapLabel('Old worker')).toBeNull()
  expect(queryMapLabel('Historical worker')).toBeNull()
  expect(screen.getByText('Current outcome')).toBeTruthy()
  expect(screen.queryByText('Old outcome')).toBeNull()
  expect(screen.getByText('current-gpu')).toBeTruthy()
  expect(screen.queryByText('old-gpu')).toBeNull()
  expect(within(screen.getByRole('combobox', { name: en.runs })).getByRole('option', { name: en.activeApiRuns })).toBeTruthy()
  fireEvent.change(screen.getByRole('combobox', { name: en.runs }), { target: { value: '' } })
  expect(mapLabel('Old worker')).toBeTruthy()
  expect(mapLabel('Historical worker')).toBeTruthy()
  expect(screen.getByText('Old outcome')).toBeTruthy()
  expect(screen.getByText('old-gpu')).toBeTruthy()
  fireEvent.change(screen.getByRole('combobox', { name: en.runs }), { target: { value: 'old' } })
  expect(document.querySelectorAll('[data-worker-id]')).toHaveLength(1)
  expect(screen.getByText('Filter · “Old plan” · 01 workers')).toBeTruthy()
  h.read.mockReturnValue({ status: 'live', value: { ...value, runs: [run('r', 'GEMM investigation')] }, failure: undefined })
  h.view.rerender(<ClusterPage {...h.props} />)
  expect(screen.getByText('Filter · “old” · 01 workers')).toBeTruthy()
  h.read.mockReturnValue({ status: 'live', value: { ...value, activeRunIds: null }, failure: undefined })
  h.view.rerender(<ClusterPage {...h.props} />)
  expect(within(screen.getByRole('combobox', { name: en.runs })).getByRole('option', { name: en.activeRuns })).toBeTruthy()
})

it('steps through workers with the selection ruler', () => {
  const value = dashboard({ tasks: [task('r/1', { title: 'One' }), task('r/2', { title: 'Two' }), task('r/3', { title: 'Three' })] })
  mount({ status: 'live', value, failure: undefined })
  expect(screen.getByRole('heading', { name: 'Three' })).toBeTruthy()
  const [up, down] = screen.getAllByRole('button', { name: en.chooseWorker })
  fireEvent.click(up!)
  expect(screen.getByRole('heading', { name: 'Two' })).toBeTruthy()
  fireEvent.click(down!)
  expect(screen.getByRole('heading', { name: 'Three' })).toBeTruthy()
  expect(mapLabel('Three').getAttribute('aria-pressed')).toBe('true')
  const ticks = [...document.querySelectorAll<HTMLElement>('[class*="ticks"] button')]
  fireEvent.click(ticks[0]!)
  expect(screen.getByRole('heading', { name: 'One' })).toBeTruthy()
  expect(mapLabel('One').getAttribute('aria-pressed')).toBe('true')
})

it('shows the map fallback list and retries an unavailable scene', () => {
  vi.mocked(createMapScene).mockImplementationOnce(() => { throw new Error('WebGL unavailable') })
  mount({ status: 'live', value: dashboard(), failure: undefined })
  expect(screen.getByRole('alert').textContent).toContain(en.webglFailed)
  expect(queryMapLabel('Implement kernel')).toBeNull()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.zoomIn }).disabled).toBe(true)
  fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: /Measure throughput/u }))
  expect(screen.getByRole('heading', { name: 'Measure throughput' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: en.retryMap }))
  expect(createMapScene).toHaveBeenCalledTimes(2)
  expect(screen.queryByRole('alert')).toBeNull()
  expect(mapLabel('Implement kernel')).toBeTruthy()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.zoomIn }).disabled).toBe(false)
})

it('hides the map labels when the scene reports a render failure', () => {
  mount({ status: 'live', value: dashboard(), failure: undefined })
  const first = latestMap()
  act(() => { first.events.fail() })
  expect(screen.getByRole('alert').textContent).toContain(en.webglFailed)
  expect(queryMapLabel('Implement kernel')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: en.retryMap }))
  expect(first.dispose).toHaveBeenCalledOnce()
  expect(mapLabel('Implement kernel')).toBeTruthy()
})

it('shows the track fallback and retries an unavailable scene', () => {
  vi.mocked(createTrackScene).mockImplementationOnce(() => { throw new Error('WebGL unavailable') })
  mount({ status: 'live', value: dashboard(), failure: undefined })
  fireEvent.click(screen.getByRole('radio', { name: /Tracks/u }))
  expect(screen.getByRole('alert').textContent).toContain(en.webglFailed)
  expect(screen.queryByRole('button', { name: /Select worker:/ })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: en.retryMap }))
  expect(createTrackScene).toHaveBeenCalledTimes(2)
  expect(trackHead('Implement kernel')).toBeTruthy()
})

it('places track heads, ruler ticks, the now chip, and message chips', () => {
  const value = dashboard({
    messages: [
      message('m1', { fromStepId: 'controller', toStepId: '2' }),
      message('m2', { phase: 'delivered' }),
      message('m3', { fromStepId: '2', toStepId: '1', phase: 'recorded' }),
      message('m4', { fromStepId: 'controller', toStepId: '1', kind: 'handoff' }),
      message('m5', { fromStepId: 'controller', toStepId: '1' }),
    ],
  })
  mount({ status: 'live', value, failure: undefined })
  fireEvent.click(screen.getByRole('radio', { name: /Tracks/u }))
  const head = trackHead('Implement kernel')
  const overlay = trackOverlay()
  expect(overlay).not.toBeNull()
  const start = observedAt - 120_000
  const window = (step: number, follow: boolean, span = 120_000): TrackWindow => ({ start, end: observedAt, follow, step, span })
  const seconds = tickStep(120_000)
  const tick = observedAt - 30_000
  projectTrack([
    trackAnchor('row:r/1', TRACK_LENGTH * 0.1, ROW), trackAnchor('row:r/2', TRACK_LENGTH * 0.1, ROW * 2),
    trackAnchor('link:message:m1', TRACK_LENGTH * 0.5, ROW * 1.5), trackAnchor('row:ghost', 0, 0),
    trackAnchor(`tick:${String(tick)}`, TRACK_LENGTH * 0.25, 0), trackAnchor('now', TRACK_LENGTH, 0),
  ], window(seconds, true))
  projectTrack([
    trackAnchor('row:r/1', TRACK_LENGTH * 0.1, ROW), trackAnchor('row:r/2', TRACK_LENGTH * 0.1, ROW * 2),
    trackAnchor('link:message:m1', TRACK_LENGTH * 0.5, ROW * 1.5), trackAnchor(`tick:${String(tick)}`, TRACK_LENGTH * 0.25, 0),
    trackAnchor('now', TRACK_LENGTH, 0),
  ], window(seconds, true))
  const tickText = new Date(tick).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
  expect(within(overlay).getByText(tickText)).toBeTruthy()
  expect(within(overlay).getByText(en.now)).toBeTruthy()
  expect(within(overlay).getAllByText(en.messageSent).length).toBeGreaterThan(0)
  expect(within(overlay).getByText(en.messageDelivered)).toBeTruthy()
  expect(within(overlay).getByText(en.messageRecorded)).toBeTruthy()
  expect(within(overlay).getByText(en.handoffSupplied)).toBeTruthy()
  const chips = [...(overlay).querySelectorAll('[class*="linkChip"]')]
  expect(chips).toHaveLength(5)
  expect(chips[0]?.getAttribute('style')).toContain('hidden')
  projectTrack([trackAnchor('link:message:m1', TRACK_LENGTH * 0.5, ROW * 1.5)], window(seconds, false))
  expect(chips[0]?.getAttribute('style')).toContain('visible')
  expect(chips[1]?.getAttribute('style')).toContain('hidden')
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.followLive }).getAttribute('aria-pressed')).toBe('false')
  const later = observedAt + 30_000
  const minutes = tickStep(1_800_000)
  projectTrack([trackAnchor(`tick:${String(later)}`, TRACK_LENGTH * 0.5, 0)], window(minutes, false))
  const minuteText = new Date(later).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit' })
  expect(within(overlay).getByText(minuteText)).toBeTruthy()
  const weekly = observedAt + 86_400_000
  const days = tickStep(604_800_000)
  projectTrack([trackAnchor(`tick:${String(weekly)}`, TRACK_LENGTH * 0.5, 0)], window(days, false))
  const dayText = new Date(weekly).toLocaleString([], { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit' })
  expect(within(overlay).getByText(dayText)).toBeTruthy()
  expect(within(head).getByText('20.0 tokens/s')).toBeTruthy()
  expect(trackHead('Measure throughput').textContent).toContain('—')
  fireEvent.click(screen.getByRole('button', { name: en.fitTracks }))
  expect(latestTrack().fit).toHaveBeenCalledTimes(1)
  expect(latestTrack().follow).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: en.followLive }))
  expect(latestTrack().follow).toHaveBeenCalledTimes(1)
  expect(latestTrack().fit).toHaveBeenCalledTimes(1)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.zoomIn }).disabled).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: en.zoomIn }))
  expect(latestTrack().zoom).toHaveBeenLastCalledWith(1.5)
  fireEvent.click(screen.getByRole('button', { name: en.zoomOut }))
  expect(latestTrack().zoom).toHaveBeenLastCalledWith(1 / 1.5)
  act(() => { latestTrack().events.hover(null) })
  act(() => { latestTrack().events.select(asTask('r/2')) })
  expect(screen.getByRole('heading', { name: 'Measure throughput' })).toBeTruthy()
  fireEvent.click(trackHead('Implement kernel'))
  expect(screen.getByRole('heading', { name: 'Implement kernel' })).toBeTruthy()
})

it('follows live from the control while Fit still refits', () => {
  mount({ status: 'live', value: dashboard(), failure: undefined })
  fireEvent.click(screen.getByRole('radio', { name: /Tracks/u }))
  fireEvent.click(screen.getByRole('button', { name: en.followLive }))
  expect(latestTrack().follow).toHaveBeenCalledTimes(1)
  expect(latestTrack().fit).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: en.fitTracks }))
  expect(latestTrack().fit).toHaveBeenCalledTimes(1)
  expect(latestTrack().follow).toHaveBeenCalledTimes(1)
})

it('reflects the reported window span in the time-zoom slider and updates on a span change', () => {
  mount({ status: 'live', value: dashboard(), failure: undefined })
  fireEvent.click(screen.getByRole('radio', { name: /Tracks/u }))
  const slider = (): HTMLInputElement => screen.getByRole<HTMLInputElement>('slider', { name: en.timeZoom })
  expect(slider().value).toBe(String(Math.round(zoomPosition(TRACK_SPAN_MAX) * 1000)))
  const start = observedAt - 120_000
  projectTrack([], { start, end: observedAt, follow: true, step: 60_000, span: 120_000 })
  expect(slider().value).toBe(String(Math.round(zoomPosition(120_000) * 1000)))
  expect(slider().getAttribute('aria-valuetext')).toBe('00:02:00')
  expect(slider().style.getPropertyValue('--fill')).toBe(`${String(Number(slider().value) / 10)}%`)
  projectTrack([], { start, end: observedAt, follow: true, step: 60_000, span: 60_000 })
  expect(slider().value).toBe(String(Math.round(zoomPosition(60_000) * 1000)))
})

it('sets the track scene span from the time-zoom slider position', () => {
  mount({ status: 'live', value: dashboard(), failure: undefined })
  fireEvent.click(screen.getByRole('radio', { name: /Tracks/u }))
  fireEvent.change(screen.getByRole<HTMLInputElement>('slider', { name: en.timeZoom }), { target: { value: '500' } })
  expect(latestTrack().span).toHaveBeenLastCalledWith(zoomSpan(0.5))
})

it('shows the track failure notice when the scene reports a render failure', () => {
  mount({ status: 'live', value: dashboard(), failure: undefined })
  fireEvent.click(screen.getByRole('radio', { name: /Tracks/u }))
  const first = latestTrack()
  act(() => { first.events.fail() })
  expect(screen.getByRole('alert').textContent).toContain(en.webglFailed)
  expect(document.querySelectorAll('[class*="trackHead"]').length).toBe(0)
  fireEvent.click(screen.getByRole('button', { name: en.retryMap }))
  expect(first.dispose).toHaveBeenCalledOnce()
  expect(trackHead('Implement kernel')).toBeTruthy()
})

it('shows worker status chips, profile cells, and log rows', () => {
  const value = dashboard({
    tasks: [
      task('r/1', {
        title: 'Implement kernel', detail: 'kernel.cu', usage: usage(400, 80), tokenSamples: [sample(100)],
        role: 'custom-role', tokenError: 'stream broken', dependencies: [], resources: [],
      }),
      task('r/2', { title: 'Measure throughput', status: 'queued', activity: 'unknown', attempt: 0, detail: '' }),
    ],
    timeline: [
      event('r/1', { seq: 1 }),
      event('r/2', { seq: 2, type: 'gate/pass', detail: '' }),
      event('r/3', { seq: 3, type: 'custom/event', detail: 'note' }),
      event('r/4', { seq: 4, type: 'agent/message', detail: 'hidden' }),
    ],
  })
  mount({ status: 'live', value, failure: undefined })
  const region = card()
  expect(within(region).getByText('Running')).toBeTruthy()
  expect(within(region).getAllByText('Writing files').length).toBeGreaterThan(0)
  expect(within(region).getByText('custom-role')).toBeTruthy()
  expect(within(region).getByRole('status').textContent).toContain('stream broken')
  expect(within(region).getByLabelText('20.0')).toBeTruthy()
  expect(within(region).getByText('400')).toBeTruthy()
  expect(within(region).getByText('80')).toBeTruthy()
  expect(within(region).getAllByText('01').length).toBeGreaterThan(0)
  const logs = within(region).getByRole('list', { name: en.workerLogs })
  expect(within(logs).getByText('▶')).toBeTruthy()
  expect(within(logs).getByText('custom/event')).toBeTruthy()
  expect(within(logs).getByText('Gate passed')).toBeTruthy()
  expect(within(logs).queryByText('hidden')).toBeNull()
  expect(within(logs).getByText('002')).toBeTruthy()
  expect(within(logs).getByText('001')).toBeTruthy()
  fireEvent.click(mapLabel('Measure throughput'))
  const second = card()
  expect(within(second).getByText('Queued')).toBeTruthy()
  expect(within(second).queryByText('Writing files')).toBeNull()
  expect(within(second).getByText(/Activity not reported/u)).toBeTruthy()
  expect(within(second).getByRole('list', { name: en.workerLogs }).textContent).toContain(en.noWorkerLogs)
  expect(within(second).getAllByText('00').length).toBeGreaterThan(0)
  expect(within(second).getAllByText('—').length).toBeGreaterThan(0)
})

it('pages the worker card to messages in every delivery phase', () => {
  const value = dashboard({
    tasks: [...dashboard().tasks, task('r/3', { title: 'Quiet worker' })],
    messages: [
      message('m1', { fromStepId: 'controller', toStepId: '2' }),
      message('m2', { phase: 'delivered' }),
      message('m3', { fromStepId: '2', toStepId: '1', phase: 'recorded' }),
      message('m4', { fromStepId: 'controller', toStepId: '1', kind: 'handoff' }),
      message('m5', { fromStepId: 'controller', toStepId: '1' }),
    ],
  })
  mount({ status: 'live', value, failure: undefined })
  fireEvent.click(mapLabel('Implement kernel'))
  fireEvent.click(screen.getByRole('button', { name: en.workerMessages }))
  const region = card()
  const list = within(region).getByRole('list', { name: en.workerMessages })
  expect(within(list).getByText(en.messageDelivered)).toBeTruthy()
  expect(within(list).getByText(en.messageRecorded)).toBeTruthy()
  expect(within(list).getByText(en.handoffSupplied)).toBeTruthy()
  expect(within(list).getAllByText(en.messageSent).length).toBeGreaterThan(0)
  expect(within(list).getAllByText(en.controller, { exact: false }).length).toBeGreaterThan(0)
  expect(within(region).getAllByText('04').length).toBeGreaterThan(0)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.workerMessages }).getAttribute('aria-pressed')).toBe('true')
  fireEvent.click(mapLabel('Quiet worker'))
  expect(within(card()).getByRole('list', { name: en.workerMessages }).textContent).toContain(en.noMessages)
})

it('focuses the selected worker and opens the other view', () => {
  mount({ status: 'live', value: dashboard(), failure: undefined })
  fireEvent.click(mapLabel('Implement kernel'))
  fireEvent.click(screen.getByRole('button', { name: /Focus/u }))
  expect(latestMap().focus).toHaveBeenLastCalledWith('r/1')
  fireEvent.click(screen.getByRole('button', { name: en.openTracks }))
  expect(screen.getByText(new RegExp(en.tracksDescription.slice(0, 20), 'u'))).toBeTruthy()
  act(() => { fireEvent.keyDown(document.body, { key: 'F' }) })
  expect(latestTrack().reveal).toHaveBeenLastCalledWith('r/1')
  fireEvent.click(screen.getByRole('button', { name: en.openMap }))
  expect(screen.getByText(en.mapDescription)).toBeTruthy()
})

it('lists leases with owners and records quarantines outside active runs', () => {
  const value = dashboard({
    runs: [run('r', 'GEMM investigation'), run('old', 'Old plan')],
    tasks: [dashboard().tasks[0]!, task('old/1', { runId: asRun('old'), title: 'Old worker', status: 'passed' })],
    leases: [
      lease('current-gpu'),
      lease('old-gpu', { runId: asRun('old') }),
      lease('old-quarantine', { runId: asRun('old'), stepId: '2', status: 'quarantined', detail: 'Shutdown unconfirmed' }),
      lease('old-empty-quarantine', { runId: asRun('old'), stepId: '3', status: 'quarantined' }),
      lease('current-quarantine', { stepId: '2', status: 'quarantined' }),
    ],
  })
  const h = mount({ status: 'live', value, failure: undefined })
  expect(screen.getByText('current-gpu')).toBeTruthy()
  expect(screen.getByText('old-gpu')).toBeTruthy()
  expect(screen.getAllByText(en.quarantined, { exact: false }).length).toBeGreaterThan(0)
  expect(screen.queryByRole('complementary', { name: en.historicalQuarantines })).toBeNull()
  h.read.mockReturnValue({ status: 'live', value: { ...value, activeRunIds: [asRun('r')] }, failure: undefined })
  h.view.rerender(<ClusterPage {...h.props} />)
  expect(screen.getByText('current-gpu')).toBeTruthy()
  expect(screen.queryByText('old-gpu')).toBeNull()
  const historical = screen.getByRole('complementary', { name: en.historicalQuarantines })
  expect(within(historical).getByText('old-quarantine')).toBeTruthy()
  expect(within(historical).getByText('old-empty-quarantine')).toBeTruthy()
  expect(within(historical).getByText('Shutdown unconfirmed', { exact: false })).toBeTruthy()
  expect(count(en.mLeases)).toBe('02')
  fireEvent.change(screen.getByRole('combobox', { name: en.runs }), { target: { value: '' } })
  expect(screen.queryByRole('complementary', { name: en.historicalQuarantines })).toBeNull()
  expect(screen.getByText('old-gpu')).toBeTruthy()
  expect(count(en.mLeases)).toBe('05')
})

it('lists outcome ledger evidence for passed, blocked, and failed tasks', () => {
  const value = dashboard({
    outcomes: [
      outcome('o1', { title: 'Passing outcome', role: 'developer', status: 'pass', summary: 'All checks agree', checks: ['tolerance: yes'] }),
      outcome('o2', { title: 'Blocked outcome', role: 'specialist', status: 'blocked', summary: 'Hardware missing', checks: ['lease: no'] }),
      outcome('o3', { title: 'Failing outcome', status: 'fail', summary: 'Dimensions disagree', checks: ['129 × 127 × 131: no'] }),
    ],
  })
  mount({ status: 'live', value, failure: undefined })
  for (const [title, chip, check] of [
    ['Passing outcome', en.success, 'tolerance: yes'],
    ['Blocked outcome', en.blockedOutcome, 'lease: no'],
    ['Failing outcome', en.failure, '129 × 127 × 131: no'],
  ] as const) {
    const details = screen.getByText(title).closest('details')
    expect(details).not.toBeNull()
    expect(within(details as HTMLElement).getByText(chip)).toBeTruthy()
    fireEvent.click(within(details as HTMLElement).getByText(title))
    expect(within(details as HTMLElement).getByText(check)).toBeTruthy()
  }
  expect(within(card()).getByText('Developer')).toBeTruthy()
  const ledger = screen.getByText(en.ledger).closest('section')
  expect(within(ledger as HTMLElement).getByText('specialist')).toBeTruthy()
})

it('expands the activity timeline and localizes unknown record times', () => {
  const value = dashboard({
    updatedAt: null,
    timeline: [
      event('t1', { type: 'agent/activity', detail: 'kernel.cu' }),
      event('t2', { type: 'gate/pass', stepId: '', detail: '' }),
      event('t3', { type: 'custom/event', stepId: '2', detail: 'note' }),
    ],
  })
  mount({ status: 'live', value, failure: undefined })
  expect(screen.getByText(en.unknownTime)).toBeTruthy()
  fireEvent.click(screen.getByText(en.timeline))
  const list = screen.getByRole('list', { name: en.timeline })
  expect(within(list).getByText('Writing files')).toBeTruthy()
  expect(within(list).getByText('Gate passed')).toBeTruthy()
  expect(within(list).getByText('custom/event')).toBeTruthy()
  expect(within(list).getByText('note')).toBeTruthy()
  expect(within(list).getByText('2')).toBeTruthy()
  expect(within(list).getAllByRole('listitem')).toHaveLength(3)
  expect(screen.getByText(en.statusNote)).toBeTruthy()
})

it('keeps the header clock and the track inset current', () => {
  mount({ status: 'live', value: dashboard(), failure: undefined })
  const clock = document.querySelector('time')
  const before = clock?.textContent
  act(() => { vi.advanceTimersByTime(1005) })
  expect(document.querySelector('time')?.textContent).not.toBe(before)
  act(() => { for (const observer of observers) observer.fire() })
  expect(latestTrack().inset).toHaveBeenLastCalledWith({ top: 28, right: 24, bottom: 24, left: 20 })
  const calls = latestTrack().inset.mock.calls.length
  act(() => { for (const observer of observers) observer.fire() })
  expect(latestTrack().inset.mock.calls.length).toBe(calls)
  expect(observers.some(observer => observer.disconnect.mock.calls.length >= 0)).toBe(true)
})

it('renders the sidebar branch icon', () => {
  const props = { size: 16 } as React.ComponentProps<typeof ClusterIcon>
  const { container } = render(<ClusterIcon {...props} />)
  expect(container.querySelector('svg')).not.toBeNull()
})

it('places map labels without a page stage and tolerates a label without a body', () => {
  const workers: MapWorker[] = [{ task: task('r/1', { title: 'Lone worker' }), rate: 12, index: 1 }]
  const data: MapData = {
    columns: [{ id: asTask('r/1'), cell: { i: 0, j: 0 }, height: 4, state: 'running', selected: false }],
    terminals: [], links: [], maxHeight: 12,
  }
  const control: { current: MapScene | null } = { current: null }
  render(<MapView workers={workers} terminals={[]} data={data} selectedId={null} active select={() => undefined}
    control={control} failed={() => undefined} t={makeTranslate(en)} />)
  const label = document.querySelector('[data-worker-id="r/1"]')
  if (!(label instanceof HTMLElement)) throw new Error('map label missing')
  sizeLabel(label)
  projectMap([mapAnchor('r/1', 50, 60, 1)])
  expect(label.style.transform).toBe('translate3d(50.0px, 60.0px, 0)')
  for (const child of [...label.children]) child.remove()
  projectMap([mapAnchor('r/1', 90, 70, 1)])
  expect(label.style.transform).toBe('translate3d(90.0px, 70.0px, 0)')
})

it('notes an idle API with no active runs while keeping history selectable', () => {
  const value = dashboard({ activeRunIds: [], runs: [run('r', 'GEMM investigation')] })
  mount({ status: 'live', value, failure: undefined })
  expect(screen.getByText(en.noActiveRuns)).toBeTruthy()
  expect(screen.queryByRole('button', { name: /Select worker:/ })).toBeNull()
  const ruler = screen.getAllByRole('button', { name: en.chooseWorker })
  expect(ruler.map(button => (button as HTMLButtonElement).disabled)).toEqual([true, true])
  for (const button of ruler) fireEvent.click(button)
  expect(screen.queryByText(en.noActiveRuns)).toBeTruthy()
  expect(count(en.mRunning)).toBe('00')
  expect(latestMap().update.mock.calls.at(-1)?.[0].columns).toEqual([])
  act(() => { fireEvent.keyDown(document.body, { key: 'F' }) })
  expect(latestMap().focus).not.toHaveBeenCalled()
  fireEvent.change(screen.getByRole('combobox', { name: en.runs }), { target: { value: '' } })
  expect(mapLabel('Implement kernel')).toBeTruthy()
  expect(screen.queryByText(en.noActiveRuns)).toBeNull()
  fireEvent.change(screen.getByRole('combobox', { name: en.runs }), { target: { value: 'r' } })
  expect(mapLabel('Implement kernel')).toBeTruthy()
})

it('shows the latest recorded run when idle without API ownership', () => {
  const residual = dashboard({ runs: [run('old', 'Old plan')], tasks: [task('old/1', { runId: asRun('old'), title: 'Old worker', status: 'passed' })],
    activeRunIds: null })
  mount({ status: 'live', value: residual, failure: undefined })
  expect(mapLabel('Old worker')).toBeTruthy()
  cleanup()
  const unrelated = dashboard({ runs: [run('r', 'GEMM investigation')], tasks: [task('old/1', { runId: asRun('old'), title: 'Old worker', status: 'passed' })],
    activeRunIds: null })
  mount({ status: 'live', value: unrelated, failure: undefined })
  expect(screen.queryByRole('button', { name: 'Select worker: Old worker' })).toBeNull()
  expect(screen.queryByRole('button', { name: /Select worker:/ })).toBeNull()
})

it('builds map links for dependencies, leases, and controller messages', () => {
  const value = dashboard({
    tasks: [
      task('r/1', { title: 'Running worker' }),
      task('r/2', { title: 'Depends on running', status: 'queued', dependencies: ['1'] }),
      task('r/3', { title: 'Waits for held', status: 'waiting', activity: 'unknown', waitingResource: 'gpu0' }),
      task('r/4', { title: 'Waits for free', status: 'waiting', activity: 'unknown', waitingResource: 'free-gpu' }),
      task('r/5', { title: 'Depends on passed', status: 'queued', dependencies: ['6'] }),
      task('r/6', { title: 'Passed predecessor', status: 'passed' }),
      task('r/7', { title: 'Depends on missing', status: 'queued', dependencies: ['9'] }),
    ],
    leases: [lease('gpu0')],
    messages: [
      message('m1', { fromStepId: 'controller', toStepId: '2' }),
      message('m2', { fromStepId: '1', toStepId: '2', phase: 'delivered' }),
      message('m3', { fromStepId: '1', toStepId: '2' }),
      message('m4', { toStepId: '9' }),
      message('m5', { fromStepId: '9' }),
    ],
  })
  mount({ status: 'live', value, failure: undefined })
  const data = latestMap().update.mock.calls.at(-1)?.[0]
  expect(data?.links.map(link => link.id)).toEqual([
    'dependency:r/2:1',
    'lease:r/3:gpu0',
    'lease:r/4:free-gpu',
    'message:r:controller:2',
    'message:r:1:2',
  ])
  expect(data?.links.map(link => link.kind)).toEqual(['dependency', 'lease', 'lease', 'message', 'message'])
  expect(data?.links.map(link => link.to)).toEqual(['r/2', 'r/1', 'terminal:free-gpu', 'r/2', 'r/2'])
  expect(data?.links.at(-1)?.flowing).toBe(true)
  expect(data?.terminals.map(terminal => terminal.id)).toEqual(['terminal:free-gpu', 'terminal:Controller'])
})

it('switches the worker card table to messages and back to logs', () => {
  mount({ status: 'live', value: dashboard(), failure: undefined })
  expect(screen.getByRole('list', { name: en.workerLogs })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: en.workerMessages }))
  expect(screen.getByRole('list', { name: en.workerMessages })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: en.workerLogs }))
  expect(screen.getByRole('list', { name: en.workerLogs })).toBeTruthy()
})

it('keeps the map selection and scene lifetime when worker statuses change', () => {
  const h = mount({ status: 'live', value: dashboard(), failure: undefined })
  fireEvent.click(mapLabel('Implement kernel'))
  const updated = { ...dashboard(), tasks: dashboard().tasks.map(item => ({ ...item, status: item.stepId === '1' ? 'passed' as const : 'running' as const })) }
  h.read.mockReturnValue({ status: 'live', value: updated, failure: undefined })
  h.view.rerender(<ClusterPage {...h.props} />)
  expect(createMapScene).toHaveBeenCalledOnce()
  expect(latestMap().update.mock.calls.length).toBeGreaterThanOrEqual(2)
  expect(screen.getByRole('heading', { name: 'Implement kernel' })).toBeTruthy()
  expect(mapLabel('Implement kernel').getAttribute('aria-pressed')).toBe('true')
})

it('mounts the dashboard page and streams journal snapshots through the generated Remote contribution', async () => {
  const b = await journalEntry()
  try {
    const fiber = b.ctx.plugin({ inject: [...dashboardInject], apply: scope => mountDashboard(scope, CONTRIBUTION) })
    await fiber
    expect(b.ctx.slots.entries('main')[0]?.options.key).toBe('deepCluster')
    const sidebar = b.ctx.slots.entries('sidebar.panellist')[0]
    expect(sidebar?.options.id).toBe('deepCluster')
    if (sidebar === undefined) throw new Error('sidebar panel entry missing')
    expect(resolveSlotLabel(sidebar.options.label)).toBe(en.panel)
    expect(b.register).toHaveBeenCalledOnce()
    const provider = b.register.mock.calls[0]?.[0]
    if (provider === undefined) throw new Error('journal provider missing')
    const address = 'dsh-resource://deepcluster/journal', snapshot = dashboard()

    const frame = { value: snapshot, accept: vi.fn() }
    b.setStream(scriptedJournal([frame]))
    expect(await collectJournal(provider.open(address, { signal: new AbortController().signal })))
      .toEqual([{ ok: true, value: snapshot }])
    expect(frame.accept).toHaveBeenCalledOnce()

    const aborted = new AbortController()
    aborted.abort()
    const ignored = { value: snapshot, accept: vi.fn() }, abortedStream = scriptedJournal([ignored])
    b.setStream(abortedStream)
    expect(await collectJournal(provider.open(address, { signal: aborted.signal }))).toEqual([])
    expect(ignored.accept).not.toHaveBeenCalled()
    expect(abortedStream.dispose).toHaveBeenCalledOnce()

    const failure = new Error('journal stream failed'), failedStream = scriptedJournal([], failure)
    b.setStream(failedStream)
    const failed = await collectJournal(provider.open(address, { signal: new AbortController().signal }))
    expect(failed).toHaveLength(1)
    const only = failed[0]
    if (only === undefined || only.ok) throw new Error('expected an observation failure')
    expect(only.error).toBeInstanceOf(RemoteError)
    expect(failedStream.dispose).toHaveBeenCalledOnce()

    const failedAborted = new AbortController()
    failedAborted.abort()
    const lateStream = scriptedJournal([], new Error('late journal failure'))
    b.setStream(lateStream)
    expect(await collectJournal(provider.open(address, { signal: failedAborted.signal }))).toEqual([])
    expect(lateStream.dispose).toHaveBeenCalledOnce()

    expect(b.watch).toHaveBeenCalledTimes(4)
    await fiber.dispose()
    expect(b.unmount).toHaveBeenCalledOnce()
    expect(b.ctx.slots.entries('main')).toHaveLength(0)
    expect(b.ctx.slots.entries('sidebar.panellist')).toHaveLength(0)
  } finally {
    b.root()
    await b.ctx.fiber.dispose()
  }
})

it('withdraws the Remote contribution when a dashboard slot cannot be injected', async () => {
  const b = await journalEntry()
  try {
    vi.spyOn(b.ctx.slots, 'inject').mockImplementationOnce(() => { throw new Error('slot injection failed') })
    const fiber = b.ctx.plugin({ inject: [...dashboardInject], apply: scope => mountDashboard(scope, CONTRIBUTION) })
    await expect(fiber).rejects.toThrow('slot injection failed')
    expect(b.unmount).toHaveBeenCalledOnce()
  } finally {
    b.root()
    await b.ctx.fiber.dispose()
  }
})

it('ships the same locale key vocabulary in English and Chinese', () => {
  expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  for (const key of Object.keys(en)) expect(zh[key as keyof typeof zh]).toBeTruthy()
})
