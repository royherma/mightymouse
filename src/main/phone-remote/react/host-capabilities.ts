import { nativeBridge } from './native-bridge'
import type { HostShell } from '../../../shared/types'

export type { HostShell }

export interface HostCapabilities {
  /** Native system haptics can fire during a drag, unlike Safari's web APIs. */
  continuousHaptics: boolean
  /** Native Keychain-backed storage is available. */
  secureCredentialStore: boolean
  /** The shell can register Siri/Shortcuts vocabulary. */
  voiceIntents: boolean
  /** The shell can keep the microphone alive while backgrounded. */
  backgroundAudio: boolean
  /** The shell can present ASWebAuthenticationSession. */
  nativeAuth: boolean
  /**
   * The shell already paints its OWN full-screen connect cover, so the web
   * boot gate would be a second, differently-drawn screen for the same wait.
   * See `RemoteWebView.swift`'s `LaunchView` -- it stays up until `connState`
   * says otherwise, which is precisely the window `bootGate` covers.
   */
  nativeLaunchCover: boolean
  /** A camera QR scan is available. Native-only: no iOS browser engine ships
   *  BarcodeDetector, so the web path could never run here. */
  qrScan: boolean
  /**
   * A tappable URL bar exists to click through a self-signed LAN cert warning.
   *
   * iOS-ONLY by design, and NOT the inverse of `isInstalled()`. This gates the
   * Layer-4 "stranded" dead-end, whose only escape is an "Open in Safari" link.
   * An installed Android/desktop PWA has neither the iOS cert dead-end nor a
   * Safari to escape to, so treating it as unrecoverable strands a user who
   * previously just retried. Keyed off the iOS standalone marker alone --
   * `display-mode: standalone` (Android/desktop) must not select this path.
   */
  canRecoverCertificateWarning: boolean
  /** For telemetry and copy only. Feature code must use the booleans above. */
  shell: HostShell
}

export interface HostDetectionEnvironment {
  /** `navigator.standalone` — iOS-only, set only for a Home Screen launch. */
  standalone: boolean
  /** `display-mode: standalone` — Android/desktop; Safari never sets it. */
  displayModeStandalone: boolean
  nativeBridge: boolean
}

export function detectCapabilities(env: HostDetectionEnvironment): HostCapabilities {
  const shell: HostShell = env.nativeBridge
    ? 'native'
    : env.standalone || env.displayModeStandalone
      ? 'pwa'
      : 'safari'
  const native = shell === 'native'
  return {
    continuousHaptics: native,
    secureCredentialStore: native,
    voiceIntents: native,
    backgroundAudio: native,
    nativeAuth: native,
    qrScan: native,
    nativeLaunchCover: native,
    // The native shell has no URL bar either, so only a non-standalone browser
    // tab can recover -- but an Android PWA is excluded via `standalone`, not
    // via `shell`, which is the distinction the PWA regression turned on.
    canRecoverCertificateWarning: !native && !env.standalone,
    shell
  }
}

function readEnvironment(): HostDetectionEnvironment {
  if (typeof window === 'undefined') {
    return { standalone: false, displayModeStandalone: false, nativeBridge: false }
  }
  return {
    standalone: window.navigator.standalone === true,
    displayModeStandalone: window.matchMedia('(display-mode: standalone)').matches,
    // Either signal proves a native launch. `available` alone is one live
    // property read, and `capabilities` is frozen for the page -- so a handler
    // that is not attached at that instant froze the native app as `pwa` for
    // the whole session, costing it the Keychain, the launch cover and its
    // journal label. The bootstrap object is injected by the same shell and
    // does not depend on the handler, so it catches that case.
    nativeBridge: nativeBridge.available || nativeBridge.bootstrapPresent()
  }
}

/** Frozen for the lifetime of a page. A host cannot change without a reload. */
export const capabilities = Object.freeze(detectCapabilities(readEnvironment()))

export function isInstalled(): boolean {
  return capabilities.shell !== 'safari'
}

declare global {
  interface Navigator {
    standalone?: boolean
  }
}
