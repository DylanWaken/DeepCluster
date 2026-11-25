/**
 * The worker map: glossy columns on a graphite platform over a dotted floor, joined by lane-routed spline bundles.
 * Rendering runs only while the camera, a column, or a pulse moves; the owning React effect disposes every GPU and DOM
 * resource.
 */
import {
  Box3, BoxGeometry, DirectionalLight, EdgesGeometry, Group, HemisphereLight, LineBasicMaterial, LineSegments, Mesh,
  MeshStandardMaterial, MOUSE, PerspectiveCamera, Raycaster, Scene, Sphere, TOUCH, Vector2, Vector3,
  type Line, type MeshPhysicalMaterial,
} from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { ClusterTaskId } from '../dashboard-types.ts'
import { easeInOut, frameClock, reducedMotion, spring, stepSpring, tweenProgress, type Spring, type Tween } from './motion.ts'
import { CELL, cellCenter, routeLink, type Cell, type RouteNode } from './routing.ts'
import {
  concreteMaterial, createRenderer, dottedFloor, flowLine, flowMaterial, glossMaterial, Owner, readPalette,
  studioEnvironment,
} from './scene-kit.ts'

/** Half-width of a worker column footprint. */
export const COLUMN_HALF = 1.2
const TERMINAL_HALF = 0.6
const PLATFORM_TOP = 0.35
const BUNDLE = 7

/** Visual state of one column's material. */
export type ColumnState = 'running' | 'waiting' | 'idle' | 'done' | 'failed'
/** One worker column. */
export interface MapColumn {
  readonly id: ClusterTaskId
  readonly cell: Cell
  readonly height: number
  readonly state: ColumnState
  readonly selected: boolean
}
/** A connection endpoint that is not a worker, such as the controller or a held resource. */
export interface MapTerminal { readonly id: string; readonly cell: Cell }
/** A recorded connection between two node ids. */
export interface MapLink {
  readonly id: string
  readonly from: string
  readonly to: string
  readonly kind: 'message' | 'dependency' | 'lease'
  readonly flowing: boolean
}
/** Everything the map draws. */
export interface MapData {
  readonly columns: readonly MapColumn[]
  readonly terminals: readonly MapTerminal[]
  readonly links: readonly MapLink[]
  /** Tallest height a column can reach; camera framing reserves it so growing columns stay in view. */
  readonly maxHeight: number
}
/** Screen-space anchor at the top of a column or terminal, in CSS pixels relative to the host. */
export interface MapAnchor {
  readonly id: string
  readonly x: number
  readonly y: number
  readonly visible: boolean
  readonly depth: number
}
/** Scene callbacks; `project` runs after every rendered frame. */
export interface MapEvents {
  select(this: void, id: ClusterTaskId): void
  hover(this: void, id: ClusterTaskId | null): void
  project(this: void, anchors: readonly MapAnchor[]): void
  fail(this: void): void
}
/** Camera controls and lifetime returned to the mounting effect. */
export interface MapScene {
  /** Replace the drawn data; the camera moves only on the first fit. @param data - columns, terminals, and links. */
  update(this: void, data: MapData): void
  /** Ease the camera toward one column. @param id - column to frame. */
  focus(this: void, id: ClusterTaskId): void
  /** Ease the camera back to the fitted overview. */
  reset(this: void): void
  /** Choose the primary drag gesture. @param mode - pan or orbit. */
  mode(this: void, mode: 'pan' | 'orbit'): void
  /** Move the camera in screen pixels. @param x - horizontal delta. @param y - vertical delta. */
  pan(this: void, x: number, y: number): void
  /** Rotate around the focus. @param x - azimuth radians. @param y - elevation radians. */
  orbit(this: void, x: number, y: number): void
  /** Dolly toward the focus. @param factor - magnification multiplier. */
  zoom(this: void, factor: number): void
  /** Pause or resume rendering while another view is shown. @param on - whether the map is visible. */
  active(this: void, on: boolean): void
  /** Release controls, listeners, GPU resources, and the WebGL context. */
  dispose(this: void): void
}

/**
 * Overview camera framing every footprint and column height.
 * @param bounds - world bounds of the drawn content.
 * @param aspect - viewport width over height.
 * @returns camera position and orbit target.
 */
export function overview(bounds: Box3, aspect: number): { readonly position: Vector3; readonly target: Vector3 } {
  const box = bounds.isEmpty() ? new Box3(new Vector3(-6, 0, -6), new Vector3(6, 4, 6)) : bounds
  const sphere = box.getBoundingSphere(new Sphere())
  const halfFov = Math.atan(Math.tan(35 / 2 * Math.PI / 180) * Math.min(1, aspect))
  const distance = Math.max(30, sphere.radius / Math.sin(halfFov) * 1.02)
  return {
    target: sphere.center.clone().setY(sphere.center.y * 0.4),
    position: sphere.center.clone().add(new Vector3(0.62, 0.66, 0.84).normalize().multiplyScalar(distance)),
  }
}

/**
 * Mount the worker map.
 * @param host - measured container carrying the `--cluster-*` palette.
 * @param events - selection, hover, label projection, and failure callbacks.
 * @returns the disposable scene; throws when WebGL cannot initialize.
 */
export function createMapScene(host: HTMLElement, events: MapEvents): MapScene {
  const owner = new Owner()
  let disposed = false
  const dispose = (): void => { if (!disposed) { disposed = true; owner.dispose() } }
  try {
    const renderer = createRenderer(host, owner)
    const canvas = renderer.domElement
    const palette = readPalette(host)
    const scene = new Scene()
    scene.background = palette.bg
    scene.environment = studioEnvironment(renderer, owner)
    scene.environmentIntensity = 0.55
    owner.defer(() => { scene.clear() })
    const camera = new PerspectiveCamera(35, 1, 0.5, 3000)
    const controls = owner.own(new OrbitControls(camera, canvas))
    controls.enableDamping = true
    controls.dampingFactor = 0.085
    controls.screenSpacePanning = false
    controls.minPolarAngle = 0.12
    controls.maxPolarAngle = Math.PI * 0.43
    controls.minDistance = 12
    controls.maxDistance = 600
    controls.mouseButtons.LEFT = MOUSE.PAN
    controls.mouseButtons.RIGHT = MOUSE.ROTATE
    controls.touches.ONE = TOUCH.PAN
    controls.touches.TWO = TOUCH.DOLLY_PAN

    const sun = new DirectionalLight(0xffffff, 2.4)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    sun.shadow.bias = -0.0004
    sun.shadow.normalBias = 0.02
    sun.shadow.radius = 4
    scene.add(sun, sun.target, new HemisphereLight(0xffffff, 0x2a2a28, 0.5))

    const floor = dottedFloor(palette, owner, { spacing: 1.1, opacity: 0.55 })
    floor.mesh.position.y = -1.4
    scene.add(floor.mesh)
    const platformDots = dottedFloor(palette, owner, { spacing: 0.55, opacity: 0.22, contours: false, size: 1 })
    platformDots.mesh.position.y = PLATFORM_TOP + 0.004
    platformDots.setRadius(1e6)

    const unitBox = owner.own(new BoxGeometry(1, 1, 1).translate(0, 0.5, 0))
    const unitEdges = owner.own(new EdgesGeometry(unitBox))
    const platformMaterial = owner.own(new MeshStandardMaterial({ color: palette.case, roughness: 0.92, metalness: 0 }))
    const platform = new Mesh(unitBox, platformMaterial)
    platform.receiveShadow = true
    const platformEdge = new LineSegments(unitEdges,
      owner.own(new LineBasicMaterial({ color: palette.fgSoft, transparent: true, opacity: 0.32 })))
    const strata = [0.55, 0.34, 0.2].map(opacity => new LineSegments(unitEdges,
      owner.own(new LineBasicMaterial({ color: palette.accent, transparent: true, opacity }))))
    const stage = new Group()
    stage.add(platform, platformEdge, platformDots.mesh, ...strata)
    scene.add(stage)

    const plinthMaterial = owner.own(concreteMaterial(palette.caseHi, 0.7))
    const terminalMaterial = owner.own(concreteMaterial(palette.lineDim, 0.6))
    const columnMaterials: Record<ColumnState, MeshPhysicalMaterial> = {
      running: owner.own(glossMaterial(palette.concrete, 0.34)),
      waiting: owner.own(glossMaterial(palette.concrete.clone().lerp(palette.lineDim, 0.25), 0.1)),
      idle: owner.own(glossMaterial(palette.concrete, 0.12)),
      done: owner.own(glossMaterial(palette.concrete, 0.18)),
      failed: owner.own(glossMaterial(palette.caseHi.clone().lerp(palette.concrete, 0.35), 0.04)),
    }
    const selectedMaterial = owner.own(glossMaterial(palette.concrete, 0.5))
    const hoverMaterial = owner.own(glossMaterial(palette.concrete, 0.36))

    interface ColumnObjects { group: Group; shaft: Mesh; height: Spring; data: MapColumn }
    const columns = new Map<ClusterTaskId, ColumnObjects>()
    const terminals = new Map<string, Mesh>()
    const time = { value: 0 }
    const materials = {
      message: owner.own(flowMaterial(palette.accent, time, { opacity: 0.5 })),
      messageFlow: owner.own(flowMaterial(palette.accent, time, { opacity: 0.32, flow: true })),
      dependency: owner.own(flowMaterial(palette.fg, time, { opacity: 0.3, dash: 0.9 })),
      lease: owner.own(flowMaterial(palette.fgSoft, time, { opacity: 0.32, dash: 0.35 })),
    }
    const links = new Map<string, { key: string; lines: Line[]; flowing: boolean }>()
    owner.defer(() => { for (const link of links.values()) for (const line of link.lines) line.geometry.dispose() })

    let data: MapData = { columns: [], terminals: [], links: [], maxHeight: 0 }
    let width = 1, height = 1, isActive = true, hovered: ClusterTaskId | null = null
    /** Selection outranks hover, which outranks the column's state material. */
    const shaftMaterial = (column: MapColumn): MeshPhysicalMaterial =>
      column.selected ? selectedMaterial : column.id === hovered ? hoverMaterial : columnMaterials[column.state]
    /** Whether the last automatic fit framed any column; null before the first fit. */
    let fittedColumns: boolean | null = null
    let received = false
    let tween: { tween: Tween; fromTarget: Vector3; toTarget: Vector3; fromPosition: Vector3; toPosition: Vector3 } | null = null
    const bounds = new Box3()

    const anchorPoint = new Vector3()
    const project = (): void => {
      const anchors: MapAnchor[] = []
      const push = (id: string, x: number, y: number, z: number): void => {
        anchorPoint.set(x, y, z)
        const depth = anchorPoint.distanceTo(camera.position)
        anchorPoint.project(camera)
        anchors.push({ id, x: (anchorPoint.x + 1) * width / 2, y: (1 - anchorPoint.y) * height / 2, depth,
          visible: anchorPoint.z > -1 && anchorPoint.z < 1 && Math.abs(anchorPoint.x) < 1.1 && Math.abs(anchorPoint.y) < 1.1 })
      }
      for (const [id, column] of columns) push(id, column.group.position.x, PLATFORM_TOP + column.height.x + 0.12, column.group.position.z)
      for (const [id, marker] of terminals) push(id, marker.position.x, PLATFORM_TOP + 1.3, marker.position.z)
      events.project(anchors)
    }
    const render = (): void => {
      try {
        renderer.render(scene, camera)
        project()
      } catch (_error) {
        // A renderer failure after initialization leaves the worker list usable while the user retries the map.
        dispose(); events.fail()
      }
    }
    const clock = frameClock((dt, now) => {
      if (disposed || !isActive) return false
      const reduce = reducedMotion()
      let moving = false
      if (tween !== null) {
        const k = tweenProgress(tween.tween, now, reduce, easeInOut)
        controls.target.lerpVectors(tween.fromTarget, tween.toTarget, k)
        camera.position.lerpVectors(tween.fromPosition, tween.toPosition, k)
        if (k >= 1) tween = null; else moving = true
      }
      if (controls.update()) moving = true
      for (const column of columns.values()) {
        if (stepSpring(column.height, dt, reduce)) moving = true
        const h = Math.max(0.05, column.height.x)
        column.shaft.scale.y = h
      }
      if (!reduce && [...links.values()].some(link => link.flowing)) { time.value += dt; moving = true }
      render()
      return moving
    })
    const wake = (): void => { if (!disposed && isActive) clock.wake() }
    controls.addEventListener('change', wake)
    controls.addEventListener('start', () => { tween = null })
    owner.defer(() => { clock.stop(); controls.removeEventListener('change', wake) })

    const startTween = (toTarget: Vector3, toPosition: Vector3, duration: number): void => {
      tween = { tween: { start: performance.now(), duration }, fromTarget: controls.target.clone(), toTarget,
        fromPosition: camera.position.clone(), toPosition }
      wake()
    }
    const fit = (intro: boolean): void => {
      const view = overview(bounds, width / height)
      if (intro) {
        controls.target.copy(view.target)
        const lift = view.position.clone().sub(view.target).multiplyScalar(1.7)
        camera.position.copy(view.target.clone().add(lift).setY(view.position.y * 1.9))
      }
      startTween(view.target, view.position, intro ? 1600 : 900)
    }
    const autoFit = (): void => {
      const hasColumns = data.columns.length > 0
      if (received && width > 1 && (fittedColumns === null || (hasColumns && !fittedColumns))) {
        fit(fittedColumns === null)
        fittedColumns = hasColumns
      } else wake()
    }

    const layoutStage = (): void => {
      const box = new Box3()
      const include = (cell: Cell, half: number): void => {
        const center = cellCenter(cell)
        box.expandByPoint(new Vector3(center.x - half, 0, center.z - half)).expandByPoint(new Vector3(center.x + half, 0, center.z + half))
      }
      for (const column of data.columns) include(column.cell, COLUMN_HALF)
      for (const terminal of data.terminals) include(terminal.cell, TERMINAL_HALF)
      if (box.isEmpty()) box.set(new Vector3(-2, 0, -2), new Vector3(2, 0, 2))
      const margin = CELL / 2 + 1.6
      const minX = box.min.x - margin, maxX = box.max.x + margin, minZ = box.min.z - margin, maxZ = box.max.z + margin
      const sx = maxX - minX, sz = maxZ - minZ, cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2
      platform.position.set(cx, -0.25, cz); platform.scale.set(sx, PLATFORM_TOP + 0.25, sz)
      platformEdge.position.copy(platform.position); platformEdge.scale.copy(platform.scale)
      platformDots.mesh.position.set(cx, PLATFORM_TOP + 0.004, cz); platformDots.mesh.scale.set(sx, sz, 1)
      strata.forEach((line, index) => {
        const grow = (index + 1) * 0.9
        line.position.set(cx, -0.42 - index * 0.32, cz); line.scale.set(sx + grow * 2, 0.0001, sz + grow * 2)
      })
      floor.center.set(cx, 0, cz); floor.setRadius(Math.max(110, Math.max(sx, sz) * 2.2))
      sun.position.set(cx - sx * 0.6 - 20, 60, cz + sz * 0.3 + 18); sun.target.position.set(cx, 0, cz)
      const extent = Math.max(sx, sz) * 0.75 + 12
      Object.assign(sun.shadow.camera, { left: -extent, right: extent, top: extent, bottom: -extent, near: 1, far: 220 })
      sun.shadow.camera.updateProjectionMatrix()
      const tallest = Math.max(4, data.maxHeight, ...data.columns.map(column => column.height))
      bounds.set(new Vector3(minX, 0, minZ), new Vector3(maxX, tallest + 2, maxZ))
    }

    const updateLinks = (): void => {
      const nodes: RouteNode[] = [
        ...data.columns.map(column => ({ id: column.id as string, cell: column.cell, half: COLUMN_HALF })),
        ...data.terminals.map(terminal => ({ id: terminal.id, cell: terminal.cell, half: TERMINAL_HALF })),
      ]
      const retained = new Set(data.links.map(link => link.id))
      for (const [id, link] of links) {
        if (retained.has(id)) continue
        for (const line of link.lines) { stage.remove(line); line.geometry.dispose() }
        links.delete(id)
      }
      data.links.forEach((link, index) => {
        const key = `${link.from}>${link.to}:${link.kind}:${String(link.flowing)}:${index}:${nodes.map(node => `${node.id}@${node.cell.i},${node.cell.j}`).join('|')}`
        const previous = links.get(link.id)
        if (previous?.key === key) return
        if (previous !== undefined) for (const line of previous.lines) { stage.remove(line); line.geometry.dispose() }
        const route = routeLink(nodes, link.from, link.to, ((index % 5) - 2) * 0.42)
        if (route === null) { links.delete(link.id); return }
        const material = link.kind === 'dependency' ? materials.dependency : link.kind === 'lease' ? materials.lease
          : link.flowing ? materials.messageFlow : materials.message
        const lengths = [0]
        for (let k = 1; k < route.length; k++) {
          const point = route[k], previous = route[k - 1], distance = lengths[k - 1]
          if (point === undefined || previous === undefined || distance === undefined) continue
          lengths.push(distance + Math.hypot(point.x - previous.x, point.z - previous.z))
        }
        const total = lengths[lengths.length - 1] || 1
        const lines: Line[] = []
        const strands = link.kind === 'message' ? BUNDLE : 3
        for (let strand = 0; strand < strands; strand++) {
          const spread = (strand / (strands - 1) - 0.5) * (link.kind === 'message' ? 0.5 : 0.22)
          const points: number[] = []
          route.forEach((point, k) => {
            const a = route[Math.max(0, k - 1)], b = route[Math.min(route.length - 1, k + 1)], along = lengths[k]
            if (a === undefined || b === undefined || along === undefined) return
            const tangent = Math.hypot(b.x - a.x, b.z - a.z) || 1
            const envelope = Math.sin(Math.PI * along / total) ** 0.7
            const offset = spread * envelope
            points.push(point.x - (b.z - a.z) / tangent * offset, PLATFORM_TOP + 0.02 + strand * 0.0015,
              point.z + (b.x - a.x) / tangent * offset)
          })
          const line = flowLine(points, material)
          line.renderOrder = 2
          stage.add(line); lines.push(line)
        }
        links.set(link.id, { key, lines, flowing: link.flowing })
      })
    }

    const measure = (): void => {
      const rect = host.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0 || disposed) return
      width = rect.width; height = rect.height
      renderer.setSize(width, height, false)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
      autoFit()
    }
    const observer = new ResizeObserver(measure)
    observer.observe(host)
    owner.defer(() => { observer.disconnect() })

    const raycaster = new Raycaster()
    const pick = (event: PointerEvent): ClusterTaskId | null => {
      const rect = canvas.getBoundingClientRect()
      const pointer = new Vector2((event.clientX - rect.left) / rect.width * 2 - 1,
        -(event.clientY - rect.top) / rect.height * 2 + 1)
      raycaster.setFromCamera(pointer, camera)
      const hit = raycaster.intersectObjects([...columns.values()].map(column => column.shaft), false)[0]
      if (hit === undefined) return null
      const found = [...columns].find(([, column]) => column.shaft === hit.object)
      return found?.[0] ?? null
    }
    const setHover = (id: ClusterTaskId | null): void => {
      if (id === hovered) return
      hovered = id
      canvas.style.cursor = id === null ? '' : 'pointer'
      for (const column of columns.values()) column.shaft.material = shaftMaterial(column.data)
      events.hover(id)
      wake()
    }
    const pointers = new Set<number>()
    let press: { x: number; y: number; moved: boolean } | null = null
    const down = (event: PointerEvent): void => {
      pointers.add(event.pointerId)
      press = pointers.size === 1 && event.button === 0 ? { x: event.clientX, y: event.clientY, moved: false } : null
    }
    const move = (event: PointerEvent): void => {
      if (press !== null && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 4) press.moved = true
      if (pointers.size === 0 && event.pointerType === 'mouse') setHover(pick(event))
    }
    const up = (event: PointerEvent): void => {
      pointers.delete(event.pointerId)
      const click = press
      press = null
      if (click === null || click.moved || pointers.size > 0) return
      const id = pick(event)
      if (id !== null) events.select(id)
    }
    const cancel = (event: PointerEvent): void => { pointers.delete(event.pointerId); press = null }
    const leave = (): void => { setHover(null) }
    const lost = (event: Event): void => { event.preventDefault(); dispose(); events.fail() }
    canvas.addEventListener('pointerdown', down)
    canvas.addEventListener('pointermove', move)
    canvas.addEventListener('pointerup', up)
    canvas.addEventListener('pointercancel', cancel)
    canvas.addEventListener('pointerleave', leave)
    canvas.addEventListener('webglcontextlost', lost)
    owner.defer(() => {
      canvas.removeEventListener('pointerdown', down); canvas.removeEventListener('pointermove', move)
      canvas.removeEventListener('pointerup', up); canvas.removeEventListener('pointercancel', cancel)
      canvas.removeEventListener('pointerleave', leave); canvas.removeEventListener('webglcontextlost', lost)
    })

    measure()
    renderer.render(scene, camera)
    return {
      update(value) {
        if (disposed) return
        data = value
        received = true
        const retained = new Set(value.columns.map(column => column.id))
        for (const [id, column] of columns) if (!retained.has(id)) { stage.remove(column.group); columns.delete(id) }
        value.columns.forEach((column) => {
          let objects = columns.get(column.id)
          if (objects === undefined) {
            const group = new Group()
            const plinth = new Mesh(unitBox, plinthMaterial)
            plinth.scale.set(3.1, 0.08, 3.1); plinth.receiveShadow = true
            const shaft = new Mesh(unitBox, shaftMaterial(column))
            shaft.scale.set(COLUMN_HALF * 2, 0.05, COLUMN_HALF * 2); shaft.position.y = 0.08
            shaft.castShadow = true; shaft.receiveShadow = true
            const lift = new Group()
            lift.position.y = 0.08
            shaft.position.y = 0
            lift.add(shaft)
            group.add(plinth, lift)
            stage.add(group)
            objects = { group, shaft, height: spring(0.05, 7.5, 0.004), data: column }
            columns.set(column.id, objects)
          }
          const center = cellCenter(column.cell)
          objects.group.position.set(center.x, PLATFORM_TOP, center.z)
          objects.height.to = column.height
          objects.shaft.material = shaftMaterial(column)
          objects.data = column
        })
        const retainedTerminals = new Set(value.terminals.map(terminal => terminal.id))
        for (const [id, marker] of terminals) if (!retainedTerminals.has(id)) { stage.remove(marker); terminals.delete(id) }
        for (const terminal of value.terminals) {
          let marker = terminals.get(terminal.id)
          if (marker === undefined) {
            marker = new Mesh(unitBox, terminalMaterial)
            marker.scale.set(TERMINAL_HALF * 2, 1.2, TERMINAL_HALF * 2); marker.castShadow = true
            terminals.set(terminal.id, marker); stage.add(marker)
          }
          const center = cellCenter(terminal.cell)
          marker.position.set(center.x, PLATFORM_TOP, center.z)
        }
        layoutStage()
        updateLinks()
        autoFit()
      },
      focus(id) {
        const column = columns.get(id)
        if (column === undefined || disposed) return
        const target = column.group.position.clone().setY(PLATFORM_TOP + column.height.to * 0.45)
        const direction = camera.position.clone().sub(controls.target).normalize()
        startTween(target, target.clone().add(direction.multiplyScalar(Math.max(26, column.height.to * 3))), 1000)
      },
      reset() { if (!disposed) fit(false) },
      mode(value) { controls.mouseButtons.LEFT = value === 'pan' ? MOUSE.PAN : MOUSE.ROTATE; controls.touches.ONE = value === 'pan' ? TOUCH.PAN : TOUCH.ROTATE },
      pan(x, y) { if (!disposed) { tween = null; controls.pan(x, y); wake() } },
      orbit(x, y) { if (!disposed) { tween = null; controls.rotateLeft(x); controls.rotateUp(y); wake() } },
      zoom(factor) { if (!disposed) { tween = null; controls.dollyIn(factor); wake() } },
      active(on) { isActive = on; if (on) { measure(); wake() } else clock.stop() },
      dispose,
    }
  } catch (error) { dispose(); throw error }
}
