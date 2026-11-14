// MUST stay the first import: it applies the admin's runtime env override before
// CONFIG resolves the Supabase project. See env-bootstrap.ts.
import './env-bootstrap'
import { startModelCatalogRefresh } from './model-catalog'
import { setDefaultResultOrder } from 'node:dns'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import {
  app,
  Menu,
  Tray,
  nativeImage,
  BrowserWindow,
  screen,
  session,
  systemPreferences
} from 'electron'
import { initializePaths, cleanupTmp } from './store/paths'
import { HISTORY, reconcileHistoryEncryption } from './store/history'
import { MIGHTY } from './store/mighty'
import { registerIpcHandlers, buildPanelInitData, runStartupBackendProbe } from './ipc'
import type { BackendId } from './backend/adapters'
import { applyDockIcon, applyDevDockIcon, devTrayIcon } from './dock'
import { triggerRewritePanel, prepareContextTrigger } from './hotkeys'
import {
  closePanelWindow,
  getPanelWindow,
  sendToPanelRenderer,
  needsPanelReseed,
  wasJustYielded
} from './panel-window'
import { setCursorCompanion, startCursorCompanion } from './cursor-window'
import { startActControlServer, stopActControlServer } from './act-control'
import { showDeckWindow } from './deck-window'
import { canvasWindowShown, showCanvasWindow, toggleCanvasWindow } from './canvas-window'
import {
  setIslandWindow,
  isIslandWindowRunning,
  pushIslandActivity,
  registerIslandIpc
} from './island-window'
import { setCompanionMicPaused, setCompanionWindow } from './companion-window'
import { setLiveSession } from './capture/live-listen'
import { initActivity } from './activity'
import { createSoundWindow, playSound } from './sound-window'
import { showSettingsWindow } from './settings-window'
import { showCheatSheetWindow } from './cheatsheet-window'
import { showPlaygroundWindow } from './playground-window'
import { showAnalyticsWindow } from './analytics-window'
import {
  setSetupPreviewBroken,
  isSetupPreviewBroken,
  ensureParakeetInBackground,
  ensureFfmpegInBackground
} from './setup-check'
import { isPreviewingAsUser, setPreviewAsUser } from './admin-preview'
import { showResourcesWindow } from './resources-window'
import { startResourceRecording } from './ipc/resources'
import { showActionsWindow } from './actions-window'
// The Library is a composer tab now (see the tray's 'Media Library…' entry). The
// standalone window still exists behind ?window=media if it ever wants to come back.
// import { showMediaLibraryWindow } from './media-library-window'
import { showMightyWindow, getMightyWindow, getMightyZoomLevel, setMightyZoomLevel } from './mighty/mighty-window'
import { zoomLevelToPercent } from '../shared/zoom'
import { startMightyScheduler, stopMightyScheduler } from './mighty/scheduler'
import { setBugReportWindowOpener } from './crash'
import { showBugReportWindow } from './bug-report-window'
import { showSpecialistWindow } from './specialist'
import { replyWindowFocused, toggleReplyWindow } from './reply-window'
import { startReplyFocusTracking } from './reply-focus'
import { registerMediaScheme, registerMediaProtocol } from './media-protocol'
import { installDevServerGuard } from './dev-server-guard'
import { showAuthWindow, closeAuthWindow, getAuthWindow } from './auth-window'
import { getSupabase } from './supabase'
import { startWebMacPresence, stopWebMacPresence } from './web-mac-presence'
import { startWebProjectsSync, stopWebProjectsSync } from './web-projects-sync'
import { startWebChatSync, stopWebChatSync } from './web-chat-sync'
import { closeOnboardingWindow, configureOnboarding } from './onboarding-window'
import { showOnboardingOneScreenPreview } from './onboarding-one-screen-window'
import { route, configureRouting, markOnboardingAbandoned } from './routing'
import { replayFirstRun } from './ftue-replay'
import { TOUR } from '../shared/tour/constants'
import type { WelcomeVariant } from '../shared/types'
import { needsOnboarding, applyLoginShellPath, context } from './platform'
import {
  startCapture,
  stopCapture,
  isCaptureHotkeyAvailable,
  killOrphanedCaptureChildren
} from './capture'
import { recoverInterruptedRecordings } from './capture/recording-recovery'
import { ensureScreenPermission, getMirrorSources, SCREEN_ACTION } from './capture/screen-permission'
import { startContextLogging, stopContextLogging } from './capture/context-logger'
import { applySelectionWatcher, stopSelectionWatcher, summonSelectionBar } from './selection-watcher'
import { bindInAppNavigatorKey, toggleNavigatorWindow } from './navigator-window'
import { registerNavigatorIpc } from './navigator-run'
import {
  startInsightsManager,
  stopInsightsManager,
  triggerInsightsNow,
  triggerSuggestNow
} from './insights/insights-manager'
import { prewarmDeviceCache } from './capture/devices'
import { ensureParakeetServer, disposeParakeetServer } from './capture/parakeet-server'
import { prewarmVoiceRouteWindow, voiceRouteCardOpen } from './voice-route-window'
import { hudCardInUse, noteAppActive } from './hud-window'
import { ensureNativeMicDaemon } from './capture/native-mic'
import { getVirtualDisplay, stopVirtualDisplay } from './capture/virtual-display'
import { isScreenStreamRunning } from './capture/screen-stream'
import { prewarmAllShellBackends, startIdleReprewarmLoop, abortAllRuns } from './backend/runner'
import { chatBrowserTools } from './agent-relay/mcp/browser-tools'
import { UNREAD } from './store/unread'
import {
  initAuth,
  configureAuth,
  getSession,
  signOut as authSignOut,
  AuthUser,
  signInTestAdmin,
  withTimeout,
  isCurrentUserAdmin
} from './auth'
import {
  track,
  trackError,
  trackSessionStart,
  startAnalyticsFlushLoop,
  flushAnalyticsNow
} from './analytics'
import { ANALYTICS_EVENT } from '../shared/analytics-events'
import { PREFS } from './store/prefs'
import { SETTINGS } from './store/settings'
import { installCrashHandlers } from './crash'
import { setupAutoUpdater, getUpdateState, onUpdateStateChange, updaterIpc } from './updater'
import { handleDeepLink } from './deeplink'
import { CONFIG } from '../shared/config'
import { startPhoneRemoteServerDefault, applyEnvSwitch } from './ipc/phone-remote'
import { startIdleTrigger, stopIdleTrigger } from './actions/idle-trigger'
import { logComputerUseQuit } from './actions/computer-use/loop'
import { offerIdleActions } from './voice-routing/offer'
import { stopPhoneRemoteServer } from './phone-remote/server'
import { liveAgentSessions, startAgentRelayMcp, stopAgentRelayMcp } from './agent-relay/mcp/http-listener'
import { adoptCoordinationHooks } from './ipc/agent-relay'
import { startActiveCopy, stopActiveCopy, activeCopyMenuItems } from './active-copy'
import { startFactoryCoordinator } from './agent-relay/factory/scheduler'
import { startCloudAnswerPolling, stopCloudAnswerPolling } from './agent-relay/cloud-answers'
import { stopTunnelSync } from './phone-remote/cloudflare-tunnel'
import { stopStayAwake } from './phone-remote/stay-awake'
import { revertClamshellOnLaunch, disableClamshell, setClamshellAgentProbe } from './phone-remote/clamshell'
import { clearIdleLockSuppressionOnLaunch } from './phone-remote/idle-lock-suppressor'
import { handback, beginAwayMode, isAwayModeHeld, startAwayModeLockWatch } from './phone-remote/away-mode'
import { releaseDefaultInput } from './capture/phone-mic-device'
import { IS_DEV, IS_DEVTEST, envVar } from '../shared/env'
import { CHANNELS } from '../shared/ipc'
import { HIDEOUT_NAME } from '../shared/hideout'
import { openHideout } from './hideout'
import iconAsset from '../../resources/icon.png?asset'
// Dedicated monochrome menu-bar glyph. The `Template` filename suffix makes macOS
// auto-recolor it for light/dark menu bars; @2x is picked up alongside it for retina.
import trayIconAsset from '../../resources/trayTemplate.png?asset'

// Dev-only: expose a CDP port so `npm run dev:console` can read the renderer console
// + DOM over the wire (renderer errors never hit the dev-server stdout — a blank
// window is a thrown error visible only here). Never enabled in a packaged build.
// :9322 not the Chromium default :9222 — MightyMouse's port lane, so a second
// Electron project's DevTools can't collide (see electron.vite.config.ts).
if (IS_DEV) app.commandLine.appendSwitch('remote-debugging-port', envVar('MM_CDP_PORT') || '9322')

// Encoder bitrate floor — tuning protocol design (run log
// there is the record). Without a floor goog-cc drops to its internal 30k
// (0-1fps) on any link dip and never climbs back; 800k overran the link into
// 24% loss (REVERTED); 150k held 7.6fps stable with falling loss. The floor
// must stay under the degraded link's real budget (~184-300k observed).
// GLOBAL to every peer connection, phone mirror included.
// Do NOT add WebRTC-Bwe-LossBasedBweV2/Enabled:false again: tried Run 10-11
// it let target follow estimate in good phases but on a bad-link
// phase the sender kept pushing into the choked pipe -- loss went 1% -> 29%
// (#7Q3M). The loss brake is what keeps bad-link loss at ~1%.
app.commandLine.appendSwitch('force-fieldtrials', 'WebRTC-Video-MinVideoBitrate/Enabled,br:200kbps/')
// Force IPv4-first DNS resolution for the main process. Node 20+ defaults to
// 'verbatim' order, which returns IPv6 (incl. IPv4-mapped ::ffff: addresses)
// first. Supabase (Cloudflare-fronted) resolves to an IPv4-mapped IPv6 address;
// on networks without a working IPv6 path, undici's fetch tries IPv6 first and
// dies with ECONNRESET/ENOTFOUND — silently breaking edge-function POSTs
// (checkout, portal) while curl/other tools that prefer IPv4 work fine. This one
// line makes undici prefer the reachable IPv4 address. Set before any fetch runs.
setDefaultResultOrder('ipv4first')

let tray: Tray | null = null

// The tray menu is a native NSMenu — invisible to getAllWindows(), yet opening
// it fires did-become-active. menu-will-show/close is the only positive signal
// that the user asked for the tray, not the app UI.
let trayMenuOpen = false
let trayMenuClosedAt = 0
let trayMenuShownAt = 0
// Set on resign. Last-window hide also fires did-become-active while still frontmost.
let userLeft = false
// A refresh that arrives while the menu is open is deferred to menu-will-close:
// swapping a live NSMenu cancels its tracking, which snaps the menu shut.
let trayRefreshPending = false

function trackTrayMenu(menu: Menu): Menu {
  menu.on('menu-will-show', () => {
    trayMenuOpen = true
    trayMenuShownAt = Date.now()
    console.log(`[surface] tray menu-will-show t=${Date.now()}`)
  })
  menu.on('menu-will-close', () => {
    trayMenuOpen = false
    trayMenuClosedAt = Date.now()
    console.log(`[surface] tray menu-will-close t=${Date.now()}`)
    if (trayRefreshPending) {
      trayRefreshPending = false
      refreshTrayMenu()
    }
  })
  return menu
}
let tailStarted = false
// Cached signed-in user so the (synchronous) tray menu can show "Signed in as …"
// without awaiting getSession(). Kept fresh by the auth broadcast callback.
let currentUser: AuthUser | null = null

function isAdminEmail(email: string): boolean {
  return CONFIG.ADMIN_EMAILS.map((e) => e.toLowerCase()).includes(email.toLowerCase())
}
const isMac = process.platform === 'darwin'

// Register the app's URL scheme (mightymouse:// in prod/dev, mightymouse-staging://
// in a staging-flagged packaged build — see CONFIG.PROTOCOL_SCHEME) so Stripe
// checkout can redirect back into the app. A staging build MUST use its own scheme:
// two installed apps registering the same scheme would race for the OS handler, so
// whichever installed last silently steals the other's checkout returns. Must run
// BEFORE whenReady so macOS has a handler for a cold-start open-url. Only a
// packaged build registers reliably; see deeplink.ts for the dev caveat.
// setAsDefaultProtocolClient is idempotent.
app.setAsDefaultProtocolClient(CONFIG.PROTOCOL_SCHEME)

// Deep links buffered until the app is ready (macOS can deliver open-url during a
// cold start, before any window exists). Drained in whenReady.
let appReady = false
const pendingDeepLinks: string[] = []
function routeDeepLink(url: string): void {
  if (appReady) void handleDeepLink(url)
  else pendingDeepLinks.push(url)
}

// macOS delivers custom-scheme URLs via open-url (both cold start and while running).
app.on('open-url', (event, url) => {
  event.preventDefault()
  routeDeepLink(url)
})

// win/linux deliver the URL as the last argv item, not via open-url.
function deepLinkFromArgv(argv: string[]): string | undefined {
  return argv.find((arg) => arg.startsWith(`${CONFIG.PROTOCOL_SCHEME}://`))
}

/**
 * The gated app tail: hotkeys, capture, cursor companion, context log. NOT
 * started until the user is signed in. When signed out, the uiohook watcher is
 * never running, so every hotkey is inert — this IS the hard gate.
 */
function startAppTail(welcome?: WelcomeVariant): void {
  if (tailStarted) return
  tailStarted = true
  startWebMacPresence()
  startWebProjectsSync()
  startWebChatSync()

  prewarmDeviceCache()
  // Native mic path: start the resident helper now so every press, including
  // the first, is only a ~180 ms HAL start instead of a ~1 s process cold-open.
  if (PREFS.getUseNativeMic()) ensureNativeMicDaemon()
  // Holds the 680 MB parakeet model in memory so a press doesn't re-pay the
  // process + dylib + model load the CLI pays every single time.
  ensureParakeetServer()
  // A pre-started chat process connects to its tools once, at spawn: the door must be listening first.
  void chatBrowserTools().then(prewarmAllShellBackends)
  startIdleReprewarmLoop()
  prewarmVoiceRouteWindow()
  context.pinFrontmostWatch()
  // The actions both the chords and the navigator overlay fire. Defined once
  // here; startCapture and registerNavigatorIpc below both read this object.
  const sharedActions = {
    // Main-panel hotkey: grabs selection + context. Capture BEFORE showing (the
    // panel's focus would otherwise make captureContext report the panel itself),
    // stash it as trigger data, then show. A fresh open consumes it via
    // getInitialData on mount; an already-VISIBLE panel won't re-mount, so push a
    // reseed. Only reseed when it was visible — a hidden/closed panel seeds on
    // mount, and reseeding too would double-consume and clobber the selection.
    onMain: async () => {
      const wasOpen = needsPanelReseed()
      await prepareContextTrigger()
      route('panel', { panelSource: 'hotkey' })
      if (wasOpen) {
        sendToPanelRenderer(CHANNELS.panelReseed, await buildPanelInitData())
      }
    },
    // Suggest hotkey: pop a fresh suggestion bubble for the current context on
    // demand. Works even when idle suggestions are OFF — start the overlay +
    // manager lazily (both idempotent), then fire a manual prediction that runs
    // the deeper memory search. The companion art only draws when its own pref is
    // on, so this never shows an uninvited animated pointer.
    onSuggest: () => {
      // Audible "got it, generating" cue the moment the shortcut is recognized,
      // before the (slower) prediction starts — pairs with the loading bubble.
      playSound('thinking')
      startCursorCompanion()
      startInsightsManager()
      triggerSuggestNow()
    },
    // Stop: the panic button. SIGKILL every in-flight agent run so it stops
    // touching the screen immediately. Each killed CLI's close handler runs the
    // normal failure path (the HUD/panel shows the run as stopped), so there's no
    // result-routing to do here — just kill + a confirming cue.
    onStop: () => {
      const killed = abortAllRuns()
      if (killed > 0) playSound('error')
    },
    // Summons the bar at the cursor on demand. Press again to dismiss, so the
    // same key both opens and closes it.
    onToggleSelectionBar: () => {
      void summonSelectionBar()
    }
  }

  const ok = startCapture({
    ...sharedActions,
    onRewrite: async () => {
      // The rewrite hotkey captures selection + context (triggerRewritePanel)
      // before opening. If the panel was already VISIBLE, re-triggering over a new
      // app must override its stale context/selection — the renderer only fetches
      // initial data on mount, so push a fresh payload over panelReseed. A panel
      // that wasn't on screen seeds itself via getInitialData on mount; reseeding
      // it too would double-consume the trigger data and clobber the selection.
      const wasOpen = needsPanelReseed()
      await triggerRewritePanel()
      if (wasOpen) {
        sendToPanelRenderer(CHANNELS.panelReseed, await buildPanelInitData())
      }
    },
    // Chat: open the full Mighty chat window (the roomy composer). Same entry the
    // tray "Chat with Mighty…" item uses — creates or focuses the single window.
    onChat: () => showMightyWindow(),
    // Navigator: the find-anything overlay. Same toggle shape as the bar above.
    onNavigator: () => {
      toggleNavigatorWindow()
    },
    onToggleVoice: toggleVoiceMode,
    onReply: () => void toggleReplyWindow(),
    onCanvas: () => {
      void isCurrentUserAdmin().then((admin) => admin && toggleCanvasWindow())
    }
  })

  startReplyFocusTracking()

  // Every row the navigator can run routes back through these same handlers,
  // so a chord and its navigator row are never two code paths.
  registerNavigatorIpc(sharedActions)

  if (!ok) {
    console.error('Hotkey watcher failed to start (uiohook unavailable / Accessibility?)')
  }

  // The cursor overlay also hosts the experimental suggestion bubble, so it must
  // be up when EITHER the companion or experimental suggestions are enabled. The
  // pointer art only draws when the companion pref is on (sent on ready-to-show),
  // so enabling insights alone never shows an uninvited animated pointer.
  if (PREFS.getCursorCompanion() || PREFS.getExperimentalSuggestions()) startCursorCompanion()
  if (PREFS.getDynamicIsland()) setIslandWindow(true)
  if (PREFS.getLiveMode()) setCompanionWindow(true)
  if (PREFS.getContextLog()) startContextLogging()
  applySelectionWatcher()
  if (PREFS.getExperimentalSuggestions()) startInsightsManager()
  if (PREFS.getPhoneRemoteEnabled()) void startPhoneRemoteServerDefault()
  startActiveCopy({
    onChange: refreshTrayMenu,
    claim: async () => {
      if (!PREFS.getAgentRelayEnabled()) return true
      if (!(await startAgentRelayMcp()).ok) return false
      void adoptCoordinationHooks().catch((e) => console.error('[coordination] re-pointing hooks failed', e))
      return true
    },
    release: stopAgentRelayMcp
  })
  // Unconditional, unlike the line above: the poll self-gates on the same pref
  // every tick, so turning the relay on mid-session starts collecting answers
  // without a restart. An idle tick costs one boolean and no network.
  startCloudAnswerPolling()
  try {
    startFactoryCoordinator()
  } catch (error) {
    console.error('Factory coordinator failed to start', error)
  }
  // Unconditional for the same reason: every tick re-reads both action prefs, so
  // switching Actions on mid-session works without a restart. Idle ticks cost a
  // clock read until the user actually goes still.
  startIdleTrigger(offerIdleActions)

  // Proactive backend health check: catches "claude CLI not found" BEFORE the
  // user's first hotkey run dead-ends silently. Runs every time the tail starts
  // (fresh launch with onboarding already done, OR right after onboarding just
  // finished) — cheap (a --version + auth check), so no harm running it twice.
  void runStartupBackendProbe()

  // Background retry-flush so buffered events aren't lost waiting for the next
  // track() call (which may never come before quit).
  startAnalyticsFlushLoop()
  // 'new' is the only genuine first-run signal — a reauth or a normal signed-in
  // relaunch both resolve to 'returning'. This is the cohort anchor the funnel
  // uses to split activation + retention by new-vs-returning.
  trackSessionStart(welcome === 'new')
  refreshTrayMenu()

  // Mighty (standing personal agent): start the tick loop. Jobs are user-created
  // only — nothing is seeded. The loop runs an immediate catch-up pass so a job
  // whose window elapsed while the app was quit fires now, not tomorrow.
  startMightyScheduler()

  // Exactly ONE thing takes the screen after the tail goes live. Which one is
  // routing's call (TourSeen decides); the delay is this path's, so the window
  // doesn't race the tail's own startup work.
  setTimeout(() => route('postOnboarding', { welcome }), CONFIG.POST_ONBOARDING_MS)
}

function stopAppTail(): void {
  if (!tailStarted) return
  tailStarted = false
  stopWebMacPresence()
  stopWebProjectsSync()
  stopWebChatSync()
  stopCapture()
  stopContextLogging()
  stopSelectionWatcher()
  stopInsightsManager()
  stopMightyScheduler()
  setCursorCompanion(false)
  setIslandWindow(false)
  setCompanionWindow(false)
  stopPhoneRemoteServer()
  stopStayAwake()
  void disableClamshell()
  // Signing out hands the Mac back: the consent that held it open belonged to
  // the account that just left.
  void handback()
  stopIdleTrigger()
  stopCloudAnswerPolling()
  stopActiveCopy()
  stopAgentRelayMcp()
  closeOnboardingWindow()
  refreshTrayMenu()
  showAuthWindow()
  const auth = getAuthWindow()
  for (const win of BrowserWindow.getAllWindows()) {
    if (win !== auth && !win.isDestroyed()) win.destroy()
  }
}

/**
 * Post-auth gate: a signed-in user only gets the app tail (hotkeys/capture)
 * once the required permissions actually work. Otherwise we show the onboarding
 * wizard, which calls completeOnboarding() → onComplete → startAppTail() when
 * the user is done. Hotkeys genuinely don't function without these perms, so
 * deferring the tail matches reality rather than starting a dead watcher.
 */
async function gateAfterAuth(): Promise<void> {
  // needsOnboarding runs a macOS permission self-test per required key; one can
  // wedge when a permission is undetermined and freeze boot before the tray +
  // hotkeys register. Cap it — on timeout assume onboarding IS needed (true), the
  // safe default: a hung probe most likely means the permission isn't granted, and
  // it lands the user on a real window instead of a frozen background process.
  const onboard = await withTimeout(
    needsOnboarding(PREFS.getOnboardingComplete()),
    CONFIG.ONBOARDING_GATE_TIMEOUT_MS,
    true
  )

  // Did WE just restart the app to clear a stale Screen Recording TCC cache
  // (setup-check.ts)? Then the user was mid-fix in the Setup window, and a
  // silent cold boot loses that thread — the whole point of the restart was to
  // make the row they pressed turn green in front of them.
  const resumingSetup = PREFS.consumeSetupResume()

  // A wizard the user never finished outranks the permission probe. needsOnboarding
  // only re-gates on REQUIRED permissions, and Screen Recording is deliberately
  // optional (permissions.ts) — so a user who quit on that step to clear its TCC
  // cache came back "not needing onboarding" and landed on the panel mid-wizard.
  const unfinishedStep = PREFS.getOnboardingComplete() ? null : PREFS.getOnboardingStep()

  // Genuinely new (no completed onboarding, no legacy wizard step) → first-run, not the old wizard.
  const genuinelyNew = !PREFS.getOnboardingComplete() && !unfinishedStep

  if (genuinelyNew) {
    startAppTail('new')
    route('firstRun')
  } else if (onboard || unfinishedStep) {
    // If onboarding was already marked complete, we only got here because a
    // required permission's self-test just failed (revoked in System Settings,
    // OS update reset TCC, etc.) — distinct from a genuine first run. The wizard
    // uses this to swap its header copy so it doesn't read as a broken reset.
    route('onboarding', { reauth: PREFS.getOnboardingComplete() })
    // Setup last so it lands ON TOP of the wizard: it owns the row being fixed,
    // and the wizard behind it is still the gate the user returns to.
    if (resumingSetup) route('setup')
  } else {
    // Permissions already valid — this is the "returning user" case that used to
    // show nothing at all after sign-in.
    startAppTail('returning')
    // The restart worked: the row that forced it is now green. Show that rather
    // than dropping the user on a silent desktop with no proof anything changed.
    if (resumingSetup) route('setup')
  }
  closeAuthWindow()
}

// Header → [env banner] → separator. In staging a disabled "● STAGING" line
// makes the connected backend unmistakable; in prod it's just the separator
// (clean menu). Either way the menu structure below the header is identical.
const envBanner: Electron.MenuItemConstructorOptions[] = [
  ...(CONFIG.IS_STAGING
    ? [{ label: `● ${CONFIG.ENV_NAME.toUpperCase()}`, enabled: false } as const]
    : []),
  { type: 'separator' as const }
]

// Staging-only: a tray switch that auto-signs-in a seeded test-admin (real
// Supabase password flow → real JWT) so we can work without the login step.
// Each account carries its own credits and off-LAN allowance, so switching is
// how you keep testing once one account has spent its quota.
// Empty in prod (IS_STAGING false), so prod menus are untouched.
function devBypassItems(): Electron.MenuItemConstructorOptions[] {
  if (!CONFIG.IS_STAGING) return []
  const active = PREFS.getDevBypassAccount()

  // Switch IN-PLACE — never app.relaunch(). Under electron-vite the Electron
  // binary is a child of `npm run dev`, so a relaunch re-execs it orphaned from
  // the Vite server: Vite dies, the re-exec'd app renders blank, and you get
  // "UI failed to load". Signing out and back in reaches the same state (the
  // boot gate is just signIn → gateAfterAuth) without killing the dev server.
  const choose = (email: string | null): void => {
    PREFS.setDevBypassAccount(email)
    void authSignOut()
      .then(async () => {
        if (!email) {
          showAuthWindow()
          return
        }
        const res = await signInTestAdmin(email)
        if (!res.ok) {
          console.error('Dev-bypass sign-in failed:', res.error)
          showAuthWindow()
          return
        }
        await gateAfterAuth()
      })
      .catch((err) => console.error('Dev-bypass switch failed:', err))
      // Without this the menu keeps the OLD label and radio tick until something
      // else happens to rebuild it, which reads as "the switch didn't work".
      .finally(() => refreshTrayMenu())
  }

  return [
    {
      label: `🔓 Dev: bypass auth (${active ? active.replace('@staging.local', '') : 'OFF'})`,
      submenu: [
        { label: 'Off', type: 'radio' as const, checked: !active, click: () => choose(null) },
        { type: 'separator' as const },
        ...CONFIG.STAGING_TEST_ADMINS.map((a) => ({
          label: a.EMAIL,
          type: 'radio' as const,
          checked: active === a.EMAIL,
          click: () => choose(a.EMAIL)
        }))
      ]
    },
    { type: 'separator' as const }
  ]
}

// Calls beginAwayMode itself rather than showCurtain() alone: the cover is the
// visible part, but the mouse-move detection is what needs testing and only
// exists inside a real hold.
function devAwayModeItems(): Electron.MenuItemConstructorOptions[] {
  if (!IS_DEV) return []

  return [
    {
      label: isAwayModeHeld() ? '🌑 Dev: hand back now' : '🌑 Dev: cover screen now (2s)',
      click: () => {
        if (isAwayModeHeld()) {
          void handback().finally(() => refreshTrayMenu())
          return
        }
        // 2s, not 0: leaves time to take a hand off the mouse, since any local
        // input before the cover postpones it instead of covering.
        void beginAwayMode({
          onEndedByHuman: () => refreshTrayMenu(),
          coverDelayOverrideMs: 2_000
        }).then((res) => {
          if (!res.ok) console.error('Dev Away Mode failed:', res.reason, res.error)
          refreshTrayMenu()
        })
      }
    }
  ]
}

/**
 * Open the panel on the History view. Opening History is also how the user clears
 * the unread badge (UNREAD.clear lives in the renderer's historyRequest handler),
 * so this is the single action the tray badge points at.
 *
 * The view to land on (`openTo: 'history'`) rides in on the panel's init/reseed
 * payload — showPanelWindow('history') stashes the intent and the RENDERER opens
 * the flyout once it's mounted. A fresh open seeds itself via getInitialData on
 * mount; an already-visible panel won't re-mount, so we push a reseed carrying the
 * same intent. No timer, so nothing races the mount or the listener subscription.
 */
async function openHistory(): Promise<void> {
  const wasOpen = needsPanelReseed()
  route('panel', { panelSource: 'history' })
  if (wasOpen) {
    sendToPanelRenderer(CHANNELS.panelReseed, await buildPanelInitData())
  }
}

function quitForReal(): void {
  closePanelWindow()
  app.quit()
}

// Dev must go through `make restart`: app.relaunch() orphans the app from the Vite server.
function restartApp(): void {
  if (app.isPackaged) {
    app.relaunch()
    quitForReal()
    return
  }
  spawn('make', ['restart'], { cwd: app.getAppPath(), detached: true, stdio: 'ignore' }).unref()
}

function buildTrayMenu(): Menu {
  // Tail not running yet → minimal menu. Two distinct reasons land here, and the
  // action must match: genuinely signed OUT (no currentUser) → "Sign in…"; signed
  // IN but the tail hasn't started (fresh-install binary whose macOS permissions
  // aren't granted yet, so gateAfterAuth routed to onboarding instead of
  // startAppTail) → "Grant permissions", NOT "Sign in…". Showing "Sign in…" to an
  // already-authed user reads as "sign-in failed" when it actually succeeded.
  if (!tailStarted) {
    const authItem: Electron.MenuItemConstructorOptions = currentUser
      ? { label: '⚠ Grant permissions to finish setup', click: () => route('onboarding') }
      : { label: 'Sign in…', click: () => showAuthWindow() }
    return Menu.buildFromTemplate([
      { label: `${CONFIG.APP_NAME} (${CONFIG.BRAND_ICON})`, enabled: false },
      ...envBanner,
      ...devBypassItems(),
      authItem,
      { type: 'separator' },
      { label: 'Restart', click: restartApp },
      {
        label: 'Quit',
        click: quitForReal
      }
    ])
  }

  // Per-shortcut lines live in the Cheat Sheet now (SSOT: CONFIG.SHORTCUTS).
  // The tray only surfaces the Accessibility warning when hotkeys can't run.
  const accessibilityOk = isCaptureHotkeyAvailable()
  const warningItems: Electron.MenuItemConstructorOptions[] = accessibilityOk
    ? []
    : [
        {
          label: '⚠ Grant Accessibility to enable shortcuts',
          click: () => route('onboarding')
        },
        { type: 'separator' as const }
      ]

  // Two submenus keep the top level a pure launcher:
  //   • Advanced ▸ — user-facing features (Dynamic Island, Incognito, History,
  //     Cheat Sheet, Analytics, Chat). Shown to EVERYONE. No toggle gate.
  //   • Admin ▸    — platform/dev escape hatches (View as user, dev tools,
  //     Restart, staging bypass). Admin-email gated; absent for normal users.
  const realAdmin = !!currentUser && isAdminEmail(currentUser.email)
  // "View as user" hides every admin surface so an admin sees the real user's
  // app. The one exception is the exit row below — without it the preview
  // hides its own off switch and you'd have to restart to get back.
  const previewingAsUser = realAdmin && isPreviewingAsUser()
  const isAdmin = realAdmin && !previewingAsUser
  const advanced = SETTINGS.advancedMode()

  // When finished runs are unread, surface a History entry at the TOP of the menu.
  // This closes the loop on the tray badge (`🐁 2`): the number says there's
  // something new, this item is the obvious place to click, and opening History
  // clears the badge. Without it the badge is a dead-end.
  const unread = UNREAD.count()
  const unreadItems: Electron.MenuItemConstructorOptions[] =
    unread > 0
      ? [
          {
            label: `🔴 ${CONFIG.UI_LABELS.HISTORY_UNREAD_MENU.replace('{n}', String(unread))}`,
            click: () => openHistory()
          },
          { type: 'separator' as const }
        ]
      : []

  const incognito = PREFS.getIncognito()

  // Phone Remote ▸ — its own top-level section rather than a row inside
  // Advanced. It's a primary destination (pair a phone, check whether one is
  // actually connected), so it gets a plain label; live status belongs in the
  // Settings card, not the menu bar.
  const phoneRemoteItems: Electron.MenuItemConstructorOptions[] = [
    {
      label: '📱 Phone Remote',
      // Lands in Settings scrolled to the Phone Remote card (QR pairing lives
      // there). The modal IS the settings surface; the tray only routes to it.
      click: () => showSettingsWindow('phoneRemote')
    },
    { type: 'separator' as const }
  ]

  // Update ▸ — a prominent, always-visible "Restart to update" row once a new
  // version is downloaded and waiting. Without this the self-install update sits
  // silently in the background and the user never knows to relaunch. Downloading
  // shows a passive progress line (no action yet); downloaded shows the action.
  const upd = getUpdateState()
  const updateItems: Electron.MenuItemConstructorOptions[] =
    upd.state === 'downloaded'
      ? [
          {
            label: `↻ Restart to update${upd.version ? ` (v${upd.version})` : ''}`,
            click: () => updaterIpc.install()
          },
          { type: 'separator' as const }
        ]
      : upd.state === 'download-progress'
        ? [
            {
              label: `⬇ Downloading update… ${Math.round(upd.percent ?? 0)}%`,
              enabled: false as const
            },
            { type: 'separator' as const }
          ]
        : []

  // Advanced ▸ — feature destinations + the two live toggles. Everyone sees this.
  const { STEP: zoomStep, DEFAULT_LEVEL: zoomDefault } = CONFIG.MIGHTY.ZOOM
  const zoomPct = zoomLevelToPercent(getMightyZoomLevel())
  const zoomOff = zoomPct !== zoomLevelToPercent(zoomDefault)
  const zoomLabel = CONFIG.UI_LABELS.ZOOM_MENU.replace('{pct}', String(zoomPct))
  const advancedSubmenuItem: Electron.MenuItemConstructorOptions = {
    label: zoomOff
      ? `${CONFIG.UI_LABELS.ADVANCED_SUBMENU} (${zoomLabel})`
      : CONFIG.UI_LABELS.ADVANCED_SUBMENU,
    submenu: [
      { label: zoomLabel, enabled: false as const },
      {
        label: CONFIG.UI_LABELS.ZOOM_IN_MENU,
        click: () => setMightyZoomLevel(getMightyZoomLevel() + zoomStep)
      },
      {
        label: CONFIG.UI_LABELS.ZOOM_OUT_MENU,
        click: () => setMightyZoomLevel(getMightyZoomLevel() - zoomStep)
      },
      {
        label: CONFIG.UI_LABELS.ZOOM_RESET_MENU,
        enabled: zoomOff,
        click: () => setMightyZoomLevel(zoomDefault)
      },
      { type: 'separator' as const },
      {
        label: 'Dynamic Island',
        type: 'checkbox' as const,
        checked: isIslandWindowRunning(),
        click: (): void => {
          const next = !PREFS.getDynamicIsland()
          PREFS.setDynamicIsland(next)
          // Demo on enable so the toggle also shows the user what it does.
          setIslandWindow(next, next)
          track(ANALYTICS_EVENT.setting_toggled, { key: 'dynamic_island', value: String(next) })
          refreshTrayMenu()
        }
      },
      {
        label: 'Incognito mode',
        type: 'checkbox' as const,
        checked: incognito,
        // Deliberately NOT tracked — logging the toggle would leak when the user
        // goes private. Broadcast so the panel badge updates live.
        click: (): void => {
          PREFS.setIncognito(!incognito)
          broadcastIncognito(PREFS.getIncognito())
        }
      },
      { type: 'separator' as const },
      // Phone Remote lives at the TOP level now (its own section), not here --
      // it's a primary destination, and one more click behind Advanced ▸ is the
      // difference between reaching for the phone and not bothering.
      // The Library is a composer tab now, so this opens there instead of the
      // standalone window. showMediaLibraryWindow() + ?window=media still exist
      // (unwired) in case the library ever wants its own window back.
      { label: 'Media Library…', click: () => showMightyWindow(false, undefined, '') },
      { label: CONFIG.UI_LABELS.CHEAT_SHEET_MENU, click: () => showCheatSheetWindow() },
      // Health status for the six things that can actually be broken. A working
      // user never hits the warning states that link here, so without a tray
      // entry the surface is unreachable once everything's fine — which is
      // exactly when you want to open it to confirm everything's fine.
      { label: CONFIG.UI_LABELS.SETUP_MENU, click: () => route('setup') },
      { label: 'Analytics…', click: () => showAnalyticsWindow() },
      { label: `Chat with ${PREFS.getMightyName()}…`, click: () => showMightyWindow() }
    ]
  }

  // Admin ▸ — platform + dev escape hatches. Only built for admin emails; each
  // inner item keeps its own IS_DEV / staging gate on top. Restart and the
  // staging auth-bypass live here so they never clutter a normal user's menu.
  const adminSubmenuItems: Electron.MenuItemConstructorOptions[] = isAdmin
    ? [
        {
          label: CONFIG.UI_LABELS.ADMIN_SUBMENU,
          submenu: [
            // Dress rehearsal: hide every admin surface app-wide (this submenu,
            // admin-only Settings) so you read the app as a real
            // user does. Display only — access is still checked server-side.
            {
              label: CONFIG.UI_LABELS.VIEW_AS_USER_MENU,
              type: 'checkbox' as const,
              checked: false,
              click: (): void => enterViewAsUser()
            },
            {
              label: CONFIG.UI_LABELS.RESTART_MENU,
              click: () => {
                app.relaunch()
                app.exit(0)
              }
            },
            // Eyeball the live first-run screen with no side effects: never
            // writes the completion marker, tags every event preview:true.
            {
              label: CONFIG.UI_LABELS.ONE_SCREEN_SETUP_MENU,
              click: (): void => showOnboardingOneScreenPreview()
            },
            { label: CONFIG.UI_LABELS.RESOURCES_MENU, click: () => showResourcesWindow() },
            { label: `Open ${HIDEOUT_NAME}`, click: () => openHideout() },
            { type: 'separator' as const },
            // Environment ▸ — the same switch the phone remote fires, from the
            // Mac. Troubleshooting an env bug meant picking up the phone for
            // every flip, which is the slow half of the loop. The radio dots
            // double as the answer to "which env am I actually in?", read from
            // the running process rather than from the override file, so a file
            // written after launch can't make this lie.
            {
              label: `Environment: ${CONFIG.ENV_NAME}`,
              submenu: (['staging', 'prod'] as const).map((env) => ({
                label: env === 'prod' ? 'Prod (live)' : 'Staging',
                type: 'radio' as const,
                checked: CONFIG.ENV_NAME === env,
                click: (): void => {
                  // Relaunches the app — same write-then-verify path as the
                  // phone, so a failed write refuses to restart instead of
                  // coming back in the old env.
                  if (CONFIG.ENV_NAME !== env) void applyEnvSwitch(env)
                }
              }))
            },
            // Dev-only tools — never in a packaged production build (IS_DEV gate).
            ...(IS_DEV
              ? [
                  { type: 'separator' as const },
                  {
                    label: 'Component Playground… (dev)',
                    click: (): void => showPlaygroundWindow()
                  },
                  // Mocked fakes permission CHECKS (Move shows un-granted, no real TCC revoke); real hits live TCC.
                  {
                    label: 'Replay first run… (dev)',
                    submenu: [
                      {
                        label: 'Faked permissions (new-user view)',
                        click: (): void => replayFirstRun({ mock: true })
                      },
                      {
                        label: 'Real permissions (this Mac)',
                        click: (): void => replayFirstRun({ mock: false })
                      }
                    ]
                  },
                  // Fire the insights pipeline now instead of waiting the idle
                  // timer. No-op unless the experimental flag is on.
                  {
                    label: 'Trigger insights now (dev)',
                    click: (): void => triggerInsightsNow()
                  },
                  ...devAwayModeItems(),
                  // A developer whose machine works can never see the states
                  // this surface exists for. Forces all six rows to fail so the
                  // blocked-first-run screen is one click away. Buttons stay
                  // live; only the probe is faked.
                  {
                    label: 'Preview broken setup… (dev)',
                    type: 'checkbox' as const,
                    checked: isSetupPreviewBroken(),
                    click: (): void => {
                      setSetupPreviewBroken(!isSetupPreviewBroken())
                      route('setup')
                      refreshTrayMenu()
                    }
                  }
                ]
              : []),
            // Staging-only auth bypass — nested here instead of top-level.
            // devBypassItems() trails a separator (for top-level use); drop it
            // and give it a leading divider so it sits cleanly at the submenu end.
            ...(() => {
              const items = devBypassItems()
              if (!items.length) return []
              return [{ type: 'separator' as const }, ...items.slice(0, -1)]
            })()
          ]
        }
      ]
    : []

  return Menu.buildFromTemplate([
    { label: `${CONFIG.APP_NAME} (${CONFIG.BRAND_ICON})`, enabled: false },
    ...envBanner,
    // Loud, disabled status line — only when ON — so the user can see at a glance
    // that nothing is being logged this session.
    ...(incognito
      ? [{ label: '🕵️ Incognito ON · not logging', enabled: false as const }, { type: 'separator' as const }]
      : []),
    // The preview's own off switch. Loud, pinned to the top, and the ONLY admin
    // row that survives "View as user" — everything else is hidden by design, so
    // without this the way back would be a restart.
    ...(previewingAsUser
      ? [
          {
            label: CONFIG.UI_LABELS.VIEW_AS_USER_EXIT,
            click: (): void => exitViewAsUser()
          },
          { type: 'separator' as const }
        ]
      : []),
    ...warningItems,
    ...activeCopyMenuItems(),
    ...updateItems,
    ...unreadItems,
    ...(advanced
      ? [    {
      label: 'Open Panel',
      click: () => route('panel', { panelSource: 'tray' })
    },
    // Admin-only for the same reason as 'Agents waiting…' below: the roster is
    // empty until the code relay is set up, and a row that opens nothing is
    // worse than no row.
    ...(isAdmin
      ? [
          {
            label: 'Shared work…',
            click: (): void => showMightyWindow(false, undefined, undefined, true, 'work')
          },
          {
            label: 'Agents…',
            click: (): void => showMightyWindow(false, undefined, undefined, true, 'agents')
          }
        ]
      : []),
    // Voice mode is STARTED and ENDED, never toggled on/off — a conversation is
    // an event, not a setting, so this is a plain row whose label says which of
    // the two it will do. Top-level (not under Advanced ▸) because the tray is
    // the only place you can start one.
    // Admin-only while voice mode is still being dogfooded. The `|| getLiveMode()`
    // is an escape hatch, not a leak: if a conversation is somehow already
    // running for a non-admin, hiding the row would make it unkillable from the
    // tray — so the row survives, and it can only say "End".
    ...(isAdmin || PREFS.getLiveMode()
      ? [
          {
            // Label and click BOTH read the pref. They used to disagree — the label
            // asked the window, the click flipped the pref — so any path that closed
            // the window without clearing the pref left the row reading "End" while
            // clicking it started a second conversation. Unkillable from the tray.
            label: PREFS.getLiveMode() ? 'End voice mode' : 'Start voice mode',
            click: toggleVoiceMode
          }
        ]
      : []),
    {
      label: 'Tutorial…',
      click: () => {
        track(TOUR.EVENT.reopened)
        route('tour', { tourSource: TOUR.SOURCE.tray })
      }
    },
    // Admin-only: Actions is experimental; the Settings section is the supported way in.
    ...(isAdmin ? [{ label: 'Actions…', click: () => showActionsWindow() }] : []),
    { label: CONFIG.UI_LABELS.HISTORY_MENU, click: () => openHistory() },
    // The same deck the phone shows, on the Mac: agents waiting on you, one card
    // at a time. Named for the queue rather than the gesture — the tray is where
    // you learn there is something to clear.
    // Admin-only: the deck is empty for anyone who has not set up the code relay,
    // and a row that always opens nothing is worse than no row. The paths that
    // matter to a real relay user still work — a notification tap and the phone's
    // own Code button both call showDeckWindow() without going through the tray.
    ...(isAdmin ? [{ label: 'Agents waiting…', click: () => showDeckWindow() }] : []),
    ...(isAdmin ? [{ label: 'Canvas…', click: () => showCanvasWindow() }] : [])]
      : []),
    ...(advanced ? [] : phoneRemoteItems),
    { label: 'Ask a Specialist…', click: () => showSpecialistWindow() },
    { label: 'Report a Bug…', click: () => showBugReportWindow() },
    { type: 'separator' },
    ...(advanced ? phoneRemoteItems : []),
    ...(advanced ? [advancedSubmenuItem] : []),
    ...adminSubmenuItems,
    { type: 'separator' },
    {
      label: currentUser ? `Signed in as ${currentUser.email}` : 'Signed in',
      enabled: false
    },
    { type: 'separator' },
    {
      label: CONFIG.UI_LABELS.SETTINGS_MENU,
      click: () => showSettingsWindow()
    },
    { label: 'Restart', click: restartApp },
    {
      label: 'Quit',
      click: quitForReal
    }
  ])
}

// Tell every open window that Incognito flipped, so their badges (panel header,
// Settings card) update live regardless of which surface toggled it, and rebuild
// the tray so its checkbox + status line stay in sync. Exported so the ipc
// handler (Settings toggle) drives the exact same side effects as the tray click.
export function broadcastIncognito(on: boolean): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(CHANNELS.incognitoChanged, on)
  }
  refreshTrayMenu()
}

// Enter/exit "View as user" — an admin's preview of the real user's app. Both
// rebuild the tray and push to every open window, so Settings and the menu flip
// together instead of one going stale. Exported so the Settings switch and the
// tray row drive identical side effects.
export function setViewAsUserPreview(on: boolean): void {
  setPreviewAsUser(on)
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(CHANNELS.viewAsUserChanged, on)
  }
  refreshTrayMenu()
}

function enterViewAsUser(): void {
  setViewAsUserPreview(true)
  // Open Settings on the way in: it's the surface with the most admin-only
  // sections, so it's where "what does a user actually see" gets answered.
  showSettingsWindow()
}

function exitViewAsUser(): void {
  setViewAsUserPreview(false)
}

// Tell every open window which backend/model is now selected, so live chips
// (Panel header, Mighty header) update immediately instead of waiting for a
// remount or a window-focus re-read. Exported so both write sites — the
// Settings toggle and a resumed conversation re-adopting its original backend
// — drive the same push.
export function broadcastBackendChanged(backend: BackendId): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(CHANNELS.backendChanged, backend)
  }
}

export function refreshTrayMenu(): void {
  if (!tray) return
  if (trayMenuOpen) {
    trayRefreshPending = true
    return
  }
  // Title to the right of the menu-bar glyph. Priority: a downloaded-update dot (↑)
  // beats the unread count, since "restart to get the new version" is the more
  // important nudge. Empty title removes the badge. macOS auto-colors the text.
  const unread = UNREAD.count()
  const updateReady = getUpdateState().state === 'downloaded'
  const zoomPct = zoomLevelToPercent(getMightyZoomLevel())
  const zoomBadge = zoomPct === 100 ? '' : ` ${zoomPct}%`
  if (isMac) tray.setTitle((IS_DEVTEST ? 'DEV TEST' : '') + (updateReady ? ' ↑' : unread > 0 ? ` ${unread}` : '') + zoomBadge)
  tray.setContextMenu(trackTrayMenu(buildTrayMenu()))
}

function createTray(): void {
  let image = nativeImage.createEmpty()
  try {
    // Prefer the purpose-drawn monochrome template (crisp at menu-bar size,
    // auto-recolors to light/dark). Fall back to the full-color app icon.
    const fromTemplate = nativeImage.createFromPath(trayIconAsset)
    if (!fromTemplate.isEmpty()) {
      image = fromTemplate
      if (isMac) image.setTemplateImage(true)
    } else {
      image = nativeImage.createFromPath(iconAsset).resize({ width: 16, height: 16 })
      if (isMac) image.setTemplateImage(true)
    }
  } catch (err) {
    console.error('[tray] icon load failed, tray will show a blank image:', err)
  }

  tray = new Tray(devTrayIcon(image))
  tray.setToolTip(CONFIG.APP_NAME)
  tray.setContextMenu(trackTrayMenu(buildTrayMenu()))
}

// Must precede app.whenReady — privileged scheme registration is only honored
// before the app is ready. Lets the Media Library stream capture files securely.
registerMediaScheme()

// Dev's default "mightymouse" folder IS prod's "MightyMouse" on case-insensitive APFS - one shared lock.
app.setPath('userData', join(app.getPath('appData'), CONFIG.APP_NAME))
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    // win/linux: a deep link launched a 2nd instance — its URL rides in argv.
    const url = deepLinkFromArgv(argv)
    if (url) routeDeepLink(url)
    else showSettingsWindow()
  })

  app.whenReady().then(async () => {
    // ── bootCore: always runs (no gate) ──────────────────────────────────────
    // FIRST: fix PATH for the packaged (GUI-launched) app so every later spawn —
    // CLI resolution, the backend auth probe, runner.ts — sees the user's real
    // login-shell PATH (~/.local/bin etc.). Must precede anything that spawns.
    applyLoginShellPath()
    initializePaths()
    applyDockIcon()
    // Clamshell crash guard (layer 2). Ungated and early on purpose: if a prior
    // run died holding the machine-wide `pmset disablesleep` flag, this is what
    // heals the Mac. A fresh process holds nothing, so a flag found here is by
    // definition stale. Fire-and-forget — it must never delay boot, and it's a
    // silent no-op in the normal case where no flag is set.
    void revertClamshellOnLaunch()
    setClamshellAgentProbe(() =>
      liveAgentSessions().some(
        (s) => s.busySince !== undefined && Date.now() - (s.lastActivityAt ?? s.busySince) < CONFIG.PHONE_REMOTE.CLAMSHELL_AGENT_QUIET_MS
      )
    )
    // Lock-hold crash guard (layer 2), same contract, worse failure: a run that
    // died mid-hold leaves a Mac that never idle-locks, permanently and
    // invisibly. Never re-applies the hold itself.
    void clearIdleLockSuppressionOnLaunch()
    // Records every screen lock, session or not. Armed here rather than on a
    // phone connect because "the Mac locked with nothing running" is precisely
    // the case the journal could not prove.
    startAwayModeLockWatch()
    // Dev-only headless mode for a dev script: `--print-jwt` boots just far enough
    // to resolve the signed-in session (via the app's OWN Supabase client, so the
    // Keychain-encrypted token decrypts under the right app identity — a bare
    // `electron` binary can't), prints the access_token to stdout, and quits. Gated
    // on IS_DEV so it can never exist in a packaged build. Never logs the token.
    if (IS_DEV && process.argv.includes('--print-jwt')) {
      try {
        const { data } = await getSupabase().auth.getSession()
        const token = data.session?.access_token ?? ''
        if (token) process.stdout.write(token)
        else process.stderr.write('print-jwt: no active session — sign into the app first\n')
        app.exit(token ? 0 : 1)
      } catch (err) {
        process.stderr.write(`print-jwt: ${err instanceof Error ? err.message : String(err)}\n`)
        app.exit(1)
      }
      return
    }
    // Dev-only: swap Electron's generic atom for the real icon + a "D" badge, so a
    // dev Dock icon is never mistaken for an installed prod build.
    applyDevDockIcon()
    // Serve capture artifacts to the Media Library via media:// (captures-scoped).
    registerMediaProtocol()
    // Reconcile history to the encryption toggle (backs up before any convert),
    // then sweep stale plaintext prompt/output dumps from tmp.
    reconcileHistoryEncryption()
    // Settle runs the last session died holding (crash / force-quit / power loss):
    // their `pending` rows can never settle themselves. Must run AFTER the encryption
    // reconcile so it reads decrypted rows, not ciphertext.
    HISTORY.reconcilePendingRuns()
    // Same problem, Mighty's side: a chat interrupted by the last quit would
    // otherwise show as thinking forever, on the Mac and the phone alike.
    MIGHTY.reconcileInterruptedSessions()
    // Must precede cleanupTmp: a still-live orphan keeps touching its output file,
    // so the mtime sweep below can never age it out until the writer is dead.
    const orphanPids = killOrphanedCaptureChildren()
    cleanupTmp()
    void recoverInterruptedRecordings(orphanPids, () => showMightyWindow())
    // Capture crashes/uncaught errors → public.errors before anything else can throw.
    installCrashHandlers()
    // Let a crash notification open the in-app report form. Injected (not imported
    // by crash.ts) so the early-loading crash module never pulls the window graph
    // in behind it; without this the notification falls back to the mailto:.
    setBugReportWindowOpener(showBugReportWindow)
    // Dev-only: surface a "Vite is down" dialog if a window can't reach :5273,
    // so a dead renderer never masquerades as a blank popup / cross-app conflict.
    installDevServerGuard()
    bindInAppNavigatorKey()
    registerIpcHandlers()
    startResourceRecording()
    startModelCatalogRefresh()
    // Control socket the spawned act agent talks to for APP-side capabilities
    // (the highlight overlay). Best-effort: a bind failure degrades to "mm-ui
    // verbs unavailable", never blocks startup or the act loop.
    startActControlServer()
    // Screen mirror: the hidden capture window's getDisplayMedia() call has no
    // human to click a picker (it's a headless renderer) -- feed it a
    // desktopCapturer source programmatically so it resolves instead of hanging
    // forever waiting for a dialog that will never appear. Still no picker UI
    // the target is chosen for the user:
    //   extended mode on  → the virtual display (phone shows its OWN desktop)
    //   otherwise         → the primary display (classic mirror)
    // Matched by id against each source's display_id, which is a string.
    // Answering with an empty callback({}) is how you say "no source", but
    // Electron turns that into a REJECTED getDisplayMedia() promise in the
    // calling renderer, and the rejection surfaces in main as an
    // unhandledRejection ("Video was requested, but no video stream was
    // provided"). Two of those reached prod on 0.13.0 from one user whose
    // getSources() was failing; the pair (a swallowed "Failed to get sources."
    // plus the empty-callback rejection 19ms later) was the entire error budget
    // for that digest. WebrtcCaptureApp already catches its own failure and
    // reports it via webrtcCaptureError, so the phone still shows a real mirror
    // error — this only stops a handled situation from looking like a crash.
    session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
      // Electron answers this once. Phone disconnect can destroy the capture
      // window while getSources is still in flight; answering after that throws
      // "One-time callback was called more than once" as an unhandledRejection.
      let answered = false
      const answer = (payload: Parameters<typeof callback>[0]): void => {
        if (answered) return
        answered = true
        callback(payload)
      }
      // Why not just let the empty callback through: it is the only way to
      // decline, so the decline must be logged HERE. Swallowing it upstream is
      // what made the original failure invisible until it crashed.
      // Guarded on `answered` too: answer({}) makes Electron reject into the
      // .catch below, which declined AGAIN and blamed getSources for the pair.
      //
      // Tracked HERE, not left to the unhandledRejection this triggers: since
      // 2026-08-07 (src/main/crash.ts isHandledMirrorRejection) that rejection
      // is deliberately swallowed as a handled outcome, so this is the only
      // place left that reports a decline to telemetry at all. The phone still
      // gets its own classified message from onError in ipc/phone-remote.ts,
      // which receives this same `why` string via webrtcCaptureError.
      const decline = (why: string, grant?: string, sourceCount?: number): void => {
        if (answered) return
        console.error(`[mirror] no capture source: ${why}`)
        answer({})
        trackError({
          kind: 'mirror-decline',
          message: why,
          source: 'main',
          props: { grant, sourceCount }
        })
        // The grant can only be given on the Mac — so fire the grant flow here
        // too. Zero sources is what a missing Screen Recording permission
        // looks like from desktopCapturer.
        void ensureScreenPermission(SCREEN_ACTION.mirror, () => route('setup'))
      }

      getMirrorSources()
        .then((sources) => {
          // Capture window already gone → Electron likely already aborted; a
          // late answer is the double-callback race, not a real decline.
          if (!isScreenStreamRunning()) return
          const targetId = String(getVirtualDisplay()?.id ?? screen.getPrimaryDisplay().id)
          // Falling back to sources[0] would silently mirror the WRONG screen in
          // extended mode — better to hand back nothing so the phone surfaces a
          // real mirror error than to stream the user's own monitor back at them.
          const match = sources.find((s) => s.display_id === targetId)
          const target = match ?? (getVirtualDisplay() ? undefined : sources[0])
          if (!target) {
            if (sources.length > 0) {
              decline(`display ${targetId} not among ${sources.length}`, undefined, sources.length)
              return
            }
            // Zero sources also happens mid-teardown and on a sleeping display, with
            // the grant live -- opposite fixes, so log which. `make why Q="asleep"`.
            const granted = systemPreferences.getMediaAccessStatus('screen')
            decline(
              `no screen sources (grant=${granted}, displays=${screen.getAllDisplays().length})`,
              granted,
              0
            )
            return
          }
          answer({ video: target })
        })
        // Almost always a missing/stale Screen Recording grant. Logged rather
        // than swallowed: this is the message that explains the decline.
        .catch((err) => {
          if (!isScreenStreamRunning()) return
          decline(`getSources failed: ${err instanceof Error ? err.message : String(err)}`)
        })
    })
    // Wire the activity emitter to the island BEFORE any capture/run can fire it
    // (dependency injection avoids an activity ↔ island-window import cycle).
    initActivity((p) => {
      pushIslandActivity(p)
      const mighty = getMightyWindow()
      if (mighty && !mighty.isDestroyed()) mighty.webContents.send(CHANNELS.islandActivity, p)
      setCompanionMicPaused(p.state === 'listening' || p.state === 'recording')
    })
    registerIslandIpc()
    createSoundWindow()
    createTray()
    // Re-render the tray (icon title badge + menu) whenever the unread count changes.
    UNREAD.onChange(() => refreshTrayMenu())
    // Redraw the tray when the update state moves (→ downloaded shows the restart
    // row + ↑ indicator), and periodically during download-progress so the % counts up.
    onUpdateStateChange(() => refreshTrayMenu())
    // Start the update check loop (launch + every 4h). Inert in dev (unpackaged).
    setupAutoUpdater()

    if (!PREFS.getFirstBootRecorded()) {
      PREFS.setFirstBootRecorded()
      track(ANALYTICS_EVENT.app_first_boot)
    }
    track(ANALYTICS_EVENT.app_launch)

    // When the user finishes onboarding, release the app-tail gate.
    // 'new' only for a genuine first run — a reauth (permission re-granted after
    // it broke) is a returning user, not someone who needs first-run orientation.
    configureOnboarding({
      onComplete: (reauth) => startAppTail(reauth ? 'returning' : 'new'),
      // Red X on the gate: closing it means SKIP, not "ask me again in 600ms".
      // Re-gating here trapped real users — gateAfterAuth re-derives
      // unfinishedStep from an unfinished wizard and reopens it, so the window
      // came back forever (user 361c2014, 08-30: abandoned → started x10 in 4
      // min). Hotkeys no-op until Accessibility is granted; the tray keeps a
      // Setup row for whoever wants to finish later.
      onAbandon: () => {
        track(ANALYTICS_EVENT.onboarding_abandoned)
        // Latch the skip BEFORE the tail starts: closing this window leaves no
        // restorable window, macOS fires `activate`, and that routes 'panel' —
        // which re-gated back to onboarding within a second. See routing.ts.
        markOnboardingAbandoned()
        startAppTail('new')
      }
    })

    // Routing reads auth through this hook (importing index.ts back would cycle).
    // Wired before the gate chain below, so the first route() already sees auth.
    SETTINGS.advancedMode()
    configureRouting({ user: () => currentUser })

    // Broadcast auth changes to all windows; wire the hard-gate callbacks.
    configureAuth({
      onAuthed: () => {
        // Signed in, but only start the tail once permissions actually work;
        // otherwise the onboarding wizard takes over and releases the gate.
        void gateAfterAuth()
      },
      onSignedOut: () => stopAppTail(),
      broadcast: (user: AuthUser | null) => {
        currentUser = user
        if (user && !PREFS.getOnboardingComplete() && isAdminEmail(user.email)) {
          SETTINGS.set({ advancedMode: true })
        }
        refreshTrayMenu()
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) win.webContents.send(CHANNELS.authChanged, user)
        }
      }
    })

    // Restore persisted session, then apply the gate chain: signed in →
    // onboarding (if perms not yet working) → app tail. Signed out → auth.
    // Staging dev-bypass: if on and not already signed in, sign in the seeded
    // test-admin (real JWT). signInTestAdmin fires onAuthed → gateAfterAuth, so
    // we only need the fallback auth window when bypass is off and no session.
    //
    // initAuth() is timeout-safe (a hung getSession can't freeze boot); we reuse its
    // returned user instead of re-calling isAuthed() — that would re-hit getSession()
    // and re-introduce the hang. The whole block is also wrapped so any unexpected
    // throw still lets startup finish (hotkeys must register no matter what).
    try {
      let user = await initAuth()
      // Force-login (dev convenience): `MM_FORCE_LOGIN=1 npm run dev` signs in the
      // seeded staging test-admin on boot REGARDLESS of the dev-bypass toggle — so a
      // flipped-off toggle or a one-off failed sign-in can't strand you on the login
      // screen mid-iteration. Gated on IS_DEV+IS_STAGING, so it's inert in any
      // packaged/prod build. The toggle path below still works for normal use.
      const forceLogin = IS_DEV && CONFIG.IS_STAGING && envVar('MM_FORCE_LOGIN') === '1'
      const bypassAccount = CONFIG.IS_STAGING ? PREFS.getDevBypassAccount() : null
      if ((forceLogin || bypassAccount) && !user) {
        const res = await signInTestAdmin(bypassAccount ?? undefined)
        if (!res.ok) console.error('Dev-bypass test-admin sign-in failed:', res.error)
        else user = await getSession()
      }
      if (user) {
        await gateAfterAuth()
      } else {
        showAuthWindow()
      }
    } catch (err) {
      console.error('Auth init failed; showing auth window:', err)
      showAuthWindow()
    }

    // Drain any deep links that arrived before the app was ready (macOS cold
    // start), plus a first-launch deep link passed via argv on win/linux.
    appReady = true
    const firstLaunchUrl = deepLinkFromArgv(process.argv)
    if (firstLaunchUrl) pendingDeepLinks.push(firstLaunchUrl)
    for (const url of pendingDeepLinks.splice(0)) void handleDeepLink(url)

    // Last, and deliberately unawaited: existing users on a covered language get
    // the faster engine in the background while whisper keeps handling every clip
    // until it lands. Nothing here may delay boot or prompt.
    void ensureParakeetInBackground()
    // Same shape: a fresh Mac has no ffmpeg, so the first listen/record needs
    // this to have landed before the user gets there.
    void ensureFfmpegInBackground()

    console.log(`${CONFIG.APP_NAME} is active in background.`)
  })

  app.on('will-quit', () => {
    logComputerUseQuit()
    stopCapture()
    stopContextLogging()
    stopActiveCopy()
    stopAgentRelayMcp()
    stopCloudAnswerPolling()
    // cloudflared is a spawned child that outlives us unless killed — a quit
    // without this leaves a live tunnel behind, and the NEXT launch's spawn
    // races that ghost for the same tunnel (both die, "Waiting to connect…"
    // forever). Sync variant: will-quit can't await the tunnel's op queue.
    stopTunnelSync()
    // Same orphan hazard as cloudflared: a spawned server that outlives us holds
    // the port, and the next launch's spawn fails against the ghost.
    disposeParakeetServer()
    // The extended screen outlives a phone disconnect by design, but it must NOT
    // outlive the app: with no MightyMouse running there'd be no way to clear a
    // display still holding the user's windows. (The helper also exits on its
    // stdin closing, but that's the backstop for a SIGKILL, not the main path.)
    stopVirtualDisplay()
    // Close the act control socket and unlink its file — a stale .sock left
    // behind blocks the next launch's listen() with EADDRINUSE.
    stopActControlServer()
    // Belt-and-braces: Electron drops power blockers when the process exits, but
    // releasing explicitly keeps "blocker held ⇒ remote running" true right up to
    // the end, so a quit path that stalls can't leave the display pinned awake.
    stopStayAwake()
    // Kill any run still in flight. Children spawn detached (their own process group),
    // so without this an unattended job outlives the app that owns it — invisible, and
    // still burning tokens. Each kill fires the run's own failure path, which settles
    // its pending history row on the way out.
    const killed = abortAllRuns()
    if (killed > 0) console.log(`Aborted ${killed} in-flight run(s) on quit.`)
  })

  // Drain buffered analytics before the process exits. Without this, events that
  // fired late in the session (e.g. right before quit) die in the in-memory
  // buffer. We delay the quit once to let the final insert land, then quit.
  let analyticsFlushed = false
  app.on('before-quit', (e) => {
    if (analyticsFlushed) return
    e.preventDefault()
    analyticsFlushed = true
    // Cap the wait so a hung network call can't block quit forever.
    const done = (): void => app.quit()
    // Clamshell revert (layer 1) rides the SAME deferral: releasing the
    // machine-wide sleep flag is async (it may need an admin prompt), and
    // will-quit is synchronous, so this is the only hook that can actually await
    // it. A revert that loses the race is still covered by the launch guard.
    // The audio input revert rides it for the same reason: quitting with the
    // phone mic selected would leave the Mac on a device with no writer.
    Promise.race([
      // relock:false — quit is local; SACLockScreenImmediate here locked the desk.
      Promise.all([
        flushAnalyticsNow(),
        disableClamshell(),
        handback('disconnect', { relock: false }),
        releaseDefaultInput()
      ]),
      new Promise((r) => setTimeout(r, 2000))
    ]).finally(done)
  })

  app.on('window-all-closed', () => {
    if (!isMac) {
      app.quit()
    }
  })

  // The app was activated from an OS affordance: a Dock click, or a ⌘-Tab switch
  // (both only reachable once the Dock pref promotes us out of accessory mode).
  // Without this, activating an app with no open windows shows NOTHING, which
  // reads as broken.
  //
  // Restore an already-open window if there is one — that's what the user meant to
  // get back to — else open the panel, the main surface. Not triggerRewritePanel:
  // the hotkey path first captures the selection from the frontmost app, which is
  // meaningless here — activating MightyMouse means the user just left that app.
  const surfaceApp = (via: 'dock' | 'switch'): void => {
    // An action the user picked on the card (open a website, raise an app) makes
    // us resign, so the trip back reads as a Dock click and opened the panel on
    // top of the card they were still using.
    if (voiceRouteCardOpen() || replyWindowFocused() || canvasWindowShown()) return
    if (hudCardInUse()) {
      console.log('[surface] skip hud card')
      return
    }
    // `isFocusable()` is the load-bearing filter. Several always-on windows are
    // alive AND visible but are NOT app UI: the cursor companion, the live
    // companion, and the cheese bubble are all click-through `focusable: false`
    // overlays. Counting one as "a window the user can return to" would focus()
    // something unfocusable and open nothing — the app comes forward showing
    // nothing at all.
    const restorable = BrowserWindow.getAllWindows().filter(
      (w) => !w.isDestroyed() && w.isFocusable() && (w.isVisible() || w.isMinimized())
    )
    if (restorable.length === 0) {
      // Signed out: the panel is not the right first surface. macOS fires
      // `activate` on cold boot before the async initAuth() below resolves, so
      // without this a first-run user met the panel and had to find sign-in
      // themselves (2m04s of it, observed 2026-09-02).
      if (!currentUser) {
        showAuthWindow()
        return
      }
      route('panel', { panelSource: 'dock' })
      return
    }
    for (const win of restorable) if (win.isMinimized()) win.restore()
    // Prefer the panel when it's up; otherwise focus the most recent window.
    const panel = restorable.find((w) => w === getPanelWindow())
    const target = panel ?? restorable[restorable.length - 1]
    console.log(`[surface] focus win=${target.id} via=${via}`)
    target.focus()
  }

  // Dock click / reopen. Does not fire for ⌘-Tab (probed 2026-07-17).
  app.on('activate', () => {
    if (wasJustYielded()) return
    surfaceApp('dock')
  })

  // ⌘-Tab only from background. Skip tray (NSMenu) and our own hide's echo.
  // Settle 150ms: tray click can beat menu-will-show. Grace 500ms: NSMenu starves timers.
  const ACTIVATION_SETTLE_MS = 150
  const TRAY_MENU_GRACE_MS = 500
  app.on('did-resign-active', () => {
    userLeft = true
    noteAppActive(false)
  })
  app.on('did-become-active', () => {
    noteAppActive(true)
    if (!PREFS.getDockIcon()) return
    setTimeout(() => {
      const fromBackground = userLeft
      userLeft = false
      if (!fromBackground) return
      if (wasJustYielded()) return
      if (
        trayMenuOpen ||
        Date.now() - trayMenuClosedAt < TRAY_MENU_GRACE_MS ||
        Date.now() - trayMenuShownAt < TRAY_MENU_GRACE_MS
      ) {
        return
      }
      surfaceApp('switch')
    }, ACTIVATION_SETTLE_MS)
  })
}

function toggleVoiceMode(): void {
  const next = !PREFS.getLiveMode()
  PREFS.setLiveMode(next)
  // Ending the conversation drops the session — the same reset
  // ipc/settings.ts's settingsSetCompanion handler does.
  if (!next) setLiveSession(undefined)
  setCompanionWindow(next)
  playSound(next ? 'record-start' : 'record-stop')
  track(ANALYTICS_EVENT.setting_toggled, { key: 'live_companion', value: String(next) })
  refreshTrayMenu()
}
