// Tour live demos — the payoff for pressing a hotkey correctly during the
// walkthrough. See prds/active/2026-07-22-1784702216-tour-live-demos.md.
//
// THE RULE: real components, fake payload.
//
// The user sees the genuine panel window and the genuine HUD card, because a
// tour-only mock of either would drift from the real thing the moment someone
// restyled it. What's faked is everything with a consequence: no selection grab,
// no LLM call, no ffmpeg, no mic device, no clipboard write, no usage analytics.
//
// This is NOT "let the real handler run". The three handlers differ sharply in
// blast radius: the panel just opens a window, but capture writes files and can
// leave a recording live, and listen opens the mic and PASTES its result into
// whatever the user had focused. A stray paste into someone's document is the
// worst thing this tour could do, so the listen demo never touches the mic.
//
// The card also RESOLVES: it holds its loading beat for DEMO_HUD_DONE_AFTER_MS
// (700ms), then flips to the success state and sits there for the rest of the
// step's TOUR_DEMO_ADVANCE_MS (2.6s) — so ~1.9s of "captured" / "transcribed"
// is what the user actually reads. A card frozen mid-capture reads as broken,
// and the finished state is the half worth demoing.
//
// Lifecycle: a demo ends when the tour leaves the step (endTourDemo). Teardown-
// on-step-change is mandatory, not a nicety — it's
// the same class of bug as the armed-probe leak in tour-hotkey-probe.ts. A demo
// surface that outlives its step is a window the user can't explain and the tour
// no longer owns, so every probe-disarm path calls endTourDemo() too.
//
// Deliberately no import of tour-window.ts here (same reasoning as the probe's
// header): tour-window.ts imports the probe, the probe imports this, and pulling
// the window back in would close the circle.
import { PANEL_SOURCE_TOUR } from '../shared/analytics-events'
import { HUD_CAPTURE, HUD_MODE } from '../shared/types'
import { TOUR } from '../shared/tour/constants'
import { hasLiveDemo } from '../shared/tour/types'
import type { ShortcutId } from '../shared/shortcuts'
import { hidePanelWindow, isPanelVisible } from './panel-window'
import { route } from './routing'
import { dismissHud, doneHud, startHud } from './hud-window'

// The single demo surface currently on screen, if any. One at a time by
// construction — a step change tears the previous one down before arming the
// next, so there's never a second to track.
let liveDemo: { kind: 'panel' } | { kind: 'hud'; runId: string } | null = null

// Pending "flip the card to its success state" timer. Held at module scope so
// teardown can cancel it: without this, tearing a demo down inside the loading
// beat would still fire doneHud a moment later, on a card that no longer exists
// (harmless) or — worse, after a fast step change — on the NEXT step's card.
let doneTimer: NodeJS.Timeout | null = null

/** Flip the demo card from its loading beat to the finished result. This is the
 *  half of the HUD worth showing: a card frozen mid-capture reads as broken.
 *  Purely presentational — doneHud writes no history and fires no analytics, and
 *  its cheese/phone side effects both guard on run-id shapes a `tour-demo:` id
 *  can never match. */
function scheduleDemoDone(runId: string, shortcutId: ShortcutId): void {
  doneTimer = setTimeout(() => {
    doneTimer = null
    // The step may have moved on during the loading beat — only finish the card
    // that's still the live demo.
    if (liveDemo?.kind !== 'hud' || liveDemo.runId !== runId) return

    const isListen = shortcutId === 'listen'
    doneHud(
      runId,
      true,
      isListen ? TOUR.DEMO_HUD.listenDoneSummary : TOUR.DEMO_HUD.captureDoneSummary,
      // No revealPath: there's no file on disk, so a click must not try to
      // reveal one in Finder.
      null,
      undefined,
      // `sticky` so the card can't auto-dismiss itself out from under the step —
      // the tour owns this card's lifetime, and endTourDemo is what closes it.
      isListen ? { body: TOUR.DEMO_HUD.listenDoneBody, sticky: true } : { sticky: true }
    )
  }, TOUR.DEMO_HUD_DONE_AFTER_MS)
}

/** Fake run id for the demo HUD card. Namespaced so it can't collide with a
 *  real run's uuid, and so a stray dismissHud on it is always a no-op. */
function demoRunId(shortcutId: ShortcutId): string {
  return `${TOUR.DEMO_RUN_ID_PREFIX}${shortcutId}`
}

/**
 * Show the real surface behind `shortcutId`, with no side effects. Called when
 * the tour probe registers a correct press. Unknown/unmapped ids are a no-op —
 * a step without a demo simply doesn't get one.
 */
export function startTourDemo(shortcutId: ShortcutId): void {
  endTourDemo()

  // Guard on the SAME list the renderer uses to pick its advance delay. If this
  // ever shows a demo for an id the renderer thinks has none, the tour advances
  // on the short beat and kills the surface in the same blink it appeared.
  if (!hasLiveDemo(shortcutId)) return

  if (shortcutId === 'main') {
    // If the user already had their own panel open before the tour reached this
    // step, leave it entirely alone — showing it is a no-op anyway, and the
    // teardown below would otherwise CLOSE a window (and dispose the warm
    // sessions behind it) that was never ours to touch.
    if (isPanelVisible()) return

    // The real panel, opened empty: no prepareContextTrigger (so no selection is
    // consumed) and no reseed push. PANEL_SOURCE_TOUR is what suppresses the
    // panel_opened event + the provider pre-warm inside showPanelWindow.
    route('panel', { panelSource: PANEL_SOURCE_TOUR })
    liveDemo = { kind: 'panel' }
    return
  }

  // Capture + listen both render the real HUD card, differing only in the mode
  // that drives its chrome. Neither starts a process: startHud only opens the
  // card window, so a card with no run behind it just sits there looking correct.
  const runId = demoRunId(shortcutId)
  if (shortcutId === 'capture') {
    startHud(runId, TOUR.DEMO_HUD.captureTitle, TOUR.DEMO_HUD.captureSubtitle, HUD_MODE.screenshot)
    liveDemo = { kind: 'hud', runId }
    scheduleDemoDone(runId, shortcutId)
    return
  }
  if (shortcutId === 'listen') {
    startHud(
      runId,
      TOUR.DEMO_HUD.listenTitle,
      TOUR.DEMO_HUD.listenSubtitle,
      HUD_MODE.recording,
      HUD_CAPTURE.listen
    )
    liveDemo = { kind: 'hud', runId }
    scheduleDemoDone(runId, shortcutId)
  }
}

/**
 * Tear down whatever demo is on screen. Safe to call when there's nothing live
 * (the common case), so every probe-disarm path can call it unconditionally.
 */
export function endTourDemo(): void {
  // Cancel the pending success flip FIRST, and unconditionally — a demo torn
  // down inside its loading beat must not have doneHud fire afterwards.
  if (doneTimer) {
    clearTimeout(doneTimer)
    doneTimer = null
  }
  if (!liveDemo) return
  const demo = liveDemo
  // Cleared BEFORE the teardown call so a re-entrant path (a window 'closed'
  // handler firing synchronously) can't recurse back in here.
  liveDemo = null

  if (demo.kind === 'hud') {
    dismissHud(demo.runId)
    return
  }
  // Reaching here means `liveDemo` was set, i.e. WE opened this panel (startTourDemo
  // bails before recording one it didn't open). That matters because hidePanelWindow
  // closes the window and disposes its warm sessions — doing that to a panel the
  // user opened themselves would destroy their chat state.
  if (isPanelVisible()) hidePanelWindow()
}

/** True while a tour demo surface is on screen — for tests + assertions. */
export function isTourDemoLive(): boolean {
  return liveDemo !== null
}
