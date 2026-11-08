import { CONFIG } from './config'

export interface Point {
  x: number
  y: number
}

export interface CursorPath {
  from: Point
  c1: Point
  c2: Point
  land: Point
  to: Point
  travelMs: number
  settleMs: number
}

const M = CONFIG.AGENT_CURSOR

function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

function overshoots(d: number): boolean {
  return d >= M.OVERSHOOT_MIN_PX
}

export function glideMs(from: Point | null, to: Point): number {
  if (!from) return M.ENTER_MS
  const d = distance(from, to)
  if (d < 1) return 0
  const travel = Math.min(M.MAX_MS, M.MIN_MS + Math.sqrt(d) * M.MS_PER_SQRT_PX)
  return Math.round(travel + (overshoots(d) ? M.SETTLE_MS : 0))
}

export function entryPoint(to: Point): Point {
  return { x: to.x + M.ENTER_OFFSET_PX, y: to.y + M.ENTER_OFFSET_PX * 1.4 }
}

// Minimum-jerk profile: the speed curve of a human reaching movement.
export function minimumJerk(t: number): number {
  return t * t * t * (10 - 15 * t + 6 * t * t)
}

export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3)
}

export function planPath(from: Point, to: Point, totalMs: number, rand: () => number = Math.random): CursorPath {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const d = Math.hypot(dx, dy) || 1
  const ux = dx / d
  const uy = dy / d
  const side = rand() < 0.5 ? -1 : 1
  const bend = d * (M.ARC_MIN + rand() * (M.ARC_MAX - M.ARC_MIN)) * side
  const nx = -uy * bend
  const ny = ux * bend
  const over = overshoots(d) ? Math.min(M.OVERSHOOT_MAX_PX, d * M.OVERSHOOT_RATIO) : 0
  const land = { x: to.x + ux * over, y: to.y + uy * over }
  const settleMs = over > 0 ? M.SETTLE_MS : 0
  return {
    from,
    c1: { x: from.x + dx * 0.25 + nx, y: from.y + dy * 0.25 + ny },
    c2: { x: from.x + dx * 0.7 + nx * 0.55, y: from.y + dy * 0.7 + ny * 0.55 },
    land,
    to,
    travelMs: Math.max(1, totalMs - settleMs),
    settleMs
  }
}

function bezier(p: CursorPath, t: number): Point {
  const u = 1 - t
  const a = u * u * u
  const b = 3 * u * u * t
  const c = 3 * u * t * t
  const e = t * t * t
  return {
    x: a * p.from.x + b * p.c1.x + c * p.c2.x + e * p.land.x,
    y: a * p.from.y + b * p.c1.y + c * p.c2.y + e * p.land.y
  }
}

export function pointAt(p: CursorPath, elapsedMs: number): { at: Point; done: boolean } {
  if (elapsedMs < p.travelMs) return { at: bezier(p, minimumJerk(elapsedMs / p.travelMs)), done: false }
  const s = p.settleMs > 0 ? Math.min(1, (elapsedMs - p.travelMs) / p.settleMs) : 1
  const k = easeOutCubic(s)
  return {
    at: { x: p.land.x + (p.to.x - p.land.x) * k, y: p.land.y + (p.to.y - p.land.y) * k },
    done: s >= 1
  }
}
