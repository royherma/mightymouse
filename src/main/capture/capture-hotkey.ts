// Unified global hotkey watcher (uiohook-based).
//
// macOS gotcha: when uiohook's event tap is active, Electron's Carbon-based
// globalShortcut stops receiving the same combos (two competing OS hook
// mechanisms). Since we already run uiohook for capture tap/hold, ALL global
// hotkeys go through it for one consistent input path:
//   Cmd+Opt+Shift+O  tap  (<150ms)  -> screenshot
//                    hold (>=150ms) -> start recording
//                    press (recording) -> stop recording
//   Cmd+Opt+Shift+;  -> rewrite/ask panel
//   Cmd+Opt+Shift+L  -> listen/transcribe toggle (audio-only -> clipboard)
//   Cmd+Opt+Shift+Space -> alias for listen/transcribe
//   Ctrl+Space           -> lighter 2-key alias for listen/transcribe
//   fn (globe)           -> 1-key alias for listen/transcribe (native tap, see
//                           macos/fn-watch.ts -- uiohook cannot see this key)
//   Cmd+Opt+Shift+H  -> open panel + auto-open history
//   Cmd+Opt+Shift+M  -> open the main panel (no capture)
//   Cmd+Opt+Shift+S  -> suggest a move now (manual suggestion bubble)
//   Esc (during a live capture)   -> arm cancel: reveal the "Esc again to cancel" hint
//   Esc again within 1.5s          -> discard the in-progress recording/listen
import { CONFIG } from '../../shared/config'
import { IS_DEV } from '../../shared/env'
import { getShortcut, VC } from '../../shared/shortcuts'
import { acquire, isAvailable, on, AnyEvent } from './uiohook-manager'
import {
  probeIntercept,
  probeWrongKey,
  probeObserveKey,
  isProbeArmed,
  isModifierKeycode
} from '../tour-hotkey-probe'
import { input, capabilities } from '../platform'
import { PREFS } from '../store/prefs'
import { isActiveCopy } from '../active-copy'

// Keycodes come from the shortcuts registry (the ONE source of truth) so the
// keys we register always match the cheat sheet. Only the two BARE discard keys
// (Esc/Enter) are local — they aren't chorded shortcuts, just live-capture
// controls, so they don't belong in the registry.
const VC_O = getShortcut('capture').key
const VC_SEMICOLON = getShortcut('rewrite').key
const VC_L = getShortcut('listen').key
const VC_M = getShortcut('main').key
const VC_CHAT = getShortcut('chat').key
const VC_S = getShortcut('suggest').key
const VC_K = getShortcut('navigator').key
const VC_STOP = getShortcut('stop').key
const VC_VOICE = getShortcut('voice').key
const VC_REPLY = getShortcut('reply').key
const VC_CANVAS = getShortcut('canvas').key
const VC_T = getShortcut('selectionBar').key
const VC_LISTEN_ALIASES = getShortcut('listen').aliases ?? [] // Space → listen
// Combo aliases use a DIFFERENT modifier set than BASE_MODS (e.g. Ctrl+Space →
// listen), so they're matched before the hasMods (Cmd+Opt+Shift) gate.
const LISTEN_COMBO_ALIASES = getShortcut('listen').comboAliases ?? []
const VC_ESCAPE = 1 // bare Esc — arms cancel (reveals the hint) on a live capture
const VC_ENTER = 28 // bare Enter — submits a listen / confirms an armed suggestion cancel
// Suggestion-accept chords: ⌘⌥⇧1/2/3 → run suggestion 0/1/2. Same modifier set
// (BASE_MODS) as every other shortcut, so the accept keys speak the app's one
// hotkey language instead of a bespoke Cmd-only chord.
const SUGGESTION_CHORDS: Record<number, number> = {
  [VC.ONE]: 0,
  [VC.TWO]: 1,
  [VC.THREE]: 2
}

export interface Handlers {
  onTap: () => void
  onHoldStart: () => void
  onPressWhileRecording: () => void
  isRecording: () => boolean
  onRewrite: () => void
  onListen: () => void
  /** True while a listen session (plain, not yet smart) is already running.
   *  Lets keydown tell "fresh press → toggle-start" apart from "key pressed
   *  again mid-session → arm the smart-upgrade hold instead of toggling off". */
  isListenSessionActive: () => boolean
  /** Two listen presses inside CONFIG.LISTEN_DOUBLE_TAP_MS → hands-free dictation.
   *  Detected HERE and not in the handler, because keydown only calls onListen()
   *  when no session is running — tap 2 lands on tap 1's session and would never
   *  reach a detector living downstream of that gate. */
  onListenDoubleTap: () => void
  /** Listen key HELD past the tap/hold threshold → upgrade the current listen
   *  session to screen-aware "smart dictation". Fires once per hold. */
  onListenHoldSmart: () => void
  /** Ticks while the listen key is physically held, before the threshold fires —
   *  pct is 0..1 progress toward CONFIG.LISTEN_SMART_HOLD_MS. Drives the HUD's
   *  intensifying hold-glow so the user can see the hold registering in real time. */
  onListenHoldProgress: (pct: number) => void
  onListenRouteNow: () => void
  /** Enter held before fn, or tapped during the recording → press Return once the
   *  transcript has been delivered, so a dictated prompt sends itself. */
  onListenSubmitNow: () => void
  /** True while an Enter can still arm the submit — through transcription, which
   *  outlives isCapturing() (the mic is already closed by then). */
  canSubmitListen: () => boolean
  onMain: () => void
  onChat: () => void
  onSuggest: () => void
  onStop: () => void
  onToggleSelectionBar: () => void
  onNavigator: () => void
  onToggleVoice: () => void
  onReply: () => void
  onCanvas: () => void
  onArmCancel: () => void
  isCapturing: () => boolean
}

let holdTimer: NodeJS.Timeout | null = null
let holdFired = false
// Separate hold timing for the LISTEN key: holding it past LISTEN_SMART_HOLD_MS upgrades
// the session to smart dictation. Independent of the capture key's holdTimer so
// the two never interfere. `listenKeyDown` tracks the PHYSICAL key state so we can
// tell a genuine fresh press (arm the timer) from uiohook key-repeat (ignore) —
// without it, a stuck `holdFired` from a prior press kills every future hold.
let listenHoldTimer: NodeJS.Timeout | null = null
let listenKeyDown = false
let shiftHeld = false
let altHeld = false
let altRouteTap = false
// Physical, not e.metaKey: that flag lags one event behind the modifier's own
// keydown (see VC in shortcuts.ts), which showed the badges a key late and left
// them up a key after release.
let metaHeld = false
let chordModsShown = false
let enterHeld = false
let listenReleaseGrace: NodeJS.Timeout | null = null
let listenHoldProgressTimer: NodeJS.Timeout | null = null
let listenHoldStartedAt = 0
// True when the CURRENT keydown started a new session (so h.onListen() already
// fired on press and a release before the hold threshold should do nothing —
// the session should keep running). False when this press landed on top of an
// already-running plain session, meaning a release before the threshold is a
// genuine "tap again to stop" and must call h.onListen() (toggle-off) on keyup.
let listenTogglePending = false
// Timestamp of the last real listen keydown (repeats excluded), for double-tap
// detection. Press-to-press, so a long first tap still counts.
let listenLastPressAt = 0
// Timestamp of the keyup currently sitting in the release-grace window. A blip's
// re-press follows its keyup almost immediately; a human lifting and pressing
// again cannot. That gap is the only thing telling the two apart.
let listenReleaseAt = 0

// Double-tap a bare Shift → toggle listen. Hidden pref, no Settings row.
let shiftListenOn = false
let shiftTapDownAt = 0
let shiftTapClean = false
let lastShiftTapAt = 0
const SHIFT_TAP_MAX_HOLD_MS = 250

function isShiftKey(keycode: number): boolean {
  return keycode === VC.SHIFT_L || keycode === VC.SHIFT_R
}

function isAltKey(keycode: number): boolean {
  return keycode === VC.ALT_L || keycode === VC.ALT_R
}

// Must run before shiftHeld is set: a held Shift repeats keydown.
function trackShiftTapDown(e: AnyEvent): void {
  if (!isShiftKey(e.keycode)) {
    shiftTapClean = false
    lastShiftTapAt = 0
    return
  }
  if (shiftHeld) return
  shiftTapDownAt = Date.now()
  shiftTapClean = !(e.metaKey || e.altKey || e.ctrlKey)
}

function trackShiftTapUp(h: Handlers): void {
  const now = Date.now()
  const wasTap = shiftTapClean && now - shiftTapDownAt < SHIFT_TAP_MAX_HOLD_MS
  shiftTapClean = false
  if (!wasTap) {
    lastShiftTapAt = 0
    return
  }
  if (lastShiftTapAt === 0 || now - lastShiftTapAt >= CONFIG.LISTEN_DOUBLE_TAP_MS) {
    lastShiftTapAt = now
    return
  }
  lastShiftTapAt = 0
  if (probeIntercept('listen')) return
  h.onListen()
}

function isDoubleTapPress(): boolean {
  return (
    listenLastPressAt !== 0 && Date.now() - listenLastPressAt < CONFIG.LISTEN_DOUBLE_TAP_MS
  )
}

// Is the press arriving right now the tail of a hardware blip, rather than a
// human's second tap? Measured RELEASE-to-press: a blip's keyup and re-keydown
// are the same physical hold, microseconds apart, while lifting a finger and
// pressing again costs a person far longer than LISTEN_BLIP_REPRESS_MS.
//
// Press-to-press (isDoubleTapPress) CANNOT answer this: a blip re-press is ~60ms
// after the original press, always inside the 400ms double-tap window, so every
// blip read as a double-tap and killed the hold.
function isBlipRepress(): boolean {
  return listenReleaseAt !== 0 && Date.now() - listenReleaseAt < LISTEN_BLIP_REPRESS_MS
}

// Tap 1 armed a smart-upgrade hold that tap 2 has just overruled. Left running,
// it would fire onListenHoldSmart() ~1s into the hands-free session.
function clearListenHoldTimers(): void {
  if (listenHoldTimer !== null) {
    clearTimeout(listenHoldTimer)
    listenHoldTimer = null
  }
  if (listenHoldProgressTimer !== null) {
    clearInterval(listenHoldProgressTimer)
    listenHoldProgressTimer = null
  }
}
// Tick cadence for the hold-progress glow. Fast enough to read as continuous,
// cheap enough not to matter (a handful of callbacks over a 150ms window).
const LISTEN_HOLD_PROGRESS_TICK_MS = 16
// macOS/uiohook occasionally deliver a spurious keyup+keydown blip in the
// middle of a genuinely continuous physical hold (key-repeat racing the
// global event tap). A real release is debounced by this grace window before
// it's trusted — if a fresh keydown for the same key lands inside the
// window, the "release" is treated as noise and the hold keeps going.
const LISTEN_RELEASE_GRACE_MS = 60
// Release-to-press gap under which a re-press is hardware noise, not intent. A
// blip's two edges are effectively simultaneous; the fastest human double-tap
// still leaves ~100ms+ between lifting and pressing again.
const LISTEN_BLIP_REPRESS_MS = 40

// ── The listen gesture machine ──────────────────────────────────────────────
//
// TWO input sources drive these two functions: the uiohook ⌘⌥⇧L chord (plus its
// Space / Ctrl+Space aliases) and the fn key, which arrives from a native CGEvent
// tap because uiohook cannot see it at all (src/main/platform/macos/fn-watch.ts).
//
// They share ONE state machine on purpose. A second copy for fn would drift from
// this one the first time either double-tap or long-press is touched, and the
// gestures would silently diverge per key. Sharing also makes a mixed press/release
// (⌘⌥⇧L down, fn up) coherent rather than a wedged hold.

/** A listen key went DOWN — from any source. Tap starts/stops, double-tap goes
 *  hands-free, and holding past the threshold upgrades to smart dictation.
 *
 *  Exported for tests ONLY. Every real caller is in this file: reaching it any
 *  other way skips the source gating above it (probeIntercept, the fn pref). */
export function handleListenPress(h: Handlers): void {
  // A press landing inside the release-grace window is one of two things, and
  // they are told apart by how long ago the RELEASE was, not the last press: a
  // blip re-presses within LISTEN_BLIP_REPRESS_MS (swallow it, keep the hold
  // alive, don't toggle or re-arm), while a human's fast second tap takes longer
  // and falls through to the double-tap check below.
  if (listenReleaseGrace !== null) {
    clearTimeout(listenReleaseGrace)
    listenReleaseGrace = null
    if (isBlipRepress()) return
    listenKeyDown = false
  }
  // uiohook fires keydown REPEATEDLY while the key is physically held. Only the
  // FIRST press (key was up) is real. Every repeat after that is ignored via
  // listenKeyDown, so a prior press's state can never wedge a future hold.
  if (listenKeyDown) return
  listenKeyDown = true
  // Double-tap → hands-free, decided before anything else this press does. The
  // window is measured press-to-press, so it's unaffected by how long tap 1 was
  // held. Zeroed after firing so a third tap starts fresh rather than re-arming
  // off tap 2.
  if (CONFIG.LISTEN_DOUBLE_TAP_HANDS_FREE && isDoubleTapPress()) {
    listenLastPressAt = 0
    listenTogglePending = false
    clearListenHoldTimers()
    h.onListenDoubleTap()
    return
  }
  listenLastPressAt = Date.now()
  // A plain session is ALREADY running (this press is a re-press mid-session, not
  // the press that started it) → don't toggle it off yet. Arm the hold timer only;
  // the matching release decides tap-to-stop vs the hold having already upgraded
  // it. Otherwise (no session live) this press starts one.
  listenTogglePending = !h.isListenSessionActive()
  if (listenTogglePending) h.onListen()
  listenHoldStartedAt = Date.now()
  h.onListenHoldProgress(0)
  listenHoldProgressTimer = setInterval(() => {
    const pct = Math.min(1, (Date.now() - listenHoldStartedAt) / CONFIG.LISTEN_SMART_HOLD_MS)
    h.onListenHoldProgress(pct)
    if (pct >= 1 && listenHoldProgressTimer !== null) {
      clearInterval(listenHoldProgressTimer)
      listenHoldProgressTimer = null
    }
  }, LISTEN_HOLD_PROGRESS_TICK_MS)
  listenHoldTimer = setTimeout(() => {
    listenHoldTimer = null
    h.onListenHoldSmart()
  }, CONFIG.LISTEN_SMART_HOLD_MS)
}

/** A listen key came UP — from any source. Released before the threshold = it was
 *  a tap; released after = the smart upgrade already fired and this just clears.
 *  Exported for tests only — see handleListenPress. */
export function handleListenRelease(h: Handlers): void {
  // Don't trust this release immediately — uiohook can deliver a spurious keyup
  // mid-hold. Wait LISTEN_RELEASE_GRACE_MS: if a fresh press arrives in that
  // window, handleListenPress swallows it as noise and the hold continues
  // untouched. Only if nothing follows do we treat this as a genuine release.
  if (listenReleaseGrace !== null) clearTimeout(listenReleaseGrace)
  listenReleaseAt = Date.now()
  listenReleaseGrace = setTimeout(() => {
    listenReleaseGrace = null
    listenReleaseAt = 0
    listenKeyDown = false
    const releasedBeforeThreshold = listenHoldTimer !== null
    if (listenHoldTimer !== null) {
      clearTimeout(listenHoldTimer)
      listenHoldTimer = null
    }
    if (listenHoldProgressTimer !== null) {
      clearInterval(listenHoldProgressTimer)
      listenHoldProgressTimer = null
    }
    h.onListenHoldProgress(0)
    // Re-press mid-session, released before it reached the smart-upgrade
    // threshold: this was a deliberate second tap to stop, so toggle now.
    if (releasedBeforeThreshold && !listenTogglePending) h.onListen()
  }, LISTEN_RELEASE_GRACE_MS)
}
let started = false
let release: (() => void) | null = null
const unsubs: Array<() => void> = []

function hasMods(e: AnyEvent): boolean {
  return e.metaKey && e.altKey && e.shiftKey
}

// Exact modifier match for combo aliases that use a non-BASE_MODS set (e.g.
// Ctrl+Space). Every modifier must match precisely so Ctrl+Space doesn't also
// fire under Cmd+Ctrl+Space, and the BASE_MODS shortcuts stay unaffected.
function matchesComboAlias(
  e: AnyEvent,
  alias: { mods: { meta: boolean; alt: boolean; shift: boolean; ctrl?: boolean }; key: number }
): boolean {
  return (
    e.keycode === alias.key &&
    e.metaKey === alias.mods.meta &&
    e.altKey === alias.mods.alt &&
    e.shiftKey === alias.mods.shift &&
    e.ctrlKey === !!alias.mods.ctrl
  )
}

// Only on a change: this runs on every modifier keydown, and uiohook repeats
// those while a key is held.
function syncChordMods(): void {
  // ⌘ alone is enough to SHOW the numbers: the badges are only a label, so a
  // one-finger hold costs nothing. Running still needs all three — uiohook
  // cannot swallow a key, so a bare ⌘1 would switch the front app's tab too.
  const held = metaHeld
  if (held === chordModsShown) return
  chordModsShown = held
  void import('../voice-route-window')
    .then((win) => win.sendActionChordMods(held))
    .catch((err) => console.error('chord mods sync failed:', err))
}

function handleSuggestionChord(index: number): void {
  // An action card on screen owns these keys: it is the thing the user is
  // looking at, and a suggestion bubble behind it is not what they meant.
  void import('../actions/engine')
    .then(async (engine) => {
      const pick = engine.liveProposalAt(index)
      if (pick) {
        const { runAndTrack } = await import('../ipc/actions')
        runAndTrack(pick)
        return
      }
      // Avoid importing the insights/window stack from pure backend prompt tests
      // via platform permission probes; only needed at keypress time.
      const manager = await import('../insights/insights-manager')
      if (manager.hasActiveBubble()) manager.acceptActiveSuggestion(index)
    })
    .catch((err) => console.error('suggestion chord failed:', err))
}

// Bare Esc ARMS the cancel hint on a live suggestion bubble (HUD-style two-step);
// Enter then confirms. Returns whether it consumed the key (a bubble was up) so
// the caller can skip the capture-cancel Esc path.
async function tryArmSuggestionCancel(): Promise<boolean> {
  try {
    const manager = await import('../insights/insights-manager')
    return manager.armBubbleCancel()
  } catch (err) {
    console.error('suggestion cancel-arm failed:', err)
    return false
  }
}

// Bare Enter confirms an armed cancel: dismiss the live bubble (or soft-cancel a
// loading one). No-op when no bubble is up.
async function tryConfirmSuggestionCancel(): Promise<boolean> {
  try {
    const manager = await import('../insights/insights-manager')
    if (!manager.isBubbleVisible()) return false
    manager.dismissActiveBubble()
    return true
  } catch (err) {
    console.error('suggestion cancel-confirm failed:', err)
    return false
  }
}

// The Send-to card is non-focusable, so this global Esc is its only keyboard way out.
async function dismissOpenRouteCard(): Promise<boolean> {
  try {
    const { voiceRouteRunId, voiceRouteSearchActive } = await import('../voice-route-window')
    const runId = voiceRouteRunId()
    if (runId === '') return false
    if (voiceRouteSearchActive()) return true
    const { dismissVoiceRoute } = await import('../ipc/voice-routing')
    dismissVoiceRoute(runId)
    return true
  } catch (err) {
    console.error('route card esc-dismiss failed:', err)
    return false
  }
}

async function sendSuggestedRouteCard(): Promise<boolean> {
  try {
    const { sendSuggestedRoute } = await import('../ipc/voice-routing')
    return sendSuggestedRoute()
  } catch (err) {
    console.error('route card enter-send failed:', err)
    return false
  }
}

export function isCaptureHotkeyAvailable(): boolean {
  return isAvailable()
}

export function startCaptureHotkey(h: Handlers): boolean {
  if (!isAvailable() || started) return false

  unsubs.push(
    on('keydown', (e) => {
      if (!isActiveCopy()) return
      // Tour probe: live modifier held-state on EVERY key transition (down AND
      // up, see the matching call in keyup). Physical tracking inside the probe
      // corrects uiohook's lagging flag bits — without the keyup call, released
      // modifiers never dim, and without physical tracking the last-pressed
      // modifier never lights (its own keydown carries a stale flag).
      probeObserveKey(e.keycode, { meta: e.metaKey, alt: e.altKey, shift: e.shiftKey }, true)
      if (shiftListenOn) trackShiftTapDown(e)
      if (!isAltKey(e.keycode)) altRouteTap = false

      // Double-Esc discard for a live capture, a BARE key (no chord) so it's
      // checked before the hasMods gate. First Esc arms + reveals the hint; a
      // second within 1.5s confirms. Gated on isCapturing so it no-ops otherwise.
      // NOTE: uiohook can't swallow these, so they still reach the focused app —
      // fine during a listen, where the user is talking not typing.
      // Bare Esc with NO live capture: ARM the suggestion-bubble cancel (reveals
      // the "⏎ to cancel" hint). Async import, fire-and-forget — no-ops when no
      // bubble is up. During a live capture, fall through to capture-cancel below.
      if (e.keycode === VC_ESCAPE && !hasMods(e) && !h.isCapturing()) {
        void dismissOpenRouteCard().then((dismissed) => {
          if (!dismissed) void tryArmSuggestionCancel()
        })
        return
      }
      // Bare Enter with NO live capture: confirm an armed suggestion-bubble cancel.
      // A listen that is still transcribing gets first claim — the mic is closed
      // (so isCapturing is already false) but the words have not landed yet, and
      // that is the moment the user presses Enter to send what they just said.
      if (e.keycode === VC_ENTER && !hasMods(e) && !h.isCapturing()) {
        enterHeld = true
        if (h.canSubmitListen()) {
          h.onListenSubmitNow()
          return
        }
        void sendSuggestedRouteCard().then((sent) => {
          if (!sent) void tryConfirmSuggestionCancel()
        })
        return
      }
      if (e.keycode === VC_ESCAPE && !hasMods(e) && h.isCapturing()) {
        h.onArmCancel()
        return
      }
      // Enter during a capture marks the run for submit; it never cancels.
      if (e.keycode === VC_ENTER && !hasMods(e) && h.isCapturing()) {
        enterHeld = true
        h.onListenSubmitNow()
        return
      }

      if (e.keycode === VC_ENTER && !hasMods(e)) {
        enterHeld = true
        return
      }

      // Option, not a letter: uiohook cannot swallow keys, so a letter would be typed.
      const altWasHeld = altHeld
      if (e.keycode === VC.META_L || e.keycode === VC.META_R) metaHeld = true
      if (e.keycode === VC.SHIFT_L || e.keycode === VC.SHIFT_R) shiftHeld = true
      if (isAltKey(e.keycode)) altHeld = true
      syncChordMods()

      if (isShiftKey(e.keycode)) return
      if (isAltKey(e.keycode)) {
        if (listenKeyDown) h.onListenRouteNow()
        else if (!altWasHeld && !metaHeld && !shiftHeld && !e.ctrlKey) altRouteTap = true
        return
      }

      // Combo aliases use a non-BASE_MODS modifier set (e.g. Ctrl+Space → listen),
      // so they're matched here, BEFORE the Cmd+Opt+Shift gate below. Tour §7.2:
      // Ctrl+Space counts as a confirmed press on the listen step too.
      if (LISTEN_COMBO_ALIASES.some((a) => matchesComboAlias(e, a))) {
        if (probeIntercept('listen')) return
        h.onListen()
        return
      }

      // Bare ⌘K on the Send-to card opens its search. Leaks to the front app too: uiohook cannot swallow.
      if (e.keycode === VC.K && e.metaKey && !e.altKey && !e.shiftKey && !e.ctrlKey && !h.isCapturing()) {
        void import('../voice-route-window')
          .then((win) => win.openVoiceRouteSearch())
          .catch((err) => console.error('route card search open failed:', err))
        return
      }

      if (e.keycode === VC.E && e.metaKey && !e.altKey && !e.shiftKey && !e.ctrlKey && !h.isCapturing()) {
        void import('../ipc/voice-routing')
          .then((routing) => routing.enhanceSuggestedRoute())
          .catch((err) => console.error('route card enhance failed:', err))
        return
      }

      if (!hasMods(e)) return

      // While armed, ANY other Cmd+Opt+Shift chord (H/S/J/D/K/;/digits — every
      // branch below except the armed step's own key) is a wrong-key press, not
      // a real dispatch: consume it here so e.g. ⌘⌥⇧S never fires a suggestion
      // bubble mid-tour. The armed step's OWN key still falls through to its
      // real branch below, where that branch's own probeIntercept call catches it.
      if (
        isProbeArmed() &&
        // A modifier's OWN keydown lands here: on ⇧'s press hasMods is already
        // true, so ⌘⌥⇧ alone counted as a wrong key and shook the caps before
        // the user had pressed any letter.
        !isModifierKeycode(e.keycode) &&
        e.keycode !== VC_M &&
        e.keycode !== VC_O &&
        e.keycode !== VC_L &&
        !VC_LISTEN_ALIASES.includes(e.keycode)
      ) {
        probeWrongKey()
        return
      }

      // Suggestion-accept chords (⌘⌥⇧1/2/3) — same modifier set as every other
      // shortcut. Only arms while a bubble is actually live (handleSuggestionChord
      // guards on hasActiveBubble).
      const chordIndex = SUGGESTION_CHORDS[e.keycode]
      if (chordIndex !== undefined) {
        handleSuggestionChord(chordIndex)
        return
      }

      // Capture key: arm tap/hold timing or stop an in-progress recording.
      // Probe check comes BEFORE the hold timer arms (design mandated-simplification
      // bullet) — a real tour press must never start an actual recording.
      if (e.keycode === VC_O) {
        if (probeIntercept('capture')) return
        if (holdTimer !== null || holdFired) return // ignore key-repeat
        if (h.isRecording()) {
          h.onPressWhileRecording()
          return
        }
        holdFired = false
        holdTimer = setTimeout(() => {
          holdTimer = null
          holdFired = true
          h.onHoldStart()
        }, CONFIG.TAP_HOLD_MS)
        return
      }

      // Rewrite fires on keydown.
      if (e.keycode === VC_SEMICOLON) {
        h.onRewrite()
        return
      }
      // Listen/transcribe: TAP toggles start/stop (handler decides). HOLD past
      // LISTEN_SMART_HOLD_MS upgrades the session to smart dictation. We fire onListen()
      // immediately on keydown so a tap stays instant (zero lag), then arm a hold
      // timer — if the key is still down past the threshold, upgrade to smart.
      // Aliases (e.g. Space) behave identically.
      if (e.keycode === VC_L || VC_LISTEN_ALIASES.includes(e.keycode)) {
        handleListenPress(h)
        return
      }
      // Main: open the MightyMouse panel (no capture).
      if (e.keycode === VC_M) {
        if (probeIntercept('main')) return
        h.onMain()
        return
      }
      // Chat: open the full Mighty chat window (the roomy composer).
      if (e.keycode === VC_CHAT) {
        h.onChat()
        return
      }
      // Suggest: fire a fresh suggestion bubble on demand for the current context.
      if (e.keycode === VC_S) {
        h.onSuggest()
        return
      }
      // Stop: kill any in-flight act run NOW (the user's panic button).
      if (e.keycode === VC_STOP) {
        h.onStop()
        return
      }
      // Navigator: the find-anything overlay. Toggles, so the same chord closes it.
      if (e.keycode === VC_K) {
        h.onNavigator()
        return
      }
      if (e.keycode === VC_VOICE) {
        h.onToggleVoice()
        return
      }
      if (IS_DEV && e.keycode === VC_REPLY) {
        h.onReply()
        return
      }
      if (e.keycode === VC_CANVAS) {
        h.onCanvas()
        return
      }
      // Selection bar: summon the bar at the cursor (press again to dismiss).
      if (e.keycode === VC_T) {
        console.log('[selection-bar] hotkey VC_T dispatched')
        h.onToggleSelectionBar()
        return
      }
    })
  )

  unsubs.push(
    on('keyup', (e) => {
      if (!isActiveCopy()) return
      // Tour probe: modifier releases must dim the held caps — see keydown twin.
      probeObserveKey(e.keycode, { meta: e.metaKey, alt: e.altKey, shift: e.shiftKey }, false)
      if (shiftListenOn && isShiftKey(e.keycode)) trackShiftTapUp(h)
      if (isAltKey(e.keycode) && altRouteTap) {
        altRouteTap = false
        h.onListenRouteNow()
      }
      if (e.keycode === VC.SHIFT_L || e.keycode === VC.SHIFT_R) shiftHeld = false
      if (isAltKey(e.keycode)) altHeld = false
      if (e.keycode === VC.META_L || e.keycode === VC.META_R) metaHeld = false
      syncChordMods()
      if (e.keycode === VC_ENTER) enterHeld = false

      // Listen key release: cancel the smart-upgrade hold timer. Released before
      // the threshold = it was a tap — if this press had toggled a session on,
      // leave it running; if this press was a re-press mid-session (toggle was
      // deferred), it's a genuine "tap again to stop", so fire the toggle now.
      // Released after the threshold = the upgrade already fired; just clear state.
      if (e.keycode === VC_L || VC_LISTEN_ALIASES.includes(e.keycode)) {
        handleListenRelease(h)
        return
      }

      if (e.keycode !== VC_O) return
      if (holdTimer !== null) {
        // Released before hold threshold — it was a tap
        clearTimeout(holdTimer)
        holdTimer = null
        holdFired = false
        h.onTap()
        return
      }
      // If holdFired, recording is now active; release does nothing here —
      // the next keydown while recording will call onPressWhileRecording.
      holdFired = false
    })
  )

  // fn (globe) as a listen alias. Separate source from uiohook -- it rides a native
  // CGEvent tap, since uiohook cannot see this key -- but it drives the SAME gesture
  // machine, so tap / double-tap / long-press all behave identically to ⌘⌥⇧L.
  liveHandlers = h
  if (PREFS.getFnListenEnabled()) startFnListen(h)
  shiftListenOn = PREFS.getShiftListenEnabled()

  release = acquire()
  started = true
  return true
}

export function stopCaptureHotkey(): void {
  unsubs.forEach((u) => u())
  unsubs.length = 0
  stopFnListen()
  liveHandlers = null
  if (release) release()
  release = null
  started = false
  if (listenHoldTimer !== null) {
    clearTimeout(listenHoldTimer)
    listenHoldTimer = null
  }
  if (listenReleaseGrace !== null) {
    clearTimeout(listenReleaseGrace)
    listenReleaseGrace = null
  }
  if (listenHoldProgressTimer !== null) {
    clearInterval(listenHoldProgressTimer)
    listenHoldProgressTimer = null
  }
  listenKeyDown = false
}

// ── fn key wiring ───────────────────────────────────────────────────────────
//
// Held separately from `unsubs` (the uiohook listener list) because the fn source
// is toggleable at runtime: flipping the setting off must tear down the native
// watcher WITHOUT disturbing any uiohook subscription.
let fnUnsub: (() => void) | null = null
/** Handlers from the live session, so the Settings toggle can start the fn watcher
 *  later without the IPC layer having to carry them across. Cleared on stop. */
let liveHandlers: Handlers | null = null

function startFnListen(h: Handlers): void {
  // No fn key to watch off macOS, and the platform stub throws rather than
  // no-op'ing — an unguarded call crashed every Windows launch (v0.41.0).
  if (!capabilities.fnKey) return
  if (fnUnsub) return
  fnUnsub = input.onFnEdge((down) => {
    if (!isActiveCopy()) return
    if (down) {
      // Tour parity with the ⌘⌥⇧L path: a real fn press must count as the listen
      // step's press, and must not start an actual session while the probe is armed.
      if (probeIntercept('listen')) return
      handleListenPress(h)
      if (altHeld) h.onListenRouteNow()
      if (enterHeld) h.onListenSubmitNow()
      return
    }
    handleListenRelease(h)
  })
}

function stopFnListen(): void {
  if (!capabilities.fnKey) return
  if (fnUnsub) {
    fnUnsub()
    fnUnsub = null
  }
  input.stopFnWatch()
}

/** Turn the fn-as-listen alias on/off while the app is running, so the Settings
 *  toggle takes effect immediately instead of at the next restart. Handlers come
 *  from the live capture-hotkey session, so this no-ops if that isn't started. */
export function setFnListenEnabled(on: boolean): void {
  if (on) {
    if (liveHandlers) startFnListen(liveHandlers)
    return
  }
  stopFnListen()
}

/** Reset the listen gesture machine's module state. Tests only — the real reset
 *  is stopCaptureHotkey(), which also tears down subscriptions a test never made. */
export function __resetListenStateForTests(): void {
  clearListenHoldTimers()
  if (listenReleaseGrace !== null) {
    clearTimeout(listenReleaseGrace)
    listenReleaseGrace = null
  }
  listenKeyDown = false
  listenLastPressAt = 0
  listenReleaseAt = 0
  listenTogglePending = false
  listenHoldStartedAt = 0
}
