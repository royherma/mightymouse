import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { AuthUser } from '../auth'
import type { Intent } from '../routing'

// The whole point of routing.ts is that an INTENT plus a STATE decides which
// window opens. So the test is that table: 6 intents × 4 states, asserting the
// window each pair lands on. Two rows are the tester-reported bugs from
// 2026-09-03 — a signed-out user got the wizard, then the panel.
//
// Every window module is mocked: they all reach 'electron', which doesn't load
// in this repo's node-environment vitest. What's under test is the DECISION, not
// Electron's window plumbing.

const showAuthWindow = vi.fn()
const showOnboardingWindow = vi.fn()
const showPanelWindow = vi.fn()
const showSetupWindow = vi.fn()
const showTourWindow = vi.fn()
const showMightyWindow = vi.fn()
const showFirstRunWindow = vi.fn()

let onboardingComplete = false
let onboardingStep: string | null = null
let tourSeen = false
let smallPanel = true

vi.mock('../auth-window', () => ({ showAuthWindow }))
vi.mock('../onboarding-window', () => ({ showOnboardingWindow }))
vi.mock('../panel-window', () => ({ showPanelWindow }))
vi.mock('../setup-window', () => ({ showSetupWindow }))
vi.mock('../tour-window', () => ({ showTourWindow }))
vi.mock('../mighty/mighty-window', () => ({ showMightyWindow }))
vi.mock('../first-run-window', () => ({ showFirstRunWindow, getFirstRunWindow: () => null }))
vi.mock('../store/settings', () => ({ SETTINGS: { get: () => ({ smallPanel }) } }))
vi.mock('../store/prefs', () => ({
  PREFS: {
    getOnboardingComplete: () => onboardingComplete,
    getOnboardingStep: () => onboardingStep,
    getTourSeen: () => tourSeen
  }
}))

const USER: AuthUser = { id: 'u1', email: 'test@example.com' } as AuthUser

/** The four states, expressed as the prefs + auth combination that produces each. */
const STATES = {
  signedOut: { user: null, complete: false, step: null },
  needsPerms: { user: USER, complete: false, step: null },
  midWizard: { user: USER, complete: false, step: 'accessibility' },
  ready: { user: USER, complete: true, step: null }
} as const

type StateName = keyof typeof STATES

async function routeIn(state: StateName, intent: Intent): Promise<void> {
  const s = STATES[state]
  onboardingComplete = s.complete
  onboardingStep = s.step
  const { route, configureRouting } = await import('../routing')
  configureRouting({ user: () => s.user })
  route(intent)
}

/** Which mock fired, as a name — so a failure names the window, not a call count. */
function opened(): string {
  if (showAuthWindow.mock.calls.length) return 'auth'
  if (showOnboardingWindow.mock.calls.length) return 'onboarding'
  if (showTourWindow.mock.calls.length) return 'tour'
  if (showPanelWindow.mock.calls.length) return 'panel'
  if (showMightyWindow.mock.calls.length) return 'mighty'
  if (showSetupWindow.mock.calls.length) return 'setup'
  if (showFirstRunWindow.mock.calls.length) return 'firstRun'
  return 'none'
}

describe('route()', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    tourSeen = false
    smallPanel = true
  })

  // Signed out collapses every intent to auth. This is the class of bug the
  // module exists to make unwritable, so it's asserted for ALL six intents
  // rather than just the two that were reported.
  const INTENTS: Intent[] = ['panel', 'tour', 'setup', 'onboarding', 'postOnboarding', 'auth']
  for (const intent of INTENTS) {
    it(`signedOut + ${intent} → auth`, async () => {
      await routeIn('signedOut', intent)
      expect(opened()).toBe('auth')
    })
  }

  // The two bugs the tester hit, called out by name so a regression names itself.
  it('BUG 1: a signed-out tray "finish setup" click does not open the wizard', async () => {
    await routeIn('signedOut', 'onboarding')
    expect(showOnboardingWindow).not.toHaveBeenCalled()
    expect(showAuthWindow).toHaveBeenCalled()
  })

  it('BUG 2: abandoning the wizard while signed out does not open the panel or tour', async () => {
    await routeIn('signedOut', 'postOnboarding')
    expect(showPanelWindow).not.toHaveBeenCalled()
    expect(showTourWindow).not.toHaveBeenCalled()
    expect(showAuthWindow).toHaveBeenCalled()
  })

  it('needsPerms + panel → first run (its buttons would no-op)', async () => {
    await routeIn('needsPerms', 'panel')
    expect(opened()).toBe('firstRun')
  })

  it('midWizard + panel → onboarding, resuming the unfinished step', async () => {
    await routeIn('midWizard', 'panel')
    expect(opened()).toBe('onboarding')
    expect(showOnboardingWindow).toHaveBeenCalledWith({ reauth: false })
  })

  it('ready + panel → panel', async () => {
    await routeIn('ready', 'panel')
    expect(opened()).toBe('panel')
  })

  it('ready + panel with small panel off → main window', async () => {
    smallPanel = false
    await routeIn('ready', 'panel')
    expect(opened()).toBe('mighty')
  })

  it('ready + tray History with small panel off → main window on the Library tab, unread badge cleared', async () => {
    const { UNREAD } = await import('../store/unread')
    UNREAD.mark('run-a')
    UNREAD.mark('run-b')
    smallPanel = false
    const { route, configureRouting } = await import('../routing')
    onboardingComplete = true
    onboardingStep = null
    configureRouting({ user: () => USER })
    route('panel', { panelSource: 'history' })
    expect(showMightyWindow).toHaveBeenCalledWith(false, undefined, '')
    expect(UNREAD.count()).toBe(0)
  })

  it('ready + panel from elsewhere with small panel off → main window as it was, unread kept', async () => {
    const { UNREAD } = await import('../store/unread')
    UNREAD.clear()
    UNREAD.mark('run-c')
    smallPanel = false
    const { route, configureRouting } = await import('../routing')
    onboardingComplete = true
    onboardingStep = null
    configureRouting({ user: () => USER })
    route('panel', { panelSource: 'dock' })
    expect(showMightyWindow).toHaveBeenCalledWith()
    expect(UNREAD.count()).toBe(1)
  })

  it('ready + setup → setup', async () => {
    await routeIn('ready', 'setup')
    expect(opened()).toBe('setup')
  })

  // TourSeen is the authority on the hand-off, not the onboarding flag: that flag
  // survives a re-grant, so a user who quit before reaching the tour came back
  // "returning" and got the panel with TourSeen still unset.
  it('ready + postOnboarding → tour when the tour is unseen', async () => {
    tourSeen = false
    await routeIn('ready', 'postOnboarding')
    expect(opened()).toBe('tour')
  })

  it('ready + postOnboarding → panel once the tour has been seen', async () => {
    tourSeen = true
    await routeIn('ready', 'postOnboarding')
    expect(opened()).toBe('panel')
  })

  it('ready + postOnboarding with small panel off → main window', async () => {
    tourSeen = true
    smallPanel = false
    await routeIn('ready', 'postOnboarding')
    expect(opened()).toBe('mighty')
  })

  it('ready + onboarding passes reauth, so a re-grant does not read as a reset', async () => {
    await routeIn('ready', 'onboarding')
    expect(showOnboardingWindow).toHaveBeenCalledWith({ reauth: true })
  })

  // jiggygent, 2026-08-30, v0.39.0: closing the gate left no restorable window,
  // macOS fired `activate`, index.ts routed 'panel', and needsPerms reopened the
  // gate — 9 times in 4 minutes, then he quit for good.
  it('BUG 3: after abandoning, panel no longer re-gates to first run', async () => {
    const { route, configureRouting, markOnboardingAbandoned } = await import('../routing')
    onboardingComplete = false
    onboardingStep = null
    configureRouting({ user: () => USER })

    route('panel', { panelSource: 'dock' })
    expect(opened()).toBe('firstRun')

    vi.clearAllMocks()
    markOnboardingAbandoned()
    route('panel', { panelSource: 'dock' })
    expect(showFirstRunWindow).not.toHaveBeenCalled()
    expect(showOnboardingWindow).not.toHaveBeenCalled()
    expect(showPanelWindow).toHaveBeenCalled()
  })
})
