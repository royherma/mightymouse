import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Activity, ArrowDown, ChevronLeft, MessageCircle, MonitorPlay, Info, Play, RotateCcw, Undo2 } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { AgentRelaySessionInfo } from '@shared/types'
import type { Suggestion } from '@shared/swipe-suggest'
import { attachEdgeSwipe } from '@shared/edge-swipe'
import { hapticTick } from '../haptics'
import { Avatar } from './AiHome'
import { Composer, type ComposerFill, type ComposerMic } from './Composer'
import { MediaViewer } from './MediaViewer'
import type { MediaRef, ThreadItem } from './use-ai-session'
import { Button } from '@shared/ui/Button'

const MEDIA_GRID_MAX = 4
const NEAR_BOTTOM_PX = 120
const SUG_DRIFT_PX_PER_S = 22
const SUG_PAUSE_MS = 1400

interface ScrollSpot {
  top: number
  atBottom: boolean
  seen: number
}
// Module scope: AiRoot unmounts whenever the phone goes back to the trackpad.
const scrollSpots = new Map<string, ScrollSpot>()
const SKELETON_BUBBLES = [
  { mine: true, width: '58%', height: 40 },
  { mine: false, width: '80%', height: 92 },
  { mine: true, width: '42%', height: 40 },
  { mine: false, width: '72%', height: 64 }
]

function SuggestionStrip({ suggestions, onPick }: { suggestions: Suggestion[]; onPick: (text: string) => void }): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  const key = suggestions.map((s) => s.text).join('\n')
  useEffect(() => {
    const el = ref.current
    if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    el.scrollLeft = 0
    let raf = 0
    let pos = 0
    let dir = 1
    let last = performance.now()
    let pauseUntil = last + SUG_PAUSE_MS
    const step = (t: number): void => {
      const max = el.scrollWidth - el.clientWidth
      if (max > 1 && t >= pauseUntil) {
        pos = Math.min(max, Math.max(0, pos + (dir * SUG_DRIFT_PX_PER_S * (t - last)) / 1000))
        el.scrollLeft = pos
        if (pos >= max || pos <= 0) {
          dir = -dir
          pauseUntil = t + SUG_PAUSE_MS
        }
      }
      last = t
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    const stop = (): void => {
      cancelAnimationFrame(raf)
      el.dataset.touched = ''
    }
    const events = ['pointerdown', 'touchstart', 'wheel'] as const
    events.forEach((e) => el.addEventListener(e, stop, { passive: true, once: true }))
    return () => {
      cancelAnimationFrame(raf)
      events.forEach((e) => el.removeEventListener(e, stop))
      delete el.dataset.touched
    }
  }, [key])
  return (
    <div className="aiSugs" ref={ref}>
      {suggestions.map((s) => (
        <Button
          variant="bare"
          key={s.text}
          type="button"
          className="aiSug"
          onClick={() => {
            hapticTick()
            onPick(s.text)
          }}
        >
          {s.emoji && <i>{s.emoji}</i>}
          <span>{s.text}</span>
        </Button>
      ))}
    </div>
  )
}

function MediaGrid({ media, onOpen, mine }: { media: MediaRef[]; onOpen: (index: number) => void; mine?: boolean }): React.JSX.Element | null {
  if (!media.length) return null
  const shown = media.slice(0, MEDIA_GRID_MAX)
  const extra = media.length - shown.length
  return (
    <div className="aiMedia" data-count={shown.length} data-mine={mine ? '' : undefined}>
      {shown.map((m, i) => (
        <Button variant="bare" key={m.key} type="button" aria-label={`Open ${m.name}`} onClick={() => onOpen(i)}>
          {m.video ? <video src={m.src} muted playsInline preload="metadata" /> : <img src={m.src} alt={m.name} loading="lazy" />}
          {m.video && (
            <span className="aiViewerThumbPlay" aria-hidden="true">
              <Play size={22} fill="currentColor" />
            </span>
          )}
          {extra > 0 && i === shown.length - 1 && <span className="aiMediaMore">{`+${extra}`}</span>}
        </Button>
      ))}
    </div>
  )
}

function Markdown({ text }: { text: string }): React.JSX.Element {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{ a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a> }}
    >
      {text}
    </ReactMarkdown>
  )
}

function Steps({ texts }: { texts: string[] }): React.JSX.Element {
  return (
    <details className="aiSteps">
      <summary>
        {`${texts.length === 1 ? '1 step' : `${texts.length} steps`}${texts.length ? ` · ${texts[texts.length - 1]}` : ''}`}
      </summary>
      <ol>
        {texts.map((t, i) => (
          <li key={i}>{t}</li>
        ))}
      </ol>
    </details>
  )
}

const POP_MS = 180

function useSwipeBack(scrollRef: React.RefObject<HTMLDivElement | null>, onBack: () => void, enabled: boolean): void {
  const backRef = useRef(onBack)
  backRef.current = onBack
  useEffect(() => {
    const root = scrollRef.current?.closest<HTMLElement>('.ai')
    if (!root || !enabled) return
    let timer = 0
    const panes = (): HTMLElement[] => Array.from(root.children) as HTMLElement[]
    const place = (x: string, animate: boolean): void =>
      panes().forEach((el) => {
        el.style.transition = animate ? `transform ${POP_MS}ms ease-out` : 'none'
        el.style.transform = x
      })
    const clear = (): void =>
      panes().forEach((el) => {
        el.style.transition = ''
        el.style.transform = ''
      })
    const stop = attachEdgeSwipe({
      direction: 'right',
      fromEdgeOnly: true,
      width: () => root.clientWidth,
      ignore: () => root.querySelector('.aiSheet, .aiScreen') !== null,
      onDrag: (dx) => place(`translateX(${dx}px)`, false),
      onEnd: (commit) => {
        place(commit ? 'translateX(100%)' : '', true)
        if (!commit) return
        hapticTick()
        timer = window.setTimeout(() => {
          backRef.current()
          window.setTimeout(clear, 50)
        }, POP_MS)
      }
    })
    return () => {
      stop()
      window.clearTimeout(timer)
    }
  }, [scrollRef, enabled])
}

function ThreadSkeleton(): React.JSX.Element {
  return (
    <div className="aiThreadSkeleton" aria-label="Loading" role="status">
      {SKELETON_BUBBLES.map((b, i) => (
        <div key={i} className={b.mine ? 'aiYouWrap' : 'aiAgentWrap'}>
          <div className={`${b.mine ? 'aiYou' : 'aiAgent'} aiIdeaSkeleton`} style={{ width: b.width, height: b.height }} />
        </div>
      ))}
    </div>
  )
}

export function Conversation(props: {
  title: string
  spotKey?: string
  subtitle?: string
  project?: AgentRelaySessionInfo['project'] | null
  health?: string
  items: ThreadItem[]
  streamed?: string
  statusText?: string | null
  decisions?: React.ReactNode
  suggestions?: Suggestion[]
  onBack: () => void
  onWatch?: () => void
  onMore?: () => void
  onPulse?: () => void
  pulseDot?: string
  placeholder: string
  busy?: boolean
  canReply?: boolean
  onSend: (text: string, file: File | null) => boolean | void
  onStop?: () => void
  onUndo?: (at: number) => void
  undoError?: { at: number; error: string } | null
  mic?: ComposerMic
  allowPhoto?: boolean
  sendError?: string
  emptyText?: string
  loading?: boolean
}): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const threadRef = useRef<HTMLDivElement | null>(null)
  const stickRef = useRef(true)
  const restoreRef = useRef<number | null>(null)
  const seenRef = useRef(0)
  const [atBottom, setAtBottom] = useState(true)
  const [unseen, setUnseen] = useState(0)
  const [viewerAt, setViewerAt] = useState<number | null>(null)
  const [fill, setFill] = useState<ComposerFill | null>(null)
  const [actionsFor, setActionsFor] = useState<string | null>(null)
  useSwipeBack(scrollRef, props.onBack, viewerAt === null)
  const lastRecap = [...props.items].reverse().find((i) => i.kind === 'agent' && i.recap)
  const count = props.items.length
  const spotKey = props.spotKey ?? props.title

  const settle = (): void => {
    const el = scrollRef.current
    if (!el) return
    const restore = restoreRef.current
    if (restore !== null) {
      if (el.scrollHeight - el.clientHeight < restore) return
      restoreRef.current = null
      el.scrollTop = restore
    } else if (stickRef.current) el.scrollTop = el.scrollHeight
  }

  useLayoutEffect(() => {
    const spot = scrollSpots.get(spotKey)
    stickRef.current = !spot || spot.atBottom
    restoreRef.current = spot && !spot.atBottom ? spot.top : null
    seenRef.current = spot && !spot.atBottom ? spot.seen : Number.MAX_SAFE_INTEGER
    setAtBottom(stickRef.current)
  }, [spotKey])

  const tail = `${count}:${props.streamed?.length ?? 0}:${props.statusText ?? ''}`
  useLayoutEffect(() => {
    settle()
    if (stickRef.current) seenRef.current = count
    setUnseen(Math.max(0, count - seenRef.current))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tail, spotKey])

  useEffect(() => {
    const el = scrollRef.current
    const thread = threadRef.current
    if (!el || !thread) return
    const ro = new ResizeObserver(settle)
    ro.observe(el)
    ro.observe(thread)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const userTookOver = (): void => {
    restoreRef.current = null
  }

  const onScroll = (): void => {
    const el = scrollRef.current
    // A restore is still waiting on content: this scroll is a layout clamp, not the user.
    if (!el || restoreRef.current !== null) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX
    stickRef.current = near
    if (near) seenRef.current = count
    scrollSpots.set(spotKey, { top: el.scrollTop, atBottom: near, seen: seenRef.current })
    setAtBottom(near)
    setUnseen(near ? 0 : Math.max(0, count - seenRef.current))
  }

  const toNewest = (): void => {
    hapticTick()
    stickRef.current = true
    restoreRef.current = null
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }

  const allMedia = props.items.flatMap((i) => (i.kind === 'steps' ? [] : i.media))
  const open = (media: MediaRef[], index: number): void => setViewerAt(Math.max(0, allMedia.indexOf(media[index])))

  const send = (text: string, file: File | null): boolean | void => {
    stickRef.current = true
    restoreRef.current = null
    return props.onSend(text, file)
  }

  const last = props.items[props.items.length - 1]
  const failedPrompt = last?.kind === 'agent' && last.failed ? [...props.items].reverse().find((i) => i.kind === 'you')?.text : undefined
  const canRetry = !!failedPrompt && props.canReply !== false && !props.busy && !props.streamed

  return (
    <>
      <div className="aiHead">
        <Button variant="bare" type="button" className="aiIconBtn" aria-label="Back" onClick={props.onBack}>
          <ChevronLeft size={22} />
        </Button>
        <div className="aiHeadTitle">
          <Avatar project={props.project} size={32}>
            {props.project === null ? <MessageCircle size={17} /> : undefined}
          </Avatar>
          <div className="aiRowText">
            <b>{props.title}</b>
            {props.subtitle && <span data-health={props.health}>{props.subtitle}</span>}
          </div>
        </div>
        {props.onPulse && (
          <Button variant="bare" type="button" className="aiIconBtn aiPulseBtn" aria-label="Pulse" data-label="Pulse" onClick={props.onPulse}>
            <Activity size={19} />
            {props.pulseDot && <i style={{ background: props.pulseDot }} />}
          </Button>
        )}
        {props.onWatch && (
          <Button variant="bare" type="button" className="aiIconBtn" aria-label="Watch screen" title="Watch screen" data-label="Screen" onClick={props.onWatch}>
            <MonitorPlay size={18} />
          </Button>
        )}
        {props.onMore && (
          <Button variant="bare" type="button" className="aiIconBtn" aria-label="Details" title="Details" data-label="Details" onClick={props.onMore}>
            <Info size={20} />
          </Button>
        )}
      </div>
      <div className="aiScroll" ref={scrollRef} onScroll={onScroll} onTouchStart={userTookOver} onWheel={userTookOver}>
        <div className="aiThread" ref={threadRef}>
          {lastRecap && lastRecap.kind === 'agent' && (
            <div className="aiRecap">
              <small>Recap</small>
              {lastRecap.recap}
            </div>
          )}
          {props.loading ? (
            <ThreadSkeleton />
          ) : (
            props.items.length === 0 && !props.streamed && <div className="aiEmpty">{props.emptyText ?? 'Nothing here yet'}</div>
          )}
          {props.items.map((item) =>
            item.kind === 'steps' ? (
              <Steps key={item.key} texts={item.texts} />
            ) : item.kind === 'you' ? (
              <div key={item.key} className="aiYouWrap">
                {item.text && (
                  <div className="aiYou" onClick={() => setActionsFor((k) => (k === item.key ? null : item.key))}>
                    {item.text}
                  </div>
                )}
                <MediaGrid media={item.media} onOpen={(i) => open(item.media, i)} mine />
                {props.onUndo && item.undo === 'undo' && !props.busy && actionsFor === item.key && (
                  <Button variant="bare" type="button" className="aiUndo" onClick={() => { setActionsFor(null); props.onUndo?.(item.at) }}>
                    <Undo2 size={14} />
                    Undo file changes from here
                  </Button>
                )}
                {(item.undo === 'putBack' || props.undoError?.at === item.at) && (
                  <div className="aiUndone">
                    <Undo2 size={13} />
                    <span>{props.undoError?.at === item.at ? props.undoError.error : 'Files undone to before this message'}</span>
                    {props.onUndo && item.undo === 'putBack' && (
                      <Button variant="bare" type="button" className="aiUndoPutBack" onClick={() => props.onUndo?.(item.at)}>
                        Put back
                      </Button>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div key={item.key} className="aiAgentWrap">
                {item.text && (
                  <div className="aiAgent" data-failed={item.failed ? '' : undefined}>
                    <Markdown text={item.text} />
                  </div>
                )}
                <MediaGrid media={item.media} onOpen={(i) => open(item.media, i)} />
                {canRetry && item === last && (
                  <Button
                    variant="ghost"
                    type="button"
                    onClick={() => {
                      hapticTick()
                      send(failedPrompt, null)
                    }}
                  >
                    <RotateCcw size={14} strokeWidth={2.5} />
                    Try again
                  </Button>
                )}
              </div>
            )
          )}
          {props.streamed && (
            <div className="aiAgent">
              <Markdown text={props.streamed} />
            </div>
          )}
          {props.statusText && (
            <div className="aiStatus">
              <i className="aiRing" />
              {props.statusText}
            </div>
          )}
          {props.decisions}
        </div>
      </div>
      {!atBottom && (
        <div className="aiJumpDock">
          <Button variant="bare" type="button" className="aiJump" aria-label="Go to newest" onClick={toNewest}>
            {unseen > 0 && <span>{unseen === 1 ? '1 new' : `${unseen} new`}</span>}
            <ArrowDown size={18} strokeWidth={2.5} />
          </Button>
        </div>
      )}
      {props.suggestions && props.suggestions.length > 0 && props.canReply !== false && !props.busy && (
        <SuggestionStrip suggestions={props.suggestions} onPick={(text) => setFill({ text, n: Date.now() })} />
      )}
      {props.canReply !== false && (
        <Composer
          placeholder={props.placeholder}
          busy={props.busy}
          onSend={send}
          onStop={props.onStop}
          mic={props.mic}
          allowPhoto={props.allowPhoto}
          fill={fill}
          error={props.sendError}
        />
      )}
      {viewerAt !== null && <MediaViewer media={allMedia} index={viewerAt} onClose={() => setViewerAt(null)} />}
    </>
  )
}
