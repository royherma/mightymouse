// cursor-appearance.ts — read the user's macOS pointer appearance settings so
// the Phone Remote can draw a cursor that matches the one on their Mac.
//
// Consumer: ipc/phone-remote.ts sends this to the phone once per connect; the
// phone renders its cursor overlay with these values (see PhoneRemoteEvent's
// 'cursorAppearance').
//
// Why `defaults read`: macOS exposes pointer size/color only through the
// com.apple.universalaccess preference domain — there is no Electron or public
// AppKit API for "what color did the user make their pointer". A one-shot
// spawnSync read is the lightest bridge and matches how notch-info.ts reaches
// past Electron's API surface.
//
// Absent key == user is on the DEFAULT for that setting. macOS only writes
// these keys once you move the slider / pick a color in
// System Settings > Accessibility > Display > Pointer, so "does not exist" is
// the common case and must read as "stock cursor", never as an error.

import { spawnSync } from 'child_process'
import { devLog } from '../../../shared/env'
import { inputBinPath } from './input'

const DEFAULTS_TIMEOUT_MS = 500
const UA_DOMAIN = 'com.apple.universalaccess'

/** Pointer appearance, in the shape the phone's overlay needs. */
export interface CursorAppearance {
  /** 1.0 = stock size. macOS's slider ranges to 4.0 ("Pointer size"). */
  size: number
  /** CSS color for the arrow's fill. Stock macOS pointer is white-filled. */
  fill: string
  /** CSS color for the arrow's outline. Stock macOS pointer is black-outlined. */
  outline: string
}

// Stock macOS pointer: white fill, black outline, unscaled. Every field falls
// back to this independently, so a user who changed ONLY the color still gets
// their real color with a default size (rather than all-or-nothing defaults).
const STOCK: CursorAppearance = { size: 1, fill: '#ffffff', outline: '#000000' }

/** Read one key from the universalaccess domain. Returns null when the key is
 *  unset (the normal "user never changed this" case) or unreadable. */
function readKey(key: string): string | null {
  try {
    const r = spawnSync('defaults', ['read', UA_DOMAIN, key], {
      encoding: 'utf8',
      timeout: DEFAULTS_TIMEOUT_MS
    })
    if (r.status !== 0) return null
    const out = r.stdout.trim()
    return out.length ? out : null
  } catch (err) {
    devLog.warn('[cursor-appearance] defaults read failed', err)
    return null
  }
}

/** macOS stores these colors as a space-separated float triplet in 0..1
 *  ("1 0.5 0"), NOT as hex or 0-255. Convert to a CSS rgb() the phone can use
 *  directly. Returns null on anything that doesn't parse, so the caller falls
 *  back to the stock color rather than rendering an invisible cursor. */
function parseColor(raw: string | null): string | null {
  if (!raw) return null
  const parts = raw.split(/\s+/).map(Number)
  if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) return null
  const [r, g, b] = parts.map((n) => Math.round(Math.min(1, Math.max(0, n)) * 255))
  return `rgb(${r}, ${g}, ${b})`
}

/** Current pointer appearance, falling back to the stock macOS cursor for any
 *  setting the user hasn't customized. Never throws — a phone that can't learn
 *  the real cursor style should still draw a normal-looking one. */
export function getCursorAppearance(): CursorAppearance {
  const rawSize = readKey('mouseDriverCursorSize')
  const size = rawSize !== null ? Number(rawSize) : NaN

  return {
    // Guard the parse AND the range: a corrupt value must not scale the
    // phone's cursor to something invisible or screen-filling.
    size: Number.isFinite(size) && size >= 1 && size <= 4 ? size : STOCK.size,
    fill: parseColor(readKey('cursorFillColor')) ?? STOCK.fill,
    outline: parseColor(readKey('cursorOutlineColor')) ?? STOCK.outline
  }
}

export const CURSOR_SIZE_MIN = 1
export const CURSOR_SIZE_MAX = 4

export function setCursorSize(size: number): boolean {
  const clamped = Math.min(CURSOR_SIZE_MAX, Math.max(CURSOR_SIZE_MIN, size))
  const live = spawnSync(inputBinPath(), ['cursorscale', String(clamped)], {
    timeout: DEFAULTS_TIMEOUT_MS
  })
  if (live.status !== 0) {
    devLog.warn('[cursor-appearance] cursorscale failed', String(live.stderr ?? '').trim())
    return false
  }
  // Persist so it survives a reboot and matches System Settings' Pointer size slider.
  spawnSync('defaults', ['write', UA_DOMAIN, 'mouseDriverCursorSize', '-float', String(clamped)], {
    timeout: DEFAULTS_TIMEOUT_MS
  })
  return true
}
