import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { AgentRelaySessionInfo, AgentRelayStatus } from '@shared/types'
import type {
  PhoneRemoteMessage,
  RelayProjectWire,
  RelayRequestWire,
  RelayResponseWire,
  RelayTapMissReason,
  RelayTapOutcome,
  RelayVerbWire
} from '@shared/phone-remote-protocol'
import type { ProjectIdea } from '@shared/project-ideas'
import { isIdleNotify, previousList, refusalMessage, sessionActivity, type RelayRefusal } from '@shared/relay-cards'
import { relayStatusLine, sessionCanReply, sessionMatchesFrom, sessionRow } from '@shared/relay-status'
import {
  DEFAULT_RELAY_TURN_END_PING,
  type RelayNotifyPushLevel,
  type RelayPushFilter
} from '@shared/relay-push-filter'
import { cardSuggestKey, suggestContext, type Suggestion } from '@shared/swipe-suggest'
import { buildDeck, mergeDeck, removeCard, type SwipeAffirm, type SwipeCard } from '@shared/swipe-triage'
import { useSessionArchive, type SessionArchiveSink } from '@shared/use-session-archive'
import { sessionsWorthListing } from '@shared/relay-sessions'
import { CONFIG } from '@shared/config'
import { pulseDot, type PulseState } from '@shared/session-pulse'
import { PulsePanel } from '../../../../renderer/src/components/session-pulse'
import { AlertSettings } from './AlertSettings'
import type { ChatSessionSummary, ChatStep, OpenChatThread } from '../chat-steps'
import { ResolvedCard } from '../RelayCard'
import SessionFullScreen from '../SessionFullScreen'
import type { SessionMicProps, SessionPeekOutcome } from '../SessionList'
import SwipeDeckSheet from '../SwipeDeckSheet'
import { nativeBridge } from '../native-bridge'
import { Welcome, type FirstStepsState } from '../FirstSteps'
import { AiHome, ModelPicker, ProjectPicker, SHOW_IDEAS, type AiMode, type HomeMemory } from './AiHome'
import type { ComposerMic } from './Composer'
import { Conversation } from './Conversation'
import { DecisionCard } from './DecisionCard'
import { ScreenView } from './ScreenView'
import { Sheet } from './Sheet'
import { ChatInfoSheet, SessionInfoSheet } from './SessionInfoSheet'
import {
  chatThreadItems,
  codeThreadItems,
  matchStartedSession,
  usePushStatus,
  type AiSession,
  type ThreadItem
} from './use-ai-session'
import './ai.css'
import './phone-pulse.css'
import { Button } from '@shared/ui/Button'

const NOTICE_MS = 2600
const OUTBOX_MS = 120_000
const NO_PULSE: PulseState = { enabled: false, scoring: false, rows: [] }

export type CodeProps = {
  open: boolean
  pending: RelayRequestWire[]
  resolved: RelayRequestWire[]
  /** Whether a relayPending snapshot has ever arrived on this socket. Drives
   *  the empty-state copy: without it a dead link is indistinguishable from an
   *  idle one. Optional so the Mac-side host, which reads the store directly
   *  and has no socket to be wrong about, keeps its current behaviour. */
  linkOk?: boolean
  /** Cleared without answering. Rendered under Previous alongside `resolved`,
   *  not on a tab of their own. */
  dismissed?: RelayRequestWire[]
  /** Answer a card. The Mac's store decides first-answer-wins, so this is
   *  fire-and-forget -- a card that loses a race comes back via `refusal`. */
  onRespond: (requestId: string, response: RelayResponseWire) => void
  /** The Mac threw the last answer away. Pushed only on refusal, so anything
   *  non-null here is news the user cannot get from the card list. */
  refusal?: RelayRefusal | null
  /** Take a clear back, while the agent still has not been told. */
  onUndismiss?: (requestId: string) => void
  onClose: () => void
  imageSrc: (requestId: string) => string
  /** Send a picked photo up to the Mac, answering a photos_get card. Absent on
   *  the Mac-side host, which has no socket to send bytes on. */
  onPickPhoto?: (requestId: string, file: File) => Promise<boolean>
  /** A notification tap. May name a card in `resolved` (already answered
   *  elsewhere by the time the tap lands) or one not yet in either list (WS
   *  snapshot hasn't arrived) -- the effect below re-checks on every list
   *  change instead of firing once, so it catches the id whenever it appears. */
  focusedRequestId?: string | null
  onFocusedRequestConsumed?: () => void
  /** The tapped request is genuinely not on the Mac any more -- answered from
   *  another device, or expired. Only fired once the snapshot has landed, so it
   *  can never mean "still loading". */
  onTapMissed?: (reason: RelayTapMissReason) => void
  /** Diagnostic only. Says where the tap above landed, so a tap that opens the
   *  wrong screen leaves a trace -- the Mac cannot see this side at all. */
  onTapTrace?: (requestId: string, outcome: RelayTapOutcome) => void
  /** Who is connected right now, pushed as `relayStatus`. Optional because the
   *  Mac-side host renders this same component off its own store and has no
   *  socket -- and because a phone that has not received the first push yet
   *  must show the strip's own "starting" state, never a wrong count. */
  status?: AgentRelayStatus
  /** Last lines of a pane, keyed by session label, after a peek. */
  sessionPreviews?: Record<string, string>
  /** What you have already said to each agent, by label, as the Mac holds it. */
  sessionSent?: Record<string, { text: string; at: number }[]>
  onSessionSentGet?: (label: string) => void
  /** Suggested chips for an idle card, keyed by `cardSuggestKey`. Absent on the
   *  Mac-side host, which has no wire to ask over -- the deck falls back to the
   *  canned three there, which is the same thing an empty answer produces. */
  sessionSuggestions?: Record<string, Suggestion[]>
  onRequestSuggestions?: (label: string, tldr: string, refresh?: boolean) => void
  sessionPreviewAges?: Record<string, number>
  sessionPeekOutcome?: SessionPeekOutcome | null
  onSessionPeek?: (label: string) => void
  onSessionReply?: (label: string, text: string) => void
  onSessionStop?: (label: string) => void
  /** Attach a photo to the reply being typed. Absent on the Mac-side host for
   *  the same reason as `onSessionGoTo` -- there is no wire to send bytes on. */
  onSessionAttach?: (label: string, file: File) => Promise<boolean>
  /** Raise this agent's window on the Mac. Absent on the Mac-side host, which
   *  renders this component off its own store and has its own jump. */
  onSessionGoTo?: (label: string) => void
  onSessionZoom?: (label: string, on: boolean) => void
  sessionZoomed?: Readonly<Record<string, boolean>>
  sessionGoToFailed?: ReadonlySet<string>
  /** Stamped when the Mac confirms it raised the window. The whole surface
   *  steps aside on it: you sent your attention to the Mac, and the phone is
   *  a trackpad again the moment it lands. */
  sessionRevealedAt?: number | null
  sessionArchiveSink: SessionArchiveSink
  /** Start the mirror from a session sheet. Closes the sheet -- you asked to
   *  look at the screen, so the screen is what you should be left on. */
  onOpenScreen?: () => void
  mirrorOn?: boolean
  /** The live Mac pane + its toggle, rendered inside the swipe deck's header.
   *  Threaded from TouchpadLayout because that is where the single useMirror
   *  lives -- the deck must never open a second stream of its own. */
  deckScreen?: {
    on: boolean
    onToggle: () => void
    pane?: React.ReactNode
    zoomed?: Readonly<Record<string, boolean>>
    onZoom?: (label: string, on: boolean) => void
  }
  /** The floating control cluster + its header toggle, rendered inside the
   *  swipe deck. Threaded from TouchpadLayout for the same reason `deckScreen`
   *  is: every control handler it needs lives there, and this file is shared
   *  with the Mac window, which has the cluster on screen already. */
  deckIsland?: {
    on: boolean
    onToggle: () => void
    node?: React.ReactNode
  }
  /** The same pane + toggle for the open agent sheet. Separate from `deckScreen`
   *  because only one MirrorPane may exist at a time -- the host decides which
   *  of the three mount points is live, and hands the node to that one. */
  sessionScreen?: {
    on: boolean
    onToggle: () => void
    pane?: React.ReactNode
    controls?: React.ReactNode
    aspect?: number
  }
  /** Fires when a session sheet opens or closes, for the same reason
   *  `onDeckOpenChange` does: the host needs to know which pane may mount. */
  onSessionDetailOpenChange?: (open: boolean) => void
  /** Fires when the deck opens or closes. TouchpadLayout mounts the mirror in
   *  exactly ONE place at a time and needs this to know which: the deck is
   *  `position: fixed` and COVERS the trackpad rather than unmounting it, so
   *  without this both panes would mount, both would claim the single
   *  `videoRef`, and the loser would be left an orphan with no stream. */
  onDeckOpenChange?: (open: boolean) => void
  sessionMic?: SessionMicProps
  /** Which kinds of message may buzz this phone. Null while the Mac has not
   *  answered; optional because the Mac-side host has its own Settings for
   *  this and no socket to ask over. */
  pushFilter?: RelayPushFilter | null
  notifyLevel?: RelayNotifyPushLevel
  turnEndPing?: boolean
  onSetPush?: (verb: RelayVerbWire, on: boolean) => void
  onSetNotifyLevel?: (level: RelayNotifyPushLevel) => void
  onSetTurnEndPing?: (on: boolean) => void
  /** Asked on every open, not once on connect -- the Mac's own Settings can
   *  change these while the phone sits idle on the deck. */
  onRequestPushFilter?: () => void
}
// sessionId, not label: a new session's label changes once Claude names it
type Route = { name: 'home' } | { name: 'code'; label: string; sessionId?: string } | { name: 'chat' } | { name: 'starting' }
type Overlay = 'info' | 'chatInfo' | 'raw' | 'alerts' | 'deck' | 'picker' | 'chatPicker' | 'modelPicker' | 'answered' | 'pulse' | null
type Place = { route: Route; overlay: Overlay }

const sameRoute = (a: Route, b: Route): boolean =>
  a.name === b.name && (a.name !== 'code' || b.name !== 'code' || a.label === b.label)

const REFUSAL_VISIBLE_MS = 6000
const STEPS_KEY = 'mm-remote-ai-steps'

export interface AiChat {
  open: boolean
  sessions: ChatSessionSummary[]
  thread: OpenChatThread | null
  busy: boolean
  steps: ChatStep[]
  streamed: string
  onEnter: () => void
  onExit: () => void
  onOpenSession: (id: string) => void
  onNewSession: () => void
  onSend: (text: string, projectId?: string) => boolean
  onStop: () => void
  mic?: ComposerMic
  thoughtRecording?: boolean
}

function readSteps(): boolean {
  try {
    return localStorage.getItem(STEPS_KEY) === '1'
  } catch {
    return false
  }
}

function useRefusal(refusal: RelayRefusal | null | undefined): RelayRefusal | null {
  const [shown, setShown] = useState<RelayRefusal | null>(null)
  useEffect(() => {
    if (!refusal) return
    setShown(refusal)
    const clear = setTimeout(() => setShown(null), REFUSAL_VISIBLE_MS)
    return () => clearTimeout(clear)
  }, [refusal])
  return shown
}

export default function AiRoot(props: {
  code: CodeProps
  chat: AiChat
  ai: AiSession
  onOpenCode: () => void
  alertsAsk?: number
  onOpenNotes?: () => void
  onOpenSettings: () => void
  macName: string | null
  firstSteps: FirstStepsState | null
  send: (msg: PhoneRemoteMessage) => void
}): React.JSX.Element | null {
  const { code, chat, ai } = props
  const open = code.open || chat.open
  const { pending, resolved, onRespond, imageSrc } = code
  const [route, setRoute] = useState<Route>({ name: 'home' })
  const [mode, setMode] = useState<AiMode>('code')
  const [overlay, setOverlay] = useState<Overlay>(null)
  const [trail, setTrail] = useState<Place[]>([])
  const here = useRef<Place>({ route, overlay })
  useEffect(() => {
    here.current = { route, overlay }
  }, [route, overlay])
  const homeMemory = useRef<HomeMemory>({})
  const recallHome = useCallback(() => homeMemory.current, [])
  const rememberHome = useCallback((part: HomeMemory): void => {
    homeMemory.current = { ...homeMemory.current, ...part }
  }, [])
  const goTo = useCallback((next: Route): void => {
    const from = here.current
    if (from.overlay === null && sameRoute(from.route, next)) return
    if (from.route.name !== 'starting') setTrail((t) => [...t, from])
    setOverlay(null)
    setRoute(next)
  }, [])
  const goBack = (): void => {
    const prev = trail[trail.length - 1]
    setTrail(trail.slice(0, -1))
    setRoute(prev?.route ?? { name: 'home' })
    setOverlay(prev?.overlay ?? null)
  }
  const goHome = useCallback((): void => {
    setTrail([])
    setRoute({ name: 'home' })
  }, [])
  const [showSteps, setShowSteps] = useState(readSteps)
  const [sendError, setSendError] = useState<string | undefined>()
  const [watching, setWatching] = useState(false)
  const [outbox, setOutbox] = useState<{ label: string; text: string; at: number }[]>([])
  const mirrorStartedHere = useRef(false)
  const shownRefusal = useRefusal(code.refusal)

  const statusLine = useMemo(() => (code.status ? relayStatusLine(code.status, []) : null), [code.status])
  const live = useMemo(() => sessionsWorthListing(statusLine?.names ?? [], code.status?.sessionMarks, true), [statusLine, code.status?.sessionMarks])
  const archive = useSessionArchive(live, code.status?.sessionMarks, code.sessionArchiveSink)
  const deckSessions = useMemo(() => live.filter((s) => !archive.isArchived(s)), [live, archive.isArchived])
  const previous = previousList(resolved, code.dismissed ?? [])
  const history = useMemo(() => [...pending, ...resolved], [pending, resolved])
  const pushStatus = usePushStatus(open)

  const toggleSteps = (): void => {
    setShowSteps((v) => {
      try {
        localStorage.setItem(STEPS_KEY, v ? '0' : '1')
      } catch {
        /* private mode */
      }
      return !v
    })
  }

  const [welcomePicked, setWelcomePicked] = useState(false)
  const [openingChat, setOpeningChat] = useState<string | null>(null)
  const chatThreadId = chat.thread?.id
  useEffect(() => {
    if (openingChat !== null && chatThreadId === openingChat) setOpeningChat(null)
  }, [openingChat, chatThreadId])
  const close = useCallback((): void => {
    setOverlay(null)
    homeMemory.current = {}
    if (chat.open) chat.onExit()
    if (code.open) code.onClose()
  }, [chat, code])

  // hasThread, not chat.thread: every reply replaces the thread object and would reopen the chat you just left
  const hasThread = chat.thread !== null
  useEffect(() => {
    if (!chat.open || code.open) return
    setMode('chat')
    setRoute((r) => (r.name === 'chat' ? r : hasThread ? { name: 'chat' } : { name: 'home' }))
  }, [chat.open, code.open, hasThread])

  useEffect(() => {
    if (code.open && !chat.open) setMode('code')
  }, [code.open, chat.open])

  const changeMode = (next: AiMode): void => {
    setMode(next)
    goHome()
    if (next === 'chat' && !chat.open) chat.onEnter()
    if (next === 'code') {
      if (!code.open) props.onOpenCode()
      if (chat.open) chat.onExit()
    }
  }

  const project: RelayProjectWire | null = useMemo(
    () => ai.projects?.find((p) => p.id === ai.lastProjectId) ?? null,
    [ai.projects, ai.lastProjectId]
  )
  const { requestProjects, requestIdeas } = ai
  useEffect(() => {
    if (open && ai.projects === null) requestProjects()
  }, [open, ai.projects, requestProjects])
  const chatProject = useMemo(
    () => ai.projects?.find((p) => p.id === ai.chatProjectId) ?? null,
    [ai.projects, ai.chatProjectId]
  )
  const { requestModels } = ai
  useEffect(() => {
    if (open) requestModels(mode)
  }, [open, mode, requestModels])
  const projectId = project?.id
  const haveIdeas = projectId ? ai.ideas[projectId] !== undefined : true
  useEffect(() => {
    if (SHOW_IDEAS && open && mode === 'code' && projectId && !haveIdeas) requestIdeas(projectId, 'cached')
  }, [open, mode, projectId, haveIdeas, requestIdeas])

  const start = (text: string, file: File | null): void => {
    if (!text.trim()) return
    void ai.startSession({ project, text: text.trim(), file: file ?? undefined })
    goTo({ name: 'starting' })
  }
  const startIdea = (idea: ProjectIdea): void => start(idea.prompt, null)

  const [startQueue, setStartQueue] = useState<string[]>([])
  const started = matchStartedSession(ai.start, live)
  const { clearStart } = ai
  const startText = ai.start?.text
  const { onSessionReply } = code
  useEffect(() => {
    if (route.name !== 'starting' || !started) return
    const at = Date.now()
    startQueue.forEach((text) => onSessionReply?.(started.label, text))
    const sent = [startText ?? '', ...startQueue].filter(Boolean)
    setOutbox((prev) => [
      ...prev.filter((o) => at - o.at < OUTBOX_MS),
      ...sent.map((text, i) => ({ label: started.label, text, at: at + i }))
    ])
    setStartQueue([])
    setRoute({ name: 'code', label: started.label, sessionId: started.sessionId })
    clearStart()
  }, [route.name, started, clearStart, startQueue, startText, onSessionReply])

  const decisionsFor = useCallback(
    (session: AgentRelaySessionInfo): RelayRequestWire[] =>
      pending.filter((r) => sessionMatchesFrom(session, r.params.from)),
    [pending]
  )
  const waitingFor = useCallback(
    (session: AgentRelaySessionInfo): number => decisionsFor(session).filter((r) => !isIdleNotify(r)).length,
    [decisionsFor]
  )
  const loose = pending.filter((r) => !isIdleNotify(r) && !live.some((s) => sessionMatchesFrom(s, r.params.from)))

  const [deck, setDeck] = useState<SwipeCard[]>([])
  const [deckFailed, setDeckFailed] = useState<ReadonlySet<string>>(new Set())
  const deckCount = useMemo(() => buildDeck(deckSessions, history, Date.now()).length, [deckSessions, history])
  useEffect(() => {
    if (overlay !== 'deck') return
    const next = buildDeck(deckSessions, history, Date.now())
    setDeck((prev) => (prev.length === 0 ? next : mergeDeck(prev, next)))
  }, [overlay, deckSessions, history])
  const markDeckFailed = (label: string): void => {
    setDeckFailed((prev) => new Set(prev).add(label))
    setDeck(buildDeck(deckSessions, history, Date.now()))
  }
  const onDeckAffirm = (affirm: SwipeAffirm, card: SwipeCard): void => {
    setDeck((prev) => removeCard(prev, card.label))
    if (affirm.kind === 'respond') {
      onRespond(affirm.requestId, { answer: affirm.answer, questionIndex: affirm.questionIndex, via: affirm.via })
      return
    }
    if (affirm.kind === 'reply') {
      if (!code.onSessionReply) return markDeckFailed(affirm.label)
      code.onSessionReply(affirm.ref, affirm.text)
      return
    }
    if (affirm.kind === 'archive' && !archive.setArchived(card.session, true)) markDeckFailed(affirm.label)
  }
  const openDeck = (): void => {
    setDeck(buildDeck(deckSessions, history, Date.now()))
    setDeckFailed(new Set())
    setOverlay('deck')
  }

  const openSession = useCallback(
    (label: string): void => {
      const session = archive.all.find((s) => s.label === label || s.stated === label || s.sessionId === label)
      setMode('code')
      goTo({ name: 'code', label: session?.label ?? label, sessionId: session?.sessionId })
    },
    [archive.all, goTo]
  )

  const { alertsAsk } = props
  useEffect(() => {
    if (alertsAsk) setOverlay('alerts')
  }, [alertsAsk])

  const { onRequestPushFilter } = code
  useEffect(() => {
    if (overlay === 'alerts') onRequestPushFilter?.()
  }, [overlay, onRequestPushFilter])

  const [notice, setNotice] = useState<string | null>(null)
  const [micOwner, setMicOwner] = useState<string | null>(null)
  const revealedAt = code.sessionRevealedAt ?? null
  useEffect(() => {
    if (revealedAt === null) return
    setOverlay((o) => (o === 'info' ? null : o))
    setNotice(CONFIG.UI_LABELS.CODE_SESSION_GOTO_DONE)
  }, [revealedAt])
  const goToFailedCount = code.sessionGoToFailed?.size ?? 0
  useEffect(() => {
    if (goToFailedCount > 0) setNotice(CONFIG.UI_LABELS.CODE_SESSION_GOTO_MISSING)
  }, [goToFailedCount])
  useEffect(() => {
    if (!notice) return undefined
    const t = window.setTimeout(() => setNotice(null), NOTICE_MS)
    return () => window.clearTimeout(t)
  }, [notice])

  const { focusedRequestId, onFocusedRequestConsumed, onTapMissed, onTapTrace } = code
  useEffect(() => {
    if (!focusedRequestId || !code.open) return
    const hit = pending.find((r) => r.id === focusedRequestId) ?? resolved.find((r) => r.id === focusedRequestId)
    if (!hit) {
      if (code.linkOk === false) return
      onTapTrace?.(focusedRequestId, 'not-in-list')
      onTapMissed?.('not-in-list')
      onFocusedRequestConsumed?.()
      return
    }
    const match = live.find((s) => sessionMatchesFrom(s, hit.params.from))
    if (!match && isIdleNotify(hit) && !code.status) return
    onTapTrace?.(focusedRequestId, match ? 'session' : 'detail')
    if (match) openSession(match.label)
    else {
      if (isIdleNotify(hit)) onTapMissed?.('session-gone')
      setMode('code')
      goHome()
    }
    onFocusedRequestConsumed?.()
  }, [focusedRequestId, code.open, code.linkOk, code.status, pending, resolved, live, openSession, goHome, onFocusedRequestConsumed, onTapMissed, onTapTrace])

  const current =
    route.name === 'code'
      ? archive.all.find((s) => s.label === route.label) ??
        (route.sessionId ? archive.all.find((s) => s.sessionId === route.sessionId) : undefined) ??
        null
      : null
  const currentLabel = current?.label
  const { watchTranscript } = ai
  useEffect(() => {
    if (!open || !currentLabel) return
    return watchTranscript(currentLabel)
  }, [open, currentLabel, watchTranscript])

  const { requestPulse } = ai
  useEffect(() => {
    if (open && currentLabel) requestPulse(currentLabel)
  }, [open, currentLabel, requestPulse])

  const currentDecisions = current ? decisionsFor(current) : []
  const firstDecision = currentDecisions[0]?.id ?? null
  useEffect(() => {
    nativeBridge.visibleRelayRequest(open ? firstDecision : null)
    return () => nativeBridge.visibleRelayRequest(null)
  }, [open, firstDecision])

  const subject = current ? sessionActivity(current.stated ?? current.label, history).derivedSubject : undefined
  const suggestKey = current ? cardSuggestKey({ label: current.label, session: current, subject }) : undefined
  const suggestions = suggestKey ? code.sessionSuggestions?.[suggestKey] : undefined
  const { onRequestSuggestions } = code
  const suggestAsk = current && suggestKey && !suggestions ? suggestContext(current, subject) : ''
  useEffect(() => {
    if (currentLabel && suggestAsk) onRequestSuggestions?.(currentLabel, suggestAsk)
  }, [currentLabel, suggestAsk, onRequestSuggestions])

  useEffect(() => setSendError(undefined), [route])

  const onDetailOpen = code.onSessionDetailOpenChange
  useEffect(() => {
    if (open || !watching) return
    setWatching(false)
    onDetailOpen?.(false)
  }, [open, watching, onDetailOpen])

  if (!open) return null

  const sessionMic: ComposerMic | undefined = code.sessionMic
  const mic = sessionMic && micOwner ? { ...sessionMic, draftPatch: null } : sessionMic
  const cardMic = (id: string): ComposerMic | undefined =>
    sessionMic && {
      ...sessionMic,
      onMicDown: () => {
        setMicOwner(id)
        sessionMic.onMicDown()
      },
      draftPatch: micOwner === id ? sessionMic.draftPatch : null,
      onDraftConsumed: () => {
        setMicOwner(null)
        sessionMic.onDraftConsumed()
      }
    }
  const macScreen = code.sessionScreen
  const onWatch = macScreen
    ? () => {
        setOverlay(null)
        mirrorStartedHere.current = !macScreen.on
        code.onSessionDetailOpenChange?.(true)
        if (!macScreen.on) macScreen.onToggle()
        setWatching(true)
      }
    : undefined
  const stopWatching = (): void => {
    setWatching(false)
    code.onSessionDetailOpenChange?.(false)
    if (mirrorStartedHere.current && macScreen?.on) macScreen.onToggle()
    mirrorStartedHere.current = false
  }

  const answerFromPulse = (): void => {
    const target = currentDecisions.find((r) => !isIdleNotify(r))
    setOverlay(null)
    window.requestAnimationFrame(() => {
      const card = target && document.querySelector(`[data-request-id="${CSS.escape(target.id)}"]`)
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' })
      else document.querySelector('.ai .aiScroll')?.scrollTo({ top: 1e9, behavior: 'smooth' })
    })
  }

  const decisionNodes = (requests: RelayRequestWire[], named = false): React.ReactNode =>
    requests.map((r) => {
      const session = live.find((s) => sessionMatchesFrom(s, r.params.from))
      return (
        <DecisionCard
          key={r.id}
          request={r}
          onRespond={onRespond}
          imageSrc={imageSrc}
          onPickPhoto={code.onPickPhoto}
          title={named ? (session?.project?.name ?? r.params.from) : undefined}
          session={session}
          mic={cardMic(r.id)}
          onOpenSession={session ? () => openSession(session.label) : undefined}
        />
      )
    })

  let screen: React.ReactNode
  if (route.name === 'code' && current) {
    const row = sessionRow(current, Date.now())
    const busy = row.health === 'working'
    const said = codeThreadItems(current.label, ai.transcripts[current.label] ?? [], showSteps)
    const heard = said.filter((i) => i.kind === 'you').map((i) => (i.kind === 'you' ? i.text : ''))
    const waiting = outbox.filter(
      (o) => o.label === current.label && Date.now() - o.at < OUTBOX_MS && !heard.some((t) => t.includes(o.text))
    )
    const label = current.label
    const pulse: PulseState = ai.pulse[label] ?? NO_PULSE
    const openPulse = (): void => {
      setOverlay('pulse')
      if (pulse.rows.length === 0 && !pulse.scoring) ai.scorePulse(label, false)
    }
    const items: ThreadItem[] = [
      ...said,
      ...waiting.map((o): ThreadItem => ({ kind: 'you', key: `out${o.at}`, at: o.at, text: o.text, media: [] }))
    ]
    screen = (
      <Conversation
        title={row.name ?? row.repo ?? current.label}
        spotKey={`code:${current.label}`}
        subtitle={[current.project?.name ?? row.repo, row.state_text].filter(Boolean).join(' · ')}
        project={current.project}
        health={row.health}
        items={items}
        statusText={busy ? row.state_text : waiting.length ? 'Sending to Claude…' : null}
        decisions={decisionNodes(currentDecisions.filter((r) => !isIdleNotify(r)))}
        suggestions={suggestions}
        onBack={goBack}
        onWatch={onWatch}
        onMore={() => setOverlay('info')}
        onPulse={openPulse}
        pulseDot={pulse.rows.length ? pulseDot(pulse.rows[pulse.rows.length - 1]) : undefined}
        placeholder={`Reply to ${row.name ?? 'Claude'}`}
        busy={busy || waiting.length > 0}
        canReply={sessionCanReply(current) && !current.stale}
        allowPhoto={Boolean(code.onSessionAttach)}
        mic={mic}
        sendError={sendError}
        loading={!ai.transcripts[current.label] && waiting.length === 0}
        emptyText="Nothing said yet"
        onStop={code.onSessionStop ? () => code.onSessionStop?.(current.label) : undefined}
        onUndo={(at) => ai.undoTurn(current.label, at)}
        undoError={ai.undoError?.label === current.label ? ai.undoError : null}
        onSend={(text, file) => {
          setSendError(undefined)
          const reply = (): void => {
            if (!text.trim()) return
            code.onSessionReply?.(current.label, text.trim())
            setOutbox((prev) => [...prev.filter((o) => Date.now() - o.at < OUTBOX_MS), { label: current.label, text: text.trim(), at: Date.now() }])
          }
          if (!file || !code.onSessionAttach) return reply()
          void code.onSessionAttach(current.label, file).then((ok) => {
            if (!ok) setSendError('The photo did not send. Try again.')
            reply()
          })
        }}
      />
    )
  } else if (route.name === 'starting') {
    const s = ai.start
    const items: ThreadItem[] = [
      ...(s ? [s.text] : []),
      ...startQueue
    ].map((text, i): ThreadItem => ({ kind: 'you', key: `start${i}`, at: i, text, media: [] }))
    const retryProject = ai.projects?.find((p) => p.id === s?.projectId) ?? project
    screen = (
      <Conversation
        title={s?.projectName || 'New agent'}
        subtitle={s?.error ? 'Did not start' : 'Starting Claude'}
        project={retryProject}
        items={items}
        statusText={s && !s.error ? (s.projectName ? `Starting Claude in ${s.projectName}…` : 'Starting Claude…') : null}
        onBack={() => {
          if (s?.error) clearStart()
          setStartQueue([])
          goBack()
        }}
        placeholder={s?.error ? 'Try again' : 'Add more while it starts'}
        busy={Boolean(s && !s.error)}
        allowPhoto={Boolean(s?.error)}
        mic={mic}
        sendError={s?.error}
        onSend={(text, file) => {
          if (s?.error || !s) return start(text || s?.text || '', file)
          if (text.trim()) setStartQueue((q) => [...q, text.trim()])
        }}
      />
    )
  } else if (route.name === 'chat') {
    const last = chat.steps[chat.steps.length - 1]
    const thread = openingChat === null ? chat.thread : null
    screen = (
      <Conversation
        title={thread?.title || chat.sessions.find((c) => c.id === openingChat)?.title || 'New chat'}
        spotKey={`chat:${openingChat ?? chat.thread?.id ?? 'new'}`}
        loading={openingChat !== null}
        project={null}
        items={thread ? chatThreadItems(thread, showSteps) : []}
        streamed={chat.streamed}
        statusText={chat.busy ? (last ? [last.phase, last.detail].filter(Boolean).join(' ') : 'Thinking…') : null}
        onBack={goBack}
        onWatch={onWatch}
        onMore={() => setOverlay('chatInfo')}
        placeholder="Ask a follow-up"
        busy={chat.busy}
        onStop={chat.onStop}
        mic={chat.mic}
        emptyText="Ask anything"
        onSend={(text) => text.trim() !== '' && chat.onSend(text.trim())}
      />
    )
  } else {
    screen = (
      <AiHome
        mode={mode}
        onMode={changeMode}
        onClose={close}
        project={mode === 'chat' ? chatProject : project}
        onOpenPicker={() => setOverlay(mode === 'chat' ? 'chatPicker' : 'picker')}
        models={ai.models[mode]}
        onOpenModels={() => setOverlay('modelPicker')}
        ideas={projectId ? ai.ideas[projectId] : undefined}
        onRefreshIdeas={() => projectId && requestIdeas(projectId, 'refresh')}
        onStart={start}
        onStartIdea={startIdea}
        startError={ai.start?.error}
        onChatAsk={(text) => {
          setOpeningChat(null)
          chat.onNewSession()
          if (!chat.onSend(text, chatProject?.id)) return false
          goTo({ name: 'chat' })
          return true
        }}
        chatSessions={chat.sessions}
        onOpenChat={(id) => {
          setOpeningChat(chat.thread?.id === id ? null : id)
          chat.onOpenSession(id)
          goTo({ name: 'chat' })
        }}
        sessions={archive.sessions}
        recall={recallHome}
        remember={rememberHome}
        waitingFor={waitingFor}
        isPinned={archive.isPinned}
        onOpenSession={openSession}
        looseDecisions={loose.length > 0 ? decisionNodes(loose, true) : undefined}
        startHere={
          props.firstSteps?.welcome && !welcomePicked ? (
            <Welcome
              onPick={(pick) => {
                setWelcomePicked(true)
                props.send({ type: 'welcomePick', pick })
                if (pick === 'trackpad') close()
                else if (pick !== 'dismiss') changeMode(pick)
              }}
            />
          ) : undefined
        }
        needsCount={pending.filter((r) => !isIdleNotify(r)).length}
        deckCount={deckCount}
        onOpenDeck={openDeck}
        answeredCount={previous.length}
        onOpenAnswered={() => setOverlay('answered')}
        archivedCount={archive.count}
        showArchived={archive.showArchived}
        onShowArchived={archive.setShowArchived}
        mic={mode === 'chat' ? chat.mic : mic}
        thoughtRecording={chat.thoughtRecording}
        onOpenNotes={props.onOpenNotes}
        onOpenSettings={props.onOpenSettings}
        onWatch={onWatch}
        linkOk={code.linkOk !== false}
      />
    )
  }

  if (overlay === 'deck') {
    return (
      <SwipeDeckSheet
        open
        deck={deck}
        onBack={() => setOverlay(null)}
        onClose={() => setOverlay(null)}
        suggestions={code.sessionSuggestions}
        onRequestSuggestions={code.onRequestSuggestions}
        failed={deckFailed}
        onAffirm={onDeckAffirm}
        onOpenSession={openSession}
        onGoTo={code.onSessionGoTo}
        goToFailed={code.sessionGoToFailed}
        statusLine={statusLine ?? undefined}
      />
    )
  }

  if (overlay === 'raw' && current) {
    return (
      <SessionFullScreen
        open
        session={current}
        history={history.filter((r) => sessionMatchesFrom(current, r.params.from))}
        now={Date.now()}
        initialMode="raw"
        onCollapse={() => setOverlay(null)}
        imageSrc={imageSrc}
        onReply={code.onSessionReply}
        onStop={code.onSessionStop}
        onAttach={code.onSessionAttach}
        sent={code.sessionSent?.[current.label]}
        onSentGet={code.onSessionSentGet}
        onGoTo={code.onSessionGoTo ? () => code.onSessionGoTo?.(current.label) : undefined}
        goToFailed={code.sessionGoToFailed?.has(current.label)}
        mic={code.sessionMic}
        suggestions={code.sessionSuggestions}
        onRequestSuggestions={code.onRequestSuggestions}
      />
    )
  }

  return (
    <div className="ai" role="dialog" aria-label="AI">
      {overlay === 'alerts' ? (
        <div className="aiScroll aiAlerts">
          <AlertSettings
            status={pushStatus}
            filter={code.pushFilter ?? null}
            notifyLevel={code.notifyLevel ?? 'all'}
            turnEndPing={code.turnEndPing ?? DEFAULT_RELAY_TURN_END_PING}
            onSetPush={code.onSetPush}
            onSetNotifyLevel={code.onSetNotifyLevel}
            onSetTurnEndPing={code.onSetTurnEndPing}
            onClose={() => setOverlay(null)}
          />
        </div>
      ) : (
        screen
      )}
      {notice && (
        <div className="aiToast" data-tone="ok" role="status">
          {notice}
        </div>
      )}
      {shownRefusal && (
        <div className="aiToast" role="alert">
          {refusalMessage(shownRefusal)}
        </div>
      )}
      {archive.error && (
        <div className="aiToast" role="alert">
          {archive.error}
          <Button variant="bare" type="button" aria-label="Dismiss" onClick={archive.clearError}>
            <X size={16} />
          </Button>
        </div>
      )}

      {overlay === 'info' && current && (
        <SessionInfoSheet
          session={current}
          info={ai.info[current.label]}
          onRequestInfo={ai.requestInfo}
          onClose={() => setOverlay(null)}
          git={{
            state: ai.git[current.label],
            busy: ai.gitBusy[current.label],
            note: ai.gitNote[current.label],
            onAsk: (op) => ai.requestGit(current.label, op),
            onClearNote: () => ai.clearGitNote(current.label)
          }}
          actions={{
            onGoTo: code.onSessionGoTo,
            goToFailed: code.sessionGoToFailed?.has(current.label),
            onWatch,
            onZoom: code.onSessionZoom,
            zoomed: code.sessionZoomed?.[current.label],
            onRaw: () => setOverlay('raw'),
            showSteps,
            onSteps: toggleSteps,
            pinned: archive.isPinned(current),
            onPin: (on) => archive.setPinned(current, on),
            archived: archive.isArchived(current),
            onArchive: (on) => {
              archive.setArchived(current, on)
              if (on) goBack()
            }
          }}
        />
      )}

      {overlay === 'chatInfo' && (
        <ChatInfoSheet
          title={chat.thread?.title || 'New chat'}
          messages={chat.sessions.find((c) => c.id === chat.thread?.id)?.messageCount ?? 0}
          busy={chat.busy}
          showSteps={showSteps}
          onSteps={toggleSteps}
          onNewChat={() => {
            setOverlay(null)
            setOpeningChat(null)
            chat.onNewSession()
          }}
          onClose={() => setOverlay(null)}
        />
      )}

      {watching && (
        <ScreenView
          pane={macScreen?.pane}
          controls={macScreen?.controls}
          macName={props.macName}
          send={props.send}
          onBack={stopWatching}
        />
      )}

      {overlay === 'picker' && (
        <ProjectPicker
          projects={ai.projects}
          current={project?.id ?? null}
          allowNone
          onClose={() => setOverlay(null)}
          onPick={(p) => {
            ai.chooseProject(p?.id ?? null)
            setOverlay(null)
          }}
        />
      )}

      {overlay === 'modelPicker' && (
        <ModelPicker
          models={ai.models[mode]}
          title={mode === 'chat' ? 'Model' : 'Coding agent'}
          note={mode === 'chat' ? 'Your Mac chats use this model too' : 'New agents from your Mac use this too'}
          onClose={() => setOverlay(null)}
          onPick={(id) => {
            ai.chooseModel(mode, id)
            setOverlay(null)
          }}
        />
      )}

      {overlay === 'chatPicker' && (
        <ProjectPicker
          projects={ai.projects}
          current={chatProject?.id ?? null}
          allowNone
          onClose={() => setOverlay(null)}
          onPick={(p) => {
            ai.chooseChatProject(p?.id ?? null)
            setOverlay(null)
          }}
        />
      )}

      {overlay === 'pulse' && current && (
        <Sheet label="Pulse" onClose={() => setOverlay(null)}>
          <div className="phonePulse">
            <PulsePanel
              sessionRef={current.label}
              state={ai.pulse[current.label] ?? NO_PULSE}
              onScore={(force) => ai.scorePulse(current.label, force)}
              onScope={(scope) => ai.setPulseScope(current.label, scope)}
              onChip={(prompt) => {
                code.onSessionReply?.(current.label, prompt)
                setOutbox((prev) => [...prev.filter((o) => Date.now() - o.at < OUTBOX_MS), { label: current.label, text: prompt, at: Date.now() }])
                return Promise.resolve()
              }}
              onAnswer={currentDecisions.some((r) => !isIdleNotify(r)) ? answerFromPulse : undefined}
              onClose={() => setOverlay(null)}
            />
          </div>
        </Sheet>
      )}
      {overlay === 'answered' && (
        <Sheet label="Answered" onClose={() => setOverlay(null)}>
          <div className="aiHeadTitle">
            <h1 style={{ flex: 1 }}>Answered</h1>
            <Button variant="bare" type="button" className="aiIconBtn" aria-label="Close" onClick={() => setOverlay(null)}>
              <X size={22} />
            </Button>
          </div>
          {previous.length === 0 ? (
            <div className="aiEmpty">Nothing answered yet</div>
          ) : (
            previous.map((r) => {
              const match = live.find((s) => sessionMatchesFrom(s, r.params.from))
              return (
                <ResolvedCard
                  key={r.id}
                  request={r}
                  onUndismiss={code.onUndismiss}
                  onExpand={match ? () => openSession(match.label) : undefined}
                  imageSrc={imageSrc}
                  sessions={live}
                  onOpenSession={openSession}
                />
              )
            })
          )}
        </Sheet>
      )}
    </div>
  )
}
