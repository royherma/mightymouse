import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode, PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { Maximize2, MessageSquare, Plus, SquareTerminal, X } from 'lucide-react'
import { Button } from './Button'
import { LoadBadge } from './session-load'
import { useTerminalView } from './ViewModeMenu'
import { sessionRow } from '../../../shared/relay-status'
import { PANE_INPUT_SELECTOR, PREFIX_HELP, cmuxCommand, paneInDirection, usePanePrefixKeys, type CmuxCommand, type PrefixCommand } from '../mighty/pane-prefix-keys'
import type { AgentRelaySessionInfo, SessionLoad } from '../../../shared/types'
import './SessionPanes.css'

const COLS = 3
const ROW_MIN_PX = 320
const MAX_ROWS = 2
const FIT_GAP = 0
const MIN_HEIGHT = 360
const GAP_PX = 1
const MIN_COL_PX = 360
const MIN_ROW_PX = 220
const FRESH_RECHECK_MS = 10_000
const ORDER_KEY = 'mm.panes.order.v1'
const SIZE_KEY = 'mm.panes.sizes.v1'
const CLOSED_KEY = 'mm.panes.closed.v1'

function paneKey(session: AgentRelaySessionInfo): string {
  return session.sessionId || `${session.label}:${session.pid ?? ''}:${session.since ?? ''}`
}

function uniqueSessions(sessions: AgentRelaySessionInfo[]): AgentRelaySessionInfo[] {
  const seen = new Set<string>()
  return sessions.filter((s) => {
    const key = paneKey(s)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function transcriptRef(session: AgentRelaySessionInfo): string {
  return session.sessionId ?? (session.origin?.tmuxPane || session.label)
}

function plainlyUsed(session: AgentRelaySessionInfo): boolean {
  return Boolean(session.lastTurnEndedAt || session.busySince || session.handedBackAt || session.waiting || session.tldr || session.aiTitle)
}

function needsYou(session: AgentRelaySessionInfo): boolean {
  const health = sessionRow(session, 0).health
  return health === 'waiting' || health === 'your-turn'
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    return
  }
}

function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const y = getComputedStyle(p).overflowY
    if (y === 'auto' || y === 'scroll') return p
  }
  return null
}

function useFitHeight(ref: React.RefObject<HTMLDivElement | null>): number | undefined {
  const [fit, setFit] = useState<number>()
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const parent = scrollParent(el)
    const run = (): void => {
      const box = parent?.getBoundingClientRect()
      const top = el.getBoundingClientRect().top - (box?.top ?? 0) + (parent?.scrollTop ?? 0)
      const bottom = parent ? Math.min(parent.clientHeight, window.innerHeight - (box?.top ?? 0)) : window.innerHeight
      setFit(Math.max(MIN_HEIGHT, Math.floor(bottom - top - FIT_GAP)))
    }
    run()
    const watch = new ResizeObserver(run)
    if (parent) watch.observe(parent)
    window.addEventListener('resize', run)
    return () => {
      watch.disconnect()
      window.removeEventListener('resize', run)
    }
  }, [ref])
  return fit
}

function useEmptyKeys(sessions: AgentRelaySessionInfo[]): Set<string> | null {
  const [empty, setEmpty] = useState<Map<string, boolean>>(new Map())
  const unknownKey = sessions
    .filter((s) => !plainlyUsed(s))
    .map(paneKey)
    .join('|')
  const latest = useRef(sessions)
  latest.current = sessions
  useEffect(() => {
    let live = true
    const check = (): void => {
      const toCheck = latest.current.filter((s) => !plainlyUsed(s))
      void Promise.all(
        toCheck.map((s) =>
          window.api.agentRelaySessionTranscript(transcriptRef(s)).then(
            (turns) => [paneKey(s), turns.length === 0] as const,
            () => [paneKey(s), false] as const
          )
        )
      ).then((pairs) => {
        if (live) setEmpty(new Map(pairs))
      })
    }
    check()
    const timer = setInterval(check, FRESH_RECHECK_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [unknownKey])
  if (sessions.some((s) => !plainlyUsed(s) && !empty.has(paneKey(s)))) return null
  return new Set([...empty].filter(([, isEmpty]) => isEmpty).map(([key]) => key))
}

function ordered(sessions: AgentRelaySessionInfo[], order: string[]): AgentRelaySessionInfo[] {
  const rank = new Map(order.map((k, i) => [k, i]))
  return sessions
    .map((s, i) => ({ s, i, r: rank.get(paneKey(s)) }))
    .sort((a, b) => (a.r ?? Infinity) - (b.r ?? Infinity) || a.i - b.i)
    .map((x) => x.s)
}

function focusPane(pane: Element | null | undefined): void {
  if (!pane) return
  const input = pane.querySelector<HTMLElement>(PANE_INPUT_SELECTOR)
  input?.focus()
  input?.scrollIntoView({ block: 'nearest' })
}

function fromPrefix(cmd: PrefixCommand): CmuxCommand | null {
  if (cmd.kind === 'jump' || cmd.kind === 'move' || cmd.kind === 'zoom') return cmd
  if (cmd.kind === 'next-pane') return { kind: 'next' }
  if (cmd.kind === 'split') return { kind: 'new' }
  if (cmd.kind === 'tab') return { kind: 'group', step: cmd.step }
  if (cmd.kind === 'close') return cmd
  return null
}

function usePaneKeys(
  wrapRef: React.RefObject<HTMLDivElement | null>,
  groupCount: number,
  active: number,
  pick: (group: number) => void,
  open: (key: string) => void,
  close: (key: string) => void,
  startNew: (() => void) | undefined
): ReturnType<typeof usePanePrefixKeys> {
  const latest = useRef({ groupCount, active, pick, open, close, startNew })
  latest.current = { groupCount, active, pick, open, close, startNew }
  const run = (cmd: CmuxCommand): boolean => {
    const wrap = wrapRef.current
    if (!wrap) return false
    const { groupCount, active, pick, open, close, startNew } = latest.current
    const panes = [...wrap.querySelectorAll<HTMLElement>('.session-pane[data-pane-key]')]
    const current = (document.activeElement?.closest('.session-pane[data-pane-key]') as HTMLElement | null) ?? panes[0]
    if (cmd.kind === 'new') return startNew ? (startNew(), true) : false
    if (cmd.kind === 'group') {
      if (groupCount < 2) return false
      pick((active + cmd.step + groupCount) % groupCount)
      requestAnimationFrame(() => focusPane(wrap.querySelector('.session-pane[data-pane-key]')))
      return true
    }
    if (cmd.kind === 'jump') return focusPane(panes[cmd.index]), true
    if (cmd.kind === 'next') return focusPane(panes[(panes.indexOf(current) + 1) % panes.length]), true
    if (cmd.kind === 'zoom') return current?.dataset.paneKey ? (open(current.dataset.paneKey), true) : false
    if (cmd.kind === 'close') return current?.dataset.paneKey ? (close(current.dataset.paneKey), true) : false
    if (!current) return false
    const boxes = panes.map((p) => ({ id: p.dataset.paneKey ?? '', box: p.getBoundingClientRect() }))
    const to = paneInDirection(boxes, current.dataset.paneKey ?? '', cmd.dir)
    focusPane(panes.find((p) => p.dataset.paneKey === to))
    return true
  }
  const runRef = useRef(run)
  runRef.current = run
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.isComposing || !wrapRef.current?.offsetParent) return
      const cmd = cmuxCommand(e)
      if (!cmd || !runRef.current(cmd)) return
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [wrapRef])
  return usePanePrefixKeys(wrapRef, (cmd) => {
    const mapped = fromPrefix(cmd)
    if (mapped) runRef.current(mapped)
  })
}

const PANES_PREFIX_HELP = PREFIX_HELP.filter(([keys]) => keys !== 'c').map(([keys, what]) =>
  keys === 'x' ? ([keys, 'Hide this pane'] as const) : ([keys, what] as const)
)

function track(fr: number[]): string {
  return fr.map((f) => `minmax(0, ${f}fr)`).join(' ')
}

function handleOffset(fr: number[], i: number): string {
  const total = fr.reduce((a, b) => a + b, 0)
  const before = fr.slice(0, i + 1).reduce((a, b) => a + b, 0) / total
  const gaps = fr.length - 1
  return `calc((100% - ${gaps * GAP_PX}px) * ${before} + ${i * GAP_PX + GAP_PX / 2}px)`
}

function Divider(props: {
  axis: 'col' | 'row'
  fr: number[]
  index: number
  onChange: (next: number[]) => void
  onReset: () => void
}): React.JSX.Element {
  const { axis, fr, index } = props
  const start = (down: ReactPointerEvent<HTMLDivElement>): void => {
    down.preventDefault()
    const grip = down.currentTarget
    const grid = grip.parentElement
    if (!grid) return
    grip.setPointerCapture(down.pointerId)
    const size = axis === 'col' ? grid.clientWidth : grid.clientHeight
    const usable = size - (fr.length - 1) * GAP_PX
    const total = fr.reduce((a, b) => a + b, 0)
    const from = axis === 'col' ? down.clientX : down.clientY
    const base = [...fr]
    const move = (ev: PointerEvent): void => {
      const delta = (((axis === 'col' ? ev.clientX : ev.clientY) - from) / usable) * total
      const pair = base[index] + base[index + 1]
      const minFr = Math.min(pair / 2, ((axis === 'col' ? MIN_COL_PX : MIN_ROW_PX) / usable) * total)
      const left = Math.max(minFr, Math.min(pair - minFr, base[index] + delta))
      const next = [...base]
      next[index] = left
      next[index + 1] = pair - left
      props.onChange(next)
    }
    const up = (): void => {
      grip.removeEventListener('pointermove', move)
      grip.removeEventListener('pointerup', up)
      grip.removeEventListener('pointercancel', up)
      document.body.removeAttribute('data-pane-resizing')
    }
    document.body.setAttribute('data-pane-resizing', axis)
    grip.addEventListener('pointermove', move)
    grip.addEventListener('pointerup', up)
    grip.addEventListener('pointercancel', up)
  }
  return (
    <div
      className="session-pane-divider"
      data-axis={axis}
      style={axis === 'col' ? { left: handleOffset(fr, index) } : { top: handleOffset(fr, index) }}
      onPointerDown={start}
      onDoubleClick={props.onReset}
      title="Drag to resize, double-click to even out"
      role="separator"
      aria-orientation={axis === 'col' ? 'vertical' : 'horizontal'}
    />
  )
}

export function SessionPanes(props: {
  sessions: AgentRelaySessionInfo[]
  loads: Record<string, SessionLoad>
  onOpen: (session: AgentRelaySessionInfo) => void
  renderDetail: (session: AgentRelaySessionInfo, headActions: ReactNode) => ReactNode
  barSlot?: HTMLElement | null
  onNewSession?: () => Promise<string | null>
}): React.JSX.Element {
  const [starting, setStarting] = useState<'idle' | 'busy' | string>('idle')
  const startNew = async (): Promise<void> => {
    if (!props.onNewSession || starting === 'busy') return
    setStarting('busy')
    const failed = await props.onNewSession()
    setStarting(failed ?? 'idle')
  }
  const all = uniqueSessions(props.sessions)
  const emptyKeys = useEmptyKeys(all)
  const [order, setOrder] = useState<string[]>(() => readJson(ORDER_KEY, []))
  const [sizes, setSizes] = useState<Record<string, number[]>>(() => readJson(SIZE_KEY, {}))
  const [closed, setClosed] = useState<string[]>(() => readJson(CLOSED_KEY, []))
  const saveClosed = (next: string[]): void => {
    setClosed(next)
    writeJson(CLOSED_KEY, next)
  }
  const closePane = (key: string): void => saveClosed([...closed, key].slice(-200))
  const [terminal, setTerminal] = useTerminalView()
  const [dragKey, setDragKey] = useState<string | null>(null)
  const [dropKey, setDropKey] = useState<string | null>(null)
  const [picked, setPicked] = useState(0)
  const wrapRef = useRef<HTMLDivElement>(null)
  const fit = useFitHeight(wrapRef)

  const used = emptyKeys ? all.filter((s) => !emptyKeys.has(paneKey(s))) : []
  const newestEmpty = emptyKeys
    ? all.filter((s) => emptyKeys.has(paneKey(s))).sort((a, b) => (b.since ?? 0) - (a.since ?? 0))[0]
    : undefined
  const closedSet = new Set(closed)
  const hiddenCount = all.filter((s) => closedSet.has(paneKey(s))).length
  const sessions = ordered(newestEmpty ? [...used, newestEmpty] : used, order).filter((s) => !closedSet.has(paneKey(s)))

  const rows = Math.max(1, Math.min(MAX_ROWS, Math.floor(((fit ?? 0) - (props.barSlot ? 0 : 36)) / ROW_MIN_PX)))
  const perGroup = COLS * rows
  const groups: AgentRelaySessionInfo[][] = []
  for (let i = 0; i < sessions.length; i += perGroup) groups.push(sessions.slice(i, i + perGroup))
  const active = Math.min(picked, Math.max(0, groups.length - 1))
  const shown = groups[active] ?? []
  const cols = shown.length === 4 && rows > 1 ? 2 : Math.min(COLS, Math.max(1, shown.length))
  const gridRows = Math.max(1, Math.ceil(shown.length / cols))
  const colKey = `c${cols}`
  const rowKey = `r${gridRows}`
  const colFr = sizes[colKey]?.length === cols ? sizes[colKey] : Array<number>(cols).fill(1)
  const rowFr = sizes[rowKey]?.length === gridRows ? sizes[rowKey] : Array<number>(gridRows).fill(1)
  const setSize = (key: string, next: number[] | undefined): void => {
    const all = { ...sizes }
    if (next) all[key] = next
    else delete all[key]
    setSizes(all)
    writeJson(SIZE_KEY, all)
  }

  const swap = (from: string, to: string): void => {
    if (from === to) return
    const keys = sessions.map(paneKey)
    const a = keys.indexOf(from)
    const b = keys.indexOf(to)
    if (a < 0 || b < 0) return
    ;[keys[a], keys[b]] = [keys[b], keys[a]]
    setOrder(keys)
    writeJson(ORDER_KEY, keys)
  }

  const prefix = usePaneKeys(
    wrapRef,
    groups.length,
    active,
    setPicked,
    (key) => {
      const session = shown.find((s) => paneKey(s) === key)
      if (session) props.onOpen(session)
    },
    closePane,
    props.onNewSession ? () => void startNew() : undefined
  )

  const armDrag = (key: string) => (down: ReactPointerEvent<HTMLElement>) => {
    const target = down.target as HTMLElement
    if (target.closest('.session-detail-head') && !target.closest('button, a, input, textarea')) setDragKey(key)
  }

  const barInner = (
    <>
        <div className="session-pane-groups" role="tablist" aria-label="Groups of sessions">
          {groups.length > 1 &&
            groups.map((group, i) => {
              const from = i * perGroup + 1
              return (
                <Button
                  key={from}
                  variant="bare"
                  role="tab"
                  className="session-pane-group"
                  aria-selected={i === active}
                  onClick={() => setPicked(i)}
                  title={`Sessions ${from} to ${from + group.length - 1}`}
                >
                  {group.length === 1 ? `${from}` : `${from}-${from + group.length - 1}`}
                  {group.some(needsYou) && <span className="session-pane-group-dot" title="Something here needs you" />}
                </Button>
              )
            })}
        </div>
        {hiddenCount > 0 && (
          <Button variant="bare" className="session-pane-new" onClick={() => saveClosed([])} title="Show the panes you hid">
            {hiddenCount} hidden
          </Button>
        )}
        {props.onNewSession && (
          <Button
            variant="bare"
            className="session-pane-new"
            onClick={() => void startNew()}
            disabled={starting === 'busy'}
            title={starting !== 'idle' && starting !== 'busy' ? starting : 'Start a new agent in this project - it shows up here as a pane (⌘D)'}
            data-failed={starting !== 'idle' && starting !== 'busy' ? '' : undefined}
          >
            <Plus size={13} strokeWidth={2.5} />
            {starting === 'busy' ? 'Starting…' : starting !== 'idle' ? 'Retry' : 'New'}
          </Button>
        )}
        <Button
          variant="icon"
          className="session-pane-view-toggle"
          aria-pressed={terminal}
          onClick={() => setTerminal(!terminal)}
          title={terminal ? 'Showing terminals - click for chat' : 'Showing chat - click for terminals'}
          aria-label={terminal ? 'Switch panes to chat' : 'Switch panes to terminal'}
        >
          {terminal ? <MessageSquare size={14} strokeWidth={2.25} /> : <SquareTerminal size={14} strokeWidth={2.25} />}
        </Button>
    </>
  )

  return (
    <div className="session-panes-wrap" ref={wrapRef} style={fit ? { height: fit } : undefined}>
      {props.barSlot ? createPortal(<div className="session-pane-bar" data-slotted="">{barInner}</div>, props.barSlot) : <div className="session-pane-bar">{barInner}</div>}
      <div className="session-panes" role="list" style={{ gridTemplateColumns: track(colFr), gridTemplateRows: track(rowFr) }}>
        {shown.map((session, index) => {
          const key = paneKey(session)
          return (
            <section
              key={key}
              className="session-pane"
              data-pane-key={key}
              role="listitem"
              draggable={dragKey === key}
              data-dragging={dragKey === key || undefined}
              data-drop={dropKey === key && dragKey !== key ? '' : undefined}
              onPointerDownCapture={armDrag(key)}
              onPointerUp={() => setDragKey(null)}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('text/plain', key)
              }}
              onDragEnd={() => {
                setDragKey(null)
                setDropKey(null)
              }}
              onDragOver={(e) => {
                if (!dragKey) return
                e.preventDefault()
                setDropKey(key)
              }}
              onDragLeave={() => setDropKey((k) => (k === key ? null : k))}
              onDrop={(e) => {
                e.preventDefault()
                if (dragKey) swap(dragKey, key)
                setDragKey(null)
                setDropKey(null)
              }}
            >
              {prefix.phase === 'numbers' && <div className="session-pane-number"><span>{index + 1}</span></div>}
              {props.renderDetail(
                session,
                <span className="session-pane-actions">
                  <LoadBadge load={session.sessionId ? props.loads[session.sessionId] : undefined} />
                  <Button
                    variant="icon"
                    className="session-pane-hover"
                    onClick={() => props.onOpen(session)}
                    title="Open full size (⌘⇧↩)"
                    aria-label="Open full size"
                  >
                    <Maximize2 size={13} strokeWidth={2} />
                  </Button>
                  <Button
                    variant="icon"
                    className="session-pane-hover"
                    onClick={() => closePane(key)}
                    title="Hide this pane (Ctrl-B x) - the others fill the space"
                    aria-label="Hide this pane"
                  >
                    <X size={14} strokeWidth={2} />
                  </Button>
                </span>
              )}
            </section>
          )
        })}
        {colFr.slice(0, -1).map((_, i) => (
          <Divider key={`c${i}`} axis="col" fr={colFr} index={i} onChange={(n) => setSize(colKey, n)} onReset={() => setSize(colKey, undefined)} />
        ))}
        {rowFr.slice(0, -1).map((_, i) => (
          <Divider key={`r${i}`} axis="row" fr={rowFr} index={i} onChange={(n) => setSize(rowKey, n)} onReset={() => setSize(rowKey, undefined)} />
        ))}
      </div>
      {prefix.phase === 'armed' && <div className="session-pane-prefix">Ctrl-B</div>}
      {prefix.phase === 'help' && (
        <div className="session-pane-prefix session-pane-prefix-help" onClick={prefix.dismiss}>
          {PANES_PREFIX_HELP.map(([keys, what]) => (
            <div key={keys} className="session-pane-prefix-row">
              <kbd>{keys}</kbd>
              <span>{what}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
