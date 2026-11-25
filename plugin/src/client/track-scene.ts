/**
 * The track view: one ground track per worker, with a glossy column at the left edge, a token-rate ribbon over a
 * vertex-alpha fill, patterned activity clips like an editing timeline, and recorded connectors passing beneath the
 * tracks. A world clipping plane at the frame top hides only content above the frame, so rows stay drawn while
 * scrolling. The time window is the only moving camera state; geometry is rewritten in place while the window or a
 * live clip moves.
 */
import {
  BoxGeometry, BufferAttribute, BufferGeometry, Color, DirectionalLight, DynamicDrawUsage, EdgesGeometry, Float32BufferAttribute,
  HemisphereLight, InstancedBufferAttribute, InstancedMesh, Line, LineBasicMaterial, LineSegments, Matrix4, Mesh, MeshBasicMaterial,
  type MeshPhysicalMaterial, MeshStandardMaterial, PerspectiveCamera, PlaneGeometry, Plane, Raycaster, Scene, Vector2, Vector3,
} from 'three'
import type { ClusterTaskId } from '../dashboard-types.ts'
import type { ColumnState } from './ground-scene.ts'
import { frameClock, reducedMotion, spring, stepSpring } from './motion.ts'
import { createRenderer, dottedFloor, flowMaterial, flowRibbon, glossMaterial, Owner, readPalette, studioEnvironment } from './scene-kit.ts'
import {
  averageRate, CONTROLLER_LANE, type ClipKind, type RatePoint, type TrackClip, type TrackConnector, type TrackMark,
} from './track-model.ts'

/** World length of the visible time window along x. */
export const TRACK_LENGTH = 64
/** Distance between neighboring tracks along z. */
export const ROW = 4.2
/** Shortest selectable time window in milliseconds. */
export const TRACK_SPAN_MIN = 5_000
/** Longest selectable time window in milliseconds: seven days. */
export const TRACK_SPAN_MAX = 7 * 24 * 3_600_000
/** Texture pattern of an activity clip, drawn by the clip shader from the `clipPattern` instance attribute. */
export type ClipPattern = 'solid' | 'stripes' | 'hatch' | 'dots' | 'bars'
/** Pattern drawn on each clip kind. */
export const CLIP_PATTERNS: Readonly<Record<ClipKind, ClipPattern>> = {
  thinking: 'solid', command: 'solid', tool: 'stripes', read: 'dots', write: 'hatch',
  starting: 'bars', waiting: 'stripes', queued: 'dots', idle: 'solid',
}
/** Shader id of each clip pattern; the value stored in the `clipPattern` instance attribute. */
const CLIP_PATTERN_IDS: Readonly<Record<ClipPattern, number>> = { solid: 0, stripes: 1, hatch: 2, dots: 3, bars: 4 }
/** Render interval while only the playhead moves, so an idle view keeps its clock current at a low frame rate. */
const PLAYHEAD_FRAME_MS = 100
const STRIP_TOP = -1.75, STRIP_BOTTOM = 1.55, RATE_BASE = -0.2, RATE_DEPTH = 1.35, CLIP_TOP = 0.15, CLIP_DEPTH = 1.1
const COLUMN_X = -3.4, COLUMN_HALF = 0.85
const RIBBON_WIDTH = 0.12, RIBBON_Y = 0.02
const LINK_Y = -0.3, MESSAGE_WIDTH = 0.14, DEPENDENCY_WIDTH = 0.09
const BUCKETS = 240, CURVE_POINTS = 28
const TILT = 0.98

/** One worker track. */
export interface TrackSceneRow {
  readonly id: ClusterTaskId
  readonly height: number
  readonly state: ColumnState
  readonly selected: boolean
  readonly clips: readonly TrackClip[]
  readonly marks: readonly TrackMark[]
  readonly rate: readonly RatePoint[]
}
/** Everything the track view draws. */
export interface TrackSceneData {
  readonly rows: readonly TrackSceneRow[]
  readonly connectors: readonly TrackConnector[]
  readonly ceiling: number
  readonly start: number
  readonly end: number
  readonly live: boolean
  /** Identity of the displayed run selection; the window refits when it changes. */
  readonly selection: string
}
/** Screen anchor of a track header, a time tick, a connector, or the playhead. */
export interface TrackAnchor { readonly id: string; readonly x: number; readonly y: number; readonly visible: boolean }
/** CSS pixels the camera fit leaves free on each side of the host. */
export interface TrackInset { readonly top: number; readonly right: number; readonly bottom: number; readonly left: number }
/** Visible time window. */
export interface TrackWindow {
  readonly start: number
  readonly end: number
  readonly follow: boolean
  readonly step: number
  /** Window length in milliseconds. */
  readonly span: number
}
/** Scene callbacks. */
export interface TrackEvents {
  select(this: void, id: ClusterTaskId): void
  hover(this: void, id: ClusterTaskId | null): void
  project(this: void, anchors: readonly TrackAnchor[], window: TrackWindow): void
  fail(this: void): void
}
/** Window controls and lifetime. */
export interface TrackScene {
  /** Replace the drawn data. @param data - rows, connectors, and observed time extent. */
  update(this: void, data: TrackSceneData): void
  /** Show the whole recorded extent; a live run keeps following now and growing to cover the run, an empty view follows now. */
  fit(this: void): void
  /** Keep the window's right edge at the current time, with or without workers; the span is unchanged. */
  follow(this: void): void
  /** Keep the tracks clear of overlaid controls. @param edges - CSS pixels reserved on each side of the host. */
  inset(this: void, edges: TrackInset): void
  /** Zoom time around a screen x. @param factor - span divisor. @param at - fraction of the host width; centered when omitted. */
  zoom(this: void, factor: number, at?: number): void
  /**
   * Set the window length around the window center; live following keeps the live edge.
   * @param span - target length in milliseconds, clamped to the span range.
   */
  span(this: void, span: number): void
  /** Shift the window. @param fraction - window widths; positive moves later. */
  pan(this: void, fraction: number): void
  /** Scroll tracks. @param rows - track pitches; positive moves down. */
  scroll(this: void, rows: number): void
  /** Scroll one track into view; outside live following, also move the window onto its clips. @param id - worker task id. */
  reveal(this: void, id: ClusterTaskId): void
  /** Pause or resume rendering. @param on - whether the view is visible. */
  active(this: void, on: boolean): void
  /** Release every resource. */
  dispose(this: void): void
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value))

/**
 * Slider position of a time span.
 * @param span - window length in milliseconds; clamped to the span range.
 * @returns 0 at the longest span and 1 at the shortest.
 */
export function zoomPosition(span: number): number {
  const clamped = Math.min(TRACK_SPAN_MAX, Math.max(TRACK_SPAN_MIN, span))
  return 1 - Math.log(clamped / TRACK_SPAN_MIN) / Math.log(TRACK_SPAN_MAX / TRACK_SPAN_MIN)
}

/**
 * Time span of a slider position.
 * @param position - slider position; clamped to 0..1.
 * @returns the window length in milliseconds.
 */
export function zoomSpan(position: number): number {
  return TRACK_SPAN_MIN * (TRACK_SPAN_MAX / TRACK_SPAN_MIN) ** (1 - clamp01(position))
}

/**
 * A readable tick step for a time span.
 * @param span - window length in milliseconds.
 * @returns the step between labeled ticks in milliseconds.
 */
export function tickStep(span: number): number {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400, 21600, 43200, 86400].map(s => s * 1000)
  return steps.find(step => span / step <= 8) ?? 86_400_000
}

/** World position of one sampled connector point; connectors stay flat at the link height. */
interface LinkSample { readonly x: number; readonly z: number }

/**
 * Mount the track view.
 * @param host - measured container carrying the `--cluster-*` palette.
 * @param events - selection, hover, projection, and failure callbacks.
 * @returns the disposable scene; throws when WebGL cannot initialize.
 */
export function createTrackScene(host: HTMLElement, events: TrackEvents): TrackScene {
  const owner = new Owner()
  let disposed = false
  const dispose = (): void => { if (!disposed) { disposed = true; owner.dispose() } }
  try {
    const renderer = createRenderer(host, owner)
    const canvas = renderer.domElement
    const topClip = new Plane(new Vector3(0, 0, 1), 0)
    renderer.clippingPlanes = [topClip]
    const palette = readPalette(host)
    const scene = new Scene()
    scene.background = palette.bg
    scene.environment = studioEnvironment(renderer, owner)
    scene.environmentIntensity = 0.5
    owner.defer(() => { scene.clear() })
    const camera = new PerspectiveCamera(22, 1, 1, 2000)
    const sun = new DirectionalLight(0xffffff, 2.2)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    sun.shadow.bias = -0.0004
    sun.shadow.normalBias = 0.02
    scene.add(sun, sun.target, new HemisphereLight(0xffffff, 0x2a2a28, 0.5))
    const floor = dottedFloor(palette, owner, { spacing: 1.1, opacity: 0.45 })
    floor.mesh.position.y = -0.6
    scene.add(floor.mesh)

    const unitBox = owner.own(new BoxGeometry(1, 1, 1).translate(0.5, 0.5, 0.5))
    const columnBox = owner.own(new BoxGeometry(1, 1, 1).translate(0, 0.5, 0))
    const unitPlane = owner.own(new PlaneGeometry(1, 1).rotateX(-Math.PI / 2).translate(0.5, 0, 0.5))
    const planeEdges = owner.own(new EdgesGeometry(owner.own(new BoxGeometry(1, 0.0001, 1).translate(0.5, 0, 0.5))))
    const stripMaterial = owner.own(new MeshStandardMaterial({ color: palette.panel, roughness: 0.95 }))
    const stripSelected = owner.own(new MeshStandardMaterial({ color: palette.case, roughness: 0.95 }))
    const stripEdge = owner.own(new LineBasicMaterial({ color: palette.hair }))
    const stripEdgeSelected = owner.own(new LineBasicMaterial({ color: palette.accent }))
    const divider = owner.own(new LineBasicMaterial({ color: palette.lineFaint }))
    const columnMaterials: Record<ColumnState, MeshPhysicalMaterial> = {
      running: owner.own(glossMaterial(palette.concrete, 0.34)),
      waiting: owner.own(glossMaterial(palette.concrete.clone().lerp(palette.lineDim, 0.25), 0.1)),
      idle: owner.own(glossMaterial(palette.concrete, 0.12)),
      done: owner.own(glossMaterial(palette.concrete, 0.18)),
      failed: owner.own(glossMaterial(palette.caseHi.clone().lerp(palette.concrete, 0.35), 0.04)),
    }
    const columnSelected = owner.own(glossMaterial(palette.concrete, 0.5))
    const computed = getComputedStyle(host)
    const clipColor = (kind: ClipKind): Color => {
      const value = computed.getPropertyValue(`--cluster-clip-${kind}`).trim()
      return value === '' ? palette.fg : new Color(value)
    }
    const clipColors: Record<ClipKind, Color> = {
      thinking: clipColor('thinking'), command: clipColor('command'), tool: clipColor('tool'), read: clipColor('read'),
      write: clipColor('write'), starting: clipColor('starting'), waiting: clipColor('waiting'), queued: clipColor('queued'),
      idle: clipColor('idle'),
    }
    const clipHeights: Record<ClipKind, number> = {
      thinking: 0.22, command: 0.3, tool: 0.26, read: 0.18, write: 0.2, starting: 0.12, queued: 0.05, waiting: 0.07, idle: 0.04,
    }
    const clipMaterial = owner.own(new MeshStandardMaterial({ color: 0xffffff, roughness: 0.62, metalness: 0 }))
    clipMaterial.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>',
          '#include <common>\nattribute float clipPattern; varying float vClipPattern; varying vec3 vClipLocal;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          vClipPattern = clipPattern;
          #ifdef USE_INSTANCING
            vClipLocal = position * vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
          #else
            vClipLocal = position;
          #endif`)
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          varying float vClipPattern; varying vec3 vClipLocal;
          float dcBand(float v, float period) { float f = fract(v / period); float w = fwidth(v / period); return smoothstep(0.5 - w, 0.5 + w, f); }`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          vec2 dcP = vClipLocal.xz; float dcMask = 0.0;
          if (vClipPattern > 0.5 && vClipPattern < 1.5) dcMask = dcBand(dcP.x + dcP.y, 0.42);
          else if (vClipPattern > 1.5 && vClipPattern < 2.5) dcMask = max(dcBand(dcP.x + dcP.y, 0.5), dcBand(dcP.x - dcP.y, 0.5));
          else if (vClipPattern > 2.5 && vClipPattern < 3.5) dcMask = smoothstep(0.18, 0.24, length(fract(dcP / 0.32) - 0.5));
          else if (vClipPattern > 3.5) dcMask = dcBand(dcP.x, 0.28);
          diffuseColor.rgb *= mix(1.0, 0.42, dcMask);`)
    }
    clipMaterial.customProgramCacheKey = () => 'dc-clip'
    const makeClipGeometry = (capacity: number): { geometry: BufferGeometry; pattern: InstancedBufferAttribute } => {
      const pattern = new InstancedBufferAttribute(new Float32Array(capacity), 1).setUsage(DynamicDrawUsage)
      const geometry = unitBox.clone()
      geometry.setAttribute('clipPattern', pattern)
      return { geometry, pattern }
    }
    let clipCapacity = 512
    let clipBuffers = makeClipGeometry(clipCapacity)
    let clips = new InstancedMesh(clipBuffers.geometry, clipMaterial, clipCapacity)
    clips.instanceMatrix.setUsage(DynamicDrawUsage)
    clips.castShadow = true; clips.receiveShadow = true; clips.frustumCulled = false
    scene.add(clips)
    owner.defer(() => { clips.dispose(); clipBuffers.geometry.dispose() })
    const markMaterial = owner.own(new MeshBasicMaterial({ color: palette.accent }))
    const markFail = owner.own(new MeshBasicMaterial({ color: palette.fg }))
    const areaMaterial = owner.own(new MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }))
    const ribbonMaterial = owner.own(new MeshBasicMaterial({ color: palette.accent.clone().lerp(new Color(0xffffff), 0.12) }))
    const tickMaterial = owner.own(new LineBasicMaterial({ color: palette.hair }))
    const playheadMaterial = owner.own(new LineBasicMaterial({ color: palette.accent }))
    const time = { value: 0 }
    const linkMaterials = {
      message: owner.own(flowMaterial(palette.muted, time, { opacity: 0.9, flow: true, additive: false })),
      dependency: owner.own(flowMaterial(palette.lineDim, time, { opacity: 0.8, dash: 0.6, additive: false })),
    }

    interface RowObjects {
      strip: Mesh
      edge: LineSegments
      line: LineSegments
      column: Mesh
      height: ReturnType<typeof spring>
      area: Mesh
      ribbon: Mesh
      data: TrackSceneRow
      z: number
    }
    const rows = new Map<ClusterTaskId, RowObjects>()
    const links = new Map<string, Mesh>()
    const marks: Mesh[] = []
    owner.defer(() => {
      for (const row of rows.values()) { row.area.geometry.dispose(); row.ribbon.geometry.dispose() }
      for (const line of links.values()) line.geometry.dispose()
    })
    const ticks = new LineSegments(new BufferGeometry(), tickMaterial)
    const playhead = new Line(new BufferGeometry(), playheadMaterial)
    const controllerLine = new LineSegments(planeEdges, stripEdge)
    scene.add(ticks, playhead, controllerLine)
    owner.defer(() => { ticks.geometry.dispose(); playhead.geometry.dispose() })

    let data: TrackSceneData = { rows: [], connectors: [], ceiling: 100, start: Date.now() - 60_000, end: Date.now(), live: false, selection: '' }
    let width = 1, height = 1, isActive = true, hovered: ClusterTaskId | null = null, follow = true, fitted: string | null = null
    let clipZ = -Infinity
    /** Whether a live window keeps growing to show the whole run; set by fitting, cleared by any zoom. */
    let wholeRun = false
    let inset: TrackInset = { top: 0, right: 0, bottom: 0, left: 0 }
    const windowEnd = spring(Date.now(), 7, 20), windowSpan = spring(120_000, 7, 20), scrollZ = spring(0, 8, 0.002)
    const laneZ = (lane: string): number => lane === CONTROLLER_LANE ? -ROW * 0.8 : rows.get(lane as ClusterTaskId)?.z ?? 0
    const linkZ = (lane: TrackConnector['from']): number => laneZ(lane) + CLIP_TOP + CLIP_DEPTH / 2
    const now = (): number => Date.now()
    const toX = (t: number): number => (t - (windowEnd.x - windowSpan.x)) / windowSpan.x * TRACK_LENGTH
    const clampX = (x: number): number => Math.min(TRACK_LENGTH, Math.max(0, x))

    let fitRows = 4
    const visibleCount = (): number => Math.max(1, Math.min(rows.size, fitRows))
    const target = new Vector3(), corner = new Vector3()
    const placeCamera = (): void => {
      for (let attempt = 0; attempt < 4; attempt++) {
        const visibleRows = visibleCount()
        const { widthRatio, heightRatio } = frameRows(visibleRows)
        if (widthRatio < 0.97 && visibleRows > 1) fitRows = visibleRows - 1
        else if (heightRatio < visibleRows / (visibleRows + 1) * 0.98 && visibleRows < rows.size) fitRows = visibleRows + 1
        else break
      }
    }
    const frameRows = (visibleRows: number): { widthRatio: number; heightRatio: number } => {
      const count = Math.max(1, rows.size)
      const maxScroll = Math.max(0, (count - visibleRows) * ROW)
      scrollZ.to = Math.min(maxScroll, Math.max(0, scrollZ.to))
      const x0 = COLUMN_X - COLUMN_HALF - 0.6, x1 = TRACK_LENGTH + 0.6
      const lead = controllerLine.visible ? Math.max(0, ROW * 0.8 + 0.6 - scrollZ.x) : 0
      const z0 = scrollZ.x - lead + STRIP_TOP - 1.6
      clipZ = z0 - 0.1
      topClip.constant = -clipZ
      const z1 = scrollZ.x + (visibleRows - 1) * ROW + STRIP_BOTTOM + 0.3
      target.set((x0 + x1) / 2, 0, (z0 + z1) / 2)
      camera.aspect = width / height
      camera.clearViewOffset()
      const safeWidth = Math.max(0.2, 2 - 2 * (inset.left + inset.right) / width)
      const safeHeight = Math.max(0.2, 2 - 2 * (inset.top + inset.bottom) / height)
      let distance = (x1 - x0) / (2 * Math.tan(camera.fov / 2 * Math.PI / 180) * camera.aspect) * 1.2
      let box = { left: -1, right: 1, bottom: -1, top: 1 }
      for (let pass = 0; pass < 6; pass++) {
        camera.position.set(target.x, Math.sin(TILT) * distance, target.z + Math.cos(TILT) * distance)
        camera.lookAt(target)
        camera.updateProjectionMatrix(); camera.updateMatrixWorld()
        box = { left: Infinity, right: -Infinity, bottom: Infinity, top: -Infinity }
        for (const [x, z] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]] as const) {
          corner.set(x, 0, z).project(camera)
          box = { left: Math.min(box.left, corner.x), right: Math.max(box.right, corner.x),
            bottom: Math.min(box.bottom, corner.y), top: Math.max(box.top, corner.y) }
        }
        if (pass < 5) distance *= Math.max((box.right - box.left) / safeWidth, (box.top - box.bottom) / safeHeight)
      }
      const centerX = -1 + (inset.left + (width - inset.left - inset.right) / 2) / width * 2
      const safeTop = 1 - inset.top / height * 2
      camera.setViewOffset(width, height, ((box.left + box.right) / 2 - centerX) * width / 2,
        (safeTop - box.top) * height / 2, width, height)
      camera.updateProjectionMatrix()
      sun.position.set(target.x - 30, 50, target.z + 30); sun.target.position.copy(target)
      const extent = TRACK_LENGTH * 0.7 + visibleRows * ROW
      Object.assign(sun.shadow.camera, { left: -extent, right: extent, top: extent, bottom: -extent, near: 1, far: 220 })
      sun.shadow.camera.updateProjectionMatrix()
      floor.center.copy(target); floor.setRadius(Math.max(120, TRACK_LENGTH * 1.6))
      return { widthRatio: (box.right - box.left) / safeWidth, heightRatio: (box.top - box.bottom) / safeHeight }
    }

    const matrix = new Matrix4()
    const writeClips = (t: number): void => {
      let count = 0
      let total = 0
      for (const objects of rows.values()) total += objects.data.clips.length
      if (total > clipCapacity) {
        scene.remove(clips); clips.dispose(); clipBuffers.geometry.dispose()
        clipCapacity = Math.max(total, clipCapacity * 2)
        clipBuffers = makeClipGeometry(clipCapacity)
        clips = new InstancedMesh(clipBuffers.geometry, clipMaterial, clipCapacity)
        clips.instanceMatrix.setUsage(DynamicDrawUsage)
        clips.castShadow = true; clips.receiveShadow = true; clips.frustumCulled = false
        scene.add(clips)
      }
      for (const objects of rows.values()) {
        if (objects.z + STRIP_BOTTOM < clipZ) continue
        for (const clip of objects.data.clips) {
          const end = clip.open ? Math.max(clip.end, t) : clip.end
          const x0 = clampX(toX(clip.start)), x1 = clampX(toX(end))
          if (x1 - x0 < 0.02) continue
          matrix.makeScale(x1 - x0, clipHeights[clip.kind], CLIP_DEPTH).setPosition(x0, 0.01, objects.z + CLIP_TOP)
          clips.setMatrixAt(count, matrix)
          clips.setColorAt(count, clipColors[clip.kind])
          clipBuffers.pattern.setX(count, CLIP_PATTERN_IDS[CLIP_PATTERNS[clip.kind]])
          count++
        }
      }
      clips.count = count
      clips.instanceMatrix.needsUpdate = true
      clipBuffers.pattern.needsUpdate = true
      if (clips.instanceColor !== null) clips.instanceColor.needsUpdate = true
    }

    const writeRibbon = (ribbon: BufferAttribute, index: number, before: number, z: number, after: number): void => {
      const step = TRACK_LENGTH / (BUCKETS - 1), x = index * step
      const dz = after - before
      const length = Math.hypot(step, dz)
      const offsetX = -dz / length * RIBBON_WIDTH / 2
      const offsetZ = step / length * RIBBON_WIDTH / 2
      ribbon.setXYZ(index * 2, x + offsetX, RIBBON_Y, z + offsetZ)
      ribbon.setXYZ(index * 2 + 1, x - offsetX, RIBBON_Y, z - offsetZ)
    }
    const writeCurve = (objects: RowObjects): void => {
      const series = objects.data.rate
      const area = objects.area.geometry.getAttribute('position') as BufferAttribute
      const ribbon = objects.ribbon.geometry.getAttribute('position') as BufferAttribute
      const start = windowEnd.x - windowSpan.x
      const bucketWidth = windowSpan.x / (BUCKETS - 1)
      const ceiling = Math.max(1, data.ceiling)
      let before = 0, middle = 0
      for (let b = 0; b < BUCKETS; b++) {
        const at = start + b * bucketWidth
        const value = averageRate(series, at - bucketWidth / 2, at + bucketWidth / 2)
        const x = b / (BUCKETS - 1) * TRACK_LENGTH, z = objects.z + RATE_BASE - Math.min(1, value / ceiling) * RATE_DEPTH
        area.setXYZ(b * 2, x, 0.012, objects.z + RATE_BASE); area.setXYZ(b * 2 + 1, x, 0.012, z)
        if (b > 0) writeRibbon(ribbon, b - 1, b === 1 ? middle : before, middle, z)
        before = middle; middle = z
      }
      writeRibbon(ribbon, BUCKETS - 1, middle, middle, middle)
      area.needsUpdate = true; ribbon.needsUpdate = true
    }

    const writeTicks = (): TrackAnchor[] => {
      const span = windowSpan.x, start = windowEnd.x - span, step = tickStep(span)
      const top = clipZ + 0.1 + 0.7
      const bottom = Math.max(0, rows.size - 1) * ROW + STRIP_BOTTOM
      const points: number[] = []
      const anchors: TrackAnchor[] = []
      for (let at = Math.ceil(start / step) * step; at <= windowEnd.x; at += step) {
        const x = toX(at)
        points.push(x, 0.004, top, x, 0.004, bottom)
        anchors.push(project(`tick:${String(at)}`, x, 0, top - 0.4))
      }
      ticks.geometry.dispose()
      ticks.geometry = new BufferGeometry().setAttribute('position', new Float32BufferAttribute(points, 3))
      const t = now(), x = toX(t)
      playhead.visible = x >= 0 && x <= TRACK_LENGTH
      playhead.geometry.dispose()
      playhead.geometry = new BufferGeometry().setAttribute('position', new Float32BufferAttribute([x, 0.03, top - 0.6, x, 0.03, bottom + 0.4], 3))
      if (playhead.visible) anchors.push(project('now', x, 0, top - 0.9))
      return anchors
    }

    const curveSamples = (link: TrackConnector): LinkSample[] => {
      const z0 = linkZ(link.from), z1 = linkZ(link.to)
      const x0 = toX(link.fromAt)
      const x1 = toX(link.kind === 'dependency' && link.phase === 'pending' ? Math.max(link.toAt, now()) : link.toAt)
      const samples: LinkSample[] = []
      for (let k = 0; k < CURVE_POINTS; k++) {
        const u = k / (CURVE_POINTS - 1), s = u * u * (3 - 2 * u)
        samples.push({
          x: link.kind === 'message' ? x0 + Math.sin(Math.PI * u) * 0.6 : x0 + (x1 - x0) * s,
          z: z0 + (z1 - z0) * (link.kind === 'message' ? u : s),
        })
      }
      return samples
    }
    const writeLinks = (): TrackAnchor[] => {
      const anchors: TrackAnchor[] = []
      for (const link of data.connectors) {
        const mesh = links.get(link.id)
        if (mesh === undefined) continue
        const samples = curveSamples(link)
        const inside = samples.some(sample => sample.x >= 0 && sample.x <= TRACK_LENGTH)
        mesh.visible = inside
        if (!inside) continue
        mesh.geometry.dispose()
        mesh.geometry = flowRibbon(samples.flatMap(sample => [clampX(sample.x), LINK_Y, sample.z]),
          link.kind === 'message' ? MESSAGE_WIDTH : DEPENDENCY_WIDTH)
        if (link.kind === 'message') {
          const z0 = linkZ(link.from), z1 = linkZ(link.to)
          const gapZ = laneZ(link.from) + (z1 > z0 ? (STRIP_BOTTOM + ROW + STRIP_TOP) / 2 : (STRIP_BOTTOM + STRIP_TOP - ROW) / 2)
          const nearest = samples.reduce((best, sample) => Math.abs(sample.z - gapZ) < Math.abs(best.z - gapZ) ? sample : best)
          anchors.push(project(`link:${link.id}`, nearest.x, LINK_Y, nearest.z))
        }
      }
      return anchors
    }
    const writeMarks = (): void => {
      let k = 0
      for (const objects of rows.values()) {
        if (objects.z + STRIP_BOTTOM < clipZ) continue
        for (const mark of objects.data.marks) {
          if (mark.type !== 'gate/pass' && mark.type !== 'gate/fail' && mark.type !== 'task/outcome') continue
          const x = toX(mark.at)
          if (x < 0 || x > TRACK_LENGTH) continue
          let mesh = marks[k]
          if (mesh === undefined) { mesh = new Mesh(unitBox, markMaterial); marks.push(mesh); scene.add(mesh) }
          mesh.visible = true
          mesh.material = mark.passed ? markMaterial : markFail
          mesh.scale.set(0.16, 0.5, 0.16)
          mesh.position.set(x - 0.08, 0, objects.z + CLIP_TOP + CLIP_DEPTH + 0.1)
          k++
        }
      }
      for (const mesh of marks.slice(k)) mesh.visible = false
    }

    const anchorPoint = new Vector3()
    const project = (id: string, x: number, y: number, z: number): TrackAnchor => {
      anchorPoint.set(x, y, z).project(camera)
      return { id, x: (anchorPoint.x + 1) * width / 2, y: (1 - anchorPoint.y) * height / 2,
        visible: anchorPoint.z > -1 && anchorPoint.z < 1 && Math.abs(anchorPoint.x) < 1.05 && Math.abs(anchorPoint.y) < 1.05 }
    }
    const render = (): void => {
      try {
        const t = now()
        placeCamera()
        for (const objects of rows.values()) if (objects.z + STRIP_BOTTOM >= clipZ) writeCurve(objects)
        writeClips(t)
        writeMarks()
        const anchors = [...writeTicks(), ...writeLinks()]
        for (const objects of rows.values()) {
          const anchor = project(`row:${objects.data.id}`, 0.15, 0, objects.z + STRIP_TOP + 0.1)
          anchors.push(objects.z + STRIP_TOP + 0.1 >= clipZ ? anchor : { ...anchor, visible: false })
        }
        renderer.render(scene, camera)
        events.project(anchors, {
          start: windowEnd.x - windowSpan.x, end: windowEnd.x, follow, step: tickStep(windowSpan.x), span: windowSpan.to,
        })
      } catch (_error) {
        // A renderer failure after initialization leaves the worker list usable while the user retries the view.
        dispose(); events.fail()
      }
    }
    let renderedAt = -Infinity
    const clock = frameClock((dt, at) => {
      if (disposed || !isActive) return false
      const reduce = reducedMotion()
      let moving = false
      if (follow) {
        const t = now()
        if (wholeRun && data.live) windowSpan.to = liveSpan(t)
        windowEnd.to = t + windowSpan.to * 0.06; moving = true
      }
      if (stepSpring(windowEnd, dt, reduce)) moving = true
      if (stepSpring(windowSpan, dt, reduce)) moving = true
      if (stepSpring(scrollZ, dt, reduce)) moving = true
      for (const objects of rows.values()) {
        if (stepSpring(objects.height, dt, reduce)) moving = true
        const h = Math.max(0.05, objects.height.x)
        objects.column.scale.y = h
      }
      if (!reduce && data.connectors.some(link => link.kind === 'message')) { time.value += dt; moving = moving || data.live }
      const playheadX = toX(now())
      const ticking = playheadX >= 0 && playheadX <= TRACK_LENGTH
      if (moving || !ticking || at - renderedAt >= PLAYHEAD_FRAME_MS) { render(); renderedAt = at }
      return moving || ticking
    })
    const wake = (): void => { if (!disposed && isActive) clock.wake() }
    owner.defer(() => { clock.stop() })

    const fittedSpan = (start: number, end: number): number => Math.min(TRACK_SPAN_MAX, Math.max(TRACK_SPAN_MIN, (end - start) * 1.08))
    const liveSpan = (t: number): number => fittedSpan(Math.min(data.start, t - TRACK_SPAN_MIN), t)
    const fitWindow = (): void => {
      if (data.rows.length === 0) { follow = true; wake(); return }
      const t = now()
      const start = data.live ? Math.min(data.start, t - TRACK_SPAN_MIN) : data.start
      const end = data.live ? t : Math.max(data.end, start + TRACK_SPAN_MIN)
      windowSpan.to = fittedSpan(start, end)
      windowEnd.to = end + windowSpan.to * 0.04
      follow = data.live; wholeRun = true
      wake()
    }

    const measure = (): void => {
      const rect = host.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0 || disposed) return
      width = rect.width; height = rect.height
      renderer.setSize(width, height, false)
      wake()
    }
    const observer = new ResizeObserver(measure)
    observer.observe(host)
    owner.defer(() => { observer.disconnect() })

    const raycaster = new Raycaster()
    const ground = new Plane(new Vector3(0, 1, 0), 0)
    const pointer = (event: PointerEvent | WheelEvent): Vector2 => {
      const rect = canvas.getBoundingClientRect()
      return new Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1)
    }
    const pick = (event: PointerEvent): ClusterTaskId | null => {
      raycaster.setFromCamera(pointer(event), camera)
      const candidates = [...rows.values()].flatMap(row => [row.strip, row.column])
      const hit = raycaster.intersectObjects(candidates, false).find(candidate => candidate.point.z >= clipZ)
      if (hit === undefined) return null
      const found = [...rows].find(([, row]) => row.strip === hit.object || row.column === hit.object)
      return found?.[0] ?? null
    }
    const groundX = (event: PointerEvent | WheelEvent): number | null => {
      raycaster.setFromCamera(pointer(event), camera)
      const point = raycaster.ray.intersectPlane(ground, new Vector3())
      return point === null ? null : point.x
    }
    const setHover = (id: ClusterTaskId | null): void => {
      if (id === hovered) return
      hovered = id
      canvas.style.cursor = id === null ? 'grab' : 'pointer'
      for (const [rowId, row] of rows) row.edge.material = row.data.selected ? stripEdgeSelected : rowId === id ? divider : stripEdge
      events.hover(id)
      wake()
    }
    const zoomAt = (factor: number, x: number | null): void => {
      const span = windowSpan.to, next = Math.min(TRACK_SPAN_MAX, Math.max(TRACK_SPAN_MIN, span / factor))
      const anchor = x === null ? 0.5 : Math.min(1, Math.max(0, x / TRACK_LENGTH))
      const at = windowEnd.to - span + anchor * span
      windowSpan.to = next; wholeRun = false
      windowEnd.to = at + (1 - anchor) * next
      if (factor > 1 && x !== null) follow = follow && anchor > 0.9
      wake()
    }
    const wheel = (event: WheelEvent): void => {
      event.preventDefault()
      if (event.shiftKey) { follow = false; windowEnd.to += event.deltaY / 800 * windowSpan.to; wake(); return }
      if (event.altKey) { scrollZ.to += event.deltaY / 120 * ROW; wake(); return }
      zoomAt(Math.exp(-event.deltaY * 0.0015), groundX(event))
    }
    let drag: { x: number; y: number; end: number; scroll: number; moved: boolean; id: number } | null = null
    const down = (event: PointerEvent): void => {
      if (event.button !== 0) return
      drag = { x: event.clientX, y: event.clientY, end: windowEnd.to, scroll: scrollZ.to, moved: false, id: event.pointerId }
      canvas.setPointerCapture(event.pointerId)
    }
    const move = (event: PointerEvent): void => {
      if (drag !== null && drag.id === event.pointerId) {
        const dx = event.clientX - drag.x, dy = event.clientY - drag.y
        if (!drag.moved && Math.hypot(dx, dy) > 4) { drag.moved = true; canvas.style.cursor = 'grabbing' }
        if (drag.moved) {
          follow = false
          windowEnd.to = drag.end - dx / width * windowSpan.to * 1.15
          scrollZ.to = drag.scroll - dy / height * ROW * 4
          windowEnd.x = windowEnd.to; scrollZ.x = scrollZ.to
          wake()
        }
        return
      }
      if (event.pointerType === 'mouse') setHover(pick(event))
    }
    const up = (event: PointerEvent): void => {
      const press = drag
      drag = null
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
      canvas.style.cursor = hovered === null ? 'grab' : 'pointer'
      if (press === null || press.moved) return
      const id = pick(event)
      if (id !== null) events.select(id)
    }
    const double = (): void => { fitWindow() }
    const leave = (): void => { if (drag === null) setHover(null) }
    const lost = (event: Event): void => { event.preventDefault(); dispose(); events.fail() }
    canvas.style.cursor = 'grab'
    canvas.addEventListener('wheel', wheel, { passive: false })
    canvas.addEventListener('pointerdown', down)
    canvas.addEventListener('pointermove', move)
    canvas.addEventListener('pointerup', up)
    canvas.addEventListener('pointercancel', up)
    canvas.addEventListener('pointerleave', leave)
    canvas.addEventListener('dblclick', double)
    canvas.addEventListener('webglcontextlost', lost)
    owner.defer(() => {
      canvas.removeEventListener('wheel', wheel); canvas.removeEventListener('pointerdown', down)
      canvas.removeEventListener('pointermove', move); canvas.removeEventListener('pointerup', up)
      canvas.removeEventListener('pointercancel', up); canvas.removeEventListener('pointerleave', leave)
      canvas.removeEventListener('dblclick', double); canvas.removeEventListener('webglcontextlost', lost)
    })

    const strip = (mesh: Mesh | LineSegments, z0: number, z1: number): void => {
      mesh.position.set(0, mesh instanceof Mesh ? 0 : 0.003, z0); mesh.scale.set(TRACK_LENGTH, 1, z1 - z0)
    }
    measure()
    return {
      update(value) {
        if (disposed) return
        data = value
        const retained = new Set(value.rows.map(row => row.id))
        for (const [id, objects] of rows) {
          if (retained.has(id)) continue
          scene.remove(objects.strip, objects.edge, objects.line, objects.column, objects.area, objects.ribbon)
          objects.area.geometry.dispose(); objects.ribbon.geometry.dispose()
          rows.delete(id)
        }
        value.rows.forEach((row, index) => {
          let objects = rows.get(row.id)
          if (objects === undefined) {
            const area = new Mesh(new BufferGeometry(), areaMaterial)
            const indices: number[] = []
            for (let b = 0; b < BUCKETS - 1; b++) indices.push(b * 2, b * 2 + 2, b * 2 + 1, b * 2 + 1, b * 2 + 2, b * 2 + 3)
            const color = new BufferAttribute(new Float32Array(BUCKETS * 2 * 4), 4)
            for (let b = 0; b < BUCKETS; b++) {
              color.setXYZW(b * 2, palette.accent.r, palette.accent.g, palette.accent.b, 0)
              color.setXYZW(b * 2 + 1, palette.accent.r, palette.accent.g, palette.accent.b, 0.5)
            }
            area.geometry.setAttribute('position', new BufferAttribute(new Float32Array(BUCKETS * 2 * 3), 3).setUsage(DynamicDrawUsage))
              .setAttribute('color', color).setIndex(indices)
            area.frustumCulled = false
            const ribbon = new Mesh(new BufferGeometry()
              .setAttribute('position', new BufferAttribute(new Float32Array(BUCKETS * 2 * 3), 3).setUsage(DynamicDrawUsage))
              .setIndex(indices), ribbonMaterial)
            ribbon.frustumCulled = false
            const column = new Mesh(columnBox, columnMaterials[row.state])
            column.castShadow = true; column.receiveShadow = true
            objects = {
              strip: new Mesh(unitPlane, stripMaterial), edge: new LineSegments(planeEdges, stripEdge),
              line: new LineSegments(planeEdges, divider), column, height: spring(0.05, 7.5, 0.004),
              area, ribbon, data: row, z: 0,
            }
            objects.strip.receiveShadow = true
            scene.add(objects.strip, objects.edge, objects.line, column, area, ribbon)
            rows.set(row.id, objects)
          }
          objects.data = row
          objects.z = index * ROW
          strip(objects.strip, objects.z + STRIP_TOP, objects.z + STRIP_BOTTOM)
          strip(objects.edge, objects.z + STRIP_TOP, objects.z + STRIP_BOTTOM)
          objects.line.position.set(0, 0.004, objects.z + (RATE_BASE + CLIP_TOP) / 2); objects.line.scale.set(TRACK_LENGTH, 1, 0.0001)
          objects.strip.material = row.selected ? stripSelected : stripMaterial
          objects.edge.material = row.selected ? stripEdgeSelected : row.id === hovered ? divider : stripEdge
          objects.column.position.set(COLUMN_X, 0, objects.z); objects.column.scale.set(COLUMN_HALF * 2, 1, COLUMN_HALF * 2)
          objects.column.material = row.selected ? columnSelected : columnMaterials[row.state]
          objects.height.to = row.height
        })
        const hasController = value.connectors.some(link => link.from === CONTROLLER_LANE)
        controllerLine.visible = hasController
        controllerLine.position.set(0, 0.003, -ROW * 0.8 - 0.3); controllerLine.scale.set(TRACK_LENGTH, 1, 0.6)
        const keep = new Set(value.connectors.map(link => link.id))
        for (const [id, line] of links) if (!keep.has(id)) { scene.remove(line); line.geometry.dispose(); links.delete(id) }
        for (const link of value.connectors) {
          if (links.has(link.id)) continue
          const mesh = new Mesh(new BufferGeometry(), link.kind === 'message' ? linkMaterials.message : linkMaterials.dependency)
          mesh.frustumCulled = false
          links.set(link.id, mesh); scene.add(mesh)
        }
        if (value.rows.length > 0 && fitted !== value.selection) { fitted = value.selection; scrollZ.to = 0; fitWindow() }
        wake()
      },
      fit: fitWindow,
      follow() { follow = true; wake() },
      inset(edges) { inset = edges; wake() },
      zoom(factor, at) { zoomAt(factor, at === undefined ? null : at * TRACK_LENGTH) },
      span(value) {
        const clamped = Math.min(TRACK_SPAN_MAX, Math.max(TRACK_SPAN_MIN, value))
        zoomAt(windowSpan.to / clamped, null)
      },
      pan(fraction) { follow = false; windowEnd.to += fraction * windowSpan.to; wake() },
      scroll(count) { scrollZ.to += count * ROW; wake() },
      reveal(id) {
        const objects = rows.get(id)
        if (objects === undefined) return
        const visibleRows = visibleCount()
        if (objects.z < scrollZ.to || objects.z > scrollZ.to + (visibleRows - 1) * ROW) {
          scrollZ.to = objects.z - Math.floor(visibleRows / 2) * ROW
        }
        const clipsOf = objects.data.clips
        if (clipsOf.length > 0 && !(follow && data.live)) {
          const t = now()
          const start = Math.min(...clipsOf.map(clip => clip.start))
          const end = Math.max(...clipsOf.map(clip => clip.open ? Math.max(clip.end, t) : clip.end))
          if (end < windowEnd.to - windowSpan.to || start > windowEnd.to) {
            follow = false
            windowSpan.to = Math.min(TRACK_SPAN_MAX, Math.max(TRACK_SPAN_MIN, (end - start) * 1.3))
            windowEnd.to = end + windowSpan.to * 0.12
          }
        }
        wake()
      },
      active(on) { isActive = on; if (on) { measure(); wake() } else clock.stop() },
      dispose,
    }
  } catch (error) { dispose(); throw error }
}
