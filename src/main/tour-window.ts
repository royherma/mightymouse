import { BrowserWindow } from 'electron'
import { chrome } from './platform'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { CONFIG } from '../shared/config'
import { TOUR } from '../shared/tour/constants'
import type { TourSource } from '../shared/tour/types'
import { PREFS } from './store/prefs'
import { disarmProbe, setTourDemoHooks, setTourWindowRef } from './tour-hotkey-probe'
import { endTourDemo, startTourDemo } from './tour-demo'
import { route } from './routing'
import { track } from './analytics'
import { ANALYTICS_EVENT } from '../shared/analytics-events'

// Wire the probe's live-demo hooks here rather than inside the probe itself:
// this module already depends on 'electron', so it's the right side of the
// import boundary the probe's header describes. Registered once at module load.
setTourDemoHooks({ start: startTourDemo, end: endTourDemo })

// The value tour — a short, beautiful walkthrough of the 3 core hotkeys, shown
// once after the permissions wizard and re-openable from the tray.
//
// NOT a gate: alwaysOnTop:false, normal traffic lights, and the app tail runs
// regardless. Tried the soft-gate version (alwaysOnTop + closable:false) and
// reverted it — hiding the traffic lights leaves hiddenInset's title strip still
// reserved, so the header floated in an empty bar and the whole window read as
// broken. Not worth the exposure win.
//
// A HARD gate was never on the table either: the confirm steps need a real
// keypress and tour_key_timed_out exists because those sometimes fail, so
// no-exit-until-complete would brick the app on a flaky TCC grant. The
// permissions wizard can gate because it IS the fix for its own failure; the
// tour can't fix a dead chord.
//
// Any dismissal (Done, Skip, or the red-X) marks the tour seen so it never
// auto-shows again.

let tourWindow: BrowserWindow | null = null

// Lets `closed` tell an explicit Done/Skip from a red-X dismissal, which must
// not hand off. Reset in showTourWindow.
let completing = false

export function showTourWindow(source: TourSource): void {
  if (tourWindow && !tourWindow.isDestroyed()) {
    tourWindow.show()
    tourWindow.focus()
    return
  }

  completing = false

  const win = new BrowserWindow({
    // Landscape on purpose. The old 480x540 portrait card forced every element
    // to shrink to fit one narrow column — the hotkeys the tour exists to teach
    // ended up the smallest thing on screen. Fits a 1280x800 MacBook Air with
    // room to spare.
    width: 900,
    height: 620,
    title: `How to use ${CONFIG.APP_NAME}`,
    frame: true,
    ...chrome.windowOptions('inset'),
    resizable: false,
    minimizable: true,
    maximizable: false,
    // Purely educational — let the user click away to try things. Not a gate.
    alwaysOnTop: false,
    show: false,
    backgroundColor: CONFIG.THEME_TOKENS.windowBg,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  tourWindow = win
  setTourWindowRef(win)

  const query = { window: TOUR.WINDOW, source }
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?window=${TOUR.WINDOW}&source=${source}`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { query })
  }

  win.on('ready-to-show', () => {
    win.show()
    win.focus()
  })

  // Any close (incl. the red-X) counts as "seen" — the tour is informational,
  // so dismissing it shouldn't make it nag again on the next launch.
  win.on('closed', () => {
    PREFS.setTourSeen(true)
    if (!completing) track(ANALYTICS_EVENT.tour_handoff, { to: 'none', dismissed: true })
    tourWindow = null
    setTourWindowRef(null)
    // Belt-and-braces: an armed probe that outlives the window would
    // silently swallow a real hotkey press forever. A crashed/closed renderer
    // must not strand it armed. disarmProbe() also tears down any live demo
    // surface, so closing the tour mid-demo can't strand a panel or HUD card.
    disarmProbe()
  })
}

/** The live tour window, or null. Used by tour-hotkey-probe.ts to push probe
 * events and by capture-hotkey.ts-adjacent checks for focus state. */
export function getTourWindow(): BrowserWindow | null {
  return tourWindow
}

/** Push an event to the tour renderer, if it's open. Mirrors
 * settings-window.ts's sendToSettingsRenderer — the tour is a second listener
 * for feature status the Settings card already receives (phone-remote's
 * connected/disconnected broadcast), and the phone-pairing step confirms on it.
 * No-ops when the tour is closed, which is the common case. */
export function sendToTourRenderer(channel: string, ...args: unknown[]): void {
  if (tourWindow && !tourWindow.isDestroyed()) {
    tourWindow.webContents.send(channel, ...args)
  }
}

export function closeTourWindow(): void {
  if (tourWindow && !tourWindow.isDestroyed()) {
    tourWindow.close()
  }
  tourWindow = null
}

/** Finish the tour on an explicit Done/Skip, then hand off to the panel — without
 * it the last step closed onto an empty screen. NOT on the red-X path: a
 * dismissal shouldn't summon a window the user just closed. */
export function completeTour(): void {
  PREFS.setTourSeen(true)
  completing = true
  closeTourWindow()

  // After `closed`, whose demo teardown would otherwise close a panel the tour's
  // live demo had already opened.
  setTimeout(() => {
    track(ANALYTICS_EVENT.tour_handoff, { to: 'panel', dismissed: false })
    route('panel', { panelSource: 'welcome', welcome: 'new' })
  }, CONFIG.POST_ONBOARDING_MS)
}
