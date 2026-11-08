/**
 * A bundle id turned into a real app icon and name, for the session sheet's
 * origin rows. The bundle id is the ONLY reliable source: inside tmux
 * `TERM_PROGRAM` reads "tmux", not the terminal. Every step degrades to
 * `undefined` -- these rows may never break a session list.
 */

import { execFile } from 'child_process'
import { existsSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import { app } from 'electron'
import { devLog } from '../../shared/env'

/** Bounded so a wedged `mdworker` cannot hold up the session list. */
const LOOKUP_TIMEOUT_MS = 3000

export interface HostApp {
  name: string
  /** Absent when the bundle has no readable icon; the name still renders. */
  iconPngBase64?: string
}

/** By bundle id, process-lifetime — `mdfind` is a spawn and this list re-renders
 *  per card. Misses cache as `null` too, or an unresolvable app re-spawns
 *  Spotlight forever. */
const cache = new Map<string, HostApp | null>()

/** The IN-FLIGHT lookup, not just the finished one. `broadcastStatus()` fires
 *  per relay change, so a result-only cache is still empty on the next call and
 *  every broadcast spawned another `mdfind` — measured at 472 spawns for one id,
 *  which is what made them start failing. */
const inFlight = new Map<string, Promise<HostApp | undefined>>()

function appPathFor(bundleId: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'mdfind',
      [`kMDItemCFBundleIdentifier == '${bundleId}'`],
      { timeout: LOOKUP_TIMEOUT_MS },
      (err, stdout) => {
        if (err) {
          devLog.warn(`[agent-relay] host app lookup failed: ${bundleId}`, err.message)
          resolve(null)
          return
        }
        // Several hits are normal (a copy in ~/Applications, one in the trash).
        resolve(stdout.split('\n').find((line) => line.trim().endsWith('.app'))?.trim() || null)
      }
    )
  })
}

/** `Cursor.app` -> `Cursor`. The display name would need a plist read per app;
 *  the basename is the same string for every host we care about. */
function displayName(appPath: string): string {
  return basename(appPath, '.app')
}

/** Cached. An id we cannot place resolves to `undefined`, so the caller omits
 *  the row rather than rendering an empty one. */
export function hostAppFor(bundleId: string | undefined): Promise<HostApp | undefined> {
  if (!bundleId) return Promise.resolve(undefined)

  const hit = cache.get(bundleId)
  if (hit !== undefined) return Promise.resolve(hit ?? undefined)

  const pending = inFlight.get(bundleId)
  if (pending) return pending

  const lookup = resolveHostApp(bundleId).finally(() => inFlight.delete(bundleId))
  inFlight.set(bundleId, lookup)
  return lookup
}

/** The bundle's OWN icon, as a 32px PNG.
 *
 * `app.getFileIcon()` looks like the obvious call and is wrong here: for cmux it
 * returns the generic placeholder square, not the app's artwork -- a valid,
 * non-empty 16px PNG, which is why byte counts and `isEmpty()` both said it had
 * worked. `nativeImage` cannot read `.icns` either (loads 0x0), so `sips`
 * converts it. Falls back to `getFileIcon` for a bundle with no `.icns`, where
 * a placeholder still beats no icon.
 */
async function iconPngFor(appPath: string): Promise<string | undefined> {
  const icns = join(appPath, 'Contents', 'Resources', 'AppIcon.icns')
  if (existsSync(icns)) {
    const converted = await sipsToPng(icns)
    if (converted) return converted
  }
  try {
    const icon = await app.getFileIcon(appPath, { size: 'normal' })
    return icon.isEmpty() ? undefined : icon.toPNG().toString('base64')
  } catch (err) {
    devLog.warn(`[agent-relay] host app icon failed: ${appPath}`, String(err))
    return undefined
  }
}

/** Via a temp file: `sips` writes to a path, not stdout. */
function sipsToPng(icns: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const out = join(tmpdir(), `mm-host-icon-${basename(icns, '.icns')}-${process.pid}.png`)
    execFile(
      'sips',
      ['-s', 'format', 'png', '--resampleWidth', '32', icns, '--out', out],
      { timeout: LOOKUP_TIMEOUT_MS },
      (err) => {
        if (err) {
          devLog.warn(`[agent-relay] sips icon convert failed: ${icns}`, err.message)
          resolve(undefined)
          return
        }
        try {
          const png = readFileSync(out).toString('base64')
          rmSync(out, { force: true })
          resolve(png)
        } catch {
          resolve(undefined)
        }
      }
    )
  })
}

async function resolveHostApp(bundleId: string): Promise<HostApp | undefined> {
  const appPath = await appPathFor(bundleId)
  if (!appPath) {
    cache.set(bundleId, null)
    return undefined
  }

  const resolved: HostApp = { name: displayName(appPath) }
  const png = await iconPngFor(appPath)
  if (png) resolved.iconPngBase64 = png

  cache.set(bundleId, resolved)
  return resolved
}

/** Cached answer only, never a lookup — `currentStatus()` is synchronous, so the
 *  resolve happens in `warmHostApp` and this just reads what landed. */
export function cachedHostApp(bundleId: string | undefined): HostApp | undefined {
  if (!bundleId) return undefined
  return cache.get(bundleId) ?? undefined
}

/** Fire-and-forget: an id already cached OR already being looked up spawns
 *  nothing. `onResolved` fires only when the lookup produced an app, so a
 *  permanently unresolvable id never re-triggers its caller. */
export function warmHostApp(bundleId: string | undefined, onResolved?: () => void): void {
  if (!bundleId || cache.has(bundleId) || inFlight.has(bundleId)) return
  void hostAppFor(bundleId).then((app) => {
    if (app && onResolved) onResolved()
  })
}

export function clearHostAppCache(): void {
  cache.clear()
  inFlight.clear()
}
