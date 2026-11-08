import React, { useEffect, useState, useRef } from 'react'
import { flushSync } from 'react-dom'
import { CornerDownLeft, Maximize2, Radio, Sparkles, Square, Waypoints, X, Zap } from 'lucide-react'
import { CONFIG } from '../../shared/config'
import { HUD_MODE, HUD_CAPTURE, HUD_ROUTE_ROOM } from '../../shared/types'
import { ProgressBar } from './components/ProgressBar'
import { ActionsSection } from './components/ActionsSection'
import { ProgressMeter, MAC_METER_CLASSES } from '../../shared/progress-ring'
import { FeedbackRow } from './components/FeedbackRow'
import type {
  HudMode,
  HudCapture,
  HudActionKind,
  FeedbackRating,
  HudPreview,
  QuickAction,
  HudRelayCard
} from '../../shared/types'
import { AGENT_FACE_SIZE } from '../../shared/agent-face'
import { AgentFace } from '../../shared/agent-face-view'
import { UNKNOWN_SENDER, waitingLabel, levelEmoji } from '../../shared/relay-cards'
import { distinctPath } from '../../shared/relay-status'
import { interviewView, answerAt } from '../../shared/relay-interview'
import { RelayInterviewNav, HUD_NAV_CLASSES } from '../../shared/relay-interview-nav'
import { timerTransition } from './hud-timer'
import { useInterval } from './hooks/useInterval'
import { useIpcSubscriptions } from './hooks/useIpcSubscriptions'
import { WaveformViz } from './components/WaveformViz'
import { Tooltip, useTooltip } from './components/Tooltip'
import { Button } from './components/Button'
import { CopyButton } from './components/CopyButton'

// Hover copy for the card's destructive/interrupt controls. These three are easy
// to confuse at a glance (see the ×/✕/■ cluster), so each says what SURVIVES the
// click, not just what the click does. Native `title` is unreliable in this
// borderless always-on-top window (see Tooltip.tsx) — these go through <Tooltip>.
/**
 * The card's folder line, or nothing when the folder just restates the repo the
 * sender label already names. The shim builds `from` as `repo/branch - session`
 * (mightymouse-code.js:47), so the repo is the head of that string -- which is
 * exactly the comparison `distinctPath` wants, and reusing it keeps one rule for
 * "is this path worth a line" instead of a second copy that drifts.
 */
function hudSenderPath(relay: HudRelayCard): string | undefined {
  if (!relay.cwd) return undefined
  const repo = (relay.from ?? '').split(/[/\-]/)[0].trim()
  // No parseable repo means nothing to be redundant WITH, so the path always earns its line.
  return repo ? distinctPath(relay.cwd, repo) : distinctPath(relay.cwd, '')
}

/**
 * The glyph on a pending relay card. One '⚡' for all three verbs meant a
 * screenshot and a destructive-approval looked identical at a glance, which is
 * the one moment the difference matters. Severity wins when the sender stated
 * one -- a 🛑 is a stronger claim than "this is an approve".
 */
function relayIcon(relay: HudRelayCard): string {
  return levelEmoji(relay.level) ?? (relay.verb === 'approve' ? '🔑' : relay.verb === 'show' ? '👀' : '💬')
}

/** Same rule as the Panel's isHighRisk (relay-cards.ts), on the HUD's own DTO --
 *  HudRelayCard isn't a RelayRequestWire, so the shared helper doesn't apply
 *  directly, but the definition ("a high-risk approve") is one line either way. */
function relayHighRisk(relay: HudRelayCard): boolean {
  return relay.verb === 'approve' && relay.risk === 'high'
}

/** "Asked 4m ago" / "Times out in 2m" -- the Panel and phone cards already show
 *  this off `waitingLabel`; the HUD is the surface you answer from without
 *  opening either of them, so it's the one card that most needs to say it. Ticks
 *  independently of the run timer (which stays off for a relay card -- see
 *  showTimer below): this is elapsed WAIT time, not elapsed WORK time. */
function RelayWaitingTime({ relay }: { relay: HudRelayCard }): React.ReactElement | null {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(tick)
  }, [])
  const label = waitingLabel(relay, now)
  if (!label) return null
  return (
    <span className="hud-relay-waiting" data-urgent={label.urgent ? '' : undefined}>
      {label.text}
    </span>
  )
}

const CONTROL_TIP = {
  stopCapture: 'Stop and keep the recording',
  cancelCapture: 'Discard - keeps nothing',
  stopRun: 'Stop and keep what it has so far',
  dismiss: 'Hide this card - the run keeps going',
  dismissIdle: 'Hide this card',
  // Same string as the Settings toggle that enables this button — a tooltip
  // naming a feature must match what Settings calls it, or the setting is
  // unfindable. Renamed together 2026-07-22 ("Show run details" → this).
  expand: CONFIG.UI_LABELS.RUN_DETAILS,
  transcribeTime: 'Time spent turning your words into text'
} as const

function parseMode(): HudMode {
  const m = new URLSearchParams(window.location.search).get('mode')
  return m === HUD_MODE.screenshot || m === HUD_MODE.recording ? m : HUD_MODE.act
}

function parseCapture(): HudCapture {
  const c = new URLSearchParams(window.location.search).get('capture')
  if (c === HUD_CAPTURE.screen) return HUD_CAPTURE.screen
  if (c === HUD_CAPTURE.smartListen) return HUD_CAPTURE.smartListen
  if (c === HUD_CAPTURE.handsFree) return HUD_CAPTURE.handsFree
  return HUD_CAPTURE.listen
}

const ACTION_LABEL: Record<HudActionKind, string> = {
  ask: 'Ask',
  act: 'Act'
}

// How many seconds of a recording the inline clip plays before looping back. A
// capture card auto-dismisses in a few seconds, so a short opening loop is all
// that ever shows — no need to play (or even decode) the whole video.
const PREVIEW_CLIP_SECONDS = 4

// Transcription speed, as a human would say it: sub-second in ms (the common
// case — whisper is ~1.2s flat), seconds beyond that. Never "0.9s".
function formatTranscribeTime(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}

// The macOS-style inline capture preview shown on a finished card. Screenshots
// render as a still <img>; recordings as a muted, autoplaying clip that loops the
// first few seconds. Uses the media:// protocol (window.api.mediaUrl) exactly
// like the Media Library thumbnails, so no web-security relaxation is needed.
function PreviewMedia({ preview }: { preview: HudPreview }): React.ReactElement {
  const videoRef = useRef<HTMLVideoElement>(null)
  const src = window.api.mediaUrl(preview.path)

  // Loop just the opening: when playback passes the clip window, jump back to 0.
  useEffect(() => {
    const v = videoRef.current
    if (!v || preview.kind !== 'video') return
    const onTime = (): void => {
      if (v.currentTime >= PREVIEW_CLIP_SECONDS) v.currentTime = 0
    }
    v.addEventListener('timeupdate', onTime)
    return () => v.removeEventListener('timeupdate', onTime)
  }, [preview])

  return (
    <div className="hud-preview">
      {preview.kind === 'image' ? (
        <img src={src} decoding="async" alt="Screenshot preview" />
      ) : (
        <video ref={videoRef} src={src} muted autoPlay loop playsInline preload="auto" />
      )}
    </div>
  )
}

// A pre-warmed spare window (warmHud in hud-window.ts) loads with no runId and is
// handed its card later via hudInit. Every piece of card state below is parsed from
// the URL on mount, so the cheapest correct reset is: rewrite the query string,
// then remount the whole card under a new key.
export default function HudRoot(): React.ReactElement {
  const [gen, setGen] = useState(0)
  useEffect(
    () =>
      window.api.onHudInit((p) => {
        const q = new URLSearchParams({
          window: 'hud',
          runId: p.runId,
          title: p.title,
          subtitle: p.subtitle,
          mode: p.mode,
          capture: p.capture,
          etaMs: String(p.etaMs),
          elapsedMs: String(p.elapsedMs)
        })
        window.history.replaceState(null, '', `?${q}`)
        // flushSync, not a plain setState: on the WARM path main sends hudInit and
        // hudDone back-to-back in one tick (startRelayHud → startHud → doneHud, with
        // card.ready already true). A deferred remount let that hudDone land on the
        // OUTGOING instance's subscription — its state was then thrown away and the
        // new card mounted at its defaults, so a "Needs your answer" relay card came
        // up as running: spinner + ticking timer, relay payload lost. Mounting
        // synchronously means the new instance is subscribed before hudDone arrives.
        flushSync(() => setGen((g) => g + 1))
      }),
    []
  )
  if (gen === 0 && new URLSearchParams(window.location.search).has('warm')) return <></>
  return <HudApp key={gen} />
}

function HudApp(): React.ReactElement {
  const [runId, setRunId] = useState('')
  const [title, setTitle] = useState('Working on it')
  const [subtitle, setSubtitle] = useState('working…')
  const [icon, setIcon] = useState('⚡')
  // Parsed synchronously so the timer/IPC closures below see the right value
  // on first render (the onHudDone subscription captures it once on mount).
  const [mode] = useState<HudMode>(parseMode)
  // Screen-record vs mic-listen vs smart-dictation. Only screen-record shows the
  // 🖥 + 🔴 indicator so the user knows their SCREEN is being captured, not just
  // audio. Mutable (not just parsed once from the URL): the hold-to-smart-dictation
  // upgrade morphs a LIVE listen card from `listen` to `smartListen` in place via
  // onHudUpdate's `capture` field, instead of main closing this window and opening
  // a new one (which visibly hid the HUD for a frame — see morphHud in hud-window.ts).
  const [capture, setCapture] = useState<HudCapture>(parseCapture)
  // Whether the card is currently a LIVE mic recording (drives the waveform UI).
  // Starts true for a recording card, but a button-initiated Ask/Act run flips it
  // off — that run reuses the same card but is an LLM call, not a recording.
  const [recording, setRecording] = useState(mode === HUD_MODE.recording)
  // 0..1 while the listen hotkey is physically held, before the tap/hold threshold
  // fires - drives the intensifying hold-glow ring so a hold visibly registers
  // instead of dead silence until the smart-dictation flip. 0 = no glow.
  const [holdProgress, setHoldProgress] = useState(0)
  const [routeNext, setRouteNext] = useState(false)
  const [submitNext, setSubmitNext] = useState(false)
  const [timerFreeze, setTimerFreeze] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState('0.0s')
  // How long transcribing took, beside the clip length. Main only sends it when the
  // user turned "Show transcription speed" on, so null = off or not a dictation card.
  const [transcribeMs, setTranscribeMs] = useState<number | null>(null)
  // Predicted total run time (ms), from the estimator. Arrives one of two ways:
  //  • startHud query (card raised for this run) — read here on mount, or
  //  • a running/update IPC message (card raised as a recording/listen then REUSED
  //    for the LLM call, or a panel→HUD detach) — applied in onHudUpdate below.
  // 0 = no estimate → no bar, just the timer. Drives the progress fill below.
  const [etaMs, setEtaMs] = useState<number>(() => {
    const raw = Number(new URLSearchParams(window.location.search).get('etaMs'))
    return Number.isFinite(raw) && raw > 0 ? raw : 0
  })
  // Live fill 0–100. Held below BAR_CAP_PCT while running so the bar never reads
  // "done" before the run is; the timer keeps ticking honestly past the estimate.
  const [barPct, setBarPct] = useState(0)

  // Timer ticks live for recordings AND for any LLM run card (act/ask/rewrite all
  // open as HUD_MODE.act). A run card opens straight into "working…", so it must
  // tick from mount — without this an ask/rewrite/act card showed a spinner but a
  // frozen 0.0s until done. Screenshot stays off (instantaneous, no timer).
  const [showTimer, setShowTimer] = useState(
    mode === HUD_MODE.recording || mode === HUD_MODE.act
  )

  // Revealed when the user presses Esc once during a live capture (main pushes
  // it via hudUpdate). Shows the "Esc again to cancel" hint; a second Esc discards.
  const [cancelArmed, setCancelArmed] = useState(false)

  // Hands-free only: is the user talking right now (VAD, pushed from main)? The
  // session is mostly silence, so the wave + timer follow speech instead of
  // running the whole time — see speechDriven below.
  const [speaking, setSpeaking] = useState(false)

  // Hands-free stays open across long pauses, so a permanent waveform over a
  // climbing timer read as "recording everything" when nothing was captured.
  // Only this capture kind defers its wave/timer to actual speech; every other
  // recording IS continuous, so they keep showing both for their whole run.
  // Mode matters: hands-free ALSO raises an act card per utterance, and that one
  // is a normal finished run whose transcribe time should show.
  const speechDriven = capture === HUD_CAPTURE.handsFree && mode === HUD_MODE.recording

  // 'stopped' is a THIRD settled state, not a flavour of fail: the user chose it,
  // so it renders neutral (grey ■) instead of red (!). Keeping it separate stops
  // deliberate stops from reading as crashes.
  // 'waiting' = blocked on a human decision. Distinct from 'running' because
  // every piece of run chrome (spinner, stop square, ticking clock) keys on
  // 'running', and none of it is true while nothing is executing.
  const [hudState, setHudState] = useState<'running' | 'waiting' | 'ok' | 'fail' | 'stopped'>(
    'running'
  )
  const [clickable, setClickable] = useState(false)
  // One tooltip for the whole card — labels the ■/✕/× controls on hover, instantly
  // and in-brand (native `title` is slow + OS-chromed here).
  const { tip, hoverProps } = useTooltip()
  // True when the run saved a folder/file we can reveal. On a plain card the
  // whole card is clickable to reveal; on an interactive card (Ask/Act buttons)
  // the card click is reserved, so we surface an explicit "Open folder" button.
  const [canReveal, setCanReveal] = useState(false)
  const [actions, setActions] = useState<HudActionKind[]>([])
  const [body, setBody] = useState<string | null>(null)
  // True when this card is a destructive-act gate: render Confirm/Cancel instead
  // of the normal Ask/Act row, and keep the buttons visible (not hover-gated) —
  // the user must see the decision immediately, not discover it by hovering.
  const [confirmAct, setConfirmAct] = useState(false)
  // Present = this card is a code-agent-relay ask/approve/show request, not a
  // normal run result (PRD 2026-08-12-1786501335 §6b). Renders its own row
  // instead of the confirmAct/actions branches below.
  const [relay, setRelay] = useState<HudRelayCard | null>(null)
  // §5.4: "the button is not rendered" when nothing resolves. origin never
  // rides HudRelayCard itself (it lives on the main-process RelayRequest), so
  // this is a one-shot invoke keyed by requestId rather than a card field.
  const [canGoToOrigin, setCanGoToOrigin] = useState(false)
  const [relayAnswer, setRelayAnswer] = useState('')
  const [relayNote, setRelayNote] = useState('')
  // Same shared derivation the Panel and phone cards use -- three surfaces on
  // one interview must not each hold their own cursor (PRD §7.3).
  // Which question is being LOOKED at, when that is not the one the interview is
  // waiting on. null follows the cursor, which is every card until Back is used.
  const [viewIndex, setViewIndex] = useState<number | null>(null)

  const interview = interviewView(
    relay?.questions,
    relay?.buffered,
    relay?.canReadPane ?? false,
    relay?.options,
    viewIndex ?? undefined
  )
  const askQuestion = interview.isInterview ? interview.current?.question : undefined
  const askOptions = (interview.isInterview ? interview.current?.options : relay?.options) ?? []
  const askDone = interview.isInterview && interview.current === null

  useEffect(() => {
    if (!relay) {
      setCanGoToOrigin(false)
      return
    }
    let cancelled = false
    // Cheap main-side check (no shell-out, see origin-resolver.ts's
    // isOriginResolvable) -- fine to fire once per card without debouncing.
    window.api.hudCanGoToOrigin(relay.requestId).then((can) => {
      if (!cancelled) setCanGoToOrigin(can)
    })
    return () => {
      cancelled = true
    }
  }, [relay?.requestId])

  // Inline capture preview: a screenshot thumbnail or a short looping clip of a
  // recording, shown macOS-style above the summary once the run finishes.
  const [preview, setPreview] = useState<HudPreview | null>(null)

  // True while an Ask/Act run kicked off from this card's buttons is in flight,
  // so we swap the action row for a "Working…" note.
  const [followUpRunning, setFollowUpRunning] = useState(false)

  // The optional instruction typed into the card's input. Consumed by whichever
  // Ask/Act button the user presses; cleared after.
  const [actionInput, setActionInput] = useState('')

  // The instruction input is hidden by default so the card stays compact; it
  // reveals on hover (or once the user has typed into it). Keeps it open while
  // there's text so a hover-out mid-typing doesn't drop what was entered.
  const [actionInputOpen, setActionInputOpen] = useState(false)
  // Voice routing in 'hover' mode: main is holding this transcript unranked.
  // 'idle' shows the button, 'ranking' its spinner; the card closes itself once
  // the route card opens, so there is no success state to render here.
  const [voiceRoute, setVoiceRoute] = useState<'no' | 'idle' | 'ranking' | 'gone'>('no')
  const hasRouteRoom = voiceRoute !== 'no'

  // The user's skills (QuickActions), same list as the main panel. Shown as a bar
  // on hover of a finished card — clicking one runs that skill against this card,
  // with the capture file (capture card) or the full chat (AI card) as context.
  const [skills, setSkills] = useState<QuickAction[]>([])
  useEffect(() => {
    window.api.actionsLoad().then((list) => setSkills(list ?? []))
  }, [])

  // Explicit 👍/👎 feedback for this run, same loop as the History flyout. The HUD
  // is a fresh run with no prior rating, so this state starts empty and is filled
  // optimistically on click. Gated on feedbackEnabled (fetched once on mount) and
  // only shown on a finished result, revealed on hover like the action group.
  const [feedbackEnabled, setFeedbackEnabled] = useState(false)
  // Run Transcript Inspector ("Show run details") — when on, the card shows an
  // expand icon on hover that opens the full-screen inspector for this run.
  const [runTranscript, setRunTranscript] = useState(false)
  const [feedbackRating, setFeedbackRating] = useState<FeedbackRating | null>(null)
  const [feedbackNote, setFeedbackNote] = useState<string | null>(null)

  // Run start, back-dated by any time that already elapsed before this card mounted
  // (a panel→HUD detach: main passes elapsedMs so the timer + bar CONTINUE the run's
  // clock instead of resetting to 0). Fresh cards get elapsedMs=0 → start = now.
  const startTimeRef = useRef<number>(
    Date.now() - (Number(new URLSearchParams(window.location.search).get('elapsedMs')) || 0)
  )
  const bodyRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)

  // Parse query arguments once on mount.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    setRunId(params.get('runId') || '')
    setTitle(params.get('title') || 'Working on it')
    setSubtitle(params.get('subtitle') || 'working…')
    // Whether the 👍/👎 feedback control should appear on a finished card. Read
    // from the same PanelInitData the panel uses, so the HUD honors the Settings
    // toggle without its own preload channel.
    window.api.getInitialData().then((d) => setFeedbackEnabled(d.feedbackEnabled))
    // Whether the expand-to-inspector affordance should appear. Read from prefs so
    // the HUD honors the Settings "Show run details" toggle.
    window.api.settingsGetPrefs().then((p) => setRunTranscript(p.runTranscript))
  }, [])

  // Elapsed timer; ticks while showTimer is on and not frozen. Also advances the
  // ETA bar: fill = elapsed/eta, capped at BAR_CAP_PCT so it holds (with a shimmer)
  // near the end instead of claiming done — doneHud snaps it to 100% when the run
  // actually finishes. No eta (etaMs===0) → barPct stays 0 and the bar isn't rendered.
  useInterval(
    () => {
      const ms = Date.now() - startTimeRef.current
      setElapsed((ms / 1000).toFixed(1) + 's')
      if (etaMs > 0) {
        setBarPct(Math.min(CONFIG.ESTIMATOR.BAR_CAP_PCT, (ms / etaMs) * 100))
      }
    },
    // Also gated on hudState: a done/fail card must never keep ticking even if a
    // hudDone payload somehow arrived without timerFreeze (belt-and-suspenders —
    // the visible symptom this guards against is a ✓ card whose timer never stops).
    showTimer && timerFreeze === null && hudState === 'running' ? 100 : null
  )

  // On done/fail the timer freezes; snap the bar to full so it visually completes
  // (success or fail, the work is over — a bar stuck at 80% would look wrong).
  useEffect(() => {
    if (timerFreeze !== null && etaMs > 0) setBarPct(100)
  }, [timerFreeze, etaMs])

  // Show the bar only for a live LLM run with a real estimate — never for recordings
  // (their length is user-controlled, not predictable) or when we have no history.
  const showBar = etaMs > 0 && !recording && hudState === 'running'
  // Once elapsed passes the estimate we can't fill further, so shimmer to signal
  // "still going" rather than freezing a dead bar at the cap.
  const barOvertime = showBar && barPct >= CONFIG.ESTIMATOR.BAR_CAP_PCT

  // Auto-scroll the answer to the bottom when a new body lands (e.g. a follow-up
  // answer). rAF so scrollHeight is read after the browser lays the text out.
  useEffect(() => {
    if (!body || !bodyRef.current) return
    const el = bodyRef.current
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight
    })
  }, [body])

  // Content-driven sizing: observe the card's real rendered height and ask the
  // main process to size the window to fit. This is the SINGLE source of truth
  // for the card height — main no longer guesses with fixed per-state constants,
  // so the layout can never clip the buttons or the input.
  useEffect(() => {
    const el = cardRef.current
    if (!el || !runId) return
    let last = 0
    const report = (): void => {
      // offsetHeight is the container's true rendered height (it's min-height:100%
      // + content, so it grows/shrinks with the card). Round up so a sub-pixel
      // measurement never shaves a row.
      const h = Math.ceil(el.offsetHeight) - ('routeRoom' in el.dataset ? HUD_ROUTE_ROOM : 0)
      if (h > 0 && Math.abs(h - last) >= 1) {
        last = h
        window.api.hudResize(runId, h)
      }
    }
    const ro = new ResizeObserver(report)
    ro.observe(el)
    report()
    return () => ro.disconnect()
  }, [runId, hasRouteRoom])

  useIpcSubscriptions(() => [
    window.api.onHudUpdate((payload) => {
      // A button-initiated run flips the card back to "running". It's an Ask/Act
      // LLM call, not a recording — drop the mic-waveform UI for the icon/spinner.
      if (payload.running) {
        setHudState('running')
        setRecording(false)
        setIcon('⚡')
        setActions([])
        setBody(null)
        setClickable(false)
        setTimerFreeze(null)
        setShowTimer(true)
        setFollowUpRunning(false)
        setCanReveal(false)
        // Reusing a capture card for an Ask/Act run — drop the capture preview so
        // the LLM result card isn't topped by a stale screenshot/video thumbnail.
        setPreview(null)
        // Fresh run on the reused card → drop any prior rating so the new result
        // gets its own 👍/👎.
        setFeedbackRating(null)
        setFeedbackNote(null)
        startTimeRef.current = Date.now()
        if (payload.title) setTitle(payload.title)
        // Late ETA: this card was raised without one (recording/listen reuse, or a
        // panel→HUD detach). Reset the bar to 0 and adopt the run's estimate (or
        // clear it to 0 = timer-only) so the fill restarts from the new run's start.
        setBarPct(0)
        setEtaMs(payload.etaMs && payload.etaMs > 0 ? payload.etaMs : 0)
      }
      // Esc armed (or the 1.5s window lapsed): toggle the hint. This update carries
      // no subtitle, so don't clobber the existing one.
      if (payload.cancelArmed !== undefined) setCancelArmed(payload.cancelArmed)
      // Explicit recording flip (e.g. smart dictation's mic-closed → processing
      // handoff) — drops the waveform branch so the subtitle text becomes visible.
      if (payload.recording !== undefined) setRecording(payload.recording)
      if (payload.holdProgress !== undefined) setHoldProgress(payload.holdProgress)
      if (payload.routeNext) setRouteNext(true)
      if (payload.submitNext) setSubmitNext(true)
      if (payload.speaking !== undefined) setSpeaking(payload.speaking)
      // Listen → smart-dictation upgrade, morphed onto this SAME card (morphHud in
      // hud-window.ts). Not gated on `running` — the session is still live, this
      // just swaps the badge/accent/title. The .hud-smart-morph CSS class (below)
      // picks up the capture change and animates it instead of hard-cutting.
      if (payload.capture !== undefined) setCapture(payload.capture)
      if (payload.title !== undefined && !payload.running) setTitle(payload.title)
      // Freeze/resume is handled BEFORE the subtitle bail-out: a freeze can arrive
      // on an update that changes nothing else (a capture that stopped but whose
      // phase label is unchanged), and returning early used to drop it on the floor.
      setTimerFreeze((frozen) => {
        const t = timerTransition(payload.freezeTimer, payload.timerFreeze, frozen)
        if (t.kind === 'freeze') {
          setElapsed(t.at)
          return t.at
        }
        if (t.kind === 'resume') {
          if (t.rebaseToMs !== null) startTimeRef.current = Date.now() - t.rebaseToMs
          return null
        }
        return frozen
      })
      if (payload.subtitle === undefined) return
      setSubtitle(payload.subtitle)
    }),
    window.api.onHudDone((payload) => {
      // Act/ask/recording HUDs reveal their total time on done (main sends it in
      // `timerFreeze`). A screenshot is instantaneous — its duration is noise, so
      // never show a timer for it.
      if (payload.timerFreeze && mode !== HUD_MODE.screenshot) {
        setShowTimer(true)
        setTimerFreeze(payload.timerFreeze)
        setElapsed(payload.timerFreeze)
      }
      if (payload.transcribeMs !== undefined) setTranscribeMs(payload.transcribeMs)
      // A stop arrives on the ok:false path but is NOT a failure — neutral state
      // and a ■ glyph (matching the button that caused it), never the red !.
      const wasStopped = !payload.ok && !!payload.stopped
      // A pending relay card is NOT finished, so it must not claim success -- a ✓
      // on an unanswered question reads as "already handled". It is not running
      // either: the agent is parked waiting on this human, so 'waiting' drops the
      // spinner/stop/clock. It settles when the answer lands.
      const relayPending = !!payload.relay
      setHudState(relayPending ? 'waiting' : payload.ok ? 'ok' : wasStopped ? 'stopped' : 'fail')
      setIcon(
        relayPending ? relayIcon(payload.relay!) : payload.ok ? '✓' : wasStopped ? '■' : '!'
      )
      // A relay card's elapsed time measures how long the human took to look, not
      // work done -- and main sends timerFreeze on this same path, which would
      // otherwise park a frozen 0.0s on the card forever.
      if (relayPending) setShowTimer(false)

      setActions(payload.actions || [])
      setVoiceRoute(payload.canVoiceRoute ? 'idle' : 'no')
      setBody(payload.body || null)
      setConfirmAct(!!payload.confirmAct)
      setRelay(payload.relay ?? null)
      setFollowUpRunning(false)
      setPreview(payload.ok ? payload.preview ?? null : null)

      // revealPath present means main has a folder/file stashed for this card. A
      // stopped act keeps its run folder too — the agent may have written files
      // before the kill, so the user needs a way to go look at what landed.
      setCanReveal(!!((payload.ok || wasStopped) && payload.revealPath))

      let subText = payload.summary
      if (wasStopped && payload.revealPath) {
        subText += '  · click to reveal'
        setClickable(true)
      } else if (payload.ok && payload.revealPath) {
        subText += '  · click to reveal'
        setClickable(true)
      } else if (payload.ok && payload.hasConversation) {
        subText += '  · click to open'
        setClickable(true)
      } else if (!payload.ok) {
        setClickable(true) // clickable to dismiss easily on fail
      }
      setSubtitle(subText)
    })
  ])

  const handleCloseClick = (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    window.api.hudDismiss(runId)
  }

  // Hover controls on a live recording/listen card: Stop finalizes it (same as
  // pressing the capture hotkey again — transcribes/saves normally), Cancel
  // discards it (same as double-Esc, but the click itself is the confirmation
  // so there's no second step).
  const handleStopClick = (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    window.api.hudStopCapture(runId)
  }

  const handleCancelCaptureClick = (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    window.api.hudCancelCapture(runId)
  }

  // Stop on a live Ask/Act card — the LLM equivalent of the recording card's ■.
  // Kills only this card's CLI process group; main leaves the card up so it can
  // settle into its normal stopped state (partial work is kept, not discarded).
  const handleStopRunClick = (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    window.api.hudStopRun(runId)
  }

  const handleExpandClick = (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    window.api.transcriptOpen(runId)
  }

  const handleCardClick = (): void => {
    // Clicking anywhere on the card reveals its saved capture folder, opens the
    // Mighty conversation it belongs to (ask results), or just dismisses (fail) —
    // main decides which via handleHudClick. The Ask/Act buttons, Copy, and the
    // input each stopPropagation, so they don't trigger this — only the card's
    // "dead space" (icon, title, transcript) does.
    if (canReveal || clickable || hudState === 'fail') {
      window.api.hudReveal(runId)
    }
  }

  // One handler for every Ask/Act button on the card. The typed text (optional)
  // is the instruction. Once a conversation exists (body present), Ask CONTINUES
  // the thread (hudFollowUp); otherwise it's a fresh capture run (hudAction).
  const handleAction = (action: HudActionKind): void => {
    const typed = actionInput.trim()
    if (action === 'ask' && body) {
      // Continue the ask thread on this card.
      setActionInput('')
      setFollowUpRunning(true)
      window.api.hudFollowUp(runId, typed || 'Tell me more.')
      return
    }
    window.api.hudAction(runId, action, typed || undefined)
    setActionInput('')
  }

  // Confirm/Cancel a destructive act that's waiting on this card. Optimistically
  // flip to "Working…"/close the gate so the user gets instant feedback instead
  // of the buttons lingering while resolvePendingAct runs in main.
  const handleConfirmAct = (answer: 'confirm' | 'cancel'): void => {
    window.api.hudConfirmAct(runId, answer)
    setConfirmAct(false)
    if (answer === 'confirm') setFollowUpRunning(true)
  }

  // Answer a pending relay card (§6b). Optimistic close, same shape as
  // handleConfirmAct — first answer wins regardless of surface, so a stale
  // duplicate from another surface just no-ops in main and this card is
  // already gone by then (dismissRelayHud fires off the SAME store event).
  const handleRelayAnswer = (
    response: { answer?: string; approved?: boolean; note?: string; acked?: boolean },
    via: 'chip' | 'typed' | 'note'
  ): void => {
    if (!relay) return
    window.api.hudRelayAnswer({
      runId,
      requestId: relay.requestId,
      response,
      via,
      questionIndex: interview.isInterview ? interview.index : undefined,
      // Answering a question that already holds an answer can only be a change:
      // you had to step back onto it to be here.
      revise: interview.answered !== undefined
    })
    setViewIndex(null)
    // A multi-question ask stays PENDING between answers, so closing the card
    // here would strand the person on question 1 with nowhere to answer the
    // rest. Main re-raises it at the next question off the store's change feed;
    // for a single question that same feed dismisses it.
    setRelayAnswer('')
    if (!interview.isInterview) setRelay(null)
  }

  /** Send the whole set. A revision deliberately does NOT settle the request, so
   *  the last question's answer is re-sent without `revise` to end it. */
  const sendAllAnswers = (): void => {
    const last = relay?.questions ? relay.questions.length - 1 : -1
    const held = answerAt(relay?.buffered, last)
    if (!relay || last < 0 || held === undefined) return
    window.api.hudRelayAnswer({
      runId,
      requestId: relay.requestId,
      response: { answer: held },
      via: 'chip',
      questionIndex: last
    })
    setViewIndex(null)
  }

  const handleGoToOrigin = (e: React.MouseEvent): void => {
    e.stopPropagation()
    if (!relay) return
    window.api.hudGoToOrigin(relay.requestId)
  }

  // Record a 👍/👎 (+ optional note) for this run — same loop as the History
  // flyout. Optimistic: paint the rating immediately, then persist; reconcile
  // with the stored entry on resolve.
  const submitFeedback = (rating: FeedbackRating | null, note?: string): void => {
    setFeedbackRating(rating)
    setFeedbackNote(note ?? null)
    window.api.feedbackSubmit(runId, rating, note).then((entry) => {
      if (entry) {
        setFeedbackRating(entry.rating)
        setFeedbackNote(entry.note ?? null)
      }
    })
  }

  // Run a skill against this finished card. Main builds the attachment (capture
  // file or the serialized chat) and launches it, reusing this card's runId — the
  // card flips to "Working…" and shows the skill's result in place.
  const runSkill = (e: React.MouseEvent, actionKey: string): void => {
    e.stopPropagation()
    setFollowUpRunning(true)
    window.api.hudRunSkill(runId, actionKey)
  }

  // A capture card (screenshot / screen-recording / listen) has no AI answer to
  // rate — on hover it gets a NOTE-ONLY box instead of thumbs. Note is useful data
  // (why I grabbed this), so it's offered on every finished capture.
  const isCapture = mode === HUD_MODE.screenshot || mode === HUD_MODE.recording
  // A card is "interactive" (hover keeps it alive + reveals the hidden controls)
  // when it has buttons, a result body, a rateable AI result, OR is a finished
  // capture (→ note box). The rateable case lets a plain act/rewrite card reveal
  // its 👍/👎 on hover even with no buttons and no inline body.
  const canRate = feedbackEnabled && hudState === 'ok' && !!body
  const canNote = feedbackEnabled && hudState === 'ok' && isCapture
  // A finished card with skills to offer is interactive too — hovering reveals the
  // skills bar even on a capture card with feedback off and no body.
  const canRunSkills = hudState === 'ok' && skills.length > 0
  const interactive = actions.length > 0 || !!body || canRate || canNote || canRunSkills || confirmAct || !!relay

  // Hovering an interactive card resets its auto-dismiss timer so it won't
  // vanish while you're reading the answer or deciding which button to hit.
  // Also reveals the instruction input (hidden by default to stay compact).
  const handleMouseEnter = (e: React.MouseEvent): void => {
    if (interactive) {
      window.api.hudHover(runId)
      if (e.target === e.currentTarget || (e.target as Element).closest('.hud-route-btn')) return
      setActionInputOpen(true)
      // An ask-capable card reveals its follow-up input on hover. Make the window
      // focusable now (while the pointer is over it) so a click into the input can
      // actually focus it and accept typing — the card opened non-focusable so it
      // never stole focus on appear. Re-hidden on leave.
      if (actions.includes('ask') || relay?.verb === 'ask') window.api.hudSetFocusable(runId, true)
    }
  }

  // Leaving re-arms the auto-dismiss countdown that enter paused, so an ignored
  // card vanishes on its own instead of sticking forever after one hover. Re-hide
  // the instruction input unless the user typed something into it.
  const handleMouseLeave = (): void => {
    if (interactive) {
      window.api.hudLeave(runId)
      if (!actionInput.trim() && !relayAnswer.trim()) {
        setActionInputOpen(false)
        // Pointer left without typing → drop focusability so the card can't hold
        // focus. Keep it focusable if there's text in the input (user mid-thought).
        if (actions.includes('ask') || relay?.verb === 'ask') window.api.hudSetFocusable(runId, false)
      }
    }
  }

  return (
    // The controls straddle the card's top-right corner, so they can't live
    // inside .hud-container (overflow: hidden clips them). This shell carries the
    // gutter they hang into and is what the ResizeObserver measures.
    <div
      ref={cardRef}
      className="hud-shell"
      data-route-room={hasRouteRoom ? '' : undefined}
      style={{ '--hud-route-room': `${hasRouteRoom ? HUD_ROUTE_ROOM : 0}px` } as React.CSSProperties}
      onMouseEnter={handleMouseEnter}
      onMouseMove={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {/* Expand to the full run-transcript inspector. Only when the "Show run
          details" setting is on; hidden until hover (same reveal as dismiss). */}
      {runTranscript && runId && (
        <Button
          variant="icon"
          className="hud-expand"
          onClick={handleExpandClick}
          {...hoverProps(CONTROL_TIP.expand)}
        >
          <Maximize2 size={11} strokeWidth={2.25} />
        </Button>
      )}

      {/* Dismiss Button. Spells out that it only HIDES the card while a run is
          still in flight — the ambiguity that made × read like an abort. */}
      <Button
        variant="icon"
        className="hud-close"
        onClick={handleCloseClick}
        {...hoverProps(hudState === 'running' ? CONTROL_TIP.dismiss : CONTROL_TIP.dismissIdle)}
      >
        ×
      </Button>

      <div
        className={`hud-container ${hudState} ${(clickable && !interactive) || canReveal ? 'clickable' : ''} ${interactive ? 'interactive' : ''} ${capture === HUD_CAPTURE.smartListen && recording && hudState === 'running' ? 'hud-smart-morph' : ''}`}
        onClick={handleCardClick}
      >
      {/* Full-height fill that grows left-to-right across the card as the listen
          hotkey is held, reaching 100% width exactly as the tap/hold threshold
          fires. Absolutely positioned against .hud-container; sits behind
          hud-main (z-index 0 vs 1) so the waveform/text stay legible on top of
          it. This is the only hold-progress effect - no glow ring left behind
          once the fill completes. */}
      {capture !== HUD_CAPTURE.smartListen && holdProgress > 0 && (
        <div className="hud-hold-fill" style={{ width: `${Math.min(100, holdProgress * 100)}%` }} />
      )}

      {/* macOS-style capture preview — a screenshot thumbnail or a short looping
          clip of a recording. Only on a finished card (never mid-capture, where
          the waveform owns the space). Sits above the summary row. */}
      {preview && hudState === 'ok' && !recording && <PreviewMedia preview={preview} />}

      <div className="hud-main">
        {/* Live mic waveform while a recording is in flight — replaces the
            static icon/spinner with the layered orange wave animation. Falls
            back to the icon badge for screenshots, results, and stopped runs. */}
        {recording && hudState === 'running' && (!speechDriven || speaking) ? (
          <>
            {/* Screen-record only: 🖥 + pulsing 🔴 so the user knows the SCREEN is
                being captured, not just the mic. Listen shows waveform alone. */}
            {capture === HUD_CAPTURE.screen && (
              <div className="hud-screen-badge" title="Recording your screen">
                <span className="hud-screen-glyph">🖥</span>
                <span className="hud-rec-dot" />
              </div>
            )}
            {/* Smart dictation: a ✨ badge + a blue/violet waveform so it's obvious
                the AI will adapt the output to the screen, not just transcribe. */}
            {capture === HUD_CAPTURE.smartListen && (
              <div className="hud-smart-badge" title="Screen-aware dictation">
                <Sparkles size={14} strokeWidth={2.25} />
              </div>
            )}
            {/* Hands-free stays open across pauses, so its card is the only signal
                the mic is still live — without a badge it's identical to a plain
                one-shot listen and the user can't tell which mode they're in. */}
            {capture === HUD_CAPTURE.handsFree && (
              <div className="hud-handsfree-badge" title="Hands-free · tap the hotkey to stop">
                <Radio size={14} strokeWidth={2.25} />
              </div>
            )}
            {routeNext && (
              <div
                className="flex shrink-0 items-center text-accent-text"
                title={CONFIG.UI_LABELS.ROUTE_NEXT_TOOLTIP}
              >
                <Waypoints size={14} strokeWidth={2.25} />
              </div>
            )}
            {submitNext && (
              <div
                className="flex shrink-0 items-center text-accent-text"
                title={CONFIG.UI_LABELS.SUBMIT_NEXT_TOOLTIP}
              >
                <CornerDownLeft size={14} strokeWidth={2.25} />
              </div>
            )}
            <div className="hud-wave-slot">
              <WaveformViz
                accentRgb={
                  capture === HUD_CAPTURE.smartListen
                    ? CONFIG.THEME_TOKENS.accentSmartRgb
                    : undefined
                }
              />
              {/* Hover-only Stop/Cancel — mouse equivalent of the hotkey-again
                  (stop) and double-Esc (cancel) keyboard paths. Swaps in over the
                  waveform on card hover so either is one click away without
                  hunting for the tiny × in the corner. */}
              <div className="hud-wave-controls" onClick={(e) => e.stopPropagation()}>
                <Button
                  variant="icon"
                  className="hud-wave-btn hud-wave-stop"
                  onClick={handleStopClick}
                  {...hoverProps(CONTROL_TIP.stopCapture)}
                >
                  <Square size={12} strokeWidth={2.25} fill="currentColor" />
                </Button>
                <Button
                  variant="icon"
                  className="hud-wave-btn hud-wave-cancel"
                  onClick={handleCancelCaptureClick}
                  {...hoverProps(CONTROL_TIP.cancelCapture)}
                >
                  <X size={14} strokeWidth={2.25} />
                </Button>
              </div>
            </div>
            {/* Hands-free shows no clock: the session runs across many pauses, so
                its elapsed time measures nothing the user cares about. The wave
                alone says "I'm hearing you". */}
            {showTimer && !speechDriven && (
              <div className="hud-timer hud-timer-wave">{elapsed}</div>
            )}
          </>
        ) : (
          <>
            {/* Icon Badge. An idle hands-free card keeps its pulsing badge instead
                of the spinner: nothing is being processed, the mic is just open. */}
            {speechDriven && hudState === 'running' ? (
              <div className="hud-handsfree-badge" title="Hands-free · tap the hotkey to stop">
                <Radio size={14} strokeWidth={2.25} />
              </div>
            ) : (
              <div className="hud-icon-wrap">
                <span>{icon}</span>
                <div className="hud-spinner"></div>
              </div>
            )}

            {/* Status Details */}
            <div className="hud-text">
              <div className="hud-row1">
                <div className="hud-title">{title}</div>
                {/* Stop a live Ask/Act. Until this existed, a long run had NO abort
                    on the card — only the corner × , which just hides it while the
                    CLI keeps working. Hover-revealed like the recording controls so
                    a settled card stays clean. */}
                {hudState === 'running' && !recording && (
                  <Button
                    variant="icon"
                    className="hud-run-stop"
                    onClick={handleStopRunClick}
                    {...hoverProps(CONTROL_TIP.stopRun)}
                  >
                    <Square size={9} strokeWidth={2.5} fill="currentColor" />
                  </Button>
                )}
                {showTimer && !speechDriven && <div className="hud-timer">{elapsed}</div>}
                {transcribeMs !== null && (
                  <div className="hud-transcribe-time" {...hoverProps(CONTROL_TIP.transcribeTime)}>
                    <Zap size={9} strokeWidth={2.5} />
                    {formatTranscribeTime(transcribeMs)}
                  </div>
                )}
              </div>
              <div className="hud-subtitle">{subtitle}</div>
              {/* Who is asking. The title says what's wanted OF YOU ("Needs your
                  answer") and is identical for every agent, so with two sessions
                  open the card named neither. Same chip vocabulary as the Panel
                  and the phone sheet -- deliberately not a fourth wording. */}
              {relay && (
                <div className="hud-sender">
                  {relay.from ? (
                    <AgentFace
                      id={relay.faceId ?? relay.from}
                      size={AGENT_FACE_SIZE.chip}
                    />
                  ) : (
                    <span className="hud-sender-dot" data-unknown="" aria-hidden="true" />
                  )}
                  <span className="hud-sender-name">{relay.from ?? UNKNOWN_SENDER}</span>
                  {/* Only when it isn't just restating the repo the label already
                      names -- a worktree folder earns the space, a duplicate doesn't. */}
                  {hudSenderPath(relay) && (
                    <span className="hud-sender-path">{hudSenderPath(relay)}</span>
                  )}
                  {/* Same "Hard to undo" wording as the Panel's high-risk approve
                      (relay-card.tsx) -- this is the one card a glance can't afford
                      to misread. */}
                  {relayHighRisk(relay) && <span className="hud-risk-tag">Hard to undo</span>}
                  <RelayWaitingTime relay={relay} />
                </div>
              )}
              {/* ETA progress bar — only when the estimator gave us a target. Fills
                  toward the predicted finish, shimmers once it caps. Absent on a
                  cold-start run (etaMs 0), so first-ever runs look exactly as before. */}
              {showBar && (
                <div className={`hud-eta ${barOvertime ? 'hud-eta-overtime' : ''}`}>
                  <ProgressBar pct={barPct} height="h-1" />
                </div>
              )}
            </div>
          </>
        )}

        {/* Outside the waveform branch on purpose: a silent hands-free card
            renders the icon branch, so a hint nested in the wave would never
            show for the one mode that stays open across pauses. */}
        {cancelArmed && hudState === 'running' && recording && (
          <div className="hud-cancel-hint">
            Esc again
            <br />
            to cancel
          </div>
        )}
      </div>

      {/* Inline result body (scrollable; auto-scrolls to bottom on new answer) */}
      {body && (
        <div className="hud-body" ref={bodyRef}>
          {body}
        </div>
      )}

      {/* Unified action region. Hidden by default to keep the card compact —
          the whole group (Ask / Act, Copy, instruction input) reveals only on
          hover (actionInputOpen). Type something or leave it blank; the button
          you press decides what happens. On an answered card, Ask continues the
          thread. A run in flight always shows its "Working…" status. */}
      {followUpRunning ? (
        <div className="hud-followup-running">Working…</div>
      ) : relay ? (
        // Code agent relay card (PRD §6b): always visible, same reasoning as
        // confirmAct — a request an agent is BLOCKED on must not hide behind
        // a hover. High-risk approve shows Approve/Deny directly: the iOS
        // Face ID gate has no macOS counterpart, so an extra click here
        // guarded nothing on an already-unlocked Mac and only buried the
        // real buttons a step deeper than the Code sheet's.
        <div className="hud-action-group">
          {/* Above the verb blocks, not inside `show`'s: ask/approve carry a
              picture too, and the point is seeing it in the same glance as the
              question -- an image you never see is a decision made blind. */}
          {relay.imagePath && (
            <div className="hud-preview">
              <img src={window.api.mediaUrl(relay.imagePath)} alt={relay.caption ?? ''} />
            </div>
          )}
          {/* ask/approve only, by the shape of HudRelayCard -- see its `progress`
              field. The compact meter, same as every other surface: a bar here
              spent a full row of a card sized to be glanced at. */}
          {relay.progress !== undefined && (
            <div className="hud-progress">
              <ProgressMeter value={relay.progress} classes={MAC_METER_CLASSES} />
            </div>
          )}
          {relay.verb === 'ask' && (
            <>
              <RelayInterviewNav
                interview={interview}
                onGo={setViewIndex}
                classes={HUD_NAV_CLASSES}
              />
              {/* The subtitle carries question 1, so it normally needs no line of
                  its own -- EXCEPT when stepped back onto it, where the subtitle
                  is whatever question the card was last raised at. */}
              {askQuestion && (interview.step > 1 || viewIndex !== null) && (
                <div className="hud-body">{askQuestion}</div>
              )}
              {askDone && (
                <div className="hud-body">
                  {interview.blockedCopy ?? CONFIG.UI_LABELS.CODE_ASK_ALL_ANSWERED}
                </div>
              )}
              {!askDone && askOptions.length > 0 && (
                <div className="hud-actions hud-actions-stacked">
                  {askOptions.map((opt) => (
                    <Button
                      key={opt}
                      variant="ghost"
                      className="btn hud-action-btn"
                      data-picked={interview.answered === opt ? '' : undefined}
                      onClick={(e) => {
                        e.stopPropagation()
                        handleRelayAnswer({ answer: opt }, 'chip')
                      }}
                    >
                      {opt}
                    </Button>
                  ))}
                </div>
              )}
              {askDone && !interview.blockedCopy && (
                <div className="hud-actions">
                  <Button
                    variant="primary"
                    className="btn hud-action-btn hud-confirm-btn"
                    onClick={(e) => {
                      e.stopPropagation()
                      sendAllAnswers()
                    }}
                  >
                    {CONFIG.UI_LABELS.CODE_ASK_SEND_ALL}
                  </Button>
                </div>
              )}
              {!askDone && interview.canType && (
                <input
                  className="hud-action-input"
                  placeholder="Type an answer…"
                  value={relayAnswer}
                  onChange={(e) => setRelayAnswer(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && relayAnswer.trim()) {
                      handleRelayAnswer({ answer: relayAnswer.trim() }, 'typed')
                    }
                  }}
                />
              )}
            </>
          )}
          {relay.verb === 'approve' && (
            <>
              {relay.detail && <div className="hud-body">{relay.detail}</div>}
              <div className="hud-actions">
                <Button
                  variant="primary"
                  className="btn hud-action-btn hud-confirm-btn"
                  onClick={(e) => {
                    e.stopPropagation()
                    handleRelayAnswer({ approved: true, note: relayNote.trim() || undefined }, 'chip')
                  }}
                >
                  Approve
                </Button>
                <Button
                  variant="ghost"
                  className="btn hud-action-btn hud-cancel-btn"
                  onClick={(e) => {
                    e.stopPropagation()
                    handleRelayAnswer({ approved: false, note: relayNote.trim() || undefined }, 'chip')
                  }}
                >
                  Deny
                </Button>
              </div>
              <input
                className="hud-action-input"
                placeholder="Optional note…"
                value={relayNote}
                onChange={(e) => setRelayNote(e.target.value)}
                onClick={(e) => e.stopPropagation()}
              />
            </>
          )}
          {relay.verb === 'show' && (
            <>
              {relay.caption && <div className="hud-body">{relay.caption}</div>}
              {relay.waitForAck && (
                <Button
                  variant="primary"
                  className="btn hud-action-btn hud-confirm-btn"
                  onClick={(e) => {
                    e.stopPropagation()
                    handleRelayAnswer({ acked: true }, 'note')
                  }}
                >
                  Got it
                </Button>
              )}
            </>
          )}
          {canGoToOrigin && (
            <Button variant="ghost" className="btn hud-action-copy" onClick={handleGoToOrigin}>
              {relay.from ? `Go to ${relay.from}` : 'Go to the agent'}
            </Button>
          )}
        </div>
      ) : confirmAct ? (
        // Destructive-act gate: always visible (not hover-gated) — the user must
        // see this the instant the card renders, not discover it on hover. No
        // input row, no Copy — just the yes/no decision.
        <div className="hud-action-group hud-confirm-group">
          <div className="hud-actions">
            <Button
              variant="primary"
              className="btn hud-action-btn hud-confirm-btn"
              onClick={(e) => {
                e.stopPropagation()
                handleConfirmAct('confirm')
              }}
            >
              Confirm
            </Button>
            <Button
              variant="ghost"
              className="btn hud-action-btn hud-cancel-btn"
              onClick={(e) => {
                e.stopPropagation()
                handleConfirmAct('cancel')
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        (actions.length > 0 || body) &&
        actionInputOpen && (
          <div className="hud-action-group">
            <div className="hud-actions">
              {actions.map((a) => (
                <Button
                  key={a}
                  variant="ghost"
                  className="btn hud-action-btn"
                  onClick={(e) => {
                    e.stopPropagation()
                    handleAction(a)
                  }}
                >
                  {ACTION_LABEL[a]}
                </Button>
              ))}
              {body && (
                <span className="contents" onClick={(e) => e.stopPropagation()}>
                  <CopyButton label="Copy answer" text={body} />
                </span>
              )}
            </div>
            {actions.includes('ask') && actionInputOpen && (
              <input
                className="hud-action-input"
                placeholder={body ? 'Ask a follow-up…' : 'Optional: add a question or instruction…'}
                value={actionInput}
                onChange={(e) => setActionInput(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && actions.includes('ask')) handleAction('ask')
                }}
              />
            )}
          </div>
        )
      )}

      {/* What your words asked for, ready to run with one click. Its own
          subscription, so it appears on whatever card is up when the ranking
          lands rather than waiting for the next hud update. */}
      <div className="hud-actioncard" onClick={(e) => e.stopPropagation()}>
        <ActionsSection />
      </div>

      {/* Feedback on a finished run — reveals on hover (actionInputOpen) so the card
          stays compact, only on success. AI answers (ask/act/rewrite) get 👍/👎 +
          note; user-generated captures get a NOTE-ONLY box (no thumb — nothing AI
          to rate). stopPropagation so a click never triggers the card's
          reveal-folder handler. */}
      {feedbackEnabled && hudState === 'ok' && !followUpRunning && actionInputOpen && (canRate || canNote) && (
        <div className="hud-feedback" onClick={(e) => e.stopPropagation()}>
          <FeedbackRow
            rating={feedbackRating}
            note={feedbackNote}
            noteOnly={isCapture}
            onSubmit={submitFeedback}
          />
        </div>
      )}

      {/* Skills bar — the user's QuickActions, same as the main panel. Reveals on
          hover of a finished card. Clicking one runs that skill with this card as
          context: the capture file (capture card) or the full chat (AI card). */}
      {hudState === 'ok' && !followUpRunning && actionInputOpen && skills.length > 0 && (
        <div className="hud-skills" onClick={(e) => e.stopPropagation()}>
          {skills.map((s) => (
            <Button
              key={s.key}
              variant="ghost"
              className="hud-skill-chip"
              title={`${s.mode}: ${s.instruction || s.label}`}
              onClick={(e) => runSkill(e, s.key)}
            >
              {s.icon && <span className="hud-skill-icon">{s.icon}</span>}
              <span>{s.label}</span>
            </Button>
          ))}
        </div>
      )}

      </div>

      {(voiceRoute === 'idle' || voiceRoute === 'ranking') && (
        <Button
          variant="icon"
          className="hud-route-btn"
          aria-label="Action Route"
          disabled={voiceRoute === 'ranking'}
          onClick={(e) => {
            e.stopPropagation()
            setVoiceRoute('ranking')
            void window.api.voiceRouteFromHud(runId).then((shown) => {
              if (!shown) setVoiceRoute('gone')
            })
          }}
          {...hoverProps(
            voiceRoute === 'ranking'
              ? CONFIG.UI_LABELS.ROUTE_FINDING_TOOLTIP
              : CONFIG.UI_LABELS.ROUTE_TOOLTIP
          )}
        >
          {voiceRoute === 'ranking' ? (
            <span className="spinner" />
          ) : (
            <Waypoints size={12} strokeWidth={2.25} />
          )}
        </Button>
      )}

      {/* One floating tooltip for every control on this card (■ / ✕ / × / expand). */}
      <Tooltip tip={tip} />
    </div>
  )
}
