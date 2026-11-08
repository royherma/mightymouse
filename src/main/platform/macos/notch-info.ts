// notch-info.ts — read physical notch geometry from the native NotchInfo binary.
//
// Consumer: island-window.ts imports getNotchInfo() to position the wrap-around
// blob at pixel-exact notch coordinates instead of a center-estimate.
//
// Why a native binary: Electron has no notch API as of v39. NSScreen.safeAreaInsets
// and auxiliaryTopLeft/RightArea are AppKit-only. A one-shot swiftc binary is the
// lightest possible bridge — no Objective-C runtime embedding, no native addon.
//
// Coordinate-space reminder (from NotchInfo.swift):
//   The binary emits AppKit bottom-left-origin values. For the notch itself
//   (always at the PHYSICAL TOP of the notched display), the Electron y is 0
//   relative to that screen, so notchX/notchWidth/notchHeight can be used
//   directly without conversion for island positioning.

import { spawnSync } from 'child_process'
import { existsSync } from 'fs'
import { devLog } from '../../../shared/env'
import { resolveHelper } from './helpers'

// Binary name + directory under the repo root / app resources.
// Single definition so the path layout never drifts across files.
const NOTCH_INFO_BIN = 'notch-info'

// Maximum time (ms) to wait for the binary to respond.
// It does a single synchronous NSScreen read — 500 ms is very conservative.
const NOTCH_INFO_TIMEOUT_MS = 500

/** Shape of a successful notch-present result. */
export interface NotchInfo {
  hasNotch: true
  /** Left edge of the notch in screen-logical pixels (AppKit coords, origin at screen left). */
  notchX: number
  /** Width of the notch in logical pixels. */
  notchWidth: number
  /** Height of the notch (= safeAreaInsets.top) in logical pixels. */
  notchHeight: number
  /** Full logical width of the notched screen. */
  screenWidth: number
}

/** Shape of a no-notch result. */
export interface NoNotchInfo {
  hasNotch: false
}

export type NotchResult = NotchInfo | NoNotchInfo

// Module-level cache. Notch geometry is fixed for the lifetime of the app on
// a given display; no need to re-read after the first successful call.
let cachedResult: NotchResult | null = null

/** Resolve the binary path for the current environment (dev vs packaged). */
function resolveBinaryPath(): string {
  return resolveHelper(NOTCH_INFO_BIN)
}

/**
 * Read the physical notch geometry from the native binary.
 *
 * Returns a {@link NotchResult} on success (hasNotch may be false on non-notched
 * machines — that is a valid, non-error result). Returns null on ANY failure:
 * binary missing, spawn error, parse error, timeout. Callers must fall back to
 * their bounds-based estimate when null is returned.
 *
 * Result is cached after the first successful read — safe to call repeatedly
 * at no cost after the first invocation.
 */
export function getNotchInfo(): NotchResult | null {
  if (cachedResult !== null) return cachedResult

  const bin = resolveBinaryPath()

  if (!existsSync(bin)) {
    devLog.warn(
      `[notch-info] binary not found at ${bin}. ` + `Run: cd native/notch-info && bash build.sh`
    )
    return null
  }

  const result = spawnSync(bin, [], { timeout: NOTCH_INFO_TIMEOUT_MS, encoding: 'utf-8' })

  if (result.error) {
    devLog.error('[notch-info] spawn error:', result.error.message)
    return null
  }

  if (result.status !== 0) {
    devLog.error('[notch-info] binary exited with status', result.status, result.stderr?.trim())
    return null
  }

  const rawLine = (result.stdout ?? '').trim()
  if (!rawLine) {
    devLog.error('[notch-info] binary produced no output')
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(rawLine)
  } catch {
    devLog.error('[notch-info] JSON parse failed:', rawLine)
    return null
  }

  // Validate the shape before caching. The binary is ours, but be defensive.
  if (typeof parsed !== 'object' || parsed === null || !('hasNotch' in parsed)) {
    devLog.error('[notch-info] unexpected JSON shape:', rawLine)
    return null
  }

  const obj = parsed as Record<string, unknown>

  if (obj['hasNotch'] === false) {
    cachedResult = { hasNotch: false }
    return cachedResult
  }

  if (
    typeof obj['notchX'] !== 'number' ||
    typeof obj['notchWidth'] !== 'number' ||
    typeof obj['notchHeight'] !== 'number' ||
    typeof obj['screenWidth'] !== 'number'
  ) {
    devLog.error('[notch-info] missing numeric fields in JSON:', rawLine)
    return null
  }

  cachedResult = {
    hasNotch: true,
    notchX: obj['notchX'],
    notchWidth: obj['notchWidth'],
    notchHeight: obj['notchHeight'],
    screenWidth: obj['screenWidth']
  }

  devLog.log(
    `[notch-info] notch detected: x=${cachedResult.notchX} w=${cachedResult.notchWidth} h=${cachedResult.notchHeight} screenW=${cachedResult.screenWidth}`
  )

  return cachedResult
}
