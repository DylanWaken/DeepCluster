/** Shared WebGL setup for the control-room scenes: renderer, palette, concrete, dotted ground, and flowing lines. */
import {
  AdditiveBlending, BufferGeometry, Color, Float32BufferAttribute, Line, Mesh, MeshPhysicalMaterial,
  MeshStandardMaterial, NeutralToneMapping, NormalBlending, PCFShadowMap, PlaneGeometry, PMREMGenerator, ShaderMaterial,
  SRGBColorSpace, type Texture, Vector3, WebGLRenderer,
} from 'three'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'

/** Scene colors read from the host's CSS custom properties, so CSS owns the palette. */
export interface ScenePalette {
  readonly bg: Color
  readonly fg: Color
  readonly fgSoft: Color
  readonly muted: Color
  readonly lineDim: Color
  readonly lineFaint: Color
  readonly hair: Color
  readonly panel: Color
  readonly case: Color
  readonly caseHi: Color
  readonly accent: Color
  readonly concrete: Color
}

/**
 * Read the scene palette from `--cluster-*` custom properties on the host.
 * @param host - element inside the themed page.
 * @returns linear-space colors for materials.
 */
export function readPalette(host: HTMLElement): ScenePalette {
  const style = getComputedStyle(host)
  const color = (name: string): Color => new Color(style.getPropertyValue(`--cluster-${name}`).trim() || '#808080')
  return {
    bg: color('bg'), fg: color('fg'), fgSoft: color('fg-soft'), muted: color('muted'), lineDim: color('line-dim'),
    lineFaint: color('line-faint'), hair: color('hair'), panel: color('panel'), case: color('case'), caseHi: color('case-hi'),
    accent: color('accent'), concrete: color('concrete'),
  }
}

/** Resources released in reverse registration order when a scene is disposed. */
export class Owner {
  readonly #cleanup: (() => void)[] = []
  /**
   * Register a resource with a `dispose` method.
   * @param resource - geometry, material, texture, or controls.
   * @returns the same resource.
   */
  own<T extends { dispose(): void }>(resource: T): T { this.#cleanup.push(() => { resource.dispose() }); return resource }
  /** Register an arbitrary release step. @param release - idempotent cleanup. */
  defer(release: () => void): void { this.#cleanup.push(release) }
  /** Run every release step once, newest first. */
  dispose(): void { for (const release of this.#cleanup.splice(0).reverse()) release() }
}

/**
 * Create the shared renderer configuration and attach its canvas.
 * @param host - measured container.
 * @param owner - receives renderer disposal and context release.
 * @returns a renderer with shadows, sRGB output, and neutral tone mapping.
 */
export function createRenderer(host: HTMLElement, owner: Owner): WebGLRenderer {
  const renderer = new WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' })
  owner.defer(() => { renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove() })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.outputColorSpace = SRGBColorSpace
  renderer.toneMapping = NeutralToneMapping
  renderer.toneMappingExposure = 1.05
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = PCFShadowMap
  renderer.domElement.setAttribute('aria-hidden', 'true')
  host.append(renderer.domElement)
  return renderer
}

/**
 * Prefiltered studio environment for physically based reflections.
 * @param renderer - renderer that owns the PMREM targets.
 * @param owner - receives the environment texture.
 * @returns the environment map.
 */
export function studioEnvironment(renderer: WebGLRenderer, owner: Owner): Texture {
  const generator = new PMREMGenerator(renderer)
  const room = new RoomEnvironment()
  const target = generator.fromScene(room, 0.04)
  room.dispose(); generator.dispose()
  return owner.own(target.texture)
}

const NOISE = /* glsl */ `
float dcHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float dcNoise(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(dcHash(i), dcHash(i + vec3(1,0,0)), f.x), mix(dcHash(i + vec3(0,1,0)), dcHash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(dcHash(i + vec3(0,0,1)), dcHash(i + vec3(1,0,1)), f.x), mix(dcHash(i + vec3(0,1,1)), dcHash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float dcFbm(vec3 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { v += a * dcNoise(p); p *= 2.03; a *= 0.5; } return v; }
`

/**
 * Cast-concrete PBR material; variation is computed in world space, so scaled columns never stretch it.
 * @param color - base albedo.
 * @param roughness - base roughness before variation.
 * @returns a standard material with procedural albedo, pits, and roughness variation.
 */
export function concreteMaterial(color: Color, roughness = 0.86): MeshStandardMaterial {
  const material = new MeshStandardMaterial({ color, roughness, metalness: 0 })
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vConcrete;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvConcrete = (modelMatrix * vec4(transformed, 1.0)).xyz;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vConcrete;\n${NOISE}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float dcGrain = dcFbm(vConcrete * 2.6);
        float dcPits = smoothstep(0.80, 0.93, dcNoise(vConcrete * 15.0));
        float dcStain = dcFbm(vConcrete * 0.32 + 7.1);
        diffuseColor.rgb *= 0.9 + 0.13 * dcGrain - 0.22 * dcPits - 0.07 * dcStain;`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = clamp(roughnessFactor + 0.14 * (dcGrain - 0.5) + 0.1 * dcPits, 0.0, 1.0);`)
  }
  material.customProgramCacheKey = () => 'dc-concrete'
  return material
}

/**
 * Glossy white column material with a lit interior and bright edges; it assumes geometry whose local bounds are x and z
 * in [-0.5, 0.5] and y in [0, 1] (the column boxes in both scenes), with any scale.
 * @param color - base albedo and sheen color.
 * @param interior - strength of the lit interior fill.
 * @returns a physical material whose shader adds an interior glow and rim light.
 */
export function glossMaterial(color: Color, interior = 0.16): MeshPhysicalMaterial {
  const material = new MeshPhysicalMaterial({
    color: color.clone().multiplyScalar(0.84), roughness: 0.08, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.03,
    sheen: 0.25, sheenColor: color, sheenRoughness: 0.4, envMapIntensity: 1.6,
  })
  material.onBeforeCompile = (shader) => {
    shader.uniforms.dcInterior = { value: interior }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vDcLocal;\nvarying vec3 vDcScale;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
      vDcLocal = position;
      vDcScale = vec3(length(modelMatrix[0].xyz), length(modelMatrix[1].xyz), length(modelMatrix[2].xyz));`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float dcInterior;\nvarying vec3 vDcLocal;\nvarying vec3 vDcScale;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
      vec3 dcD = min(vDcLocal - vec3(-0.5, 0.0, -0.5), vec3(0.5, 1.0, 0.5) - vDcLocal) * vDcScale;
      float dcEdge = dcD.x + dcD.y + dcD.z - min(dcD.x, min(dcD.y, dcD.z)) - max(dcD.x, max(dcD.y, dcD.z));
      float dcRim = 1.0 - smoothstep(0.0, 0.05, dcEdge);
      float dcGlow = 0.3 + 0.7 * smoothstep(0.0, 1.0, vDcLocal.y);
      float dcFacing = abs(dot(normal, normalize(vViewPosition)));
      totalEmissiveRadiance += diffuseColor.rgb * (dcInterior * dcGlow * mix(0.4, 1.0, dcFacing) + dcRim * 0.3);`)
  }
  material.customProgramCacheKey = () => 'dc-gloss'
  return material
}

/** Uniforms of a dotted floor that callers may move with the content. */
export interface DottedFloor { readonly mesh: Mesh; readonly center: Vector3; setRadius(this: void, radius: number): void }

/**
 * A transparent ground of antialiased dots, with faint contour lines fading in toward the horizon.
 * @param palette - dot and contour colors.
 * @param owner - receives geometry and material.
 * @param options - dot spacing and opacity; contours off for secondary surfaces.
 * @returns the floor mesh and its movable fade center.
 */
export function dottedFloor(palette: ScenePalette, owner: Owner,
  options: { spacing?: number; opacity?: number; contours?: boolean; size?: number } = {}): DottedFloor {
  const size = options.size ?? 900
  const uniforms = {
    dotColor: { value: palette.lineDim }, contourColor: { value: palette.accent },
    spacing: { value: options.spacing ?? 1 }, opacity: { value: options.opacity ?? 0.6 },
    contours: { value: options.contours === false ? 0 : 1 }, radius: { value: 90 }, center: { value: new Vector3() },
  }
  const material = owner.own(new ShaderMaterial({
    transparent: true, depthWrite: false, toneMapped: false,
    uniforms,
    vertexShader: /* glsl */ 'varying vec3 vWorld; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
    fragmentShader: /* glsl */ `
      uniform vec3 dotColor; uniform vec3 contourColor; uniform float spacing; uniform float opacity; uniform float contours;
      uniform float radius; uniform vec3 center; varying vec3 vWorld;
      ${NOISE}
      void main() {
        vec2 p = vWorld.xz;
        vec2 cell = (fract(p / spacing) - 0.5) * spacing;
        float d = length(cell), w = fwidth(d);
        float dotMask = 1.0 - smoothstep(spacing * 0.055 - w, spacing * 0.055 + w, d);
        float dist = length(p - center.xz);
        float fade = 1.0 - smoothstep(radius * 0.3, radius, dist);
        float h = dcFbm(vec3(p * 0.03, 0.0)) * 9.0;
        float line = 1.0 - smoothstep(0.0, fwidth(h) * 1.4, abs(fract(h - 0.5) - 0.5));
        float band = smoothstep(radius * 0.22, radius * 0.55, dist) * (1.0 - smoothstep(radius * 0.8, radius * 1.5, dist));
        float a = dotMask * opacity * fade + line * band * 0.32 * contours;
        vec3 c = mix(dotColor, contourColor, clamp(line * band * contours * 1.6, 0.0, 1.0));
        gl_FragColor = vec4(c, a);
        #include <colorspace_fragment>
      }`,
  }))
  const mesh = new Mesh(owner.own(new PlaneGeometry(size, size)), material)
  mesh.rotation.x = -Math.PI / 2
  mesh.renderOrder = -1
  const center = uniforms.center.value
  return { mesh, center, setRadius: (radius) => { uniforms.radius.value = radius } }
}

/** Shared uniforms of every flowing line material. */
export interface FlowUniforms { readonly time: { value: number } }

/**
 * Line material whose opacity fades at both ends, can carry moving pulses or dashes, and honors renderer clipping planes.
 * @param color - line color.
 * @param options - base opacity, dash period, pulse flow, blending, and the shared clock uniform.
 * @returns the shader material; geometry needs `along` and `remain` distance attributes.
 */
export function flowMaterial(color: Color, time: FlowUniforms['time'],
  options: { opacity: number; dash?: number; flow?: boolean; additive?: boolean }): ShaderMaterial {
  return new ShaderMaterial({
    transparent: true, depthWrite: false, toneMapped: false, clipping: true,
    blending: options.additive === false ? NormalBlending : AdditiveBlending,
    uniforms: {
      color: { value: color }, opacity: { value: options.opacity }, time, dash: { value: options.dash ?? 0 },
      flow: { value: options.flow === true ? 1 : 0 },
    },
    vertexShader: /* glsl */ `#include <clipping_planes_pars_vertex>
      attribute float along; attribute float remain; varying float vAlong; varying float vRemain;
      void main() {
        vAlong = along; vRemain = remain;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <clipping_planes_vertex>
      }`,
    fragmentShader: /* glsl */ `#include <clipping_planes_pars_fragment>
      uniform vec3 color; uniform float opacity; uniform float time; uniform float dash; uniform float flow;
      varying float vAlong; varying float vRemain;
      void main() {
        #include <clipping_planes_fragment>
        float a = opacity;
        if (dash > 0.0) a *= step(0.42, fract(vAlong / dash));
        if (flow > 0.0) a += smoothstep(0.8, 1.0, fract(vAlong / 7.0 - time * 0.5)) * 0.9;
        a *= smoothstep(0.0, 0.9, vAlong) * smoothstep(0.0, 0.9, vRemain);
        gl_FragColor = vec4(color, a);
        #include <colorspace_fragment>
      }`,
  })
}

/** One complete flow sample with its distance from the start and from the end. */
interface FlowSample {
  readonly x: number
  readonly y: number
  readonly z: number
  readonly along: number
  remain: number
}

/**
 * Read the complete XYZ samples of a flat point list and measure their cumulative distance.
 * @param points - sampled XYZ points as flat triples; incomplete triples are ignored.
 * @returns samples carrying their start and end distances.
 */
function flowSamples(points: readonly number[]): FlowSample[] {
  const samples: FlowSample[] = []
  for (let index = 0; index + 2 < points.length; index += 3) {
    const x = points[index], y = points[index + 1], z = points[index + 2]
    if (x === undefined || y === undefined || z === undefined) continue
    const previous = samples[samples.length - 1]
    const along = previous === undefined ? 0 : previous.along + Math.hypot(x - previous.x, y - previous.y, z - previous.z)
    samples.push({ x, y, z, along, remain: 0 })
  }
  const last = samples.at(-1)
  const total = last === undefined ? 0 : last.along
  for (const sample of samples) sample.remain = total - sample.along
  return samples
}

/**
 * Build a line geometry with the distance attributes {@link flowMaterial} reads.
 * @param points - sampled XYZ points as flat triples.
 * @returns the geometry; the caller owns disposal.
 */
export function flowGeometry(points: readonly number[]): BufferGeometry {
  const samples = flowSamples(points)
  return new BufferGeometry()
    .setAttribute('position', new Float32BufferAttribute(samples.flatMap(sample => [sample.x, sample.y, sample.z]), 3))
    .setAttribute('along', new Float32BufferAttribute(samples.map(sample => sample.along), 1))
    .setAttribute('remain', new Float32BufferAttribute(samples.map(sample => sample.remain), 1))
}

/**
 * Build a flat ribbon along sampled points in the x-z plane, carrying the distance attributes {@link flowMaterial} reads.
 * @param points - sampled XYZ points as flat triples.
 * @param width - full ribbon width in world units.
 * @returns the geometry with two vertices per sample and no triangles below two samples; the caller owns disposal.
 */
export function flowRibbon(points: readonly number[], width: number): BufferGeometry {
  const samples = flowSamples(points)
  const positions: number[] = []
  const along: number[] = []
  const remain: number[] = []
  if (samples.length >= 2) {
    samples.forEach((sample, index) => {
      const previous = samples[index - 1] ?? sample
      const next = samples[index + 1] ?? sample
      const dx = next.x - previous.x
      const dz = next.z - previous.z
      const length = Math.hypot(dx, dz)
      const offsetX = length === 0 ? 0 : -dz / length * width / 2
      const offsetZ = length === 0 ? width / 2 : dx / length * width / 2
      positions.push(
        sample.x + offsetX, sample.y, sample.z + offsetZ,
        sample.x - offsetX, sample.y, sample.z - offsetZ,
      )
      along.push(sample.along, sample.along)
      remain.push(sample.remain, sample.remain)
    })
  }
  const index: number[] = []
  for (let sample = 0; sample < samples.length - 1; sample += 1) {
    index.push(2 * sample, 2 * sample + 2, 2 * sample + 1, 2 * sample + 1, 2 * sample + 2, 2 * sample + 3)
  }
  return new BufferGeometry()
    .setAttribute('position', new Float32BufferAttribute(positions, 3))
    .setAttribute('along', new Float32BufferAttribute(along, 1))
    .setAttribute('remain', new Float32BufferAttribute(remain, 1))
    .setIndex(index)
}

/**
 * Convenience: a {@link Line} from flat points and a shared flow material.
 * @param points - flat XYZ triples.
 * @param material - flow material.
 * @returns the line object.
 */
export function flowLine(points: readonly number[], material: ShaderMaterial): Line {
  const line = new Line(flowGeometry(points), material)
  line.frustumCulled = false
  return line
}
