// @vitest-environment jsdom
/** CPU-only track-scene behavior: window fit, cursor gestures, selection, live follow, clipping, and resource ownership. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fireEvent } from '@testing-library/react'
import {
  BufferGeometry, Color, InstancedMesh, Material, Mesh, MeshBasicMaterial, MeshPhysicalMaterial, PerspectiveCamera, PlaneGeometry,
  ShaderMaterial, Texture, Vector3, type Plane, type Scene, type WebGLRenderer,
} from 'three'
import type { ClusterTaskId } from '../src/dashboard-types.ts'
import {
  CLIP_PATTERNS, createTrackScene, ROW, tickStep, TRACK_LENGTH, TRACK_SPAN_MAX, TRACK_SPAN_MIN, zoomPosition, zoomSpan,
  type ClipPattern, type TrackAnchor, type TrackScene, type TrackSceneData, type TrackSceneRow, type TrackWindow,
} from '../src/client/track-scene.ts'
import type { ClipKind, RatePoint, TrackClip, TrackConnector, TrackMark } from '../src/client/track-model.ts'

const gpu = vi.hoisted(() => ({
  render: vi.fn(), dispose: vi.fn(), lose: vi.fn(), disconnect: vi.fn(),
  renderers: [] as Array<{ clippingPlanes: readonly { readonly constant: number }[] }>,
}))
const ray = vi.hoisted(() => ({
  forcedHits: null as null | Array<{ object: object; point: { z: number } }>,
  plane: undefined as undefined | null | { x: number },
}))

vi.mock('three', async (original) => {
  const actual = await original<typeof import('three')>()
  type ActualRaycaster = InstanceType<typeof actual.Raycaster>
  class FakeRaycaster {
    readonly #actual = new actual.Raycaster()
    setFromCamera(...args: Parameters<ActualRaycaster['setFromCamera']>): void { this.#actual.setFromCamera(...args) }
    get ray() {
      return ray.plane === undefined ? this.#actual.ray : { intersectPlane: () => ray.plane ?? null }
    }
    intersectObjects(...args: Parameters<ActualRaycaster['intersectObjects']>) {
      return ray.forcedHits ?? this.#actual.intersectObjects(...args)
    }
  }
  return {
    ...actual,
    Raycaster: FakeRaycaster,
    PMREMGenerator: class {
      constructor(readonly renderer: WebGLRenderer) { void renderer }
      fromScene() { return { texture: new Texture() } }
      dispose() { /* The environment target is represented by its texture only. */ }
    },
    WebGLRenderer: class {
      readonly domElement = document.createElement('canvas')
      readonly shadowMap = { enabled: false, type: 0 }
      readonly clippingPlanes: Plane[] = []
      outputColorSpace = ''
      toneMapping = 0
      toneMappingExposure = 1
      constructor() {
        gpu.renderers.push(this)
        const captured = new Set<number>()
        Object.defineProperties(this.domElement, {
          getBoundingClientRect: { value: () => new DOMRect(0, 0, 800, 500) },
          setPointerCapture: { value: (id: number) => { captured.add(id) } },
          releasePointerCapture: { value: (id: number) => { captured.delete(id) } },
          hasPointerCapture: { value: (id: number) => captured.has(id) },
        })
      }
      setPixelRatio() { /* The test renderer performs no GPU work. */ }
      setSize() { /* The fixed CSS size above is the measured host. */ }
      render(scene: Scene, camera: PerspectiveCamera): void {
        scene.updateMatrixWorld()
        camera.updateMatrixWorld()
        gpu.render(scene, camera)
      }
      dispose(): void { gpu.dispose() }
      forceContextLoss(): void { gpu.lose() }
    },
  }
})

const BASE = Date.parse('2026-01-01T00:00:00.000Z')
const MINUTE = 60_000
const LINK_Y = -0.3
const BUCKETS = 240
const task = (value: string): ClusterTaskId => value as ClusterTaskId
const clip = (kind: ClipKind, start: number, end: number, open = false): TrackClip => ({ kind, start, end, open, detail: '' })
const mark = (id: string, at: number, type: string, passed = true): TrackMark => ({ id, at, type, passed })
const once = (at: number, rate: number): RatePoint => ({ at, rate })
const PATTERN_IDS: Readonly<Record<ClipPattern, number>> = { solid: 0, stripes: 1, hatch: 2, dots: 3, bars: 4 }

function manyRows(count: number): TrackSceneRow[] {
  return Array.from({ length: count }, (_, index) => row(index))
}
function row(index: number, overrides: Partial<TrackSceneRow> = {}): TrackSceneRow {
  return {
    id: task(String(index)), height: 3 + index,
    state: (['running', 'waiting', 'idle', 'done', 'failed'] as const)[index % 5]!, selected: index === 0,
    clips: [clip('thinking', BASE - 50_000, BASE - 30_000), clip('command', BASE - 30_000, BASE - 10_000)],
    marks: [], rate: [], ...overrides,
  }
}
const connector = (id: string, from: string, to: string, kind: TrackConnector['kind'], fromAt: number, toAt: number,
  phase = 'released'): TrackConnector => ({ id, kind, from: from as ClusterTaskId, to: task(to), fromAt, toAt, phase, messageKind: '', text: '' })

const clips = (count: number): TrackClip[] => Array.from({ length: count }, (_, index) =>
  clip('command', BASE - 60_000 + index * 90, BASE - 60_000 + index * 90 + 80))

function sceneData(overrides: Partial<TrackSceneData> = {}): TrackSceneData {
  const rows = [0, 1, 2, 3, 4, 5, 6, 7].map(index => row(index, {
    marks: index === 0 ? [
      mark('pass', BASE - 40_000, 'gate/pass'), mark('fail', BASE - 20_000, 'gate/fail', false),
      mark('outcome', BASE - 15_000, 'task/outcome'), mark('other', BASE - 12_000, 'improvisation/report'),
    ] : [],
    rate: index === 0 ? [once(BASE - 65_000, 50), once(BASE - 30_000, 120)] : [],
  }))
  return {
    rows, connectors: [
      connector('controller', 'controller', '0', 'message', BASE - 40_000, BASE - 40_000),
      connector('dependency', '0', '1', 'dependency', BASE - 45_000, BASE - 35_000),
      connector('pending', '1', '2', 'dependency', BASE - 35_000, BASE - 25_000, 'pending'),
      connector('future', '0', '3', 'message', BASE + 10 * MINUTE, BASE + 10 * MINUTE),
      connector('ghost', 'ghost', '4', 'message', BASE - 20_000, BASE - 20_000),
      connector('early', '0', '5', 'message', BASE - 120_000, BASE - 100_000),
    ],
    ceiling: 100, start: BASE - 60_000, end: BASE, live: false, selection: 'run-a', ...overrides,
  }
}

const scheduled = new Map<number, FrameRequestCallback>()
let frameSequence = 0
let virtualClock = 0
const mounted: TrackScene[] = []
const observerCallbacks: (() => void)[] = []

function installFrames(): void {
  scheduled.clear()
  frameSequence = 0
  virtualClock = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frameSequence += 1
    scheduled.set(frameSequence, callback)
    return frameSequence
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { scheduled.delete(id) })
}
function advanceFrame(milliseconds = 16): void {
  virtualClock += milliseconds
  const pending = [...scheduled.values()]
  scheduled.clear()
  const now = performance.now() + virtualClock
  for (const callback of pending) callback(now)
}
function advanceFrames(count: number, milliseconds = 16): void {
  for (let index = 0; index < count; index += 1) advanceFrame(milliseconds)
}

beforeEach(() => {
  vi.clearAllMocks()
  ray.forcedHits = null
  ray.plane = undefined
  mounted.length = 0
  observerCallbacks.length = 0
  gpu.renderers.length = 0
  installFrames()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(BASE)
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  vi.stubGlobal('ResizeObserver', class {
    readonly self: ResizeObserver = {
      observe() { /* No layout notifications are requested. */ },
      unobserve() { /* Nothing is unobserved. */ },
      disconnect: gpu.disconnect,
    }
    constructor(readonly callback: ResizeObserverCallback) { observerCallbacks.push(() => { callback([], this.self) }) }
    observe() { /* The factory also measures synchronously. */ }
    disconnect = gpu.disconnect
  })
  vi.stubGlobal('PointerEvent', class extends MouseEvent {
    readonly pointerId: number
    readonly pointerType: string
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init)
      this.pointerId = init.pointerId ?? 0
      this.pointerType = init.pointerType ?? 'mouse'
    }
  })
})
afterEach(() => {
  for (const scene of mounted) scene.dispose()
  mounted.length = 0
  scheduled.clear()
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function host(width = 800, height = 500): HTMLDivElement {
  const element = document.createElement('div')
  for (const name of ['bg', 'fg', 'fg-soft', 'muted', 'line-dim', 'line-faint', 'hair', 'panel', 'case', 'case-hi', 'accent', 'concrete']) {
    element.style.setProperty(`--cluster-${name}`, 'rgb(80, 80, 80)')
  }
  element.getBoundingClientRect = () => new DOMRect(0, 0, width, height)
  document.body.append(element)
  return element
}
function mount(element = host()) {
  const select = vi.fn(), hover = vi.fn(), project = vi.fn(), fail = vi.fn()
  const scene = createTrackScene(element, { select, hover, project, fail })
  mounted.push(scene)
  return { element, scene, select, hover, project, fail }
}
function anchorsOf(project: ReturnType<typeof vi.fn>): readonly TrackAnchor[] {
  return project.mock.calls.at(-1)?.[0] as readonly TrackAnchor[]
}
function windowOf(project: ReturnType<typeof vi.fn>): TrackWindow {
  return project.mock.calls.at(-1)?.[1] as TrackWindow
}
function cameraOf(): PerspectiveCamera {
  return gpu.render.mock.calls.at(-1)![1] as PerspectiveCamera
}
function sceneOf(): Scene {
  return gpu.render.mock.calls.at(-1)![0] as Scene
}
function clipConstant(): number {
  return gpu.renderers.at(-1)?.clippingPlanes[0]?.constant ?? Number.NaN
}
function screenPoint(camera: PerspectiveCamera, x: number, y: number, z: number): { x: number; y: number } {
  const point = new Vector3(x, y, z).project(camera)
  return { x: (point.x + 1) * 400, y: (1 - point.y) * 250 }
}
function visibleRow(anchors: readonly TrackAnchor[], index: number): TrackAnchor {
  return anchors.find(anchor => anchor.id === `row:${String(index)}`)!
}
function meshesOf(scene: Scene): Mesh[] {
  const found: Mesh[] = []
  scene.traverse((object) => { if (object instanceof Mesh && !(object instanceof InstancedMesh)) found.push(object as Mesh) })
  return found
}
function stripsOf(scene: Scene): Mesh[] {
  return meshesOf(scene).filter(mesh => mesh.geometry instanceof PlaneGeometry && mesh.geometry.parameters.width === 1)
}
function instancedOf(scene: Scene): InstancedMesh {
  let found: InstancedMesh | undefined
  scene.traverse((object) => { if (object instanceof InstancedMesh) found = object })
  return found!
}
function columnsOf(scene: Scene): Mesh[] {
  return meshesOf(scene).filter(mesh => mesh.material instanceof MeshPhysicalMaterial)
}
function linksOf(scene: Scene): Mesh[] {
  return meshesOf(scene).filter(mesh => mesh.material instanceof ShaderMaterial && mesh.material.clipping)
}
function areasOf(scene: Scene): Mesh[] {
  return meshesOf(scene).filter(mesh => mesh.material instanceof MeshBasicMaterial && mesh.material.vertexColors)
}
function ribbonsOf(scene: Scene): Mesh[] {
  return meshesOf(scene).filter(mesh => mesh.material instanceof MeshBasicMaterial && !mesh.material.vertexColors
    && mesh.geometry.getAttribute('position')?.count === BUCKETS * 2)
}
function markMeshes(scene: Scene): Mesh[] {
  return meshesOf(scene).filter(mesh => mesh.geometry.type === 'BoxGeometry' && mesh.material instanceof MeshBasicMaterial)
}
function interiorOf(material: MeshPhysicalMaterial): number {
  const shader = {} as Parameters<NonNullable<typeof material.onBeforeCompile>>[0]
  shader.uniforms = {}
  shader.vertexShader = ''
  shader.fragmentShader = ''
  material.onBeforeCompile(shader, {} as WebGLRenderer)
  return Number(shader.uniforms.dcInterior?.value)
}

it('fits the recorded extent and projects ticks, the playhead, and every row header', () => {
  const map = mount()
  map.scene.update(sceneData())
  advanceFrames(60, 100)
  const window = windowOf(map.project)
  expect(window.follow).toBe(false)
  expect(window.start).toBeLessThanOrEqual(BASE - 60_000)
  expect(window.end).toBeGreaterThanOrEqual(BASE)
  expect(window.end - window.start).toBeGreaterThan(60_000)
  expect(window.span).toBeCloseTo(window.end - window.start, 3)
  expect(window.step).toBe(tickStep(window.end - window.start))
  const anchors = anchorsOf(map.project)
  expect(anchors.some(anchor => anchor.id.startsWith('tick:'))).toBe(true)
  expect(anchors.some(anchor => anchor.id === 'now')).toBe(true)
  expect(anchors.some(anchor => anchor.id === 'row:0')).toBe(true)
  expect(gpu.render).toHaveBeenCalled()
})

it('keeps every row drawn and moves only the clip plane while scrolling', () => {
  const map = mount()
  map.scene.update(sceneData({ rows: manyRows(20) }))
  advanceFrames(60, 100)
  const scene = sceneOf()
  expect(gpu.renderers.at(-1)?.clippingPlanes).toHaveLength(1)
  const strips = stripsOf(scene)
  expect(strips).toHaveLength(20)
  expect(strips.every(strip => strip.visible)).toBe(true)
  const positions = strips.map(strip => strip.position.z)
  const fitted = clipConstant()
  expect(fitted).toBeCloseTo(7.41, 3)
  expect(visibleRow(anchorsOf(map.project), 0).visible).toBe(true)
  map.scene.scroll(0.95)
  advanceFrames(60, 100)
  const crossed = clipConstant()
  expect(crossed).toBeCloseTo(-0.54, 3)
  expect(crossed).toBeLessThan(fitted)
  expect(stripsOf(scene).map(strip => strip.position.z)).toEqual(positions)
  expect(stripsOf(scene).every(strip => strip.visible)).toBe(true)
  expect(visibleRow(anchorsOf(map.project), 0).visible).toBe(false)
  map.scene.scroll(0.1)
  advanceFrames(60, 100)
  const below = clipConstant()
  expect(below).toBeCloseTo(-0.96, 3)
  expect(Math.abs(below - crossed)).toBeLessThan(1)
})

it('shrinks the fitted row count when the viewport is very wide', () => {
  const map = mount(host(1600, 200))
  map.scene.update(sceneData({ rows: manyRows(6) }))
  advanceFrames(30, 100)
  expect(visibleRow(anchorsOf(map.project), 0)).toBeDefined()
})

it('follows wall-clock time for a live run and grows the window with it', () => {
  const map = mount()
  map.scene.update(sceneData({ live: true, start: BASE - 10 * MINUTE }))
  advanceFrames(60, 100)
  const before = windowOf(map.project)
  expect(before.follow).toBe(true)
  vi.setSystemTime(BASE + 20_000)
  advanceFrames(20, 100)
  const after = windowOf(map.project)
  expect(after.end).toBeGreaterThan(before.end)
  expect(after.end - after.start).toBeGreaterThan(60_000)
  expect(after.end - after.start).toBeGreaterThan(before.end - before.start)
})

it('tracks the current time while following without rows, with a recorded run, and with a live run', () => {
  const empty = mount()
  empty.scene.update({ rows: [], connectors: [], ceiling: 100, start: BASE - 60_000, end: BASE, live: false, selection: '' })
  advanceFrames(40, 100)
  const emptyBefore = windowOf(empty.project)
  vi.setSystemTime(BASE + 20_000)
  advanceFrames(40, 100)
  const emptyAfter = windowOf(empty.project)
  expect(emptyBefore.follow).toBe(true)
  expect(emptyAfter.follow).toBe(true)
  expect(emptyAfter.end).toBeGreaterThan(emptyBefore.end)
  expect(emptyAfter.end - emptyAfter.start).toBeCloseTo(emptyBefore.end - emptyBefore.start, 0)
  empty.scene.dispose()

  const recorded = mount()
  recorded.scene.update(sceneData({ selection: 'recorded-follow' }))
  advanceFrames(60, 100)
  recorded.scene.follow()
  advanceFrames(40, 100)
  const recordedBefore = windowOf(recorded.project)
  expect(recordedBefore.follow).toBe(true)
  vi.setSystemTime(BASE + 40_000)
  advanceFrames(40, 100)
  const recordedAfter = windowOf(recorded.project)
  expect(recordedAfter.end).toBeGreaterThan(recordedBefore.end)
  expect(recordedAfter.end - recordedAfter.start).toBeCloseTo(recordedBefore.end - recordedBefore.start, 0)
  recorded.scene.dispose()

  const live = mount()
  live.scene.update(sceneData({ live: true, start: BASE - 10 * MINUTE, selection: 'live-follow' }))
  advanceFrames(120, 100)
  const liveBefore = windowOf(live.project)
  vi.setSystemTime(BASE + 5 * MINUTE)
  advanceFrames(120, 100)
  const liveAfter = windowOf(live.project)
  expect(liveBefore.follow).toBe(true)
  expect(liveAfter.follow).toBe(true)
  expect(liveAfter.end).toBeGreaterThan(liveBefore.end)
  expect(liveAfter.end - liveAfter.start).toBeGreaterThan(liveBefore.end - liveBefore.start)
})

it('fits without rows, frames a recorded run without following, and follows a live run', () => {
  const empty = mount()
  empty.scene.update({ rows: [], connectors: [], ceiling: 100, start: BASE - 60_000, end: BASE, live: false, selection: '' })
  advanceFrames(40, 100)
  empty.scene.span(90_000)
  advanceFrames(60, 100)
  const narrowed = windowOf(empty.project)
  expect(narrowed.follow).toBe(true)
  empty.scene.fit()
  advanceFrames(60, 100)
  const refitted = windowOf(empty.project)
  expect(refitted.follow).toBe(true)
  expect(refitted.end - refitted.start).toBeCloseTo(narrowed.end - narrowed.start, 0)
  empty.scene.dispose()

  const recorded = mount()
  recorded.scene.update(sceneData({ selection: 'fit-recorded' }))
  advanceFrames(60, 100)
  recorded.scene.pan(10)
  advanceFrames(60, 100)
  expect(windowOf(recorded.project).follow).toBe(false)
  recorded.scene.fit()
  advanceFrames(60, 100)
  const framed = windowOf(recorded.project)
  expect(framed.follow).toBe(false)
  expect(framed.start).toBeLessThanOrEqual(BASE - 60_000)
  expect(framed.end).toBeGreaterThanOrEqual(BASE)
  recorded.scene.dispose()

  const live = mount()
  live.scene.update(sceneData({ live: true, start: BASE - 10 * MINUTE, selection: 'fit-live' }))
  advanceFrames(120, 100)
  const first = windowOf(live.project)
  expect(first.follow).toBe(true)
  vi.setSystemTime(BASE + 2 * MINUTE)
  advanceFrames(120, 100)
  const grown = windowOf(live.project)
  expect(grown.end).toBeGreaterThan(first.end)
  expect(grown.end - grown.start).toBeGreaterThan(first.end - first.start)
  expect(grown.start).toBeLessThanOrEqual(BASE - 10 * MINUTE)
})

it('starts following without changing the span in any data state', () => {
  for (const [selection, live] of [['follow-empty', false], ['follow-recorded', false], ['follow-live', true]] as const) {
    const map = mount()
    const data = live ? sceneData({ live: true, start: BASE - 10 * MINUTE, selection })
      : selection === 'follow-empty' ? { ...sceneData({ selection }), rows: [], connectors: [] }
        : sceneData({ selection })
    map.scene.update(data)
    advanceFrames(60, 100)
    map.scene.pan(3)
    advanceFrames(60, 100)
    map.scene.span(45_000)
    advanceFrames(60, 100)
    const before = windowOf(map.project)
    expect(before.follow).toBe(false)
    map.scene.follow()
    advanceFrames(20, 100)
    const after = windowOf(map.project)
    expect(after.follow).toBe(true)
    expect(after.span).toBeCloseTo(before.span, 3)
    map.scene.dispose()
    vi.setSystemTime(BASE)
  }
})

it('keeps rendering an idle playhead every 100 ms and stops once it leaves the window', () => {
  const map = mount()
  map.scene.update(sceneData())
  advanceFrames(60, 100)
  const rendered = gpu.render.mock.calls.length
  advanceFrames(30, 16)
  const idleRenders = gpu.render.mock.calls.length - rendered
  expect(idleRenders).toBeGreaterThan(0)
  expect(idleRenders).toBeLessThanOrEqual(5)
  expect(scheduled.size).toBe(1)
  map.scene.pan(100)
  advanceFrames(120, 100)
  expect(anchorsOf(map.project).some(anchor => anchor.id === 'now')).toBe(false)
  expect(scheduled.size).toBe(0)
})

it('keeps a fitted live run in view as time advances', () => {
  const map = mount()
  const start = BASE - 10 * MINUTE
  map.scene.update(sceneData({ live: true, start, selection: 'run-whole' }))
  advanceFrames(120, 100)
  const fitted = windowOf(map.project)
  expect(fitted.start).toBeLessThanOrEqual(start)
  vi.setSystemTime(BASE + 5 * MINUTE)
  advanceFrames(120, 100)
  const later = windowOf(map.project)
  expect(later.end).toBeGreaterThan(fitted.end)
  expect(later.start).toBeLessThanOrEqual(start)
  expect(later.end - later.start).toBeGreaterThan(fitted.end - fitted.start)
})

it('holds a zoomed span fixed while following the live edge', () => {
  for (const narrow of [(scene: TrackScene): void => { scene.span(30_000) }, (scene: TrackScene): void => { scene.zoom(2) }]) {
    vi.setSystemTime(BASE)
    const map = mount()
    map.scene.update(sceneData({ live: true, start: BASE - 10 * MINUTE, selection: 'run-zoom' }))
    advanceFrames(120, 100)
    narrow(map.scene)
    advanceFrames(120, 100)
    const zoomed = windowOf(map.project)
    vi.setSystemTime(BASE + 2 * MINUTE)
    advanceFrames(120, 100)
    const later = windowOf(map.project)
    expect(later.end - later.start).toBeCloseTo(zoomed.end - zoomed.start, 3)
    expect(later.end).toBeGreaterThan(zoomed.end)
    expect(later.start).toBeGreaterThan(zoomed.start)
    map.scene.dispose()
  }
})

it('restores whole-run growth when fitted again after a zoom', () => {
  const map = mount()
  const start = BASE - 10 * MINUTE
  map.scene.update(sceneData({ live: true, start, selection: 'run-refit' }))
  advanceFrames(120, 100)
  map.scene.span(30_000)
  advanceFrames(120, 100)
  const narrow = windowOf(map.project)
  expect(narrow.end - narrow.start).toBeCloseTo(30_000, 3)
  vi.setSystemTime(BASE + 5 * MINUTE)
  advanceFrames(120, 100)
  const held = windowOf(map.project)
  expect(held.start).toBeGreaterThan(start)
  map.scene.fit()
  advanceFrames(120, 100)
  const refitted = windowOf(map.project)
  expect(refitted.start).toBeLessThanOrEqual(start)
  vi.setSystemTime(BASE + 10 * MINUTE)
  advanceFrames(120, 100)
  const grown = windowOf(map.project)
  expect(grown.end).toBeGreaterThan(refitted.end)
  expect(grown.start).toBeLessThanOrEqual(start)
  expect(grown.end - grown.start).toBeGreaterThan(held.end - held.start)
})

it('refits the recorded extent only when the displayed selection changes', () => {
  const map = mount()
  const first = sceneData()
  map.scene.update(first)
  advanceFrames(30, 100)
  map.scene.pan(0.4)
  advanceFrames(30, 100)
  const panned = windowOf(map.project)
  map.scene.update({ ...first })
  advanceFrames(20, 100)
  expect(Math.abs(windowOf(map.project).start - panned.start)).toBeLessThan(200)
  expect(windowOf(map.project).follow).toBe(false)
  map.scene.update({ ...first, selection: 'run-b' })
  advanceFrames(60, 100)
  expect(windowOf(map.project).follow).toBe(false)
  expect(windowOf(map.project).start).toBeLessThan(panned.start)
  expect(windowOf(map.project).start).toBeLessThanOrEqual(BASE - 60_000)
})

it('zooms around the pointer, pans by windows, insets, and clamps the span', () => {
  const map = mount()
  map.scene.update(sceneData())
  advanceFrames(40, 100)
  const fitted = windowOf(map.project)
  map.scene.inset({ top: 20, right: 30, bottom: 10, left: 40 })
  map.scene.zoom(2)
  advanceFrames(20, 100)
  const zoomed = windowOf(map.project)
  expect(zoomed.end - zoomed.start).toBeLessThan(fitted.end - fitted.start)
  map.scene.zoom(2, 0.95)
  advanceFrames(20, 100)
  expect(windowOf(map.project).follow).toBe(false)
  map.scene.zoom(1e6)
  advanceFrames(30, 100)
  expect(windowOf(map.project).end - windowOf(map.project).start).toBeGreaterThanOrEqual(TRACK_SPAN_MIN)
  map.scene.zoom(1e-6)
  advanceFrames(30, 100)
  expect(windowOf(map.project).end - windowOf(map.project).start).toBeLessThanOrEqual(TRACK_SPAN_MAX)
  map.scene.pan(0.5)
  advanceFrames(30, 100)
  expect(windowOf(map.project).follow).toBe(false)
  map.scene.pan(100)
  advanceFrames(60, 100)
  expect(anchorsOf(map.project).some(anchor => anchor.id === 'now')).toBe(false)
  map.scene.fit()
  advanceFrames(120, 100)
  expect(windowOf(map.project).follow).toBe(false)
  expect(anchorsOf(map.project).some(anchor => anchor.id === 'now')).toBe(true)
  map.scene.pan(-100)
  advanceFrames(60, 100)
  expect(anchorsOf(map.project).some(anchor => anchor.id === 'now')).toBe(false)
  map.scene.fit()
  advanceFrames(120, 100)
  expect(anchorsOf(map.project).some(anchor => anchor.id === 'now')).toBe(true)
})

it('zooms out around a pointer and updates following only for a right-edge anchor', () => {
  const map = mount()
  map.scene.update(sceneData())
  advanceFrames(40, 100)
  const wide = windowOf(map.project)
  map.scene.zoom(0.5, 0.5)
  advanceFrames(30, 100)
  expect(windowOf(map.project).end - windowOf(map.project).start).toBeGreaterThan(wide.end - wide.start)
  map.scene.zoom(4, 0.5)
  advanceFrames(30, 100)
  expect(windowOf(map.project).follow).toBe(false)
  map.scene.zoom(2)
  advanceFrames(30, 100)
  expect(windowOf(map.project).follow).toBe(false)
  map.scene.follow()
  advanceFrames(40, 100)
  expect(windowOf(map.project).follow).toBe(true)
  map.scene.zoom(2, 0.95)
  advanceFrames(30, 100)
  expect(windowOf(map.project).follow).toBe(true)
  map.scene.zoom(2, 0.5)
  advanceFrames(30, 100)
  expect(windowOf(map.project).follow).toBe(false)
})

it('scrolls rows with Alt-wheel, shifts time with Shift-wheel, and zooms with a plain wheel', () => {
  const map = mount()
  map.scene.update(sceneData({ rows: manyRows(20) }))
  advanceFrames(40, 100)
  const canvas = map.element.querySelector('canvas')!
  const before = windowOf(map.project)
  fireEvent.wheel(canvas, { deltaY: 120, shiftKey: true })
  advanceFrames(20, 100)
  expect(windowOf(map.project).follow).toBe(false)
  expect(windowOf(map.project).start).toBeGreaterThan(before.start)
  const shifted = windowOf(map.project)
  fireEvent.wheel(canvas, { deltaY: 240, altKey: true })
  advanceFrames(30, 100)
  expect(visibleRow(anchorsOf(map.project), 0).visible).toBe(false)
  expect(Math.abs(windowOf(map.project).start - shifted.start)).toBeLessThan(500)
  fireEvent.wheel(canvas, { deltaY: -120 })
  advanceFrames(30, 100)
  expect(windowOf(map.project).end - windowOf(map.project).start).toBeLessThan(shifted.end - shifted.start)
})

it('selects a track on a click, hovers it, drags the window, and refits on double-click', () => {
  const map = mount()
  map.scene.update(sceneData())
  advanceFrames(60, 100)
  const canvas = map.element.querySelector('canvas')!
  const point = screenPoint(cameraOf(), 20, 0, ROW)
  fireEvent.pointerMove(canvas, { pointerId: 1, clientX: point.x, clientY: point.y, pointerType: 'mouse' })
  expect(map.hover).toHaveBeenLastCalledWith(task('1'))
  expect(canvas.style.cursor).toBe('pointer')
  fireEvent.pointerMove(canvas, { pointerId: 2, clientX: point.x, clientY: point.y, pointerType: 'mouse' })
  expect(map.hover).toHaveBeenCalledTimes(1)
  map.scene.update(sceneData())
  advanceFrames(2, 100)
  fireEvent.pointerDown(canvas, { pointerId: 3, clientX: point.x, clientY: point.y, button: 0 })
  fireEvent.pointerUp(canvas, { pointerId: 3, clientX: point.x, clientY: point.y, button: 0 })
  expect(map.select).toHaveBeenLastCalledWith(task('1'))
  expect(canvas.style.cursor).toBe('pointer')
  map.select.mockClear()
  map.scene.update(sceneData())
  advanceFrames(2, 100)
  fireEvent.pointerLeave(canvas)
  expect(map.hover).toHaveBeenLastCalledWith(null)
  expect(canvas.style.cursor).toBe('grab')

  const before = windowOf(map.project).start
  fireEvent.pointerDown(canvas, { pointerId: 4, clientX: point.x, clientY: point.y, button: 2 })
  fireEvent.pointerUp(canvas, { pointerId: 4, clientX: point.x, clientY: point.y, button: 2 })
  expect(map.select).not.toHaveBeenCalled()

  fireEvent.pointerMove(canvas, { pointerId: 12, clientX: point.x, clientY: point.y, pointerType: 'touch' })
  fireEvent.pointerDown(canvas, { pointerId: 5, clientX: point.x, clientY: point.y, button: 0 })
  fireEvent.pointerMove(canvas, { pointerId: 5, clientX: point.x + 2, clientY: point.y, pointerType: 'mouse' })
  fireEvent.pointerMove(canvas, { pointerId: 5, clientX: point.x + 80, clientY: point.y + 40, pointerType: 'mouse' })
  expect(canvas.style.cursor).toBe('grabbing')
  fireEvent.pointerMove(canvas, { pointerId: 99, clientX: point.x + 90, clientY: point.y + 40, pointerType: 'mouse' })
  fireEvent.pointerMove(canvas, { pointerId: 5, clientX: point.x + 90, clientY: point.y + 40, pointerType: 'mouse' })
  fireEvent.pointerUp(canvas, { pointerId: 5, clientX: point.x + 90, clientY: point.y + 40, button: 0 })
  advanceFrames(20, 100)
  expect(windowOf(map.project).start).not.toBeCloseTo(before, 0)
  expect(windowOf(map.project).follow).toBe(false)
  expect(map.select).not.toHaveBeenCalled()

  fireEvent.pointerDown(canvas, { pointerId: 6, clientX: point.x, clientY: point.y, button: 0 })
  fireEvent.pointerCancel(canvas, { pointerId: 6, clientX: point.x, clientY: point.y })
  expect(canvas.hasPointerCapture(6)).toBe(false)

  fireEvent.dblClick(canvas)
  advanceFrames(40, 100)
  expect(windowOf(map.project).follow).toBe(false)
  expect(windowOf(map.project).start).toBeLessThanOrEqual(BASE - 60_000)
})

it('hover-clears only when no drag is pending', () => {
  const map = mount()
  map.scene.update(sceneData())
  advanceFrames(60, 100)
  const canvas = map.element.querySelector('canvas')!
  const point = screenPoint(cameraOf(), 20, 0, ROW)
  fireEvent.pointerDown(canvas, { pointerId: 1, clientX: point.x, clientY: point.y, button: 0 })
  fireEvent.pointerLeave(canvas)
  expect(map.hover).not.toHaveBeenCalled()
  fireEvent.pointerUp(canvas, { pointerId: 1, clientX: point.x, clientY: point.y, button: 0 })
  expect(map.select).toHaveBeenCalledWith(task('1'))
})

it('draws each recorded clip, grows the instance buffer, and skips clips outside the window', () => {
  const map = mount()
  const rows: TrackSceneRow[] = [
    row(0, { clips: [...clips(600), clip('queued', BASE - 60_000, BASE - 60_000), clip('command', BASE - 40_000, BASE - 10_000, true)] }),
    row(1, { clips: [clip('idle', BASE - 120_000, BASE - 110_000)] }),
  ]
  const wide = sceneData({ rows })
  map.scene.update(wide)
  advanceFrames(10, 100)
  const grown = instancedOf(sceneOf())
  expect(grown.count).toBe(601)
  expect(grown.geometry.getAttribute('clipPattern').count).toBeGreaterThanOrEqual(600)
  map.scene.update({ ...wide, rows: [row(0), row(1), row(2)] })
  advanceFrames(5, 100)
  map.scene.update({ ...wide, rows: [row(0), row(1)] })
  advanceFrames(5, 100)
  expect(visibleRow(anchorsOf(map.project), 0)).toBeDefined()
})

it('writes one pattern id per clip kind and recreates the buffer when capacity grows', () => {
  const kinds: readonly ClipKind[] = ['thinking', 'command', 'tool', 'read', 'write', 'starting', 'waiting', 'queued', 'idle']
  expect(CLIP_PATTERNS).toEqual({
    thinking: 'solid', command: 'solid', tool: 'stripes', read: 'dots', write: 'hatch',
    starting: 'bars', waiting: 'stripes', queued: 'dots', idle: 'solid',
  })
  const map = mount()
  const data = sceneData({ rows: [row(0, { clips: kinds.map(kind => clip(kind, BASE - 50_000, BASE - 40_000)) })] })
  map.scene.update(data)
  advanceFrames(5, 100)
  const small = instancedOf(sceneOf())
  const pattern = small.geometry.getAttribute('clipPattern')
  expect(pattern.count).toBe(512)
  expect(kinds.map((_, index) => pattern.getX(index)))
    .toEqual(kinds.map(kind => PATTERN_IDS[CLIP_PATTERNS[kind]]))
  const previous = small.geometry
  map.scene.update({ ...data, rows: [row(0, { clips: clips(600) })] })
  advanceFrames(5, 100)
  const grown = instancedOf(sceneOf())
  expect(grown).not.toBe(small)
  expect(grown.geometry).not.toBe(previous)
  expect(grown.geometry.getAttribute('clipPattern').count).toBeGreaterThanOrEqual(600)
})

it('draws token-rate ribbons over a vertex-alpha fill', () => {
  const map = mount()
  const single: RatePoint[] = [once(BASE - 60_000, 10)]
  const rows = [
    row(0, { rate: [once(BASE - 70_000, 40), once(BASE - 20_000, 400)] }),
    row(1, { rate: [] }),
    row(2, { rate: single }),
    row(3, { rate: [once(BASE - 300_000, 80)] }),
  ]
  map.scene.update(sceneData({ rows, ceiling: 0 }))
  advanceFrames(10, 100)
  const scene = sceneOf()
  const areas = areasOf(scene), ribbons = ribbonsOf(scene)
  expect(areas).toHaveLength(4)
  expect(ribbons).toHaveLength(4)
  const area = areas[0]!.geometry
  const ribbon = ribbons[0]!.geometry
  expect(area.getAttribute('position').count).toBe(BUCKETS * 2)
  expect(area.getAttribute('color').itemSize).toBe(4)
  expect(area.getAttribute('color').getW(0)).toBe(0)
  expect(area.getAttribute('color').getW(1)).toBe(0.5)
  expect(area.getAttribute('position').getY(0)).toBeCloseTo(0.012)
  expect(ribbon.getAttribute('position').count).toBe(BUCKETS * 2)
  expect(ribbon.getAttribute('position').getY(0)).toBeCloseTo(0.02)
  expect(ribbon.index?.count).toBe((BUCKETS - 1) * 6)
  expect(area.index?.count).toBe(ribbon.index?.count)
  const position = ribbon.getAttribute('position')
  for (const bucket of [40, 120, 200]) {
    const width = Math.hypot(position.getX(bucket * 2) - position.getX(bucket * 2 + 1),
      position.getZ(bucket * 2) - position.getZ(bucket * 2 + 1))
    expect(width).toBeCloseTo(0.12, 6)
  }
  const expected = new Color('rgb(80, 80, 80)').lerp(new Color(0xffffff), 0.12)
  expect((ribbons[0]!.material as MeshBasicMaterial).color.getHex()).toBe(expected.getHex())
  expect((areas[0]!.material as MeshBasicMaterial).depthWrite).toBe(false)
})

it('samples each curve bucket at the mean rate over its half-bucket interval', () => {
  const map = mount()
  map.scene.update(sceneData({ rows: [row(0)], ceiling: 100 }))
  advanceFrames(60, 100)
  const window = windowOf(map.project)
  const bucketWidth = (window.end - window.start) / (BUCKETS - 1)
  const center = window.start + 120 * bucketWidth
  map.scene.update(sceneData({ rows: [row(0, { rate: [once(center, 100)] })], ceiling: 100 }))
  advanceFrames(30, 100)
  const position = areasOf(sceneOf())[0]!.geometry.getAttribute('position')
  const zOf = (bucket: number): number => position.getZ(bucket * 2 + 1)
  expect(zOf(120)).toBeCloseTo((zOf(119) + zOf(121)) / 2, 5)
  expect(zOf(119)).toBeCloseTo(zOf(0), 5)
  expect(zOf(121)).toBeCloseTo(zOf(BUCKETS - 1), 5)
})

it('draws passing and failing gate marks and hides marks that disappear', () => {
  const map = mount()
  const marks = [
    mark('pass', BASE - 40_000, 'gate/pass'), mark('fail', BASE - 20_000, 'gate/fail', false),
    mark('outcome', BASE - 15_000, 'task/outcome'), mark('ignored', BASE - 10_000, 'improvisation/report'),
    mark('future', BASE + 60 * MINUTE, 'gate/pass'), mark('past', BASE - 60 * MINUTE, 'gate/pass'),
  ]
  const first = sceneData({ rows: [row(0, { marks }), row(1, { marks: [] })] })
  map.scene.update(first)
  advanceFrames(5, 100)
  expect(markMeshes(sceneOf())).toHaveLength(3)
  map.scene.update({ ...first, rows: [row(0, { marks: marks.slice(0, 1) }), row(1, { marks: [] })] })
  advanceFrames(5, 100)
  expect(markMeshes(sceneOf()).filter(mesh => mesh.visible)).toHaveLength(1)
})

it('skips clip and mark work only for tracks above the clip plane', () => {
  const map = mount()
  const rows = Array.from({ length: 20 }, (_, index) => row(index, {
    marks: [mark(`m${String(index)}`, BASE - 20_000, 'gate/pass')],
  }))
  map.scene.update(sceneData({ rows }))
  advanceFrames(60, 100)
  const scene = sceneOf()
  const clipCount = instancedOf(scene).count
  expect(clipCount).toBe(40)
  expect(markMeshes(scene).filter(mesh => mesh.visible)).toHaveLength(20)
  map.scene.scroll(1000)
  advanceFrames(60, 100)
  expect(instancedOf(scene).count).toBeLessThan(clipCount)
  expect(instancedOf(scene).count).toBeGreaterThan(0)
  const visibleMarks = markMeshes(scene).filter(mesh => mesh.visible)
  expect(visibleMarks.length).toBeLessThan(20)
  expect(visibleMarks.length).toBeGreaterThan(0)
})

it('draws message and dependency ribbons beneath the tracks with chip anchors', () => {
  const map = mount()
  const data = sceneData({ rows: [row(0), row(1), row(2), row(3), row(4)] })
  map.scene.update(data)
  advanceFrames(10, 100)
  const links = linksOf(sceneOf())
  expect(links).toHaveLength(6)
  for (const link of links) {
    expect(link.renderOrder).toBe(0)
    expect(link.frustumCulled).toBe(false)
  }
  const drawn = links.filter(link => link.visible)
  expect(drawn).toHaveLength(4)
  for (const link of drawn) {
    const position = link.geometry.getAttribute('position')
    expect(position.count).toBeGreaterThan(0)
    for (let index = 0; index < position.count; index++) expect(position.getY(index)).toBeCloseTo(LINK_Y, 6)
  }
  const uniformsOf = (link: Mesh): Record<string, { value: number }> => {
    if (!(link.material instanceof ShaderMaterial)) throw new Error('Expected a connector shader material')
    return link.material.uniforms
  }
  const messageLink = links.find(link => uniformsOf(link).opacity!.value === 0.9)!
  const dependencyLink = links.find(link => uniformsOf(link).opacity!.value === 0.8)!
  expect(uniformsOf(messageLink).flow!.value).toBe(1)
  expect(uniformsOf(messageLink).dash!.value).toBe(0)
  expect(uniformsOf(dependencyLink).dash!.value).toBe(0.6)
  expect(uniformsOf(dependencyLink).flow!.value).toBe(0)
  const widthOf = (link: Mesh): number => {
    const position = link.geometry.getAttribute('position')
    return Math.hypot(position.getX(0) - position.getX(1), position.getZ(0) - position.getZ(1))
  }
  const messages = drawn.filter(link => link.material === messageLink.material)
  expect(messages).toHaveLength(2)
  for (const link of messages) expect(widthOf(link)).toBeCloseTo(0.14, 5)
  const dependencies = drawn.filter(link => link.material === dependencyLink.material)
  expect(dependencies).toHaveLength(2)
  for (const link of dependencies) expect(widthOf(link)).toBeCloseTo(0.09, 5)
  map.scene.update({ ...data, connectors: [] })
  advanceFrames(5, 100)
  expect(linksOf(sceneOf())).toHaveLength(0)
})

it('anchors message chips in the gap after the source track for downward and upward links', () => {
  const map = mount()
  const data = sceneData({
    rows: manyRows(4),
    connectors: [
      connector('down', '0', '2', 'message', BASE - 40_000, BASE - 40_000),
      connector('up', '3', '1', 'message', BASE - 40_000, BASE - 40_000),
    ],
  })
  map.scene.update(data)
  advanceFrames(40, 100)
  const window = windowOf(map.project)
  const span = window.end - window.start
  const toX = (at: number): number => (at - window.start) / span * TRACK_LENGTH
  const expected = (from: number, to: number): { x: number; z: number; gap: number } => {
    const z0 = from * ROW + 0.7, z1 = to * ROW + 0.7
    const gap = from * ROW + (z1 > z0 ? (1.55 + ROW - 1.75) / 2 : (1.55 - 1.75 - ROW) / 2)
    const x0 = toX(BASE - 40_000)
    let best = { x: x0, z: z0, gap }
    let distance = Infinity
    for (let index = 0; index < 28; index++) {
      const u = index / 27
      const z = z0 + (z1 - z0) * u
      const step = Math.abs(z - gap)
      if (step < distance) { distance = step; best = { x: x0 + Math.sin(Math.PI * u) * 0.6, z, gap } }
    }
    return best
  }
  const anchors = anchorsOf(map.project)
  for (const [id, from, to] of [['link:down', 0, 2], ['link:up', 3, 1]] as const) {
    const anchor = anchors.find(value => value.id === id)!
    const point = expected(from, to)
    const screen = screenPoint(cameraOf(), point.x, LINK_Y, point.z)
    expect(anchor.x).toBeCloseTo(screen.x, 4)
    expect(anchor.y).toBeCloseTo(screen.y, 4)
    expect(Math.abs(point.z - point.gap)).toBeLessThan(0.4)
  }
})

it('uses glossy capless columns whose interior follows state and selection', () => {
  const map = mount()
  const rows = [
    row(0, { state: 'running', selected: false }), row(1, { state: 'waiting', selected: false }),
    row(2, { state: 'idle' }), row(3, { state: 'done' }), row(4, { state: 'failed' }),
  ]
  const data = sceneData({ rows })
  map.scene.update(data)
  advanceFrames(10, 100)
  const columns = columnsOf(sceneOf())
  expect(columns).toHaveLength(5)
  expect(meshesOf(sceneOf()).filter(mesh => mesh.geometry.type === 'BoxGeometry')).toHaveLength(5)
  expect(columns.map(column => interiorOf(column.material as MeshPhysicalMaterial))).toEqual([0.34, 0.1, 0.12, 0.18, 0.04])
  for (const column of columns) {
    const material = column.material as MeshPhysicalMaterial
    expect(material.clearcoat).toBe(1)
    expect(material.clearcoatRoughness).toBeCloseTo(0.03)
    expect(material.metalness).toBe(0)
    expect(material.roughness).toBeCloseTo(0.08)
    expect(material.sheen).toBeCloseTo(0.25)
    expect(material.envMapIntensity).toBeCloseTo(1.6)
    expect(material.color.getHex()).toBe(new Color('rgb(80, 80, 80)').multiplyScalar(0.84).getHex())
    expect(material.sheenColor.getHex()).toBe(new Color('rgb(80, 80, 80)').getHex())
  }
  map.scene.update({ ...data, rows: [{ ...rows[0]!, selected: true }, ...rows.slice(1)] })
  advanceFrames(5, 100)
  expect(interiorOf(columnsOf(sceneOf())[0]!.material as MeshPhysicalMaterial)).toBe(0.5)
})

it('ignores picks above the clip plane and takes the first remaining hit', () => {
  const map = mount()
  map.scene.update(sceneData({ rows: [row(0), row(1)] }))
  advanceFrames(40, 100)
  const canvas = map.element.querySelector('canvas')!
  const strips = stripsOf(sceneOf())
  const point = screenPoint(cameraOf(), 20, 0, ROW)
  ray.forcedHits = [{ object: strips[1]!, point: { z: 0 } }]
  fireEvent.pointerMove(canvas, { pointerId: 1, clientX: point.x, clientY: point.y, pointerType: 'mouse' })
  expect(map.hover).toHaveBeenLastCalledWith(task('1'))
  ray.forcedHits = [{ object: strips[1]!, point: { z: -1000 } }, { object: strips[0]!, point: { z: 0 } }]
  fireEvent.pointerMove(canvas, { pointerId: 2, clientX: point.x, clientY: point.y, pointerType: 'mouse' })
  expect(map.hover).toHaveBeenLastCalledWith(task('0'))
  ray.forcedHits = [{ object: strips[0]!, point: { z: -1000 } }]
  fireEvent.pointerMove(canvas, { pointerId: 3, clientX: point.x, clientY: point.y, pointerType: 'mouse' })
  expect(map.hover).toHaveBeenLastCalledWith(null)
})

it('tolerates connectors added without an update and a pick that misses every drawn row', () => {
  const map = mount()
  const data = sceneData({ rows: [row(0), row(1)] })
  const connectors = [...data.connectors]
  map.scene.update({ ...data, connectors })
  advanceFrames(30, 100)
  connectors.push(connector('runtime', '0', '1', 'message', BASE - 20_000, BASE - 20_000))
  advanceFrames(2, 100)
  const canvas = map.element.querySelector('canvas')!
  const point = screenPoint(cameraOf(), 20, 0, 0)
  fireEvent.pointerMove(canvas, { pointerId: 1, clientX: point.x, clientY: point.y, pointerType: 'mouse' })
  expect(map.hover).toHaveBeenLastCalledWith(task('0'))
  ray.forcedHits = [{ object: {}, point: { z: 0 } }]
  fireEvent.pointerMove(canvas, { pointerId: 3, clientX: point.x, clientY: point.y, pointerType: 'mouse' })
  expect(map.hover).toHaveBeenLastCalledWith(null)
  ray.forcedHits = null
  fireEvent.pointerMove(canvas, { pointerId: 4, clientX: point.x, clientY: point.y, pointerType: 'mouse' })
  expect(map.hover).toHaveBeenLastCalledWith(task('0'))
  ray.forcedHits = []
  fireEvent.pointerMove(canvas, { pointerId: 5, clientX: point.x, clientY: point.y, pointerType: 'mouse' })
  expect(map.hover).toHaveBeenLastCalledWith(null)
  ray.forcedHits = [{ object: {}, point: { z: 0 } }]
  fireEvent.pointerDown(canvas, { pointerId: 2, clientX: point.x, clientY: point.y, button: 0 })
  fireEvent.pointerUp(canvas, { pointerId: 2, clientX: point.x, clientY: point.y, button: 0 })
  expect(map.select).not.toHaveBeenCalled()
})

it('reveals a track by scrolling it into view and refits when its clips are outside the window', () => {
  const map = mount()
  const data = sceneData()
  map.scene.update(data)
  advanceFrames(60, 100)
  const before = windowOf(map.project)
  map.scene.reveal(task('missing'))
  map.scene.reveal(task('3'))
  advanceFrames(60, 100)
  expect(Math.abs(windowOf(map.project).start - before.start)).toBeLessThan(500)
  map.scene.reveal(task('7'))
  advanceFrames(60, 100)
  expect(visibleRow(anchorsOf(map.project), 7).visible).toBe(true)
  map.scene.reveal(task('0'))
  advanceFrames(60, 100)
  expect(visibleRow(anchorsOf(map.project), 0).visible).toBe(true)
  const far = { ...data, rows: data.rows.map(value => value.id === task('2')
    ? { ...value, clips: [clip('command', BASE + 60 * MINUTE, BASE + 70 * MINUTE, true)] }
    : value.id === task('4') ? { ...value, clips: [] } : value) }
  map.scene.update({ ...far, selection: 'run-c' })
  advanceFrames(30, 100)
  map.scene.reveal(task('2'))
  advanceFrames(60, 100)
  expect(windowOf(map.project).end).toBeGreaterThan(BASE + 70 * MINUTE)
  map.scene.reveal(task('1'))
  advanceFrames(60, 100)
  expect(windowOf(map.project).end).toBeLessThan(BASE + 60 * MINUTE)
  map.scene.reveal(task('4'))
  advanceFrames(10, 100)
  expect(visibleRow(anchorsOf(map.project), 4)).toBeDefined()
})

it('keeps the live window on reveal and refills the clock without message connectors', () => {
  const live = mount()
  live.scene.update(sceneData({ live: true, start: BASE - 10 * MINUTE }))
  advanceFrames(40, 100)
  const before = windowOf(live.project)
  live.scene.reveal(task('7'))
  advanceFrames(40, 100)
  expect(windowOf(live.project).end).toBeGreaterThanOrEqual(before.end)
  live.scene.dispose()
  const quiet = mount()
  quiet.scene.update(sceneData({
    connectors: [connector('dependency', '0', '1', 'dependency', BASE - 45_000, BASE - 35_000)],
  }))
  advanceFrames(20, 100)
  expect(gpu.render).toHaveBeenCalled()
})

it('pauses frames while hidden and resumes measuring when shown', () => {
  const map = mount()
  const pending = [...scheduled.values()]
  map.scene.active(false)
  advanceFrame(16)
  const rendered = gpu.render.mock.calls.length
  map.scene.update(sceneData())
  advanceFrame(16)
  expect(gpu.render).toHaveBeenCalledTimes(rendered)
  for (const callback of pending) callback(performance.now())
  expect(gpu.render).toHaveBeenCalledTimes(rendered)
  map.scene.active(true)
  advanceFrame(16)
  expect(gpu.render.mock.calls.length).toBeGreaterThan(rendered)
})

it('honors reduced motion and a host without a motion preference', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
  const reduced = mount()
  reduced.scene.update(sceneData())
  advanceFrame(16)
  expect(gpu.render).toHaveBeenCalled()
  reduced.scene.dispose()
  vi.stubGlobal('matchMedia', undefined)
  const absent = mount()
  absent.scene.update(sceneData())
  advanceFrame(16)
  expect(gpu.render).toHaveBeenCalled()
})

it('releases every geometry, material, texture, listener, and renderer exactly once', () => {
  const geometry = vi.spyOn(BufferGeometry.prototype, 'dispose')
  const material = vi.spyOn(Material.prototype, 'dispose')
  const texture = vi.spyOn(Texture.prototype, 'dispose')
  const map = mount()
  map.scene.update(sceneData())
  advanceFrames(5, 100)
  advanceFrame(16)
  const pending = [...scheduled.values()]
  const canvas = map.element.querySelector('canvas')!
  const removeListener = vi.spyOn(canvas, 'removeEventListener')
  geometry.mockClear(); material.mockClear(); texture.mockClear()
  map.scene.dispose()
  map.scene.dispose()
  for (const callback of pending) callback(performance.now())
  expect(gpu.disconnect).toHaveBeenCalledOnce()
  expect(gpu.dispose).toHaveBeenCalledOnce()
  expect(gpu.lose).toHaveBeenCalledOnce()
  expect(texture).toHaveBeenCalled()
  expect(geometry.mock.calls.length).toBeGreaterThan(5)
  expect(material.mock.calls.length).toBeGreaterThan(5)
  expect(removeListener).toHaveBeenCalledWith('webglcontextlost', expect.any(Function))
  expect(map.element.querySelector('canvas')).toBeNull()
  const rendered = gpu.render.mock.calls.length
  map.scene.update(sceneData())
  map.scene.fit()
  map.scene.inset({ top: 0, right: 0, bottom: 0, left: 0 })
  map.scene.zoom(2)
  map.scene.span(30_000)
  map.scene.pan(0.1)
  map.scene.scroll(1)
  map.scene.reveal(task('0'))
  map.scene.active(true)
  advanceFrame(16)
  expect(gpu.render).toHaveBeenCalledTimes(rendered)
})

it('reports a lost WebGL context and stops rendering after the failure', () => {
  const map = mount()
  map.scene.update(sceneData())
  advanceFrame(16)
  const canvas = map.element.querySelector('canvas')!
  const lost = new Event('webglcontextlost', { cancelable: true })
  canvas.dispatchEvent(lost)
  expect(lost.defaultPrevented).toBe(true)
  expect(map.fail).toHaveBeenCalledOnce()
  expect(gpu.dispose).toHaveBeenCalledOnce()
  expect(map.element.querySelector('canvas')).toBeNull()
})

it('reports a renderer failure after initialization and ignores the remaining frame', () => {
  const map = mount()
  map.scene.update(sceneData())
  advanceFrame(16)
  gpu.render.mockImplementationOnce(() => { throw new Error('Renderer failed') })
  advanceFrame(16)
  expect(map.fail).toHaveBeenCalledOnce()
  expect(gpu.dispose).toHaveBeenCalledOnce()
  const rendered = gpu.render.mock.calls.length
  for (const callback of [...scheduled.values()]) callback(performance.now())
  expect(gpu.render).toHaveBeenCalledTimes(rendered)
})

it('releases partial initialization when the canvas cannot attach', () => {
  const element = host()
  element.append = () => { throw new Error('No canvas slot') }
  expect(() => createTrackScene(element, { select: vi.fn(), hover: vi.fn(), project: vi.fn(), fail: vi.fn() })).toThrow('No canvas slot')
  expect(gpu.dispose).toHaveBeenCalledOnce()
  expect(gpu.lose).toHaveBeenCalledOnce()
})

it('measures a zero-sized host, fits it on the first usable resize, and ignores later measures after disposal', () => {
  const size = { width: 0, height: 0 }
  const element = host()
  element.getBoundingClientRect = () => new DOMRect(0, 0, size.width, size.height)
  const map = mount(element)
  map.scene.update(sceneData({ rows: [row(0), row(1)] }))
  advanceFrame(16)
  size.width = 800
  size.height = 0
  observerCallbacks.at(-1)!()
  size.height = 500
  observerCallbacks.at(-1)!()
  advanceFrames(60, 100)
  expect(visibleRow(anchorsOf(map.project), 0)).toBeDefined()
  map.scene.dispose()
  observerCallbacks.at(-1)!()
  expect(gpu.dispose).toHaveBeenCalledOnce()
})

it('draws an empty run without clips, connectors, or rows and accepts a zero ceiling', () => {
  const map = mount()
  map.scene.update(sceneData({ rows: [], connectors: [], ceiling: 0 }))
  advanceFrames(20, 100)
  expect(anchorsOf(map.project).filter(anchor => anchor.id.startsWith('row:'))).toEqual([])
  expect(gpu.render).toHaveBeenCalled()
})

it('translates the ground pointer to a time position and tolerates a ray parallel to the ground', () => {
  const map = mount()
  map.scene.update(sceneData())
  advanceFrames(20, 100)
  const canvas = map.element.querySelector('canvas')!
  ray.plane = { x: 32 }
  fireEvent.wheel(canvas, { deltaY: -120 })
  advanceFrames(20, 100)
  ray.plane = null
  fireEvent.wheel(canvas, { deltaY: 120 })
  advanceFrames(20, 100)
  expect(gpu.render).toHaveBeenCalled()
})

it('reads clip colors from custom properties and falls back to the foreground color', () => {
  const element = host()
  element.style.setProperty('--cluster-clip-read', 'rgb(255, 0, 0)')
  const map = mount(element)
  map.scene.update(sceneData({ rows: [row(0, { clips: [clip('read', BASE - 50_000, BASE - 40_000),
    clip('tool', BASE - 40_000, BASE - 30_000)] })] }))
  advanceFrames(5, 100)
  const instance = instancedOf(sceneOf())
  const read = new Color(), tool = new Color()
  instance.getColorAt(0, read); instance.getColorAt(1, tool)
  expect(read.getHex()).toBe(new Color('rgb(255, 0, 0)').getHex())
  expect(tool.getHex()).toBe(new Color('rgb(80, 80, 80)').getHex())
})

it('injects the patterned clip shader and keeps its program cache key', () => {
  const map = mount()
  map.scene.update(sceneData())
  advanceFrames(5, 100)
  const material = instancedOf(sceneOf()).material as import('three').MeshStandardMaterial
  const shader = {} as Parameters<NonNullable<typeof material.onBeforeCompile>>[0]
  shader.vertexShader = '#include <common>\n#include <begin_vertex>'
  shader.fragmentShader = '#include <common>\n#include <color_fragment>'
  material.onBeforeCompile(shader, {} as WebGLRenderer)
  expect(shader.vertexShader).toContain('attribute float clipPattern;')
  expect(shader.vertexShader).toContain('vClipLocal = position * vec3(')
  expect(shader.fragmentShader).toContain('float dcBand(')
  expect(shader.fragmentShader).toContain('mix(1.0, 0.42, dcMask)')
  expect(material.customProgramCacheKey()).toBe('dc-clip')
})

it('sets the window length around the center and keeps the live edge', () => {
  const map = mount()
  map.scene.update(sceneData())
  advanceFrames(40, 100)
  const fitted = windowOf(map.project)
  const center = (fitted.start + fitted.end) / 2
  map.scene.span(30_000)
  advanceFrames(120, 100)
  const zoomed = windowOf(map.project)
  expect(zoomed.end - zoomed.start).toBeCloseTo(30_000, 0)
  expect((zoomed.start + zoomed.end) / 2).toBeCloseTo(center, 0)
  expect(zoomed.span).toBeCloseTo(30_000, 0)
  map.scene.span(1)
  advanceFrames(120, 100)
  expect(windowOf(map.project).end - windowOf(map.project).start).toBeCloseTo(TRACK_SPAN_MIN, 0)
  map.scene.span(1e15)
  advanceFrames(120, 100)
  expect(windowOf(map.project).end - windowOf(map.project).start).toBeCloseTo(TRACK_SPAN_MAX, 0)
  map.scene.update(sceneData({ live: true, start: BASE - 10 * MINUTE, selection: 'run-live' }))
  advanceFrames(120, 100)
  map.scene.span(30_000)
  advanceFrames(120, 100)
  expect(windowOf(map.project).end - BASE).toBeCloseTo(30_000 * 0.06, -2)
})

it('maps slider positions to spans and back', () => {
  expect(TRACK_SPAN_MIN).toBe(5_000)
  expect(TRACK_SPAN_MAX).toBe(7 * 24 * 3_600_000)
  expect(zoomPosition(TRACK_SPAN_MAX)).toBeCloseTo(0, 6)
  expect(zoomPosition(TRACK_SPAN_MIN)).toBeCloseTo(1, 6)
  expect(zoomPosition(1)).toBeCloseTo(1, 6)
  expect(zoomPosition(1e15)).toBeCloseTo(0, 6)
  expect(zoomSpan(0)).toBeCloseTo(TRACK_SPAN_MAX, 4)
  expect(zoomSpan(1)).toBeCloseTo(TRACK_SPAN_MIN, 6)
  expect(zoomSpan(-5)).toBeCloseTo(TRACK_SPAN_MAX, 4)
  expect(zoomSpan(5)).toBeCloseTo(TRACK_SPAN_MIN, 6)
  for (const span of [TRACK_SPAN_MIN, 30_000, 3_600_000, TRACK_SPAN_MAX]) {
    expect(zoomSpan(zoomPosition(span))).toBeCloseTo(span, 6)
  }
})

it('selects the time step for short, long, and beyond-range spans', () => {
  expect(tickStep(1_000)).toBe(1_000)
  expect(tickStep(7 * 24 * 3_600_000)).toBe(86_400_000)
  expect(tickStep(7 * 24 * 3_600_000 * 2)).toBe(86_400_000)
  expect(TRACK_LENGTH).toBe(64)
  expect(ROW).toBe(4.2)
})
