import { CANVAS_SANDBOX, type CanvasBubble, type CanvasStroke } from '../../../shared/canvas'

export interface Size {
  w: number
  h: number
}
export interface Point {
  x: number
  y: number
}
export interface PlanetSpot extends Point {
  id: string
  r: number
  ring: number
  nameW: number
}

export const PLANET_R = 58
export const EMPTY_PLANET_R = 44
export const NAME_H = 28
export const HUB = { w: 420, h: 64 }
const ORBIT_SQUASH = 0.82
const SLOT_GAP = 30
const BUBBLE_GAP = 14
const CELL_GAP = 48
const NAME_CHAR_W = 9.4
const PULL_X = 0.97
const PULL_Y = 0.94

export const nameWidth = (name: string): number => Math.min(260, name.length * NAME_CHAR_W + 52)

function slotAngles(sizes: Size[]): number[] {
  const weights = sizes.map((z) => Math.max(z.w, z.h * 1.5) + SLOT_GAP)
  const total = weights.reduce((s, w) => s + w, 0) || 1
  let acc = 0
  return weights.map((w) => {
    const a = -Math.PI / 2 + ((acc + w / 2) / total) * Math.PI * 2
    acc += w
    return a
  })
}

function slotsAt(ring: number, sizes: Size[]): Point[] {
  return slotAngles(sizes).map((a) => ({
    x: Math.cos(a) * ring,
    y: Math.sin(a) * ring * ORBIT_SQUASH
  }))
}

const boxesHit = (a: Point, as: Size, b: Point, bs: Size, gap: number): boolean =>
  Math.abs(a.x - b.x) < (as.w + bs.w) / 2 + gap && Math.abs(a.y - b.y) < (as.h + bs.h) / 2 + gap

/** No bubble may touch the planet, the name pill hanging under it, or another bubble. */
function clears(r: number, nameW: number, sizes: Size[], pts: Point[]): boolean {
  const pill = { x: 0, y: r + NAME_H / 2 + 2 }
  const pillSize = { w: nameW, h: NAME_H }
  for (let i = 0; i < pts.length; i++) {
    const nx = Math.max(Math.abs(pts[i].x) - sizes[i].w / 2 - BUBBLE_GAP, 0)
    const ny = Math.max(Math.abs(pts[i].y) - sizes[i].h / 2 - BUBBLE_GAP, 0)
    if (Math.hypot(nx, ny) < r) return false
    if (boxesHit(pts[i], sizes[i], pill, pillSize, BUBBLE_GAP)) return false
    for (let j = i + 1; j < pts.length; j++)
      if (boxesHit(pts[i], sizes[i], pts[j], sizes[j], BUBBLE_GAP)) return false
  }
  return true
}

function ringFor(r: number, nameW: number, sizes: Size[]): number {
  if (!sizes.length) return 0
  for (let ring = r + 20; ring < 3000; ring += 6)
    if (clears(r, nameW, sizes, slotsAt(ring, sizes))) return ring
  return 3000
}

interface Cell extends PlanetSpot {
  half: Size
}

function cellFor(id: string, name: string, sizes: Size[]): Cell {
  const r = sizes.length ? PLANET_R : EMPTY_PLANET_R
  const nameW = nameWidth(name)
  const ring = ringFor(r, nameW, sizes)
  const pts = slotsAt(ring, sizes)
  const reachX = Math.max(r, nameW / 2, ...pts.map((p, i) => Math.abs(p.x) + sizes[i].w / 2))
  const reachY = Math.max(r + NAME_H + 4, ...pts.map((p, i) => Math.abs(p.y) + sizes[i].h / 2))
  return {
    id,
    r,
    ring,
    nameW,
    x: 0,
    y: 0,
    half: { w: reachX + CELL_GAP / 2, h: reachY + CELL_GAP / 2 }
  }
}

/** Planets ring the centre bubble without touching; one in `prev` keeps its spot so a new note only nudges neighbours. */
export function placePlanets(
  order: string[],
  members: Map<string, Size[]>,
  names: Map<string, string>,
  prev?: Map<string, Point>,
  fixed?: Map<string, Point>
): Map<string, PlanetSpot> {
  const cells = order.map((id) => cellFor(id, names.get(id) ?? '', members.get(id) ?? []))
  const hub = { w: HUB.w / 2 + CELL_GAP, h: HUB.h / 2 + CELL_GAP }
  let i = 0
  let reach = Math.max(hub.w, hub.h * 2)
  let ringNo = 0
  while (i < cells.length) {
    const biggest = Math.max(...cells.slice(i).map((c) => Math.max(c.half.w, c.half.h)))
    const R = reach + biggest
    const rx = R * 1.3
    const ry = R * 0.78
    const around = 2 * Math.PI * Math.sqrt((rx * rx + ry * ry) / 2) * 0.9
    const ring: Cell[] = []
    let used = 0
    while (i < cells.length && (ring.length === 0 || used + cells[i].half.w * 2 <= around)) {
      used += cells[i].half.w * 2
      ring.push(cells[i++])
    }
    let acc = 0
    const start = -Math.PI / 2 + (ringNo % 2) * (Math.PI / Math.max(ring.length, 1))
    for (const c of ring) {
      const a = start + ((acc + c.half.w) / Math.max(used, around * 0.6)) * Math.PI * 2
      acc += c.half.w * 2
      c.x = Math.cos(a) * rx
      c.y = Math.sin(a) * ry
    }
    reach = R + biggest
    ringNo++
  }
  for (const c of cells) {
    const p = fixed?.get(c.id) ?? prev?.get(c.id)
    if (p) {
      c.x = p.x
      c.y = p.y
    }
  }
  const pinned = (c: Cell): boolean => fixed?.has(c.id) ?? false
  for (let pass = 0; pass < 120; pass++) {
    let moved = false
    for (let a = 0; a < cells.length; a++) {
      const A = cells[a]
      const ox = A.half.w + hub.w - Math.abs(A.x)
      const oy = A.half.h + hub.h - Math.abs(A.y)
      if (ox > 0 && oy > 0 && !pinned(A)) {
        if (ox / hub.w < oy / hub.h) A.x += Math.sign(A.x || 1) * ox
        else A.y += Math.sign(A.y || 1) * oy
        moved = true
      }
      for (let b = a + 1; b < cells.length; b++) {
        const B = cells[b]
        const dx = B.x - A.x
        const dy = B.y - A.y
        const px = A.half.w + B.half.w - Math.abs(dx)
        const py = A.half.h + B.half.h - Math.abs(dy)
        if (px <= 0 || py <= 0 || (pinned(A) && pinned(B))) continue
        moved = true
        const ka = pinned(A) ? 0 : pinned(B) ? 1 : 0.5
        const kb = 1 - ka
        if (px < py) {
          A.x -= Math.sign(dx || 1) * px * ka
          B.x += Math.sign(dx || 1) * px * kb
        } else {
          A.y -= Math.sign(dy || 1) * py * ka
          B.y += Math.sign(dy || 1) * py * kb
        }
      }
    }
    if (!moved) break
  }
  const free = (c: Cell, x: number, y: number): boolean =>
    !(c.half.w + hub.w > Math.abs(x) && c.half.h + hub.h > Math.abs(y)) &&
    cells.every(
      (o) =>
        o === c ||
        o.half.w + c.half.w <= Math.abs(o.x - x) ||
        o.half.h + c.half.h <= Math.abs(o.y - y)
    )
  // Pull toward the centre until blocked; y pulls harder because screens are wide.
  for (let pass = 0; pass < 80; pass++) {
    let moved = false
    for (const c of cells) {
      const x = c.x * PULL_X
      const y = c.y * PULL_Y
      if (!pinned(c) && Math.hypot(c.x - x, c.y - y) > 0.5 && free(c, x, y)) {
        c.x = x
        c.y = y
        moved = true
      }
    }
    if (!moved) break
  }
  return new Map(
    cells.map((c) => [c.id, { id: c.id, x: c.x, y: c.y, r: c.r, ring: c.ring, nameW: c.nameW }])
  )
}

/** Where each member sits on its planet's orbit, in the order given. */
export function orbitSpots(planet: PlanetSpot, sizes: Size[]): Point[] {
  return slotsAt(planet.ring, sizes).map((p) => ({ x: planet.x + p.x, y: planet.y + p.y }))
}

/** Half-size of a planet with its orbit and name, for fitting the camera. */
export function planetReach(planet: PlanetSpot, sizes: Size[]): Size {
  const pts = slotsAt(planet.ring, sizes)
  return {
    w:
      Math.max(planet.r, planet.nameW / 2, ...pts.map((p, i) => Math.abs(p.x) + sizes[i].w / 2)) +
      20,
    h: Math.max(planet.r + NAME_H + 4, ...pts.map((p, i) => Math.abs(p.y) + sizes[i].h / 2)) + 20
  }
}

/** Projects with the most bubbles first (inner ring), Sandbox always last. */
export function planetOrder(projectIds: string[], bubbles: CanvasBubble[]): string[] {
  const count = new Map<string, number>()
  for (const b of bubbles) if (!b.parent) count.set(b.planet, (count.get(b.planet) ?? 0) + 1)
  return [...projectIds.filter((id) => id !== CANVAS_SANDBOX)]
    .sort((a, b) => (count.get(b) ?? 0) - (count.get(a) ?? 0))
    .concat(CANVAS_SANDBOX)
}

/** Point on a box's edge in the direction of `toward`, so lines start at the bubble, not its middle. */
export function rim(c: Point, size: Size, toward: Point): Point {
  const dx = toward.x - c.x
  const dy = toward.y - c.y
  const k = Math.min(
    (size.w / 2 + 4) / Math.abs(dx || 1e-6),
    (size.h / 2 + 4) / Math.abs(dy || 1e-6)
  )
  return { x: c.x + dx * k, y: c.y + dy * k }
}

export const ERASE_PX = 12

/** Smooth path through the points: quadratic curves via each midpoint. */
export function strokePath(pts: number[]): string {
  if (pts.length < 4) return pts.length ? `M${pts[0]},${pts[1]} l0.1,0` : ''
  let d = `M${pts[0]},${pts[1]}`
  for (let i = 2; i < pts.length - 2; i += 2) {
    const mx = (pts[i] + pts[i + 2]) / 2
    const my = (pts[i + 1] + pts[i + 3]) / 2
    d += ` Q${pts[i]},${pts[i + 1]} ${mx},${my}`
  }
  return `${d} L${pts[pts.length - 2]},${pts[pts.length - 1]}`
}

export interface Rect {
  x0: number
  y0: number
  x1: number
  y1: number
}

export const normRect = (a: Point, b: Point): Rect => ({
  x0: Math.min(a.x, b.x),
  y0: Math.min(a.y, b.y),
  x1: Math.max(a.x, b.x),
  y1: Math.max(a.y, b.y)
})

export const boxInRect = (c: Point, hw: number, hh: number, r: Rect): boolean =>
  c.x + hw > r.x0 && c.x - hw < r.x1 && c.y + hh > r.y0 && c.y - hh < r.y1

export const strokeInRect = (s: CanvasStroke, r: Rect): boolean => {
  for (let i = 0; i < s.points.length; i += 2)
    if (
      s.points[i] >= r.x0 &&
      s.points[i] <= r.x1 &&
      s.points[i + 1] >= r.y0 &&
      s.points[i + 1] <= r.y1
    )
      return true
  return false
}

export const strokeNear = (s: CanvasStroke, p: Point, radius: number): boolean => {
  for (let i = 0; i < s.points.length; i += 2)
    if (Math.hypot(s.points[i] - p.x, s.points[i + 1] - p.y) < radius) return true
  return false
}
