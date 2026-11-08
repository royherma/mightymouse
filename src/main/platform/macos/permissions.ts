import { systemPreferences, shell } from 'electron'
import { PermissionKey, PermissionState, PermissionStatus } from '../../../shared/types'
import { track } from '../../analytics'
import { ANALYTICS_EVENT } from '../../../shared/analytics-events'
import { reportsForPoll } from '../../../shared/permission-report'

// Last status we reported per permission, so list() emits on CHANGE only. The UI
// polls list() on a timer; without this every poll would be an analytics row.
// Process-local by design: a restart re-emitting once is the cheap, honest way to
// catch a grant that happened while the app was closed.
const lastReported = new Map<PermissionKey, PermissionStatus>()

function reportPermissionChanges(states: PermissionState[]): void {
  // The decision of what's worth emitting lives in shared/ so it can be tested
  // without Electron — see permission-report.ts for why that mattered here.
  for (const r of reportsForPoll(states, lastReported)) {
    track(ANALYTICS_EVENT.permission_granted, r)
  }
}


function accessibilityStatus(prompt = false): PermissionStatus {
  try {
    return systemPreferences.isTrustedAccessibilityClient(prompt) ? 'granted' : 'denied'
  } catch (err) {
    console.error('accessibility check failed:', err)
    return 'unknown'
  }
}

function screenStatus(): PermissionStatus {
  try {
    // getMediaAccessStatus('screen') => 'granted' | 'denied' | 'restricted' | 'not-determined'
    const s = systemPreferences.getMediaAccessStatus('screen')
    if (s === 'granted') return 'granted'
    if (s === 'denied' || s === 'restricted') return 'denied'
    return 'unknown'
  } catch (err) {
    console.error('screen check failed:', err)
    return 'unknown'
  }
}

function micStatus(): PermissionStatus {
  try {
    const s = systemPreferences.getMediaAccessStatus('microphone')
    if (s === 'granted') return 'granted'
    if (s === 'denied' || s === 'restricted') return 'denied'
    return 'unknown'
  } catch (err) {
    console.error('mic check failed:', err)
    return 'unknown'
  }
}

const PANE: Record<PermissionKey, string> = {
  accessibility: 'Privacy_Accessibility',
  screen: 'Privacy_ScreenCapture',
  microphone: 'Privacy_Microphone'
}

export const PERMISSIONS = {
  /** Back-compat shim for existing callers. */
  hasAccessibility(prompt = false): boolean {
    return accessibilityStatus(prompt) === 'granted'
  },

  list(): PermissionState[] {
    const states: PermissionState[] = [
      {
        key: 'accessibility',
        label: 'Accessibility',
        status: accessibilityStatus(false),
        description: 'Read text selection and paste rewrites. Required for the rewrite/ask panel.',
        required: true
      },
      {
        // Optional by design: the core loop (select text → hotkey → answer) needs
        // only Accessibility. Marking this required made a denial unrecoverable —
        // needsOnboarding() re-opened the wizard on every launch and the app tail
        // never started, so the app did nothing forever over a permission its main
        // feature never touches. Capture actions now ask for it at the moment they
        // need it (ensureScreenPermission).
        key: 'screen',
        label: 'Screen Recording',
        status: screenStatus(),
        description: 'Capture screenshots and record the screen.',
        required: false
      },
      {
        key: 'microphone',
        label: 'Microphone',
        status: micStatus(),
        description: 'Record audio for transcription during screen recordings.',
        required: false
      }
    ]
    reportPermissionChanges(states)
    return states
  },

  /**
   * Trigger the OS prompt where possible, else deep-link to the right pane.
   *
   * Two users were stranded here: the screen request was a silent
   * no-op AND we opened System Settings on top of the prompt we'd just asked
   * for. Both are fixed below; see the design for the forensics.
   */
  async request(key: PermissionKey): Promise<void> {
    if (key === 'accessibility') {
      // Fires the system prompt if not yet trusted. macOS shows its own
      // "Open System Settings" dialog here, so opening the pane ourselves would
      // land a second window on top of it.
      accessibilityStatus(true)
      if (accessibilityStatus(false) !== 'granted') this.openPane(key)
      return
    } else if (key === 'microphone') {
      // askForMediaAccess resolves TRUE once the user allows, and only shows a
      // prompt on the first ask. Open the pane just for the already-answered
      // case — doing it unconditionally steals focus from the live prompt.
      try {
        if (await systemPreferences.askForMediaAccess(key)) return
      } catch (err) {
        console.error(`askForMediaAccess(${key}) failed:`, err)
      }
      this.openPane(key)
      return
    } else if (key === 'screen') {
      // Electron's desktopCapturer/systemPreferences have no call that reliably
      // registers the app in the TCC Screen Recording list — only the real
      // CGRequestScreenCaptureAccess() C function does that (confirmed: Electron's
      // own getSources() only started wrapping this in v29+ and still hangs on
      // some macOS versions). node-mac-permissions exposes it directly.
      //
      // The `true` is load-bearing. `openPreferences` defaults to FALSE, and the
      // native code reads it only on the path where macOS refused to show the
      // prompt (already-denied, or another TCC dialog is up) — so without it the
      // call returns having done nothing at all: no dialog, no TCC row, no throw.
      // Passing true makes the native side open the pane itself in exactly that
      // case, guarded by its own HasOpenSystemPreferencesDialog() check.
      try {
        // Lazy: this is the only native `.node` binding in platform/, and it must
        // never load on win32 (optionalDependency, darwin-only).
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { askForScreenCaptureAccess } = require('node-mac-permissions') as { askForScreenCaptureAccess: (openPreferences?: boolean) => void }
        askForScreenCaptureAccess(true)
      } catch (err) {
        console.error('askForScreenCaptureAccess failed:', err)
      }
      // The native call opens the pane only where macOS refused to prompt. It
      // does NOTHING when the TCC grant already exists — the exact case where
      // our functional self-test still fails (grant present, capture broken
      // until the app is relaunched). That combination made Allow look dead:
      // no prompt, no pane, no change. Open the pane ourselves in that case
      // only, so the button always produces something the user can act on.
      if (screenStatus() === 'granted') this.openPane(key)
      return
    }
    this.openPane(key)
  },

  openPane(key: PermissionKey): void {
    const pane = PANE[key]
    shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${pane}`)
  }
}

/**
 * The required permissions whose functional self-test must pass before the app
 * tail (hotkeys + capture) is allowed to start. Microphone is optional and so
 * is excluded here. Derived from `PERMISSIONS.list()` so it stays in sync with
 * the `required` flags rather than duplicating the key list.
 */
export function requiredPermissionKeys(): PermissionKey[] {
  return PERMISSIONS.list()
    .filter((p) => p.required)
    .map((p) => p.key)
}
