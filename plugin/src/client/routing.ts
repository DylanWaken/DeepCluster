/**
 * Grid placement and lane routing for ground connections.
 *
 * Nodes occupy cell centers on a square grid of pitch {@link CELL}. Connections leave a node through a face, travel only
 * along the lanes halfway between cells, and enter the target through a face, so a route never crosses a node footprint.
 * Lane corners are rounded with quadratic fillets whose depth stays inside the lane clearance.
 */
import { elementAt, entryOf, present } from './invariant.ts'

/** Distance between neighboring cell centers in world units. */
export const CELL = 8

/** Integer grid coordinates of one node. */
export interface Cell { readonly i: number; readonly j: number }
/** A point on the XZ ground plane. */
export interface RoutePoint { readonly x: number; readonly z: number }
/** An obstacle and possible endpoint: a square footprint of half-width `half` centered in its cell. */
export interface RouteNode { readonly id: string; readonly cell: Cell; readonly half: number }

/**
 * Stable square-ring placement: new indices never move earlier ones.
 * @param index - nonnegative insertion index.
 * @returns the cell for that index.
 */
export function cellSlot(index: number): Cell {
  const ring = Math.floor(Math.sqrt(index)), offset = index - ring * ring
  return offset < ring ? { i: ring, j: offset } : { i: offset - ring, j: ring }
}

/**
 * World position of a cell center.
 * @param cell - grid coordinates.
 * @returns the XZ point.
 */
export function cellCenter(cell: Cell): RoutePoint { return { x: cell.i * CELL, z: cell.j * CELL } }

type Direction = 0 | 1 | 2 | 3
const STEP = [{ x: 1, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 1 }, { x: 0, z: -1 }] as const
const TURN = CELL * 0.75

interface Edge { readonly to: string; readonly cost: number; readonly dir: Direction }

/** Face stubs of a node: the lane point beside each face and the two lane corners that point connects to. */
function stubs(node: RouteNode): { dir: Direction; point: RoutePoint; corners: [string, string]; along: [Direction, Direction] }[] {
  const { i, j } = node.cell
  return [
    { dir: 0, point: { x: (i + 0.5) * CELL, z: j * CELL }, corners: [`${i},${j - 1}`, `${i},${j}`], along: [3, 2] },
    { dir: 1, point: { x: (i - 0.5) * CELL, z: j * CELL }, corners: [`${i - 1},${j - 1}`, `${i - 1},${j}`], along: [3, 2] },
    { dir: 2, point: { x: i * CELL, z: (j + 0.5) * CELL }, corners: [`${i - 1},${j}`, `${i},${j}`], along: [1, 0] },
    { dir: 3, point: { x: i * CELL, z: (j - 0.5) * CELL }, corners: [`${i - 1},${j - 1}`, `${i},${j - 1}`], along: [1, 0] },
  ]
}

/** Lowest-cost lane polyline between two node faces, or null when either node is missing. */
function lanePath(nodes: readonly RouteNode[], fromId: string, toId: string): RoutePoint[] | null {
  const source = nodes.find(node => node.id === fromId), target = nodes.find(node => node.id === toId)
  if (source === undefined || target === undefined || source === target) return null
  const cells = nodes.map(node => node.cell)
  const minI = Math.min(...cells.map(cell => cell.i)) - 1, maxI = Math.max(...cells.map(cell => cell.i))
  const minJ = Math.min(...cells.map(cell => cell.j)) - 1, maxJ = Math.max(...cells.map(cell => cell.j))
  const points = new Map<string, RoutePoint>()
  const edges = new Map<string, Edge[]>()
  const link = (from: string, edge: Edge): void => {
    const list = edges.get(from)
    if (list === undefined) edges.set(from, [edge]); else list.push(edge)
  }
  const inside = (a: number, b: number): boolean => a >= minI && a <= maxI && b >= minJ && b <= maxJ
  for (let a = minI; a <= maxI; a++) for (let b = minJ; b <= maxJ; b++) {
    points.set(`${a},${b}`, { x: (a + 0.5) * CELL, z: (b + 0.5) * CELL })
    for (const dir of [0, 1, 2, 3] as const) {
      const na = a + STEP[dir].x, nb = b + STEP[dir].z
      if (inside(na, nb)) link(`${a},${b}`, { to: `${na},${nb}`, cost: CELL, dir })
    }
  }
  for (const stub of stubs(source)) {
    const key = `s${stub.dir}`
    points.set(key, stub.point)
    link('S', { to: key, cost: CELL / 2 - source.half, dir: stub.dir })
    stub.corners.forEach((corner, index) => {
      entryOf(points, corner)
      link(key, { to: corner, cost: CELL / 2, dir: elementAt(stub.along, index) })
    })
  }
  for (const stub of stubs(target)) {
    const key = `t${stub.dir}`
    points.set(key, stub.point)
    const inward = ([1, 0, 3, 2] as const)[stub.dir]
    link(key, { to: 'T', cost: CELL / 2 - target.half, dir: inward })
    stub.corners.forEach((corner, index) => {
      entryOf(points, corner)
      link(corner, { to: key, cost: CELL / 2, dir: ([1, 0, 3, 2] as const)[elementAt(stub.along, index)] })
    })
    for (const exit of stubs(source)) {
      if (exit.point.x === stub.point.x && exit.point.z === stub.point.z) link(`s${exit.dir}`, { to: key, cost: 0, dir: exit.dir })
    }
  }
  const best = new Map<string, number>()
  const previous = new Map<string, string>()
  const queue: { state: string; node: string; dir: Direction | -1; cost: number }[] = [{ state: 'S|-1', node: 'S', dir: -1, cost: 0 }]
  best.set('S|-1', 0)
  let goal: string | null = null
  while (queue.length > 0) {
    let lowest = 0
    for (let index = 1; index < queue.length; index++) {
      if (elementAt(queue, index).cost < elementAt(queue, lowest).cost) lowest = index
    }
    const current = elementAt(queue, lowest)
    queue.splice(lowest, 1)
    if (current.cost > entryOf(best, current.state)) continue
    if (current.node === 'T') { goal = current.state; break }
    for (const edge of entryOf(edges, current.node)) {
      const cost = current.cost + edge.cost + (current.dir !== -1 && current.dir !== edge.dir ? TURN : 0)
      const state = `${edge.to}|${edge.dir}`
      if (cost < (best.get(state) ?? Infinity)) {
        best.set(state, cost); previous.set(state, current.state)
        queue.push({ state, node: edge.to, dir: edge.dir, cost })
      }
    }
  }
  const resolvedGoal = present(goal, 'routing goal state')
  const keys: string[] = []
  for (let state: string | undefined = resolvedGoal; state !== undefined; state = previous.get(state)) {
    keys.unshift(elementAt(state.split('|'), 0))
  }
  const exitDir = Number(elementAt(keys, 1).slice(1)) as Direction
  const entryDir = Number(elementAt(keys, keys.length - 2).slice(1)) as Direction
  const start = cellCenter(source.cell), end = cellCenter(target.cell)
  const path = [
    { x: start.x + STEP[exitDir].x * source.half, z: start.z + STEP[exitDir].z * source.half },
    ...keys.slice(1, -1).map(key => entryOf(points, key)),
    { x: end.x + STEP[entryDir].x * target.half, z: end.z + STEP[entryDir].z * target.half },
  ].filter((point, index, all) => {
    if (index === 0) return true
    const previousPoint = elementAt(all, index - 1)
    return point.x !== previousPoint.x || point.z !== previousPoint.z
  })
  return path.filter((point, index) => {
    if (index === 0 || index === path.length - 1) return true
    const a = elementAt(path, index - 1), b = elementAt(path, index + 1)
    return !((a.x === point.x && point.x === b.x) || (a.z === point.z && point.z === b.z))
  })
}

/** Shift an axis-aligned polyline sideways by `offset` relative to its travel direction. */
function offsetPath(path: readonly RoutePoint[], offset: number): RoutePoint[] {
  const normal = (a: RoutePoint, b: RoutePoint): RoutePoint => {
    const length = Math.hypot(b.x - a.x, b.z - a.z)
    return { x: -(b.z - a.z) / length, z: (b.x - a.x) / length }
  }
  return path.map((point, index) => {
    const previous = path[index - 1], next = path[index + 1]
    const before = index > 0 && previous !== undefined ? normal(previous, point) : null
    const after = index < path.length - 1 && next !== undefined ? normal(point, next) : null
    const shift = before !== null && after !== null ? { x: before.x + after.x, z: before.z + after.z } : before ?? after ?? { x: 0, z: 0 }
    return { x: point.x + shift.x * offset, z: point.z + shift.z * offset }
  })
}

/**
 * Route one connection between node faces along grid lanes and round every corner.
 * @param nodes - all footprints; none is ever crossed.
 * @param fromId - source node id.
 * @param toId - target node id.
 * @param offset - signed sideways shift so parallel connections sharing a lane stay apart; |offset| ≤ 1.2 keeps clearance.
 * @param radius - largest corner fillet radius.
 * @returns densely sampled smooth points from the source face to the target face, or null when no route exists.
 */
export function routeLink(nodes: readonly RouteNode[], fromId: string, toId: string, offset = 0, radius = 2.4): RoutePoint[] | null {
  const lanes = lanePath(nodes, fromId, toId)
  if (lanes === null) return null
  const path = offsetPath(lanes, Math.max(-1.2, Math.min(1.2, offset)))
  const out: RoutePoint[] = [elementAt(path, 0)]
  for (let index = 1; index < path.length - 1; index++) {
    const p = elementAt(path, index - 1), v = elementAt(path, index), q = elementAt(path, index + 1)
    const inLength = Math.hypot(v.x - p.x, v.z - p.z), outLength = Math.hypot(q.x - v.x, q.z - v.z)
    const r = Math.min(radius, inLength * (index === 1 ? 0.9 : 0.5), outLength * (index === path.length - 2 ? 0.9 : 0.5))
    const a = { x: v.x + (p.x - v.x) / inLength * r, z: v.z + (p.z - v.z) / inLength * r }
    const b = { x: v.x + (q.x - v.x) / outLength * r, z: v.z + (q.z - v.z) / outLength * r }
    out.push(a)
    for (let step = 1; step < 12; step++) {
      const t = step / 12, u = 1 - t
      out.push({ x: u * u * a.x + 2 * u * t * v.x + t * t * b.x, z: u * u * a.z + 2 * u * t * v.z + t * t * b.z })
    }
    out.push(b)
  }
  out.push(elementAt(path, path.length - 1))
  return out
}

/**
 * Smallest distance from a route to any footprint other than its endpoints; used to verify routing.
 * @param points - sampled route.
 * @param nodes - all footprints.
 * @param exclude - endpoint ids whose faces the route touches by design.
 * @returns the minimum gap in world units; negative means the route enters a footprint.
 */
export function routeClearance(points: readonly RoutePoint[], nodes: readonly RouteNode[], exclude: readonly string[]): number {
  let gap = Infinity
  for (const node of nodes) {
    if (exclude.includes(node.id)) continue
    const center = cellCenter(node.cell)
    for (const point of points) {
      const dx = Math.abs(point.x - center.x) - node.half, dz = Math.abs(point.z - center.z) - node.half
      gap = Math.min(gap, dx > 0 || dz > 0 ? Math.hypot(Math.max(dx, 0), Math.max(dz, 0)) : Math.max(dx, dz))
    }
  }
  return gap
}
