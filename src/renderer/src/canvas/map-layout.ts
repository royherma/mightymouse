import { HUB, NAME_H, nameWidth, type PlanetSpot, type Point, type Size } from './layout'

export const MAP_R = 30
export const MAP_MIN_ZOOM = 0.7
const ITEM_GAP = 28
const GROUP_GAP = 48
const BRANCH_RUN = 90
const CHILD_RUN = 70
const FOLLOW_INDENT = 44

export interface MapBox {
  x: number
  y: number
  hw: number
  hh: number
}

export interface MapBranch {
  from: string
  to: string
  chat?: boolean
}

export interface MapLayout {
  planets: Map<string, PlanetSpot>
  targets: Map<string, Point>
  boxes: Map<string, MapBox>
  branches: MapBranch[]
  hide: Set<string>
  hub: Point
}

export interface MapInput {
  order: string[]
  members: Map<string, string[]>
  /** answer or chat bubble -> the note it hangs off, drawn to its right */
  childOf: Map<string, string>
  /** first message of a chat -> later messages that continued it, oldest first */
  chats: Map<string, string[]>
  collapsed: Set<string>
  waiting: string[]
  names: Map<string, string>
  sizeOf: (id: string) => Size
}

/** Projects in a left column, notes stacked to the right oldest-first, a chat's later messages indented under its first, answers further right; notes still being read wait above the input. */
export function mapLayout(m: MapInput): MapLayout {
  const { order, members, childOf, chats, collapsed, waiting, names, sizeOf } = m
  const planets = new Map<string, PlanetSpot>()
  const targets = new Map<string, Point>()
  const boxes = new Map<string, MapBox>()
  const branches: MapBranch[] = []
  const hide = new Set<string>()
  const nameW = new Map(order.map((id) => [id, nameWidth(names.get(id) ?? '')]))
  const colX = Math.max(MAP_R, ...[...nameW.values()].map((w) => w / 2)) + BRANCH_RUN
  const planetH = MAP_R * 2 + NAME_H + 4
  const kids = new Map<string, string[]>()
  for (const [child, parent] of childOf) kids.set(parent, [...(kids.get(parent) ?? []), child])
  const followers = new Set([...chats.values()].flat())

  const seen = new Set<string>()
  const kidsOf = (b: string): string[] => (kids.get(b) ?? []).filter((k) => !followers.has(k))
  const treeH = (b: string, path = new Set<string>()): number => {
    if (path.has(b)) return sizeOf(b).h
    const next = new Set(path).add(b)
    const under = kidsOf(b).map((k) => treeH(k, next))
    const stack = under.reduce((sum, h) => sum + h, 0) + Math.max(under.length - 1, 0) * ITEM_GAP
    return Math.max(sizeOf(b).h, stack)
  }
  const placeTree = (b: string, x: number, top: number): number => {
    if (seen.has(b)) return x
    seen.add(b)
    const s = sizeOf(b)
    const h = treeH(b)
    targets.set(b, { x: x + s.w / 2, y: top + h / 2 })
    let right = x + s.w
    const under = kidsOf(b)
    const stack =
      under.reduce((sum, k) => sum + treeH(k), 0) + Math.max(under.length - 1, 0) * ITEM_GAP
    let kidTop = top + (h - stack) / 2
    for (const k of under) {
      right = Math.max(right, placeTree(k, x + s.w + CHILD_RUN, kidTop))
      kidTop += treeH(k) + ITEM_GAP
    }
    return right
  }

  let top = 0
  for (const id of order) {
    const heads = (members.get(id) ?? []).filter((b) => !childOf.has(b) && !followers.has(b))
    const rows: { id: string; x: number; head?: string }[] = []
    for (const h of heads) {
      rows.push({ id: h, x: colX })
      const later = chats.get(h) ?? []
      if (collapsed.has(h)) {
        for (const f of later) [f, ...(kids.get(f) ?? [])].forEach((x) => hide.add(x))
        continue
      }
      for (const f of later) rows.push({ id: f, x: colX + FOLLOW_INDENT, head: h })
    }
    const rowH = rows.map((r) => treeH(r.id))
    const itemsH = rowH.reduce((s, h) => s + h, 0) + Math.max(rows.length - 1, 0) * ITEM_GAP
    const groupH = Math.max(planetH, itemsH)
    let y = top + (groupH - itemsH) / 2
    let right = colX
    rows.forEach((r, i) => {
      branches.push(r.head ? { from: r.head, to: r.id, chat: true } : { from: id, to: r.id })
      right = Math.max(right, placeTree(r.id, r.x, y))
      y += rowH[i] + ITEM_GAP
    })
    const w = nameW.get(id) ?? 0
    const py = top + groupH / 2 - (NAME_H + 4) / 2
    planets.set(id, { id, x: 0, y: py, r: MAP_R, ring: 0, nameW: w })
    const x0 = -Math.max(MAP_R, w / 2)
    boxes.set(id, {
      x: (x0 + right) / 2,
      y: top + groupH / 2,
      hw: (right - x0) / 2 + 20,
      hh: groupH / 2 + 20
    })
    top += groupH + GROUP_GAP
  }
  for (const id of waiting) {
    const s = sizeOf(id)
    targets.set(id, { x: colX + s.w / 2, y: top + s.h / 2 })
    top += s.h + ITEM_GAP
  }
  return {
    planets,
    targets,
    boxes,
    branches,
    hide,
    hub: { x: colX + HUB.w / 2, y: top + HUB.h / 2 }
  }
}
