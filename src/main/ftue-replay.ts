import { PREFS } from './store/prefs'
import { route } from './routing'
import type { PermissionCheck, PermissionKey, PermissionTest } from '../shared/types'
import { IS_DEV, devLog, DEV_MOCK_PREFIX } from '../shared/env'
import type { TourProbeEventPayload } from '../shared/tour/types'
import { CHANNELS } from '../shared/ipc'
import { getTourWindow } from './tour-window'

// Dev-only first-run replay. Lets us walk the real FTUE chain — permissions
// wizard → welcome banner → value tour — on demand, without uninstalling the
// app or revoking real macOS permissions.
//
// Why a MOCK layer rather than just resetting the flags: the wizard's content is
// driven by live TCC self-tests, not by a pref. On a dev machine those already
// pass, so a flag-only reset shows every row pre-verified — the exact opposite
// of what a new user sees. Mock mode fakes the *check results* so the wizard
// renders its un-granted states, while the real grants stay untouched (hotkeys
// keep working the whole time).
//
// Inert in production: every entry point is IS_DEV-gated, and the IPC layer only
// consults this module when mock mode is actually on.

/** Which permissions report as "not yet granted" while mock mode is on. */
const MOCK_UNGRANTED: PermissionKey[] = ['accessibility', 'screen', 'microphone']

// Keys the user has "granted" during this mock run. Clicking Grant/Test in the
// wizard moves a key in here, so the flow advances exactly like a real one
// instead of being stuck un-granted forever.
const mockGranted = new Set<PermissionKey>()

export function isFtueMockActive(): boolean {
  return IS_DEV && PREFS.getFtueMock()
}

/**
 * Fake permission checks for the wizard. Mirrors buildPermissionChecks()'s shape
 * so the renderer can't tell the difference — keys the mock run hasn't "granted"
 * yet come back failing, the rest come back verified.
 *
 * Every result carries `mocked: true`, and surfaces MUST label off that flag —
 * the DEV_MOCK_PREFIX on `detail` renders only mid-grant, so it is not a
 * reliable marker on its own. See `make why ftue mock`.
 */
export function mockPermissionChecks(): PermissionCheck[] {
  return MOCK_UNGRANTED.map((key) => {
    const granted = mockGranted.has(key)
    return {
      key,
      status: granted ? 'granted' : 'denied',
      test: granted
        ? { ok: true, mocked: true }
        : {
            ok: false,
            detail: `${DEV_MOCK_PREFIX} not granted yet.`,
            mocked: true,
            mockUnwinnable: key === 'screen'
          }
    }
  })
}

/**
 * Fake self-test. First call for a key "grants" it, so the flow advances like a
 * real one. `screen` is the deliberate exception — it NEVER grants, which is
 * what keeps the drag-to-add coach state reachable. Safe only because screen is
 * skippable; a hard gate would strand the replay. See `make why ftue mock`.
 */
export function mockSelfTest(key: PermissionKey): PermissionTest {
  if (key === 'screen') {
    return {
      ok: false,
      detail: `${DEV_MOCK_PREFIX} not in the list yet.`,
      mocked: true,
      // Pressing Allow here can never succeed. Without this the step offered a
      // live-looking button against a hardcoded refusal, which reads exactly
      // like the app failing to see a permission the user just granted.
      mockUnwinnable: true
    }
  }
  if (mockGranted.has(key)) return { ok: true, mocked: true }
  mockGranted.add(key)
  return { ok: true, mocked: true }
}

// Resets FTUE flags and reopens first-run as a new user. mock:false replays against real TCC grants, no fakery.
export function replayFirstRun({ mock = true }: { mock?: boolean } = {}): void {
  if (!IS_DEV) return

  PREFS.setFtueMock(mock)
  mockGranted.clear()

  PREFS.setOnboardingComplete(false)
  PREFS.setTourSeen(false)

  devLog.log(
    mock
      ? '[ftue-replay] mock first run started — real permissions untouched'
      : '[ftue-replay] real first run started — live TCC checks, no fakery'
  )
  route('firstRun')
}

/**
 * Leave mock mode and restore the real flags, so a replay can't strand the app
 * pretending onboarding was never done. Called when the mocked wizard finishes.
 */
export function endFtueMock(): void {
  if (!PREFS.getFtueMock()) return
  PREFS.setFtueMock(false)
  mockGranted.clear()
  PREFS.setOnboardingComplete(true)
  devLog.log('[ftue-replay] mock first run finished — flags restored')
}

/**
 * Bail out of a replay mid-run: mock off, real TCC visible again, onboarding
 * flags left alone because the user did NOT finish. Distinct from endFtueMock,
 * which also marks onboarding done. See `make why ftue mock`.
 */
export function exitFtueMock(): void {
  if (!PREFS.getFtueMock()) return
  PREFS.setFtueMock(false)
  mockGranted.clear()
  devLog.log('[ftue-replay] mock exited mid-run — showing real permissions')
}

/**
 * dev-only escape hatch for the tour's press-to-confirm steps, so a
 * replay doesn't require physically pressing all three chords every time.
 * Fakes a 'hit' straight to the tour window — same payload shape a real probe
 * hit sends, so useHotkeyConfirm can't tell the difference. IS_DEV-gated like
 * the rest of this module; inert (and unreachable — nothing calls it) in prod.
 */
export function mockConfirmTourStep(): void {
  if (!IS_DEV) return
  const win = getTourWindow()
  if (!win || win.isDestroyed()) return
  const payload: TourProbeEventPayload = { kind: 'hit' }
  win.webContents.send(CHANNELS.tourProbeEvent, payload)
}

/**
 * Dev-only: fake the live ⌘⌥⇧ held-state without physically holding the keys.
 *
 * Exists because the chord-held frame — three modifiers down, letter cap
 * revealed but NOT yet pressed — is the one state you cannot inspect by hand:
 * holding the chord means you can't also drive devtools, and letting go to look
 * tears the frame down. Several cap-color bugs were mis-diagnosed for exactly
 * that reason. Reachable from the tour window's own console via
 * `window.api.tour.mockMods(true)`.
 */
export function mockTourMods(down: boolean): void {
  if (!IS_DEV) return
  const win = getTourWindow()
  if (!win || win.isDestroyed()) return
  const payload: TourProbeEventPayload = {
    kind: 'mods',
    meta: down,
    alt: down,
    shift: down
  }
  win.webContents.send(CHANNELS.tourProbeEvent, payload)
}
