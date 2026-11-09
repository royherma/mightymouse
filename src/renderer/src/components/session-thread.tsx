import { SuggestedReplyActions } from './SessionPriority'
import { HoverScroll } from './hover-scroll'
/** The conversation half of the session sheet: the turns and the box you answer in. */

import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { ArrowUp, Check, ChevronRight, ListChecks, Pencil, RefreshCw, RotateCcw, Sparkles, Square, Timer, Undo2, X } from 'lucide-react'
import { CONFIG } from '../../../shared/config'
import { suggestContext, type Suggestion } from '../../../shared/swipe-suggest'
import { agentVendor, isInterruptMarker, sessionCanReply } from '../../../shared/relay-status'
import { foldSteps, toolParts, waitingWords, type StepRow } from '../../../shared/session-steps'
import { cardSummary, formatDuration, resolvedOutcome } from '../../../shared/relay-cards'
import type { AgentHelper, AgentRelaySessionInfo, AgentTranscriptTurn, TurnUndoState } from '../../../shared/types'
import { agentMessageKey, toAttachment } from '../../../shared/attachments'
import type { RelayRequestWire, RelayResponseWire } from '../../../shared/phone-remote-protocol'
import { Markdown } from './Markdown'
import { InlineMedia } from './local-path'
import { InlineLinks } from './link-card'
import { RelayCard } from './relay-card'
import { shortWhen } from './session-facts'
import { AttachBar, AttachButton } from './AttachBar'
import { useRememberedText } from '../hooks/useRememberedText'
import { useAttachments, useComposerInbox, usePasteToComposer } from '../hooks/useAttachments'
import { Button } from './Button'
import { CopyButton, ICON_SIZE } from './CopyButton'
import { TalkButton, TalkSendButton } from './TalkButton'
import { AgentQuestion, StartingAgent, type StartingInfo } from './starting-agent'
import { SessionPulse } from './session-pulse-mac'
import { useSlashMenu } from './composer-slash-menu'
import { ProjectIdeas } from './ProjectIdeas'
import { AGENT_QUICK_START_PROMPTS } from '../mighty/mighty-shared'
import { droppedText } from './agent-screen'
import './AgentProjects.css'
import './session-thread.css'

/** 20, not the wire's 50: a whole afternoon of turns buries the actions above it. */
const TIMELINE_MAX = 20
const LONG_GAP_MS = 5 * 60_000

/** A sent turn is NOT a fake card: the approve path reads that type off the store. */
type Turn =
  | { kind: 'card'; at: number; request: RelayRequestWire }
  | { kind: 'sent'; at: number; text: string; files?: string[] }
  | { kind: 'said'; at: number; role: AgentTranscriptTurn['role']; text: string; files?: string[]; undo?: TurnUndoState }

function emptyTranscript(status: 'loading' | 'failed' | 'ready', ended: boolean): string {
  if (status === 'loading') return 'Reading what it said…'
  if (status === 'failed') return "Couldn't read what it said."
  if (ended) return 'No messages from this agent were saved.'
  return CONFIG.UI_LABELS.CODE_SESSION_LAST_EMPTY
}

type Row = StepRow<Turn>

/** The opening message is the task: a long thread must not scroll it out of the window. */
function recentRows(rows: Row[]): Row[] {
  const recent = rows.slice(-TIMELINE_MAX)
  const first = rows[0]
  const opening = first && (first.kind === 'sent' || (first.kind === 'said' && first.role === 'you'))
  return opening && recent[0] !== first ? [first, ...recent] : recent
}

function SentFiles(props: { files?: string[] }): React.JSX.Element | null {
  if (!props.files?.length) return null
  return <AttachBar attachments={props.files.map(toAttachment)} />
}

function MessageActions(props: { text: string; onEdit?: () => void; onResend?: () => void; onUndo?: () => void }): React.JSX.Element {
  return (
    <div className="session-msg-actions">
      <CopyButton label="Copy message" text={props.text} />
      {props.onEdit && (
        <Button variant="quiet" title="Edit and send again" aria-label="Edit message" onClick={props.onEdit}>
          <Pencil size={ICON_SIZE} />
        </Button>
      )}
      {props.onResend && (
        <Button variant="quiet" title="Send again" aria-label="Send message again" onClick={props.onResend}>
          <RotateCcw size={ICON_SIZE} />
        </Button>
      )}
      {props.onUndo && (
        <Button variant="quiet" title="Undo file changes from here" aria-label="Undo file changes from here" onClick={props.onUndo}>
          <Undo2 size={ICON_SIZE} />
        </Button>
      )}
    </div>
  )
}

function UndoneLine(props: { error?: string; onPutBack?: () => void }): React.JSX.Element {
  return (
    <div className="session-undone">
      <Undo2 size={12} />
      <span>{props.error ?? 'Files undone to before this message'}</span>
      {props.onPutBack && (
        <Button variant="bare" className="session-undone-put-back" onClick={props.onPutBack}>
          Put back
        </Button>
      )}
    </div>
  )
}

function StepGroup(props: { texts: string[] }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const names = [...new Set(props.texts.map((text) => toolParts(text).name))]
  return (
    <>
      <Button
        variant="bare"
        className="session-detail-did"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRight size={12} strokeWidth={2.5} data-open={open || undefined} />
        <span>
          <b>{props.texts.length} steps</b> <span>{names.join(', ')}</span>
        </span>
      </Button>
      {open &&
        props.texts.map((text, i) => <ToolTurn text={text} nested key={`${i}-${text.slice(0, 24)}`} />)}
    </>
  )
}

function rowKey(row: Row): string {
  if (row.kind === 'steps') return `steps-${row.at}`
  if (row.kind === 'card') return row.request.id
  return `${row.kind}-${row.at}-${row.text.slice(0, 24)}`
}

function clockTime(at: number): string {
  const when = new Date(at)
  return when.toDateString() === new Date().toDateString()
    ? when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : when.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function TurnRow(props: { at: number; prevAt?: number; children: React.ReactNode }): React.JSX.Element {
  const gap = props.prevAt && props.prevAt > 0 ? props.at - props.prevAt : 0
  return (
    <div className="turn-row">
      {props.at > 0 && (
        <div className="turn-rail">
          {gap >= 1000 && (
            <span className="turn-gap" data-long={gap >= LONG_GAP_MS || undefined}>
              {formatDuration(gap)}
            </span>
          )}
          <time className="turn-time" dateTime={new Date(props.at).toISOString()} title={new Date(props.at).toLocaleString()}>
            {clockTime(props.at)}
          </time>
        </div>
      )}
      {props.children}
    </div>
  )
}

function ToolTurn(props: { text: string; nested?: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const { name, detail } = toolParts(props.text)
  return (
    <Button
      variant="bare"
      className="session-detail-did"
      data-open={open ? '' : undefined}
      data-bare={detail ? undefined : ''}
      data-nested={props.nested ? '' : undefined}
      aria-expanded={open}
      disabled={!detail}
      onClick={() => setOpen((value) => !value)}
    >
      <ChevronRight size={12} strokeWidth={2.5} data-open={open || undefined} />
      <span>
        <b>{name}</b>
        {open && detail && <span>{detail}</span>}
      </span>
    </Button>
  )
}


const AUTO_PICK_KEY = 'mm.code.autoPickSecs'
const AUTO_PICK_CHOICES = [0, 10, 30, 60, 120]

function readAutoPickSecs(): number {
  try {
    return Number(localStorage.getItem(AUTO_PICK_KEY)) || 0
  } catch {
    return 0
  }
}

type AutoPick = {
  secs: number
  setSecs: (secs: number) => void
  leftMs?: number
  totalMs: number
  stop: () => void
}

function useAutoPick(first: string | undefined, key: string, busy: boolean, send: (text: string) => void): AutoPick {
  const [secs, setSecsState] = useState(readAutoPickSecs)
  const [stoppedKey, setStoppedKey] = useState('')
  const [sentKey, setSentKey] = useState('')
  const [clock, setClock] = useState({ id: '', start: 0, now: 0 })
  const sendRef = useRef(send)
  useEffect(() => {
    sendRef.current = send
  })

  useEffect(() => {
    const sync = (): void => setSecsState(readAutoPickSecs())
    window.addEventListener(AUTO_PICK_KEY, sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener(AUTO_PICK_KEY, sync)
      window.removeEventListener('storage', sync)
    }
  }, [])
  if (busy && stoppedKey !== key) setStoppedKey(key)

  const totalMs = secs * 1000
  const active = secs > 0 && !!first && !busy && stoppedKey !== key && sentKey !== key
  const armedId = `${key}|${first}|${totalMs}`
  useEffect(() => {
    if (!active || !first) return
    const start = Date.now()
    const kick = setTimeout(() => setClock({ id: armedId, start, now: start }), 0)
    const tick = setInterval(() => setClock({ id: armedId, start, now: Date.now() }), 250)
    const fire = setTimeout(() => {
      setSentKey(key)
      sendRef.current(first)
    }, totalMs)
    return () => {
      clearTimeout(kick)
      clearInterval(tick)
      clearTimeout(fire)
    }
  }, [active, first, key, totalMs, armedId])

  const setSecs = (next: number): void => {
    setSecsState(next)
    try {
      localStorage.setItem(AUTO_PICK_KEY, String(next))
    } catch {
      // localStorage unavailable - the timer just doesn't outlive the window.
    }
    window.dispatchEvent(new Event(AUTO_PICK_KEY))
  }
  const leftMs = active && clock.id === armedId ? Math.max(0, totalMs - (clock.now - clock.start)) : undefined
  return { secs, setSecs, leftMs, totalMs, stop: () => setStoppedKey(key) }
}

function autoPickWord(secs: number): string {
  if (secs === 0) return CONFIG.UI_LABELS.CODE_SESSION_AUTO_PICK_OFF
  return secs < 60 ? `${secs}s` : `${secs / 60}m`
}

function AutoPickControl({ auto }: { auto: AutoPick }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  if (auto.leftMs !== undefined) {
    return (
      <div className="session-detail-suggest-auto-wrap">
        <Button
          variant="bare"
          className="session-detail-suggest-chip session-detail-suggest-again session-detail-suggest-auto"
          data-label=""
          data-on=""
          title={CONFIG.UI_LABELS.CODE_SESSION_AUTO_PICK_STOP}
          aria-label={CONFIG.UI_LABELS.CODE_SESSION_AUTO_PICK_STOP}
          onClick={auto.stop}
        >
          <Timer size={13} strokeWidth={2.25} />
          {Math.ceil(auto.leftMs / 1000)}s
          <X size={12} strokeWidth={2.5} />
        </Button>
      </div>
    )
  }
  return (
    <div className="session-detail-suggest-auto-wrap" onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setOpen(false)}>
      <Button
        variant="bare"
        className="session-detail-suggest-chip session-detail-suggest-again session-detail-suggest-auto"
        data-label={auto.secs > 0 ? '' : undefined}
        data-on={auto.secs > 0 || undefined}
        title={CONFIG.UI_LABELS.CODE_SESSION_AUTO_PICK}
        aria-label={CONFIG.UI_LABELS.CODE_SESSION_AUTO_PICK}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Timer size={13} strokeWidth={2.25} />
        {auto.secs > 0 && autoPickWord(auto.secs)}
      </Button>
      {open && (
        <div className="session-detail-suggest-auto-menu" role="menu">
          <span>{CONFIG.UI_LABELS.CODE_SESSION_AUTO_PICK}</span>
          {AUTO_PICK_CHOICES.map((secs) => (
            <Button
              key={secs}
              variant="bare"
              role="menuitemradio"
              aria-checked={auto.secs === secs}
              onClick={() => {
                auto.setSecs(secs)
                setOpen(false)
              }}
            >
              {autoPickWord(secs)}
              {auto.secs === secs && <Check size={13} strokeWidth={2.5} />}
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}

function ReplySuggestions(props: {
  session: AgentRelaySessionInfo
  said: AgentTranscriptTurn | undefined
  draft: string
  onPick: (text: string) => void
  onSend: (text: string) => void
}): React.JSX.Element | null {
  const { session, said, draft, onPick, onSend } = props
  const [state, setState] = useState<{ key: string; items?: Suggestion[] }>({ key: '' })
  const [dismissedKey, setDismissedKey] = useState('')
  const context = suggestContext(session, session.stated ?? session.label)
  const key = `${session.sessionId ?? session.label} ${said?.at ?? 0}`

  const ask = (fresh: boolean): void => {
    if (!context) return
    setState({ key })
    void window.api
      .agentRelaySuggest(session.label, context, said?.text, fresh)
      .catch(() => [])
      .then((items) => setState((prev) => (prev.key === key ? { key, items } : prev)))
  }

  useEffect(() => {
    if (state.key !== key) ask(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  const loading = state.key !== key || state.items === undefined
  useEffect(() => {
    if (!loading) return
    const giveUp = setTimeout(
      () => setState((prev) => (prev.key === key && !prev.items ? { key, items: [] } : prev)),
      CONFIG.SUGGESTIONS.PREDICT_TIMEOUT_MS + 5000
    )
    return () => clearTimeout(giveUp)
  }, [loading, key])

  const items = loading ? [] : (state.items ?? [])
  const hidden = !context || dismissedKey === key
  const first = items[0]?.text
  const auto = useAutoPick(hidden ? undefined : first, key, draft !== '', onSend)
  if (hidden) return null

  return (
    <div className="session-detail-suggest" aria-busy={loading || undefined} aria-live="polite">
      <div className="session-detail-suggest-row">
        {loading ? (
          <>
            <span className="session-detail-suggest-hint">
              <Sparkles size={12} strokeWidth={2.25} aria-hidden="true" className="animate-pulse" />
              {CONFIG.UI_LABELS.CODE_SESSION_SUGGEST_LOADING}
            </span>
            {[7, 9, 6].map((rem, i) => (
              <span
                key={i}
                className="session-detail-suggest-chip session-detail-suggest-ghost"
                style={{ width: `${rem}rem`, animationDelay: `${i * 120}ms` }}
              />
            ))}
          </>
        ) : items.length === 0 ? (
          <span className="session-detail-suggest-hint">{CONFIG.UI_LABELS.CODE_SESSION_SUGGEST_NONE}</span>
        ) : (
          items.map((item, i) => (
            <Button
              key={item.text}
              variant="bare"
              className="session-detail-suggest-chip"
              data-first={i === 0 || undefined}
              data-auto={(i === 0 && auto.leftMs !== undefined) || undefined}
              style={{
                animationDelay: `${i * 70}ms`,
                ...(i === 0 && auto.leftMs !== undefined ? { ['--auto-ms' as string]: `${auto.totalMs}ms` } : {}),
              }}
              aria-pressed={draft === item.text}
              onClick={() => {
                auto.stop()
                onPick(item.text)
              }}
              onDoubleClick={() => onSend(item.text)}
            >
              {item.emoji && (
                <span className="session-detail-suggest-emoji" aria-hidden="true">
                  {item.emoji}
                </span>
              )}
              <HoverScroll text={item.text} />
            </Button>
          ))
        )}
      </div>
      {!loading && (
        <Button
          variant="bare"
          className="session-detail-suggest-chip session-detail-suggest-again"
          title={CONFIG.UI_LABELS.CODE_SESSION_SUGGEST_AGAIN}
          aria-label={CONFIG.UI_LABELS.CODE_SESSION_SUGGEST_AGAIN}
          onClick={() => ask(true)}
        >
          <RefreshCw size={13} strokeWidth={2.25} />
        </Button>
      )}
      {!loading && items.length > 0 && <AutoPickControl auto={auto} />}
      <Button
        variant="bare"
        className="session-detail-suggest-chip session-detail-suggest-again"
        title={CONFIG.UI_LABELS.CODE_SESSION_SUGGEST_HIDE}
        aria-label={CONFIG.UI_LABELS.CODE_SESSION_SUGGEST_HIDE}
        data-label=""
        onClick={() => setDismissedKey(key)}
      >
        {CONFIG.UI_LABELS.CODE_SESSION_SUGGEST_HIDE_WORD}
      </Button>
    </div>
  )
}

function FloatingRecap({ text, onSize }: { text: string; onSize: (px: number) => void }): React.JSX.Element {
  const [open, setOpen] = useState(true)
  const boxRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = boxRef.current
    if (!el) return
    const watch = new ResizeObserver(() => onSize(el.offsetHeight + 24))
    watch.observe(el)
    return () => {
      watch.disconnect()
      onSize(0)
    }
  }, [onSize])
  return (
    <div className="session-recap-float" ref={boxRef} data-open={open ? '' : undefined}>
      <Button
        variant="bare"
        className="session-recap-toggle"
        title={open ? CONFIG.UI_LABELS.CODE_SESSION_RECAP_HIDE : CONFIG.UI_LABELS.CODE_SESSION_RECAP_SHOW}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <ListChecks size={13} />
        {CONFIG.UI_LABELS.CODE_SESSION_RECAP}
      </Button>
      {open && <div className="session-recap-text">{text}</div>}
    </div>
  )
}

function useRunningHelpers(sessionRef: string, active: boolean): AgentHelper[] {
  const [helpers, setHelpers] = useState<AgentHelper[]>([])
  useEffect(() => {
    if (!active) {
      setHelpers([])
      return
    }
    let live = true
    const load = (): void => {
      void window.api.agentRelaySessionHelpers(sessionRef).then(
        (next) => {
          if (live) setHelpers(next)
        },
        () => undefined
      )
    }
    load()
    const poll = setInterval(load, CONFIG.AGENT_RELAY.THREAD_POLL_MS)
    return () => {
      live = false
      clearInterval(poll)
    }
  }, [sessionRef, active])
  return helpers
}

function RunningHelpers(props: { helpers: AgentHelper[] }): React.JSX.Element {
  const count = props.helpers.length
  return (
    <div className="flex max-w-full flex-col gap-1 self-start text-xs text-muted">
      <span>
        {count === 1 ? '1 background agent working' : `${count} background agents working`}
      </span>
      {props.helpers.map((helper) => {
        const { name, detail } = toolParts(helper.doing)
        const step = helper.doing ? `${name} ${detail.split('\n').pop() ?? ''}`.trim() : 'Starting'
        return (
          <span className="flex min-w-0 gap-1.5" key={`${helper.since}-${helper.task}`}>
            <b className="shrink-0 font-medium text-fg">{helper.task}</b>
            <span className="truncate" title={step}>
              {step}
            </span>
          </span>
        )
      })}
    </div>
  )
}

export type BrowserPage = { url: string; title: string }
export const BrowserPageContext = createContext<(() => BrowserPage | undefined) | null>(null)

export function SessionThread(props: {
  session: AgentRelaySessionInfo
  /** The id when there is one: two unnamed panes in one checkout share a label. */
  sessionRef: string
  history: RelayRequestWire[]
  ended: boolean
  now: number
  spoken: AgentTranscriptTurn[]
  transcriptStatus: 'loading' | 'failed' | 'ready'
  /** Mid-turn right now, so the thread can say so instead of sitting silent. */
  working: boolean
  /** The message that started this agent, before main has a record of it. */
  opening?: { text: string; files: string[] }
  starting?: StartingInfo
  showSteps: boolean
  onRespond: (requestId: string, response: RelayResponseWire) => void
  /** Restarts a stopped agent with this message; resolves to the failure reason, or null. */
  onResume?: (message: string, paths: string[]) => Promise<string | null>
  /** Set in terminal view: there is no composer, so a picked suggestion is typed at the terminal prompt instead. */
  fillTerminal?: (text: string) => void
  pasteTerminal?: (text: string) => void
}): React.JSX.Element {
  const {
    session,
    sessionRef,
    history,
    ended,
    now,
    spoken,
    transcriptStatus,
    working,
    opening,
    starting,
    showSteps,
    onRespond,
    onResume,
    fillTerminal,
    pasteTerminal
  } = props
  const booting = starting !== undefined && session.sessionId === undefined
  const replyWhyId = useId()

  const [draft, setDraft] = useRememberedText(`reply:${sessionRef}`)
  const [draftEvidence, setDraftEvidence] = useState<AgentTranscriptTurn | undefined>(undefined)
  const [sendFailed, setSendFailed] = useState(false)
  const [resumeFailed, setResumeFailed] = useState<string | undefined>(undefined)
  const [resumed, setResumed] = useState<{ text: string; at: number } | undefined>(undefined)
  useEffect(() => setResumed(undefined), [sessionRef])
  const [dropping, setDropping] = useState(false)
  const [stoppedAt, setStoppedAt] = useState<number | undefined>(undefined)
  useEffect(() => setStoppedAt(undefined), [sessionRef])
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [talkLive, setTalkLive] = useState(false)
  const turnsRef = useRef<HTMLDivElement>(null)

  // A reply mints no card, so main's store is the only record it happened --
  // and for the same reason nothing pushes when it lands, hence the poll.
  const att = useAttachments(`reply:${sessionRef}`)
  const [sent, setSent] = useState<{ text: string; at: number; files?: string[] }[]>([])
  useEffect(() => {
    let live = true
    const load = (): void => {
      void window.api.agentRelaySessionSent(sessionRef).then((turns) => {
        // An empty answer never clears the screen: a ref that just flipped from
        // label to id reads empty for one poll while main re-keys the store.
        if (live && turns.length > 0) setSent(turns)
      })
    }
    load()
    const poll = setInterval(
      load,
      working ? CONFIG.AGENT_RELAY.THREAD_POLL_BUSY_MS : CONFIG.AGENT_RELAY.THREAD_POLL_MS
    )
    return () => {
      live = false
      clearInterval(poll)
    }
    // NOT `history.length`: restarting on a card drops whatever was typed
    // between polls back off the screen until the next read puts it back.
  }, [sessionRef, working])

  // The same message reaches us twice -- once from main's store as it is typed,
  // then again off the agent's own transcript once the CLI has written it down.
  // The transcript is what the agent actually received, so it wins and the
  // locally-recorded copy drops out rather than rendering a twin bubble.
  const echoed = new Set(spoken.filter((t) => t.role === 'you').map((t) => agentMessageKey(t.text)))
  const [undoNow, setUndoNow] = useState<Map<number, TurnUndoState>>(new Map())
  const [undoError, setUndoError] = useState<{ at: number; error: string }>()
  useEffect(() => setUndoNow(new Map()), [spoken])
  const toggleUndo = async (at: number): Promise<void> => {
    setUndoError(undefined)
    const result = await window.api.repoTurnUndo(sessionRef, at).catch((e: unknown) => ({ ok: false as const, error: String(e) }))
    if (result.ok) setUndoNow((prev) => new Map(prev).set(at, result.state))
    else setUndoError({ at, error: result.error })
  }
  // A pasted image reaches the transcript as `[Image #1]` with no path; our record has it.
  const sentFiles = new Map(
    sent.filter((t) => t.files?.length).map((t) => [agentMessageKey(t.text), t.files])
  )

  // Held until one of the real sources carries it: main records it once the
  // spawn returns, and the agent's own transcript picks it up after that.
  const known = new Set([...echoed, ...sent.map((t) => agentMessageKey(t.text))])
  const pending = opening && !known.has(agentMessageKey(opening.text)) ? opening : undefined

  const waiting = history.find((r) => r.status === 'pending')
  const openWaiting = (id: string): void => {
    const card = turnsRef.current?.querySelector<HTMLElement>(`[data-request-id="${id}"]`)
    card?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    card?.querySelector<HTMLElement>('[tabindex="-1"], textarea, button')?.focus({ preventScroll: true })
  }

  // Oldest first and interleaved: an answer above its question reads as two loose lines.
  const turns: Turn[] = [
    ...history.map((request): Turn => ({ kind: 'card', at: request.createdAt, request })),
    ...(pending ? [{ kind: 'sent' as const, at: 0, text: pending.text, files: pending.files }] : []),
    ...sent
      .filter((t) => !echoed.has(agentMessageKey(t.text)))
      .map((t): Turn => ({ kind: 'sent', at: t.at, text: t.text, files: t.files })),
    ...spoken.map((t): Turn => ({
      kind: 'said',
      at: t.at,
      role: t.role,
      text: t.text,
      files: t.role === 'you' ? (t.files ?? sentFiles.get(agentMessageKey(t.text))) : undefined,
      undo: undoNow.get(t.at) ?? t.undo
    }))
  ].sort((a, b) => a.at - b.at)

  // The agent's own busy stamp is dropped on the first turn -- it is keyed on a
  // sessionId the shim has not registered yet (http-listener.ts) -- so the
  // thread decides for itself: your message sitting last means a reply is owed.
  const recap = spoken.findLast((t) => t.recap)?.recap
  const last = turns[turns.length - 1]
  const lastAsk = turns.findLast((t) => t.kind === 'sent' || (t.kind === 'said' && t.role === 'you'))
  const turnEndedSinceAsk = (session.lastTurnEndedAt ?? 0) >= (lastAsk?.at ?? Infinity)
  const awaitingReply =
    (!ended || resumed !== undefined) &&
    last !== undefined &&
    (last.kind !== 'said' || last.role !== 'agent') &&
    !(last.kind === 'card' && last.request.status === 'pending') &&
    !turnEndedSinceAsk
  const stopHeld =
    (stoppedAt !== undefined && (last?.at ?? 0) <= stoppedAt) ||
    (last?.kind === 'said' && isInterruptMarker(last.text))
  const thinking = (working || awaitingReply) && !stopHeld
  const helpers = useRunningHelpers(sessionRef, thinking)
  const agentSpokeLast = !thinking && last?.kind === 'said' && last.role === 'agent'

  // Pinned to the newest turn, or you scroll to find what the agent just said.
  useEffect(() => {
    const el = turnsRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [turns.length, sessionRef, thinking])

  // Link cards, images and the suggestion bar resize the thread after the pin above ran.
  const pinned = useRef(true)
  const [recapSpace, setRecapSpace] = useState(0)
  useLayoutEffect(() => {
    const el = turnsRef.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [recapSpace])
  useEffect(() => {
    const el = turnsRef.current
    if (!el) return
    const onScroll = (): void => {
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32
    }
    const keep = new ResizeObserver(() => {
      if (pinned.current) el.scrollTop = el.scrollHeight
    })
    keep.observe(el)
    for (const child of el.children) keep.observe(child)
    el.addEventListener('scroll', onScroll)
    return () => {
      keep.disconnect()
      el.removeEventListener('scroll', onScroll)
    }
  }, [turns.length, sessionRef, thinking])

  // Not just `ended`: a live session with no addressable pane has nowhere to type.
  const canReply = (!ended && sessionCanReply(session)) || (ended && onResume !== undefined && !resumed)

  useEffect(() => {
    if (!resumed || !ended) return
    const stalled = setTimeout(() => {
      setResumed(undefined)
      setSent((prev) => prev.filter((t) => t.at !== resumed.at))
      setDraft(resumed.text)
      setResumeFailed(CONFIG.UI_LABELS.CODE_SESSION_RESUME_STALLED)
    }, CONFIG.AGENT_RELAY.RESUME_START_TIMEOUT_MS)
    return () => clearTimeout(stalled)
  }, [resumed, ended, setDraft])

  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [draft])

  const appendDraft = useCallback(
    (text: string) =>
      setDraft((prev) => (prev + text).slice(0, CONFIG.PHONE_REMOTE.CHAT_MESSAGE_MAX_CHARS)),
    []
  )
  usePasteToComposer(inputRef, att.paste, appendDraft, canReply)
  useComposerInbox(inputRef, att.addPaths, canReply)
  const slash = useSlashMenu({ draft, setDraft, inputRef, cwd: session.cwd, claude: agentVendor(session.agent) === 'claude' })

  const sendingRef = useRef(false)
  const browserPage = useContext(BrowserPageContext)
  // Clears only once main confirms delivery: `ok:false` would silently eat the text.
  const submit = async (override?: string): Promise<boolean> => {
    const text = (override ?? draft).trim()
    const files = att.attachments
    // An attachment on its own is a message: the agent opens the file and has
    // something to work on without a word of prose.
    if ((!text && files.length === 0) || !canReply || sendingRef.current) return false
    sendingRef.current = true
    setSendFailed(false)
    setResumeFailed(undefined)
    const sentAt = Date.now()
    if (ended && onResume) {
      const reason = await onResume(text, files.map((a) => a.path)).finally(() => { sendingRef.current = false })
      if (reason !== null) {
        setResumeFailed(reason)
        return false
      }
      setResumed({ text, at: sentAt })
    }
    const result = ended ? { ok: true } : await window.api.agentRelaySessionReply(
      sessionRef,
      text,
      files.map((a) => a.path),
      draftEvidence,
      browserPage?.()
    ).finally(() => { sendingRef.current = false })
    if (!result.ok) {
      setSendFailed(true)
      return false
    }
    setDraft('')
    setDraftEvidence(undefined)
    att.clear()
    // Painted here rather than waiting for the poll: a message that takes two
    // seconds to appear reads as one that was swallowed.
    setSent((prev) => [...prev, { text, at: sentAt, files: files.map((a) => a.path) }])
    return true
  }
  const sendWithDraft = (prompt: string): Promise<boolean> => {
    if (sendingRef.current) return Promise.resolve(false)
    const text = draft.trim() ? `${draft.trimEnd()}\n\n${prompt}` : prompt
    setDraft(text)
    return submit(text)
  }

  // Esc is the interrupt key in both Claude Code and Codex.
  const stop = async (): Promise<void> => {
    const ok = await window.api.agentRelaySessionKeys(sessionRef, [{ key: 'Escape' }]).catch(() => false)
    if (!ok) {
      setSendFailed(true)
      setTimeout(() => setSendFailed(false), 2600)
      return
    }
    setStoppedAt(Date.now())
  }
  const fillDraft = (text: string): void => {
    setDraft(text)
    setDraftEvidence(undefined)
    inputRef.current?.focus()
  }
  const projectName = session.cwd?.split('/').filter(Boolean).pop() ?? session.label
  const showStop = thinking && canReply && !draft.trim() && att.attachments.length === 0

  return (
    <div
      className="session-detail-thread"
      data-dropping={dropping && (canReply || pasteTerminal) ? '' : undefined}
      onDragOver={(e) => {
        if (!(canReply || pasteTerminal) || !e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        setDropping(true)
      }}
      // relatedTarget outside this element, not any dragleave: crossing onto a
      // child fires one too, and reacting to that flickers the highlight off
      // under the pointer.
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false)
      }}
      onDrop={(e) => {
        setDropping(false)
        if (pasteTerminal) {
          e.preventDefault()
          const text = droppedText(e.dataTransfer)
          if (text) pasteTerminal(text)
        } else if (canReply) att.drop(e)
      }}
    >
      <SessionPulse
        sessionRef={sessionRef}
        onAnswer={waiting ? () => openWaiting(waiting.id) : undefined}
        onAxisSend={canReply ? sendWithDraft : undefined}
      />
      {turns.length === 0 && !thinking && transcriptStatus === 'ready' && canReply ? (
        <div className="session-detail-last session-detail-fresh">
          <h2 className="session-detail-fresh-title">{CONFIG.UI_LABELS.CODE_SESSION_FRESH_TITLE}</h2>
          <ProjectIdeas
            cwd={session.cwd ?? ''}
            name={projectName}
            titles={[]}
            onPick={fillDraft}
            onSend={(text) => {
              setDraftEvidence(undefined)
              void submit(text)
            }}
            fallback={
              <div className="agent-draft-starters">
                {AGENT_QUICK_START_PROMPTS.map(({ icon: Icon, label, prompt }) => (
                  <Button key={label} variant="bare" className="agent-draft-starter" onClick={() => fillDraft(prompt)}>
                    <Icon size={13} strokeWidth={1.75} />
                    {label}
                  </Button>
                ))}
              </div>
            }
          />
        </div>
      ) : turns.length === 0 && !thinking ? (
        <div className="session-detail-last">{emptyTranscript(transcriptStatus, ended)}</div>
      ) : (
        <div className="session-detail-turns" ref={turnsRef} style={{ paddingBottom: recapSpace }}>
          {recentRows(foldSteps(turns, showSteps)).map((turn, i, rows) => (
            <TurnRow key={rowKey(turn)} at={turn.at} prevAt={rows[i - 1]?.at}>
            {turn.kind === 'steps' ? (
              turn.texts.length === 1 ? (
                <ToolTurn text={turn.texts[0]} key={`said-${turn.at}-${turn.texts[0].slice(0, 24)}`} />
              ) : (
                <StepGroup texts={turn.texts} key={`steps-${turn.at}`} />
              )
            ) : turn.kind === 'said' && isInterruptMarker(turn.text) ? (
              <div className="session-detail-did" data-bare="" key={`stop-${turn.at}`}>
                <Square size={10} strokeWidth={2.5} />
                <span>{CONFIG.UI_LABELS.CHAT_STOPPED}</span>
              </div>
            ) : turn.kind === 'said' ? (
                <div
                  className={turn.role === 'you' ? 'session-detail-said' : 'session-detail-heard'}
                  key={`said-${turn.at}-${turn.text.slice(0, 24)}`}
                >
                  {turn.role === 'you' ? (
                    <>
                      {turn.text}
                      <SentFiles files={turn.files} />
                      <MessageActions
                        text={turn.text}
                        onEdit={canReply ? () => fillDraft(turn.text) : undefined}
                        onResend={canReply ? () => void submit(turn.text) : undefined}
                        onUndo={turn.undo === 'undo' && !working ? () => void toggleUndo(turn.at) : undefined}
                      />
                      {(turn.undo === 'putBack' || undoError?.at === turn.at) && (
                        <UndoneLine
                          error={undoError?.at === turn.at ? undoError.error : undefined}
                          onPutBack={turn.undo === 'putBack' ? () => void toggleUndo(turn.at) : undefined}
                        />
                      )}
                    </>
                  ) : (
                    <>
                      <Markdown cwd={session.cwd}>{turn.text}</Markdown>
                      <InlineMedia text={turn.text} cwd={session.cwd} />
                      <InlineLinks text={turn.text} />
                      <MessageActions text={turn.text} />
                    </>
                  )}
                </div>
            ) : turn.kind === 'sent' ? (
              <div className="session-detail-said" key={`sent-${turn.at}`}>
                {turn.text}
                <SentFiles files={turn.files} />
                <MessageActions text={turn.text} onEdit={canReply ? () => fillDraft(turn.text) : undefined} />
              </div>
            ) : turn.request.status === 'pending' ? (
              <RelayCard
                key={turn.request.id}
                request={turn.request}
                showSender={false}
                onRespond={onRespond}
              />
            ) : (
              <div className="session-detail-turn" key={turn.request.id}>
                {/* The agent asks and you answer, so the sides invert against a
                    chat surface: the agent takes the left. */}
                <div className="session-detail-heard">
                  <Markdown cwd={session.cwd}>{cardSummary(turn.request)}</Markdown>
                </div>
                {resolvedOutcome(turn.request) && (
                  <div className="session-detail-said">{resolvedOutcome(turn.request)}</div>
                )}
                <span className="session-detail-when">
                  {shortWhen(turn.request.createdAt, now)}
                </span>
              </div>
            )}
            </TurnRow>
          ))}
          {booting && starting && (
            <StartingAgent
              {...starting}
              now={now}
              askedAbove={history.filter((r) => r.status === 'pending' && r.verb === 'ask').map((r) => r.params.question ?? '')}
            />
          )}
          {thinking && !booting && (
            <AgentQuestion pane={session.origin?.tmuxPane}>
              <div className="session-detail-thinking">
                <span className="session-detail-thinking-dots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                <span>{waitingWords(session, spoken, ended && !resumed)}</span>
              </div>
            </AgentQuestion>
          )}
          {thinking && !booting && helpers.length > 0 && <RunningHelpers helpers={helpers} />}
        </div>
      )}
      {recap && (
        <div className="session-recap-anchor">
          <FloatingRecap text={recap} key={recap} onSize={setRecapSpace} />
        </div>
      )}

      {ended && !onResume ? (
        <p className="session-detail-empty" id={replyWhyId}>
          {CONFIG.UI_LABELS.CODE_SESSION_ENDED}
        </p>
      ) : !canReply && !ended && !booting ? (
        <p className="session-detail-empty" id={replyWhyId}>
          {CONFIG.UI_LABELS.CODE_SESSION_NO_PANE}
        </p>
      ) : null}

      {agentSpokeLast && canReply && draft === '' && (
        <SuggestedReplyActions
          key={JSON.stringify(spoken.at(-1))}
          session={session}
          turns={spoken}
          onEdit={fillTerminal ?? ((text) => { setDraft(text); setDraftEvidence(spoken.at(-1)); inputRef.current?.focus() })}
        />
      )}
      {agentSpokeLast && canReply && (
        <ReplySuggestions
          session={session}
          said={spoken.findLast((t) => t.role === 'agent')}
          draft={draft}
          onPick={fillTerminal ?? ((text) => {
            setDraft(text)
            setDraftEvidence(undefined)
            inputRef.current?.focus()
          })}
          onSend={(text) => {
            setDraftEvidence(undefined)
            void submit(text)
          }}
        />
      )}
      {att.attachments.length > 0 && (
        <div className="session-detail-attachments">
          <AttachBar attachments={att.attachments} onRemove={att.remove} />
        </div>
      )}

      {sendFailed && (
        <p className="session-detail-empty session-detail-failed">
          That didn&apos;t reach the agent. Its window may have closed.
          <Button variant="bare" onClick={() => void submit()}>
            {CONFIG.UI_LABELS.CODE_SESSION_RETRY}
          </Button>
        </p>
      )}
      {resumeFailed && (
        <p className="session-detail-empty session-detail-failed">
          {resumeFailed}
          <Button variant="bare" onClick={() => void submit()}>
            {CONFIG.UI_LABELS.CODE_SESSION_RETRY}
          </Button>
        </p>
      )}
      {(!ended || onResume) && !fillTerminal && <div
        className="session-detail-composer"
        data-disabled={canReply ? undefined : ''}
      >
        {canReply && slash.menu}
        {canReply && <AttachButton onClick={() => void att.pick()} />}
        <textarea
          ref={inputRef}
          className="session-detail-input"
          value={draft}
          maxLength={CONFIG.PHONE_REMOTE.CHAT_MESSAGE_MAX_CHARS}
          rows={1}
          disabled={!canReply}
          aria-describedby={canReply ? undefined : replyWhyId}
          placeholder={
            canReply
              ? att.attachments.length > 0
                ? CONFIG.UI_LABELS.CODE_ATTACHED_PLACEHOLDER
                : CONFIG.UI_LABELS.CODE_SESSION_REPLY_PLACEHOLDER
              : booting || resumed
                ? CONFIG.UI_LABELS.CODE_SESSION_REPLY_AFTER_START
                : ''
          }
          onChange={(e) => { setDraft(e.target.value); if (!e.target.value) setDraftEvidence(undefined) }}
          onKeyDown={(e) => {
            if (slash.onKeyDown(e)) return
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void submit()
            }
          }}
        />
        {canReply && (
          <TalkButton inputRef={inputRef} label onLiveChange={setTalkLive} />
        )}
        {talkLive ? (
          <TalkSendButton className="session-detail-send" />
        ) : showStop ? (
          <Button
            variant="bare"
            className="session-detail-send"
            aria-label={CONFIG.UI_LABELS.CHAT_STOP}
            title={CONFIG.UI_LABELS.CHAT_STOP}
            onClick={() => void stop()}
          >
            <Square size={12} fill="currentColor" />
          </Button>
        ) : (
          <Button
            variant="bare"
            className="session-detail-send"
            disabled={!canReply || (!draft.trim() && att.attachments.length === 0)}
            aria-label={CONFIG.UI_LABELS.CODE_SESSION_SEND}
            onClick={() => void submit()}
          >
            <ArrowUp size={16} strokeWidth={2.25} />
          </Button>
        )}
      </div>}
      {slash.popup}
    </div>
  )
}
