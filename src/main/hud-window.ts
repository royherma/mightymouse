import { BrowserWindow, screen, shell } from 'electron'
import { statSync } from 'fs'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { CHANNELS } from '../shared/ipc'
import { HUD_MODE, HUD_CAPTURE, HUD_ROUTE_ROOM } from '../shared/types'
import type {
  HudInitPayload,
  HudMode,
  HudCapture,
  HudActionKind,
  HudDonePayload,
  HudUpdatePayload,
  HudPreview,
  HudRelayCard
} from '../shared/types'
import { markTest } from '../shared/relay-cards'
import { interviewView } from '../shared/relay-interview'
import { PREFS } from './store/prefs'
import { HISTORY } from './store/history'
import { playSound } from './sound-window'
import { isPhoneRun, sendToPhone } from './phone-remote/server'
import { showMightyWindow } from './mighty/mighty-window'
import { relayRequestStore, type RelayRequest } from './agent-relay/store'
import { resolveOrigin, isOriginResolvable } from './agent-relay/origin-resolver'
import { liveAgentSessions } from './agent-relay/mcp/http-listener'
import { senderFaceId } from '../shared/agent-face'
import { yieldIfLastRestorable, yieldToForeignApp } from './panel-window'

interface HudCard {
  window: BrowserWindow
  runId: string
  startedAt: number
  mode: HudMode
  /** Sub-kind this card was raised with (listen/screen/smartListen). Lets
   *  handleHudClick tell a smart-dictation card apart from a plain capture, so a
   *  click on the RESULT opens the conversation to continue it instead of always
   *  revealing the recording's folder in Finder. */
  capture: HudCapture
  /** True while this card is a LIVE mic recording. Set from mode on start, then
   *  cleared when a button-initiated Ask/Act run reuses the card (runningHud) —
   *  that run is an LLM call, so it must not show the waveform or the stop sound.
   *  Kept separate from `mode` so the capture type stays honest. */
  recording: boolean
  routeRoom?: boolean
  revealPath?: string | null
  /** The Mighty session this card's result belongs to, once done() resolves it —
   *  see DoneOpts.sessionId. Lets a click on a finished ask card open the real
   *  conversation instead of just revealing a folder. */
  mightySessionId?: string
  dismissTimeout?: NodeJS.Timeout
  /** The auto-dismiss delay this card was given on done(), so a hover-then-leave
   *  can re-arm with the same timing instead of sticking forever. */
  dismissDelay?: number
  ready: boolean
  /** The latest hudUpdate that arrived before the renderer mounted, flushed whole
   *  on ready-to-show. Holds the FULL payload (not just the subtitle) so a freeze,
   *  a morph or a running-flip that lands during window load isn't silently
   *  reduced to a text change. */
  pendingUpdate: HudUpdatePayload | null
  pendingDone: HudDonePayload | null
  height: number
  width: number
}

const CARD_W = 320
// Recording cards show only a compact waveform + timer while listening, so they
// start narrow and widen to CARD_W on done (when the transcript/result + Ask/Act
// buttons need the room). See widthForCard().
const RECORDING_W = 200
const CARD_H = 78
// Expanded heights: actions-only (two buttons under the summary) and a full
// inline result body (scrollable answer + Copy).
const EXPANDED_ACTIONS_H = 118
// Ask-capable action cards (capture results) reserve room for the optional
// "add a question" input that the renderer reveals on hover below the buttons.
const EXPANDED_ASK_ACTIONS_H = 184
// Tall enough to actually read a multi-paragraph answer (body scrolls inside),
// PLUS the follow-up input row (~46px) that sits below the body + buttons.
const EXPANDED_BODY_H = 400
const MARGIN_TOP = 14
const MARGIN_RIGHT = 14
const GAP = 8
// Transparent slack on ALL FOUR sides of the card: the dismiss/expand chips
// straddle its top-right corner, and the card's CSS shadow needs somewhere to
// land on every side (the window sets hasShadow:false, so the shadow is ours to
// draw and ours to leave room for). Must match --hud-overhang in index.css.
// Card sizes below stay the CARD's size; every window is 2× this bigger and
// offset so the card lands where it always did.
const CHIP_GUTTER = 13

const activeHuds: Map<string, HudCard> = new Map()
const hudOrder: string[] = []

// Stack cards top-down, each sitting below the cumulative height of the ones
// above it (cards can be taller once they show buttons / an inline result).
function relayoutHuds(): void {
  const display = screen.getPrimaryDisplay()
  // workArea (NOT bounds) excludes the menu bar; bounds.y is 0 = under the menu bar.
  // A non-activating (showInactive) card sits exactly where we place it — macOS no
  // longer nudges it down — so anchoring to bounds.y clipped it behind the menu bar.
  const bounds = display.workArea
  const rightEdge = bounds.x + bounds.width - MARGIN_RIGHT

  let y = bounds.y + MARGIN_TOP
  hudOrder.forEach((id) => {
    const card = activeHuds.get(id)
    if (card && !card.window.isDestroyed()) {
      // Each card right-aligns to the same edge, so narrower cards (a live
      // recording) hug the right rather than stretching to the full width.
      // width/height are the CARD's; the window adds CHIP_GUTTER on ALL FOUR
      // sides (chips on the top/right, shadow room on every side), so x/y shift
      // back by it to keep the card itself on the same edge.
      const room = card.routeRoom ? HUD_ROUTE_ROOM : 0
      card.window.setBounds({
        x: Math.floor(rightEdge - card.width) - CHIP_GUTTER - room,
        y: Math.floor(y) - CHIP_GUTTER,
        width: card.width + CHIP_GUTTER * 2 + room,
        height: card.height + CHIP_GUTTER * 2 + room
      })
      y += card.height + GAP + room
    }
  })
}

export function hudStackLeftEdge(): number {
  const bounds = screen.getPrimaryDisplay().workArea
  return bounds.x + bounds.width - MARGIN_RIGHT - CARD_W
}

// Grow/shrink a card's height and reflow the stack so cards below it move down.
function resizeHudCard(card: HudCard, height: number): void {
  if (card.height === height) return
  card.height = height
  relayoutHuds()
}

// Largest a single card may grow to (a runaway answer otherwise eats the screen).
// Headroom for a finished capture card's full stack: transcript + Ask/Act + input +
// note row + a wrapped skills bar. 520 clipped once the note + skills rows landed.
const MAX_CARD_H = 640

/**
 * Content-driven sizing: the renderer measures the card's real rendered height
 * (ResizeObserver) and calls this. This is the source of truth for card height —
 * it supersedes the coarse per-state guesses in doneHud(), so the window always
 * fits its content (no clipped buttons/inputs) and shrinks back when content does.
 */
export function setHudCardHeight(runId: string, height: number): void {
  const card = activeHuds.get(runId)
  if (!card || card.window.isDestroyed()) return
  // A live recording card is intentionally compact (waveform only) — don't let a
  // stray measurement stretch it.
  if (card.recording) return
  // The renderer measures .hud-shell, which includes the gutter on top AND
  // bottom; card.height is the CARD alone (relayoutHuds re-adds it to the window).
  const cardH = Math.round(height) - CHIP_GUTTER * 2
  const h = Math.min(Math.max(cardH, CARD_H), MAX_CARD_H)
  resizeHudCard(card, h)
}

let hudClosedAt = 0
// 600ms — did-become-active fires at mousedown and its guard in index.ts runs 150ms later
const HUD_CLOSE_ECHO_MS = 600

function pointerOverCard(): boolean {
  const p = screen.getCursorScreenPoint()
  for (const card of activeHuds.values()) {
    if (card.window.isDestroyed()) continue
    const b = card.window.getBounds()
    if (p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height) return true
  }
  return false
}

export function hudCardInUse(): boolean {
  return Date.now() - hudClosedAt < HUD_CLOSE_ECHO_MS || pointerOverCard()
}

let cardActivatedApp = false

export function noteAppActive(active: boolean): void {
  cardActivatedApp = active && pointerOverCard()
}

// Must run BEFORE the card loses key: macOS brings our next window forward the moment it does.
function handBackIfCardHeldApp(win: BrowserWindow): boolean {
  if (!cardActivatedApp) return false
  const focused = BrowserWindow.getFocusedWindow()
  const onCard = focused === null || [...activeHuds.values()].some((c) => c.window === focused)
  if (focused !== win && !onCard) return false
  cardActivatedApp = false
  const handed = yieldToForeignApp()
  console.log(`[surface] card held app, handed back=${handed}`)
  return handed
}

export function dismissHud(runId: string): void {
  const card = activeHuds.get(runId)
  if (!card) {
    console.log(`[hud] dismiss MISS runId=${runId} open=[${hudOrder.join(',')}]`)
    return
  }
  console.log(`[hud] dismiss runId=${runId} open=[${hudOrder.join(',')}]`)
  hudClosedAt = Date.now()

  if (card.dismissTimeout) {
    clearTimeout(card.dismissTimeout)
  }

  if (!card.window.isDestroyed()) {
    // Hovering an ask card flips it focusable (setHudFocusable) so its follow-up
    // input can take keys, and the × lives INSIDE that hover region — so mouse-leave
    // never fires and the card would close while still focusable/key. macOS then
    // hands activation back to the app, did-become-active fires unguarded, and
    // surfaceApp() pops the panel open. Drop focusability first, then yield so the
    // activation echo lands inside wasJustYielded()'s window and is swallowed.
    const dying = card.window
    const handedBack = handBackIfCardHeldApp(dying)
    dying.setFocusable(false)
    dying.close()
    // Only the LAST card yields. yieldIfLastRestorable calls app.hide(), which hides
    // every window in the app and restores only those visible at that instant — so a
    // card raised inside that gap (the pre-warmed spare shows in ~1ms) was hidden and
    // never came back, which read as "dismissing one card killed all the others".
    if (!handedBack && hudOrder.filter((id) => id !== runId).length === 0) yieldIfLastRestorable(dying)
  }

  activeHuds.delete(runId)

  const idx = hudOrder.indexOf(runId)
  if (idx !== -1) {
    hudOrder.splice(idx, 1)
  }

  relayoutHuds()
}

export type { HudMode }

function createHudBrowserWindow(
  cardW: number,
  x: number,
  y: number,
  query: Record<string, string>
): BrowserWindow {
  const win = new BrowserWindow({
    width: cardW + CHIP_GUTTER * 2,
    height: CARD_H + CHIP_GUTTER * 2,
    x,
    y,
    frame: false,
    transparent: true,
    // The window is bigger than the card (see CHIP_GUTTER), so macOS's native
    // shadow traced THAT rectangle, not the card — a rounded outline offset from
    // the card that also painted over the ✕ chip. The card draws its own in CSS.
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    resizable: false,
    // Open NON-focusable so appearing never steals focus — a HUD card (Listen,
    // recording, result, progress) must not activate our app, or it pulls focus off
    // Finder/the editor and loses the user's selection + context. Mirrors the
    // cursor/sound overlays. Cards that later need typing (ask follow-up) flip to
    // focusable on demand via setHudFocusable(); the panel is the only surface that
    // takes focus on open (you type in it immediately).
    focusable: false,
    acceptFirstMouse: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?${new URLSearchParams(query)}`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { query })
  }
  return win
}

// One hidden, fully-loaded HUD window kept in reserve so the next startHud paints
// on the same tick instead of after a cold renderer load. The renderer sits at
// `?window=hud&warm=1` with no runId until hudInit hands it a card.
let spareHud: { window: BrowserWindow; ready: boolean } | null = null

/** Create the spare if none exists. Safe to call anytime after app ready. */
export function warmHud(): void {
  if (spareHud) return
  const win = createHudBrowserWindow(CARD_W, 0, 0, { window: 'hud', warm: '1' })
  const spare = { window: win, ready: false }
  win.once('ready-to-show', () => {
    spare.ready = true
  })
  win.on('closed', () => {
    if (spareHud === spare) spareHud = null
  })
  spareHud = spare
}

function takeSpareHud(): BrowserWindow | null {
  if (!spareHud?.ready || spareHud.window.isDestroyed()) return null
  const win = spareHud.window
  spareHud = null
  return win
}

export function startHud(
  runId: string,
  title: string,
  subtitle: string,
  mode: HudMode = HUD_MODE.act,
  capture: HudCapture = HUD_CAPTURE.listen,
  // Predicted run duration (ms) from src/main/estimator, or 0/undefined when there's
  // no history to predict from. Drives the card's progress bar; absent → plain timer.
  // Passed in the initial query (known at start) so the bar fills from the first frame.
  etaMs = 0,
  // Wall-clock ms the run actually started. Defaults to now (a fresh card), but a
  // panel→HUD detach passes the run's ORIGINAL start so the timer + bar continue
  // from there instead of resetting to 0 — the run moved surface, it didn't restart.
  startedAtMs = 0
): void {
  // A runId identifies ONE card. Raising the same id twice used to build a second
  // window, overwrite the map entry (orphaning the first window so dismissHud could
  // never close it) and push a duplicate into hudOrder — three ticking cards from one
  // hands-free arm, because main raises the card AND the host renderer reports
  // `starting` on mount. Re-raising is now an update of the live card.
  const existing = activeHuds.get(runId)
  if (existing && !existing.window.isDestroyed()) {
    console.log(`[hud] re-raise ignored, updating in place: runId=${runId}`)
    morphHud(runId, capture, title, subtitle)
    return
  }

  // Cap at 4 stacked cards: dismiss oldest. A LIVE capture is never the one
  // evicted — hands-free is the oldest card in its own stack by definition (its
  // mode card outlives every utterance below it), so a plain oldest-first cap
  // silently closed the only "the mic is open" indicator on the 4th segment.
  while (hudOrder.length >= 4) {
    const evictable = hudOrder.find((id) => {
      const c = activeHuds.get(id)
      return !c || !c.recording
    })
    // Every card is a live recording (can't happen today — only one mic runs at a
    // time) — fall back to the oldest so the cap still holds.
    const oldestId = evictable ?? hudOrder[0]
    dismissHud(oldestId)
  }

  // Recordings start compact (waveform + timer only); everything else opens at
  // full width. doneHud() widens a recording card when its result lands.
  // Hands-free is the exception among recordings: it carries instructional copy
  // ("talk anytime · tap the hotkey to stop") from the first frame, which the
  // narrow width truncated mid-word.
  const narrow = mode === HUD_MODE.recording && capture !== HUD_CAPTURE.handsFree
  const initialW = narrow ? RECORDING_W : CARD_W

  const display = screen.getPrimaryDisplay()
  // workArea excludes the menu bar (see relayoutHuds) — anchoring to bounds.y=0 put
  // the card under the menu bar and clipped it once cards stopped activating.
  const bounds = display.workArea
  // Initial position; relayoutHuds() at the end sets the exact stacked bounds.
  const x = Math.floor(bounds.x + bounds.width - initialW - MARGIN_RIGHT) - CHIP_GUTTER
  const y = bounds.y + MARGIN_TOP - CHIP_GUTTER

  // The run's true start: the passed override (panel→HUD detach — continue the
  // existing run's clock) or now (a fresh card). The renderer reads `elapsedMs`
  // (now − this) so a detached card shows the real elapsed time, not 0.
  const effectiveStart = startedAtMs > 0 ? startedAtMs : Date.now()
  const elapsedMs = Date.now() - effectiveStart
  const init: HudInitPayload = { runId, title, subtitle, mode, capture, etaMs, elapsedMs }
  const t0 = Date.now()

  // A pre-warmed spare skips the whole window-create + renderer-load wait (seconds
  // on a loaded dev box — long enough that a listen tap looked like it did nothing
  // and got tapped again, stopping it). Cold path only when no spare is ready.
  const spareWin = takeSpareHud()
  const win =
    spareWin ??
    createHudBrowserWindow(initialW, x, y, {
      window: 'hud',
      runId,
      title,
      subtitle,
      mode,
      capture,
      etaMs: String(etaMs),
      elapsedMs: String(elapsedMs)
    })

  const card: HudCard = {
    window: win,
    runId,
    startedAt: effectiveStart,
    mode,
    capture,
    recording: mode === HUD_MODE.recording,
    ready: false,
    pendingUpdate: null,
    pendingDone: null,
    height: CARD_H,
    width: initialW
  }

  const onReady = (): void => {
    console.log(`[hud] shown runId=${runId} +${Date.now() - t0}ms ${spareWin ? 'warm' : 'cold'}`)
    // showInactive (NOT show) — show() activates our app and steals focus off the
    // user's frontmost app (Finder/editor), losing their selection + context. A HUD
    // card is a passive overlay, so it must appear WITHOUT activating. Mirrors the
    // cursor overlay. Follow-up typing flips focusable on demand (setHudFocusable).
    win.showInactive()
    card.ready = true
    if (card.pendingUpdate !== null) {
      win.webContents.send(CHANNELS.hudUpdate, card.pendingUpdate)
      card.pendingUpdate = null
    }
    if (card.pendingDone !== null) {
      win.webContents.send(CHANNELS.hudDone, card.pendingDone)
      card.pendingDone = null
    }
  }
  if (spareWin) {
    spareWin.setBounds({
      x,
      y,
      width: initialW + CHIP_GUTTER * 2,
      height: CARD_H + CHIP_GUTTER * 2
    })
    spareWin.webContents.send(CHANNELS.hudInit, init)
    onReady()
  } else {
    win.on('ready-to-show', onReady)
  }

  activeHuds.set(runId, card)
  hudOrder.push(runId)
  // Replace the spare we just consumed (or make the first one), off the hot path.
  setImmediate(warmHud)

  console.log(`[hud] start runId=${runId} mode=${mode} capture=${capture} open=[${hudOrder.join(',')}]`)

  relayoutHuds()
}

export function updateHud(
  runId: string,
  subtitle: string,
  freezeTimer = false,
  recording?: boolean,
  // Seconds to freeze the timer AT, overriding the card's wall-clock. A capture
  // that has already stopped (phone clip, finished mic recording) must freeze on
  // the RECORDING length, not on how long the card has been open — otherwise the
  // number keeps climbing through transcode/whisper and then snaps backwards when
  // doneHud lands on the real clip length. Ignored unless freezeTimer is true.
  freezeAtS?: number
): void {
  const card = activeHuds.get(runId)
  if (!card || card.window.isDestroyed()) return
  const elapsedS = freezeAtS !== undefined ? freezeAtS : (Date.now() - card.startedAt) / 1000
  const payload: HudUpdatePayload = {
    subtitle,
    freezeTimer,
    timerFreeze: freezeTimer ? elapsedS.toFixed(1) + 's' : undefined,
    recording
  }
  if (!card.ready) {
    // Renderer not mounted yet — hold the whole payload to flush on ready-to-show.
    // Keeping only the subtitle (the old behaviour) silently dropped the freeze, so
    // a card that stopped recording before its window finished loading came up
    // ticking and never stopped.
    card.pendingUpdate = payload
    return
  }
  card.window.webContents.send(CHANNELS.hudUpdate, payload)
}

/**
 * Push hold-progress (0..1) to a live listen card while the key is physically
 * held, before the tap/hold threshold fires. Drives the intensifying glow so
 * the user can see the hold registering in real time. No-op once the card is
 * gone (e.g. released + dismissed before the next tick).
 */
export function updateHudHoldProgress(runId: string, pct: number): void {
  const card = activeHuds.get(runId)
  if (!card || card.window.isDestroyed() || !card.ready) return
  card.window.webContents.send(CHANNELS.hudUpdate, { holdProgress: pct })
}

export function markHudRouteNext(runId: string): void {
  const card = activeHuds.get(runId)
  if (!card || card.window.isDestroyed()) return
  if (!card.ready) {
    card.pendingUpdate = { ...card.pendingUpdate, routeNext: true }
    return
  }
  card.window.webContents.send(CHANNELS.hudUpdate, { routeNext: true })
}

export function markHudSubmitNext(runId: string): void {
  const card = activeHuds.get(runId)
  if (!card || card.window.isDestroyed()) return
  if (!card.ready) {
    card.pendingUpdate = { ...card.pendingUpdate, submitNext: true }
    return
  }
  card.window.webContents.send(CHANNELS.hudUpdate, { submitNext: true })
}

/**
 * Tell a hands-free card whether the user is talking right now. Drives the
 * waveform + timer, which only make sense while speech is actually being
 * captured — the session itself is mostly silence.
 */
export function updateHudSpeaking(runId: string, speaking: boolean): void {
  const card = activeHuds.get(runId)
  if (!card || card.window.isDestroyed()) return
  if (!card.ready) {
    card.pendingUpdate = { ...card.pendingUpdate, speaking }
    return
  }
  card.window.webContents.send(CHANNELS.hudUpdate, { speaking })
}

/**
 * Upgrade a LIVE listen card's capture kind + title IN PLACE — e.g. the plain
 * listen → smart-dictation flip when the hold crosses LISTEN_SMART_HOLD_MS.
 * Replaces the old dismissHud()+startHud() pair: that closed the window and
 * opened a new one, which visibly hid the HUD for a frame (window close is
 * synchronous, the replacement's loadFile/ready-to-show is not) and fired
 * relayoutHuds() twice in a row, double-shifting any other stacked card. This
 * pushes the new capture/title/subtitle onto the SAME window — no close, no
 * second relayout, no gap. widenHud() already grows the card if needed.
 */
export function morphHud(runId: string, capture: HudCapture, title: string, subtitle: string): void {
  const card = activeHuds.get(runId)
  if (!card || card.window.isDestroyed()) return
  card.capture = capture
  const payload: HudUpdatePayload = { capture, title, subtitle }
  if (!card.ready) {
    card.pendingUpdate = { ...card.pendingUpdate, ...payload }
    return
  }
  card.window.webContents.send(CHANNELS.hudUpdate, payload)
}

/**
 * Widen a card that opened at the narrow RECORDING_W (waveform-only) once it
 * moves past recording into a text/phase-label state — e.g. smart dictation's
 * "Reading your screen…"/"Thinking…" steps. Same width fix doneHud applies on
 * the result card, exposed standalone so smart-dictation.ts can call it the
 * moment it flips recording:false, instead of clipping until doneHud/failHud.
 */
export function widenHud(runId: string): void {
  const card = activeHuds.get(runId)
  if (!card || card.window.isDestroyed() || card.width === CARD_W) return
  card.width = CARD_W
  relayoutHuds()
}

/**
 * The inverse: shrink back to the waveform-only width. Hands-free alternates —
 * wide while it shows its instruction line, narrow once the wave replaces that
 * text — so a card that could only ever grow left a bare waveform floating in
 * 320px of empty pill.
 */
export function narrowHud(runId: string): void {
  const card = activeHuds.get(runId)
  if (!card || card.window.isDestroyed() || card.width === RECORDING_W) return
  card.width = RECORDING_W
  relayoutHuds()
}

/**
 * Is this card's window actually on screen right now? HUD cards are always
 * focusable:false (never steal OS focus — see the interface doc above), so
 * isVisible() is the only meaningful "did the user see this" signal, mirroring
 * panel-window.ts's isPanelVisible() (which also only checks isVisible()).
 */
export function isHudVisible(runId: string): boolean {
  const card = activeHuds.get(runId)
  return !!card && !card.window.isDestroyed() && card.window.isVisible()
}

/**
 * Show or hide the "Esc again to cancel" hint on a live capture card (first Esc press).
 * Pushes a subtitle-less hudUpdate so the renderer flips the hint on without
 * disturbing the current subtitle. No-op if the card isn't mounted yet.
 */
export function armHudCancel(runId: string, armed: boolean): void {
  const card = activeHuds.get(runId)
  if (!card || card.window.isDestroyed() || !card.ready) return
  card.window.webContents.send(CHANNELS.hudUpdate, { cancelArmed: armed })
}

export interface DoneOpts {
  /** Quick-action buttons to render under the summary (e.g. ['ask','act']). */
  actions?: HudActionKind[]
  /** Long-form result body to render inline with a Copy button. */
  body?: string | null
  /** Don't auto-dismiss (set automatically when actions/body are present). */
  sticky?: boolean
  /** Inline capture preview — a screenshot thumbnail or a short recording clip,
   *  shown macOS-style above the summary. Absolute path; served via media://. */
  preview?: HudPreview | null
  /** Renders Confirm/Cancel buttons instead of `actions` — a destructive act
   *  is waiting on the user before it fires. Never auto-dismisses. */
  confirmAct?: boolean
  /** The Mighty session this result belongs to (ask only). Stashed on the card so a
   *  later click on the finished card can open the real conversation instead of just
   *  revealing a folder — see handleHudClick. Undefined for act/rewrite (never bound
   *  to a session) or if the run wasn't linked to one. */
  sessionId?: string
  /** The user stopped this run — render it neutrally, not as a failure. */
  stopped?: boolean
  /** Ms from "audio finalized" to "transcript in hand" — the post-mic wait, shown
   *  beside the clip length when the user opted into transcription speed. */
  transcribeMs?: number
  /** Renders the code-agent-relay card (ask/approve/show) instead of `actions`.
   *  Never auto-dismisses — see the doneHud tail logic. */
  relay?: HudRelayCard
  /** Offer the "voice route" button: hover mode is holding this transcript. */
  canVoiceRoute?: boolean
}

export function doneHud(
  runId: string,
  ok: boolean,
  summary: string,
  revealPath?: string | null,
  elapsedOverrideS?: number,
  opts: DoneOpts = {}
): void {
  // Phone remote: reset the phone's "Running…" status back to Ready/error --
  // without this it hangs on "Running…" forever until the phone reconnects.
  if (isPhoneRun(runId)) {
    const phoneBody = opts.body && opts.body.trim() !== '' ? opts.body : summary
    // A failure carries its history id too: the row holds the reason copy and the
    // stderr detail, so the toast has somewhere to send you. It used to send
    // `undefined`, which made a failed toast a dead end.
    const failure = ok ? null : HISTORY.failureFor(runId)
    sendToPhone({
      type: 'runDone',
      ok,
      summary: phoneBody,
      historyId: runId,
      reason: failure?.reason,
      detail: failure?.detail
    })
  }

  const card = activeHuds.get(runId)
  if (!card) return

  card.revealPath = revealPath
  card.mightySessionId = opts.sessionId
  // The card is now a FINISHED result (transcript + Ask/Act + note + skills), not a
  // live mic recording — clear the flag so setHudCardHeight stops refusing to grow
  // the window (line ~103). Without this, a listen/recording card that finishes with
  // the new note row + skills bar clips: it stays flagged recording and can't resize
  // to fit the taller content.
  card.recording = false
  // For recordings, freeze at the recording duration (passed in), not the HUD
  // wall-clock — otherwise transcription/finalize time inflates the number.
  const elapsedS =
    elapsedOverrideS !== undefined ? elapsedOverrideS : (Date.now() - card.startedAt) / 1000
  const elapsed = elapsedS.toFixed(1) + 's'

  const hasActions = !!(opts.actions && opts.actions.length > 0) || !!opts.confirmAct
  const hasBody = !!(opts.body && opts.body.trim() !== '')
  // Ask-capable cards reserve space for the hover "add a question" input.
  const hasAskAction = !!opts.actions?.includes('ask')
  // A confirm gate must never auto-dismiss — silently timing out would either
  // lose the act (safe default) or, worse, invite a "sticky = fires anyway"
  // bug later. Made explicit instead of leaning on the sticky-delay path.
  const sticky = opts.sticky || hasActions || hasBody || !!opts.confirmAct
  // An inline capture preview (screenshot/clip) adds a fixed media frame above the
  // summary — reserve its height in the opening preset so the card doesn't clip
  // before the renderer's ResizeObserver measures the real content. Matches the
  // .hud-preview frame (max 180px) + its margin in index.css.
  const previewH = opts.preview ? 190 : 0

  // A recording card opened narrow (waveform only); its result — transcript +
  // Ask/Act buttons — needs the full width. Widen before pushing the payload.
  if (card.width !== CARD_W || card.routeRoom !== !!opts.canVoiceRoute) {
    card.width = CARD_W
    card.routeRoom = !!opts.canVoiceRoute
    relayoutHuds()
  }

  // A card showing buttons, an inline answer, or a capture preview needs more room
  // than the 78px default. Grow it before pushing the payload so the layout doesn't
  // clip. The ResizeObserver in the renderer then trims to the exact rendered height.
  if (hasActions || hasBody || previewH > 0) {
    const base = hasBody
      ? EXPANDED_BODY_H
      : hasAskAction
        ? EXPANDED_ASK_ACTIONS_H
        : hasActions
          ? EXPANDED_ACTIONS_H
          : CARD_H
    // A body already scrolls inside its own fixed height, so the preview doesn't
    // stack on top of it; for the compact action/plain cards it adds on.
    resizeHudCard(card, Math.min(hasBody ? base : base + previewH, MAX_CARD_H))
  }

  if (card.window && !card.window.isDestroyed()) {
    const donePayload: HudDonePayload = {
      ok,
      summary,
      revealPath: revealPath ? 'click to reveal' : null,
      timerFreeze: elapsed,
      actions: opts.actions,
      canVoiceRoute: opts.canVoiceRoute,
      body: opts.body ?? null,
      preview: opts.preview ?? null,
      confirmAct: opts.confirmAct,
      relay: opts.relay,
      hasConversation: !!opts.sessionId,
      stopped: opts.stopped,
      // Gated in main, not the renderer: an opted-out user's HUD never receives
      // the number at all.
      transcribeMs: PREFS.getShowTiming() ? opts.transcribeMs : undefined
    }
    if (card.ready) {
      card.window.webContents.send(CHANNELS.hudDone, donePayload)
    } else {
      card.pendingDone = donePayload
    }
  }

  // Sound feedback, chosen by capture type. Recordings play NO stop sound (the
  // stop is already obvious from the card flipping to its result), so a finished
  // recording stays silent; everything else keeps its cue.
  if (!ok) {
    playSound('error')
  } else if (card.recording) {
    // intentionally silent — no stop chime on a finished recording
  } else if (card.mode === HUD_MODE.screenshot) {
    playSound('screenshot')
  } else {
    playSound('success')
  }

  // Auto-dismiss. Sticky cards (transcript + Ask/Act buttons) go after 3s — the
  // user spoke the text, they don't need to read it back. Plain cards keep the 6s
  // default; failures get longer so the reason is readable. ENGAGING with a card
  // (hover/click) cancels the timer entirely (see keepHudAlive) so it sticks
  // until manually dismissed.
  if (card.dismissTimeout) clearTimeout(card.dismissTimeout)
  // A confirm gate or a relay ask/approve/show waits on a real decision — no
  // auto-dismiss timer at all, or a slow read would silently drop (or worse,
  // someday auto-fire) the destructive act. The store's own timeout (design,
  // up to 600s) is what eventually resolves an ignored relay card, never the
  // HUD's cosmetic auto-hide; dismissRelayHud() closes this window when that fires.
  if (!opts.confirmAct && !opts.relay) {
    const delay = !ok ? FAIL_DISMISS_MS : sticky ? STICKY_DISMISS_MS : RESULT_DISMISS_MS
    card.dismissDelay = delay
    card.dismissTimeout = setTimeout(() => dismissHud(runId), delay)
  }
}

// How long a sticky (action/result) card stays before auto-dismissing, absent
// any engagement.
const STICKY_DISMISS_MS = 3000
const RESULT_DISMISS_MS = 6000
// Failures linger longer than a success card: the user has to READ the reason
// ("couldn't hear that") and decide whether to retry, not just watch it vanish.
const FAIL_DISMISS_MS = 8000

/**
 * Flip a card focusable on demand so its follow-up input can receive keystrokes.
 * Cards open NON-focusable (so appearing never steals focus off Finder/the editor);
 * the renderer calls this with `true` when the user clicks into the "ask a follow-up"
 * field, and `false` when the field blurs — so the card only ever holds focus while
 * the user is actively typing in it, never on mere appearance.
 */
export function setHudFocusable(runId: string, focusable: boolean): void {
  const card = activeHuds.get(runId)
  if (!card || card.window.isDestroyed()) return
  // Only toggle the CAPABILITY to take focus — do NOT call focus() here. Hovering an
  // ask card flips this true so a subsequent click into the follow-up input can focus
  // it via the OS; the appearance/hover itself never activates the app. Blur flips it
  // back so the card can't hold focus once the user looks away.
  if (!focusable) handBackIfCardHeldApp(card.window)
  card.window.setFocusable(focusable)
}

/**
 * Pause a card's auto-dismiss timer while the pointer is over it — the user is
 * reading the result / deciding which button to hit, so it shouldn't vanish
 * mid-read. Paired with rearmHudDismiss() on mouse-leave: hover pauses, leaving
 * resumes the normal countdown. (Clicking a button still cancels via runningHud.)
 */
export function keepHudAlive(runId: string): void {
  const card = activeHuds.get(runId)
  if (!card || card.window.isDestroyed()) return
  if (card.dismissTimeout) {
    clearTimeout(card.dismissTimeout)
    card.dismissTimeout = undefined
  }
}

/**
 * Restart a card's auto-dismiss countdown when the pointer leaves it. Without
 * this, a single hover (or a card that opens under the cursor) would keep the
 * card up forever. Re-arms with the same delay the card got on done().
 */
export function rearmHudDismiss(runId: string): void {
  const card = activeHuds.get(runId)
  if (!card || card.window.isDestroyed()) return
  // No delay recorded = card never armed (a confirm gate) — nothing to re-arm.
  if (card.dismissDelay === undefined) return
  if (card.dismissTimeout) clearTimeout(card.dismissTimeout)
  card.dismissTimeout = setTimeout(() => dismissHud(runId), card.dismissDelay)
}

export function failHud(runId: string, message: string, stopped = false): void {
  // `stopped` still travels the ok:false path (the run produced no final result),
  // but the card renders it neutrally rather than red — see HudDonePayload.stopped.
  doneHud(runId, false, message || 'failed', undefined, undefined, { stopped })
}

/**
 * Flip a done card back to a running state — used when the user clicks a HUD
 * quick-action button (Ask/Act) and we kick off a backend run on that card.
 * Cancels any pending auto-dismiss and pushes a fresh "running" subtitle.
 */
export function runningHud(runId: string, title: string, subtitle: string, etaMs = 0): void {
  const card = activeHuds.get(runId)
  if (!card || card.window.isDestroyed()) return
  if (card.dismissTimeout) {
    clearTimeout(card.dismissTimeout)
    card.dismissTimeout = undefined
  }
  // The card is running again — drop the stale delay so a mouse-leave during the
  // run doesn't re-arm a dismiss against an in-flight backend call.
  card.dismissDelay = undefined
  // A button-initiated run is an Ask/Act LLM call, not a mic recording. Clear the
  // recording flag so done() plays the success sound (not record-stop); the
  // renderer drops the mic-waveform UI off the running:true update it also gets.
  card.recording = false
  card.startedAt = Date.now()
  if (card.ready) {
    // etaMs rides the running update so a card RAISED as a recording/listen and then
    // REUSED for an LLM call (capture-actions) still gets its ETA bar — it never went
    // through startHud's query with one. 0 = no estimate → renderer shows just the timer.
    card.window.webContents.send(CHANNELS.hudUpdate, { running: true, title, subtitle, etaMs })
  } else {
    // Carry the whole reuse, not just the label: a `running` flip dropped here left
    // the card stuck in its previous (possibly frozen) state once it mounted.
    card.pendingUpdate = { ...card.pendingUpdate, running: true, title, subtitle, etaMs }
  }
}

/**
 * Handle a click into a HUD card's result. A smart-dictation card hands off to the
 * conversation it just logged (returns its runId so the caller can resume the panel
 * on it) instead of revealing a folder — the user tapped it to keep going, not to go
 * spelunking in Finder. An ask card with a bound Mighty session opens straight to
 * that conversation (what the user actually means by "open the conversation" —
 * revealPath on an ask card only ever points at the run's audit folder, which isn't
 * it). Every other capture kind keeps the old reveal-in-Finder behavior unchanged.
 */
export function handleHudClick(runId: string): boolean {
  const card = activeHuds.get(runId)
  if (!card) return false
  console.log(`[hud] body click runId=${runId} session=${card.mightySessionId !== undefined} reveal=${card.revealPath !== undefined}`)

  const isSmartDictation = card.capture === HUD_CAPTURE.smartListen
  if (isSmartDictation) {
    dismissHud(runId)
    return true
  }

  if (card.mightySessionId) {
    showMightyWindow(false, card.mightySessionId)
    dismissHud(runId)
    return false
  }

  if (card.revealPath) {
    // A capture passes its FOLDER — that's a Library entry, so open it in OUR
    // Library tab (player, transcript, waveform, tags), not Finder. Finder was the
    // old behavior and it dumped the user into raw files for a recording they'd
    // just made in-app. A file path (screenshot, written file) has no library row
    // to land on, so it still gets selected in its parent. Stat decides; a stat
    // failure falls back to selecting, which Finder handles either way.
    let isDir = false
    try {
      isDir = statSync(card.revealPath).isDirectory()
    } catch {}
    // The Library lives as a tab in the composer now, so a capture opens there —
    // same window as Chat/History/Made, not a second one to manage.
    if (isDir) showMightyWindow(false, undefined, card.revealPath)
    else shell.showItemInFolder(card.revealPath)
  }
  dismissHud(runId)
  return false
}

/**
 * Raise (or update, if already open) one HUD card for a pending code-agent-
 * relay request. Reuses the request's own id
 * as the card's runId — a relay request already IS a one-per-card identity,
 * so minting a second UUID here would just be an indirection to keep in sync.
 * The card is born already "done" (no running phase to show) and never
 * auto-dismisses while pending, same as a confirmAct gate.
 */
/** Whether Mac alerts are drawn as our own cards rather than macOS
 *  notifications. Read live, so flipping the choice needs no restart. */
function relayCardsChosen(): boolean {
  const mac = PREFS.getAgentRelayMacAlerts()
  return mac.enabled && mac.renderer === 'card'
}

export function startRelayHud(request: RelayRequest): void {
  if (request.status !== 'pending') return
  // A `notify` reaches here only when the user picked MightyMouse cards over macOS
  // notifications -- the store feed at
  // ipc/agent-relay.ts still filters it out, so nothing else changed. It has
  // nothing to answer, so it rides the ordinary STICKY_DISMISS_MS timer home
  // instead of waiting for a decision that is never coming.
  if (request.verb === 'notify' && !relayCardsChosen()) return
  const runId = request.id
  // startHud() ignores a re-raise, and doneHud() never touches the title -- so a
  // card raised by an earlier verb kept ITS heading while the body swapped to the
  // new request, printing e.g. the question as the title of a "Needs your answer"
  // card. Push the title on every raise, not just the first.
  if (activeHuds.has(runId)) {
    morphHud(runId, HUD_CAPTURE.listen, relayTitle(request), relaySummary(request))
  } else {
    startHud(runId, relayTitle(request), relaySummary(request), HUD_MODE.act, HUD_CAPTURE.listen)
  }
  const relay: HudRelayCard = {
    requestId: request.id,
    verb: request.verb,
    createdAt: request.createdAt,
    timeoutMs: request.timeoutMs,
    from: request.params.from,
    faceId: senderFaceId(request.params.from, liveAgentSessions()) || undefined,
    cwd: request.params.cwd,
    test: request.params.test,
    level: request.params.level,
    question: request.params.question,
    options: request.params.options,
    questions: request.params.questions,
    buffered: request.buffered.length ? request.buffered : undefined,
    canReadPane: Boolean(request.params.origin?.tmuxPane),
    action: request.params.action,
    detail: request.params.detail,
    risk: request.params.risk,
    imagePath: request.params.imagePath,
    caption: request.params.caption,
    waitForAck: request.params.waitForAck,
    progress: request.params.progress
  }
  doneHud(runId, true, relaySummary(request), null, undefined, { relay, sticky: true })
}

/** What the card asks OF YOU. The agent's action/question is the subtitle -- the
 *  two used to be the same string, which printed one sentence twice with the
 *  title truncated mid-word. */
function relayTitle(request: RelayRequest): string {
  const heading =
    request.verb === 'approve'
      ? 'Needs your decision'
      : request.verb === 'show'
        ? 'Take a look'
        // An update asks nothing, so "Needs your answer" would be a lie. Its own
        // title when it has one, matching the native card (mac-notification.ts).
        : request.verb === 'notify'
          ? (request.params.title ?? 'Update')
          : 'Needs your answer'
  return markTest(heading, request.params.test)
}

function relaySummary(request: RelayRequest): string {
  if (request.verb === 'approve') return request.params.action ?? 'Approve?'
  if (request.verb === 'show') return request.params.caption ?? 'Screenshot'
  // Same fallback chain the native card uses: an idle ping carries no news of
  // its own, so the recap is the only thing that can say where it left off.
  if (request.verb === 'notify') {
    return request.params.body ?? (request.params.idle ? request.params.last : undefined) ?? ''
  }
  // `params.question` is pinned to questions[0], so an interview left here would
  // show question 1 forever while the buttons below advanced.
  const view = interviewView(
    request.params.questions,
    request.buffered,
    Boolean(request.params.origin?.tmuxPane)
  )
  return view.current?.question ?? request.params.question ?? 'Question'
}

/** Drop a relay card the instant its request settles from ANY surface (§6b:
 *  first answer wins) — a HUD card left open on an already-answered request
 *  would let the user "answer" it again into a no-op. */
export function dismissRelayHud(requestId: string): void {
  dismissHud(requestId)
}

/**
 * "Go to session" — take-me-to-the-session design/§5.5. Replaces the old
 * "Open the screen" affordance on the Mac card: that button opened phone
 * pairing settings, which was never honest here (it was written for the
 * PHONE card, where the sheet closes onto a live mirror). On the Mac the
 * useful destination is the actual terminal pane the agent is running in.
 *
 * Looks the live request up by id rather than trusting anything the renderer
 * sent, so `origin` never has to become a HudRelayCard field — the request
 * (and its origin) already lives in relayRequestStore, keyed by the same id
 * the card renders.
 */
export async function goToOriginFromHud(requestId: string): Promise<void> {
  const request = relayRequestStore.get(requestId)
  if (!request) return
  await resolveOrigin(request.params.origin)
}

/** Pure/synchronous companion to goToOriginFromHud — lets the renderer ask
 *  "would this button do anything" without a shell-out on every card render. */
export function hasResolvableOriginFromHud(requestId: string): boolean {
  const request = relayRequestStore.get(requestId)
  return isOriginResolvable(request?.params.origin)
}
