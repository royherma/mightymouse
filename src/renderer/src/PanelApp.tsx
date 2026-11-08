import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react'
import {
  AppMode,
  QuickAction,
  HistoryItem,
  PanelInitData,
  BackendHealthWarning,
  WelcomeVariant,
  MightySession,
  ActivationChecklist
} from '../../shared/types'
import { detectMode, stripModePrefix, isAppMode } from '../../shared/mode'
import { CONFIG } from '../../shared/config'
import { usageResetText } from '../../shared/billing-math'
import { AlertTriangle, Check, ChevronDown, EyeOff, Maximize2, Plus, QrCode, Settings, Square, SquareArrowOutUpRight, Terminal, X } from 'lucide-react'
import { Button } from './components/Button'
import SkillBodyEditor from './components/SkillBodyEditor'
import { UpdateNudge } from './components/UpdateNudge'
import { Tooltip, useTooltip } from './components/Tooltip'
import { ProgressBar } from './components/ProgressBar'
import { Markdown } from './components/Markdown'
import { AttachBar } from './components/AttachBar'
import { ModelPicker } from './components/ModelPicker'
import { HistoryList } from './components/HistoryList'
import { ContextIcon } from './components/AppIcon'
import { useAttachments } from './hooks/useAttachments'
import { usePhoneRemoteQr } from './hooks/usePhoneRemoteQr'
import { useAgentRelay } from './hooks/useAgentRelay'
// import { CodePanel } from './components/CodePanel'  // parked with the flyout
import { modeChipVars } from './mode-colors'
import { backendChipLabel, MIGHTYMOUSE_BACKEND } from './backend-chip'
import { visibleThreadTurns } from './thread-turns'
import { formatRunDuration } from './hud-timer'
import { getShortcut, comboGlyphs } from '../../shared/shortcuts'

const FOCUS_DELAY_MS = 50
const BADGE_CLEAR_MS = 1200

// The in-panel first-run hero is superseded by the standalone onboarding flow —
// two welcomes fired back to back. Kept behind a flag rather than deleted so the
// hero can come back if onboarding ever stops covering the hotkey teach.
const SHOW_WELCOME_HERO = false

const TOP_UP_PACK = CONFIG.BILLING.PACKS[0]

// Checklist ring: 2πr at r=8.5 in the button's 20x20 viewBox.
const CHECKLIST_RING_C = 2 * Math.PI * 8.5
// 2.2 of the circumference is eaten by the gap between segments — enough to read
// as separate ticks at 20px without the arcs shrinking to dots at 5 segments.
const CHECKLIST_SEG_LEN = (n: number): number => CHECKLIST_RING_C / n - 2.2
import { useInterval } from './hooks/useInterval'
import { useIpcSubscriptions } from './hooks/useIpcSubscriptions'

// Must match the .panel-container.minimizing transition in index.css — the hide
// fires on a timer, so a shorter value here would cut the shrink off mid-flight.
// PARKED with the minimize button below.
// const PANEL_MINIMIZE_MS = 180

function backendWarningHeadline(warning: BackendHealthWarning): string {
  const name = CONFIG.BACKEND_META[warning.backend]?.label ?? warning.backend
  const failed = warning.result.checks.find((c) => !c.ok)
  const reason = Object.values(CONFIG.BACKEND_CHECK).find((c) => c.label === failed?.label)?.reason
  return reason ? `${name} ${reason}.` : `${name} can't run right now.`
}

export default function PanelApp(): React.ReactElement {
  // Single floating hover tooltip for the whole panel (shared primitive).
  const { tip, hoverProps } = useTooltip()

  // Config state from IPC
  const [selection, setSelection] = useState('')
  const [placeholder, setPlaceholder] = useState(CONFIG.DEFAULT_PLACEHOLDER)
  const [lastInstr, setLastInstr] = useState('')
  const [modeOverride, setModeOverride] = useState<AppMode | null>(null)
  const [ctxOn, setCtxOn] = useState(false)
  const [ctxLabel, setCtxLabel] = useState('no context')
  // Unflattened context identity behind ctxLabel — drives the row's app icon +
  // favicon badge. Kept as separate state (not parsed back out of ctxLabel).
  const [ctxApp, setCtxApp] = useState('')
  const [ctxURL, setCtxURL] = useState('')
  const [actions, setActions] = useState<QuickAction[]>([])
  const [backend, setBackend] = useState('claude')
  // The selected Ollama model tag (e.g. "gemma3:4b"), so the local backend chip
  // can show WHICH model is answering instead of a generic "Local". Empty for
  // cloud backends. Kept in sync via init + reseed (buildPanelInitData).
  const [ollamaModel, setOllamaModel] = useState('')
  // The selected Rapid-MLX model alias, so the `mlx` backend chip shows WHICH model
  // is answering. Empty for other backends. Mirrors ollamaModel; synced the same way.
  const [mlxModel, setMlxModel] = useState('')
  // The per-conversation model pick for the paid `mightymouse` backend (an
  // OpenRouter slug from CONFIG.MODEL_CATALOG, or '' = server-routed default).
  // Seeded from init/reseed; the dropdown writes it through to PREFS via IPC.
  const [selectedModel, setSelectedModel] = useState('')

  // Input & UI state
  const [inputValue, setInputValue] = useState('')
  const att = useAttachments()
  const phoneRemoteQr = usePhoneRemoteQr()
  const [inputDisabled, setInputDisabled] = useState(false)
  const [inputError, setInputError] = useState(false)
  const [activeActionKey, setActiveActionKey] = useState<string | null>(null)

  // Busy UI
  const [busyActive, setBusyActive] = useState(false)
  const [busyRunning, setBusyRunning] = useState(false) // drives the elapsed timer
  const [busyPhase, setBusyPhase] = useState('Starting')
  const [busyDetail, setBusyDetail] = useState('warming up...')
  const [busyCtxVisible, setBusyCtxVisible] = useState(false)
  const [busySeconds, setBusySeconds] = useState(0)
  // Predicted run duration (ms) from the estimator, delivered on the busyPhase IPC.
  // 0 = no history to predict from → no bar, just the timer (mirrors the HUD card).
  const [busyEtaMs, setBusyEtaMs] = useState(0)

  // History flyout — the row data/filter/expand/feedback state now all live inside
  // <HistoryList>; the panel only tracks whether the flyout is open, so it can
  // toggle it and re-fit the auto-sized window when it opens/closes/grows.
  const [historyOpen, setHistoryOpen] = useState(false)
  const [modelMenuOpen, setModelMenuOpen] = useState(false)

  // Code flyout — the Mac's half of the agent relay. The button only exists
  // when the Settings toggle is on (see useAgentRelay).
  const relay = useAgentRelay()
  // const [codeOpen, setCodeOpen] = useState(false)  // parked with the flyout below

  // Incognito mode: drives the header "not logging" badge. Seeded from init data,
  // kept live via the incognitoChanged broadcast (tray/Settings flip it).
  const [incognito, setIncognito] = useState(false)

  // Chat conversation — the panel is just another view of a MightySession. No local
  // conversation state to keep in sync: session IS the source of truth, refetched via
  // mighty.getSession() whenever a turn lands (onShowAnswer, onTurnAppended).
  const [session, setSession] = useState<MightySession | null>(null)

  // Two callers with different intent: the chat row's button resumes THIS
  // conversation; the titlebar's opens Mighty itself, always on a new chat.
  const expandToMighty = useCallback(async (resumeSession = true) => {
    const boundId = resumeSession ? sessionIdRef.current : null
    void window.api.mighty.open(boundId === null, boundId ?? undefined)
  }, [])
  const [answerVisible, setAnswerVisible] = useState(false)
  // Thread index of the message whose hover-copy button was just clicked (shows ✓).
  const [copiedMsg, setCopiedMsg] = useState<number | null>(null)
  // Which bubble is being read aloud (synthesizing or playing), by thread index.
  const [speakingMsg, setSpeakingMsg] = useState<number | null>(null)
  // True while a chat turn is in flight: the question is already in the thread and
  // we're waiting on its answer (drives the inline "thinking" bubble + q dedupe).
  const [chatPending, setChatPending] = useState(false)

  // Out-of-credits error state — distinct from generic errors (drives inline top-up prompt)
  const [outOfCredits, setOutOfCredits] = useState(false)
  const [usageResetLine, setUsageResetLine] = useState('')

  // Dismissible "backend CLI missing" banner, pushed once by the startup health
  // probe (runStartupBackendProbe in main). null = no warning / already dismissed.
  const [backendWarning, setBackendWarning] = useState<BackendHealthWarning | null>(null)

  // Post-auth welcome banner variant ('new' | 'returning'), seeded once from the
  // panel's init payload (see consumePendingWelcome in main). null = no banner.
  const [welcome, setWelcome] = useState<WelcomeVariant | null>(null)

  // "Finish setup" activation checklist — every row but backendConnected comes
  // straight from main (see buildActivationChecklist); backendConnected is
  // merged in below from the probe this component already runs on mount.
  const [checklist, setChecklist] = useState<ActivationChecklist | null>(null)
  // null until panelProbeBackend() resolves. A plain `false` start would mean
  // "backend not connected" for the probe's whole duration, so the ring would
  // paint a row it hasn't checked and then vanish once the probe came back true.
  const [backendConnected, setBackendConnected] = useState<boolean | null>(null)
  // Closed by default: the checklist is opened from the header ring, never on its own.
  const [checklistOpen, setChecklistOpen] = useState(false)
  const [showTiming, setShowTiming] = useState(true)

  // Act result rendered inline (act stays in the panel like ask, but its result is
  // a summary + a reveal path, not a chat answer — so it's a one-shot block with a
  // Reveal button, no follow-up composer). null = no act result showing.
  const [actResult, setActResult] = useState<{
    summary: string
    revealPath: string | null
    revealIsDir?: boolean
    ok: boolean
  } | null>(null)

  // Toast
  const [toastMessage, setToastMessage] = useState('')
  const [toastVisible, setToastVisible] = useState(false)

  const inputRef = useRef<HTMLElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Minimize: shrink the whole panel toward the Dock, THEN hide the window. The
  // panel is skipTaskbar so macOS gives it no genie of its own (see
  // getMinimizeOrigin) — without this it just blinks out of existence.
  // The class is stripped after the hide so the next open paints at full size:
  // showPanelWindow reuses the same window and never remounts this component.
  // PARKED with its header button — restore both together, plus the Minus import.
  // const minimize = useCallback(async () => {
  //   const el = containerRef.current
  //   if (!el) {
  //     window.api.panelHide()
  //     return
  //   }
  //   const origin = await window.api.panelMinimizeOrigin()
  //   el.style.transformOrigin = `${origin.x}% ${origin.y}%`
  //   el.classList.add('minimizing')
  //   // Timer, not transitionend: a hidden/backgrounded window can drop the event
  //   // and the panel would then never hide at all.
  //   window.setTimeout(() => {
  //     window.api.panelHide()
  //     el.classList.remove('minimizing')
  //     el.style.transformOrigin = ''
  //   }, PANEL_MINIMIZE_MS)
  // }, [])
  // Explicit composer height from the drag handle under the input. null = auto
  // (the flex behavior above); a number pins .input-wrap so a long instruction
  // can be read in full without the flyout stealing the space.
  const [composerH, setComposerH] = useState<number | null>(null)
  const inputWrapRef = useRef<HTMLDivElement>(null)
  // The currently playing read-aloud element, so a new press can stop the old one.
  const speakAudioRef = useRef<HTMLAudioElement | null>(null)
  // Monotonic token: a synthesis result is stale if another press superseded it
  // mid-flight (Kokoro takes seconds, so this window is wide, not theoretical).
  const speakTokenRef = useRef(0)
  // The filter popup itself — measured so the window grows tall enough to show it unclipped
  // when only a few history rows make the flyout short.
  const filterPopRef = useRef<HTMLDivElement>(null)
  // The model-picker's open menu — same deal as filterPopRef: it's position:absolute
  // (out of flow) so it never adds to the container's measured height on its own.
  const modelMenuRef = useRef<HTMLDivElement>(null)
  const threadEndRef = useRef<HTMLDivElement>(null)
  const toastTimeout = useRef<NodeJS.Timeout | null>(null)
  // IPC subscriptions register once (deps: []), so read live chat state via a ref.
  const chatPendingRef = useRef(false)
  // Run id of the ask currently in flight, learned from the busyPhase/showAnswer
  // payloads (submit is fire-and-forget, so it isn't known at send time). Cleared on
  // a new submit (the next run's id arrives with its first phase) and on Stop.
  const inFlightRunIdRef = useRef<string | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  // Text of the question for the run currently in flight. On Stop we restore it into
  // the composer so the user can edit + resend, instead of losing what they typed.
  const lastSentRef = useRef('')
  const stoppingRunIdRef = useRef<string | null>(null)
  // The auto-fit ResizeObserver registers once (deps: []); it reads chat state via
  // this ref so it can switch behavior (grow-to-content vs cap-and-scroll) without
  // re-subscribing. Mirrors `answerVisible`.
  const answerVisibleRef = useRef(false)
  // Last height (px) reported to main via window.api.resize. Dedupes the auto-fit:
  // a width-only drag re-fires the ResizeObserver but doesn't change content height,
  // so we skip the redundant setBounds that would otherwise jitter the frame.
  const lastReportedH = useRef(0)
  // Mirrors lastReportedH for the chat flag — see measureAndReport's dedupe.
  const lastReportedChat = useRef(false)

  const openHistoryFlyout = () => {
    setHistoryOpen(true)
  }

  const applyInitData = (data: PanelInitData) => {
    setSelection(data.selection)
    setPlaceholder(data.placeholder)
    setLastInstr(data.lastInstr)
    setModeOverride(data.lastMode)
    setCtxOn(data.ctxOn)
    setCtxLabel(data.ctxLabel)
    setCtxApp(data.ctxApp)
    setCtxURL(data.ctxURL)
    setActions(data.actions)
    setBackend(data.backend)
    setOllamaModel(data.ollamaModel)
    setMlxModel(data.mlxModel)
    setSelectedModel(data.selectedModel)
    setIncognito(data.incognito)
    // Restore an unsubmitted draft from a prior session (see PREFS.setDraftInput)
    // so typed-but-not-sent text survives a Panel remount, not just a submit.
    if (data.draftInput) {
      setInputValue(data.draftInput)
      if (data.activeActionKey) {
        setActiveActionKey(data.activeActionKey)
        const restoredAction = data.actions.find((a) => a.key === data.activeActionKey)
        if (restoredAction) setModeOverride(restoredAction.mode)
      }
    }
    // Opened from the tray History item: main flagged the view via the payload, so
    // we open the flyout here, after mount/reseed — no event to miss, no timer.
    if (data.openTo === 'history') {
      openHistoryFlyout()
    } else if (typeof data.openTo === 'object' && data.openTo?.type === 'run') {
      // Selection-bar one-tap action: the user already chose what to do, so seed
      // the instruction and let the pendingRunRef effect submit it once the state
      // lands. Rewrite mode explicitly — a bar action is always a rewrite of the
      // selection, never routed by a `?`/`!` prefix the user never typed.
      setModeOverride('rewrite')
      setInputValue(data.openTo.instruction)
      pendingRunRef.current = true
    } else if (typeof data.openTo === 'object' && data.openTo?.type === 'conversation') {
      // A HUD card handoff (e.g. a clicked smart-dictation result): resume that
      // conversation into the live chat instead of the plain focus-the-input default.
      // Fire-and-forget — same as History's Continue button, nothing here awaits it.
      void resumeConversationById(data.openTo.runId).then((resumed) => {
        if (!resumed && inputRef.current) inputRef.current.focus()
      })
    } else if (inputRef.current) {
      inputRef.current.focus()
    }
    if (data.welcome) setWelcome(data.welcome)
    setChecklist(data.checklist)
  }

  // Measure the panel's intrinsic content height and report it to main so the
  // BrowserWindow auto-fits. Ref-stable (only reads refs + the DOM) so the
  // once-registered ResizeObserver and the historyOpen effect can both call it.
  const measureAndReport = () => {
    const el = containerRef.current
    if (!el) return
    const thread = el.querySelector<HTMLElement>('.thread')
    const savedScroll = thread?.scrollTop ?? 0
    el.classList.add('measuring')
    let contentH = el.offsetHeight
    el.classList.remove('measuring')
    if (thread) thread.scrollTop = savedScroll
    const pop = filterPopRef.current
    if (pop) {
      const popBottom = pop.getBoundingClientRect().bottom - el.getBoundingClientRect().top
      contentH = Math.max(contentH, Math.ceil(popBottom) + 8)
    }
    const modelMenu = modelMenuRef.current
    if (modelMenu) {
      const menuBottom = modelMenu.getBoundingClientRect().bottom - el.getBoundingClientRect().top
      contentH = Math.max(contentH, Math.ceil(menuBottom) + 8)
    }
    const inChat = answerVisibleRef.current
    const reqH = inChat ? Math.min(contentH, CONFIG.PANEL_MAX_H) : contentH
    if (reqH === lastReportedH.current && inChat === lastReportedChat.current) return
    lastReportedH.current = reqH
    lastReportedChat.current = inChat
    window.api.resize(reqH, inChat)
  }

  // Drag the composer's bottom edge to set an explicit height. Pointer capture (not
  // document listeners) so the drag survives the cursor leaving the 8px strip, and
  // measureAndReport runs per move so the window grows with the box in real time.
  const startComposerDrag = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    const handle = e.currentTarget
    const startY = e.clientY
    const startH = inputWrapRef.current?.offsetHeight ?? CONFIG.PANEL_COMPOSER_MIN_H
    handle.setPointerCapture(e.pointerId)
    const onMove = (ev: PointerEvent): void => {
      const next = Math.max(CONFIG.PANEL_COMPOSER_MIN_H, startH + (ev.clientY - startY))
      setComposerH(next)
      requestAnimationFrame(measureAndReport)
    }
    const onUp = (ev: PointerEvent): void => {
      handle.releasePointerCapture(ev.pointerId)
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onUp)
    }
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onUp)
  }

  // Persist the draft (debounced) so unsubmitted text survives a Panel remount —
  // see PREFS.setDraftInput. Submit/Stop/New already clear it main-side; skipped
  // on the very first render so mount-time seeding never echoes back as a write.
  const draftMounted = useRef(false)
  useEffect(() => {
    if (!draftMounted.current) {
      draftMounted.current = true
      return
    }
    const t = setTimeout(() => window.api.draftInput(inputValue), 400)
    return () => clearTimeout(t)
  }, [inputValue])

  // Initial load
  useEffect(() => {
    void window.api.settingsGetPrefs().then((p) => setShowTiming(p.showTiming))

    window.api.getInitialData().then((data) => {
      applyInitData(data)
      requestAnimationFrame(measureAndReport)
    })

    window.api
      .panelProbeBackend()
      .then((warning) => {
        if (!warning) return
        setBackendWarning(warning.result.ok ? null : warning)
        setBackendConnected(warning.result.ok)
      })
      .catch(() => {})

    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(measureAndReport)
    })

    if (containerRef.current) resizeObserver.observe(containerRef.current)

    return () => {
      resizeObserver.disconnect()
      if (toastTimeout.current) clearTimeout(toastTimeout.current)
    }
  }, [])

  useEffect(() => {
    requestAnimationFrame(measureAndReport)
  }, [historyOpen, modelMenuOpen])

  useIpcSubscriptions(() => [
    window.api.onBusyPhase((payload) => {
      setBusyPhase(payload.phase)
      setBusyDetail(payload.detail)
      // Adopt the run's ETA the first time main reports it (constant per run).
      if (payload.etaMs && payload.etaMs > 0) setBusyEtaMs(payload.etaMs)
      // Learn the in-flight run's id + the Mighty session it's already bound to.
      if (payload.runId) inFlightRunIdRef.current = payload.runId
      if (payload.sessionId) sessionIdRef.current = payload.sessionId
    }),
    window.api.onShowAnswer((payload) => {
      if (payload.runId && payload.runId !== inFlightRunIdRef.current) return
      stopBusyTimer()
      setBusyActive(false)
      setInputDisabled(false)
      setChatPending(false)
      chatPendingRef.current = false
      // Turn resolved — its run is done, so there's nothing live to hand off anymore.
      inFlightRunIdRef.current = null
      // A run that resolved without ever emitting a bound busyPhase leaves this null,
      // and expand would then open a blank chat instead of this conversation.
      if (payload.sessionId) sessionIdRef.current = payload.sessionId
      // Main already appended this turn to the bound session server-side before
      // sending showAnswer, so a refetch here is guaranteed to see it — no race.
      if (sessionIdRef.current) {
        void window.api.mighty.getSession(sessionIdRef.current).then(setSession)
      }
      setAnswerVisible(true)
      setInputValue('')
      setModeOverride('ask') // stays in conversational ask mode for follow-ups

      setTimeout(() => {
        if (inputRef.current) {
          inputRef.current.focus()
        }
      }, FOCUS_DELAY_MS)
    }),
    window.api.onShowActResult((payload) => {
      // Act finished while the panel was open: drop the busy overlay and show the
      // summary + Reveal inline. One-shot — no thread, no follow-up composer.
      stopBusyTimer()
      setBusyActive(false)
      setInputDisabled(false)
      setActResult(payload)
      setAnswerVisible(true)
    }),
    window.api.onShowError((payload) => {
      // A user-initiated Stop kills the CLI, which lands here as a failure. That's
      // not an error to show — handleStop already cleaned up + restored the composer.
      if (payload.runId && payload.runId === stoppingRunIdRef.current) {
        stoppingRunIdRef.current = null
        return
      }
      if (payload.runId && payload.runId !== inFlightRunIdRef.current) return
      stopBusyTimer()
      setBusyActive(false)
      setInputDisabled(false)
      setChatPending(false)
      chatPendingRef.current = false
      inFlightRunIdRef.current = null

      if (payload.msg === 'out_of_credits') {
        // Distinct UI: inline top-up prompt instead of a generic error bubble.
        // The panel stays open so the user can switch to a BYO backend via the chip.
        setOutOfCredits(true)
        setAnswerVisible(true)
        void window.api.billingGetUsage().then((u) => setUsageResetLine(u ? usageResetText(u.resetsAt) : ''))
      } else {
        setOutOfCredits(false)
        // Main already appended the "Error: ..." turn to the bound session before
        // sending showError, so a refetch renders it as the thread's last bubble.
        if (sessionIdRef.current) {
          void window.api.mighty.getSession(sessionIdRef.current).then(setSession)
        }
        setAnswerVisible(true)
      }

      setTimeout(() => {
        if (inputRef.current) inputRef.current.focus()
      }, FOCUS_DELAY_MS)
    }),
    window.api.onPanelReseed((data) => {
      setCtxOn(data.ctxOn)
      setCtxLabel(data.ctxLabel)
      setCtxApp(data.ctxApp)
      setCtxURL(data.ctxURL)
      setSelection(data.selection)
      setActions(data.actions)
      setChecklist(data.checklist)
      // Tray History fired while the panel was already open — main pushes a reseed
      // carrying the intent (an already-mounted panel won't re-run getInitialData).
      if (data.openTo === 'history') openHistoryFlyout()
    }),
    window.api.onIncognitoChanged((on) => setIncognito(on)),
    window.api.onBackendHealthWarning((payload) => setBackendWarning(payload)),
    // Model switched from any surface (Settings, or a resumed session) — keep
    // the live model chip in sync without waiting for a remount.
    window.api.onBackendChanged((next) => setBackend(next)),
    // The shortcuts editor lives in its own window; when it saves, main broadcasts
    // the fresh list so our pill row stays in sync.
    window.api.onActionsChanged((updated) => setActions(updated)),
    // A turn landed in a Mighty session while Mighty itself (not this panel) was the
    // one running it — e.g. Mighty finished a job. Only refetch if it's OUR bound
    // session; every other session id is none of the panel's business.
    window.api.mighty.onTurnAppended(({ sessionId }) => {
      if (sessionIdRef.current !== sessionId) return
      void window.api.mighty.getSession(sessionId).then(setSession)
    }),
    window.api.onResourcesAskDraft((text) => {
      setActiveActionKey(null)
      setModeOverride('ask')
      window.api.modeOverride('ask')
      setInputValue(text)
      setTimeout(() => inputRef.current?.focus(), 50)
    })
  ])

  // Mirror answerVisible into a ref the once-registered ResizeObserver can read.
  useEffect(() => {
    answerVisibleRef.current = answerVisible
  }, [answerVisible])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // Escalate like Mighty does: close what's open first, panel last.
      if (historyOpen) {
        setHistoryOpen(false)
        if (inputRef.current) inputRef.current.focus()
        return
      }
      window.api.cancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [historyOpen])

  // Welcome-back is a quiet pulse on the header mascot, not a persistent notice —
  // clear it once the pulse animation (1.8s x 3) has finished. Welcome-new stays up
  // until dismissed (first-run context is worth more screen time than a glow).
  useEffect(() => {
    if (welcome !== 'returning') return
    const t = setTimeout(() => setWelcome(null), 5500)
    return () => clearTimeout(t)
  }, [welcome])

  // Follow the thread down as it grows.
  //
  useEffect(() => {
    let raf2 = 0
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        threadEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
      })
    })
    return () => {
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
    }
  }, [session, chatPending])

  // Drop the store's copy of the turn the pending bubble is already showing, or the
  // question renders twice while a run is in flight (see visibleThreadTurns).
  const threadTurns = useMemo(
    () => visibleThreadTurns(session?.turns ?? [], chatPending),
    [session, chatPending]
  )

  const showToast = (msg: string) => {
    setToastMessage(msg)
    setToastVisible(true)
    if (toastTimeout.current) clearTimeout(toastTimeout.current)
    toastTimeout.current = setTimeout(() => {
      setToastVisible(false)
    }, 1400)
  }

  // Busy timer: ticks the elapsed seconds while a run is in flight.
  useInterval(() => setBusySeconds((prev) => prev + 0.1), busyRunning ? 100 : null)

  const startBusyTimer = () => {
    setBusySeconds(0)
    // Clear any prior run's ETA — the new run's lands on its first busyPhase. Until
    // then the overlay shows just the timer (no stale bar from the last run).
    setBusyEtaMs(0)
    setBusyRunning(true)
  }

  // ETA bar fill for the busy overlay: elapsed / eta, capped so it holds near the
  // end with a shimmer instead of reading "done" early. 0 eta → no bar (see render).
  const busyEtaPct =
    busyEtaMs > 0
      ? Math.min(CONFIG.ESTIMATOR.BAR_CAP_PCT, ((busySeconds * 1000) / busyEtaMs) * 100)
      : 0
  const busyOvertime = busyEtaMs > 0 && busyEtaPct >= CONFIG.ESTIMATOR.BAR_CAP_PCT

  const stopBusyTimer = () => setBusyRunning(false)

  const hasModePrefix = /^\s*[?!]/.test(inputValue)
  const effectiveMode = hasModePrefix ? detectMode(inputValue) : modeOverride || detectMode(inputValue)

  // Clicking the mode chip cycles rewrite → ask → act (same as Shift+Tab).
  const cycleMode = () => {
    const next: AppMode =
      effectiveMode === 'rewrite' ? 'ask' : effectiveMode === 'ask' ? 'act' : 'rewrite'
    setModeOverride(next)
    window.api.modeOverride(next)
    inputRef.current?.focus()
  }

  // Clicking the backend chip opens Settings, where the provider can be chosen
  // explicitly (with per-provider tips + a connection test). Cycling on click was
  // too easy to trigger by accident and gave no way to see the options.
  const openBackendSettings = () => window.api.openSettingsWindow()

  // Persist the model pick and reflect the STORED value (main validates against the
  // catalog, so an unknown id comes back as '' = Auto). Optimistic set first so the
  // dropdown feels instant, then reconcile with what actually persisted.
  const handleModelChange = (model: string): void => {
    setSelectedModel(model)
    void window.api.panelSetSelectedModel(model).then((stored) => {
      if (stored !== model) setSelectedModel(stored)
    })
  }

  // Human-readable label + hover tip for the backend chip (SSOT: CONFIG.BACKEND_META)
  const backendMeta = CONFIG.BACKEND_META[backend]
  const backendLabel = backendChipLabel(backend, ollamaModel, mlxModel)
  const backendTip = backendMeta?.tip ?? ''

  // Mode-badge tip: the active mode's plain-words explainer + the cycle hint (SSOT).
  const modeTip = `${CONFIG.MODE_META[effectiveMode]?.tip ?? ''} · ${CONFIG.UI_LABELS.MODE_CYCLE_HINT}`

  const handleStop = () => {
    if (!chatPendingRef.current && !busyActive) return
    stoppingRunIdRef.current = inFlightRunIdRef.current
    window.api.stopRun()
    stopBusyTimer()
    setBusyActive(false)
    setInputDisabled(false)
    setChatPending(false)
    chatPendingRef.current = false
    inFlightRunIdRef.current = null
    // Put the text back so it's editable + resendable.
    if (lastSentRef.current) setInputValue(lastSentRef.current)
    setTimeout(() => {
      if (inputRef.current) inputRef.current.focus()
    }, FOCUS_DELAY_MS)
  }

  // Everything the Enter key does once the input holds the final text. Split out
  // of handleKeyDown so the selection bar's one-tap actions can run the exact
  // same path — same mode routing, same busy states — with no synthetic event.
  const submitCurrentInput = (): void => {
    // Strip the `?`/`!` mode-routing prefix before sending — it picks the mode
    // (via detectMode → effectiveMode) but must never reach the model as text.
    const trimmedVal = stripModePrefix(inputValue).trim()
    // Allow attachment-only sends (e.g. "describe this image" with just an image
    // dropped in). Only flash the error when there's neither text nor a file.
    if (!trimmedVal && att.attachments.length === 0) {
      setInputError(true)
      setTimeout(() => setInputError(false), 800)
      return
    }

    if (backendWarning) {
      setInputError(true)
      setTimeout(() => setInputError(false), 800)
      return
    }

    // Snapshot + clear attachments now so both submit branches send the same set
    // and the chips disappear the instant the run starts. undefined when empty so
    // the IPC payload stays clean.
    const sentAttachments = att.attachments.length > 0 ? att.attachments : undefined
    att.clear()

    if (effectiveMode === 'ask' || (answerVisible && effectiveMode !== 'act')) {
      // No optimistic push into `session` — the pending question renders straight
      // from lastSentRef + chatPending (see the thread JSX below) until the real
      // turn lands via onShowAnswer's refetch.
      setChatPending(true)
      chatPendingRef.current = true
      // Clear the previous run's id — the new run's lands on its first busyPhase.
      inFlightRunIdRef.current = null
      // Expand into the chat thread NOW (not when the answer lands) so the
      // question bubble + inline "thinking" dots show the instant you hit Enter.
      // Without this, the first ask sits on a dead main panel until onShowAnswer.
      setAnswerVisible(true)
      // Seed the thinking-bubble label so it reads "thinking" / "reading your
      // screen", not the stale default. onBusyPhase will refine it as main works.
      setBusyPhase(ctxOn ? 'Reading your screen' : 'Thinking')
      setInputDisabled(true)
      setInputValue('')
      startBusyTimer()
      lastSentRef.current = trimmedVal
      // Reuse the bound Mighty session for a follow-up, so main appends to the
      // SAME conversation instead of minting a new one (undefined = first turn).
      window.api.submit(trimmedVal, 'ask', ctxOn, '', sentAttachments, sessionIdRef.current ?? undefined)
      return
    }

    // First run from the main panel: full-screen busy overlay.
    setBusyActive(true)
    startBusyTimer()
    setBusyCtxVisible(ctxOn)

    if (ctxOn) {
      setBusyPhase('Capturing screen')
      setBusyDetail('taking screenshot + reading window context')
    } else {
      setBusyPhase('Thinking')
      setBusyDetail('reading your text')
    }

    setInputDisabled(true)
    lastSentRef.current = trimmedVal
    window.api.submit(trimmedVal, effectiveMode, ctxOn, '', sentAttachments)
  }

  // A selection-bar action seeds the input, then submits on the NEXT render —
  // effectiveMode/stripModePrefix both read `inputValue` state, so submitting in
  // the same tick would run against the stale previous value.
  const pendingRunRef = useRef(false)
  useEffect(() => {
    if (!pendingRunRef.current) return
    pendingRunRef.current = false
    submitCurrentInput()
  }, [inputValue])

  // Key Event handlers
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    // Shift+Tab flips mode regardless of input content, so you can cycle modes
    // before typing anything. Plain Tab (empty input) reuses the last instruction.
    if (e.key === 'Tab') {
      e.preventDefault()
      if (e.shiftKey) {
        cycleMode()
      } else if (inputValue === '' && lastInstr) {
        setInputValue(lastInstr)
      }
      return
    }

    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submitCurrentInput()
    }
    // Esc is handled by the document-level listener above, so it works whether or
    // not the composer has focus. Handling it here too would fire cancel() twice.
  }

  const handleActionSelect = (a: QuickAction) => {
    if (activeActionKey === a.key) {
      setActiveActionKey(null)
      window.api.actionClear()
    } else {
      setActiveActionKey(a.key)
      setInputValue(a.instruction)
      setModeOverride(a.mode)
      window.api.actionSelect(a.key)
      if (inputRef.current) {
        inputRef.current.focus()
      }
    }
  }

  const toggleCtx = () => {
    const nextOn = !ctxOn
    setCtxOn(nextOn)
    window.api.ctxToggle(nextOn)
    if (inputRef.current) {
      inputRef.current.focus()
    }
  }

  const handleOpenHistory = () => {
    if (historyOpen) {
      setHistoryOpen(false)
      if (inputRef.current) inputRef.current.focus()
    } else {
      openHistoryFlyout()
    }
  }

  // Reuse the instruction: refill the input so the user can run it again.
  const handleReuseHistoryItem = (item: HistoryItem) => {
    setInputValue(item.instruction)
    // A capture row (listen/recording/screenshot) isn't an LLM mode you can re-run
    // as-is; reusing its text drops into ask. LLM rows reuse their own mode.
    setModeOverride(isAppMode(item.mode) ? item.mode : 'ask')
    setHistoryOpen(false)
    // History (and any prior tall chat) grew the panel — snap it back to the
    // compact default so reuse lands in a clean, fit-to-content box.
    window.api.resetPanelHeight()
  }

  const resumeConversationById = async (runId: string, fallbackTitle = ''): Promise<boolean> => {
    const res = await window.api.resumeSession(runId)
    if (!res.ok || res.turns.length === 0) return false
    // Match the chip to the backend the conversation ran on (main switched the pref).
    setBackend(res.backend)
    setModeOverride(res.mode)
    const now = new Date().toISOString()
    setSession({
      schema_version: 1,
      id: '',
      created: now,
      updated: now,
      title: fallbackTitle || res.turns[0].q,
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
    setAnswerVisible(true)
    setInputValue('')
    setHistoryOpen(false)
    return true
  }

  const handleContinueHistoryItem = async (item: HistoryItem) => {
    const res = await window.api.resumeSession(item.run_id)
    if (res.ok && res.sessionId) {
      setHistoryOpen(false)
      void window.api.mighty.open(false, res.sessionId)
      return
    }
    const resumed = await resumeConversationById(item.run_id, item.instruction)
    if (!resumed) handleReuseHistoryItem(item)
  }

  // "Back / New": leave the chat, return to the main input, and start a fresh
  // conversation (new run id on the main side) so the next ask is its own thread.
  const handleBack = () => {
    window.api.resetSession()
    setSession(null)
    setAnswerVisible(false)
    setOutOfCredits(false)
    setActResult(null)
    setChatPending(false)
    chatPendingRef.current = false
    // Fresh conversation → forget the bound session so the next ask starts a new one.
    sessionIdRef.current = null
    inFlightRunIdRef.current = null
    setInputDisabled(false)
    setInputValue('')
    setModeOverride(null)
    stopBusyTimer()
    setTimeout(() => inputRef.current?.focus(), FOCUS_DELAY_MS)
  }

  // Copy a single message's text. Keyed by thread index so only the hovered
  // bubble shows its "copied" tick.
  const copyMessage = (idx: number, text: string) => {
    if (!text) return
    window.api.copy(text)
    setCopiedMsg(idx)
    showToast('copied')
    setTimeout(() => setCopiedMsg((cur) => (cur === idx ? null : cur)), BADGE_CLEAR_MS)
  }

  // Read one message aloud. Synthesis happens in main (the TTS ladder), playback
  // here — main has no audio device. Keyed by thread index like copyMessage so
  // only the pressed bubble shows a spinner, and a second press stops it.
  const speakMessage = async (idx: number, text: string): Promise<void> => {
    if (!text) return
    // Second press on the same bubble = stop, so a long answer isn't a hostage.
    if (speakingMsg === idx) {
      speakTokenRef.current++ // invalidate an in-flight synthesis for this bubble
      speakAudioRef.current?.pause()
      speakAudioRef.current = null
      setSpeakingMsg(null)
      return
    }
    speakAudioRef.current?.pause()
    speakAudioRef.current = null
    const token = ++speakTokenRef.current
    setSpeakingMsg(idx)
    const { dataUrl } = await window.api.speakText(text)
    // Superseded mid-synthesis, or no voice produced audio — stay silent either way.
    if (token !== speakTokenRef.current) return
    if (!dataUrl) {
      setSpeakingMsg((cur) => (cur === idx ? null : cur))
      return
    }
    const audio = new Audio(dataUrl)
    speakAudioRef.current = audio
    audio.onended = () => setSpeakingMsg((cur) => (cur === idx ? null : cur))
    audio.onerror = () => setSpeakingMsg((cur) => (cur === idx ? null : cur))
    void audio.play()
  }

  const checklistRows = useMemo(() => {
    // Both halves required: main's payload AND the backend probe. Rendering on
    // half the data is what made the ring appear and then vanish a beat later.
    if (!checklist || backendConnected === null) return null
    return [
      { key: 'permissions', label: CONFIG.UI_LABELS.CHECKLIST_PERMISSIONS, done: checklist.permissionsGranted, onClick: () => void window.api.setup.open() },
      { key: 'backend', label: CONFIG.UI_LABELS.CHECKLIST_BACKEND, done: backendConnected, onClick: () => void window.api.setup.open() },
      { key: 'first_run', label: CONFIG.UI_LABELS.CHECKLIST_FIRST_RUN, done: checklist.firstRunDone, onClick: () => inputRef.current?.focus() },
      {
        key: 'transcribe',
        label: CONFIG.UI_LABELS.CHECKLIST_TRANSCRIBE,
        done: checklist.transcribeDone,
        // No renderer-side call can fire it (listen is a global hotkey, not IPC) —
        // the actionable step here is showing the keys, not a click handler.
        hint: comboGlyphs(getShortcut('listen')).join(' ')
      },
      { key: 'phone', label: CONFIG.UI_LABELS.CHECKLIST_PHONE, done: checklist.phonePaired, onClick: () => window.api.openPhoneRemoteQrWindow() }
    ]
  }, [checklist, backendConnected])

  const checklistRemaining = checklistRows?.filter((r) => !r.done).length ?? 0
  const checklistAllDone = checklistRows !== null && checklistRemaining === 0
  // A 5/5 list still opens — that's the one view where the user sees every row
  // ticked. Only the ring retires, and only after this open (see onClick below).
  const showChecklist = checklistRows !== null && checklistOpen
  // Retired for good only once a completed list has actually been opened, so
  // finishing the last step while the panel is shut can't hide the ring unseen.
  const showChecklistRing =
    checklistRows !== null && !(checklistAllDone && checklist?.seenDone)

  return (
    <div
      className={`panel-container ${answerVisible ? 'in-chat' : ''} ${historyOpen ? 'history-open' : ''}`}
      ref={containerRef}
    >
      <Tooltip tip={tip} />
      {/* Auto-update nudge — surfaces "downloading" / "ready to restart" here in the
          main panel, not just buried in Settings. The tray row is its always-visible twin. */}
      <UpdateNudge />
      {/* Frameless Drag Handle — only the grip + close live in the drag strip */}
      <div className="panel-header" id="dragHandle">
        <Button
          variant="icon"
          className="close-btn"
          onClick={() => window.api.cancel()}
          title="Close - the answer shows on a small card"
          type="button"
        >
          <X size={16} strokeWidth={2.25} />
        </Button>
        {/* Minimize — PARKED 2026-08-19, not sure it earns header space yet. Hides
            the window but keeps the conversation and any in-flight run pointed here,
            unlike Close which detaches the run to a HUD card and drops the trigger.
            Everything behind it still ships (minimize(), panelMinimizeOrigin, the
            .minimizing CSS) — uncomment this block to bring it back.
        <Button variant="icon" className="minimize-btn"
          onClick={() => void minimize()}
          title={`Minimize (${comboGlyphs(getShortcut('main')).join('')} to bring back)`}
          type="button"
        >
          <Minus size={16} strokeWidth={3} />
        </Button>
        */}
        {incognito && (
          <span className="incognito-pill" title="Incognito mode is on. Nothing this session is being logged.">
            <EyeOff size={11} strokeWidth={2.5} /> Incognito
          </span>
        )}
        <span className="panel-title">
          <span className="panel-title-glyph">
            {welcome === 'returning' && <span className="panel-title-glow" />}
            {CONFIG.BRAND_ICON}
          </span>{' '}
          {CONFIG.BRAND_NAME}
        </span>
        {/* Activation progress. The ONLY entry point to the checklist — the block
            never auto-opens, so without this button it is unreachable. Vanishes
            once every step is done: nothing left to track. */}
        {showChecklistRing && checklistRows && (
          <Button
            variant="icon"
            className={`checklist-btn ${checklistOpen ? 'open' : ''} ${checklistAllDone ? 'complete' : ''}`}
            onClick={() => {
              // Opening a 5/5 list IS the acknowledgement — latch it here so the
              // ring is gone next time. Closing again must not count, or a
              // toggle-shut would retire it in the same breath.
              if (!checklistOpen && checklistAllDone) window.api.panelChecklistSeenDone()
              setChecklistOpen((v) => !v)
            }}
            title={CONFIG.UI_LABELS.CHECKLIST_TITLE}
            type="button"
          >
            {/* One arc per step, not a continuous sweep: five discrete segments
                read as "3 of 5 done" at 20px, where a partial sweep reads as
                nothing. Rotated -90deg in CSS so segment 1 starts at 12 o'clock. */}
            <svg className="checklist-ring" viewBox="0 0 20 20" aria-hidden="true">
              {checklistRows.map((row, i) => (
                <circle
                  key={row.key}
                  className={`checklist-ring-seg ${row.done ? 'done' : ''}`}
                  cx="10"
                  cy="10"
                  r="8.5"
                  strokeDasharray={`${CHECKLIST_SEG_LEN(checklistRows.length)} ${CHECKLIST_RING_C}`}
                  strokeDashoffset={-(CHECKLIST_RING_C / checklistRows.length) * i}
                />
              ))}
            </svg>
            <Check className="checklist-btn-check" size={10} strokeWidth={3} />
          </Button>
        )}
        <Button
          variant="icon"
          className="header-expand-btn"
          {...hoverProps(CONFIG.UI_LABELS.MIGHTY_OPEN_TOOLTIP)}
          // Always a fresh chat — the chat row's twin is the one that resumes.
          onClick={() => void expandToMighty(false)}
          type="button"
        >
          <Maximize2 size={15} strokeWidth={2.25} />
        </Button>
        {/* Code — the Mac's half of the agent relay, the same cards the phone's
            Code sheet answers. Only exists while the relay is switched on in
            Settings: it is opt-in, and with it off there is nothing to show.
            Opens the Mighty window's Code tab rather than a flyout here — a
            card can carry a diff or a screenshot, which the panel is too narrow
            to read. */}
        {relay.enabled && (
          <Button
            variant="icon"
            className="code-btn"
            onClick={() => void window.api.mighty.openCode()}
            title={`Code${relay.pending.length > 0 ? ` — ${relay.pending.length} waiting` : ''}`}
            type="button"
          >
            <Terminal size={15} strokeWidth={2.25} />
            {relay.pending.length > 0 && <span className="code-btn-dot" />}
          </Button>
        )}
        <Button
          variant="icon"
          className="qr-btn"
          onClick={() => window.api.openPhoneRemoteQrWindow()}
          title="Phone Remote - scan to pair"
          type="button"
        >
          <QrCode size={16} strokeWidth={2.25} />
          {/* Hover reveals the real code at a scannable size — 22px of QR is
              a texture, not something a camera can read. */}
          {phoneRemoteQr && (
            <span className="qr-btn-pop">
              <img src={phoneRemoteQr} alt="Scan with your phone's camera to pair" />
            </span>
          )}
        </Button>
        <Button
          variant="icon"
          className="settings-btn"
          onClick={() => window.api.openSettingsWindow()}
          title={CONFIG.UI_LABELS.SETTINGS}
          type="button"
        >
          <Settings size={16} strokeWidth={2.25} />
        </Button>
      </div>

      {/* Toast Notification */}
      <div className={`toast ${toastVisible ? 'visible' : ''}`}>{toastMessage}</div>

      {/* Backend health warning — from the panel-open pre-flight probe, the startup
          probe, or a backend switch. While it's up, submit is GATED (see handleKeyDown):
          the probe says this backend can't run, so spending the user's question on a
          known-failing run is worse than refusing it. Dismissing (✕) clears both the
          banner and the gate, so a false negative never traps the composer. Stays up
          across answerVisible so it isn't missed mid-chat. */}
      {backendWarning && (
        <div className="backend-warning">
          <AlertTriangle size={14} strokeWidth={2.25} className="backend-warning-icon" />
          <div className="backend-warning-body">
            <div>{backendWarningHeadline(backendWarning)}</div>
            {/* One button, straight to the surface that can actually fix it.
                This banner used to end in `result.advice` — a sentence telling
                the user what was wrong with no way to act on it, which is the
                dead end that cost two testers their setup on 2026-07-23. The
                advice line is gone: Setup shows the same thing WITH the fix. */}
            <Button
              variant="ghost"
              type="button"
              className="backend-warning-fix"
              onClick={() => {
                setBackendWarning(null)
                void window.api.setup.open()
              }}
            >
              {CONFIG.SETUP_CHECK.bannerFixLabel}
            </Button>
          </div>
          <Button
            variant="icon"
            type="button"
            className="backend-warning-dismiss"
            onClick={() => setBackendWarning(null)}
            title="Dismiss"
          >
            <X size={13} strokeWidth={2.25} />
          </Button>
        </div>
      )}

      {/* Post-auth welcome, new-user — seeded once from the panel's init payload (see
          consumePendingWelcome in main). A hero moment, not a banner: owns the panel
          body on first open, stays up until dismissed. Returning-user gets no block
          here at all — just the header mascot pulse above (panel-title-glow).
          Disabled: the standalone onboarding flow covers this now. Flip
          SHOW_WELCOME_HERO to re-enable. */}
      {SHOW_WELCOME_HERO && welcome === 'new' && (
        <div className="welcome-hero">
          <Button
            variant="icon"
            type="button"
            className="welcome-hero-dismiss"
            onClick={() => setWelcome(null)}
            title="Dismiss"
          >
            <X size={13} strokeWidth={2.25} />
          </Button>
          <span className="welcome-hero-icon">{CONFIG.BRAND_ICON}</span>
          <div className="welcome-hero-title">You're in. Let's go.</div>
          <div className="welcome-hero-sub">
            Select text anywhere, then hit the hotkey below. {CONFIG.PRODUCT_NAME} grabs it automatically.
          </div>
          <div className="welcome-hero-kbd">
            {comboGlyphs(getShortcut('main')).map((key) => (
              <span key={key} className="welcome-hero-kcap">{key}</span>
            ))}
          </div>
        </div>
      )}

      {/* "Finish setup" activation checklist. Every row but backendConnected comes
          straight from real app state via main (see buildActivationChecklist).
          Opened only from the header ring — it never shows itself. */}
      {showChecklist && checklistRows && (
        <div className="activation-checklist">
          <Button
            variant="icon"
            type="button"
            className="activation-checklist-dismiss"
            onClick={() => setChecklistOpen(false)}
            title="Close"
          >
            <X size={13} strokeWidth={2.25} />
          </Button>
          <div className="activation-checklist-title">{CONFIG.UI_LABELS.CHECKLIST_TITLE}</div>
          {checklistRows.map((row) => (
            <div
              key={row.key}
              // A done row drops its handler, so it must drop the affordance too —
              // otherwise it keeps a pointer cursor and hover underline on a click
              // that does nothing.
              className={`activation-checklist-row ${row.done ? 'done' : ''} ${!row.done && row.onClick ? 'clickable' : ''}`}
              onClick={row.done ? undefined : row.onClick}
            >
              <span className="activation-checklist-check">
                {row.done && <Check size={11} strokeWidth={3} />}
              </span>
              <span className="activation-checklist-label">{row.label}</span>
              {!row.done && row.hint && (
                <span className="activation-checklist-hint">{row.hint}</span>
              )}
            </div>
          ))}
          {/* A finished list must say it's finished and offer the way out — "0 of 5
              left" is a counter with nothing left to count, and leaves the user
              hunting for what to do. The button is the same acknowledgement as
              opening it, made explicit. */}
          {checklistAllDone ? (
            <div className="activation-checklist-done">
              <span>{CONFIG.UI_LABELS.CHECKLIST_DONE}</span>
              <Button
                variant="success"
                type="button"
                className="activation-checklist-done-btn"
                onClick={() => setChecklistOpen(false)}
              >
                {CONFIG.UI_LABELS.CHECKLIST_DONE_ACTION}
              </Button>
            </div>
          ) : (
            <div className="activation-checklist-remaining">
              {CONFIG.UI_LABELS.CHECKLIST_REMAINING.replace(
                '{n}',
                String(checklistRemaining)
              ).replace('{total}', String(checklistRows.length))}
            </div>
          )}
        </div>
      )}

      {/* Selection Preview chip — only when there is a captured selection */}
      {selection && !answerVisible && (
        <div className="preview" title={selection}>
          <span className="preview-icon">◆</span>
          <span>{selection}</span>
        </div>
      )}

      {/* Context + status row: ctx toggle (left) · backend + mode chips (right) */}
      {!answerVisible && (
        <div className="status-row">
          <div
            className={`ctx-toggle ${ctxOn ? 'on' : ''}`}
            onClick={toggleCtx}
            {...hoverProps(CONFIG.UI_LABELS.CONTEXT_TOOLTIP)}
          >
            {/* The context's own icon IS the attachment glyph — it answers "what's
                attached" better than a paperclip. 📎 stays as the fallback for when
                there's no context to show an icon for. */}
            {ctxApp ? (
              <ContextIcon app={ctxApp} url={ctxURL} size={16} />
            ) : (
              <span className="icon">📎</span>
            )}
            <div className="sw"></div>
            <span className="label-text">
              {CONFIG.UI_LABELS.CONTEXT_PREFIX}: {ctxLabel}
            </span>
          </div>
          <div className="chip-group">
            <Button
              variant="ghost"
              type="button"
              className={`backend-chip ${backend}`}
              {...hoverProps(`${backendTip} Click to change it.`)}
              onClick={openBackendSettings}
            >
              {backendLabel}
            </Button>
            {backend === MIGHTYMOUSE_BACKEND && (
              <ModelPicker
                value={selectedModel}
                onChange={handleModelChange}
                menuRef={modelMenuRef}
                onOpenChange={setModelMenuOpen}
              />
            )}
          </div>
        </div>
      )}
      {/* Shortcut pills + editor opener. The editor itself opens in its OWN
          full-screen overlay window (skillEditorOpen) so it centers on the whole
          display and never clips inside the panel's bounds. */}
      {!answerVisible && (
        <>
          {actions.length > 0 && (
            <div className="action-row-wrap">
              <div className="action-row">
                {actions.map((a) => (
                  <Button
                    key={a.key}
                    variant="ghost"
                    type="button"
                    className={`action-chip ${activeActionKey === a.key ? 'active' : ''}`}
                    {...hoverProps(`${a.mode}: ${a.instruction || a.body || a.label}`)}
                    onClick={() => handleActionSelect(a)}
                  >
                    {a.icon && <span className="action-chip-icon">{a.icon}</span>}
                    <span>{a.label}</span>
                  </Button>
                ))}
              </div>
              <Button
                variant="ghost"
                type="button"
                className="action-edit-btn"
                {...hoverProps(CONFIG.UI_LABELS.SKILL_EDIT_TOOLTIP)}
                onClick={() => window.api.skillEditorOpen()}
              >
                {CONFIG.UI_LABELS.SKILL_ADD}
              </Button>
            </div>
          )}
          {actions.length === 0 && (
            <div className="action-row-wrap">
              <div className="action-row" />
              <Button
                variant="ghost"
                type="button"
                className="action-edit-btn"
                {...hoverProps(CONFIG.UI_LABELS.SKILL_ADD_TOOLTIP)}
                onClick={() => window.api.skillEditorOpen()}
              >
                {CONFIG.UI_LABELS.SKILL_ADD}
              </Button>
            </div>
          )}
        </>
      )}

      {/* Instruction Input Label & History button */}
      {!answerVisible && (
        <>
          {/* Main instruction input + inline mode badge. A textarea (not input) so
              it grows to fill a manually-enlarged window with text top-aligned;
              Enter still submits — handleKeyDown preventDefaults it, no newline. */}
          {/* `.input-wrap` grows to absorb window slack, which is right when the
              composer is the only thing here — but History opening GROWS the window,
              and an unconditional flex:1 lets the empty input swallow that slack
              before the flyout can use it (ballooning to ~1000px and shoving the
              flyout + its filter popup off the bottom edge). Stop claiming slack
              while History is open; the flyout gets it instead. */}
          <div
            ref={inputWrapRef}
            className={`input-wrap sbe-host-panel ${historyOpen ? 'no-grow' : ''} ${composerH !== null ? 'is-sized' : ''}`}
            style={composerH !== null ? { height: composerH } : undefined}
            onDragOver={(e) => e.preventDefault()}
            onDrop={att.drop}
          >
            <SkillBodyEditor
              inputRef={inputRef as React.RefObject<HTMLTextAreaElement>}
              textareaId="i"
              textareaClassName=""
              rows={1}
              value={inputValue}
              onChange={(v) => {
                setInputValue(v)
                if (inputError) setInputError(false)
              }}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              disabled={inputDisabled}
              textareaStyle={{ borderColor: inputError ? 'var(--magenta)' : undefined }}
            >
              <Button
                variant="icon"
                type="button"
                className="input-attach-btn"
                onClick={() => void att.pick()}
                title="Attach images, audio, or files"
                aria-label="Attach files"
              >
                <Plus size={18} />
              </Button>
              <Button
                variant="ghost"
                type="button"
                className="input-badge-btn badge"
                style={modeChipVars(effectiveMode)}
                id="badge"
                {...hoverProps(modeTip)}
                onClick={cycleMode}
              >
                {CONFIG.MODE_META[effectiveMode]?.label ?? effectiveMode}
              </Button>
            </SkillBodyEditor>
          </div>
          <div
            className="composer-resize"
            onPointerDown={startComposerDrag}
            onDoubleClick={() => setComposerH(null)}
            title="Drag to resize · double-click to reset"
            role="separator"
            aria-label="Resize the text box"
          >
            <span className="composer-resize-grip" />
          </div>
          {att.attachments.length > 0 && (
            <div className="px-1 pt-2">
              <AttachBar attachments={att.attachments} onRemove={att.remove} />
            </div>
          )}

          {/* Keyboard hints + History toggle — fixed directly under the input,
              never moves. The History flyout expands BELOW this row. */}
          {!busyActive && (
            <div className="hint">
              <span>
                <kbd>Enter</kbd> to send &middot; <kbd>Esc</kbd> to close
              </span>
              <Button
                variant="ghost"
                className={`history-btn ${historyOpen ? 'active' : ''}`}
                onClick={handleOpenHistory}
                type="button"
              >
                <span className="history-icon">↺</span>
                <span className="history-text">History</span>
              </Button>
            </div>
          )}
        </>
      )}

      {/* Code Flyout — PARKED. The Code button now opens the Mighty window's
          Code tab instead, so cards get answered on a surface wide enough for a
          diff. Kept because the flyout still works and the inline surface may
          come back for quick yes/no cards.
      {codeOpen && relay.enabled && (
        <CodePanel
          pending={relay.pending}
          resolved={relay.resolved}
          onRespond={relay.respond}
          onClose={() => setCodeOpen(false)}
          onContentChange={measureAndReport}
        />
      )} */}

      {/* History Flyout Overlay — appears below the hint row */}
      {historyOpen && (
        <HistoryList
          onReuse={handleReuseHistoryItem}
          onContinue={handleContinueHistoryItem}
          onClose={() => setHistoryOpen(false)}
          onContentChange={measureAndReport}
          filterPopRef={filterPopRef}
        />
      )}

      {/* Loading Overlay */}
      {busyActive && (
        <div className={`busy active ${effectiveMode}`}>
          <div className="spinner"></div>
          <div className="busy-text">
            <div className="busy-phase">{busyPhase}</div>
            <div className="busy-detail">{busyDetail}</div>
            <div className={`busy-ctx ${busyCtxVisible ? 'visible' : ''}`}>
              📎 screenshot + page context attached
            </div>
            {/* ETA bar — appears once the estimator has a target for this run's shape.
                Fills toward the predicted finish, shimmers past it. Absent (etaMs 0)
                on a cold-start run, so the overlay looks exactly as before then. */}
            {busyEtaMs > 0 && (
              <div className={`busy-eta ${busyOvertime ? 'hud-eta-overtime' : ''}`}>
                <ProgressBar pct={busyEtaPct} height="h-1" />
              </div>
            )}
          </div>
          <div className="busy-timer">{busySeconds.toFixed(1)}s</div>
          <Button variant="ghost" type="button" className="stop-btn" onClick={handleStop} title="Stop">
            <Square size={11} fill="currentColor" strokeWidth={0} />
            <span>Stop</span>
          </Button>
        </div>
      )}

      {/* Conversational Answers Panel */}
      {answerVisible && (
        <div className="answer-wrap visible">
          {/* Context header — what this conversation is grounded in */}
          <div className="chat-ctx-header">
            <Button
              variant="ghost"
              type="button"
              className="chat-back"
              onClick={handleBack}
              title="Back to main / start a new conversation"
            >
              ← New
            </Button>
            <span
              className="chat-ctx-label"
              title={ctxOn ? CONFIG.UI_LABELS.CONTEXT_TOOLTIP : ctxLabel}
            >
              {ctxOn
                ? `📎 ${CONFIG.UI_LABELS.CONTEXT_PREFIX}: ${ctxLabel}`
                : actResult
                  ? 'act'
                  : 'ask'}
            </span>
            <span className={`chat-backend ${backend}`}>{backendLabel}</span>
            <Button
              variant="icon"
              type="button"
              className="chat-hide"
              onClick={() => void expandToMighty(true)}
              {...hoverProps(CONFIG.UI_LABELS.MIGHTY_RESUME_TOOLTIP)}
            >
              <SquareArrowOutUpRight size={13} strokeWidth={2.25} />
            </Button>
            <Button
              variant="icon"
              type="button"
              className="chat-hide"
              onClick={() => window.api.panelHide()}
              title={`Hide (${comboGlyphs(getShortcut('main')).join('')} to bring back)`}
            >
              <ChevronDown size={14} strokeWidth={2.5} />
            </Button>
          </div>

          {/* Out-of-credits inline prompt — replaces the thread when balance = $0 */}
          {outOfCredits && (
            <div className="thread">
              <div className="msg a">
                <div className="bubble" style={{ color: 'var(--red-light)' }}>
                  {CONFIG.UI_LABELS.OUT_OF_CREDITS}
                  {usageResetLine && ` ${usageResetLine}.`}
                </div>
              </div>
              <div className="msg a">
                <div className="bubble">
                  {/* Smallest pack, read from config — never hardcode the id or the
                      price here or this button silently lies the moment pricing moves. */}
                  <Button
                    variant="primary"
                    type="button"
                    className="btn"
                    onClick={() =>
                      window.api.billingOpenCheckout({
                        kind: 'pack',
                        id: TOP_UP_PACK.id,
                        reason: 'credits_empty'
                      })
                    }
                  >
                    Add {TOP_UP_PACK.label} extra usage
                  </Button>{' '}
                  <Button
                    variant="ghost"
                    type="button"
                    className="btn"
                    onClick={() => window.api.openUpgradeWindow('credits_empty')}
                  >
                    See plans
                  </Button>
                  <span
                    style={{ display: 'block', marginTop: 6, fontSize: 11, color: 'var(--muted)' }}
                  >
                    Or switch to a BYO backend (Claude or Codex) via the chip above.
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Act result — one-shot summary + Reveal, no follow-up thread. */}
          {actResult && !outOfCredits && (
            <div className="thread">
              <div className="msg a">
                <div
                  className="bubble act-result-bubble"
                  style={actResult.ok ? undefined : { color: 'var(--red-light)' }}
                >
                  {actResult.summary}
                  <Button
                    variant="icon"
                    type="button"
                    className={`bubble-copy ${copiedMsg === -1 ? 'copied' : ''}`}
                    onClick={() => copyMessage(-1, actResult.summary)}
                    title="Copy"
                    aria-label="Copy result"
                  >
                    {copiedMsg === -1 ? '✓' : '⧉'}
                  </Button>
                  <Button
                    variant="icon"
                    type="button"
                    className={`bubble-speak ${speakingMsg === -1 ? 'speaking' : ''}`}
                    onClick={() => void speakMessage(-1, actResult.summary)}
                    title={speakingMsg === -1 ? 'Stop' : 'Read aloud'}
                    aria-label={speakingMsg === -1 ? 'Stop reading' : 'Read result aloud'}
                  >
                    {speakingMsg === -1 ? '◼' : '🔊'}
                  </Button>
                </div>
                {actResult.revealPath && (
                  <div className="meta">
                    <Button
                      variant="ghost"
                      type="button"
                      className="btn"
                      title={actResult.revealPath}
                      onClick={() => window.api.openPath(actResult.revealPath!)}
                    >
                      {actResult.revealIsDir ? 'Open run folder' : 'Show in Finder'}
                    </Button>
                  </div>
                )}
              </div>
              <div ref={threadEndRef} />
            </div>
          )}

          {!actResult && (
          <div className="thread" style={{ display: outOfCredits ? 'none' : undefined }}>
            {threadTurns.flatMap((turn, i) => {
              const bubbles = [
                <div key={`${i}-q`} className="msg q">
                  <div className="bubble">
                    {turn.q}
                    <Button
                      variant="icon"
                      type="button"
                      className={`bubble-copy ${copiedMsg === i * 2 ? 'copied' : ''}`}
                      onClick={() => copyMessage(i * 2, turn.q)}
                      title="Copy"
                      aria-label="Copy message"
                    >
                      {copiedMsg === i * 2 ? '✓' : '⧉'}
                    </Button>
                  </div>
                  <div className="meta">you</div>
                </div>
              ]
              // `a` is empty while a turn is still in flight — a run started elsewhere
              // (Mighty, a hotkey) that we bound to. Our OWN in-flight turn never
              // reaches here; threadTurns drops it in favour of the pending bubble.
              if (turn.a) {
                bubbles.push(
                  <div key={`${i}-a`} className="msg a">
                    <div className="bubble">
                      <Markdown>{turn.a}</Markdown>
                      <Button
                        variant="icon"
                        type="button"
                        className={`bubble-copy ${copiedMsg === i * 2 + 1 ? 'copied' : ''}`}
                        onClick={() => copyMessage(i * 2 + 1, turn.a)}
                        title="Copy"
                        aria-label="Copy message"
                      >
                        {copiedMsg === i * 2 + 1 ? '✓' : '⧉'}
                      </Button>
                      <Button
                        variant="icon"
                        type="button"
                        className={`bubble-speak ${speakingMsg === i * 2 + 1 ? 'speaking' : ''}`}
                        onClick={() => void speakMessage(i * 2 + 1, turn.a)}
                        title={speakingMsg === i * 2 + 1 ? 'Stop' : 'Read aloud'}
                        aria-label={speakingMsg === i * 2 + 1 ? 'Stop reading' : 'Read answer aloud'}
                      >
                        {speakingMsg === i * 2 + 1 ? '◼' : '🔊'}
                      </Button>
                    </div>
                    <div className="meta">
                      {backend}
                      {showTiming && typeof turn.durationMs === 'number' && (
                        <> · {formatRunDuration(turn.durationMs)}</>
                      )}
                    </div>
                  </div>
                )
              }
              return bubbles
            })}
            {chatPending && (
              <div className="msg q">
                <div className="bubble">{lastSentRef.current}</div>
                <div className="meta">you</div>
              </div>
            )}
            {chatPending && (
              <div className="msg a pending">
                <div className="bubble thinking">
                  <span className="typing-dots">
                    <span></span>
                    <span></span>
                    <span></span>
                  </span>
                  <span className="thinking-label">{busyPhase.toLowerCase()}</span>
                </div>
                <Button
                  variant="ghost"
                  type="button"
                  className="stop-btn stop-btn-inline"
                  onClick={handleStop}
                  title="Stop generating"
                >
                  <Square size={10} fill="currentColor" strokeWidth={0} />
                  <span>Stop</span>
                </Button>
              </div>
            )}
            <div ref={threadEndRef} />
          </div>
          )}

          {/* Follow-up composer — chat (ask) only; act results are one-shot. */}
          {!actResult && (
          <input
            ref={inputRef as React.RefObject<HTMLInputElement>}
            className={`chat-composer ${chatPending ? 'pending' : ''}`}
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={chatPending ? 'Thinking…' : 'Ask a follow-up…'}
            disabled={inputDisabled}
          />
          )}
        </div>
      )}
    </div>
  )
}
