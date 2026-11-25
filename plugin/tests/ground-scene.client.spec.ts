// @vitest-environment jsdom
/** CPU-only map-scene behavior: label projection, camera gestures, picking, lifecycle, and the shared WebGL kit. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fireEvent } from '@testing-library/react'
import {
  Box3, BufferGeometry, Color, LineSegments, Material, Mesh, MeshPhysicalMaterial, NormalBlending, PerspectiveCamera,
  PlaneGeometry, ShaderMaterial, Texture, Vector3, type Scene, type WebGLRenderer,
} from 'three'
import type { ClusterTaskId } from '../src/dashboard-types.ts'
import {
  COLUMN_HALF, createMapScene, overview, type MapAnchor, type MapColumn, type MapData, type MapLink, type MapScene,
} from '../src/client/ground-scene.ts'
import { cellCenter, routeLink, type RoutePoint } from '../src/client/routing.ts'
import {
  concreteMaterial, dottedFloor, flowGeometry, flowLine, flowMaterial, flowRibbon, glossMaterial, Owner, readPalette,
} from '../src/client/scene-kit.ts'

const gpu = vi.hoisted(() => ({ render: vi.fn(), dispose: vi.fn(), lose: vi.fn(), disconnect: vi.fn() }))
const orbit = vi.hoisted(() => ({
  created: 0, disposed: 0, updates: 0, updateResult: false,
  emit: null as null | ((type: string) => void),
}))
const ray = vi.hoisted(() => ({ forcedHits: null as null | Array<{ object: object }> }))

vi.mock('../src/client/routing.ts', async (original) => {
  const actual = await original<typeof import('../src/client/routing.ts')>()
  return { ...actual, routeLink: vi.fn(actual.routeLink) }
})

vi.mock('three/addons/controls/OrbitControls.js', async () => {
  const { Vector3 } = await import('three')
  return {
    OrbitControls: class {
      readonly target = new Vector3()
      enableDamping = false
      dampingFactor = 0
      screenSpacePanning = true
      minPolarAngle = 0
      maxPolarAngle = Math.PI
      minDistance = 0
      maxDistance = Infinity
      readonly mouseButtons = { LEFT: -1, MIDDLE: -1, RIGHT: -1 }
      readonly touches = { ONE: -1, TWO: -1 }
      readonly listeners = new Map<string, Set<() => void>>()
      constructor(readonly camera: PerspectiveCamera, readonly element: HTMLElement) {
        orbit.created += 1
        orbit.emit = (type: string) => { for (const listener of this.listeners.get(type) ?? []) listener() }
      }
      addEventListener(type: string, listener: () => void): void {
        const listeners = this.listeners.get(type)
        if (listeners === undefined) this.listeners.set(type, new Set([listener]))
        else listeners.add(listener)
      }
      removeEventListener(type: string, listener: () => void): void { this.listeners.get(type)?.delete(listener) }
      update(): boolean {
        orbit.updates += 1
        this.camera.lookAt(this.target)
        this.camera.updateMatrixWorld()
        return orbit.updateResult
      }
      pan(x: number, y: number): void {
        this.camera.position.x += x * 0.05
        this.camera.position.y -= y * 0.05
        orbit.emit?.('change')
      }
      rotateLeft(angle: number): void { this.camera.position.x += angle * 10; orbit.emit?.('change') }
      rotateUp(angle: number): void { this.camera.position.y += angle * 10; orbit.emit?.('change') }
      dollyIn(factor: number): void {
        const dx = this.camera.position.x - this.target.x
        const dy = this.camera.position.y - this.target.y
        const dz = this.camera.position.z - this.target.z
        this.camera.position.set(this.target.x + dx / factor, this.target.y + dy / factor, this.target.z + dz / factor)
        orbit.emit?.('change')
      }
      dispose(): void { orbit.disposed += 1 }
    },
  }
})

vi.mock('three', async (original) => {
  const actual = await original<typeof import('three')>()
  type ActualRaycaster = InstanceType<typeof actual.Raycaster>
  class FakeRaycaster {
    readonly #actual = new actual.Raycaster()
    setFromCamera(...args: Parameters<ActualRaycaster['setFromCamera']>): void { this.#actual.setFromCamera(...args) }
    get ray() { return this.#actual.ray }
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
      outputColorSpace = ''
      toneMapping = 0
      toneMappingExposure = 1
      constructor() {
        const captured = new Set<number>()
        Object.defineProperties(this.domElement, {
          getBoundingClientRect: { value: () => new DOMRect(0, 0, 800, 500) },
          clientWidth: { value: 800 },
          clientHeight: { value: 500 },
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

const task = (value: string): ClusterTaskId => value as ClusterTaskId
const column = (index: number, overrides: Partial<MapColumn> = {}): MapColumn => ({
  id: task(String(index)), cell: { i: index % 2, j: Math.floor(index / 2) }, height: 4 + index,
  state: (['running', 'waiting', 'idle', 'done', 'failed'] as const)[index % 5]!, selected: index === 0, ...overrides,
})
const link = (value: Partial<MapLink> & Pick<MapLink, 'id' | 'from' | 'to'>): MapLink => ({
  kind: 'message', flowing: false, ...value,
})
const MAP: MapData = {
  columns: [column(0), column(1), column(2), column(3), column(4)],
  terminals: [{ id: 'controller', cell: { i: 0, j: 3 } }],
  links: [
    link({ id: 'ma', from: '0', to: '1' }),
    link({ id: 'mb', from: 'controller', to: '0', flowing: true }),
    link({ id: 'dc', from: '1', to: '2', kind: 'dependency' }),
    link({ id: 'le', from: '2', to: '3', kind: 'lease' }),
    link({ id: 'ghost', from: 'missing', to: '4' }),
  ],
  maxHeight: 12,
}

const scheduled = new Map<number, FrameRequestCallback>()
let frameSequence = 0
let virtualClock = 0
const mounted: MapScene[] = []
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
function resetFrameClock(): void { virtualClock = 0 }

beforeEach(() => {
  vi.clearAllMocks()
  ray.forcedHits = null
  orbit.updateResult = false
  observerCallbacks.length = 0
  mounted.length = 0
  installFrames()
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
  const scene = createMapScene(element, { select, hover, project, fail })
  mounted.push(scene)
  return { element, scene, select, hover, project, fail }
}
function anchorsOf(project: ReturnType<typeof vi.fn>): readonly MapAnchor[] {
  return project.mock.calls.at(-1)?.[0] as readonly MapAnchor[]
}
function cameraOf(): PerspectiveCamera {
  return gpu.render.mock.calls.at(-1)![1] as PerspectiveCamera
}
function screenPoint(camera: PerspectiveCamera, x: number, y: number, z: number): { x: number; y: number } {
  const point = new Vector3(x, y, z).project(camera)
  return { x: (point.x + 1) * 400, y: (1 - point.y) * 250 }
}
/** Shaft material by column id, read from the last rendered scene. */
function shaftMaterials(): Map<string, MeshPhysicalMaterial> {
  const scene = gpu.render.mock.calls.at(-1)![0] as Scene
  const found = new Map<string, MeshPhysicalMaterial>()
  scene.traverse((object) => {
    if (!(object instanceof Mesh) || !(object.material instanceof MeshPhysicalMaterial)) return
    const position = object.getWorldPosition(new Vector3())
    const column = MAP.columns.find((value) => {
      const center = cellCenter(value.cell)
      return Math.abs(position.x - center.x) < 1e-6 && Math.abs(position.z - center.z) < 1e-6
    })
    if (column !== undefined) found.set(column.id, object.material)
  })
  return found
}

it('projects a screen anchor above every column and terminal after the fitted frame', () => {
  const map = mount()
  map.scene.update(MAP)
  advanceFrames(4, 500)
  const anchors = anchorsOf(map.project)
  expect(anchors.map(anchor => anchor.id).sort()).toEqual(['0', '1', '2', '3', '4', 'controller'])
  for (const anchor of anchors) {
    expect(anchor.visible).toBe(true)
    expect(anchor.x).toBeGreaterThanOrEqual(0)
    expect(anchor.x).toBeLessThanOrEqual(800)
    expect(anchor.y).toBeGreaterThanOrEqual(0)
    expect(anchor.y).toBeLessThanOrEqual(500)
    expect(anchor.depth).toBeGreaterThan(0)
  }
})

it('overviews the drawn bounds and keeps the first fit across live data changes', () => {
  const map = mount()
  map.scene.update(MAP)
  advanceFrames(30, 100)
  const fitted = cameraOf().position.clone()
  map.scene.update({ ...MAP, columns: MAP.columns.map(value => ({ ...value, height: value.height + 3 })) })
  advanceFrames(3, 16)
  expect(cameraOf().position.distanceTo(fitted)).toBeLessThan(1e-6)
  expect(anchorsOf(map.project).length).toBe(6)
})

it('frames an empty overview before data arrives and a narrow aspect after a later update', () => {
  const map = mount()
  map.scene.reset()
  advanceFrames(2, 500)
  expect(map.project).toHaveBeenCalled()
  const tall = mount(host(400, 900))
  tall.scene.update(MAP)
  advanceFrames(4, 500)
  expect(anchorsOf(tall.project).every(anchor => anchor.visible)).toBe(true)
  tall.scene.reset()
  advanceFrames(2, 500)
  expect(tall.project).toHaveBeenCalled()
})

it('reuses columns, terminals, and links across updates and releases the ones that disappear', () => {
  const map = mount()
  const geometry = vi.spyOn(BufferGeometry.prototype, 'dispose')
  map.scene.update(MAP)
  advanceFrames(2, 50)
  map.scene.update(MAP)
  advanceFrames(1, 16)
  expect(anchorsOf(map.project).map(anchor => anchor.id)).toContain('controller')
  const changed: MapData = {
    columns: MAP.columns.slice(0, 4).map(value => value.id === task('0') ? { ...value, selected: false } : value),
    terminals: [],
    links: [
      { ...MAP.links[0]!, flowing: true },
      MAP.links[2]!,
    ],
    maxHeight: 12,
  }
  map.scene.update(changed)
  advanceFrames(2, 50)
  expect(anchorsOf(map.project).map(anchor => anchor.id).sort()).toEqual(['0', '1', '2', '3'])
  map.scene.update(changed)
  advanceFrames(1, 16)
  const released = geometry.mock.calls.length
  map.scene.update({ columns: [], terminals: [], links: [], maxHeight: 0 })
  advanceFrames(1, 16)
  expect(anchorsOf(map.project)).toEqual([])
  expect(geometry.mock.calls.length).toBeGreaterThan(released)
})

it('eases toward one column, frames tall columns, and returns to the overview', () => {
  const map = mount()
  map.scene.update({ ...MAP, columns: MAP.columns.map(value => value.id === task('1') ? { ...value, height: 40 } : value) })
  advanceFrames(30, 100)
  const wide = anchorsOf(map.project).find(anchor => anchor.id === '0')!
  resetFrameClock()
  map.scene.focus(task('0'))
  advanceFrame(200)
  expect(anchorsOf(map.project).find(anchor => anchor.id === '0')!.x).not.toBe(wide.x)
  resetFrameClock()
  map.scene.focus(task('0'))
  orbit.emit?.('start')
  advanceFrames(3, 1200)
  const focused = anchorsOf(map.project).find(anchor => anchor.id === '0')!
  expect(focused.x).not.toBe(wide.x)
  resetFrameClock()
  map.scene.focus(task('1'))
  advanceFrames(3, 1200)
  expect(cameraOf().position.length()).toBeGreaterThan(0)
  map.scene.focus(task('missing'))
  map.scene.reset()
  advanceFrames(30, 200)
  expect(anchorsOf(map.project).find(anchor => anchor.id === '0')!.x).toBeCloseTo(wide.x, 0)
})

it('switches the primary drag gesture, pans, orbits, and dollies the camera', () => {
  const map = mount()
  map.scene.update(MAP)
  advanceFrames(30, 100)
  const fitted = cameraOf().position.clone()
  map.scene.mode('orbit')
  map.scene.mode('pan')
  map.scene.pan(40, 20)
  advanceFrame(16)
  const panned = cameraOf().position.clone()
  expect(panned.distanceTo(fitted)).toBeGreaterThan(0)
  map.scene.orbit(0.5, 0.1)
  advanceFrame(16)
  const orbited = cameraOf().position.clone()
  expect(orbited.distanceTo(panned)).toBeGreaterThan(0)
  map.scene.zoom(1.2)
  advanceFrame(16)
  expect(cameraOf().position.distanceTo(orbited)).toBeGreaterThan(0)
  orbit.updateResult = true
  advanceFrame(16)
  orbit.updateResult = false
  expect(orbit.updates).toBeGreaterThan(0)
})

it('pauses rendering while hidden and resumes measuring when shown', () => {
  const map = mount()
  const canvas = map.element.querySelector('canvas')!
  const pending = [...scheduled.values()]
  map.scene.active(false)
  advanceFrame(16)
  const rendered = gpu.render.mock.calls.length
  map.scene.update(MAP)
  advanceFrame(16)
  expect(gpu.render).toHaveBeenCalledTimes(rendered)
  for (const callback of pending) callback(performance.now())
  expect(gpu.render).toHaveBeenCalledTimes(rendered)
  map.scene.active(true)
  advanceFrame(16)
  expect(gpu.render.mock.calls.length).toBeGreaterThan(rendered)
  expect(canvas.isConnected).toBe(true)
})

it('honors reduced motion and a host that exposes no motion preference', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
  const reduced = mount()
  reduced.scene.update(MAP)
  advanceFrame(16)
  expect(gpu.render).toHaveBeenCalled()
  reduced.scene.dispose()
  vi.stubGlobal('matchMedia', undefined)
  const absent = mount()
  absent.scene.update(MAP)
  advanceFrame(16)
  expect(gpu.render).toHaveBeenCalled()
})

it('raycasts hover and click positions and ignores drags, right clicks, and extra pointers', () => {
  const map = mount()
  map.scene.update(MAP)
  advanceFrames(40, 100)
  const canvas = map.element.querySelector('canvas')!
  const point = screenPoint(cameraOf(), 0, 2.4, 0)
  fireEvent.pointerMove(canvas, { pointerId: 7, clientX: point.x, clientY: point.y, pointerType: 'mouse' })
  expect(map.hover).toHaveBeenLastCalledWith(task('0'))
  expect(canvas.style.cursor).toBe('pointer')
  fireEvent.pointerMove(canvas, { pointerId: 8, clientX: point.x, clientY: point.y, pointerType: 'mouse' })
  expect(map.hover).toHaveBeenCalledTimes(1)
  fireEvent.pointerMove(canvas, { pointerId: 9, clientX: 2, clientY: 2, pointerType: 'mouse' })
  expect(map.hover).toHaveBeenLastCalledWith(null)
  expect(canvas.style.cursor).toBe('')
  fireEvent.pointerMove(canvas, { pointerId: 10, clientX: point.x, clientY: point.y, pointerType: 'touch' })
  expect(map.hover).toHaveBeenCalledTimes(2)

  fireEvent.pointerDown(canvas, { pointerId: 1, clientX: point.x, clientY: point.y, button: 0 })
  fireEvent.pointerUp(canvas, { pointerId: 1, clientX: point.x, clientY: point.y, button: 0 })
  expect(map.select).toHaveBeenCalledWith(task('0'))
  map.select.mockClear()

  fireEvent.pointerDown(canvas, { pointerId: 2, clientX: point.x, clientY: point.y, button: 0 })
  fireEvent.pointerMove(canvas, { pointerId: 2, clientX: point.x + 40, clientY: point.y + 20 })
  fireEvent.pointerUp(canvas, { pointerId: 2, clientX: point.x + 40, clientY: point.y + 20, button: 0 })
  expect(map.select).not.toHaveBeenCalled()

  fireEvent.pointerDown(canvas, { pointerId: 3, clientX: point.x, clientY: point.y, button: 2 })
  fireEvent.pointerUp(canvas, { pointerId: 3, clientX: point.x, clientY: point.y, button: 2 })
  expect(map.select).not.toHaveBeenCalled()

  fireEvent.pointerDown(canvas, { pointerId: 4, clientX: point.x, clientY: point.y, button: 0 })
  fireEvent.pointerDown(canvas, { pointerId: 5, clientX: point.x, clientY: point.y, button: 0 })
  fireEvent.pointerUp(canvas, { pointerId: 4, clientX: point.x, clientY: point.y, button: 0 })
  fireEvent.pointerUp(canvas, { pointerId: 5, clientX: point.x, clientY: point.y, button: 0 })
  expect(map.select).not.toHaveBeenCalled()

  fireEvent.pointerDown(canvas, { pointerId: 6, clientX: point.x, clientY: point.y, button: 0 })
  fireEvent.pointerMove(canvas, { pointerId: 6, clientX: point.x + 1, clientY: point.y })
  fireEvent.pointerCancel(canvas, { pointerId: 6 })
  fireEvent.pointerUp(canvas, { pointerId: 6, clientX: point.x, clientY: point.y, button: 0 })
  expect(map.select).not.toHaveBeenCalled()

  fireEvent.pointerDown(canvas, { pointerId: 11, clientX: 2, clientY: 2, button: 0 })
  fireEvent.pointerUp(canvas, { pointerId: 11, clientX: 2, clientY: 2, button: 0 })
  expect(map.select).not.toHaveBeenCalled()

  fireEvent.pointerDown(canvas, { pointerId: 12, clientX: point.x, clientY: point.y, button: 0 })
  fireEvent.pointerMove(canvas, { pointerId: 12, clientX: point.x + 2, clientY: point.y })
  fireEvent.pointerUp(canvas, { pointerId: 12, clientX: point.x + 2, clientY: point.y, button: 0 })
  expect(map.select).toHaveBeenCalledWith(task('0'))
})

it('clicks a shaft and tolerates a raycast that hits nothing or a node outside the map', () => {
  const map = mount()
  map.scene.update(MAP)
  advanceFrames(40, 100)
  const canvas = map.element.querySelector('canvas')!
  const point = screenPoint(cameraOf(), 0, 2.4, 0)
  fireEvent.pointerDown(canvas, { pointerId: 30, clientX: point.x, clientY: point.y, button: 0 })
  fireEvent.pointerUp(canvas, { pointerId: 30, clientX: point.x, clientY: point.y, button: 0 })
  expect(map.select).toHaveBeenCalledWith(task('0'))
  fireEvent.pointerMove(canvas, { pointerId: 31, clientX: point.x, clientY: point.y, pointerType: 'mouse' })
  expect(map.hover).toHaveBeenLastCalledWith(task('0'))
  ray.forcedHits = [{ object: {} }]
  fireEvent.pointerMove(canvas, { pointerId: 32, clientX: point.x, clientY: point.y, pointerType: 'mouse' })
  expect(map.hover).toHaveBeenLastCalledWith(null)
  ray.forcedHits = null
  fireEvent.pointerMove(canvas, { pointerId: 33, clientX: point.x, clientY: point.y, pointerType: 'mouse' })
  expect(map.hover).toHaveBeenLastCalledWith(task('0'))
  ray.forcedHits = []
  fireEvent.pointerMove(canvas, { pointerId: 34, clientX: point.x, clientY: point.y, pointerType: 'mouse' })
  expect(map.hover).toHaveBeenLastCalledWith(null)
})

it('chooses the shaft material by state, hover, and selection', () => {
  const map = mount()
  map.scene.update(MAP)
  advanceFrames(40, 100)
  const canvas = map.element.querySelector('canvas')!
  const point = screenPoint(cameraOf(), 0, 2.4, 0)
  const scene = gpu.render.mock.calls.at(-1)![0] as Scene
  let meshes = 0
  let edges = 0
  scene.traverse((object) => {
    if (object instanceof Mesh) meshes += 1
    if (object instanceof LineSegments) edges += 1
  })
  expect(meshes).toBe(14)
  expect(edges).toBe(4)
  const initial = shaftMaterials()
  expect(initial.size).toBe(5)
  expect(new Set(initial.values()).size).toBe(5)
  const selected = initial.get('0')
  expect(selected).toBeDefined()

  fireEvent.pointerMove(canvas, { pointerId: 40, clientX: point.x, clientY: point.y, pointerType: 'mouse' })
  expect(map.hover).toHaveBeenLastCalledWith(task('0'))
  expect(shaftMaterials().get('0')).toBe(selected)

  fireEvent.pointerLeave(canvas)
  map.scene.update({
    ...MAP,
    columns: MAP.columns.map(value => value.id === task('0') ? { ...value, selected: false } : value),
  })
  advanceFrame(16)
  const unselected = shaftMaterials().get('0')
  expect(unselected).toBeDefined()
  expect(unselected).not.toBe(selected)

  fireEvent.pointerMove(canvas, { pointerId: 41, clientX: point.x, clientY: point.y, pointerType: 'mouse' })
  const hovered = shaftMaterials().get('0')
  expect(hovered).toBeDefined()
  expect(hovered).not.toBe(unselected)

  fireEvent.pointerLeave(canvas)
  expect(shaftMaterials().get('0')).toBe(unselected)

  map.scene.update({
    ...MAP,
    columns: MAP.columns.map(value => value.id === task('0') ? { ...value, selected: false, state: 'failed' } : value),
  })
  advanceFrame(16)
  const failed = shaftMaterials().get('0')
  expect(failed).toBeDefined()
  expect(failed).not.toBe(unselected)
})

it('skips a degenerate route and a route sample without a predecessor', () => {
  const map = mount()
  const sparse: RoutePoint[] = []
  sparse[1] = { x: 0, z: 0 }
  vi.mocked(routeLink).mockReturnValueOnce(sparse).mockReturnValueOnce([{ x: 0, z: 0 }])
  map.scene.update({
    columns: [column(0), column(1)],
    terminals: [],
    links: [link({ id: 'sparse', from: '0', to: '1' }), link({ id: 'single', from: '1', to: '0', kind: 'dependency' })],
    maxHeight: 0,
  })
  advanceFrames(5, 100)
  expect(anchorsOf(map.project).length).toBe(2)
})

it('clears the hover highlight when the pointer leaves the canvas', () => {
  const map = mount()
  map.scene.update(MAP)
  advanceFrames(40, 100)
  const canvas = map.element.querySelector('canvas')!
  const point = screenPoint(cameraOf(), 0, 2.4, 0)
  fireEvent.pointerMove(canvas, { pointerId: 20, clientX: point.x, clientY: point.y, pointerType: 'mouse' })
  expect(map.hover).toHaveBeenLastCalledWith(task('0'))
  fireEvent.pointerLeave(canvas)
  expect(map.hover).toHaveBeenLastCalledWith(null)
  fireEvent.pointerLeave(canvas)
  expect(map.hover).toHaveBeenCalledTimes(2)
})

it('releases every geometry, material, texture, listener, and the renderer exactly once', () => {
  const geometry = vi.spyOn(BufferGeometry.prototype, 'dispose')
  const material = vi.spyOn(Material.prototype, 'dispose')
  const texture = vi.spyOn(Texture.prototype, 'dispose')
  const map = mount()
  map.scene.update(MAP)
  advanceFrames(2, 50)
  const canvas = map.element.querySelector('canvas')!
  const removeListener = vi.spyOn(canvas, 'removeEventListener')
  geometry.mockClear(); material.mockClear(); texture.mockClear()
  map.scene.dispose()
  map.scene.dispose()
  expect(gpu.disconnect).toHaveBeenCalledOnce()
  expect(gpu.dispose).toHaveBeenCalledOnce()
  expect(gpu.lose).toHaveBeenCalledOnce()
  expect(texture).toHaveBeenCalled()
  expect(geometry.mock.calls.length).toBeGreaterThan(5)
  expect(material.mock.calls.length).toBeGreaterThan(5)
  expect(removeListener).toHaveBeenCalledWith('webglcontextlost', expect.any(Function))
  expect(map.element.querySelector('canvas')).toBeNull()
  const rendered = gpu.render.mock.calls.length
  map.scene.update(MAP)
  map.scene.pan(10, 10)
  map.scene.orbit(0.2, 0.2)
  map.scene.zoom(1.1)
  map.scene.reset()
  map.scene.focus(task('0'))
  map.scene.active(true)
  advanceFrame(16)
  expect(gpu.render).toHaveBeenCalledTimes(rendered)
})

it('reports a lost WebGL context as a failure after releasing the map', () => {
  const map = mount()
  map.scene.update(MAP)
  advanceFrames(1, 16)
  const canvas = map.element.querySelector('canvas')!
  const lost = new Event('webglcontextlost', { cancelable: true })
  canvas.dispatchEvent(lost)
  expect(lost.defaultPrevented).toBe(true)
  expect(map.fail).toHaveBeenCalledOnce()
  expect(gpu.dispose).toHaveBeenCalledOnce()
  expect(gpu.lose).toHaveBeenCalledOnce()
  expect(map.element.querySelector('canvas')).toBeNull()
  map.scene.dispose()
  expect(gpu.dispose).toHaveBeenCalledOnce()
})

it('reports a renderer failure after initialization and stops scheduling frames', () => {
  const map = mount()
  advanceFrame(16)
  expect(gpu.render).toHaveBeenCalled()
  map.scene.update(MAP)
  gpu.render.mockImplementationOnce(() => { throw new Error('Renderer failed') })
  const pending = [...scheduled.values()]
  for (const callback of pending) callback(performance.now())
  expect(map.fail).toHaveBeenCalledOnce()
  expect(gpu.dispose).toHaveBeenCalledOnce()
  expect(map.element.querySelector('canvas')).toBeNull()
  const rendered = gpu.render.mock.calls.length
  for (const callback of [...scheduled.values()]) callback(performance.now())
  expect(gpu.render).toHaveBeenCalledTimes(rendered)
})

it('releases partial initialization when the canvas cannot attach', () => {
  const element = host()
  element.append = () => { throw new Error('No canvas slot') }
  expect(() => createMapScene(element, { select: vi.fn(), hover: vi.fn(), project: vi.fn(), fail: vi.fn() })).toThrow('No canvas slot')
  expect(gpu.dispose).toHaveBeenCalledOnce()
  expect(gpu.lose).toHaveBeenCalledOnce()
})

it('releases partial initialization when the first render throws', () => {
  gpu.render.mockImplementationOnce(() => { throw new Error('Renderer failed') })
  const element = host()
  expect(() => createMapScene(element, { select: vi.fn(), hover: vi.fn(), project: vi.fn(), fail: vi.fn() })).toThrow('Renderer failed')
  expect(gpu.disconnect).toHaveBeenCalledOnce()
  expect(gpu.dispose).toHaveBeenCalledOnce()
  expect(gpu.lose).toHaveBeenCalledOnce()
  expect(element.querySelector('canvas')).toBeNull()
})

it('measures a zero-sized host, fits it on the first usable resize, and ignores later measures after disposal', () => {
  const size = { width: 0, height: 0 }
  const element = host()
  element.getBoundingClientRect = () => new DOMRect(0, 0, size.width, size.height)
  const map = mount(element)
  expect(gpu.render).toHaveBeenCalled()
  map.scene.update(MAP)
  advanceFrame(16)
  size.width = 800
  size.height = 0
  observerCallbacks.at(-1)!()
  size.height = 500
  observerCallbacks.at(-1)!()
  advanceFrames(2, 500)
  expect(anchorsOf(map.project).every(anchor => anchor.visible)).toBe(true)
  map.scene.dispose()
  observerCallbacks.at(-1)!()
  expect(gpu.dispose).toHaveBeenCalledOnce()
})

it('frames empty bounds before columns exist and only fits once columns arrive', () => {
  const map = mount()
  map.scene.update({ columns: [], terminals: [], links: [], maxHeight: 0 })
  advanceFrame(16)
  expect(anchorsOf(map.project)).toEqual([])
  map.scene.update(MAP)
  advanceFrames(4, 500)
  expect(anchorsOf(map.project).length).toBe(6)
})

it('opens an empty map on the reset overview and refits once when the first columns arrive', () => {
  const map = mount()
  advanceFrames(30, 100)
  map.scene.update({ columns: [], terminals: [], links: [], maxHeight: 12 })
  advanceFrames(30, 100)
  const empty = cameraOf().position.clone()
  expect(empty.y).toBeGreaterThan(10)
  map.scene.reset()
  advanceFrames(30, 100)
  expect(cameraOf().position.distanceTo(empty)).toBeLessThan(1e-6)
  map.scene.update(MAP)
  advanceFrames(30, 100)
  const populated = cameraOf().position.clone()
  expect(populated.distanceTo(empty)).toBeGreaterThan(1)
  map.scene.update({ columns: [], terminals: [], links: [], maxHeight: 0 })
  map.scene.update(MAP)
  advanceFrames(30, 100)
  expect(cameraOf().position.distanceTo(populated)).toBeLessThan(1e-6)
})

it('overviews an empty box and a narrow viewport with a farther camera', () => {
  const wide = overview(new Box3(), 1.6)
  const narrow = overview(new Box3(), 0.5)
  const bounded = overview(new Box3(new Vector3(-10, 0, -10), new Vector3(10, 8, 10)), 1.6)
  expect(wide.position.distanceTo(wide.target)).toBeGreaterThanOrEqual(30)
  expect(narrow.position.distanceTo(narrow.target)).toBeGreaterThan(wide.position.distanceTo(wide.target))
  expect(bounded.position.distanceTo(bounded.target)).toBeGreaterThanOrEqual(30)
  expect(COLUMN_HALF).toBe(1.2)
})

it('reads the scene palette from cluster custom properties with a neutral fallback', () => {
  const style = document.createElement('div').style
  style.setProperty('--cluster-bg', 'rgb(1, 2, 3)')
  vi.stubGlobal('getComputedStyle', () => style)
  const themed = readPalette(host())
  expect(themed.bg.getHex()).toBe(0x010203)
  expect(themed.accent.getHex()).toBe(0x808080)
  vi.stubGlobal('getComputedStyle', () => document.createElement('div').style)
  const fallback = readPalette(host())
  expect(fallback.fg.getHex()).toBe(0x808080)
})

it('builds a dotted floor with defaults and explicit contour options', () => {
  const owner = new Owner()
  const palette = readPalette(host())
  const defaults = dottedFloor(palette, owner)
  expect(defaults.mesh.geometry).toBeInstanceOf(PlaneGeometry)
  defaults.setRadius(180)
  expect((defaults.mesh.material as ShaderMaterial).uniforms.radius!.value).toBe(180)
  const explicit = dottedFloor(palette, owner, { spacing: 2, opacity: 0.2, contours: false, size: 12 })
  expect((explicit.mesh.material as ShaderMaterial).uniforms.contours!.value).toBe(0)
  owner.dispose()
})

it('builds a flow line with default dash, flow, and blending', () => {
  const time = { value: 0 }
  const material = flowMaterial(new Color('#ffffff'), time, { opacity: 0.5 })
  const geometry = flowGeometry([0, 0, 0, 10, 0, 0, 10, 0, 10])
  expect(geometry.getAttribute('position').count).toBe(3)
  expect(geometry.getAttribute('along').getX(2)).toBeCloseTo(20)
  expect(geometry.getAttribute('remain').getX(0)).toBeCloseTo(20)
  const line = flowLine([0, 0, 0, 5, 0, 0], material)
  expect(line.frustumCulled).toBe(false)
  geometry.dispose(); line.geometry.dispose(); material.dispose()
})

it('skips incomplete point triples when measuring a flow geometry', () => {
  const trailing: number[] = [0, 0, 0]
  trailing.length = 6
  expect(flowGeometry(trailing).getAttribute('along').count).toBe(1)
  const leading: number[] = []
  leading[3] = 1; leading[4] = 0; leading[5] = 0
  expect(flowGeometry(leading).getAttribute('along').count).toBe(1)
})

it('keeps the concrete shader variation and its program cache key', () => {
  const material = concreteMaterial(new Color('#888888'))
  const shader = {} as Parameters<NonNullable<typeof material.onBeforeCompile>>[0]
  shader.vertexShader = '#include <common>\n#include <begin_vertex>'
  shader.fragmentShader = '#include <common>\n#include <color_fragment>\n#include <roughnessmap_fragment>'
  material.onBeforeCompile(shader, {} as WebGLRenderer)
  expect(shader.vertexShader).toContain('vConcrete')
  expect(shader.fragmentShader).toContain('dcFbm')
  expect(material.customProgramCacheKey()).toBe('dc-concrete')
  material.dispose()
})

it('injects the gloss interior uniform and shader chunks with a stable cache key', () => {
  for (const [interior, expected] of [[undefined, 0.16], [0.3, 0.3]] as const) {
    const material = interior === undefined ? glossMaterial(new Color('#ffffff')) : glossMaterial(new Color('#ffffff'), interior)
    const shader = {} as Parameters<NonNullable<typeof material.onBeforeCompile>>[0]
    shader.uniforms = {}
    shader.vertexShader = '#include <common>\n#include <begin_vertex>'
    shader.fragmentShader = '#include <common>\n#include <emissivemap_fragment>'
    material.onBeforeCompile(shader, {} as WebGLRenderer)
    expect(shader.uniforms.dcInterior?.value).toBe(expected)
    expect(shader.vertexShader).toContain('vDcLocal = position;')
    expect(shader.vertexShader).toContain('vDcScale = vec3(')
    expect(shader.fragmentShader).toContain('uniform float dcInterior;')
    expect(shader.fragmentShader).toContain('totalEmissiveRadiance += diffuseColor.rgb')
    expect(shader.fragmentShader).toContain('float dcFacing = abs(dot(normal, normalize(vViewPosition)));')
    expect(shader.fragmentShader).toContain('mix(0.4, 1.0, dcFacing)')
    expect(material.customProgramCacheKey()).toBe('dc-gloss')
    material.dispose()
  }
})

it('honors renderer clipping planes in the flow shaders', () => {
  const material = flowMaterial(new Color('#ffffff'), { value: 0 }, { opacity: 0.5 })
  expect(material.clipping).toBe(true)
  expect(material.vertexShader).toContain('#include <clipping_planes_pars_vertex>')
  expect(material.vertexShader).toContain('#include <clipping_planes_vertex>')
  expect(material.fragmentShader).toContain('#include <clipping_planes_pars_fragment>')
  expect(material.fragmentShader).toContain('#include <clipping_planes_fragment>')
  const normal = flowMaterial(new Color('#ffffff'), { value: 0 }, { opacity: 0.5, additive: false })
  expect(normal.blending).toBe(NormalBlending)
  material.dispose(); normal.dispose()
})

it('builds a ribbon whose vertices straddle each sample by half the width', () => {
  const geometry = flowRibbon([0, 0, 0, 10, 0, 0, 10, 0, 10], 2)
  const position = geometry.getAttribute('position')
  expect(position.count).toBe(6)
  const half = Math.SQRT1_2
  expect(position.getX(0)).toBeCloseTo(0)
  expect(position.getZ(0)).toBeCloseTo(1)
  expect(position.getX(1)).toBeCloseTo(0)
  expect(position.getZ(1)).toBeCloseTo(-1)
  expect(position.getX(2)).toBeCloseTo(10 - half)
  expect(position.getZ(2)).toBeCloseTo(half)
  expect(position.getX(3)).toBeCloseTo(10 + half)
  expect(position.getZ(3)).toBeCloseTo(-half)
  expect(position.getX(4)).toBeCloseTo(9)
  expect(position.getZ(4)).toBeCloseTo(10)
  expect(position.getX(5)).toBeCloseTo(11)
  expect(position.getZ(5)).toBeCloseTo(10)
  const along = geometry.getAttribute('along')
  expect(along.getX(0)).toBe(0)
  expect(along.getX(1)).toBe(0)
  expect(along.getX(2)).toBeCloseTo(10)
  expect(along.getX(3)).toBeCloseTo(10)
  expect(along.getX(4)).toBeCloseTo(20)
  expect(along.getX(5)).toBeCloseTo(20)
  const remain = geometry.getAttribute('remain')
  expect(remain.getX(0)).toBeCloseTo(20)
  expect(remain.getX(1)).toBeCloseTo(20)
  expect(remain.getX(2)).toBeCloseTo(10)
  expect(remain.getX(4)).toBeCloseTo(0)
  expect(geometry.getIndex()?.count).toBe(12)
  expect([...geometry.getIndex()!.array]).toEqual([0, 2, 1, 1, 2, 3, 2, 4, 3, 3, 4, 5])
  const v0 = new Vector3().fromBufferAttribute(position, 0)
  const v2 = new Vector3().fromBufferAttribute(position, 2)
  const v1 = new Vector3().fromBufferAttribute(position, 1)
  expect(v2.clone().sub(v0).cross(v1.clone().sub(v0)).y).toBeGreaterThan(0)
  geometry.dispose()
})

it('offsets a zero-length tangent on z and returns empty attributes below two samples', () => {
  const duplicated = flowRibbon([5, 0, 5, 5, 0, 5], 2)
  const position = duplicated.getAttribute('position')
  expect(position.count).toBe(4)
  expect(position.getX(0)).toBeCloseTo(5)
  expect(position.getZ(0)).toBeCloseTo(6)
  expect(position.getX(1)).toBeCloseTo(5)
  expect(position.getZ(1)).toBeCloseTo(4)
  expect(duplicated.getIndex()?.count).toBe(6)
  duplicated.dispose()

  const single = flowRibbon([0, 0, 0], 2)
  expect(single.getAttribute('position').count).toBe(0)
  expect(single.getAttribute('along').count).toBe(0)
  expect(single.getAttribute('remain').count).toBe(0)
  expect(single.getIndex()?.count).toBe(0)
  single.dispose()

  const none = flowRibbon([], 2)
  expect(none.getAttribute('position').count).toBe(0)
  expect(none.getIndex()?.count).toBe(0)
  none.dispose()
})
