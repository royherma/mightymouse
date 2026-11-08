import type { AuthUser } from './auth'
import type { PanelOpenSource } from '../shared/analytics-events'
import type { TourSource } from '../shared/tour/types'
import { TOUR } from '../shared/tour/constants'
import type { WelcomeVariant } from '../shared/types'
import { PREFS } from './store/prefs'
import { showAuthWindow } from './auth-window'
import { showOnboardingWindow } from './onboarding-window'
import { showPanelWindow } from './panel-window'
import { showMightyWindow } from './mighty/mighty-window'
import { SETTINGS } from './store/settings'
import { UNREAD } from './store/unread'
import { PANEL_SOURCE_TOUR } from '../shared/analytics-events'
import { showSetupWindow } from './setup-window'
import { showTourWindow } from './tour-window'
import { getFirstRunWindow, showFirstRunWindow } from './first-run-window'

/**
 * The four states any surface-opening decision depends on. Resolved once, here,
 * instead of re-derived (or forgotten) at each call site.
 *
 * `midWizard` outranks `needsPerms` because a wizard the user never finished is
 * a stronger signal than the permission probe: Screen Recording is optional
 * (platform/macos/permissions.ts), so someone who quit on that step probes as
 * "doesn't need onboarding" and used to land on the panel mid-wizard.
 */
export type AppState = 'signedOut' | 'needsPerms' | 'midWizard' | 'ready'

export type Intent =
  | 'panel'
  | 'tour'
  | 'setup'
  | 'onboarding'
  /** The hand-off after the wizard finishes OR is abandoned: tour if unseen, else panel. */
  | 'postOnboarding'
  | 'auth'
  /** New-user chooser + phone/code path — replaces onboarding+tour for `needsPerms`. */
  | 'firstRun'

export interface RouteArg {
  panelSource?: PanelOpenSource
  welcome?: WelcomeVariant
  tourSource?: TourSource
  /** Onboarding only: swaps the header copy so a re-grant doesn't read as a reset. */
  reauth?: boolean
}

/**
 * Auth is owned by index.ts (module-local `currentUser`, kept fresh by the auth
 * broadcast). Routing reads it through this hook rather than importing index.ts,
 * which would be a cycle: index → routing → index.
 */
let readUser: () => AuthUser | null = () => null

/**
 * Set when the user closes the onboarding gate on purpose. The gate is
 * alwaysOnTop and usually the only window, so closing it leaves zero restorable
 * windows — which makes macOS fire `activate`, which routes 'panel', which
 * re-gated straight back to onboarding. One user (jiggygent, 2026-08-30, v0.39.0)
 * was trapped in that loop for 4 minutes: 9 × abandoned → started within 1s each
 * time, then quit and never came back.
 *
 * Skipping the gate is already the abandon contract — onAbandon starts the app
 * tail (index.ts). This just stops route() from undoing that decision.
 */
let onboardingAbandoned = false

export function markOnboardingAbandoned(): void {
  onboardingAbandoned = true
}

export function configureRouting(opts: { user: () => AuthUser | null }): void {
  readUser = opts.user
}

/**
 * Synchronous state resolution. Deliberately does NOT run the macOS permission
 * self-test — that probe is async and can wedge (see gateAfterAuth's timeout),
 * and a surface-opening click cannot wait on it. `needsPerms` is therefore
 * derived from the persisted onboarding-complete flag, which is what the probe
 * writes when it passes.
 */
export function resolveState(): AppState {
  if (!readUser()) return 'signedOut'
  if (!PREFS.getOnboardingComplete()) {
    return PREFS.getOnboardingStep() ? 'midWizard' : 'needsPerms'
  }
  return 'ready'
}

/**
 * THE chokepoint. Every surface-opening path in main goes through here.
 *
 * Callers name an INTENT, never a window — so a signed-out `route('panel')`
 * lands on auth by construction, not because someone remembered to check. The
 * window modules are private to this file (they export their `show*` only to
 * routing), which is what makes a gate-skipping entry point unwritable rather
 * than merely discouraged.
 *
 * Verified failures this replaces (2026-09-03, prds/active/…-routing-chokepoint):
 * a signed-out tester got the wizard from the tray, then the panel from the
 * wizard's red X.
 */
export function route(intent: Intent, arg: RouteArg = {}): void {
  const state = resolveState()

  // Signed out, every intent collapses to one surface. Nothing else in the app
  // works without a JWT: the panel's actions all need one, and the wizard grants
  // permissions for an app tail that will not start.
  if (state === 'signedOut') {
    showAuthWindow()
    return
  }

  switch (intent) {
    case 'auth':
      showAuthWindow()
      return

    case 'onboarding':
      showOnboardingWindow({ reauth: arg.reauth ?? PREFS.getOnboardingComplete() })
      return

    case 'setup':
      showSetupWindow()
      return

    case 'firstRun':
      showFirstRunWindow()
      return

    case 'postOnboarding':
      if (getFirstRunWindow()) return
      // TourSeen is the authority, not the onboarding flag: that flag survives a
      // re-grant, so a user who quit before ever reaching the tour came back as
      // "returning" and got the panel with TourSeen still unset.
      if (PREFS.getTourSeen())
        route('panel', { panelSource: 'welcome', welcome: arg.welcome ?? 'returning' })
      else showTourWindow(arg.tourSource ?? TOUR.SOURCE.auto)
      return

    case 'tour':
      showTourWindow(arg.tourSource ?? TOUR.SOURCE.auto)
      return

    case 'panel':
      // needsPerms = a genuinely new user → first-run, not the legacy wizard.
      if (state === 'needsPerms' && !onboardingAbandoned) {
        showFirstRunWindow()
        return
      }
      if (state === 'midWizard' && !onboardingAbandoned) {
        showOnboardingWindow({ reauth: false })
        return
      }
      if (!SETTINGS.get().smallPanel && arg.panelSource !== PANEL_SOURCE_TOUR) {
        if (arg.panelSource === 'history') {
          UNREAD.clear()
          showMightyWindow(false, undefined, '')
        } else showMightyWindow()
        return
      }
      showPanelWindow(arg.panelSource ?? 'other', arg.welcome)
      return
  }
}
