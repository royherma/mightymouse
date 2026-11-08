import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowDown, EyeOff } from 'lucide-react'
import { CONFIG } from '../../../shared/config'
import { Button } from './Button'
import { findPaths, isFilePath } from './local-path'
import { linkMenu, openFileInRail, openWeb } from '../hooks/useRailMode'
import './AgentScreen.css'

interface Pen {
  fg?: string
  bg?: string
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
  inverse?: boolean
}

interface Run {
  text: string
  pen: Pen
}

const BASE16 = [
  'rgb(30,30,30)', 'rgb(205,49,49)', 'rgb(13,188,121)', 'rgb(229,229,16)',
  'rgb(36,114,200)', 'rgb(188,63,188)', 'rgb(17,168,205)', 'rgb(229,229,229)',
  'rgb(102,102,102)', 'rgb(241,76,76)', 'rgb(35,209,139)', 'rgb(245,245,67)',
  'rgb(59,142,234)', 'rgb(214,112,214)', 'rgb(41,184,219)', 'rgb(255,255,255)'
]

function color256(n: number): string {
  if (n < 16) return BASE16[n]
  if (n >= 232) {
    const v = 8 + (n - 232) * 10
    return `rgb(${v},${v},${v})`
  }
  const i = n - 16
  const step = (c: number): number => (c === 0 ? 0 : 55 + c * 40)
  return `rgb(${step(Math.floor(i / 36))},${step(Math.floor(i / 6) % 6)},${step(i % 6)})`
}

function applySgr(pen: Pen, params: number[]): Pen {
  const next = { ...pen }
  for (let i = 0; i < params.length; i++) {
    const p = params[i]
    if (p === 0) Object.keys(next).forEach((k) => delete next[k as keyof Pen])
    else if (p === 1) next.bold = true
    else if (p === 2) next.dim = true
    else if (p === 3) next.italic = true
    else if (p === 4) next.underline = true
    else if (p === 7) next.inverse = true
    else if (p === 22) next.bold = next.dim = false
    else if (p === 23) next.italic = false
    else if (p === 24) next.underline = false
    else if (p === 27) next.inverse = false
    else if (p >= 30 && p <= 37) next.fg = BASE16[p - 30]
    else if (p >= 90 && p <= 97) next.fg = BASE16[p - 82]
    else if (p >= 40 && p <= 47) next.bg = BASE16[p - 40]
    else if (p >= 100 && p <= 107) next.bg = BASE16[p - 92]
    else if (p === 39) delete next.fg
    else if (p === 49) delete next.bg
    else if (p === 38 || p === 48) {
      const key = p === 38 ? 'fg' : 'bg'
      if (params[i + 1] === 5) {
        next[key] = color256(params[i + 2] ?? 0)
        i += 2
      } else if (params[i + 1] === 2) {
        next[key] = `rgb(${params[i + 2] ?? 0},${params[i + 3] ?? 0},${params[i + 4] ?? 0})`
        i += 4
      }
    }
  }
  return next
}

// eslint-disable-next-line no-control-regex
const ESCAPE = /\x1b\[([\d;:]*)([A-Za-z])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]/g

export function parseAnsi(line: string, start: Pen): { runs: Run[]; pen: Pen } {
  const runs: Run[] = []
  let pen = start
  let last = 0
  for (const match of line.matchAll(ESCAPE)) {
    if (match.index > last) runs.push({ text: line.slice(last, match.index), pen })
    if (match[2] === 'm') {
      const params = match[1] === '' ? [0] : match[1].split(/[;:]/).map((n) => Number(n) || 0)
      pen = applySgr(pen, params)
    }
    last = match.index + match[0].length
  }
  if (last < line.length) runs.push({ text: line.slice(last), pen })
  return { runs, pen }
}

function runStyle(pen: Pen): React.CSSProperties | undefined {
  const fg = pen.inverse ? pen.bg ?? 'var(--agent-screen-bg)' : pen.fg
  const bg = pen.inverse ? pen.fg ?? 'var(--agent-screen-fg)' : pen.bg
  if (!fg && !bg && !pen.bold && !pen.dim && !pen.italic && !pen.underline) return undefined
  return {
    color: fg,
    backgroundColor: bg,
    fontWeight: pen.bold ? 700 : undefined,
    opacity: pen.dim ? 0.6 : undefined,
    fontStyle: pen.italic ? 'italic' : undefined,
    textDecoration: pen.underline ? 'underline' : undefined
  }
}

type Screen = {
  text: string
  cols: number
  rows: number
  cursor?: { x: number; y: number }
  history?: number
  alt?: boolean
}
type PaneKey = { text: string } | { key: string } | { paste: string }
type Link = { start: number; end: number; href: string; kind: 'url' | 'path' }

const URL_PATTERN = /https?:\/\/[^\s<>"'`]*[^\s<>"'`.,;:!?)\]}]/g

function findLinks(plain: string, cwd?: string): Link[] {
  const links: Link[] = [...plain.matchAll(URL_PATTERN)].map((m) => ({
    start: m.index,
    end: m.index + m[0].length,
    href: m[0],
    kind: 'url'
  }))
  for (const p of findPaths(plain, cwd)) {
    if (!links.some((l) => p.start < l.end && p.end > l.start))
      links.push({ start: p.start, end: p.end, href: p.path, kind: 'path' })
  }
  return links
}

function lineSpans(runs: Run[], links: Link[]): React.ReactNode[] {
  const out: React.ReactNode[] = []
  let at = 0
  runs.forEach((run, j) => {
    let from = 0
    while (from < run.text.length) {
      const pos = at + from
      const link = links.find((l) => pos >= l.start && pos < l.end)
      const stop = link ? link.end : Math.min(Infinity, ...links.filter((l) => l.start > pos).map((l) => l.start))
      const to = Math.min(run.text.length, stop - at)
      out.push(
        <span key={`${j}.${from}`} style={runStyle(run.pen)} data-link={link?.kind} data-href={link?.href}>
          {run.text.slice(from, to)}
        </span>
      )
      from = to
    }
    at += run.text.length
  })
  return out
}

function openLink(kind: string | undefined, href: string, external: boolean): void {
  if (kind === 'url') void openWeb(href, external)
  else if (external || !isFilePath(href) || !openFileInRail(href)) void window.api.openPath(href)
}

function shellEscape(path: string): string {
  return path.replace(/[^\w\-./@%+=:,~]/g, '\\$&')
}

export function droppedText(data: DataTransfer): string {
  const paths = Array.from(data.files, (f) => window.api.pathForFile(f)).filter(Boolean)
  return paths.length ? `${paths.map(shellEscape).join(' ')} ` : data.getData('text/plain')
}

const NAMED_KEYS: Record<string, string> = {
  Enter: 'Enter',
  Backspace: 'BSpace',
  Delete: 'DC',
  Tab: 'Tab',
  Escape: 'Escape',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'PPage',
  PageDown: 'NPage'
}

function paneKey(e: React.KeyboardEvent): PaneKey | 'paste' | null {
  if (e.nativeEvent.isComposing) return null
  if (e.metaKey) {
    if (e.key === 'v' && !e.shiftKey) return 'paste'
    if (e.key === 'Backspace') return { key: 'C-u' }
    return null
  }
  if (e.key === 'Enter' && (e.shiftKey || e.altKey)) return { key: 'M-Enter' }
  if (e.key === 'Tab' && e.shiftKey) return { key: 'BTab' }
  if (e.key === 'Backspace' && e.altKey) return { key: 'C-w' }
  if (e.ctrlKey && /^[a-z]$/i.test(e.key)) return { key: `C-${e.key.toLowerCase()}` }
  if (NAMED_KEYS[e.key]) return { key: NAMED_KEYS[e.key] }
  if (e.key.length === 1 && !e.ctrlKey) return { text: e.key }
  return null
}

function coalesce(keys: PaneKey[]): PaneKey[] {
  const out: PaneKey[] = []
  for (const k of keys) {
    const prev = out[out.length - 1]
    if ('text' in k && prev && 'text' in prev) out[out.length - 1] = { text: prev.text + k.text }
    else out.push(k)
  }
  return out
}

const MAX_ZOOM = 6

type View = { scale: number; x: number; y: number }

function clampView(v: View, w: number, h: number): View {
  const scale = Math.min(MAX_ZOOM, Math.max(1, v.scale))
  return {
    scale,
    x: Math.min(0, Math.max(w - w * scale, v.x)),
    y: Math.min(0, Math.max(h - h * scale, v.y))
  }
}

const FILL_FONT_PX = 13

export function AgentScreen(props: {
  sessionRef: string
  fill?: boolean
  cwd?: string
  onHide?: () => void
}): React.JSX.Element | null {
  const [screen, setScreen] = useState<Screen | null>(null)
  const [back, setBack] = useState(0)
  const [cmdHeld, setCmdHeld] = useState(false)
  const [dropping, setDropping] = useState(false)
  const backRef = useRef(0)
  const wheelRest = useRef(0)
  const screenRef = useRef<Screen | null>(null)
  screenRef.current = screen
  const [controlling, setControlling] = useState(false)
  const [sendFailed, setSendFailed] = useState(false)
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 })
  const [zoomShown, setZoomShown] = useState(false)
  const queue = useRef<PaneKey[]>([])
  const sending = useRef(false)
  const controllingRef = useRef(false)
  const refresh = useRef<() => void>(() => {})
  const boxRef = useRef<HTMLDivElement>(null)
  const glassRef = useRef<HTMLDivElement>(null)
  const zoomTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const drag = useRef<{ x: number; y: number; view: View } | null>(null)
  const hasScreen = screen !== null
  const viewRef = useRef(view)
  viewRef.current = view

  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    setScreen(null)
    setView({ scale: 1, x: 0, y: 0 })
    backRef.current = 0
    setBack(0)
    const selecting = (): boolean => {
      const sel = window.getSelection()
      return !!sel && !sel.isCollapsed && !!boxRef.current?.contains(sel.anchorNode)
    }
    let busy = false
    let again = false
    let streamed = false
    const tick = async (): Promise<void> => {
      clearTimeout(timer)
      if (busy) {
        again = true
        return
      }
      busy = true
      do {
        again = false
        if (document.visibilityState === 'visible' && !selecting()) {
          const next = await window.api.agentRelaySessionScreen(props.sessionRef, backRef.current).catch(() => null)
          if (!alive) return
          streamed = next?.streamed ?? false
          setScreen((prev) =>
            prev?.text === next?.text &&
            prev?.cols === next?.cols &&
            prev?.cursor?.x === next?.cursor?.x &&
            prev?.cursor?.y === next?.cursor?.y
              ? prev
              : next
          )
        }
      } while (again && alive)
      busy = false
      if (!alive) return
      timer = setTimeout(
        () => void tick(),
        streamed
          ? CONFIG.AGENT_RELAY.PANE_SCREEN_STREAM_FALLBACK_MS
          : controllingRef.current
            ? CONFIG.AGENT_RELAY.PANE_SCREEN_CONTROL_POLL_MS
            : CONFIG.AGENT_RELAY.PANE_SCREEN_POLL_MS
      )
    }
    refresh.current = () => void tick()
    let watching = false
    // The stream's tmux client marks the pane focused, so it only stays connected while this is on screen.
    const syncWatch = (): void => {
      const want = alive && document.visibilityState === 'visible'
      if (want === watching) return
      watching = want
      void (want ? window.api.agentRelaySessionWatch(props.sessionRef) : window.api.agentRelaySessionUnwatch(props.sessionRef))
      if (want) void tick()
    }
    const offChanged = window.api.onAgentRelaySessionScreenChanged((ref) => {
      if (ref === props.sessionRef) void tick()
    })
    document.addEventListener('visibilitychange', syncWatch)
    syncWatch()
    void tick()
    return () => {
      alive = false
      clearTimeout(timer)
      offChanged()
      document.removeEventListener('visibilitychange', syncWatch)
      syncWatch()
    }
  }, [props.sessionRef])

  const showZoom = (): void => {
    setZoomShown(true)
    clearTimeout(zoomTimer.current)
    zoomTimer.current = setTimeout(() => setZoomShown(false), CONFIG.AGENT_RELAY.PANE_SCREEN_ZOOM_BADGE_MS)
  }

  const scrollTo = (lines: number): void => {
    const next = Math.max(0, Math.min(screenRef.current?.history ?? 0, Math.round(lines)))
    if (next === backRef.current) return
    backRef.current = next
    setBack(next)
    refresh.current()
  }

  useEffect(() => {
    const box = boxRef.current
    const glass = glassRef.current
    if (!box || !glass) return
    // React's onWheel is passive, and a pinch must not also zoom the whole window.
    const onWheel = (e: WheelEvent): void => {
      if (!props.fill) return
      const w = glass.offsetWidth
      const h = glass.offsetHeight
      const v = viewRef.current
      if (e.ctrlKey) {
        e.preventDefault()
        const rect = box.getBoundingClientRect()
        const px = e.clientX - rect.left - glass.offsetLeft
        const py = e.clientY - rect.top - glass.offsetTop
        const scale = Math.min(MAX_ZOOM, Math.max(1, v.scale * Math.exp(-e.deltaY * 0.01)))
        const k = scale / v.scale
        const next = clampView({ scale, x: px - (px - v.x) * k, y: py - (py - v.y) * k }, w, h)
        viewRef.current = next
        setView(next)
        showZoom()
        return
      }
      if (v.scale === 1) {
        if (screenRef.current?.alt) return
        e.preventDefault()
        const linePx = parseFloat(getComputedStyle(glass).fontSize) * 1.2 || 16
        wheelRest.current += -e.deltaY / linePx
        const whole = Math.trunc(wheelRest.current)
        if (whole === 0) return
        wheelRest.current -= whole
        scrollTo(backRef.current + whole)
        return
      }
      e.preventDefault()
      const next = clampView({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }, w, h)
      viewRef.current = next
      setView(next)
    }
    box.addEventListener('wheel', onWheel, { passive: false })
    return () => box.removeEventListener('wheel', onWheel)
  }, [hasScreen])

  useEffect(() => () => clearTimeout(zoomTimer.current), [])

  useEffect(() => {
    const box = boxRef.current
    if (!props.fill || !box) return
    box.focus()
    let timer: ReturnType<typeof setTimeout> | undefined
    const fit = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        const cols = Math.floor((box.clientWidth - 12) / (FILL_FONT_PX * 0.602))
        const rows = Math.floor((box.clientHeight - 12) / (FILL_FONT_PX * 1.2))
        void window.api.agentRelaySessionFit(props.sessionRef, cols, rows).then(() => refresh.current())
      }, 150)
    }
    const observer = new ResizeObserver(fit)
    observer.observe(box)
    window.addEventListener('focus', fit)
    return () => {
      observer.disconnect()
      window.removeEventListener('focus', fit)
      clearTimeout(timer)
    }
  }, [props.fill, hasScreen, props.sessionRef])

  useEffect(() => {
    if (!props.fill) return
    const onKey = (e: KeyboardEvent): void => setCmdHeld(e.metaKey)
    const off = (): void => setCmdHeld(false)
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKey)
    window.addEventListener('blur', off)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKey)
      window.removeEventListener('blur', off)
    }
  }, [props.fill])

  const flush = useCallback(async (): Promise<void> => {
    if (sending.current) return
    sending.current = true
    while (queue.current.length > 0) {
      const batch = coalesce(queue.current.splice(0))
      const ok = await window.api.agentRelaySessionKeys(props.sessionRef, batch).catch(() => false)
      setSendFailed(!ok)
    }
    sending.current = false
    refresh.current()
  }, [props.sessionRef])

  const send = (key: PaneKey): void => {
    scrollTo(0)
    queue.current.push(key)
    void flush()
  }

  const setMode = (on: boolean): void => {
    controllingRef.current = on
    setControlling(on)
    if (!on) setSendFailed(false)
    refresh.current()
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (!controlling) {
      if (e.key === 'Enter') {
        e.preventDefault()
        setMode(true)
      }
      return
    }
    const key = paneKey(e)
    if (!key) return
    e.preventDefault()
    e.stopPropagation()
    if (key === 'paste') {
      void navigator.clipboard
        .readText()
        .catch(() => '')
        .then((text) => send(text ? { paste: text } : { key: 'C-v' }))
      return
    }
    send(key)
  }

  const linkAt = (target: EventTarget): HTMLElement | null =>
    target instanceof HTMLElement ? target.closest<HTMLElement>('[data-href]') : null

  const onDrop = (e: React.DragEvent): void => {
    if (!props.fill) return
    e.preventDefault()
    e.stopPropagation()
    setDropping(false)
    const text = droppedText(e.dataTransfer)
    if (!text) return
    boxRef.current?.focus()
    send({ paste: text })
  }

  const onPointerDown = (e: React.PointerEvent): void => {
    if (view.scale === 1 || e.button !== 0) return
    drag.current = { x: e.clientX, y: e.clientY, view }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent): void => {
    const start = drag.current
    const glass = glassRef.current
    if (!start || !glass) return
    setView(
      clampView(
        { ...start.view, x: start.view.x + e.clientX - start.x, y: start.view.y + e.clientY - start.y },
        glass.offsetWidth,
        glass.offsetHeight
      )
    )
  }

  if (!screen) return null
  let pen: Pen = {}
  const lines = !props.fill
    ? screen.text.replace(ESCAPE, '')
    : screen.text.split('\n').map((line, i) => {
        const parsed = parseAnsi(line, pen)
        pen = parsed.pen
        const links = findLinks(parsed.runs.map((run) => run.text).join(''), props.cwd)
        return (
          <div key={i} className="agent-screen-line">
            {lineSpans(parsed.runs, links)}
          </div>
        )
      })

  return (
    <div className="agent-screen-wrap" data-fill={props.fill || undefined}>
      <div
        ref={boxRef}
        className="agent-screen"
        role="textbox"
        tabIndex={0}
        aria-label="Live view of this agent"
        data-controlling={controlling || undefined}
        data-zoomed={view.scale > 1 || undefined}
        data-cmd={cmdHeld || undefined}
        data-dropping={dropping || undefined}
        title={
          controlling || props.fill
            ? undefined
            : 'Click to type into this agent.'
        }
        onDoubleClick={() => setMode(true)}
        onFocus={() => setMode(true)}
        onBlur={() => setMode(false)}
        onKeyDown={onKeyDown}
        onClick={(e) => {
          const link = e.metaKey ? linkAt(e.target) : null
          if (!link?.dataset.href) return
          e.preventDefault()
          openLink(link.dataset.link, link.dataset.href, e.shiftKey)
        }}
        onContextMenu={(e) => {
          const link = linkAt(e.target)
          if (link?.dataset.link === 'url' && link.dataset.href) void linkMenu(e, link.dataset.href)
        }}
        onDragOver={(e) => {
          if (!props.fill) return
          e.preventDefault()
          e.stopPropagation()
          e.dataTransfer.dropEffect = 'copy'
          setDropping(true)
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false)
        }}
        onDrop={onDrop}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
        style={{ '--cols': screen.cols, '--rows': screen.rows } as React.CSSProperties}
      >
        <span className="agent-screen-zoom" data-shown={zoomShown || undefined} aria-hidden>
          {Math.round(view.scale * 100)}%
        </span>
        <div
          ref={glassRef}
          className="agent-screen-glass"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
        >
          {lines}
          {screen.cursor && screen.cursor.y < screen.rows && (
            <span
              className="agent-screen-cursor"
              data-live={controlling || undefined}
              style={{ left: `${screen.cursor.x * 0.602}em`, top: `${screen.cursor.y * 1.2}em` }}
            />
          )}
        </div>
        {back > 0 && (
          <Button variant="bare" className="agent-screen-live" onClick={() => scrollTo(0)}>
            <ArrowDown size={12} strokeWidth={2.5} />
            Back to live
          </Button>
        )}
      </div>
      {props.onHide && (
        <Button variant="bare" className="agent-screen-hide" title="Hide terminal" aria-label="Hide terminal" onClick={props.onHide}>
          <EyeOff size={13} strokeWidth={2} />
        </Button>
      )}
      {(controlling || props.fill) && (
        <p className="agent-screen-hint" data-failed={sendFailed || undefined}>
          {sendFailed
            ? "Couldn't reach this agent. Click outside, then try again."
            : props.fill
              ? back > 0
                ? `Scrolled up ${back} lines. Type anything to jump back.`
                : controlling
                  ? 'Everything you type goes to this agent. ⌘-click a link to open it, or drop files in.'
                  : 'Click the screen to type into this agent.'
              : 'Typing goes to this agent. Click outside to stop.'}
        </p>
      )}
    </div>
  )
}
