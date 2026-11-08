// app-switcher-list.ts — list running apps (name + bundleId + icon) from the
// native AppSwitcherList binary, for Phone Remote's app-switcher popup.
//
// Consumer: src/main/ipc/phone-remote.ts calls listSwitchableApps() when the
// phone opens the app-switcher popup, and ships the result to the phone as
// a list of tappable rows (icon + name).
//
// Why a native binary: same rationale as notch-info.ts — no Electron API
// exposes NSWorkspace/CGWindowList. See native/app-switcher-list/AppSwitcherList.swift
// for the Cmd+Tab-order approximation and icon-extraction details.
//
// The running-app SET is never cached -- it changes constantly, so every
// popup-open re-spawns the binary for a fresh snapshot/order. But each app's
// ICON is cached by bundleId for the life of this process (see iconCache
// below): the icon for e.g. com.apple.finder never changes while the app is
// installed, so re-encoding + re-shipping ~50-80KB of base64 PNG over the
// phone's WebSocket on every single popup-open was pure waste. First sight of
// a bundleId pays the encode cost; every later popup-open for that app is
// instant and free.

import { spawnSync } from 'child_process'
import { existsSync } from 'fs'
import { devLog } from '../../../shared/env'
import { resolveHelper } from './helpers'

const APP_SWITCHER_LIST_BIN = 'app-switcher-list'

// The binary renders one PNG icon per running app (a handful to a few dozen)
// — generous headroom over the ~280ms observed with 8 apps open.
const APP_SWITCHER_LIST_TIMEOUT_MS = 2000

/** One row in the app-switcher popup. */
export interface SwitchableApp {
  name: string
  bundleId: string
  /** Base64-encoded PNG icon data, or '' if the icon couldn't be rendered. */
  iconPngBase64: string
}

// bundleId -> icon, kept for the life of this process. See the module header
// for why this is safe to cache forever (icons don't change at runtime).
const iconCache = new Map<string, string>()

function resolveBinaryPath(): string {
  return resolveHelper(APP_SWITCHER_LIST_BIN)
}

/**
 * List currently-running, user-visible apps in an approximation of Cmd+Tab
 * order (see the Swift source for the exact heuristic). Returns [] on ANY
 * failure — binary missing, spawn error, parse error, timeout, bad shape —
 * this is a best-effort UI list, never worth surfacing an error for.
 */
export function listSwitchableApps(): SwitchableApp[] {
  const bin = resolveBinaryPath()

  if (!existsSync(bin)) {
    devLog.warn(
      `[app-switcher-list] binary not found at ${bin}. ` +
        `Run: cd native/app-switcher-list && bash build.sh`
    )
    return []
  }

  // Tell the binary which bundleIds we already have icons cached for, so it
  // skips re-rendering/re-encoding those (comes back with iconPngBase64: '',
  // backfilled from iconCache below).
  const knownBundleIds = [...iconCache.keys()]

  // Default maxBuffer is 1MB -- a few dozen base64 PNG icons can still add up
  // even at the smaller 64px render size, so raise it with real headroom.
  const result = spawnSync(bin, knownBundleIds, {
    timeout: APP_SWITCHER_LIST_TIMEOUT_MS,
    encoding: 'utf-8',
    maxBuffer: 8 * 1024 * 1024
  })

  if (result.error) {
    devLog.error('[app-switcher-list] spawn error:', result.error.message)
    return []
  }

  if (result.status !== 0) {
    devLog.error(
      '[app-switcher-list] binary exited with status',
      result.status,
      result.stderr?.trim()
    )
    return []
  }

  const rawLine = (result.stdout ?? '').trim()
  if (!rawLine) {
    devLog.error('[app-switcher-list] binary produced no output')
    return []
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(rawLine)
  } catch {
    devLog.error('[app-switcher-list] JSON parse failed')
    return []
  }

  if (!Array.isArray(parsed)) {
    devLog.error('[app-switcher-list] unexpected JSON shape (not an array)')
    return []
  }

  const apps: SwitchableApp[] = []
  for (const entry of parsed) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      typeof (entry as Record<string, unknown>)['name'] !== 'string' ||
      typeof (entry as Record<string, unknown>)['bundleId'] !== 'string' ||
      typeof (entry as Record<string, unknown>)['iconPngBase64'] !== 'string'
    ) {
      continue
    }
    const row = entry as Record<string, string>
    let icon = row.iconPngBase64
    if (icon) {
      iconCache.set(row.bundleId, icon)
    } else {
      icon = iconCache.get(row.bundleId) ?? ''
    }
    apps.push({ name: row.name, bundleId: row.bundleId, iconPngBase64: icon })
  }

  return apps
}
