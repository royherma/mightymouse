import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement
} from 'react'
import {
  ArrowRightLeft,
  ExternalLink,
  ListChecks,
  MessageSquare,
  MessageSquarePlus,
  Pencil,
  Plus,
  Square,
  SquareCheck,
  StickyNote,
  Terminal,
  Trash2,
  X
} from 'lucide-react'
import './canvas/canvas.css'
import { Button } from './components/Button'
import { CopyButton } from './components/CopyButton'
import { Markdown } from './components/Markdown'
import {
  CANVAS_SANDBOX,
  EMPTY_CANVAS,
  canvasFailText,
  chatRan,
  chatStatus,
  localTags,
  SESSION_DRAG_TYPE,
  CODE_DRAG_TYPE,
  OPEN_CODE_EVENT,
  readSessionDrag,
  type CanvasSessionRef,
  type CanvasBoardSummary,
  type CanvasBubble,
  type CanvasState
} from '@shared/canvas'
import type { MightyProject, MightySession } from '@shared/types'
import {
  HUB,
  NAME_H,
  orbitSpots,
  placePlanets,
  planetOrder,
  planetReach,
  rim,
  ERASE_PX,
  boxInRect,
  normRect,
  strokeInRect,
  strokeNear,
  strokePath,
  type Rect,
  type PlanetSpot,
  type Point,
  type Size
} from './canvas/layout'
import { useDispatcher, answerText, chatTitle, fullAnswer, mediaOf } from './canvas/useDispatcher'
import { DidCardView } from './canvas/DidCard'
import {
  BoardPicker,
  ChatsPicker,
  HubInput,
  PlanetView,
  TimeRuler,
  WriteBubble
} from './canvas/Pieces'
import { PX_PER_MIN, timeLayout, type TimeMark } from './canvas/time-layout'
import { MAP_MIN_ZOOM, mapLayout, type MapBox, type MapBranch } from './canvas/map-layout'
import { SegmentedControl } from './components/SegmentedControl'
import { Toolbar, type Tool } from './canvas/tools'
import { AddMenu, PickBar, UndoToast, ZoomPill, type Toast } from './canvas/controls'
import { useAttachments } from './hooks/useAttachments'
import { mightyProjectForCwd } from '@shared/relay-sessions'
import type { CanvasInk } from '@shared/canvas'

const RECENT_EMPTY_PLANETS = 6
// Past this many notes, empty projects leave the overview so the busy ones stay readable.
const HIDE_EMPTY_AT = 8
const MAX_SHOWN = 5
const MAX_SHOWN_BUSY = 2
const MAP_MAX_SHOWN = 6
const LIVE_CHARS = 320
const FRESH_LINK_MS = 3000
const BUSY_AT = 24
const CARD_CHIPS = 5
const DRAG_START_PX = 4
const CAM_EASE = 0.2
const CAM_SNAP = 0.25
const SPRING = 0.075
const DAMPING = 0.78
const FIT_MAX_ZOOM = 1.1
// Fit is an explicit ask to see it all, so it may go below the Map/Timeline reading floor.
const FIT_MIN_ZOOM = 0.28
// A full fit leaves this much room so one more note lands without a zoom-out.
const FIT_ROOM = 0.92
const HUB_ID = 'hub'
const ARRIVE_MS = 1100
const HISTORY = 100
const HUB_AT: Point = { x: 0, y: 0 }
const FOCUS_RUN = 80
const FOCUS_GAP = 16
const RULER_ROOM = 60
const TIME_MIN_ZOOM = 0.45
const VIEW_KEY = 'canvas.view'
type View = 'space' | 'map' | 'time'
const VIEWS = [
  { id: 'space', label: 'Space' },
  { id: 'map', label: 'Map' },
  { id: 'time', label: 'Timeline' }
] as const
const savedView = (): View => {
  try {
    const v = localStorage.getItem(VIEW_KEY)
    return v === 'map' || v === 'time' ? v : 'space'
  } catch {
    return 'space'
  }
}

const HOOK_HOLD_MS = 650
const REEL_SPRING = 0.028
const REEL_DAMPING = 0.84

// the stage's box on screen; not the window when embedded beside the main window's sidebar
const stageBox = { w: innerWidth, h: innerHeight }

function panInto(c: Cam, t: Point, s: Size): void {
  const x = t.x * c.tz + c.tx
  const y = t.y * c.tz + c.ty
  const hw = (s.w / 2 + 40) * c.tz
  const hh = (s.h / 2 + 40) * c.tz
  const bottom = stageBox.h - 220
  if (x - hw < 0) c.tx += hw - x
  else if (x + hw > stageBox.w) c.tx -= x + hw - stageBox.w
  if (y - hh < 60) c.ty += 60 + hh - y
  else if (y + hh > bottom) c.ty -= y + hh - bottom
}

interface Cam {
  x: number
  y: number
  z: number
  tx: number
  ty: number
  tz: number
}
interface Writing {
  at: Point
  seed?: string
  onDone?: (text: string) => void
}

const now = (): string => new Date().toISOString()
const uid = (): string => crypto.randomUUID()

export default function CanvasApp({ active = true }: { active?: boolean }): ReactElement {
  const [canvas, setCanvas] = useState<CanvasState>(EMPTY_CANVAS)
  const [projects, setProjects] = useState<MightyProject[]>([])
  const [sessions, setSessions] = useState<MightySession[]>([])
  const [sizes, setSizes] = useState<Record<string, Size>>({})
  const [pending, setPending] = useState<Record<string, Point>>({})
  const [writing, setWriting] = useState<Writing | null>(null)
  const [focusId, setFocusId] = useState<string | null>(null)
  const [zoomPlanet, setZoomPlanet] = useState<string | null>(null)
  const [dirFail, setDirFail] = useState<string | null>(null)
  const [hot, setHot] = useState<string | null>(null)
  const [dropping, setDropping] = useState(false)
  const [view, setView] = useState<View>(savedView)
  const [folded, setFolded] = useState<Set<string>>(new Set())
  const [hooked, setHooked] = useState<string[]>([])
  const [tool, setTool] = useState<Tool>('select')
  const [ink, setInk] = useState<CanvasInk>('ink')
  const [spaceHeld, setSpaceHeld] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [marquee, setMarquee] = useState<Rect | null>(null)
  const [liveStroke, setLiveStroke] = useState<number[] | null>(null)
  const [erasing, setErasing] = useState<Set<string>>(new Set())
  const hubAttach = useAttachments()
  const hubFiles = hubAttach.attachments
  const [hoverId, setHoverId] = useState<string | null>(null)
  const [arrive, setArrive] = useState<string | null>(null)
  const [boards, setBoards] = useState<CanvasBoardSummary[]>([])
  const [planetDrag, setPlanetDrag] = useState<{ id: string; at: Point } | null>(null)
  const [moveMenu, setMoveMenu] = useState<string | null>(null)
  const [plusMenu, setPlusMenu] = useState<string | null>(null)
  const [chatsOpen, setChatsOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const closeAdd = useCallback(() => setAddOpen(false), [])
  const [pull, setPull] = useState<{ from: string; to: Point; over?: string } | null>(null)
  const [toast, setToast] = useState<Toast | null>(null)
  const [dropOn, setDropOn] = useState<string | null>(null)
  const [freshLinks, setFreshLinks] = useState<Set<string>>(new Set())
  const seenLinks = useRef<Set<string> | null>(null)
  const zoomPctRef = useRef<HTMLSpanElement | null>(null)

  const stageRef = useRef<HTMLDivElement>(null)
  const worldRef = useRef<HTMLDivElement>(null)
  const els = useRef(new Map<string, HTMLDivElement>())
  const lineEls = useRef(
    new Map<string, { path: SVGPathElement | null; label: SVGTextElement | null }>()
  )
  const pos = useRef(new Map<string, Point>())
  const vel = useRef(new Map<string, Point>())
  const hooks = useRef(new Map<string, number>())
  const rulerRef = useRef<HTMLDivElement | null>(null)
  const follow = useRef<string | null>(null)
  const wasPending = useRef<string[]>([])
  const blobEls = useRef(new Map<string, SVGRectElement>())
  const hubRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ id: string; at: Point; group?: Map<string, Point> } | null>(null)
  const justDragged = useRef(false)
  const popped = useRef(new WeakSet<HTMLElement>())
  const autoFit = useRef(true)
  const fitted = useRef(false)
  const prevPlanets = useRef<Map<string, Point> | undefined>(undefined)
  const cam = useRef<Cam>({
    x: stageBox.w / 2,
    y: stageBox.h / 2,
    z: 0.8,
    tx: stageBox.w / 2,
    ty: stageBox.h / 2,
    tz: 0.8
  })
  const canvasRef = useRef(canvas)
  const sessionsRef = useRef(sessions)
  useLayoutEffect(() => {
    canvasRef.current = canvas
    sessionsRef.current = sessions
  }, [canvas, sessions])

  const commit = useCallback((next: CanvasState) => {
    canvasRef.current = next
    setCanvas(next)
    void window.api.canvas.save(next)
  }, [])
  const undoStack = useRef<CanvasState[]>([])
  const redoStack = useRef<CanvasState[]>([])
  const quiet = useCallback(
    (fn: (c: CanvasState) => CanvasState) => commit(fn(canvasRef.current)),
    [commit]
  )
  const update = useCallback(
    (fn: (c: CanvasState) => CanvasState) => {
      const before = canvasRef.current
      const next = fn(before)
      if (next === before) return
      undoStack.current = [...undoStack.current.slice(-(HISTORY - 1)), before]
      redoStack.current = []
      commit(next)
    },
    [commit]
  )
  const stepHistory = useCallback(
    (back: boolean) => {
      const from = back ? undoStack : redoStack
      const to = back ? redoStack : undoStack
      const target = from.current.at(-1)
      if (!target) return
      from.current = from.current.slice(0, -1)
      to.current = [...to.current, canvasRef.current]
      commit(target)
    },
    [commit]
  )

  useEffect(() => {
    void window.api.canvas.load().then((c) => {
      canvasRef.current = c
      setCanvas(c)
    })
    void window.api.canvas.boards().then(setBoards)
    const loadProjects = (): void => {
      void window.api.mighty.listProjects().then(setProjects)
      void window.api.mighty.listSessions().then(setSessions)
    }
    loadProjects()
    const offProjects = window.api.mighty.onProjectsChanged(loadProjects)
    const offTurns = window.api.mighty.onTurnAppended(
      () => void window.api.mighty.listSessions().then(setSessions)
    )
    return () => {
      offProjects()
      offTurns()
    }
  }, [])

  useEffect(() => {
    const ids = canvas.links.map((l) => l.id)
    if (!seenLinks.current) {
      seenLinks.current = new Set(ids)
      return
    }
    const seen = seenLinks.current
    const fresh = ids.filter((id) => !seen.has(id))
    for (const id of fresh) seen.add(id)
    if (!fresh.length) return
    setFreshLinks(new Set(fresh))
    const t = window.setTimeout(() => setFreshLinks(new Set()), FRESH_LINK_MS)
    return () => clearTimeout(t)
  }, [canvas.links])

  const projectById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects])
  const sessionById = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions])
  const planetName = useCallback(
    (id: string) => (id === CANVAS_SANDBOX ? 'Sandbox' : (projectById.get(id)?.name ?? 'Sandbox')),
    [projectById]
  )

  const arriveTimer = useRef(0)
  const onFiled = useCallback((planet: string) => {
    clearTimeout(arriveTimer.current)
    setArrive(planet)
    arriveTimer.current = window.setTimeout(() => setArrive(null), ARRIVE_MS)
  }, [])
  const dispatcher = useDispatcher({
    onFiled,
    canvasRef,
    update,
    quiet,
    sessionsRef,
    setSessions,
    setPending,
    pos,
    planetName
  })
  const { card, setCard, working, live, file } = dispatcher

  /* ---------- which bubbles and planets the overview shows ---------- */
  const roots = useMemo(
    () => canvas.bubbles.filter((b) => !b.parent && !pending[b.id]),
    [canvas.bubbles, pending]
  )
  const candidatePlanets = useMemo(() => {
    const used = new Set(canvas.bubbles.map((b) => b.planet))
    const live = projects.filter((p) => !p.archived)
    const recent = [...live]
      .sort((a, b) => b.updated.localeCompare(a.updated))
      .slice(0, RECENT_EMPTY_PLANETS)
    const added = new Set(canvas.planets ?? [])
    const ids = new Set([
      ...live.filter((p) => used.has(p.id) || p.pinned || added.has(p.id)).map((p) => p.id),
      ...recent.map((p) => p.id)
    ])
    return planetOrder([...ids], canvas.bubbles)
  }, [projects, canvas.bubbles, canvas.planets])
  const shownPlanets = useMemo(() => {
    if (roots.length < HIDE_EMPTY_AT) return candidatePlanets
    const used = new Set(roots.map((b) => b.planet))
    const added = new Set(canvas.planets ?? [])
    return candidatePlanets.filter(
      (id) => used.has(id) || added.has(id) || projectById.get(id)?.pinned
    )
  }, [candidatePlanets, roots, projectById, canvas.planets])

  const layout = useMemo(() => {
    const sizeOf = (id: string): Size => sizes[id] ?? { w: 160, h: 44 }
    const members = new Map<string, string[]>()
    const hidden = new Map<string, number>()
    for (const b of roots) members.set(b.planet, [...(members.get(b.planet) ?? []), b.id])
    const cap =
      view !== 'space' ? MAP_MAX_SHOWN : roots.length >= BUSY_AT ? MAX_SHOWN_BUSY : MAX_SHOWN
    for (const [planet, ids] of members) {
      if (planet === zoomPlanet || ids.length <= cap) continue
      const keep = ids.slice(-cap)
      if (card && ids.includes(card.bubbleId) && !keep.includes(card.bubbleId))
        keep.splice(0, 1, card.bubbleId)
      hidden.set(planet, ids.length - keep.length)
      members.set(planet, keep)
    }
    const names = new Map(
      shownPlanets.map((id) => [
        id,
        hidden.has(id)
          ? `${planetName(id)} ${(members.get(id) ?? []).length} of ${(members.get(id) ?? []).length + (hidden.get(id) ?? 0)}`
          : planetName(id)
      ])
    )
    let planets: Map<string, PlanetSpot>
    let targets = new Map<string, Point>()
    let boxes: Map<string, MapBox> | undefined
    let branches: MapBranch[] = []
    let hide = new Set<string>()
    let chatCount = new Map<string, number>()
    let hub = HUB_AT
    let marks: TimeMark[] = []
    if (view === 'time') {
      const first = new Map<string, string>()
      for (const b of roots) if (!first.has(b.planet)) first.set(b.planet, b.created)
      const order = first.size
        ? [
            ...[...first.keys()].sort((a, b) => first.get(a)!.localeCompare(first.get(b)!)),
            ...(canvas.planets ?? []).filter((id) => !first.has(id) && shownPlanets.includes(id))
          ]
        : shownPlanets
      const t = timeLayout(
        order,
        members,
        new Map(roots.map((b) => [b.id, b.created])),
        names,
        Object.keys(pending),
        sizeOf
      )
      ;({ planets, targets, boxes, hub, marks } = t)
    } else if (view === 'map') {
      const first = new Map<string, string>()
      for (const b of roots) if (!first.has(b.planet)) first.set(b.planet, b.created)
      const order = first.size
        ? [
            ...[...first.keys()].sort((a, b) => first.get(a)!.localeCompare(first.get(b)!)),
            ...(canvas.planets ?? []).filter((id) => !first.has(id) && shownPlanets.includes(id))
          ]
        : shownPlanets
      const kind = new Map(roots.map((b) => [b.id, b.kind]))
      const childOf = new Map<string, string>()
      for (const l of canvas.links) {
        const k = kind.get(l.to)
        const fromHead = kind.get(l.from) === 'answer' || kind.get(l.from) === 'thread'
        if (
          (k === 'answer' || k === 'thread' || fromHead) &&
          kind.has(l.from) &&
          !childOf.has(l.to) &&
          l.to !== l.from
        )
          childOf.set(l.to, l.from)
      }
      const headOf = new Map<string, string>()
      const chats = new Map<string, string[]>()
      for (const b of roots) {
        if (!b.sessionId || b.kind === 'answer') continue
        const key = `${b.planet}:${b.sessionId}`
        const head = headOf.get(key)
        if (!head) headOf.set(key, childOf.get(b.id) ?? b.id)
        else if (!childOf.has(b.id) && head !== b.id)
          chats.set(head, [...(chats.get(head) ?? []), b.id])
      }
      const m = mapLayout({
        order,
        members,
        childOf,
        chats,
        collapsed: folded,
        waiting: Object.keys(pending),
        names,
        sizeOf
      })
      ;({ planets, targets, boxes, branches, hub } = m)
      hide = m.hide
      chatCount = new Map([...chats].map(([h, f]) => [h, f.length]))
    } else {
      const fixed = new Map(Object.entries(canvas.places ?? {}))
      if (planetDrag) fixed.set(planetDrag.id, planetDrag.at)
      planets = placePlanets(
        shownPlanets,
        new Map(shownPlanets.map((id) => [id, (members.get(id) ?? []).map(sizeOf)])),
        names,
        prevPlanets.current,
        fixed
      )
      for (const [id, list] of members) {
        const spot = planets.get(id) ?? planets.get(CANVAS_SANDBOX)
        if (!spot) continue
        orbitSpots(spot, list.map(sizeOf)).forEach((p, i) => targets.set(list[i], p))
      }
    }
    for (const b of canvas.bubbles) if (b.at && targets.has(b.id)) targets.set(b.id, b.at)
    if (view === 'space') {
      let y = hub.y - 20
      for (const id of Object.keys(pending)) {
        targets.set(id, { x: hub.x, y: y + sizeOf(id).h / 2 })
        y += sizeOf(id).h + 14
      }
    }
    if (focusId) {
      const root = targets.get(focusId)
      if (root) {
        const rs = sizeOf(focusId)
        const left = root.x + rs.w / 2 + FOCUS_RUN
        let y = root.y - rs.h / 2
        const stack = (id: string, gap = FOCUS_GAP): void => {
          const z = sizeOf(id)
          targets.set(id, { x: left + z.w / 2, y: y + z.h / 2 })
          y += z.h + gap
        }
        for (const st of canvas.bubbles.filter((b) => b.parent === focusId)) stack(st.id)
        const dirs = canvas.bubbles.find((b) => b.id === focusId)?.directions ?? []
        if (dirs.length) dirs.forEach((_, i) => stack(`dir:${i}`))
        else stack('dir:1')
        y += FOCUS_GAP
        stack('done')
      }
    }
    const centerOf = new Map<string, Point>()
    for (const [planet, ids] of view !== 'space' ? [] : members) {
      const spot = planets.get(planet)
      if (spot) for (const id of ids) centerOf.set(id, spot)
    }
    targets.set(HUB_ID, hub)
    const shown = new Set(
      [...[...members.values()].flat(), ...Object.keys(pending)].filter((id) => !hide.has(id))
    )
    return {
      planets,
      targets,
      sizeOf,
      centerOf,
      members,
      hidden,
      shown,
      boxes,
      branches,
      hub,
      chatCount,
      marks
    }
  }, [
    view,
    folded,
    canvas.links,
    roots,
    shownPlanets,
    sizes,
    pending,
    focusId,
    zoomPlanet,
    card,
    canvas.bubbles,
    canvas.places,
    canvas.planets,
    planetDrag,
    planetName
  ])

  useLayoutEffect(() => {
    const now = Object.keys(pending)
    for (const id of wasPending.current) {
      if (now.includes(id) || !layout.targets.has(id)) continue
      hooks.current.set(id, performance.now() + HOOK_HOLD_MS)
      follow.current = id
      setHooked((h) => [...h, id])
      window.setTimeout(() => setHooked((h) => h.filter((x) => x !== id)), HOOK_HOLD_MS + 1800)
    }
    wasPending.current = now
  }, [pending, layout])

  /* ---------- measure what rendered ---------- */
  const observer = useMemo(
    () =>
      new ResizeObserver((entries) => {
        setSizes((prev) => {
          const next = { ...prev }
          let changed = false
          for (const e of entries) {
            const el = e.target as HTMLElement
            const id = el.dataset.cvId
            if (!id) continue
            const sz = { w: el.offsetWidth, h: el.offsetHeight }
            if (!next[id] || next[id].w !== sz.w || next[id].h !== sz.h) {
              next[id] = sz
              changed = true
            }
          }
          return changed ? next : prev
        })
      }),
    []
  )
  useEffect(() => () => observer.disconnect(), [observer])

  /* ---------- motion: ease every element toward its target ---------- */
  const layoutRef = useRef(layout)
  useLayoutEffect(() => {
    layoutRef.current = layout
    if (fitted.current) prevPlanets.current = layout.planets
  }, [layout])
  useEffect(() => {
    let raf = 0
    const tick = (t: number): void => {
      const L = layoutRef.current
      for (const [id, el] of els.current) {
        const off = drag.current?.group?.get(id)
        const dragging = drag.current?.id === id || off !== undefined
        const target = !dragging
          ? L.targets.get(id)
          : off
            ? { x: drag.current!.at.x + off.x, y: drag.current!.at.y + off.y }
            : drag.current!.at
        if (!target) continue
        const cur = pos.current.get(id) ?? { ...target }
        const v = vel.current.get(id) ?? { x: 0, y: 0 }
        if (dragging) {
          cur.x = target.x
          cur.y = target.y
          v.x = 0
          v.y = 0
        } else if ((hooks.current.get(id) ?? 0) > t) {
          v.x = 0
          v.y = 0
        } else {
          const reel = hooks.current.has(id)
          const k = reel ? REEL_SPRING : SPRING
          const d = reel ? REEL_DAMPING : DAMPING
          v.x = (v.x + (target.x - cur.x) * k) * d
          v.y = (v.y + (target.y - cur.y) * k) * d
          cur.x += v.x
          cur.y += v.y
          if (
            reel &&
            Math.hypot(target.x - cur.x, target.y - cur.y) < 1 &&
            Math.hypot(v.x, v.y) < 0.2
          ) {
            hooks.current.delete(id)
            if (follow.current === id) follow.current = null
          }
        }
        if (follow.current === id && !dragging) panInto(cam.current, cur, L.sizeOf(id))
        pos.current.set(id, cur)
        vel.current.set(id, v)
        const s = L.sizeOf(id)
        const ph = id.charCodeAt(0) + id.charCodeAt(id.length - 1)
        const dx = dragging ? 0 : Math.sin(t / 1700 + ph) * 3
        const dy = dragging ? 0 : Math.cos(t / 1300 + ph) * 3
        const x = cur.x - s.w / 2 + dx
        const y = cur.y - s.h / 2 + dy
        el.style.translate = `${x}px ${y}px`
        const blob = blobEls.current.get(id)
        if (blob) {
          blob.setAttribute('x', String(x))
          blob.setAttribute('y', String(y))
          blob.setAttribute('width', String(s.w))
          blob.setAttribute('height', String(s.h))
          blob.style.opacity = dragging || el.classList.contains('cv-dim') ? '0' : '1'
        }
      }
      for (const [id, line] of lineEls.current) {
        if (id.startsWith('c:')) {
          const [from, to] = id.slice(2).split('>')
          const a = pos.current.get(from)
          const b = pos.current.get(to)
          if (!a || !b || !line.path) continue
          const sx = a.x - L.sizeOf(from).w / 2 + 22
          const sy = a.y + L.sizeOf(from).h / 2
          const tx = b.x - L.sizeOf(to).w / 2 - 4
          line.path.setAttribute(
            'd',
            `M${sx},${sy} V${b.y - 10} Q${sx},${b.y} ${sx + 10},${b.y} H${tx}`
          )
          continue
        }
        if (id.startsWith('b:')) {
          const [from, to] = id.slice(2).split('>')
          const p = L.planets.get(from)
          const b = pos.current.get(to)
          if (!p || !b || !line.path) continue
          const x1 = p.x + p.r + 6
          const x2 = b.x - L.sizeOf(to).w / 2 - 4
          const mx = (x1 + x2) / 2
          line.path.setAttribute('d', `M${x1},${p.y} C${mx},${p.y} ${mx},${b.y} ${x2},${b.y}`)
          continue
        }
        const [from, to] = id.split('>')
        const a = pos.current.get(from)
        const b = pos.current.get(to)
        if (!a || !b || !line.path) continue
        const p = rim(a, L.sizeOf(from), b)
        const q = rim(b, L.sizeOf(to), a)
        const mx = (p.x + q.x) / 2
        const my = (p.y + q.y) / 2
        let nx = -(q.y - p.y) * 0.12
        let ny = (q.x - p.x) * 0.12
        const ca = L.centerOf.get(from)
        if (ca && ca === L.centerOf.get(to)) {
          const far = Math.hypot(mx - ca.x, my - ca.y) > 20
          const ox = far ? mx - ca.x : 0
          const oy = far ? my - ca.y : -1
          const k = (Math.hypot(q.x - p.x, q.y - p.y) * 0.6) / Math.hypot(ox, oy)
          nx = ox * k
          ny = oy * k
        }
        line.path.setAttribute('d', `M${p.x},${p.y} Q${mx + nx},${my + ny} ${q.x},${q.y}`)
        line.label?.setAttribute('x', String(mx + nx / 2))
        line.label?.setAttribute('y', String(my + ny / 2 - 6))
      }
      const c = cam.current
      c.x += (c.tx - c.x) * CAM_EASE
      c.y += (c.ty - c.y) * CAM_EASE
      c.z += (c.tz - c.z) * CAM_EASE
      if (Math.abs(c.tx - c.x) < CAM_SNAP && Math.abs(c.ty - c.y) < CAM_SNAP) {
        c.x = c.tx
        c.y = c.ty
      }
      if (Math.abs(c.tz - c.z) < 0.0005) c.z = c.tz
      const ruler = rulerRef.current
      if (ruler) {
        ruler.style.setProperty('--cx', `${c.x}px`)
        ruler.style.setProperty('--z', String(c.z))
        ruler.classList.toggle('cv-ruler-fine', c.z * 15 * PX_PER_MIN >= 70)
      }
      const pct = `${Math.round(c.z * 100)}%`
      if (zoomPctRef.current && zoomPctRef.current.textContent !== pct)
        zoomPctRef.current.textContent = pct
      if (worldRef.current) {
        worldRef.current.style.transform = `translate(${c.x}px,${c.y}px) scale(${c.z})`
        worldRef.current.style.setProperty('--iz', String(1 / c.z))
      }
      if (stageRef.current) {
        stageRef.current.style.backgroundPosition = `${c.x}px ${c.y}px`
        stageRef.current.style.backgroundSize = `${26 * c.z}px ${26 * c.z}px`
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  useLayoutEffect(() => {
    const el = stageRef.current
    if (!el) return
    const measure = (): void => {
      const r = el.getBoundingClientRect()
      if (r.width) Object.assign(stageBox, { w: r.width, h: r.height })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  // read live: a cached offset went stale inside the main window and shifted every pick by the sidebar width
  const origin = (): Point => {
    const r = stageRef.current?.getBoundingClientRect()
    return { x: r?.left ?? 0, y: r?.top ?? 0 }
  }

  /* ---------- camera ---------- */
  const toWorld = (sx: number, sy: number): Point => {
    const o = origin()
    return {
      x: (sx - o.x - cam.current.tx) / cam.current.tz,
      y: (sy - o.y - cam.current.ty) / cam.current.tz
    }
  }
  const toWorldNow = (sx: number, sy: number): Point => {
    const o = origin()
    return {
      x: (sx - o.x - cam.current.x) / cam.current.z,
      y: (sy - o.y - cam.current.y) / cam.current.z
    }
  }
  type Box = { x: number; y: number; hw: number; hh: number }
  const fitTo = useCallback((pts: Box[], onlyIfNeeded = false, minZoom = 0.3, newest = false) => {
    if (!pts.length) return
    const x0 = Math.min(...pts.map((p) => p.x - p.hw))
    const x1 = Math.max(...pts.map((p) => p.x + p.hw))
    const y0 = Math.min(...pts.map((p) => p.y - p.hh))
    const y1 = Math.max(...pts.map((p) => p.y + p.hh))
    const W = stageBox.w
    const H = stageBox.h - 180
    const c = cam.current
    if (
      onlyIfNeeded &&
      x0 * c.tz + c.tx >= 20 &&
      x1 * c.tz + c.tx <= W - 20 &&
      y0 * c.tz + c.ty >= 60 &&
      y1 * c.tz + c.ty <= 60 + H
    )
      return
    const z = Math.min(
      FIT_MAX_ZOOM,
      Math.max(
        minZoom,
        Math.min((W - 80) / (x1 - x0), (H - 40) / (y1 - y0)) * (onlyIfNeeded ? 1 : FIT_ROOM)
      )
    )
    Object.assign(c, {
      tz: z,
      tx:
        (x1 - x0) * z > W - 80
          ? newest
            ? W - 40 - x1 * z
            : 40 - x0 * z
          : W / 2 - ((x0 + x1) / 2) * z,
      ty: (y1 - y0) * z > H - 40 ? 60 + H - 20 - y1 * z : 60 + H / 2 - ((y0 + y1) / 2) * z
    })
  }, [])
  const planetBoxes = useCallback((only?: string): Box[] => {
    const L = layoutRef.current
    return [...L.planets.values()]
      .filter((p) => !only || p.id === only)
      .map((p) => {
        const box = L.boxes?.get(p.id)
        if (box) return box
        const r = planetReach(p, (L.members.get(p.id) ?? []).map(L.sizeOf))
        return { x: p.x, y: p.y, hw: r.w, hh: r.h }
      })
  }, [])
  const hubBox = useCallback((): Box => {
    const h = layoutRef.current.hub
    return { x: h.x, y: h.y, hw: HUB.w / 2 + 30, hh: HUB.h / 2 + 30 }
  }, [])
  const fitAll = useCallback(
    (onlyIfNeeded = false, minZoom?: number) =>
      fitTo(
        [
          ...(layoutRef.current.boxes ? [] : [hubBox()]),
          ...planetBoxes(),
          ...(layoutRef.current.marks.length ? [{ x: 0, y: -RULER_ROOM, hw: 1, hh: 1 }] : [])
        ],
        onlyIfNeeded,
        minZoom ??
          (layoutRef.current.marks.length
            ? TIME_MIN_ZOOM
            : layoutRef.current.boxes
              ? MAP_MIN_ZOOM
              : undefined),
        layoutRef.current.marks.length > 0
      ),
    [fitTo, planetBoxes, hubBox]
  )
  const allOnScreen = (): boolean => {
    const L = layoutRef.current
    const c = cam.current
    return [...L.shown, ...L.planets.keys()].every((id) => {
      const t = L.targets.get(id) ?? L.planets.get(id)
      if (!t) return true
      const s = L.sizeOf(id)
      const x = t.x * c.tz + c.tx
      const y = t.y * c.tz + c.ty
      const hw = (s.w / 2) * c.tz
      const hh = (s.h / 2) * c.tz
      return x - hw >= 10 && x + hw <= stageBox.w - 10 && y - hh >= 56 && y + hh <= stageBox.h - 120
    })
  }
  const sized = Object.keys(sizes).length > 0
  useEffect(() => {
    if (focusId || zoomPlanet || planetDrag || !sized) return
    if (!fitted.current) {
      fitted.current = true
      fitAll()
    } else if (autoFit.current && !allOnScreen()) {
      if (view === 'space' || !card) fitAll()
    }
  }, [layout, focusId, zoomPlanet, planetDrag, sized, fitAll, view, card])
  useEffect(() => {
    if (zoomPlanet && !planetDrag)
      fitTo(
        [hubBox(), ...planetBoxes(zoomPlanet)],
        false,
        layoutRef.current.boxes ? MAP_MIN_ZOOM : undefined
      )
  }, [zoomPlanet, planetDrag, layout, fitTo, planetBoxes, hubBox])
  useEffect(() => {
    if (!focusId) return
    const ids = [
      focusId,
      ...canvas.bubbles.filter((b) => b.parent === focusId).map((b) => b.id),
      'dir:0',
      'dir:1',
      'dir:2',
      'done'
    ]
    fitTo(
      ids
        .map((id) => ({ t: layout.targets.get(id), s: layout.sizeOf(id) }))
        .filter((x): x is { t: Point; s: Size } => x.t !== undefined)
        .map(({ t, s }) => ({ x: t.x, y: t.y, hw: s.w / 2 + 40, hh: s.h / 2 + 40 }))
    )
  }, [focusId, layout, canvas.bubbles, fitTo])
  const switchView = (next: View): void => {
    prevPlanets.current = undefined
    autoFit.current = true
    fitted.current = false
    setView(next)
    try {
      localStorage.setItem(VIEW_KEY, next)
    } catch {
      return
    }
  }
  const fitNow = useCallback((): void => {
    prevPlanets.current = undefined
    if (focusId) return
    autoFit.current = false
    if (zoomPlanet)
      fitTo(
        [hubBox(), ...planetBoxes(zoomPlanet)],
        false,
        FIT_MIN_ZOOM
      )
    else fitAll(false, FIT_MIN_ZOOM)
  }, [focusId, zoomPlanet, fitTo, hubBox, planetBoxes, fitAll])
  const zoomBy = (factor: number): void => {
    const c = cam.current
    const z = Math.min(1.8, Math.max(0.3, c.tz * factor))
    const cx = stageBox.w / 2
    const cy = stageBox.h / 2
    autoFit.current = false
    Object.assign(c, {
      tx: cx - (cx - c.tx) * (z / c.tz),
      ty: cy - (cy - c.ty) * (z / c.tz),
      tz: z
    })
  }
  const openBubble = useCallback((b: CanvasBubble): void => {
    if (b.codeRef) dispatchEvent(new CustomEvent(OPEN_CODE_EVENT, { detail: b.codeRef }))
    else if (b.sessionId) void window.api.mighty.open(false, b.sessionId)
  }, [])

  /* ---------- thread: three next moves, pick one, repeat ---------- */
  const fetchDirections = useCallback(
    async (rootId: string) => {
      const root = canvasRef.current.bubbles.find((b) => b.id === rootId)
      if (!root) return
      setDirFail(null)
      const steps = canvasRef.current.bubbles.filter((x) => x.parent === rootId).map((x) => x.text)
      const r = await window.api.canvas.directions(root.text, steps)
      if (!r.ok) {
        setDirFail(rootId)
        return
      }
      quiet((c) => ({
        ...c,
        bubbles: c.bubbles.map((x) => (x.id === rootId ? { ...x, directions: r.directions } : x))
      }))
    },
    [quiet]
  )
  const pickDirection = useCallback(
    (rootId: string, text: string) => {
      const root = canvasRef.current.bubbles.find((b) => b.id === rootId)
      if (!root) return
      const step: CanvasBubble = {
        id: uid(),
        kind: 'step',
        text,
        planet: root.planet,
        tags: localTags(text),
        by: 'you',
        created: now(),
        parent: rootId
      }
      const prevId =
        canvasRef.current.bubbles.filter((b) => b.parent === rootId).at(-1)?.id ?? rootId
      update((c) => ({
        ...c,
        bubbles: [...c.bubbles.map((b) => (b.id === rootId ? { ...b, directions: [] } : b)), step],
        links: [...c.links, { id: uid(), from: prevId, to: step.id, why: '', by: 'you' }]
      }))
      void fetchDirections(rootId)
    },
    [update, fetchDirections]
  )
  const openThread = (b: CanvasBubble): void => {
    if (b.parent || b.kind === 'thread') return
    setCard(null)
    setFocusId(b.id)
    if (!b.directions?.length && !b.done) void fetchDirections(b.id)
  }

  const removeIds = useCallback(
    (ids: Set<string>): void => {
      if (!ids.size) return
      if (card && ids.has(card.bubbleId)) setCard(null)
      update((c) => ({
        ...c,
        bubbles: c.bubbles.filter((b) => !ids.has(b.id) && !ids.has(b.parent ?? '')),
        links: c.links.filter((l) => !ids.has(l.from) && !ids.has(l.to)),
        strokes: (c.strokes ?? []).filter((st) => !ids.has(st.id))
      }))
      setPicked(new Set())
      setToast({ id: Date.now(), text: ids.size === 1 ? 'Removed 1 item' : `Removed ${ids.size} items` })
    },
    [card, setCard, update]
  )
  const removeBubble = (id: string): void => removeIds(new Set([id]))

  /* ---------- gestures ---------- */
  const panFrom = (sx: number, sy: number, onClick?: () => void): void => {
    const ox = cam.current.tx
    const oy = cam.current.ty
    let moved = false
    const move = (m: PointerEvent): void => {
      if (Math.hypot(m.clientX - sx, m.clientY - sy) > DRAG_START_PX) moved = true
      if (!moved) return
      autoFit.current = false
      stageRef.current?.classList.add('cv-panning')
      Object.assign(cam.current, {
        tx: ox + m.clientX - sx,
        ty: oy + m.clientY - sy,
        x: ox + m.clientX - sx,
        y: oy + m.clientY - sy
      })
    }
    const up = (): void => {
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', up)
      stageRef.current?.classList.remove('cv-panning')
      if (!moved) onClick?.()
    }
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
  }
  const track = (move: (w: Point) => void, done: () => void): void => {
    const onMove = (m: PointerEvent): void => move(toWorldNow(m.clientX, m.clientY))
    const up = (): void => {
      removeEventListener('pointermove', onMove)
      removeEventListener('pointerup', up)
      done()
    }
    addEventListener('pointermove', onMove)
    addEventListener('pointerup', up)
  }
  const pickIn = (r: Rect): Set<string> => {
    const L = layoutRef.current
    const ids = new Set<string>()
    for (const id of L.shown) {
      const p = pos.current.get(id)
      const z = L.sizeOf(id)
      if (p && boxInRect(p, z.w / 2, z.h / 2, r)) ids.add(id)
    }
    for (const st of canvasRef.current.strokes ?? []) if (strokeInRect(st, r)) ids.add(st.id)
    return ids
  }
  const copyBubbles = useCallback(
    (ids: string[]): Promise<boolean> => {
      const text = canvasRef.current.bubbles
        .filter((b) => ids.includes(b.id))
        .map((b) =>
          b.kind === 'answer'
            ? answerText(fullAnswer(b.text, b.sessionId ? sessionById.get(b.sessionId) : undefined))
            : b.text
        )
        .join('\n\n')
      if (!text) return Promise.resolve(false)
      return navigator.clipboard.writeText(text).then(
        () => true,
        () => false
      )
    },
    [sessionById]
  )

  const deletePicked = useCallback((): void => removeIds(picked), [picked, removeIds])
  useEffect(() => setPicked(new Set()), [view, focusId, zoomPlanet, folded])

  const onStageDown = (e: React.PointerEvent): void => {
    if (
      e.target !== stageRef.current &&
      e.target !== worldRef.current &&
      !(e.target instanceof SVGElement)
    )
      return
    const sx = e.clientX
    const sy = e.clientY
    const start = toWorldNow(sx, sy)
    if (tool === 'hand' || spaceHeld || e.button === 1) return panFrom(sx, sy)
    if (e.button !== 0) return
    if (tool === 'pen') {
      const pts = [start.x, start.y]
      setLiveStroke(pts)
      return track(
        (w) => {
          const lx = pts[pts.length - 2]
          const ly = pts[pts.length - 1]
          if (Math.hypot(w.x - lx, w.y - ly) * cam.current.z < 2) return
          pts.push(Math.round(w.x * 10) / 10, Math.round(w.y * 10) / 10)
          setLiveStroke([...pts])
        },
        () => {
          setLiveStroke(null)
          update((c) => ({
            ...c,
            strokes: [...(c.strokes ?? []), { id: uid(), points: pts, ink }]
          }))
        }
      )
    }
    if (tool === 'eraser') {
      const gone = new Set<string>()
      const rub = (w: Point): void => {
        const r = ERASE_PX / cam.current.z
        for (const st of canvasRef.current.strokes ?? [])
          if (!gone.has(st.id) && strokeNear(st, w, r)) gone.add(st.id)
        setErasing(new Set(gone))
      }
      rub(start)
      return track(rub, () => {
        setErasing(new Set())
        if (gone.size)
          update((c) => ({ ...c, strokes: (c.strokes ?? []).filter((st) => !gone.has(st.id)) }))
      })
    }
    let dragging = false
    track(
      (w) => {
        if (!dragging && Math.hypot(w.x - start.x, w.y - start.y) * cam.current.z < DRAG_START_PX)
          return
        dragging = true
        const r = normRect(start, w)
        setMarquee(r)
        setPicked(pickIn(r))
      },
      () => {
        setMarquee(null)
        if (dragging) return
        if (picked.size) setPicked(new Set())
        else if (plusMenu) setPlusMenu(null)
        else if (moveMenu) setMoveMenu(null)
        else if (focusId) setFocusId(null)
        else if (card) setCard(null)
        else if (zoomPlanet) setZoomPlanet(null)
      }
    )
  }
  const onStageDoubleClick = (e: React.MouseEvent): void => {
    if (
      tool !== 'select' ||
      (e.target !== stageRef.current &&
        e.target !== worldRef.current &&
        !(e.target instanceof SVGElement))
    )
      return
    setWriting({ at: toWorld(e.clientX, e.clientY) })
  }

  const hitBubble = (id: string, at: Point): string | null => {
    for (const b of canvasRef.current.bubbles) {
      if (b.id === id || b.parent || !els.current.has(b.id)) continue
      const p = pos.current.get(b.id)
      const s = layoutRef.current.sizeOf(b.id)
      if (p && Math.abs(p.x - at.x) < s.w / 2 && Math.abs(p.y - at.y) < s.h / 2) return b.id
    }
    return null
  }
  const hitPlanet = (at: Point): string | null => {
    const L = layoutRef.current
    for (const p of L.planets.values()) {
      const box = L.boxes?.get(p.id)
      if (box) {
        if (Math.abs(at.x - box.x) < box.hw && Math.abs(at.y - box.y) < box.hh) return p.id
        continue
      }
      const r = planetReach(p, (L.members.get(p.id) ?? []).map(L.sizeOf))
      if (Math.abs(at.x - p.x) < r.w && Math.abs(at.y - p.y) < r.h) return p.id
    }
    return null
  }

  const onPlanetDown = (id: string) => (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    const spot = layoutRef.current.planets.get(id)
    if (!spot) return
    const w0 = toWorldNow(e.clientX, e.clientY)
    const grab = { x: w0.x - spot.x, y: w0.y - spot.y }
    const start = { x: e.clientX, y: e.clientY }
    let dragging = false
    let last: Point = { x: spot.x, y: spot.y }
    const move = (m: PointerEvent): void => {
      if (view !== 'space') return
      if (!dragging && Math.hypot(m.clientX - start.x, m.clientY - start.y) < DRAG_START_PX) return
      dragging = true
      const w = toWorldNow(m.clientX, m.clientY)
      last = { x: w.x - grab.x, y: w.y - grab.y }
      setPlanetDrag({ id, at: last })
    }
    const up = (): void => {
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', up)
      if (!dragging) {
        setCard(null)
        setZoomPlanet((z) => (z === id ? null : id))
        hubRef.current?.focus()
        return
      }
      setPlanetDrag(null)
      update((c) => ({
        ...c,
        places: { ...c.places, [id]: { x: Math.round(last.x), y: Math.round(last.y) } }
      }))
    }
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
  }

  const onBubbleDown = (b: CanvasBubble) => (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('[data-no-drag]')) return
    e.stopPropagation()
    const start = { x: e.clientX, y: e.clientY }
    const origin = pos.current.get(b.id) ?? { x: 0, y: 0 }
    const w0 = toWorldNow(e.clientX, e.clientY)
    const grab = { x: w0.x - origin.x, y: w0.y - origin.y }
    let target: { bubble?: string; planet?: string } = {}
    const move = (m: PointerEvent): void => {
      if (!drag.current && Math.hypot(m.clientX - start.x, m.clientY - start.y) < DRAG_START_PX)
        return
      const w = toWorldNow(m.clientX, m.clientY)
      const at = { x: w.x - grab.x, y: w.y - grab.y }
      const group = drag.current?.group ?? new Map<string, Point>()
      if (!drag.current && picked.has(b.id))
        for (const id of picked) {
          const p = pos.current.get(id)
          if (id !== b.id && p) group.set(id, { x: p.x - origin.x, y: p.y - origin.y })
        }
      drag.current = { id: b.id, at, group }
      els.current.get(b.id)?.classList.add('cv-drag')
      const overB = hitBubble(b.id, at)
      const overP = overB ? null : hitPlanet(at)
      target = {
        bubble: overB ?? undefined,
        planet: overP && overP !== b.planet ? overP : undefined
      }
      setHot(target.bubble ?? target.planet ?? null)
    }
    const up = (): void => {
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', up)
      els.current.get(b.id)?.classList.remove('cv-drag')
      const wasDrag = drag.current !== null
      const moved = drag.current ? [b.id, ...(drag.current.group?.keys() ?? [])] : []
      drag.current = null
      justDragged.current = wasDrag
      setHot(null)
      if (!wasDrag) return
      if (target.bubble) {
        const to = target.bubble
        update((c) =>
          c.links.some((l) => (l.from === b.id && l.to === to) || (l.from === to && l.to === b.id))
            ? c
            : {
                ...c,
                links: [
                  ...c.links,
                  { id: uid(), from: b.id, to, why: 'you linked these', by: 'you' }
                ]
              }
        )
      } else if (target.planet && !b.parent) {
        const group = picked.has(b.id) ? [...picked] : [b.id]
        for (const id of group)
          if (canvasRef.current.bubbles.some((x) => x.id === id && !x.parent))
            dispatcher.moveTo(id, target.planet)
      } else {
        autoFit.current = false
        const spots = new Map(
          moved.flatMap((id) => {
            const p = pos.current.get(id)
            return p ? [[id, { x: Math.round(p.x), y: Math.round(p.y) }] as const] : []
          })
        )
        update((c) => ({
          ...c,
          bubbles: c.bubbles.map((x) => (spots.has(x.id) ? { ...x, at: spots.get(x.id) } : x))
        }))
      }
    }
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
  }

  const onResize = (b: CanvasBubble) => (e: React.PointerEvent) => {
    e.stopPropagation()
    const el = els.current.get(b.id)
    if (!el) return
    const w0 = el.offsetWidth
    const body = el.querySelector<HTMLElement>('.cv-answer-body')
    const h0 = body?.offsetHeight ?? 0
    const x0 = e.clientX
    const y0 = e.clientY
    let w = w0
    let h = b.h
    const move = (m: PointerEvent): void => {
      w = Math.round(Math.min(720, Math.max(120, w0 + (m.clientX - x0) / cam.current.z)))
      el.style.width = `${w}px`
      el.style.maxWidth = 'none'
      if (body) {
        h = Math.round(Math.min(900, Math.max(80, h0 + (m.clientY - y0) / cam.current.z)))
        body.style.maxHeight = `${h}px`
      }
    }
    const up = (): void => {
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', up)
      const at = pos.current.get(b.id)
      update((c) => ({
        ...c,
        bubbles: c.bubbles.map((x) =>
          x.id === b.id
            ? {
                ...x,
                w,
                h,
                at: x.at ?? (at ? { x: Math.round(at.x), y: Math.round(at.y) } : undefined)
              }
            : x
        )
      }))
    }
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
  }
  const tidy = (): void => {
    update((c) => ({
      ...c,
      places: undefined,
      bubbles: c.bubbles.map((x) => ({ ...x, at: undefined, w: undefined, h: undefined }))
    }))
    for (const el of els.current.values()) {
      el.style.width = ''
      el.style.maxWidth = ''
    }
  }
  const messy =
    canvas.bubbles.some((b) => b.at || b.w || b.h) ||
    (view === 'space' && !!Object.keys(canvas.places ?? {}).length)

  const branchFrom = (b: CanvasBubble, kind: 'ask' | 'note' | 'task'): void => {
    setPlusMenu(null)
    const p = pos.current.get(b.id) ?? { x: 0, y: 0 }
    setWriting({
      at: { x: p.x + layoutRef.current.sizeOf(b.id).w / 2 + 170, y: p.y },
      onDone: (text) => text && dispatcher.branch(b.id, text, kind)
    })
  }
  const onPlusDown = (b: CanvasBubble) => (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    const start = { x: e.clientX, y: e.clientY }
    let dragging = false
    let last: { to: Point; over?: string } | null = null
    const move = (m: PointerEvent): void => {
      if (!dragging && Math.hypot(m.clientX - start.x, m.clientY - start.y) < DRAG_START_PX) return
      dragging = true
      const to = toWorldNow(m.clientX, m.clientY)
      last = { to, over: hitBubble(b.id, to) ?? undefined }
      setPull({ from: b.id, ...last })
    }
    const up = (): void => {
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', up)
      setPull(null)
      if (!dragging || !last) {
        setPlusMenu((m) => (m === b.id ? null : b.id))
        return
      }
      const { to, over } = last
      if (over) {
        update((c) =>
          c.links.some(
            (l) => (l.from === b.id && l.to === over) || (l.from === over && l.to === b.id)
          )
            ? c
            : { ...c, links: [...c.links, { id: uid(), from: b.id, to: over, why: '', by: 'you' }] }
        )
        return
      }
      autoFit.current = false
      setWriting({
        at: to,
        onDone: (text) =>
          text && dispatcher.branch(b.id, text, /\?\s*$/.test(text) ? 'ask' : 'note', to)
      })
    }
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
  }
  const toggleTask = (id: string): void =>
    update((c) => ({
      ...c,
      bubbles: c.bubbles.map((x) => (x.id === id ? { ...x, done: !x.done } : x))
    }))

  const onBubbleClick = (b: CanvasBubble): void => {
    if (justDragged.current) {
      justDragged.current = false
      return
    }
    setPicked((p) => (p.size === 1 && p.has(b.id) ? new Set() : new Set([b.id])))
  }

  const showBoard = useCallback(
    (next: CanvasState) => {
      canvasRef.current = next
      setCanvas(next)
      setCard(null)
      setFocusId(null)
      setZoomPlanet(null)
      setWriting(null)
      setPending({})
      prevPlanets.current = undefined
      undoStack.current = []
      redoStack.current = []
      fitted.current = false
      autoFit.current = true
      void window.api.canvas.boards().then(setBoards)
      hubRef.current?.focus()
    },
    [setCard]
  )
  const startNew = useCallback(() => void window.api.canvas.startNew().then(showBoard), [showBoard])
  const openBoard = useCallback(
    (id: string) => void window.api.canvas.open(id).then(showBoard),
    [showBoard]
  )
  useEffect(() => {
    const onFocus = (): void => {
      if (!writing) hubRef.current?.focus()
      void window.api.canvas.boards().then(setBoards)
    }
    addEventListener('focus', onFocus)
    return () => removeEventListener('focus', onFocus)
  }, [writing])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        startNew()
        return
      }
      const typing = (document.activeElement as HTMLElement | null)?.isContentEditable
      const hubEmpty = !hubRef.current?.textContent
      if (
        e.metaKey &&
        e.key.toLowerCase() === 'z' &&
        (!typing || (document.activeElement === hubRef.current && hubEmpty))
      ) {
        e.preventDefault()
        stepHistory(!e.shiftKey)
        return
      }
      const hubIdle = !typing || (document.activeElement === hubRef.current && hubEmpty)
      if (e.key === ' ' && hubIdle && !writing) {
        e.preventDefault()
        if (!e.repeat) setSpaceHeld(true)
        return
      }
      if (
        e.metaKey &&
        e.key.toLowerCase() === 'c' &&
        hubIdle &&
        picked.size &&
        !getSelection()?.toString()
      ) {
        e.preventDefault()
        void copyBubbles([...picked])
        return
      }
      if (e.metaKey && e.key.toLowerCase() === 'a' && hubIdle && !writing) {
        e.preventDefault()
        setPicked(new Set(layoutRef.current.shown))
        return
      }
      if (e.key === '!' && e.shiftKey && hubIdle && !writing) {
        e.preventDefault()
        fitNow()
        return
      }
      if (e.key === 'Enter' && hubIdle && hubEmpty && picked.size === 1) {
        const one = canvasRef.current.bubbles.find((b) => picked.has(b.id))
        if (one?.sessionId || one?.codeRef) {
          e.preventDefault()
          openBubble(one)
          return
        }
      }
      if ((e.key === 'Backspace' || e.key === 'Delete') && hubIdle && picked.size) {
        e.preventDefault()
        deletePicked()
        return
      }
      if (e.key === 'Escape' && (picked.size || tool !== 'select')) {
        setPicked(new Set())
        setTool('select')
        return
      }
      if (e.key === 'Escape') {
        if (plusMenu) setPlusMenu(null)
        else if (moveMenu) setMoveMenu(null)
        else if (writing) setWriting(null)
        else if (card) setCard(null)
        else if (focusId) setFocusId(null)
        else if (zoomPlanet) setZoomPlanet(null)
        else if (toast) setToast(null)
        return
      }
      if (
        (document.activeElement as HTMLElement | null)?.isContentEditable ||
        e.metaKey ||
        e.ctrlKey ||
        e.altKey ||
        e.key.length !== 1
      )
        return
      if (!writing) hubRef.current?.focus()
    }
    const onPaste = (e: ClipboardEvent): void => {
      const el = document.activeElement as HTMLElement | null
      if (e.clipboardData && (el === hubRef.current || !el?.isContentEditable) && hubAttach.paste(e.clipboardData)) {
        e.preventDefault()
        hubRef.current?.focus()
        return
      }
      if (el?.isContentEditable) return
      const text = e.clipboardData?.getData('text').trim()
      const hub = hubRef.current
      if (!text || !hub) return
      e.preventDefault()
      hub.textContent = text.slice(0, 600)
      hub.focus()
      getSelection()?.selectAllChildren(hub)
      getSelection()?.collapseToEnd()
    }
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.key === ' ') setSpaceHeld(false)
    }
    if (!active) return
    addEventListener('keydown', onKey)
    addEventListener('keyup', onKeyUp)
    addEventListener('paste', onPaste)
    return () => {
      removeEventListener('keydown', onKey)
      removeEventListener('keyup', onKeyUp)
      removeEventListener('paste', onPaste)
    }
  }, [
    writing,
    card,
    focusId,
    zoomPlanet,
    moveMenu,
    plusMenu,
    file,
    setCard,
    startNew,
    stepHistory,
    picked,
    tool,
    active,
    deletePicked,
    copyBubbles,
    hubAttach.paste,
    toast,
    fitNow,
    openBubble
  ])

  const addSession = (ref: CanvasSessionRef, at: Point): void => {
    const have = canvasRef.current.bubbles.find((b) =>
      ref.kind === 'chat'
        ? b.sessionId === ref.id && b.kind !== 'answer'
        : b.codeRef === ref.id
    )
    if (have) {
      setArrive(have.id)
      window.setTimeout(() => setArrive(null), ARRIVE_MS)
      const p = pos.current.get(have.id)
      if (p) panInto(cam.current, p, layoutRef.current.sizeOf(have.id))
      return
    }
    const s = ref.kind === 'chat' ? sessionById.get(ref.id) : undefined
    const projectId =
      ref.kind === 'chat' ? s?.projectId : mightyProjectForCwd(ref.cwd, projects)?.id
    const b: CanvasBubble = {
      id: uid(),
      kind: 'thread',
      text: ref.kind === 'chat' ? chatTitle(s) : ref.title,
      planet: projectId && projectById.has(projectId) ? projectId : CANVAS_SANDBOX,
      tags: [],
      by: 'you',
      created: now(),
      ...(ref.kind === 'chat' ? { sessionId: ref.id } : { codeRef: ref.id }),
      at: { x: Math.round(at.x), y: Math.round(at.y) }
    }
    pos.current.set(b.id, { ...at })
    autoFit.current = false
    update((c) => ({ ...c, bubbles: [...c.bubbles, b] }))
  }
  const viewCenter = (): Point => {
    const o = origin()
    return toWorld(o.x + stageBox.w / 2, o.y + stageBox.h / 2 - 60)
  }

  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    setDropping(false)
    setDropOn(null)
    const dragged = readSessionDrag(e.dataTransfer)
    if (dragged) return addSession(dragged, toWorld(e.clientX, e.clientY))
    if (!e.dataTransfer.types.includes('Files') && !e.dataTransfer.types.includes('text/plain'))
      return
    const onto = hitPlanet(toWorldNow(e.clientX, e.clientY))
    if (onto) {
      setCard(null)
      setZoomPlanet(onto)
    }
    const hub = hubRef.current
    if (!hubAttach.addFiles([...e.dataTransfer.files]) && hub)
      hub.textContent =
        `${hub.textContent ?? ''} ${e.dataTransfer.getData('text').trim().slice(0, 600)}`.trim()
    if (!hub) return
    hub.focus()
    getSelection()?.selectAllChildren(hub)
    getSelection()?.collapseToEnd()
  }

  const submitHub = (typed: string): void => {
    const files = hubFiles
    hubAttach.clear()
    const image = files.find((f) => f.kind === 'image')
    const extra: Partial<CanvasBubble> = files.length
      ? { attachments: files, imagePath: image?.path, ...(typed ? {} : { kind: 'file' }) }
      : {}
    const text = typed || files.map((f) => (f.name ?? '').replace(/[-_]/g, ' ')).join(', ')
    file(text, layoutRef.current.hub, extra, zoomPlanet ?? undefined)
  }

  /* ---------- render ---------- */
  const focus = focusId ? canvas.bubbles.find((b) => b.id === focusId) : undefined
  const inFocus = (b: CanvasBubble): boolean => !focusId || b.id === focusId || b.parent === focusId
  const inCard = new Set(
    card?.answer
      ? canvas.links.filter((l) => l.from === card.bubbleId && l.why === 'answer').map((l) => l.to)
      : []
  )
  const rendered = canvas.bubbles.filter((b) =>
    b.parent ? b.parent === focusId : layout.shown.has(b.id) && !inCard.has(b.id)
  )
  const renderedIds = new Set(rendered.map((b) => b.id))
  const visibleLinks = canvas.links.filter((l) => {
    if (!renderedIds.has(l.from) || !renderedIds.has(l.to)) return false
    const a = canvas.bubbles.find((b) => b.id === l.from)!
    const b = canvas.bubbles.find((x) => x.id === l.to)!
    if (
      layout.branches.some(
        (x) => x.chat && [x.from, x.to].includes(l.from) && [x.from, x.to].includes(l.to)
      )
    )
      return false
    return focusId ? inFocus(a) && inFocus(b) : !a.parent && !b.parent
  })
  const bindEl = (id: string, el: HTMLDivElement | null): void => {
    const prev = els.current.get(id)
    if (prev && prev !== el) observer.unobserve(prev)
    if (el) {
      if (!popped.current.has(el)) {
        popped.current.add(el)
        el.animate(
          [{ scale: 0.4, opacity: 0 }, { scale: 1.08, opacity: 1, offset: 0.6 }, { scale: 1 }],
          {
            duration: 520,
            easing: 'cubic-bezier(.34,1.56,.64,1)'
          }
        )
      }
      el.dataset.cvId = id
      els.current.set(id, el)
      observer.observe(el)
    } else els.current.delete(id)
  }
  const bindHub = useCallback((el: HTMLDivElement | null) => {
    hubRef.current = el
  }, [])
  const bindZoomPct = useCallback((el: HTMLSpanElement | null) => {
    zoomPctRef.current = el
  }, [])
  const hideToast = useCallback(() => setToast(null), [])
  const bindBlob = (id: string, el: SVGRectElement | null): void => {
    if (el) blobEls.current.set(id, el)
    else blobEls.current.delete(id)
  }
  const bindLine = (
    key: string,
    part: 'path' | 'label',
    el: SVGPathElement | SVGTextElement | null
  ): void => {
    const cur = lineEls.current.get(key) ?? { path: null, label: null }
    if (part === 'path') cur.path = el as SVGPathElement | null
    else cur.label = el as SVGTextElement | null
    if (!cur.path && !cur.label) lineEls.current.delete(key)
    else lineEls.current.set(key, cur)
  }
  const steps = (id: string): CanvasBubble[] => canvas.bubbles.filter((b) => b.parent === id)
  const lit = (from: string, to: string): boolean =>
    !!hoverId && (from === hoverId || to === hoverId)
  const near = new Set(
    hoverId
      ? canvas.links.flatMap((l) =>
          l.from === hoverId ? [l.to] : l.to === hoverId ? [l.from] : []
        )
      : []
  )
  const pulsing = new Set(
    canvas.links
      .filter((l) => freshLinks.has(l.id) && l.by === 'ai' && l.why && l.why !== 'answer')
      .flatMap((l) => [l.from, l.to])
  )
  const pickedBubbles = rendered.filter((b) => picked.has(b.id))
  const pickedRoots = pickedBubbles.filter((b) => !b.parent)
  const pickedOne = picked.size === 1 ? pickedBubbles[0] : undefined
  const pickTop = pickedBubbles.length
    ? pickedBubbles.reduce(
        (acc, b) => {
          const t = layout.targets.get(b.id) ?? pos.current.get(b.id)
          if (!t) return acc
          const s = layout.sizeOf(b.id)
          return {
            x0: Math.min(acc.x0, t.x - s.w / 2),
            x1: Math.max(acc.x1, t.x + s.w / 2),
            y: Math.min(acc.y, t.y - s.h / 2)
          }
        },
        { x0: Infinity, x1: -Infinity, y: Infinity }
      )
    : null
  const pickAt =
    pickTop && Number.isFinite(pickTop.y) ? { x: (pickTop.x0 + pickTop.x1) / 2, y: pickTop.y } : null
  const chips = candidatePlanets.slice(0, CARD_CHIPS).map((id) => ({ id, name: planetName(id) }))
  const cardBubble = card ? canvas.bubbles.find((b) => b.id === card.bubbleId) : undefined
  const connectedName = zoomPlanet ? planetName(zoomPlanet) : ''
  const examples = zoomPlanet
    ? [`Ask ${connectedName} anything`, `Try: a next step for ${connectedName}`]
    : [
        "What's on your mind?",
        ...chips
          .filter((c) => c.id !== CANVAS_SANDBOX)
          .slice(0, 2)
          .map((c, i) =>
            i === 0 ? `Try: an idea for ${c.name}` : `Try: a question about ${c.name}`
          ),
        'Try: anything - it finds the right place'
      ]
  const hint =
    tool === 'pen'
      ? 'Draw anywhere. Esc goes back to selecting.'
      : tool === 'eraser'
        ? 'Drag over a drawing to erase it. Esc goes back to selecting.'
        : tool === 'hand'
          ? 'Drag to move around. Esc goes back to selecting.'
          : picked.size
            ? 'Drag onto a project to move, or onto another bubble to link.'
            : focusId
              ? 'Pick a next step, or edit one with the pencil. Esc goes back.'
              : zoomPlanet
                ? `Anything you type goes into ${connectedName}. Click empty space to step out.`
                : roots.length === 0
                  ? 'Type below, or drop a file or a chat anywhere here.'
                  : layout.hidden.size
                    ? 'Showing the newest notes. Click a project to see all of it.'
                    : 'Click a project to talk to just that one. Double-click empty space to write there.'

  return (
    <div
      ref={stageRef}
      className={`cv-stage cv-v-${view} ${spaceHeld || tool === 'hand' ? 'cv-tool-hand' : ''} ${tool === 'pen' ? 'cv-tool-pen' : ''} ${tool === 'eraser' ? 'cv-tool-eraser' : ''}`}
      onPointerDown={onStageDown}
      onDoubleClick={onStageDoubleClick}
      onWheel={(e) => {
        const c = cam.current
        autoFit.current = false
        if (e.ctrlKey || e.metaKey) {
          const z = Math.min(1.8, Math.max(0.3, c.tz * Math.exp(-e.deltaY * 0.01)))
          const o = origin()
          Object.assign(c, {
            tx: e.clientX - o.x - (e.clientX - o.x - c.tx) * (z / c.tz),
            ty: e.clientY - o.y - (e.clientY - o.y - c.ty) * (z / c.tz),
            tz: z
          })
        } else Object.assign(c, { tx: c.tx - e.deltaX, ty: c.ty - e.deltaY })
      }}
      onDragOver={(e) => {
        e.preventDefault()
        if (
          e.dataTransfer.types.includes('Files') ||
          e.dataTransfer.types.includes('text/plain') ||
          e.dataTransfer.types.includes(SESSION_DRAG_TYPE) ||
          e.dataTransfer.types.includes(CODE_DRAG_TYPE)
        ) {
          setDropping(true)
          const over = hitPlanet(toWorldNow(e.clientX, e.clientY))
          if (over !== dropOn) setDropOn(over)
        }
      }}
      onDragLeave={(e) => {
        if (!e.relatedTarget || !stageRef.current?.contains(e.relatedTarget as Node)) {
          setDropping(false)
          setDropOn(null)
        }
      }}
      onDrop={onDrop}
    >
      <div ref={worldRef} className="cv-world">
        <svg className="cv-lines" width="1" height="1">
          <defs>
            <marker
              id="cv-arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M0,0 L10,5 L0,10 z" className="cv-arrow-head" />
            </marker>
            <filter id="cv-goo" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur in="SourceGraphic" stdDeviation="9" result="b" />
              <feColorMatrix
                in="b"
                values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 24 -10"
                result="g"
              />
              <feGaussianBlur in="g" stdDeviation="12" result="s" />
              <feOffset in="s" dy="10" result="o" />
              <feFlood className="cv-goo-shadow" />
              <feComposite in2="o" operator="in" result="sh" />
              <feMerge>
                <feMergeNode in="sh" />
                <feMergeNode in="g" />
              </feMerge>
            </filter>
          </defs>
          <g className="cv-strokes">
            {(canvas.strokes ?? []).map((st) => (
              <path
                key={st.id}
                d={strokePath(st.points)}
                className={`cv-stroke cv-ink-${st.ink} ${picked.has(st.id) ? 'cv-picked' : ''} ${erasing.has(st.id) ? 'cv-erasing' : ''}`}
              />
            ))}
            {liveStroke ? (
              <path d={strokePath(liveStroke)} className={`cv-stroke cv-ink-${ink}`} />
            ) : null}
          </g>
          {Object.keys(pending).flatMap((id) => {
            const from = pos.current.get(id) ?? pending[id]
            return [...layout.planets.values()].map((p, i) => (
              <path
                key={`search:${id}:${p.id}`}
                className="cv-search"
                style={{ animationDelay: `${i * 0.14}s` }}
                d={`M${from.x},${from.y} L${p.x},${p.y}`}
              />
            ))
          })}
          {pull
            ? (() => {
                const a = pos.current.get(pull.from)
                if (!a) return null
                const p = rim(a, layout.sizeOf(pull.from), pull.to)
                const mx = (p.x + pull.to.x) / 2
                return (
                  <path
                    className="cv-pull"
                    d={`M${p.x},${p.y} C${mx},${p.y} ${mx},${pull.to.y} ${pull.to.x},${pull.to.y}`}
                    markerEnd="url(#cv-arrow)"
                  />
                )
              })()
            : null}
          <g filter="url(#cv-goo)">
            {[...layout.planets.values()].map((p) => (
              <g
                key={p.id}
                className={`cv-planet-blob ${planetDrag?.id === p.id ? 'cv-still' : ''}`}
                style={{ opacity: focusId ? 0 : zoomPlanet && zoomPlanet !== p.id ? 0.25 : 1 }}
              >
                <circle
                  className={p.id === CANVAS_SANDBOX ? 'cv-fill-sand' : 'cv-fill'}
                  style={{ cx: p.x, cy: p.y, r: p.r }}
                />
                <rect
                  className="cv-fill"
                  rx={NAME_H / 2}
                  style={{
                    x: p.x - p.nameW / 2,
                    y: p.y + p.r - 6,
                    width: p.nameW,
                    height: NAME_H + 8
                  }}
                />
              </g>
            ))}
            {rendered
              .map((b) => b.id)
              .map((id) => (
                <rect key={id} ref={(el) => bindBlob(id, el)} rx={22} className="cv-fill" />
              ))}
          </g>
          {view === 'time'
            ? [...layout.planets.values()].map((p) => {
                const box = layout.boxes?.get(p.id)
                if (!box) return null
                return (
                  <path
                    key={`lane:${p.id}`}
                    className={`cv-lane ${zoomPlanet && zoomPlanet !== p.id ? 'cv-faded' : ''}`}
                    d={`M${p.x + p.r + 10},${p.y} H${box.x + box.hw}`}
                  />
                )
              })
            : null}
          {layout.branches
            .filter((b) => renderedIds.has(b.to))
            .map((b) => {
              const key = `${b.chat ? 'c' : 'b'}:${b.from}>${b.to}`
              const planet = b.chat ? canvas.bubbles.find((x) => x.id === b.to)?.planet : b.from
              return (
                <path
                  key={key}
                  ref={(el) => bindLine(key, 'path', el)}
                  pathLength={1}
                  markerEnd={hooked.includes(b.to) ? 'url(#cv-arrow)' : undefined}
                  className={`cv-branch ${hooked.includes(b.to) ? 'cv-hooked' : ''} ${b.chat ? 'cv-branch-chat' : ''} ${zoomPlanet && zoomPlanet !== planet ? 'cv-faded' : ''} ${focusId ? 'cv-dim' : ''}`}
                />
              )
            })}
          {visibleLinks.map((l) => {
            const key = `${l.from}>${l.to}`
            const chain = canvas.bubbles.find((b) => b.id === l.to)?.parent !== undefined
            return (
              <g key={l.id}>
                <path
                  ref={(el) => bindLine(key, 'path', el)}
                  className={`cv-link ${l.by === 'you' ? 'cv-you' : ''} ${chain ? 'cv-chain' : ''} ${lit(l.from, l.to) ? 'cv-lit' : ''} ${freshLinks.has(l.id) ? 'cv-link-new' : ''}`}
                  pathLength={freshLinks.has(l.id) ? 1 : undefined}
                  markerEnd="url(#cv-arrow)"
                />
                {l.why ? (
                  <text
                    ref={(el) => bindLine(key, 'label', el)}
                    className={`cv-label ${lit(l.from, l.to) ? 'cv-lit' : ''} ${freshLinks.has(l.id) ? 'cv-link-new' : ''}`}
                    textAnchor="middle"
                  >
                    {l.why}
                  </text>
                ) : null}
              </g>
            )
          })}
        </svg>

        {[...layout.planets.values()].map((p) => (
          <PlanetView
            key={p.id}
            spot={p}
            project={projectById.get(p.id)}
            count={roots.filter((b) => b.planet === p.id).length}
            hot={hot === p.id || arrive === p.id || dropOn === p.id}
            more={layout.hidden.get(p.id)}
            dim={focusId !== null}
            faded={zoomPlanet !== null && zoomPlanet !== p.id}
            connected={zoomPlanet === p.id}
            dragging={planetDrag?.id === p.id}
            onDown={onPlanetDown(p.id)}
            onPlus={() => setPlusMenu((m) => (m === `planet:${p.id}` ? null : `planet:${p.id}`))}
          />
        ))}
        {plusMenu?.startsWith('planet:')
          ? (() => {
              const id = plusMenu.slice('planet:'.length)
              const p = layout.planets.get(id)
              if (!p) return null
              const name = planetName(id)
              const at = { x: p.x + p.r + 240, y: p.y }
              const start = (kind: 'ask' | 'note' | 'task'): void => {
                setPlusMenu(null)
                autoFit.current = false
                setWriting({ at, onDone: (text) => text && dispatcher.startIn(id, text, kind, at) })
              }
              return (
                <div
                  className="cv-planet-menu"
                  style={
                    view === 'space'
                      ? { left: p.x + p.r + 18, top: p.y - p.r - 10 }
                      : { left: p.x + p.r + 40, top: p.y - 20 }
                  }
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  <div className="cv-plus-menu" data-no-drag>
                    <Button variant="bare" onClick={() => start('ask')}>
                      <MessageSquarePlus size={14} /> Ask {name} something
                    </Button>
                    <Button variant="bare" onClick={() => start('note')}>
                      <StickyNote size={14} /> Add a note
                    </Button>
                    <Button variant="bare" onClick={() => start('task')}>
                      <SquareCheck size={14} /> Make a task
                    </Button>
                    <Button
                      variant="bare"
                      onClick={() => {
                        setPlusMenu(null)
                        setChatsOpen(true)
                      }}
                    >
                      <MessageSquare size={14} /> Bring in a chat
                    </Button>
                  </div>
                </div>
              )
            })()
          : null}

        {rendered.map((b) => {
          const session = b.sessionId ? sessionById.get(b.sessionId) : undefined
          const status = b.kind === 'answer' ? undefined : chatStatus(session)
          const ran = b.kind === 'answer' ? b.ran : chatRan(session)
          return (
            <div
              key={b.id}
              ref={(el) => bindEl(b.id, el)}
              data-status={status}
              style={b.w ? { width: b.w, maxWidth: 'none' } : undefined}
              className={`cv-bubble cv-${b.kind} ${inFocus(b) ? '' : 'cv-dim'} ${zoomPlanet && !focusId && b.planet !== zoomPlanet ? 'cv-faded' : ''} ${hot === b.id ? 'cv-target' : ''} ${near.has(b.id) ? 'cv-near' : ''} ${working[b.id] ? 'cv-working' : ''} ${pending[b.id] ? 'cv-reading-on' : ''} ${pulsing.has(b.id) ? 'cv-pulse-link' : ''} ${card?.bubbleId === b.id ? 'cv-carded' : ''} ${picked.has(b.id) ? 'cv-picked' : ''} ${pull?.over === b.id ? 'cv-target' : ''}`}
              onPointerDown={onBubbleDown(b)}
              onPointerEnter={() => setHoverId(b.id)}
              onPointerLeave={() => setHoverId((h) => (h === b.id ? null : h))}
              onClick={() => onBubbleClick(b)}
              onDoubleClick={(e) => {
                e.stopPropagation()
                openThread(b)
              }}
            >
              {b.imagePath ? (
                <img
                  className="cv-shot"
                  src={window.api.mediaUrl(b.imagePath)}
                  alt=""
                  draggable={false}
                />
              ) : null}
              {pending[b.id] ? (
                <span className="cv-kicker cv-reading">Finding where it belongs...</span>
              ) : null}
              {b.kind === 'step' ? (
                <span className="cv-kicker">Step {steps(b.parent ?? '').indexOf(b) + 1}</span>
              ) : null}
              {b.kind === 'thread' && b.codeRef ? (
                <span className="cv-kicker">
                  <Terminal size={10} className="inline -mt-px mr-1" />
                  Code
                </span>
              ) : b.kind === 'thread' ? (
                <span className="cv-kicker">
                  <MessageSquare size={10} className="inline -mt-px mr-1" />
                  {status === 'running'
                    ? 'Chat - running'
                    : status === 'failed'
                      ? 'Chat - failed'
                      : 'Chat'}
                </span>
              ) : null}
              {b.kind === 'answer' ? <span className="cv-kicker">Answer</span> : null}
              {b.task ? (
                <Button
                  variant="bare"
                  data-no-drag
                  className="cv-check"
                  aria-label={b.done ? 'Mark not done' : 'Mark done'}
                  onClick={(e) => {
                    e.stopPropagation()
                    toggleTask(b.id)
                  }}
                >
                  {b.done ? <SquareCheck size={15} /> : <Square size={15} />}
                </Button>
              ) : null}
              {b.media?.length ? (
                <div className="cv-media">
                  {mediaOf(b.text, b.media).map((m) =>
                    /\.(mp4|mov|webm)$/i.test(m) ? (
                      <video key={m} src={window.api.mediaUrl(m)} muted loop autoPlay playsInline />
                    ) : (
                      <img key={m} src={window.api.mediaUrl(m)} alt="" draggable={false} />
                    )
                  )}
                </div>
              ) : null}
              {b.kind === 'answer' ? (
                <div
                  className="cv-answer-body"
                  data-no-drag
                  style={b.h ? { maxHeight: b.h } : undefined}
                  onWheel={(e) => {
                    const el = e.currentTarget
                    const room =
                      e.deltaY > 0
                        ? el.scrollTop + el.clientHeight < el.scrollHeight - 1
                        : el.scrollTop > 0
                    if (room && !e.ctrlKey && !e.metaKey) e.stopPropagation()
                  }}
                >
                  <Markdown>{answerText(fullAnswer(b.text, session))}</Markdown>
                </div>
              ) : b.kind === 'file' && b.imagePath ? null : (
                <span className={b.task && b.done ? 'cv-done-text' : undefined}>
                  {b.kind === 'thread' && session ? chatTitle(session) : b.text}
                </span>
              )}
              {ran ? (
                <div className="cv-ran">
                  {b.kind !== 'thread' && b.kind !== 'answer' ? (
                    <MessageSquare size={10} className="inline -mt-px mr-1" />
                  ) : null}
                  {status === 'running' && b.kind !== 'thread' ? 'Running - ' : ''}
                  {ran}
                </div>
              ) : null}
              {working[b.id] ? (
                <div className="cv-work">
                  <i />
                  <i />
                  <i />
                  {live[b.id]?.phase ?? working[b.id]}
                </div>
              ) : null}
              {working[b.id] && live[b.id]?.text ? (
                <div className="cv-live" data-no-drag>
                  <span>
                    {live[b.id].text.slice(-LIVE_CHARS)}
                    <span className="cv-caret" />
                  </span>
                </div>
              ) : null}
              {b.stuck && !working[b.id] && card?.bubbleId !== b.id ? (
                <div className="cv-stuck" data-no-drag>
                  {canvasFailText(b.stuck.stage, b.stuck.reason)}
                  <Button
                    variant="bare"
                    className="cv-retry"
                    onClick={(e) => {
                      e.stopPropagation()
                      dispatcher.retry(b.id)
                    }}
                  >
                    Try again
                  </Button>
                </div>
              ) : null}
              {hoverId === b.id ? (
                <div className="cv-meta">
                  {[planetName(b.planet), ...b.tags.slice(0, 4).map((x) => `#${x}`)].join('  ')}
                </div>
              ) : null}
              {!b.parent && steps(b.id).length > 0 && focusId !== b.id ? (
                <div>
                  <span className={`cv-badge ${b.done ? 'cv-ok' : ''}`}>
                    {b.done ? 'Done' : 'In progress'} - {steps(b.id).length}{' '}
                    {steps(b.id).length === 1 ? 'step' : 'steps'}
                  </span>
                </div>
              ) : null}
              <span className="cv-float" data-no-drag onClick={(e) => e.stopPropagation()}>
                {b.sessionId || b.codeRef ? (
                  <Button
                    variant="bare"
                    aria-label={b.codeRef ? 'Open the session' : 'Open the chat'}
                    title={b.codeRef ? 'Open the session' : 'Open the chat'}
                    onClick={(e) => {
                      e.stopPropagation()
                      if (b.codeRef)
                        dispatchEvent(new CustomEvent(OPEN_CODE_EVENT, { detail: b.codeRef }))
                      else void window.api.mighty.open(false, b.sessionId)
                    }}
                  >
                    <ExternalLink size={13} />
                  </Button>
                ) : null}
                <CopyButton label="Copy - or pick and press ⌘C" copy={() => copyBubbles([b.id])} />
                {!b.parent ? (
                  <Button
                    variant="bare"
                    aria-label="Move to another project"
                    title="Move to another project"
                    onClick={(e) => {
                      e.stopPropagation()
                      setMoveMenu((m) => (m === b.id ? null : b.id))
                    }}
                  >
                    <ArrowRightLeft size={13} />
                  </Button>
                ) : null}
                <Button
                  variant="bare"
                  aria-label="Remove"
                  title="Remove - Undo brings it back"
                  onClick={(e) => {
                    e.stopPropagation()
                    removeBubble(b.id)
                  }}
                >
                  <Trash2 size={13} />
                </Button>
              </span>
              {moveMenu === b.id ? (
                <div className="cv-mv-menu" data-no-drag onPointerDown={(e) => e.stopPropagation()}>
                  <span>Move to</span>
                  {candidatePlanets
                    .filter((id) => id !== b.planet)
                    .map((id) => (
                      <Button
                        key={id}
                        variant="bare"
                        data-move-to={id}
                        className="cv-chip"
                        onClick={(e) => {
                          e.stopPropagation()
                          setMoveMenu(null)
                          dispatcher.moveTo(b.id, id)
                        }}
                      >
                        {planetName(id)}
                      </Button>
                    ))}
                </div>
              ) : null}
              {view === 'map' && layout.chatCount.get(b.id) ? (
                <Button
                  variant="bare"
                  data-no-drag
                  className="cv-fold"
                  onClick={(e) => {
                    e.stopPropagation()
                    setFolded((f) => {
                      const next = new Set(f)
                      if (!next.delete(b.id)) next.add(b.id)
                      return next
                    })
                  }}
                >
                  {folded.has(b.id) ? 'Show' : 'Hide'} {layout.chatCount.get(b.id)} more in this
                  chat
                </Button>
              ) : null}
              {!b.parent ? (
                <span className="cv-plus" data-no-drag>
                  <Button
                    variant="bare"
                    aria-label="Add from this - click for options, or drag out to start a new note"
                    title="Click for options, or drag out to start something new"
                    onPointerDown={onPlusDown(b)}
                  >
                    <Plus size={14} strokeWidth={2.4} />
                  </Button>
                </span>
              ) : null}
              {plusMenu === b.id ? (
                <div
                  className="cv-plus-menu"
                  data-no-drag
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  <Button variant="bare" onClick={() => branchFrom(b, 'ask')}>
                    <MessageSquarePlus size={14} /> Ask a follow-up
                  </Button>
                  <Button variant="bare" onClick={() => branchFrom(b, 'note')}>
                    <StickyNote size={14} /> Add a note
                  </Button>
                  <Button variant="bare" onClick={() => branchFrom(b, 'task')}>
                    <SquareCheck size={14} /> Make a task
                  </Button>
                  {b.kind !== 'thread' ? (
                    <Button
                      variant="bare"
                      onClick={() => {
                        setPlusMenu(null)
                        openThread(b)
                      }}
                    >
                      <ListChecks size={14} /> Plan next steps
                    </Button>
                  ) : null}
                </div>
              ) : null}
              <span className="cv-resize" data-no-drag onPointerDown={onResize(b)} />
            </div>
          )
        })}

        {focus && !focus.done && !focus.directions?.length ? (
          <div
            ref={(el) => bindEl('dir:1', el)}
            className={`cv-bubble cv-dir ${dirFail === focus.id ? 'cv-dir-bad' : ''}`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => dirFail === focus.id && void fetchDirections(focus.id)}
          >
            <span className="cv-kicker">Next</span>
            {dirFail === focus.id
              ? "Couldn't get next steps. Click to try again"
              : 'Thinking of next steps...'}
          </div>
        ) : null}
        {focus && !focus.done
          ? (focus.directions ?? []).map((d, i) => (
              <div
                key={`dir:${i}:${d}`}
                ref={(el) => bindEl(`dir:${i}`, el)}
                className="cv-bubble cv-dir"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => pickDirection(focus.id, d)}
              >
                <span className="cv-kicker">Next</span>
                {d}
                <Button
                  variant="bare"
                  className="cv-dir-edit"
                  aria-label="Edit this step"
                  onClick={(e) => {
                    e.stopPropagation()
                    const at = layoutRef.current.targets.get(`dir:${i}`) ?? layoutRef.current.hub
                    setWriting({
                      at,
                      seed: d,
                      onDone: (text) => text && pickDirection(focus.id, text)
                    })
                  }}
                >
                  <Pencil size={11} />
                </Button>
              </div>
            ))
          : null}
        {focus && !focus.done ? (
          <div
            ref={(el) => bindEl('done', el)}
            className="cv-bubble cv-done-chip"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => {
              update((c) => ({
                ...c,
                bubbles: c.bubbles.map((b) => (b.id === focus.id ? { ...b, done: true } : b))
              }))
              setFocusId(null)
            }}
          >
            Finish this idea
          </div>
        ) : null}

        {writing ? (
          <WriteBubble
            at={writing.at}
            seed={writing.seed}
            onDone={(text) => {
              setWriting(null)
              if (writing.onDone) writing.onDone(text)
              else if (text) file(text, writing.at)
            }}
          />
        ) : null}

        {pickAt && !drag.current && !marquee ? (
          <PickBar
            at={pickAt}
            count={picked.size}
            planets={candidatePlanets
              .filter((id) => pickedRoots.some((b) => b.planet !== id))
              .map((id) => ({ id, name: planetName(id) }))}
            onOpen={
              pickedOne?.sessionId || pickedOne?.codeRef ? () => openBubble(pickedOne) : undefined
            }
            onMove={
              pickedRoots.length
                ? (planet) => {
                    for (const b of pickedRoots) dispatcher.moveTo(b.id, planet)
                    setPicked(new Set())
                  }
                : undefined
            }
            onCopy={pickedBubbles.length ? () => copyBubbles(pickedBubbles.map((b) => b.id)) : undefined}
            onAsk={
              pickedBubbles.length
                ? () => {
                    const ids = pickedBubbles.map((b) => b.id)
                    const at = {
                      x: (pickTop?.x1 ?? 0) + 200,
                      y: pickAt?.y ?? 0
                    }
                    setPicked(new Set())
                    setWriting({
                      at,
                      onDone: (text) => text && dispatcher.askAbout(ids, text, at)
                    })
                  }
                : undefined
            }
            onRemove={deletePicked}
            onClear={() => setPicked(new Set())}
          />
        ) : null}
        {marquee ? (
          <div
            className="cv-marquee"
            style={{
              transform: `translate(${marquee.x0}px,${marquee.y0}px)`,
              width: marquee.x1 - marquee.x0,
              height: marquee.y1 - marquee.y0
            }}
          />
        ) : null}
      </div>

      {!focusId ? <BoardPicker boards={boards} onOpen={openBoard} onNew={startNew} /> : null}
      {!focusId ? (
        <Toolbar
          tool={tool}
          ink={ink}
          addOpen={addOpen || chatsOpen}
          onTool={setTool}
          onInk={setInk}
          onAdd={() => {
            setChatsOpen(false)
            setAddOpen((o) => !o)
          }}
        />
      ) : null}
      {addOpen && !focusId ? (
        <AddMenu
          projects={projects
            .filter((p) => !p.archived && !layout.planets.has(p.id))
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((p) => ({ id: p.id, name: p.name, icon: p.icon, imagePath: p.imagePath }))}
          onNote={() => {
            setAddOpen(false)
            setWriting({ at: viewCenter() })
          }}
          onChats={() => {
            setAddOpen(false)
            setChatsOpen(true)
          }}
          onFiles={(files) => {
            setAddOpen(false)
            hubAttach.addFiles(files)
            hubRef.current?.focus()
          }}
          onProject={(ids) => {
            setAddOpen(false)
            autoFit.current = true
            update((c) => ({ ...c, planets: [...new Set([...(c.planets ?? []), ...ids])] }))
            if (ids.length === 1) onFiled(ids[0])
          }}
          onClose={closeAdd}
        />
      ) : null}
      {chatsOpen && !focusId ? (
        <ChatsPicker
          sessions={sessions.filter(
            (s) => !canvas.bubbles.some((b) => b.sessionId === s.id && b.kind !== 'answer')
          )}
          projectName={(id) => (id && projectById.has(id) ? planetName(id) : 'No project')}
          onAdd={(id) => addSession({ kind: 'chat', id }, viewCenter())}
          onClose={() => setChatsOpen(false)}
        />
      ) : null}
      {view === 'time' && !focusId ? (
        <TimeRuler
          marks={layout.marks}
          bind={(el) => {
            rulerRef.current = el
          }}
        />
      ) : null}
      {!focusId ? (
        <div className="cv-view" onPointerDown={(e) => e.stopPropagation()}>
          <SegmentedControl look="pill" items={VIEWS} active={view} onChange={switchView} />
        </div>
      ) : null}
      <div className="cv-top">
        {focusId ? (
          <Button variant="secondary" onClick={() => setFocusId(null)}>
            {zoomPlanet ? `Back to ${connectedName}` : 'Back to all projects'}
          </Button>
        ) : zoomPlanet ? (
          <div className="cv-connect">
            <span className="cv-connect-dot" />
            Connected to <b>{connectedName}</b> - ask anything about it
            <Button variant="secondary" onClick={() => setZoomPlanet(null)}>
              <X size={12} className="inline -mt-px mr-1" />
              Step out
            </Button>
          </div>
        ) : messy ? (
          <Button variant="secondary" onClick={tidy}>
            Clean up
          </Button>
        ) : null}
      </div>
      {roots.length === 0 && !card && !focusId ? (
        <h1 className="cv-headline">Say anything. It files itself under the right project.</h1>
      ) : null}
      <div className="cv-composer">
        <HubInput
          bindRef={bindHub}
          dim={focusId !== null}
          examples={examples}
          connected={zoomPlanet !== null}
          files={hubFiles}
          onRemoveFile={hubAttach.remove}
          onSubmit={submitHub}
        />
      </div>
      {card && cardBubble ? (
        <DidCardView
          card={card}
          live={live[card.bubbleId]}
          bubble={cardBubble}
          links={canvas.links
            .filter(
              (l) => (l.from === cardBubble.id || l.to === cardBubble.id) && l.why !== 'answer'
            )
            .map((l) => {
              const other = canvas.bubbles.find(
                (b) => b.id === (l.from === cardBubble.id ? l.to : l.from)
              )
              return other && other.kind !== 'thread' ? { id: l.id, text: other.text } : null
            })
            .filter((x): x is { id: string; text: string } => x !== null)}
          chips={chips}
          planetName={planetName}
          onMove={(planet) => dispatcher.moveTo(cardBubble.id, planet)}
          onRunIn={(planet) => dispatcher.runIn(cardBubble.id, planet)}
          onUnlink={dispatcher.unlink}
          onAsk={() => dispatcher.askAi(cardBubble.id)}
          onOpen={() =>
            card.sessionId
              ? void window.api.mighty.open(false, card.sessionId)
              : openThread(cardBubble)
          }
          onRetry={() => dispatcher.retry(cardBubble.id)}
          onClose={() => setCard(null)}
        />
      ) : toast ? (
        <UndoToast
          toast={toast}
          onUndo={() => stepHistory(true)}
          onGone={hideToast}
        />
      ) : (
        <div className="cv-hint">{hint}</div>
      )}
      {!focusId ? <ZoomPill bindPercent={bindZoomPct} onZoom={zoomBy} onFit={fitNow} /> : null}
      {dropping ? (
        <div className={`cv-drop ${dropOn ? 'cv-drop-on' : ''}`}>
          {dropOn ? `Let go to add it to ${planetName(dropOn)}` : 'Let go to drop it in'}
        </div>
      ) : null}
    </div>
  )
}
