import { HUB, NAME_H, nameWidth, type PlanetSpot, type Point, type Size } from './layout'
import { MAP_R, type MapBox } from './map-layout'

export const PX_PER_MIN = 6
const BREAK_MIN = 180
const BREAK_PX = 200
const ITEM_GAP = 36
const LANE_GAP = 64
const LANE_LEFT = 150
const LABEL_ROOM = 120
const MIN = 60_000

/** A known (time, x) pair; the ruler interpolates between neighbours. */
export interface TimeMark {
  t: number
  x: number
  /** Set on the first mark after a folded gap. */
  gapMs?: number
}

export interface TimeLayout {
  planets: Map<string, PlanetSpot>
  targets: Map<string, Point>
  boxes: Map<string, MapBox>
  marks: TimeMark[]
  hub: Point
}

/** One row per project, read left to right in time order. Time sets the spacing, but a bubble never overlaps the one before it in its row, so busy minutes stretch; gaps over 3 hours fold into a fixed break. */
export function timeLayout(
  order: string[],
  members: Map<string, string[]>,
  created: Map<string, string>,
  names: Map<string, string>,
  waiting: string[],
  sizeOf: (id: string) => Size
): TimeLayout {
  const timeOf = (id: string): number => Date.parse(created.get(id) ?? '') || Date.now()
  const laneOf = new Map<string, string>()
  for (const p of order) for (const id of members.get(p) ?? []) laneOf.set(id, p)
  const items = [...laneOf.keys()].sort((a, b) => timeOf(a) - timeOf(b))

  const laneRight = new Map<string, number>()
  const left = new Map<string, number>()
  const marks: TimeMark[] = []
  let cursor = 0
  let prevT: number | undefined
  for (const id of items) {
    const t = timeOf(id)
    const lane = laneOf.get(id)!
    let gapMs: number | undefined
    if (prevT !== undefined) {
      const dt = (t - prevT) / MIN
      if (dt > BREAK_MIN) {
        gapMs = t - prevT
        cursor += BREAK_PX
      } else cursor += dt * PX_PER_MIN
    }
    cursor = Math.max(cursor, (laneRight.get(lane) ?? -Infinity) + ITEM_GAP)
    left.set(id, cursor)
    laneRight.set(lane, cursor + sizeOf(id).w)
    const last = marks.at(-1)
    if (last && last.t === t) last.x = Math.max(last.x, cursor)
    else marks.push({ t, x: cursor, gapMs })
    prevT = t
  }
  const endX = Math.max(cursor, ...laneRight.values(), 0)

  const planets = new Map<string, PlanetSpot>()
  const targets = new Map<string, Point>()
  const boxes = new Map<string, MapBox>()
  let top = 0
  for (const p of order) {
    const ids = members.get(p) ?? []
    const laneH = Math.max(MAP_R * 2 + NAME_H + 4, ...ids.map((id) => sizeOf(id).h))
    for (const id of ids) {
      const s = sizeOf(id)
      targets.set(id, { x: (left.get(id) ?? 0) + s.w / 2, y: top + s.h / 2 })
    }
    const nameW = nameWidth(names.get(p) ?? '')
    planets.set(p, { id: p, x: -LANE_LEFT, y: top + MAP_R, r: MAP_R, ring: 0, nameW })
    const right = Math.max(0, ...ids.map((id) => (left.get(id) ?? 0) + sizeOf(id).w))
    const x0 = -LANE_LEFT - Math.max(MAP_R, nameW / 2)
    boxes.set(p, {
      x: (x0 + right) / 2,
      y: top + laneH / 2,
      hw: (right - x0) / 2 + 20,
      hh: laneH / 2 + 20
    })
    top += laneH + LANE_GAP
  }
  let wy = top
  for (const id of waiting) {
    const s = sizeOf(id)
    targets.set(id, { x: endX + ITEM_GAP + s.w / 2, y: wy + s.h / 2 })
    wy += s.h + ITEM_GAP
  }
  return { planets, targets, boxes, marks, hub: { x: endX + HUB.w / 2, y: wy + HUB.h / 2 } }
}

export interface RulerTick {
  x: number
  t: number
  major: boolean
  dated?: boolean
  gapLabel?: string
}

/** Ticks every `stepMin`, placed by interpolating between marks; a tick that would crowd a dated label is dropped. */
export function rulerTicks(marks: TimeMark[], stepMin: number): RulerTick[] {
  const out: RulerTick[] = []
  const step = stepMin * MIN
  marks.forEach((m, i) => {
    const prev = marks[i - 1]
    if (!prev || m.gapMs) {
      if (m.gapMs && prev)
        out.push({ x: (prev.x + m.x) / 2, t: m.t, major: false, gapLabel: gapText(m.gapMs) })
      out.push({ x: m.x, t: m.t, major: true, dated: true })
      return
    }
    for (let t = Math.ceil(prev.t / step) * step; t < m.t; t += step) {
      if (t <= prev.t) continue
      const x = prev.x + ((t - prev.t) / (m.t - prev.t)) * (m.x - prev.x)
      const last = out.at(-1)
      if (last && x - last.x < (last.dated ? LABEL_ROOM : LABEL_ROOM / 3)) continue
      out.push({ x, t, major: new Date(t).getMinutes() === 0 })
    }
  })
  return out
}

const gapText = (ms: number): string => {
  const h = Math.round(ms / 3_600_000)
  return h < 48 ? `${h} h later` : `${Math.round(h / 24)} days later`
}
