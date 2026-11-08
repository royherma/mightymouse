/**
 * Turns a phone's User-Agent into something a human recognizes in Settings, so
 * "which one am I about to revoke?" has an answer. Deliberately coarse: a model
 * class and a browser/PWA surface, never a fingerprint.
 */

import type { PhoneRemoteDeviceKind, HostShell } from '../../shared/types'
import { CONFIG } from '../../shared/config'

/** Named-lookup form of PHONE_REMOTE_DEVICE_KINDS. `unknown` covers pre-upgrade rows. */
const DEVICE_KIND = {
  iphone: 'iphone',
  ipad: 'ipad',
  android: 'android',
  mac: 'mac',
  unknown: 'unknown'
} as const satisfies Record<PhoneRemoteDeviceKind, PhoneRemoteDeviceKind>

type DeviceKind = PhoneRemoteDeviceKind

/** One paired device as Settings renders it. `surface` is how it's running
 *  ("Safari" / "Home Screen app"); `browser` is the engine WITHOUT that
 *  override, which analytics still needs. Versions are major-only, and iOS
 *  writes its `17_5` with an underscore -- normalized to dots here. */
export type DeviceIdentity = {
  kind: DeviceKind
  model: string
  surface: string
  browser: string
  browserVersion: string | null
  os: string
  osVersion: string | null
}

const UNKNOWN_IDENTITY: DeviceIdentity = {
  kind: DEVICE_KIND.unknown,
  model: 'Unknown device',
  surface: '',
  browser: '',
  browserVersion: null,
  os: '',
  osVersion: null
}

/** Both standalone surfaces, and the reason `shell` exists: the iOS app's
 *  WKWebView sends a stock Safari UA and pairs with the same standalone flag. */
const HOME_SCREEN_SURFACE = 'Home Screen app'
const NATIVE_SURFACE = `${CONFIG.IOS_APP_NAME} app`

/**
 * An iPad in desktop mode sends a macOS UA and lands in `mac`. Accepted -- this
 * is a display label, not an auth decision.
 */
export function parseDeviceIdentity(
  userAgent: string | undefined | null,
  standalone = false,
  shell: HostShell | null = null
): DeviceIdentity {
  if (!userAgent) {
    const surface = shellSurface(shell) ?? (standalone ? HOME_SCREEN_SURFACE : '')
    return { ...UNKNOWN_IDENTITY, surface }
  }
  const ua = userAgent.toLowerCase()

  let kind: DeviceKind = DEVICE_KIND.unknown
  let model = 'Unknown device'
  if (/\biphone\b/.test(ua)) {
    kind = DEVICE_KIND.iphone
    model = 'iPhone'
  } else if (/\bipad\b/.test(ua)) {
    kind = DEVICE_KIND.ipad
    model = 'iPad'
  } else if (/\bipod\b/.test(ua)) {
    kind = DEVICE_KIND.iphone
    model = 'iPod touch'
  } else if (/\bandroid\b/.test(ua)) {
    kind = DEVICE_KIND.android
    model = /\bmobile\b/.test(ua) ? 'Android phone' : 'Android tablet'
  } else if (/\bmacintosh\b|\bmac os x\b/.test(ua)) {
    kind = DEVICE_KIND.mac
    model = 'Mac'
  }

  // An installed iOS PWA sends a UA byte-identical to a Safari tab's, so only
  // the page's own report can separate them. `shell` is the more specific one.
  const surface =
    shellSurface(shell) ?? (standalone ? HOME_SCREEN_SURFACE : parseSurface(ua, kind))
  const { browser, browserVersion } = parseBrowser(ua)
  const { os, osVersion } = parseOs(ua, kind)
  return { kind, model, surface, browser, browserVersion, os, osVersion }
}

/** The label a self-reported shell earns, or null to fall back to the UA -- a
 *  'safari' report is worse than the UA, which names third-party browsers too. */
function shellSurface(shell: HostShell | null): string | null {
  if (shell === 'native') return NATIVE_SURFACE
  if (shell === 'pwa') return HOME_SCREEN_SURFACE
  return null
}

/**
 * ORDER IS LOAD-BEARING: every third-party iOS browser carries `safari` plus its
 * own token and the Chromium ones carry `chrome` too, so vendor tokens must all
 * precede the generic ones. Edge is EdgA on Android, Edg on desktop; Safari's
 * user-facing version is in `Version/`, not the `Safari/604.1` WebKit build.
 */
const BROWSERS: ReadonlyArray<{ name: string; token: RegExp }> = [
  { name: 'Chrome', token: /\bcrios\/([\d.]+)/ },
  { name: 'Firefox', token: /\bfxios\/([\d.]+)/ },
  { name: 'Edge', token: /\bedgios\/([\d.]+)/ },
  { name: 'Opera', token: /\bopios\/([\d.]+)/ },
  { name: 'Edge', token: /\bedga\/([\d.]+)/ },
  { name: 'Edge', token: /\bedg\/([\d.]+)/ },
  { name: 'Samsung Internet', token: /\bsamsungbrowser\/([\d.]+)/ },
  { name: 'Opera', token: /\bopr\/([\d.]+)/ },
  { name: 'Chrome', token: /\bchrome\/([\d.]+)/ },
  { name: 'Firefox', token: /\bfirefox\/([\d.]+)/ },
  { name: 'Safari', token: /\bversion\/([\d.]+).*\bsafari\// },
  { name: 'Safari', token: /\bsafari\/([\d.]+)/ }
]

/** First family whose token appears, with the captured version. */
function matchBrowser(ua: string): { name: string; version: string | null } | null {
  for (const { name, token } of BROWSERS) {
    const hit = token.exec(ua)
    if (hit) return { name, version: hit[1] ?? null }
  }
  return null
}

/** Family + MAJOR version; the rest is dropped here, not at the callsite. */
function parseBrowser(ua: string): { browser: string; browserVersion: string | null } {
  const hit = matchBrowser(ua)
  if (!hit) return { browser: '', browserVersion: null }
  return { browser: hit.name, browserVersion: hit.version?.split('.')[0] ?? null }
}

/** Platform + version, independent of the browser. Apple writes the version with
 *  underscores and Android with dots; normalized so one column holds both. */
function parseOs(ua: string, kind: DeviceKind): { os: string; osVersion: string | null } {
  const ios = /\b(?:iphone )?os (\d+[._]\d+)/.exec(ua)
  if (ios && (kind === DEVICE_KIND.iphone || kind === DEVICE_KIND.ipad)) {
    return { os: 'iOS', osVersion: ios[1].replace(/_/g, '.') }
  }
  const android = /\bandroid (\d+(?:\.\d+)?)/.exec(ua)
  if (android) return { os: 'Android', osVersion: android[1] }
  const mac = /\bmac os x (\d+[._]\d+)/.exec(ua)
  if (mac) return { os: 'macOS', osVersion: mac[1].replace(/_/g, '.') }
  if (kind === DEVICE_KIND.mac) return { os: 'macOS', osVersion: null }
  return { os: '', osVersion: null }
}

/** Which browser -- or none, when it's an installed Home Screen app. Older iOS
 *  PWAs dropped the Safari token; recent ones keep it, so this is only the
 *  fallback for records predating the `standalone` flag. */
function parseSurface(ua: string, kind: DeviceKind): string {
  const family = matchBrowser(ua)?.name
  if (family) return family
  if (kind === DEVICE_KIND.iphone || kind === DEVICE_KIND.ipad) return HOME_SCREEN_SURFACE
  return ''
}

/** Apple hardware identifiers -> marketing names. Lives here, not in the iOS
 *  bundle: the table gains rows every September and a Mac release can carry
 *  them, where the app would need an App Store submission. Partial by design. */
const APPLE_MODEL_NAMES: Readonly<Record<string, string>> = {
  'iPhone14,4': 'iPhone 13 mini',
  'iPhone14,5': 'iPhone 13',
  'iPhone14,2': 'iPhone 13 Pro',
  'iPhone14,3': 'iPhone 13 Pro Max',
  'iPhone14,7': 'iPhone 14',
  'iPhone14,8': 'iPhone 14 Plus',
  'iPhone15,2': 'iPhone 14 Pro',
  'iPhone15,3': 'iPhone 14 Pro Max',
  'iPhone15,4': 'iPhone 15',
  'iPhone15,5': 'iPhone 15 Plus',
  'iPhone16,1': 'iPhone 15 Pro',
  'iPhone16,2': 'iPhone 15 Pro Max',
  'iPhone17,3': 'iPhone 16',
  'iPhone17,4': 'iPhone 16 Plus',
  'iPhone17,1': 'iPhone 16 Pro',
  'iPhone17,2': 'iPhone 16 Pro Max',
  'iPhone17,5': 'iPhone 16e',
  'iPhone18,1': 'iPhone 17 Pro',
  'iPhone18,2': 'iPhone 17 Pro Max',
  'iPhone18,3': 'iPhone 17',
  'iPhone18,4': 'iPhone Air',
  'iPhone18,5': 'iPhone 17e',
  'iPad13,18': 'iPad (10th gen)',
  'iPad14,3': 'iPad Pro 11-inch',
  'iPad14,5': 'iPad Pro 12.9-inch',
  'iPad14,8': 'iPad Air 11-inch',
  'iPad14,10': 'iPad Air 13-inch'
}

/** Returning a miss unchanged handles Chromium's already-readable name
 *  ("Pixel 8") for free -- no branch on which client sent it. */
export function resolveModelName(reported: string): string {
  return APPLE_MODEL_NAMES[reported] ?? reported
}

/** "iPhone · Safari", or just the model when the surface is unknown.
 *  `reportedModel` outranks the UA family -- the whole reason two same-family
 *  phones can be told apart. Already clamped by the time it reaches here. */
export function formatDeviceLabel(
  identity: DeviceIdentity,
  reportedModel: string | null = null
): string {
  const model = reportedModel ? resolveModelName(reportedModel) : identity.model
  return identity.surface ? `${model} · ${identity.surface}` : model
}

/** "iOS 18.7.7", or null when we've never learned a version. `reportedVersion`
 *  outranks the UA: the native app names its own OS exactly, while iOS Safari's
 *  UA rounds to a two-part `18_7`. Falls back to the bare platform when only the
 *  family is known, since "iOS" still beats a blank line. */
export function formatOsLabel(
  identity: DeviceIdentity,
  reportedVersion: string | null = null
): string | null {
  const version = reportedVersion ?? identity.osVersion
  if (!identity.os) return version
  return version ? `${identity.os} ${version}` : identity.os
}

