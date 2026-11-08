/**
 * Auto-updater — the only place electron-updater is touched. Checks on launch and
 * every 4h, auto-downloads, installs on next quit (autoInstallOnAppQuit).
 *
 * Inert under `npm run dev`: every check short-circuits on app.isPackaged.
 */
import { app, BrowserWindow, shell } from 'electron'
import { autoUpdater, type UpdateInfo, type ProgressInfo } from 'electron-updater'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { CHANNELS } from '../shared/ipc'
import { CONFIG } from '../shared/config'
import type { UpdateStatusPayload } from '../shared/types'
import { devLog } from '../shared/env'
import { track, trackError } from './analytics'
import { ANALYTICS_EVENT } from '../shared/analytics-events'
import { PREFS } from './store/prefs'

/** Public release page users land on when they click "Get update" (manual mode). */
export const RELEASE_PAGE_URL = CONFIG.RELEASE_PAGE_URL

// Latest update state, cached in main so the (synchronous) tray menu can show a
// "Restart to update" row + icon indicator without a renderer round-trip. Mirrors
// the `currentUser` cache pattern in index.ts. onChange lets index.ts refresh the
// tray whenever the state moves (e.g. → downloaded).
// 'not-available' is the neutral initial: nothing to nudge about until an event fires.
let lastUpdate: UpdateStatusPayload = { state: 'not-available' }
let onUpdateChange: (() => void) | null = null
let lastProgressNudgeAt = 0
const PROGRESS_NUDGE_INTERVAL_MS = 1000

// Watchdog: electron-updater has no built-in timeout, so a stalled download
// (network drop mid-stream, backgrounded app) can leave `download-progress` as
// the terminal state forever — no 'error' or 'downloaded' ever fires, and the
// tray would show a frozen percentage indefinitely. Reset on every progress
// tick; if it fires, treat the download as failed so the tray clears the row.
let stallWatchdog: ReturnType<typeof setTimeout> | null = null
const STALL_TIMEOUT_MS = 5 * 60 * 1000

function clearStallWatchdog(): void {
  if (stallWatchdog) {
    clearTimeout(stallWatchdog)
    stallWatchdog = null
  }
}

function armStallWatchdog(): void {
  clearStallWatchdog()
  stallWatchdog = setTimeout(() => {
    devLog.error('[updater] download stalled — no progress for 5min, clearing tray row')
    trackError({
      kind: 'update_stalled',
      message: `Update download stalled — no progress for ${STALL_TIMEOUT_MS / 60_000}min`,
      source: 'updater'
    })
    broadcastUpdateStatus({ state: 'error', message: 'Update download stalled' })
  }, STALL_TIMEOUT_MS)
}

/** The most recent update lifecycle state (for the tray). */
export function getUpdateState(): UpdateStatusPayload {
  return lastUpdate
}

/** Register a callback fired whenever the update state changes (index.ts → refreshTrayMenu). */
export function onUpdateStateChange(cb: () => void): void {
  onUpdateChange = cb
}

function broadcastUpdateStatus(payload: UpdateStatusPayload): void {
  const stateChanged = payload.state !== lastUpdate.state
  lastUpdate = payload
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(CHANNELS.updateStatus, payload)
  }
  // Nudge the tray on every STATE change, plus throttled during download-progress
  // (~1/sec) so the percent visibly counts up instead of freezing at whatever
  // number was showing when the state first flipped to 'download-progress'.
  const now = Date.now()
  if (stateChanged) {
    lastProgressNudgeAt = now
    onUpdateChange?.()
  } else if (payload.state === 'download-progress' && now - lastProgressNudgeAt >= PROGRESS_NUDGE_INTERVAL_MS) {
    lastProgressNudgeAt = now
    onUpdateChange?.()
  }
}

/**
 * Clears stale electron-updater pending zips left after a failed in-app install.
 * Harmless in manual mode; keeps the cache from accumulating once Phase 2 lands.
 * The cache dir name is derived from electron-updater's default (app name based).
 */
async function clearStalePendingCache(): Promise<void> {
  if (process.platform !== 'darwin' || !app.isPackaged) return
  const pendingDir = join(
    app.getPath('home'),
    'Library',
    'Caches',
    `${app.getName()}-updater`,
    'pending'
  )
  try {
    await rm(pendingDir, { recursive: true, force: true })
  } catch {
    // best-effort cleanup — ignore
  }
}

/**
 * Run a single update check. No-op (logged) in dev / unpackaged builds, in a
 * staging packaged build — a staging install must never auto-pull the prod
 * release feed and silently overwrite itself with the prod build/backend — and
 * off darwin, where no update manifest is published at all.
 */
export async function checkForUpdates(): Promise<void> {
  if (!app.isPackaged) {
    devLog.log('[updater] skipping check (dev / unpackaged)')
    return
  }
  // mac reads latest-mac.yml, win32 reads latest.yml — release.yml publishes
  // BOTH to every real tag (:274-289), so both platforms have a live feed.
  // Unsigned Windows installers are accepted because electron-builder.yml sets
  // verifyUpdateCodeSignature: false. linux stays excluded: no latest-linux.yml
  // is published, and an unguarded check there 404s every boot and every 4h,
  // surfacing as a red error in Settings.
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    devLog.log('[updater] skipping check (no update feed on this platform)')
    return
  }
  if (CONFIG.IS_STAGING) {
    devLog.log('[updater] skipping check (staging build)')
    return
  }
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    devLog.error('[updater] check failed:', err)
  }
}

/**
 * Emit `update_installed` on the first boot of a new version — measured at boot,
 * not at quitAndInstall(), because an install that never finishes must not count.
 * A fresh install has no stored version and so is never reported as an update.
 */
function trackVersionChange(): void {
  const current = CONFIG.APP_VERSION
  const previous = PREFS.getLastSeenVersion()
  if (previous === current) return
  PREFS.setLastSeenVersion(current)
  if (!previous) return
  track(ANALYTICS_EVENT.update_installed, { version: current, from_version: previous })
}

/**
 * Wire the updater + start the check loop. Call once from app.whenReady, after
 * IPC handlers are registered. Safe to call in dev — every check short-circuits.
 */
const OFFLINE_NET_ERROR =
  /net::ERR_(INTERNET_DISCONNECTED|NETWORK_CHANGED|NETWORK_IO_SUSPENDED|NAME_NOT_RESOLVED|TIMED_OUT|ADDRESS_UNREACHABLE|HTTP2_PROTOCOL_ERROR|CONNECTION_(RESET|CLOSED|TIMED_OUT|REFUSED|ABORTED))/
const SERVER_HICCUP = /HttpError: 5\d\d|^5\d\d\b/

export function isOfflineOrServerHiccup(message: string): boolean {
  return OFFLINE_NET_ERROR.test(message) || SERVER_HICCUP.test(message)
}

export function setupAutoUpdater(): void {
  trackVersionChange()

  // electron-updater logs via its own logger; route it to our dev-only console
  // (silent in prod) instead of pulling in the electron-log dependency.
  autoUpdater.logger = {
    info: (...a: unknown[]) => devLog.log('[updater]', ...a),
    warn: (...a: unknown[]) => devLog.warn('[updater]', ...a),
    error: (...a: unknown[]) => devLog.error('[updater]', ...a),
    debug: () => {}
  }
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => broadcastUpdateStatus({ state: 'checking' }))
  autoUpdater.on('update-available', (info: UpdateInfo) => {
    track(ANALYTICS_EVENT.update_available, { version: info.version })
    broadcastUpdateStatus({ state: 'available', version: info.version })
  })
  autoUpdater.on('update-not-available', () => broadcastUpdateStatus({ state: 'not-available' }))
  autoUpdater.on('download-progress', (p: ProgressInfo) => {
    armStallWatchdog()
    broadcastUpdateStatus({ state: 'download-progress', percent: p.percent })
  })
  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    clearStallWatchdog()
    track(ANALYTICS_EVENT.update_downloaded, { version: info.version })
    broadcastUpdateStatus({ state: 'downloaded', version: info.version })
  })
  autoUpdater.on('error', (err: Error) => {
    clearStallWatchdog()
    devLog.error('[updater] error:', err)
    if (!isOfflineOrServerHiccup(err.message)) trackError({
      kind: 'update_error',
      message: err.message,
      stack: err.stack,
      source: 'updater'
    })
    broadcastUpdateStatus({ state: 'error', message: err.message })
  })

  void clearStalePendingCache()

  // Initial check + every 4 hours.
  void checkForUpdates()
  setInterval(() => void checkForUpdates(), 4 * 60 * 60 * 1000)
}

/** IPC handlers for the renderer. */
export const updaterIpc = {
  check: () => checkForUpdates(),
  download: async () => {
    if (app.isPackaged) await autoUpdater.downloadUpdate()
  },
  install: () => autoUpdater.quitAndInstall(),
  getState: () => getUpdateState(),
  /** Open the public release page in the system browser (manual fallback). */
  openReleasePage: () => shell.openExternal(RELEASE_PAGE_URL)
}
