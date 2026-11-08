// One independent Mighty conversation, fully self-contained: its own session, backend
// picker, message list, and input box. This is what a single grid cell in PaneGrid
// renders. Extracted from ChatTab's conversation column (MightyApp.tsx) — every piece
// of state that used to be a ChatTab-wide singleton (session, busy/phase/liveText,
// sessionIdRef, scrollRef, inFlightRef) is now scoped to ONE pane instance, so N panes
// running concurrently never cross-talk. See the onPhase/onEvent sessionId filter below
// — that's the bugfix this multi-pane feature required (ChatTab never needed it because
// only one session was ever live).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Download,
  MessageSquare,
  ArrowUp,
  Square,
  Volume2,
  VolumeX,
  SquareTerminal
} from 'lucide-react'
import { AttachBar, AttachButton } from '../components/AttachBar'
import '../components/AgentProjects.css'
import { Button } from '../components/Button'
import { TalkButton, TalkSendButton } from '../components/TalkButton'
import { Row, Stack } from '../components/Layout'
import { useSpokenReplies } from '../hooks/useSpokenReplies'
import { useAttachments, useComposerInbox } from '../hooks/useAttachments'
import { useInterval } from '../hooks/useInterval'
import { CONFIG } from '../../../shared/config'
import { devLog } from '../../../shared/env'
import { Message } from './MightyConversationView'
import { QUICK_START_PROMPTS, EMPTY_TIMELINE, routeFor, type SendRoute } from './mighty-shared'
import { ChatModelPicker } from './ChatModelPicker'
import { RUN_EVENT } from '../../../shared/types'
import { foldRunEvent } from '../lib/run-events'
import { splitPendingDraft } from './pending-draft'
import { titleUnderlineTone, type PaneOpenColorId } from './pane-colors'
import { ownsLivePush } from './live-event-owner'
import { shouldWipeUnboundPane } from './session-resolve'
import { paneLifecycleLog } from './pane-lifecycle-log'
import type { TimelineItem } from '../lib/run-events'
import { ProjectAvatar } from '../components/ProjectIcon'
import { ProjectScopePicker } from '../components/ProjectScopePicker'
import { useChatShowSteps, useShowTiming } from './chat-details'
import type { BackendId, HistoryItem, MediaAttachment, MightyProject, MightySession } from '../../../shared/types'

/** A History-tab row handed to whichever pane is focused when Reuse/Continue is
 *  clicked. `nonce` makes each handoff a distinct value even for the same run_id
 *  clicked twice in a row, so the consuming effect (keyed on this prop) fires every
 *  time, not just on change — mirrors the pre-multi-pane HistoryHandoff shape. */
export interface ConversationHandoff {
  item: HistoryItem
  kind: 'reuse' | 'continue'
  nonce: number
  /** Set on a 'continue' whose run still resolves to a real Mighty session. The tab
   *  opens that session in the active pane instead of routing the handoff here, so the
   *  follow-up appends to the actual conversation rather than a transient copy. Absent
   *  for rows predating the turn-level run_id stamp, which still seed inline. */
  openSessionId?: string
}

export interface ConversationPaneProps {
  /** This pane's durable identity — used only to key React state/effects per
   *  instance; ConversationPane never reads/writes it directly. */
  paneId: string
  /** The session this pane is bound to, or null for a not-yet-started pane (the
   *  first send() lazily creates one, same as ChatTab's historical null-session
   *  behavior). Owned by ChatWorkspacesTab (persisted inside ChatPaneRef). */
  sessionId: string | null
  /** Colored underline under the title — matches the sidebar bar for this pane slot. */
  slotColor?: PaneOpenColorId | null
  /** Fired the moment a brand-new session is created by this pane's first send(),
   *  so the caller can persist the pointer. Never fired again after that — once a
   *  pane has a session id it keeps it for the pane's lifetime (no session-switch
   *  UI inside a pane in v1; closing/reopening the pane is how you'd change it). */
  onSessionCreated: (sessionId: string) => void
  /** Project the session this pane lazily creates should be filed under ("new chat"
   *  from a project header). Only consulted while the pane has no session yet. */
  pendingProjectId?: string
  /** Persona name, mirrors ChatTab's `name` prop (from MightySettings). */
  name: string
  /** A History Reuse/Continue request routed to this pane (only the focused pane
   *  of the active tab receives one — see ChatWorkspacesTab), or null. */
  handoff?: ConversationHandoff | null
  /** Called once `handoff` has been applied, so the parent can clear it — otherwise
   *  the same request would re-fire on the next render. */
  onHandoffConsumed?: () => void
  /** Fired whenever this pane's turn list changes — lets the tab-level context rail
   *  (Outputs/Sources) mirror whichever pane is focused, without the rail owning a
   *  session of its own. Only the focused pane's caller wires this in practice. */
  onTurnsChange?: (turns: MightySession['turns']) => void
  /** Fired whenever this pane's in-flight runId changes (null once it settles).
   *  Lets the window-level Esc handler stop live runs without owning run state —
   *  the runId is per-pane, the key handler is a singleton. */
  onRunChange?: (paneId: string, runId: string | null) => void
  onDraftTitle?: (title: string | null) => void
  /** Bound session id missing on disk — parent clears the pane binding. */
  onSessionMissing?: () => void
  /** Pane-chrome buttons rendered as SIBLINGS in this pane's header row, not as an
   *  overlay — an absolutely-positioned cluster sat on top of the backend chip and
   *  covered it. Split either side of the chip (add before, close after) so the
   *  provider stays put and readable no matter which buttons are showing. */
  headerAddAction?: React.ReactNode
  headerCloseAction?: React.ReactNode
  emptyAction?: React.ReactNode
  projects?: MightyProject[]
  onPendingProjectChange?: (projectId: string | undefined) => void
  onNewProject?: () => void
  onEditProject?: (project: MightyProject) => void
  onRegisterAttach?: (pick: (() => void) | null) => void
  onPendingSourcesChange?: (paths: string[]) => void
  onSessionsChanged?: () => void
  onRouteToAgent?: (cwd: string, message: string, paths: string[]) => void
}

/** One pane's mutable session-scoped state, all local to this component instance —
 *  the entire point of the extraction: nothing here is shared across panes. */
export function ConversationPane({
  paneId,
  sessionId,
  pendingProjectId,
  slotColor = null,
  onSessionCreated,
  name,
  handoff,
  onHandoffConsumed,
  onTurnsChange,
  onRunChange,
  onDraftTitle,
  onSessionMissing,
  headerAddAction,
  headerCloseAction,
  emptyAction,
  projects = [],
  onPendingProjectChange,
  onNewProject,
  onEditProject,
  onRegisterAttach,
  onPendingSourcesChange,
  onSessionsChanged,
  onRouteToAgent
}: ConversationPaneProps): React.ReactElement {
  const [session, setSession] = useState<MightySession | null>(null)
  const [titleDraft, setTitleDraft] = useState<string | null>(null)
  // True only while a BOUND session is being fetched. Without it, `session === null`
  // means both "this pane has no chat" and "its chat hasn't arrived yet", so a pane
  // opening a real conversation flashed the onboarding prompts for the length of the
  // IPC round-trip. Seeded from the prop: a pane can mount already bound.
  const [resolving, setResolving] = useState(sessionId !== null)
  const [input, setInput] = useState('')
  const att = useAttachments()
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [talkLive, setTalkLive] = useState(false)
  useComposerInbox(inputRef, att.addPaths)
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState('')
  const [liveTimeline, setLiveTimeline] = useState<TimelineItem[]>([])
  const liveSeq = useRef(0)
  const [backend, setBackend] = useState<BackendId | null>(null)
  const [exportMenuOpen, setExportMenuOpen] = useState(false)
  const [exportDone, setExportDone] = useState(false)
  const exportMenuRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [renderMarkup, setRenderMarkup] = useState(true)
  const [showResponseTime] = useShowTiming()
  const [showSteps] = useChatShowSteps()

  // Mirrors this pane's OWN session id for the once-registered onPhase/onEvent/
  // onTurnAppended subscriptions below, which can't close over `session` without
  // going stale. Starts null so the first mount always fetches a bound session.
  const sessionIdRef = useRef<string | null>(null)
  // Identity token for this pane's most recently issued send() — lets an in-flight
  // response tell "I'm still this pane's current send" from "a newer send superseded
  // me" (e.g. the same pane re-sent before the first reply landed). One token per
  // PANE, not global, so pane A's in-flight state can never be clobbered by pane B.
  const inFlightRef = useRef<object | null>(null)
  // Correlation id for this pane's in-flight send, minted here and echoed back on
  // every phase/event push for that run. Null when nothing is in flight.
  const clientRunIdRef = useRef<string | null>(null)
  const steerRef = useRef<{ text: string; attachments: MediaAttachment[] } | null>(null)
  const onSessionMissingRef = useRef(onSessionMissing)
  onSessionMissingRef.current = onSessionMissing
  const onSessionCreatedRef = useRef(onSessionCreated)
  onSessionCreatedRef.current = onSessionCreated

  // Does a live phase/event belong to THIS pane?
  //
  // Matched on clientRunId FIRST, because a session id can't answer this during the
  // window where it matters: on a pane's first send no session exists yet, so every
  // fresh pane compared null-to-null and accepted every other fresh pane's stream —
  // three panes rendering one pane's tokens. The correlation id is unique per send and
  // known to both sides before any session does, so it decides on its own.
  //
  // The sessionId fallback covers runs this pane didn't start (the panel or the phone
  // asking into the session it's bound to), which carry no clientRunId.
  const ownsLiveSession = useCallback(
    (evId: string, evRunId?: string): boolean =>
      ownsLivePush(
        { sessionId: sessionIdRef.current, clientRunId: clientRunIdRef.current },
        { sessionId: evId, clientRunId: evRunId }
      ),
    []
  )

  // Bind on the first push, not when the reply ends: a reload or remount mid-reply otherwise reopens an empty chat.
  const bindFromLivePush = useCallback((evId: string, evRunId?: string): void => {
    if (!evId || sessionIdRef.current || !evRunId || evRunId !== clientRunIdRef.current) return
    sessionIdRef.current = evId
    paneLifecycleLog.send(paneId, 'bound', evId)
    onSessionCreatedRef.current(evId)
  }, [paneId])

  useEffect(() => {
    void window.api.mighty.getRenderMarkup().then(setRenderMarkup)
  }, [])

  useEffect(() => {
    onRegisterAttach?.(() => void att.pick())
    return () => onRegisterAttach?.(null)
  }, [att, onRegisterAttach])

  useEffect(() => {
    onPendingSourcesChange?.(att.attachments.map((a) => a.path))
  }, [att.attachments, onPendingSourcesChange])

  const scopeProjectId = session?.projectId ?? pendingProjectId
  const scopeFolder = projects.find((p) => p.id === scopeProjectId)?.repoFolder
  const scopeProject = projects.find((p) => p.id === scopeProjectId)
  const scopeName = scopeProject?.name
  const [routeOverride, setRouteOverride] = useState<SendRoute | null>(null)
  if (input.trim() === '' && routeOverride !== null) setRouteOverride(null)
  const route: SendRoute = !onRouteToAgent
    ? 'chat'
    : scopeFolder
      ? (routeOverride ?? routeFor(input, true))
      : 'chat'

  const changeProject = useCallback(
    async (projectId: string | undefined) => {
      const sid = sessionIdRef.current
      if (!sid) {
        onPendingProjectChange?.(projectId)
        return
      }
      const ok = await window.api.mighty.assignSessionProject(sid, projectId)
      if (!ok) return
      const fresh = await window.api.mighty.getSession(sid)
      if (fresh && sessionIdRef.current === sid) setSession(fresh)
      onSessionsChanged?.()
    },
    [onPendingProjectChange, onSessionsChanged]
  )

  // Resolve this pane's bound session once on mount. A pane with no sessionId yet
  // (fresh pane, nothing sent) simply starts empty — send() lazily creates one.
  useEffect(() => {
    // Unbound (a pane reset to "no chat"): WIPE, don't bail. Returning early here left
    // the previous conversation's turns rendered and sessionIdRef still pointing at it,
    // so a supposedly-new chat showed the old one and the next send appended to it.
    if (!sessionId) {
      if (!shouldWipeUnboundPane(sessionId, inFlightRef.current !== null)) {
        paneLifecycleLog.resolve(paneId, 'skip', null, true)
        return
      }
      paneLifecycleLog.resolve(paneId, 'wipe', null, false)
      sessionIdRef.current = null
      // Disown any in-flight send too. Its `inFlightRef.current === sendToken` checks
      // all fail now, so a reply for the chat we just left can't re-bind this pane or
      // paint its answer into the empty one the user is looking at.
      inFlightRef.current = null
      clientRunIdRef.current = null
      setSession(null)
      setResolving(false)
      setInput('')
      setLiveTimeline([])
      setPhase('')
      setBusy(false)
      return
    }
    if (sessionIdRef.current === sessionId) {
      paneLifecycleLog.resolve(paneId, 'skip', sessionId, inFlightRef.current !== null)
      setResolving(false)
      return
    }
    paneLifecycleLog.resolve(paneId, 'fetch', sessionId, inFlightRef.current !== null)
    // Rebind the ref BEFORE the await, not after: send() reads it to decide which
    // conversation a turn belongs to, so leaving it on the previous chat for the
    // length of a getSession round-trip is exactly long enough to type and hit Enter.
    sessionIdRef.current = sessionId
    // Drop the OUTGOING chat's content synchronously. Leaving it mounted for the
    // length of the getSession round-trip is what shows an existing conversation
    // inside a chat you just opened — brief, but it's also the window in which a
    // send would target the wrong turn list.
    // Same disown as the unbind branch: a reply for the chat being navigated AWAY
    // from must not land in the one being navigated to.
    inFlightRef.current = null
    clientRunIdRef.current = null
    setSession(null)
    setResolving(true)
    setLiveTimeline([])
    setPhase('')
    setBusy(false)
    void (async () => {
      const s = await window.api.mighty.getSession(sessionId)
      // A pane rebound again (or unbound) while this was in flight — the newer
      // binding owns the pane now, so this stale result must not paint over it.
      if (sessionIdRef.current !== sessionId) return
      if (!s) {
        onSessionMissingRef.current?.()
        setSession(null)
        setResolving(false)
        sessionIdRef.current = null
        return
      }
      setSession(s)
      setResolving(false)
      sessionIdRef.current = s.id
      // Whatever the user had typed belonged to the PREVIOUS session. Clearing it here
      // is what stops a draft leaking across a chat switch; the pending-draft effect
      // below then seeds this session's own unsent turn, if it has one.
      setInput('')
    })()
  }, [sessionId, paneId])

  // A History-tab Reuse/Continue request routed to this pane. Reuse just prefills
  // the composer; Continue rebuilds the run's transcript as a transient unbound
  // session (id: '') so it renders immediately, falling back to reuse if
  // resumeSession comes back empty. Copied verbatim from the pre-multi-pane
  // ChatTab — only the target (this pane's own state, not a singleton) changed.
  useEffect(() => {
    if (!handoff) return
    // ChatTab handles this one by opening the real session in this pane — seeding a
    // transient copy here too would race it and win, which is the bug being fixed.
    if (handoff.openSessionId && handoff.kind === 'continue') return
    const { item, kind } = handoff
    void (async () => {
      if (kind === 'reuse') {
        setInput(item.instruction)
        onHandoffConsumed?.()
        return
      }
      const res = await window.api.resumeSession(item.run_id)
      if (!res.ok || res.turns.length === 0) {
        setInput(item.instruction)
        onHandoffConsumed?.()
        return
      }
      const now = new Date().toISOString()
      setSession({
        schema_version: 1,
        id: '',
        created: now,
        updated: now,
        title: item.instruction,
        turns: res.turns.map((t) => ({
          source: 'chat',
          q: t.q,
          a: t.a,
          ts: now,
          ok: true,
          backend: res.backend
        }))
      })
      sessionIdRef.current = null
      onHandoffConsumed?.()
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handoff])

  const resolvePaneBackend = useCallback(async (): Promise<void> => {
    const p = await window.api.settingsGetPrefs()
    const id = sessionIdRef.current
    const bound = id ? await window.api.mighty.getSession(id) : null
    let resolved: BackendId = backend ?? p.backend
    if (bound?.backend) {
      resolved = bound.backend
    } else if (bound?.projectId) {
      const project = (await window.api.mighty.listProjects()).find((x) => x.id === bound.projectId)
      if (project?.defaultBackend) resolved = project.defaultBackend
    }
    setBackend(resolved)
  }, [backend])

  useEffect(() => {
    void resolvePaneBackend()
    // Re-resolve when this pane rebinds to a different session (relaunch, pane swap).
  }, [resolvePaneBackend, sessionId])

  useEffect(() => {
    const onFocus = (): void => void resolvePaneBackend()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [resolvePaneBackend])

  const chooseBackend = useCallback(
    async (id: BackendId) => {
      const previous = backend
      setBackend(id)
      const sid = sessionIdRef.current
      // No session yet: the choice rides along on the first send(), which pins it.
      if (!sid) return
      try {
        await window.api.mighty.setSessionBackend(sid, id)
      } catch (err) {
        devLog.error('Failed to set session backend', err)
        setBackend(previous)
      }
    },
    [backend]
  )


  useEffect(() => {
    if (!exportMenuOpen) return
    const onClick = (e: MouseEvent): void => {
      if (!exportMenuRef.current?.contains(e.target as Node)) setExportMenuOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [exportMenuOpen])

  const exportChat = useCallback(
    async (format: 'markdown' | 'json') => {
      const sid = sessionIdRef.current
      setExportMenuOpen(false)
      if (!sid) return
      const ok = await window.api.mighty.exportSession(sid, format)
      if (ok) {
        setExportDone(true)
        setTimeout(() => setExportDone(false), 2000)
      }
    },
    []
  )

  // Live-activity phase push, filtered to THIS pane's session — every other pane's
  // run also fires this event, so without the sessionId check pane A's "Reading…"
  // would flash into pane B's pending bubble the instant two panes run concurrently.
  // ownsLiveSession (not a bare id compare) is what makes that hold on a FIRST send,
  // when this pane has no session id to compare against yet.
  useEffect(
    () =>
      window.api.mighty.onPhase((p) => {
        if (!ownsLiveSession(p.sessionId, p.clientRunId)) return
        bindFromLivePush(p.sessionId, p.clientRunId)
        setPhase(p.phase)
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  // Same cross-talk guard for the rich per-line transcript.
  useEffect(
    () =>
      window.api.mighty.onEvent(({ sessionId: evSessionId, clientRunId, event }) => {
        if (!ownsLiveSession(evSessionId, clientRunId)) return
        bindFromLivePush(evSessionId, clientRunId)
        // Persisted on the turn (run-mighty.ts) — not a timeline step.
        if (event.kind === RUN_EVENT.usage) return
        setLiveTimeline((prev) => foldRunEvent(prev, event, () => liveSeq.current++))
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  // A turn on this pane's session started or finished elsewhere (e.g. the panel
  // asked into the same session). Already correctly filtered in ChatTab — copied
  // verbatim, this is the template the two subscriptions above now match.
  useEffect(
    () =>
      window.api.mighty.onTurnAppended(({ sessionId: appendedId }) => {
        if (sessionIdRef.current !== appendedId) return
        void (async () => {
          const fresh = await window.api.mighty.getSession(appendedId)
          setSession(fresh)
        })()
      }),
    []
  )

  useEffect(() => {
    // Only ever ADOPT a real id here, never clear one. send() optimistically renders
    // the pending turn on a session whose id is still '' (a fresh pane), and the
    // History "Continue" path builds a transient one the same way — writing that ''
    // back would blank the ref mid-run and hand send() the wrong target. The paths
    // that legitimately unbind a pane (rebind, Continue) null the ref themselves.
    if (session?.id) sessionIdRef.current = session.id
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [session, busy])

  // "Read answers aloud" — voice as a mode on this typed surface. Off by default;
  // a chat that starts talking on its own is a bug, not a feature.
  const spoken = useSpokenReplies()

  const send = useCallback(
    async (overrideText?: string, overrideAttachments?: MediaAttachment[]) => {
      const message = (overrideText ?? input).trim()
      const attachments = overrideAttachments ?? att.attachments
      if (message === '' && attachments.length === 0) return
      const toAgent = route === 'agent' && scopeFolder && onRouteToAgent && message !== ''
      const liveRunId = session?.runId ?? clientRunIdRef.current
      if (!toAgent && (busy || session?.runId !== undefined) && liveRunId) {
        steerRef.current = { text: message, attachments }
        setInput('')
        att.clear()
        void window.api.mighty.stopRun(liveRunId)
        return
      }
      if (busy) return
      if (route === 'agent' && scopeFolder && onRouteToAgent && message !== '') {
        setInput('')
        att.clear()
        onRouteToAgent(scopeFolder, message, attachments.map((a) => a.path))
        return
      }
      // sessionIdRef, not `session?.id`: `session` is the ASYNC-resolved copy, so
      // switching this pane to another chat and sending before the getSession await
      // lands wrote the turn into the chat you just navigated away from. The ref is
      // the one field every path keeps current — the resolve effect, and the History
      // "Continue" handler which nulls it for a transient (id: '') session so a
      // follow-up correctly starts a new chat instead of appending to the old one.
      const sentToId = sessionIdRef.current ?? undefined
      const parked = sentToId ? splitPendingDraft(session, false).draft : ''
      const replacesParked = parked !== '' && parked !== message
      const sendToken = {}
      inFlightRef.current = sendToken
      const clientRunId = crypto.randomUUID()
      clientRunIdRef.current = clientRunId
      paneLifecycleLog.send(paneId, 'start', sentToId ?? null)
      setInput('')
      att.clear()
      if (!sentToId) onDraftTitle?.(message)
      setBusy(true)
      setPhase('')
      setLiveTimeline([])
      setSession((prev) => {
        const now = new Date().toISOString()
        const base: MightySession = prev ?? {
          schema_version: 1,
          id: '',
          created: now,
          updated: now,
          title: message,
          turns: []
        }
        const kept = replacesParked ? base.turns.slice(0, -1) : base.turns
        return {
          ...base,
          title: kept.length === 0 ? message : base.title,
          turns: [...kept, { source: 'chat', q: message, a: '', ts: now, ok: true, backend: '' }]
        }
      })
      try {
        if (replacesParked && sentToId) await window.api.mighty.truncateLastTurn(sentToId)
        const res = await window.api.mighty.chat(
          message,
          sentToId,
          attachments.length > 0 ? attachments : undefined,
          // A bound session carries its own project; only a pane that hasn't created
          // one yet needs the pending value ("new chat" under a project header).
          session?.projectId ?? pendingProjectId,
          // Only for a pane with no session yet — its dropdown choice exists nowhere
          // else. An existing session already carries its own pin; sending the
          // rendered value too would let a stale render outrank what's on disk.
          sentToId ? undefined : (backend ?? undefined),
          clientRunId
        )
        // Bind the pane to its new session BEFORE the getSession await, not after: a
        // re-render during that window (adding a sibling pane is enough) re-runs this
        // pane with the still-null sessionId prop, and the resolve effect bails on
        // null — rendering an empty "New chat" over a live chat and orphaning
        // the session, which nothing then holds a pointer to.
        if (inFlightRef.current === sendToken && res.sessionId && sessionIdRef.current !== res.sessionId) {
          sessionIdRef.current = res.sessionId
          paneLifecycleLog.send(paneId, 'bound', res.sessionId)
          if (!sentToId) onSessionCreated(res.sessionId)
        }
        const fresh = await window.api.mighty.getSession(res.sessionId)
        if (inFlightRef.current === sendToken) {
          setSession(fresh)
          setLiveTimeline([])
          // Read the answer aloud when the toggle is on — a no-op otherwise, and
          // silent on a failed run (res.error), since hearing an error sentence
          // spoken in Mighty's voice reads as Mighty being confused, not broken.
          if (!res.error) spoken.speakIfEnabled(res.answer)
        }
      } finally {
        if (inFlightRef.current === sendToken) {
          paneLifecycleLog.send(paneId, 'done', sessionIdRef.current)
          // Retire the correlation id only for the send that still owns the pane; a
          // superseded run must not clear the newer one's id out from under it.
          clientRunIdRef.current = null
          onDraftTitle?.(null)
          setBusy(false)
          setPhase('')
        }
      }
    },
    [
      input,
      busy,
      session,
      sessionId,
      att,
      onSessionCreated,
      spoken,
      backend,
      paneId,
      pendingProjectId,
      onDraftTitle,
      route,
      scopeFolder,
      onRouteToAgent
    ]
  )

  const [regenerateFailed, setRegenerateFailed] = useState(false)
  const replaceLastTurn = useCallback(
    async (text: string) => {
      const sid = sessionIdRef.current
      if (!sid || busy) return
      setRegenerateFailed(false)
      const truncated = await window.api.mighty.truncateLastTurn(sid)
      if (!truncated) {
        setRegenerateFailed(true)
        return
      }
      setSession(truncated)
      await send(text)
    },
    [busy, send]
  )
  const regenerate = useCallback(() => {
    const last = session?.turns[session.turns.length - 1]
    if (last) void replaceLastTurn(last.q)
  }, [session, replaceLastTurn])
  const editAndResend = useCallback(
    (newText: string) => void replaceLastTurn(newText),
    [replaceLastTurn]
  )

  // Declared above the turn-split memo below, which reads it: a live run owns the
  // trailing empty turn (it's the pending bubble), so it must not be split off.
  const running = session?.runId !== undefined

  // A stored session can end in an unsent turn (a listen capture parks its transcript
  // that way). splitPendingDraft decides what's a message and what's still a draft —
  // one rule, shared with every other reader. See mighty/pending-draft.ts.
  const { turns, draft } = useMemo(
    () => splitPendingDraft(session, busy || running),
    [session, busy, running]
  )

  // Move this session's unsent turn into the composer, so Enter sends it. Keyed on
  // the session id (not the draft text) so it fires once per chat you open and never
  // re-appears after you clear it — and so SWITCHING chats re-seeds from the new one
  // rather than stranding the old session's draft in the box.
  useEffect(() => {
    if (draft) setInput(draft)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id])

  useEffect(() => {
    onTurnsChange?.(turns)
    // onTurnsChange is a fresh closure each render on the caller's side (it reads
    // the caller's own state) — depending on it would re-fire this effect every
    // render for no reason. Depending on `turns` alone is what we actually want:
    // notify when the DATA changes, not when the parent re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turns])
  const inFlight = busy || running
  useEffect(() => {
    const steer = steerRef.current
    if (inFlight || !steer) return
    steerRef.current = null
    void send(steer.text, steer.attachments)
  }, [inFlight, send])
  const steerable = inFlight && (input.trim() !== '' || att.attachments.length > 0)

  // Report this pane's live runId to the window-level Esc handler. Depends on the
  // id alone, not on onRunChange — that prop is a fresh closure every parent render.
  const runId = session?.runId ?? null
  const stoppableRunId = runId ?? (busy ? clientRunIdRef.current : null)
  useEffect(() => {
    onRunChange?.(paneId, stoppableRunId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId, stoppableRunId])
  // A pane that unmounts mid-run must not leave a stale runId in the parent's map,
  // or Esc would try to stop a run this window no longer shows.
  useEffect(
    () => () => onRunChange?.(paneId, null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [paneId]
  )
  const [elapsedMs, setElapsedMs] = useState(0)
  const runStartRef = useRef<number | null>(null)

  useEffect(() => {
    if (!inFlight) {
      runStartRef.current = null
      setElapsedMs(0)
      return
    }
    runStartRef.current ??= Date.now()
    setElapsedMs(Date.now() - runStartRef.current)
  }, [inFlight])

  useInterval(
    () => {
      if (runStartRef.current !== null) setElapsedMs(Date.now() - runStartRef.current)
    },
    inFlight ? CONFIG.MIGHTY.ELAPSED_TICK_MS : null
  )

  const runTimeoutMs = CONFIG.MIGHTY.RUN_TIMEOUT_MS.chat + CONFIG.MIGHTY.RUN_TIMEOUT_GRACE_MS
  useEffect(() => {
    if (!inFlight || elapsedMs < runTimeoutMs) return
    const stuckRun = session?.runId ?? clientRunIdRef.current
    if (stuckRun) void window.api.mighty.stopRun(stuckRun)
    if (!sessionIdRef.current && session?.id) sessionIdRef.current = session.id
    inFlightRef.current = null
    clientRunIdRef.current = null
    setBusy(false)
    setPhase('')
    setLiveTimeline([])
    const sid = sessionIdRef.current
    const timeoutAnswer = CONFIG.UI_LABELS.CHAT_RUN_TIMEOUT
    if (sid) {
      void window.api.mighty.getSession(sid).then((fresh) => {
        if (sessionIdRef.current !== sid || !fresh) return
        const turns = fresh.turns
        const last = turns[turns.length - 1]
        if (last && last.a === '') {
          setSession({
            ...fresh,
            runId: undefined,
            turns: [...turns.slice(0, -1), { ...last, a: timeoutAnswer, ok: false }]
          })
        } else {
          setSession({ ...fresh, runId: undefined })
        }
      })
      return
    }
    setSession((prev) => {
      if (!prev || prev.turns.length === 0) return prev
      const last = prev.turns[prev.turns.length - 1]
      if (last.a !== '') return prev
      return {
        ...prev,
        turns: [...prev.turns.slice(0, -1), { ...last, a: timeoutAnswer, ok: false }]
      }
    })
  }, [inFlight, elapsedMs, runTimeoutMs])

  const isHome = turns.length === 0 && !resolving

  const composer = (
    <div
      className={`mighty-composer px-5 ${isHome ? '' : 'py-3'}`}
      onDragOver={(e) => e.preventDefault()}
      onDrop={att.drop}
    >
      <Stack gap={2} className="chat-measure">
        <div className="agent-draft-card">
          {att.attachments.length > 0 && (
            <AttachBar attachments={att.attachments} onRemove={att.remove} />
          )}
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPaste={(e) => {
              if (att.paste(e.clipboardData)) e.preventDefault()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || !e.shiftKey)) {
                e.preventDefault()
                void send()
              }
            }}
            rows={isHome ? 3 : 2}
            placeholder={`Ask ${name} to do something…`}
            className={`agent-draft-input ${isHome ? 'text-base' : ''}`}
          />
          <div className="agent-draft-row">
            <AttachButton onClick={() => void att.pick()} />
            {(scopeProjectId || projects.some((p) => !p.archived)) && (
              <ProjectScopePicker
                projects={projects}
                valueId={scopeProjectId}
                onChange={(id) => void changeProject(id)}
                onNewProject={onNewProject}
                onEditProject={onEditProject}
              />
            )}
            {backend && <ChatModelPicker backend={backend} onChoose={chooseBackend} />}
            {onRouteToAgent && scopeFolder && input.trim() !== '' && (
              <Button
                variant="ghost"
                className="shrink-0 gap-1 px-2 text-xs"
                title={CONFIG.UI_LABELS.ROUTE_FLIP_HINT}
                onClick={() => setRouteOverride(route === 'agent' ? 'chat' : 'agent')}
              >
                {route === 'agent' ? <SquareTerminal size={12} /> : <MessageSquare size={12} />}
                {route === 'agent'
                  ? `${CONFIG.UI_LABELS.ROUTE_TO_AGENT} ${scopeName}`
                  : CONFIG.UI_LABELS.ROUTE_TO_CHAT}
              </Button>
            )}
            <span className="agent-draft-row-gap" />
            <TalkButton inputRef={inputRef} label={isHome} onLiveChange={setTalkLive} />
            {talkLive ? (
              <TalkSendButton className="agent-draft-send" />
            ) : inFlight && !steerable ? (
              <Button
                variant="bare"
                className="agent-draft-send"
                onClick={() => {
                  const id = runId ?? clientRunIdRef.current
                  if (id) void window.api.mighty.stopRun(id)
                }}
                aria-label={CONFIG.UI_LABELS.CHAT_STOP}
                title={CONFIG.UI_LABELS.CHAT_STOP}
              >
                <Square size={12} fill="currentColor" />
              </Button>
            ) : (
              <Button
                variant="bare"
                className="agent-draft-send"
                onClick={() => void send()}
                disabled={input.trim() === '' && att.attachments.length === 0}
                aria-label="Send message"
                title={steerable ? CONFIG.UI_LABELS.CHAT_STEER : undefined}
              >
                <ArrowUp size={16} strokeWidth={2.5} />
              </Button>
            )}
          </div>
        </div>
        {regenerateFailed && (
          <Row gap={1.5} className="text-xs text-muted">
            <span>{CONFIG.UI_LABELS.CHAT_REGENERATE_FAILED}</span>
            <Button variant="ghost" onClick={regenerate}>
              {CONFIG.UI_LABELS.CHAT_REGENERATE}
            </Button>
          </Row>
        )}
      </Stack>
    </div>
  )

  return (
    <div
      className="flex h-full flex-col min-w-0 min-h-0 bg-surface1"
      data-pane-id={paneId}
      data-empty={isHome ? '' : undefined}
    >
      <Row gap={1.5} className="px-5 py-2.5 border-b border-surface3 min-w-0">
        {titleDraft !== null && session ? (
          <input
            autoFocus
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onFocus={(e) => e.target.select()}
            onBlur={() => {
              const title = titleDraft.trim()
              setTitleDraft(null)
              if (title === '' || title === session.title) return
              setSession({ ...session, title })
              void window.api.mighty.setSessionTitle(session.id, title).then(() => onSessionsChanged?.())
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') {
                e.stopPropagation()
                setTitleDraft(null)
              }
            }}
            className="min-w-0 flex-1 bg-surface2 rounded px-1 -mx-1 text-sm font-medium text-on-surface outline-none focus:shadow-focus"
          />
        ) : (
          <span
            onDoubleClick={() => session && setTitleDraft(session.title)}
            title={session ? 'Double-click to rename' : undefined}
            className={`text-sm font-medium text-on-surface truncate inline-block w-fit max-w-full pb-0.5 ${titleUnderlineTone(slotColor)}`}
          >
            {resolving
              ? CONFIG.UI_LABELS.UNTITLED_CHAT
              : session?.title || CONFIG.UI_LABELS.UNTITLED_CHAT}
          </span>
        )}
        <span className="flex-1 min-w-0" aria-hidden />
        <Button
          variant="icon"
          type="button"
          onClick={() => (spoken.speaking ? spoken.stop() : spoken.setEnabled(!spoken.enabled))}
          title={
            spoken.speaking
              ? 'Stop reading'
              : spoken.enabled
                ? 'Answers are read aloud - click to turn off'
                : 'Read answers aloud'
          }
          aria-label="Read answers aloud"
          aria-pressed={spoken.enabled}
          className={`shrink-0 ${spoken.enabled ? 'text-accent-text' : ''} ${spoken.speaking ? 'animate-pulse' : ''}`}
        >
          {spoken.enabled ? <Volume2 size={15} /> : <VolumeX size={15} />}
        </Button>
        {exportDone && <span className="text-xs text-muted shrink-0">{CONFIG.UI_LABELS.CHAT_EXPORT_DONE}</span>}
        {turns.length > 0 && (
          <div className="relative shrink-0" ref={exportMenuRef}>
            <Button
              variant="icon"
              onClick={() => setExportMenuOpen((v) => !v)}
              aria-expanded={exportMenuOpen}
              title="Export this chat"
              aria-label="Export this chat"
            >
              <Download size={15} />
            </Button>
            {exportMenuOpen && (
              <div className="absolute right-0 top-full mt-1.5 w-48 rounded-lg border border-surface3 bg-surface1 shadow-lg py-1 z-10">
                <Button
                  variant="bare"
                  onClick={() => void exportChat('markdown')}
                  className="w-full flex items-center px-3 py-2 text-left text-sm text-on-surface hover:bg-surface2"
                >
                  {CONFIG.UI_LABELS.CHAT_EXPORT_MARKDOWN}
                </Button>
                <Button
                  variant="bare"
                  onClick={() => void exportChat('json')}
                  className="w-full flex items-center px-3 py-2 text-left text-sm text-on-surface hover:bg-surface2"
                >
                  {CONFIG.UI_LABELS.CHAT_EXPORT_JSON}
                </Button>
              </div>
            )}
          </div>
        )}
        {headerAddAction}
        {headerCloseAction}
      </Row>

      <div ref={scrollRef} className="mighty-conv-scroll flex-1 overflow-y-auto px-5 pb-4 pt-3 min-h-0">
        <div className="chat-measure min-h-full space-y-4">
          {turns.length === 0 && resolving && (
            <div className="h-full flex items-center justify-center text-sm text-muted">
              Loading…
            </div>
          )}
          {isHome && (
            <div className="mighty-chat-welcome flex flex-col items-center justify-center text-center gap-6">
              <div className="flex flex-col items-center gap-2 text-muted">
                {scopeProject ? (
                  <ProjectAvatar icon={scopeProject.icon} imagePath={scopeProject.imagePath} size={48} className="rounded-xl" />
                ) : (
                  <MessageSquare size={22} strokeWidth={1.5} />
                )}
                <p className="mighty-welcome-title font-semibold text-on-surface">
                  {CONFIG.UI_LABELS.CHAT_PANE_EMPTY_HEADLINE}
                </p>
                <p className="text-sm max-w-sm">{CONFIG.UI_LABELS.CHAT_PANE_EMPTY_BODY}</p>
              </div>
              <div className="w-full max-w-xl">{composer}</div>
              <div className="agent-draft-starters w-full max-w-xl">
                {QUICK_START_PROMPTS.map(({ icon: Icon, label, prompt }) => (
                  <Button
                    variant="bare"
                    key={label}
                    disabled={busy}
                    onClick={() => void send(prompt)}
                    className="agent-draft-starter disabled:opacity-50 disabled:pointer-events-none"
                  >
                    <Icon size={13} strokeWidth={1.75} />
                    {label}
                  </Button>
                ))}
                {emptyAction}
              </div>
            </div>
          )}
          {turns.map((t, i) => (
            <Message
              key={i}
              name={name}
              q={t.q}
              a={t.a}
              ts={t.ts}
              artifacts={t.artifacts}
              onEdit={i === turns.length - 1 && !inFlight ? editAndResend : undefined}
              onRegenerate={i === turns.length - 1 && !inFlight ? regenerate : undefined}
              pending={(busy || running) && i === turns.length - 1 && t.a === ''}
              phase={phase}
              liveTimeline={i === turns.length - 1 ? liveTimeline : EMPTY_TIMELINE}
              elapsedMs={i === turns.length - 1 ? elapsedMs : 0}
              renderMarkup={renderMarkup}
              detail={showResponseTime}
              showSteps={showSteps}
              backend={t.backend}
              model={t.model}
              durationMs={t.durationMs}
              firstPhaseMs={t.firstPhaseMs}
              usage={t.usage}
              // Matched on the answer TEXT, not on "the last turn": a reply that
              // arrives while the previous one is still being read would otherwise
              // steal the highlight and light up words nobody is saying.
              highlight={
                spoken.tokens.length > 0 && t.a === spoken.activeText
                  ? { tokens: spoken.tokens, index: spoken.wordIndex }
                  : undefined
              }
            />
          ))}
        </div>
      </div>

      {!isHome && composer}
    </div>
  )
}
