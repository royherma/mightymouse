import { app, BrowserWindow, screen } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { CONFIG, buildLastHint } from '../shared/config'
import { CHANNELS } from '../shared/ipc'
import { track } from './analytics'
import {
  ANALYTICS_EVENT,
  PANEL_SOURCE_TOUR,
  type PanelOpenSource
} from '../shared/analytics-events'
import type { ContextData, PanelOpenTo, WelcomeVariant } from '../shared/types'
import { captureContext, chrome } from './platform'
import { activateApp } from './platform/macos/activate-app'
import { currentForeignFrontmostBundleId } from './platform/macos/frontmost-watch'
import { getPanelState, buildCtxLabel, buildCtxIdentity, actionVisible } from './ipc/panel-state'
import { ACTIONS } from './store/actions'
import { PREFS } from './store/prefs'

let panelWindow: BrowserWindow | null = null

// The view the next mount/reseed should land on (e.g. 'history' when opened from
// the tray History item). Set by showPanelWindow, consumed once by
// buildPanelInitData so the RENDERER opens the view when it's ready — replacing
// the old fixed-timer `openHistory` push that raced both the mount (panelState
// not seeded) and the renderer's listener subscription.
let pendingOpenTo: PanelOpenTo | undefined

/** Read-and-clear the pending open-to intent. Single-shot per open. */
export function consumePendingOpenTo(): PanelOpenTo | undefined {
  const v = pendingOpenTo
  pendingOpenTo = undefined
  return v
}

/** Queue the panel to resume a specific conversation on its next mount/reseed —
 *  same single-shot pattern as pendingOpenTo above, just set directly (not via
 *  showPanelWindow's `source`) since the HUD click path isn't a PanelOpenSource. */
export function queueResumeConversation(runId: string): void {
  pendingOpenTo = { type: 'conversation', runId }
}

/** Queue an instruction for the panel to submit on its next mount/reseed. Used
 *  by the selection bar's one-tap actions, where the user already chose what to
 *  do and typing it again would be the whole friction we're removing. */
export function queueRunInstruction(instruction: string): void {
  pendingOpenTo = { type: 'run', instruction }
}

// Same single-shot pattern as pendingOpenTo, for the post-auth welcome banner
// (see showPanelWindow's `welcome` param). Kept separate from pendingOpenTo
// since the two can't both apply to the same open.
let pendingWelcome: WelcomeVariant | undefined

/** Read-and-clear the pending welcome-banner variant. Single-shot per open. */
export function consumePendingWelcome(): WelcomeVariant | undefined {
  const v = pendingWelcome
  pendingWelcome = undefined
  return v
}

// Keep the frame this far inside the display's work area on every edge — so the
// drag strip + resize handles never end up flush against (or past) a screen edge.
// Shared by initial placement and the content auto-fit's bottom clamp.
const SCREEN_MARGIN = 8

// The height the user manually dragged the frame to, this session only (NOT
// persisted — every fresh open resets to default). While set, the content
// auto-fit treats it as a floor so it never snaps a deliberately-enlarged window
// back down mid-session. Reset to 0 on each show.
let manualFloorH = 0

// True after an explicit hidePanelWindow() call, cleared on the next show. Lets
// showPanelWindow tell "hidden, restore in place" apart from "brand new, position
// near cursor" — both look identical via win.isVisible() (false) otherwise.
let wasHidden = false

// Live context-pill poll — while the panel is on screen, re-check the frontmost
// app/window/URL on an interval and push an update the moment it changes (e.g.
// the user Cmd+Tabs to a different app without closing the panel). Runs ONLY
// while visible: started at the end of showPanelWindow, stopped in
// hidePanelWindow/closePanelWindow so it never ticks in the background.
let contextPollTimer: ReturnType<typeof setInterval> | null = null

function ctxEqual(a: ContextData, b: ContextData): boolean {
  return a.frontApp === b.frontApp && a.windowTitle === b.windowTitle && a.browserURL === b.browserURL
}

async function pollContextTick(): Promise<void> {
  const panelState = getPanelState()
  // No panelState yet (panel hasn't finished its first mount) — nothing to diff
  // against, skip this tick rather than guessing.
  if (!panelState) return
  const ctx = await captureContext()
  if (ctxEqual(ctx, panelState.ctx)) return

  // Mutate ctx IN PLACE (not a full panelState replace) — submit/run handlers read
  // panelState.selection/history/finderFiles, none of which a focus change should
  // touch. Only ctx (and the actions list it can gate) changes here.
  panelState.ctx = ctx
  sendToPanelRenderer(CHANNELS.panelReseed, {
    selection: panelState.selection,
    placeholder: buildLastHint(PREFS.getLastInstruction()),
    lastInstr: PREFS.getLastInstruction(),
    lastMode: PREFS.getLastMode(),
    ctxOn: panelState.ctxOn,
    ctxLabel: buildCtxLabel(ctx),
    ...buildCtxIdentity(ctx),
    actions: ACTIONS.load().filter((a) => actionVisible(a, ctx.browserURL)),
    backend: PREFS.getBackend(),
    ollamaModel: PREFS.getOllamaModel(),
    selectedModel: PREFS.getSelectedModel(),
    cursorOn: PREFS.getCursorCompanion(),
    feedbackEnabled: PREFS.getFeedbackEnabled(),
    incognito: PREFS.getIncognito(),
    historyFilterHidden: PREFS.getHistoryFilterHidden()
  })
}

function startContextPoll(): void {
  if (contextPollTimer) return
  contextPollTimer = setInterval(() => {
    void pollContextTick()
  }, CONFIG.PANEL_CONTEXT_POLL_MS)
}

function stopContextPoll(): void {
  if (!contextPollTimer) return
  clearInterval(contextPollTimer)
  contextPollTimer = null
}

/**
 * The panel's live BrowserWindow, re-derived from Electron when the module-level
 * `panelWindow` has gone stale.
 *
 * Why this is not just `return panelWindow`: that variable is nulled by the
 * `closed` handler, and if it is ever nulled while the real window is still on
 * screen, EVERY guarded op (`close`, `hide`, `resize`) hits `if (!panelWindow)
 * return` and no-ops SILENTLY. The user sees a panel that ignores its own close
 * button — no error, no log, nothing to debug against. Observed 2026-08-17:
 * cancel/panelHide/resize all confirmed reaching main and all doing nothing,
 * while the window sat there rendering fine.
 *
 * `closed` fires on a destroyed window, so anything Electron still lists as an
 * undestroyed panel window outranks our cached null. Electron's list is the
 * source of truth; the variable is only a cache.
 */
function resolvePanelWindow(): BrowserWindow | null {
  if (panelWindow && !panelWindow.isDestroyed()) return panelWindow

  const live = BrowserWindow.getAllWindows().find(
    (w) => !w.isDestroyed() && w.webContents.getURL().includes('window=panel')
  )
  if (!live) return null

  // Re-adopt so the next call takes the fast path and `closed` can clear it. The
  // log is the whole point of keeping this branch loud: a recovery means the
  // cache went stale, which is the bug — the recovery is only the safety net.
  console.log('[panel] recovered stale panelWindow reference')
  panelWindow = live
  return live
}

export function getPanelWindow(): BrowserWindow | null {
  return resolvePanelWindow()
}

// True only when the panel is actually on screen. Distinct from "the window
// object exists" (getPanelWindow): a kept-alive but hidden window still returns
// a non-null window. Triggers use this to decide whether to push a reseed — a
// not-yet-visible panel seeds itself via getInitialData on mount, so reseeding
// it would double-consume the trigger data and clobber the selection.
export function isPanelVisible(): boolean {
  const win = resolvePanelWindow()
  return win !== null && win.isVisible()
}

// True whenever a re-trigger needs to push a reseed instead of relying on
// mount-time getInitialData: either the panel is currently visible (isPanelVisible),
// OR it's hidden-but-alive via hidePanelWindow() (wasHidden) — that case's
// showPanelWindow() call just show()+focus()s without reseeding, same as the
// already-visible case, so callers must check both. Read BEFORE calling
// showPanelWindow(), since that call clears wasHidden.
export function needsPanelReseed(): boolean {
  return isPanelVisible() || wasHidden
}

export function createPanelWindow(): BrowserWindow {
  // Via the resolver, not the bare variable: a stale null here would build a
  // SECOND panel window on top of the live one.
  const existing = resolvePanelWindow()
  if (existing) return existing

  // Always open at the default size — the panel is not size-persisted. The user
  // can drag it bigger while it's open (the textarea/thread fills the slack), but
  // every fresh open resets to PANEL_W × PANEL_H (see showPanelWindow).
  panelWindow = new BrowserWindow({
    width: CONFIG.PANEL_W,
    height: CONFIG.PANEL_H,
    minWidth: CONFIG.PANEL_MIN_W,
    minHeight: CONFIG.PANEL_MIN_H,
    maxWidth: CONFIG.PANEL_MAX_W,
    maxHeight: CONFIG.PANEL_MAX_H,
    frame: false,
    transparent: true,
    ...chrome.windowOptions('vibrant'),
    visualEffectState: 'active',
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    resizable: true, // user can drag any edge; height also auto-fits content
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  // Track manual drag-resizes. `will-resize` fires for user frame drags but NOT
  // programmatic setBounds, so it's how we tell a deliberate enlarge apart from the
  // content auto-fit — and stops the auto-fit from snapping a dragged-tall window
  // back down. The drag height is NOT persisted: every fresh open resets to the
  // compact default (see showPanelWindow), so this floor only lasts the session.
  panelWindow.on('will-resize', (_e, newBounds) => {
    manualFloorH = newBounds.height
  })

  // Load renderer page
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    panelWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?window=panel`)
  } else {
    panelWindow.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { window: 'panel' }
    })
  }

  // Clear the ref ONLY if it still points at the window that just died. A late
  // `closed` from a previous panel would otherwise null out a NEWER live one —
  // leaving a panel on screen whose every op silently no-ops (see
  // resolvePanelWindow). `closed` is async, so the two can overlap.
  const self = panelWindow
  panelWindow.on('closed', () => {
    if (panelWindow === self) panelWindow = null
  })

  return panelWindow
}

export function showPanelWindow(
  source: PanelOpenSource = 'other',
  welcome?: WelcomeVariant
): void {
  // createPanelWindow() resolves before building, so a stale null can't spawn a
  // second panel on top of the live one.
  const win = createPanelWindow()

  // Opened from the History tray item: land the panel on the History flyout. The
  // renderer reads this off its init/reseed payload and opens the view once it's
  // mounted — no timer, no race. Cleared after one consume.
  if (source === 'history') pendingOpenTo = 'history'

  // Post-auth welcome banner (see gateAfterAuth / completeOnboarding in main).
  // Same single-shot pattern as the History case above.
  if (welcome) pendingWelcome = welcome

  // Already open (re-trigger over a new app to refresh context): DON'T reposition
  // or reset size — the user may be mid-edit and a jump/resize is jarring. Just
  // keep it on top. Only a fresh open positions near the cursor.
  if (win.isVisible() || wasHidden) {
    wasHidden = false
    win.show()
    win.focus()
    startContextPoll()
    return
  }

  // Fresh open only — re-triggers over a visible panel, or a restore from
  // hidePanelWindow(), both return above — so this fires once per actual open.
  // The top of the engagement funnel.
  //
  // A tour demo is the one open that isn't usage: the walkthrough shows the real
  // panel so the user sees what the hotkey does, but nobody reached for it. It
  // neither counts in the funnel nor deserves a pre-warmed provider session
  // (which would spend a real backend spawn on a window that's about to close).
  const isTourDemo = source === PANEL_SOURCE_TOUR
  if (!isTourDemo) {
    track(ANALYTICS_EVENT.panel_opened, { source })
  }

  // Position: a welcome open has no meaningful cursor position (it fires right
  // after sign-in/onboarding, not from a hotkey at the user's current focus), so
  // it centers on the active display instead of following the cursor.
  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor)
  // workArea (not bounds) excludes the menu bar + dock, so a cursor near a screen
  // edge still lands the panel fully inside the usable area.
  const work = display.workArea
  // Always open at the compact default size — size is NOT persisted across opens.
  // The user can drag it bigger while it's open (the container fills the slack), but
  // every fresh open resets to PANEL_W × PANEL_H. Position still follows the cursor.
  const w = CONFIG.PANEL_W
  const h = CONFIG.PANEL_H
  // Fresh open = no manual-drag floor; the content auto-fit starts from a clean
  // baseline and grows downward as the thread fills.
  manualFloorH = 0

  let x: number
  let y: number
  if (welcome) {
    x = work.x + (work.width - w) / 2
    y = work.y + (work.height - h) / 2
  } else {
    x = cursor.x + 16
    y = cursor.y + 16
  }

  // Clamp to the work area with margin
  x = Math.min(Math.max(x, work.x + SCREEN_MARGIN), work.x + work.width - w - SCREEN_MARGIN)
  y = Math.min(Math.max(y, work.y + SCREEN_MARGIN), work.y + work.height - h - SCREEN_MARGIN)

  win.setBounds({
    x: Math.floor(x),
    y: Math.floor(y),
    width: w,
    height: h
  })

  win.show()
  win.focus()
  startContextPoll()
}

export function closePanelWindow(): void {
  stopContextPoll()
  const dying = resolvePanelWindow()
  // No eager `panelWindow = null` here: close() only REQUESTS a close, so nulling
  // now leaves a live window with a dead reference if it doesn't complete. The
  // `closed` handler clears it once the window is actually gone.
  if (dying) dying.close()
  wasHidden = false
  yieldIfLastRestorable(dying)
}

// Hide (not close/destroy) the panel — the BrowserWindow and its renderer stay
// alive, so chat state (answerVisible, conversation) survives. The existing
// panel hotkey (⌘⌥⇧M → showPanelWindow) already has a "window exists" branch
// that just show()+focus()s without reseeding, so it doubles as the restore path.
export function hidePanelWindow(opts?: { yieldApp?: boolean }): void {
  const win = resolvePanelWindow()
  if (!win) return
  wasHidden = true
  stopContextPoll()
  win.hide()
  // The yield ends in app.hide() when nothing else is on screen, which hides the
  // whole app, not just this window — and no restore path calls app.show(), so
  // the panel hotkey then brings back a window inside a hidden app. Fine for the
  // dismiss paths that want focus to leave; wrong for an explicit minimize.
  if (opts?.yieldApp !== false) yieldIfLastRestorable(win)
}

/**
 * Where the panel should shrink toward on minimize, as a percentage of its own
 * frame — the format `transform-origin` wants. The panel is skipTaskbar, so it
 * has no Dock tile and macOS gives us no genie; this is how the animation gets a
 * believable destination instead of vanishing in place.
 *
 * The Dock exposes no coordinates, so the edge it sits on is derived from the gap
 * between the display's full bounds and its workArea (workArea excludes the Dock).
 * Values are NOT clamped to 0-100: the Dock is usually outside the panel's frame,
 * and an origin beyond the box is exactly what aims the shrink off-screen at it.
 */
export function getMinimizeOrigin(): { x: number; y: number } {
  const win = resolvePanelWindow()
  const display = win
    ? screen.getDisplayMatching(win.getBounds())
    : screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const { bounds, workArea } = display
  // Dock thickness on each edge. Exactly one is non-zero on a normal setup; the
  // menu bar makes `top` non-zero too, which is why top is never a candidate.
  const left = workArea.x - bounds.x
  const right = bounds.x + bounds.width - (workArea.x + workArea.width)
  const bottom = bounds.y + bounds.height - (workArea.y + workArea.height)
  // Dock centre in screen coords. Auto-hidden Dock leaves every gap at 0, and the
  // bottom-centre fallback is right for that case too (auto-hide lives there).
  let point: { x: number; y: number }
  if (left > right && left > bottom) point = { x: bounds.x, y: bounds.y + bounds.height / 2 }
  else if (right > bottom) point = { x: bounds.x + bounds.width, y: bounds.y + bounds.height / 2 }
  else point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height }

  if (!win) return { x: 50, y: 100 }
  const f = win.getBounds()
  return {
    x: ((point.x - f.x) / f.width) * 100,
    y: ((point.y - f.y) / f.height) * 100
  }
}

let lastYieldAt = 0
const YIELD_ECHO_MS = 500 // overlay showInactive can activate us after app.hide()

/** True in the echo window after we hid ourselves — not a Dock click or ⌘-Tab. */
export function wasJustYielded(): boolean {
  return Date.now() - lastYieldAt < YIELD_ECHO_MS
}

export function yieldToForeignApp(): boolean {
  const previous = currentForeignFrontmostBundleId()
  if (previous === '' || !activateApp(previous)) return false
  lastYieldAt = Date.now()
  return true
}

/** Resign so dismiss is not a Dock click. Restore click-through overlays after. */
export function yieldIfLastRestorable(except?: BrowserWindow | null): void {
  if (process.platform !== 'darwin') return
  const restorable = BrowserWindow.getAllWindows().filter(
    (w) =>
      w !== except &&
      !w.isDestroyed() &&
      w.isFocusable() &&
      (w.isVisible() || w.isMinimized())
  )
  if (restorable.length > 0) {
    console.log(`[surface] yield skip restorable=${restorable.map((w) => w.id).join(',')}`)
    return
  }
  const overlays = BrowserWindow.getAllWindows().filter(
    (w) => w !== except && !w.isDestroyed() && w.isVisible() && !w.isFocusable()
  )
  console.log(`[surface] yield overlays=${overlays.map((w) => w.id).join(',')}`)
  lastYieldAt = Date.now()
  if (overlays.length > 0) {
    const previous = currentForeignFrontmostBundleId()
    if (previous !== '' && activateApp(previous)) {
      lastYieldAt = Date.now() // re-stamp: activateApp blocked ~90ms of the guard
      return
    }
  }
  // Fallback: app.hide() hides the APP, so the restore below mostly does not take.
  app.hide()
  for (const w of overlays) if (!w.isDestroyed()) w.showInactive()
}

// "Back / New" from chat: drop any manual-drag floor and snap the frame back to
// the compact default height. Without this, a session that auto-grew (or was
// dragged) tall stays tall on New, since the content auto-fit can't shrink below
// the stale floor. The next content auto-fit then takes over from a clean baseline.
export function resetPanelHeight(): void {
  const win = resolvePanelWindow()
  if (!win) return
  manualFloorH = 0
  const bounds = win.getBounds()
  if (bounds.height === CONFIG.PANEL_H) return
  win.setBounds({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: CONFIG.PANEL_H
  })
}

export function resizePanelWindow(newH: number, inChat = false): void {
  const win = resolvePanelWindow()
  if (!win) return
  const bounds = win.getBounds()

  // Ceiling = the smaller of the hard cap and how much vertical room the panel
  // actually has on its current display. The window grows DOWNWARD from a fixed y;
  // without the screen check it could grow past the bottom edge, dragging the
  // resize handles + composer off-screen (then you can't drag or resize it). Past
  // this ceiling the window stops growing and the chat thread scrolls internally
  // (it's already `overflow-y:auto` + `flex:1`) — header stays pinned at the top.
  const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y })
  const work = display.workArea
  const roomBelow = work.y + work.height - bounds.y - SCREEN_MARGIN
  const ceiling = Math.min(CONFIG.PANEL_MAX_H, Math.max(CONFIG.PANEL_MIN_H, roomBelow))

  // Content auto-fit: track the renderer's natural content height, but never below
  // a height the user dragged to this session (manualFloorH) — the container fills
  // that slack, so shrinking under it would re-open the gray gap. Clamp to min/ceiling.
  //
  // In CHAT the floor is PANEL_CHAT_MIN_H, not PANEL_MIN_H: the latter is tuned for
  // the compose view (input + hints, no thread). A chat window at PANEL_MIN_H crushes
  // .thread onto its own min-height:80px, which is the cramped first-message panel —
  // the reply then jerks the frame taller as it streams. Floored here in main (not in
  // the renderer's measure pass) so no measure path can route around it.
  const baseFloor = inChat ? CONFIG.PANEL_CHAT_MIN_H : CONFIG.PANEL_MIN_H
  const floor = Math.max(baseFloor, manualFloorH)
  const clampedH = Math.max(floor, Math.min(newH, ceiling))

  // If the panel sits so low that even the clamped height would spill off the
  // bottom, slide y up just enough to fit (still within the work area top margin).
  // Keeps the whole frame — and its drag/resize edges — on screen.
  let y = bounds.y
  const overflow = y + clampedH - (work.y + work.height - SCREEN_MARGIN)
  if (overflow > 0) y = Math.max(work.y + SCREEN_MARGIN, y - overflow)

  if (clampedH === bounds.height && y === bounds.y) return
  win.setBounds({
    x: bounds.x,
    y: Math.floor(y),
    width: bounds.width,
    height: clampedH
  })
}

export function sendToPanelRenderer(channel: string, ...args: any[]): void {
  const win = resolvePanelWindow()
  if (win) win.webContents.send(channel, ...args)
}
