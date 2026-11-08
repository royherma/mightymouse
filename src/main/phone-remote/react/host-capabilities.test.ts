import { describe, expect, it } from 'vitest'
import { detectCapabilities } from './host-capabilities'

describe('host capability negotiation', () => {
  it.each([
    [
      'Safari tab',
      { standalone: false, displayModeStandalone: false, nativeBridge: false },
      { shell: 'safari', continuousHaptics: false, secureCredentialStore: false, canRecoverCertificateWarning: true }
    ],
    [
      'installed iOS PWA (no URL bar, cannot clear a cert warning)',
      { standalone: true, displayModeStandalone: false, nativeBridge: false },
      { shell: 'pwa', continuousHaptics: false, secureCredentialStore: false, canRecoverCertificateWarning: false }
    ],
    [
      // Regression guard: display-mode is the Android/desktop marker. Treating
      // it as unrecoverable routed these users into the iOS-only stranded
      // dead-end, whose only exit is an "Open in Safari" link they don't have.
      'installed Android/desktop PWA still recovers via its URL bar',
      { standalone: false, displayModeStandalone: true, nativeBridge: false },
      { shell: 'pwa', continuousHaptics: false, secureCredentialStore: false, canRecoverCertificateWarning: true }
    ],
    [
      'native shell',
      { standalone: true, displayModeStandalone: true, nativeBridge: true },
      { shell: 'native', continuousHaptics: true, secureCredentialStore: true, canRecoverCertificateWarning: false }
    ]
  ])('%s negotiates the right host', (_name, env, expected) => {
    expect(detectCapabilities(env)).toMatchObject(expected)
  })

  it('keeps native capabilities independent of PWA markers', () => {
    expect(
      detectCapabilities({ standalone: false, displayModeStandalone: false, nativeBridge: true })
    ).toMatchObject({ shell: 'native', voiceIntents: true, backgroundAudio: true, nativeAuth: true })
  })

  // No iOS browser engine ships BarcodeDetector, so a scan offered anywhere but
  // the native shell is a button that opens nothing.
  it.each([
    ['Safari', { standalone: false, displayModeStandalone: false, nativeBridge: false }, false],
    ['installed PWA', { standalone: true, displayModeStandalone: false, nativeBridge: false }, false],
    ['native shell', { standalone: false, displayModeStandalone: false, nativeBridge: true }, true]
  ])('offers a QR scan on %s: %s', (_name, env, expected) => {
    expect(detectCapabilities(env).qrScan).toBe(expected)
  })

  // The real WKWebView environment: BOTH PWA markers are false, because
  // `navigator.standalone` and `display-mode: standalone` each answer "launched
  // from a Home Screen icon" and the native app was not. This is what left the
  // native shell on theme.css's Safari branch -- controls sitting on the home
  // indicator -- while the app was chrome-free and full-screen like the PWA.
  it('reports native for a WKWebView that sets neither PWA marker', () => {
    expect(
      detectCapabilities({ standalone: false, displayModeStandalone: false, nativeBridge: true }).shell
    ).toBe('native')
  })
})

// theme.css cannot be unit-tested, so this locks the CONTRACT it depends on:
// every shell that runs chrome-free over a real home indicator must be
// reachable from CSS. `display-mode: standalone` covers only the PWA, so the
// stylesheet also selects `html[data-shell='native']`, stamped by main.tsx.
describe('safe-area shells reachable from CSS', () => {
  it.each([
    ['installed iOS PWA', { standalone: true, displayModeStandalone: false, nativeBridge: false }],
    ['native iOS shell', { standalone: false, displayModeStandalone: false, nativeBridge: true }]
  ])('%s is chrome-free and must get the safe-area floor', (_name, env) => {
    const shell = detectCapabilities(env).shell
    expect(shell).not.toBe('safari')
    // Selector parity: the PWA is matched by the media query, native by the
    // attribute. A new chrome-free shell would fail here until theme.css grows
    // a matching selector.
    expect(['pwa', 'native']).toContain(shell)
  })
})
