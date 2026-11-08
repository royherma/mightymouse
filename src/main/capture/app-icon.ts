/**
 * app-icon.ts — resolve a macOS app's REAL icon (the actual .app bundle icon, not
 * an emoji or hand-drawn glyph) to a small cached PNG, for the Media Library's
 * app filter.
 *
 * Pipeline (all native macOS, no dependency):
 *   1. app name → bundle path   via `mdfind` on the Spotlight index (exact filename
 *      first, then a contains match so "Chrome" → Google Chrome.app).
 *   2. bundle → .icns           via `defaults read .../Info CFBundleIconFile`
 *      (+ append `.icns` when the key omits the extension).
 *   3. .icns → PNG              via `sips -s format png --resampleHeightWidth`.
 *
 * Result is cached under PATHS.APP_ICONS/<slug>.png and served over media:// like
 * the capture thumbnails. A miss (app uninstalled, weird bundle) returns null and
 * the renderer falls back to a generic tile — never throws.
 */
import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { PATHS } from '../store/paths'
import { CONFIG } from '../../shared/config'

const ICON_PX = 64 // rendered icon size; Retina-crisp at the 32px display size

/** Filesystem-safe slug for an app name → its cache filename. */
function slug(appName: string): string {
  return appName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'app'
}

/** Promise wrapper over execFile with a hard timeout; resolves '' on any failure. */
function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: CONFIG.APP_ICON_TIMEOUT_MS }, (err, stdout) => {
      resolve(err ? '' : stdout.trim())
    })
  })
}

// /System/Applications is NOT in the Spotlight index, so mdfind never finds Apple's
// built-ins (Chess, Stickies, Calculator) — check the standard dirs on disk first.
const APP_DIRS = ['/Applications', '/System/Applications', '/System/Applications/Utilities', join(homedir(), 'Applications')]

async function bundlePath(appName: string): Promise<string> {
  const escaped = appName.replace(/["\\]/g, '')

  for (const dir of APP_DIRS) {
    const direct = join(dir, `${escaped}.app`)
    if (existsSync(direct)) return direct
  }

  const out = await run('mdfind', [
    `kMDItemContentType == 'com.apple.application-bundle' && kMDItemFSName == "${escaped}.app"c`
  ])
  const exact = out.split('\n').map((l) => l.trim()).filter((l) => l !== '')
  if (exact.length > 0) return pickShallowest(exact)

  const fuzzy = await run('mdfind', [
    `kMDItemContentType == 'com.apple.application-bundle' && kMDItemFSName == "*${escaped}*.app"c`
  ])
  const hits = fuzzy.split('\n').map((l) => l.trim()).filter((l) => l !== '')
  return hits.length > 0 ? pickShallowest(hits) : ''
}

function pickShallowest(paths: string[]): string {
  return paths.reduce((best, p) => (p.split('/').length < best.split('/').length ? p : best))
}

/**
 * Resolve `appName` to a cached PNG path, rendering it on first request. Returns
 * the absolute PNG path, or null if the app/icon can't be resolved. Cached: a
 * second call for the same app is a cheap existsSync hit.
 */
export async function resolveAppIcon(appName: string): Promise<string | null> {
  if (!appName || !appName.trim()) return null
  const out = join(PATHS.APP_ICONS, `${slug(appName)}.png`)
  if (existsSync(out)) return out

  // 1. app name → bundle path. NEVER use AppleScript `path to application`: it LAUNCHES
  // the app to resolve the path, so resolving N icons opens N apps.
  const bundle = await bundlePath(appName)
  if (!bundle || !existsSync(bundle)) return null

  // 2. bundle → .icns. CFBundleIconFile may or may not carry the extension.
  let iconFile = await run('defaults', ['read', join(bundle, 'Contents', 'Info'), 'CFBundleIconFile'])
  if (!iconFile) return null
  if (!iconFile.endsWith('.icns')) iconFile += '.icns'
  const icns = join(bundle, 'Contents', 'Resources', iconFile)
  if (!existsSync(icns)) return null

  // 3. .icns → PNG (sips writes the file; empty stdout is fine on success).
  await run('sips', [
    '-s', 'format', 'png',
    icns,
    '--resampleHeightWidth', String(ICON_PX), String(ICON_PX),
    '--out', out
  ])
  return existsSync(out) ? out : null
}

// Pre-render icons for apps we may propose, so the renderer's first paint is a hit.
export async function warmAppIcons(appNames: string[], limit = 60): Promise<void> {
  for (const name of appNames.slice(0, limit)) {
    if (existsSync(join(PATHS.APP_ICONS, `${slug(name)}.png`))) continue
    await resolveAppIcon(name)
  }
}
