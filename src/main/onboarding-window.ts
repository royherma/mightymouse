import { BrowserWindow } from 'electron'
import { chrome } from './platform'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { CONFIG } from '../shared/config'
import { PREFS } from './store/prefs'
import { track } from './analytics'
import { ANALYTICS_EVENT, type OnboardingSurface } from '../shared/analytics-events'
import { IS_DEV } from '../shared/env'

// The permissions onboarding wizard. Shown right after sign-in and re-shown on
// every launch until the required permissions pass their self-tests (see
// needsOnboarding in macos/permission-tests). While it's up it acts as a hard
// gate: index.ts defers startAppTail() until `onComplete` fires, so hotkeys +
// capture stay off until the user has actually granted what they need.

let onboardingWindow: BrowserWindow | null = null

/** Set by index.ts — releases the app-tail gate once onboarding is finished. */
let onCompleteCb: ((reauth: boolean) => void) | null = null

/** Set by index.ts — the user closed the gate without finishing it. */
let onAbandonCb: (() => void) | null = null

// True only for the window teardown that completeOnboarding() itself performs,
// so the 'closed' handler can tell "finished" from "walked away".
let completing = false

// Whether the currently-open (or most recently opened) wizard was a reauth —
// so completeOnboarding can tell the caller apart from a genuine first run
// without index.ts having to track it separately.
let currentIsReauth = false

export function configureOnboarding(opts: {
  onComplete: (reauth: boolean) => void
  onAbandon: () => void
}): void {
  onCompleteCb = opts.onComplete
  onAbandonCb = opts.onAbandon
}

export function showOnboardingWindow(opts: { reauth?: boolean } = {}): void {
  currentIsReauth = !!opts.reauth
  if (onboardingWindow && !onboardingWindow.isDestroyed()) {
    // Already open — a re-show/focus, not a fresh start. Don't re-fire the event.
    onboardingWindow.show()
    onboardingWindow.focus()
    return
  }

  completing = false

  // Top of the FTUE funnel — pair with onboarding_completed for drop-off. reauth
  // splits a genuine first run from a "perm broke, re-grant" reopen.
  track(ANALYTICS_EVENT.onboarding_started, {
    reauth: currentIsReauth,
    surface: 'onescreen'
  })

  onboardingWindow = new BrowserWindow({
    width: 520,
    height: CONFIG.ONBOARDING_ONE_SCREEN.height,
    title: `Set up ${CONFIG.APP_NAME}`,
    frame: true,
    ...chrome.windowOptions('inset'),
    resizable: false,
    minimizable: true,
    maximizable: false,
    // Keep the wizard in front while it gates — it's the only thing the user
    // can act on until required perms are granted.
    alwaysOnTop: true,
    show: false,
    backgroundColor: CONFIG.THEME_TOKENS.windowBg,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  // reauth=1 marks the "a previously-granted permission just broke" case (see
  // gateAfterAuth in index.ts) so the renderer can swap its header copy instead
  // of reading like a first-run reset. Always a fresh loadFile/loadURL here — the
  // window is destroyed on every close (completeOnboarding/stopAppTail), so the
  // query param is never stale on the reused-window early-return above.
  const query = {
    window: 'onboarding1',
    ...(opts.reauth ? { reauth: '1' } : {})
  }
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    const qs = new URLSearchParams(query).toString()
    onboardingWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?${qs}`)
  } else {
    onboardingWindow.loadFile(join(__dirname, '../renderer/index.html'), { query })
  }

  // The wizard's advance/check decisions are logged from the renderer, which
  // doesn't reach the dev log on its own — without this, debugging a step that
  // won't move means opening DevTools by hand.
  if (IS_DEV) {
    onboardingWindow.webContents.on('console-message', (_e, _level, message) => {
      // eslint-disable-next-line no-console -- intentional dev-only forward
      console.log(`[onboarding-renderer] ${message}`)
    })
  }

  onboardingWindow.on('ready-to-show', () => {
    onboardingWindow?.show()
    onboardingWindow?.focus()
  })

  onboardingWindow.on('closed', () => {
    onboardingWindow = null
    if (completing) return
    onAbandonCb?.()
  })
}

export function lowerOnboardingWindowForGrant(): void {
  const win = onboardingWindow
  if (!win || win.isDestroyed() || !win.isAlwaysOnTop()) return
  win.setAlwaysOnTop(false)
  win.once('focus', () => {
    if (!win.isDestroyed()) win.setAlwaysOnTop(true)
  })
}

// Suppresses onAbandon: every caller is the app closing the gate deliberately.
// The flag is NOT reset here — 'closed' arrives a tick later, so a try/finally
// would clear it before the handler reads it. showOnboardingWindow resets it.
export function closeOnboardingWindow(): void {
  completing = true
  if (onboardingWindow && !onboardingWindow.isDestroyed()) {
    onboardingWindow.close()
  }
  onboardingWindow = null
}

/**
 * Finish onboarding: persist the flag, close the window, and release the gate.
 * Called from the onboardingComplete IPC handler when the user clicks Done.
 */
export function completeOnboarding(surface: OnboardingSurface): void {
  PREFS.setOnboardingComplete(true)
  // Resolves the in-progress marker. Without this the boot gate would keep
  // reopening the wizard at the last step the user was on, forever.
  PREFS.clearOnboardingStep()
  track(ANALYTICS_EVENT.onboarding_completed, { reauth: currentIsReauth, surface })
  closeOnboardingWindow()
  onCompleteCb?.(currentIsReauth)
}
