/**
 * Permissions on Windows — there are none to gate on.
 *
 * This is not a stub and not a fake pass; it is the honest answer. macOS asks
 * for Accessibility before it may synthesize a keystroke and Screen Recording
 * before it may read a pixel. Windows asks for neither: SendKeys and
 * GetForegroundWindow work for any process at the same integrity level, with no
 * grant, no pane, and nothing for a wizard to walk the user through.
 *
 * So `list()` is empty and `requiredPermissionKeys()` is empty, and the
 * onboarding wizard shows no permission step rather than three rows that all
 * say "not applicable". The one real Windows privacy gate — the microphone
 * toggle in Settings — belongs to capture, which is Tier 2 and has no
 * caller here yet; adding a row for a feature that doesn't ship would be the
 * fake-pass in reverse.
 *
 * The one boundary this cannot cross is elevation: a window running as admin
 * while we are not silently discards our synthetic input (User Interface
 * Privilege Isolation). That is not a permission — nothing can grant it —
 * so it is documented at the point it bites, in selection.ts.
 */
import { shell } from 'electron'
import type {
  PermissionCheck,
  PermissionKey,
  PermissionState,
  PermissionTest
} from '../../../shared/types'
import type { PermissionsApi } from '../contract'

/** Nothing is gated, so every probe passes. Named so the shape is obviously
 *  deliberate rather than a placeholder someone forgot to fill in. */
const NOTHING_TO_GRANT: PermissionTest = { ok: true }

export const PERMISSIONS: PermissionsApi = {
  // True, not false. Callers read this as "may I synthesize input" — and we may.
  // Returning false would have them disable the hotkey paths that in fact work.
  hasAccessibility: () => true,
  list: (): PermissionState[] => [],
  request: () => Promise.resolve(),
  openPane: (key: PermissionKey) => {
    // Windows has one privacy pane that maps to anything we might ever ask for.
    // Nothing routes here today (list() is empty, so the UI offers no button),
    // but a Tier 2 mic feature will, and sending the user to the right page
    // beats a no-op they can't tell from a broken button.
    if (key === 'microphone') void shell.openExternal('ms-settings:privacy-microphone')
  }
}

export function requiredPermissionKeys(): PermissionKey[] {
  return []
}

export function runSelfTest(): Promise<PermissionTest> {
  return Promise.resolve(NOTHING_TO_GRANT)
}

export function buildPermissionChecks(): Promise<PermissionCheck[]> {
  return Promise.resolve([])
}

/**
 * True only when the user has never finished the wizard.
 *
 * The macOS version also re-gates a user whose permission grant later broke.
 * With no permissions to break, that clause has nothing to test — so the
 * remaining reason to show onboarding is the one thing it still does on
 * Windows: installing a backend CLI.
 */
export function needsOnboarding(onboardingComplete: boolean): Promise<boolean> {
  return Promise.resolve(!onboardingComplete)
}
