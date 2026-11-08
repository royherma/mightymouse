// chrome.ts — the Chrome/Safari adapter for Phone Remote's app-aware bar.
//
// Moved from macos/browser-context.ts when the bar grew a second app; the
// AppleScript, the favicon cache and the Local State parse are unchanged. What
// changed is the edge: this file now speaks the neutral AppContext vocabulary,
// so Chrome's 1-based tab index is stringified on the way out and parsed back
// on the way in. Nothing outside this file knows Chrome uses numbers.
//
// Two sources, because the facts live in different places:
//   TABS     — AppleScript against the running browser. It is the only thing
//              that knows the LIVE window, and `set active tab index` jumps
//              straight to a tab (no repeated keystrokes to land N away).
//   PROFILES — Chrome's `Local State` JSON on disk. Chrome exposes no scripting
//              dictionary for its profile list, but that file is the same thing
//              the profile menu renders from.
//
// Favicons come from each profile's `Favicons` SQLite DB, copied before reading:
// Chrome holds the live file open under WAL, so querying it in place can throw
// SQLITE_BUSY. Icons are cached per URL for the life of the process — a site's
// favicon does not change while you are scrubbing a tab strip, and re-encoding
// base64 PNGs on every keystroke would dwarf the cost of the AppleScript call.

import { spawnSync } from 'child_process'
import { existsSync, readFileSync, copyFileSync, unlinkSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { devLog } from '../../../../shared/env'
import {
  APP_ADAPTER,
  EMPTY_READING,
  type AppAdapterId,
  type AppContextGroup,
  type AppContextItem,
  type AppContextReading
} from '../../../../shared/app-context'
import { FIELD_SEP, OSASCRIPT_TIMEOUT_MS, runOsa, runOsaAsync } from './osa'

const CHROME_SUPPORT_DIR = join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome')

/** Which scriptable app name each adapter answers to in AppleScript. */
const OSA_APP_NAME: Record<string, string> = {
  [APP_ADAPTER.chrome]: 'Google Chrome',
  [APP_ADAPTER.safari]: 'Safari'
}

/**
 * Adapters speaking Chrome's `active tab index` dialect, not Safari's
 * `current tab`. A SET rather than `id === chrome` so a second Chromium app
 * joins by name — the wrong branch returns null and degrades to a bare app
 * chip, which reads as an unreadable app rather than a dispatch bug.
 */
const CHROMIUM_DIALECT: readonly string[] = [APP_ADAPTER.chrome]

function isChromiumDialect(adapterId: AppAdapterId): boolean {
  return CHROMIUM_DIALECT.includes(adapterId)
}

/** base64 PNG by favicon page-host, for this process's lifetime. */
const faviconCache = new Map<string, string>()
let faviconCacheLoaded = false

/**
 * Tabs of the frontmost window, in tab-bar order, plus Chrome's profiles.
 *
 * Chrome and Safari use different terms for the same idea (`active tab index`
 * vs `current tab`), so each gets its own script rather than one
 * lowest-common-denominator query. Profiles are Chrome-only — Safari has no
 * equivalent concept, so it reports zero groups and the bar drops that control.
 */
export async function readChrome(adapterId: AppAdapterId): Promise<AppContextReading> {
  // Profiles are Chrome's ALONE — read from its Local State file on disk, which
  // no other Chromium-dialect app here has. Deliberately not isChromiumDialect.
  const isChrome = adapterId === APP_ADAPTER.chrome
  const [items, groups, activeGroupId] = await Promise.all([
    listTabs(adapterId),
    isChrome ? listChromeProfiles() : [],
    isChrome ? activeChromeProfile() : ''
  ])
  return { items, groups, activeGroupId, tmuxZoomed: null }
}

export async function readActiveTab(
  adapterId: AppAdapterId
): Promise<{ title: string; url: string } | null> {
  const app = OSA_APP_NAME[adapterId]
  if (!app) return null
  const script = isChromiumDialect(adapterId)
    ? `tell application "${app}"
         if (count of windows) is 0 then return ""
         tell active tab of front window
           return title & "${FIELD_SEP}" & URL
         end tell
       end tell`
    : `tell application "${app}"
         if (count of windows) is 0 then return ""
         tell current tab of front window
           return name & "${FIELD_SEP}" & URL
         end tell
       end tell`
  const out = await runOsaAsync(script)
  if (!out) return null
  const i = out.indexOf(FIELD_SEP)
  if (i < 0) return { title: out, url: '' }
  return { title: out.slice(0, i), url: out.slice(i + FIELD_SEP.length) }
}

async function listTabs(adapterId: AppAdapterId): Promise<AppContextItem[]> {
  const app = OSA_APP_NAME[adapterId]
  // One script returning titles, URLs, and the active index together: three
  // separate osascript calls could straddle a tab change and disagree.
  const script =
    isChromiumDialect(adapterId)
      ? `tell application "${app}"
           if (count of windows) is 0 then return ""
           set t to title of every tab of front window
           set u to URL of every tab of front window
           set a to active tab index of front window
           set AppleScript's text item delimiters to "${FIELD_SEP}"
           return (a as text) & "${FIELD_SEP}" & (t as text) & "${FIELD_SEP}${FIELD_SEP}" & (u as text)
         end tell`
      : `tell application "${app}"
           if (count of windows) is 0 then return ""
           set t to name of every tab of front window
           set u to URL of every tab of front window
           set a to index of current tab of front window
           set AppleScript's text item delimiters to "${FIELD_SEP}"
           return (a as text) & "${FIELD_SEP}" & (t as text) & "${FIELD_SEP}${FIELD_SEP}" & (u as text)
         end tell`

  const out = await runOsaAsync(script)
  if (!out) return []

  // Layout: <activeIndex> SEP <titles…> SEP SEP <urls…>. The doubled separator
  // is the only unambiguous boundary — a title list can itself contain empties.
  const [head, tail] = out.split(`${FIELD_SEP}${FIELD_SEP}`)
  if (!head || tail === undefined) return []
  const headParts = head.split(FIELD_SEP)
  const active = Number.parseInt(headParts[0] ?? '', 10)
  const titles = headParts.slice(1)
  const urls = tail.split(FIELD_SEP)
  if (!Number.isFinite(active) || titles.length === 0) return []

  return titles.map((title, i) => ({
    // AppleScript indexes from 1 and `set active tab index` expects that same
    // value back, so the index IS the identity here — stringified because the
    // wire carries opaque ids and must not learn that this adapter uses numbers.
    id: String(i + 1),
    title,
    subtitle: urls[i] ?? '',
    active: i + 1 === active,
    iconPngBase64: faviconFor(urls[i] ?? '')
  }))
}

/** Jump the frontmost window straight to a tab. */
export function activateChromeTab(adapterId: AppAdapterId, itemId: string): boolean {
  // Parsed back here and nowhere else: the number is this adapter's private
  // business. A non-numeric id can only mean a stale phone render, so refuse.
  const index = Number.parseInt(itemId, 10)
  if (!Number.isSafeInteger(index) || index < 1) return false

  const app = OSA_APP_NAME[adapterId]
  const script =
    isChromiumDialect(adapterId)
      ? `tell application "${app}"
           if (count of windows) is 0 then return "0"
           if ${index} > (count of tabs of front window) then return "0"
           set active tab index of front window to ${index}
           activate
           return "1"
         end tell`
      : `tell application "${app}"
           if (count of windows) is 0 then return "0"
           if ${index} > (count of tabs of front window) then return "0"
           set current tab of front window to tab ${index} of front window
           activate
           return "1"
         end tell`
  return runOsa(script) === '1'
}

/** Shape we read out of Chrome's `Local State`. Chrome writes far more than
 *  this; these are the only fields the bar needs. */
interface LocalState {
  profile?: {
    info_cache?: Record<string, ChromeProfileInfo>
    last_active_profiles?: string[]
  }
}

interface ChromeProfileInfo {
  name?: string
  gaia_picture_file_name?: string
  /** First name on the Google account. This — NOT `name` — is what Chrome puts
   *  in the window title, so it is what a title match has to compare against. */
  gaia_given_name?: string
  /** Signed-in address, '' on a signed-out profile. */
  user_name?: string
}

/** Open tab count per profile directory. */
type TabCounts = Record<string, number>

/**
 * Whether a Chrome window and a System Events window are the same window.
 *
 * Chrome's `title of w` is exactly the prefix of System Events' name for that
 * window ("MightyMouse" vs "MightyMouse - Google Chrome - Tech (…)"), which is
 * the only signal available to catch a drifted positional join. An empty Chrome
 * title carries no signal, so it passes — dropping the window would lose its
 * tabs to prove nothing.
 *
 * Exported for the test: the join it guards cannot be staged on disk, and
 * mis-attributing a window's tabs is silent.
 */
export const pairsWindow = (chromeTitle: string, sysTitle: string): boolean =>
  !chromeTitle || sysTitle.startsWith(chromeTitle)

/**
 * How many tabs each profile has open.
 *
 * Chrome's AppleScript dictionary gives a window's tab count but NOT which
 * profile owns it — `properties of window` has no profile field. System Events
 * does expose the title, which carries the profile suffix, so the count is
 * attributed by running each window's title back through the same resolver the
 * front window uses. One osascript call for both halves keeps it to a single
 * ~240ms round trip rather than one per window.
 */
async function chromeTabCounts(candidates: string[], cache: Record<string, ChromeProfileInfo>): Promise<TabCounts> {
  // Counts come from Chrome (which knows them) and the profile from System
  // Events (which is the only side exposing it), so the two lists must be
  // joined. There is NO shared key: System Events cannot see Chrome's window
  // id, and every window here is maximized to identical bounds, so geometry
  // cannot tell them apart either. Position is the only join available.
  //
  // What position alone cannot do is NOTICE when it is wrong, and it silently
  // will be — System Events lists windows Chrome's `windows` collection omits
  // (downloads, task manager), and one of those shifts every later pairing by
  // one, moving a whole window's tabs onto the wrong profile. So Chrome's own
  // `title of w` rides along as a checksum: it is exactly the prefix of System
  // Events' name for the same window ("MightyMouse" vs "MightyMouse - Google
  // Chrome - Tech (…)"). A pair that fails that test is a window we cannot
  // attribute, and dropping it beats crediting it to the wrong profile.
  const raw = await runOsaAsync(
    `set counts to {}
     set ctitles to {}
     tell application "Google Chrome"
       repeat with w in windows
         set end of counts to (count of tabs of w) as text
         set end of ctitles to title of w
       end repeat
     end tell
     set titles to {}
     tell application "System Events" to tell process "Google Chrome"
       repeat with w in windows
         set end of titles to name of w
       end repeat
     end tell
     set out to ""
     repeat with i from 1 to (count of counts)
       if i > (count of titles) then exit repeat
       set out to out & (item i of counts) & "\t" & (item i of ctitles) & "\t" & (item i of titles) & linefeed
     end repeat
     return out`
  )
  if (!raw) return {}

  const counts: TabCounts = {}
  for (const line of raw.split('\n')) {
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const n = Number.parseInt(parts[0] ?? '', 10)
    if (!Number.isFinite(n)) continue
    // parts[1] is Chrome's title, parts[2] System Events'. A tab title may
    // itself contain a tab character, so the System Events half is everything
    // after the second separator rather than parts[2] alone.
    const chromeTitle = (parts[1] ?? '').trim()
    const sysTitle = parts.slice(2).join('\t').trim()
    if (!pairsWindow(chromeTitle, sysTitle)) {
      devLog.warn(`[app-context] window pairing drifted, skipping: ${chromeTitle} vs ${sysTitle}`)
      continue
    }
    const dir = resolveProfileFromTitle(sysTitle, candidates, cache)
    if (dir) counts[dir] = (counts[dir] ?? 0) + n
  }
  return counts
}

function readLocalState(): LocalState | null {
  const localState = join(CHROME_SUPPORT_DIR, 'Local State')
  if (!existsSync(localState)) return null
  try {
    return JSON.parse(readFileSync(localState, 'utf8')) as LocalState
  } catch (err) {
    devLog.warn('[app-context] Local State unreadable:', err)
    return null
  }
}

/**
 * The profiles that currently have a window open, in Chrome's own order.
 *
 * NOT every profile in `info_cache` — that is every profile ever created (24
 * here, most of them dormant), and offering all of them turned a "jump to that
 * window" control into a directory of things that are not on screen. Chrome
 * tracks the live set itself in `last_active_profiles`, which is the same set
 * its own window menu lists.
 *
 * Returns [] when the key is missing (a Chrome too old to write it), which the
 * caller reads as "cannot tell" rather than "none".
 */
function liveProfileDirs(state: LocalState): string[] {
  const cache = state.profile?.info_cache ?? {}
  return (state.profile?.last_active_profiles ?? []).filter((d) => d in cache)
}

/**
 * Chrome profiles with a window open, in Chrome's own order.
 *
 * `info_cache` is keyed by profile DIRECTORY ("Default", "Profile 15") — that
 * key, not the display name, is what `--profile-directory` wants, and display
 * names are freely duplicated (four profiles here are all "studio.example").
 */
export async function listChromeProfiles(): Promise<AppContextGroup[]> {
  const state = readLocalState()
  const cache = state?.profile?.info_cache
  if (!cache) return []
  // Live profiles lead, in Chrome's own order, then the rest alphabetically.
  // Both are listed: the open ones are what you almost always want, but
  // "switch to a profile that is not running yet" is a real action, and hiding
  // 20 profiles to surface 4 trades one confusion for another. The phone draws
  // the boundary as a divider, so the ordering here IS the grouping.
  const live = liveProfileDirs(state)
  const idle = Object.keys(cache)
    .filter((dir) => !live.includes(dir))
    .sort((a, b) => (cache[a]?.name ?? a).localeCompare(cache[b]?.name ?? b))
  const dirs = [...live, ...idle]
  const counts = await chromeTabCounts(live, cache)
  return dirs.map((dir) => {
    const info = cache[dir] ?? {}
    return {
      id: dir,
      name: info.name || dir,
      iconPngBase64: profileAvatar(dir, info.gaia_picture_file_name),
      subtitle: info.user_name ?? '',
      itemCount: counts[dir] ?? 0,
      active: live.includes(dir)
    }
  })
}

/**
 * Focus a Chrome profile, preferring the window it already has open.
 *
 * `open -na --profile-directory` does NOT raise an existing window — it always
 * spawns a fresh one, so picking a profile you were already looking at gave you
 * a second "New Tab" window instead of the tabs you meant. That is the whole
 * reason this walks the windows first: the count in the dropdown comes from
 * windows that exist, so activating must land on one of THOSE.
 *
 * Chrome exposes no "which profile owns this window" property, so ownership is
 * matched by title through the same resolver the read path uses — including its
 * live-profiles-only candidate rule, without which a dormant profile sharing a
 * given name can capture the match. `open -na` stays as the fallback for a
 * profile with genuinely no window, which is the one case it gets right.
 */
export function activateChromeProfile(groupId: string): boolean {
  if (raiseChromeProfileWindow(groupId)) return true
  const r = spawnSync('open', ['-na', 'Google Chrome', '--args', `--profile-directory=${groupId}`], {
    timeout: OSASCRIPT_TIMEOUT_MS
  })
  return !r.error && r.status === 0
}

/**
 * Raise the first existing window owned by `groupId`. False when it has none.
 *
 * Titles come from System Events (the only side that exposes the profile) and
 * the raise goes through Chrome's own `index`, which is safe because both
 * enumerate the same windows in the same order — the same pairing
 * `chromeTabCounts` relies on.
 *
 * `set index to 1` is what actually reorders Chrome's window list; `activate`
 * alone only brings the app forward on whatever window was already front.
 */
function raiseChromeProfileWindow(groupId: string): boolean {
  const state = readLocalState()
  const cache = state?.profile?.info_cache
  if (!cache) return false
  const live = liveProfileDirs(state)
  const candidates = live.length > 0 ? live : Object.keys(cache)

  // Ids and titles in ONE call, zipped by position inside the script. Read
  // separately they could straddle a window change and pair an id with another
  // window's title; the raise below then keys off the id alone, which — unlike a
  // position — survives `set index to 1` reordering the list.
  const raw = runOsa(
    `set ids to {}
     tell application "Google Chrome"
       repeat with w in windows
         set end of ids to (id of w) as text
       end repeat
     end tell
     set titles to {}
     tell application "System Events" to tell process "Google Chrome"
       repeat with w in windows
         set end of titles to name of w
       end repeat
     end tell
     set out to ""
     repeat with i from 1 to (count of ids)
       if i > (count of titles) then exit repeat
       set out to out & (item i of ids) & "\t" & (item i of titles) & linefeed
     end repeat
     return out`
  )
  if (!raw) return false

  let winId = ''
  for (const line of raw.split('\n')) {
    const tab = line.indexOf('\t')
    if (tab < 0) continue
    if (resolveProfileFromTitle(line.slice(tab + 1).trim(), candidates, cache) === groupId) {
      winId = line.slice(0, tab)
      break
    }
  }
  if (!winId) return false

  return (
    runOsa(
      `tell application "Google Chrome"
         repeat with w in windows
           if (id of w as text) is "${winId}" then
             set index of w to 1
             activate
             return "1"
           end if
         end repeat
         return "0"
       end tell`
    ) === '1'
  )
}

/**
 * Directory of the profile owning Chrome's front window.
 *
 * Chrome does not expose this to AppleScript, so it is matched by window title:
 * every Chrome window's title ends with the profile name when more than one
 * profile exists. Names are duplicated across profiles here, so a match is a
 * hint, not proof — '' (no highlight) is the honest answer when it is ambiguous.
 */
async function activeChromeProfile(): Promise<string> {
  const title = await runOsaAsync(
    `tell application "System Events" to tell process "Google Chrome"
       if (count of windows) is 0 then return ""
       return name of front window
     end tell`
  )
  if (!title) return ''
  const state = readLocalState()
  const cache = state?.profile?.info_cache
  if (!cache) return ''

  // ONLY profiles with a window open can own the front window. Without this the
  // match ran against all 24 profiles including dormant ones, and a dormant
  // profile literally named "Pat" matched the title of a window belonging to a
  // signed-in profile whose GIVEN name is also Pat -- uniquely, so the result
  // looked confident. The bar then drew that dead profile's (absent) avatar as a
  // monogram while Chrome's own toolbar showed the real account photo.
  const live = liveProfileDirs(state)
  const candidates = live.length > 0 ? live : Object.keys(cache)
  return resolveProfileFromTitle(title, candidates, cache)
}

/** Trailing "<given name> (<profile name>)" Chrome appends to a window title. */
const TITLE_PROFILE_SUFFIX = / - Google Chrome - (.+)$/

/**
 * Which profile owns a window, from its title alone.
 *
 * Chrome's format is `<tab> - Google Chrome - <gaia_given_name>`, with
 * ` (<profile name>)` appended ONLY when the given name alone would be
 * ambiguous. So a BARE given name shared by several live profiles is not
 * ambiguous at all — it identifies the one Chrome did not feel the need to
 * qualify. Reading a bare name as ambiguous is what dropped the highlight on
 * the Default profile here, where "Pat" is also Profile 15's given name.
 *
 * Exported for the test: this is pure string→directory logic over data that is
 * a pain to stage on disk, and it has now been wrong in two different ways.
 */
export function resolveProfileFromTitle(
  title: string,
  candidates: string[],
  cache: Record<string, ChromeProfileInfo>
): string {
  const suffix = TITLE_PROFILE_SUFFIX.exec(title)?.[1]
  if (!suffix) return ''

  // Qualified: the parenthesised half is the profile's display name, which is
  // the exact thing --profile-directory is keyed to. Matched first because it
  // is the only unambiguous form Chrome emits.
  //
  // Matched by SEARCHING for a name the suffix ends with, not by parsing out
  // the parens: a display name may itself contain them ("TechGuyver (roy's
  // socials)" yields "Tech (Studio (my socials))"), and no single
  // greedy-or-lazy regex splits that correctly. Longest name first so a name
  // that is a suffix of another cannot win.
  const byName = candidates
    .filter((dir) => {
      const name = cache[dir]?.name
      return name && suffix.endsWith(`(${name})`)
    })
    .sort((a, b) => (cache[b]?.name?.length ?? 0) - (cache[a]?.name?.length ?? 0))
  if (byName.length > 0) return byName[0]

  const byGiven = candidates.filter((dir) => cache[dir]?.gaia_given_name === suffix)
  if (byGiven.length === 1) return byGiven[0]
  // Several live profiles share this given name and Chrome still printed it
  // bare, which it only does for the unqualified one: the default profile.
  if (byGiven.length > 1) {
    const fallback = byGiven.find((dir) => dir === 'Default')
    if (fallback) return fallback
  }

  // No Google account on this profile, so Chrome falls back to its display name.
  const byDisplay = candidates.filter((dir) => cache[dir]?.name === suffix)
  return byDisplay.length === 1 ? byDisplay[0] : ''
}

/** A profile's Google account picture, if it has one. Generated (non-account)
 *  avatars are `chrome://theme/` resources with no file on disk — the phone
 *  falls back to a monogram for those. */
function profileAvatar(dir: string, gaiaFile?: string): string {
  if (!gaiaFile) return ''
  const path = join(CHROME_SUPPORT_DIR, dir, gaiaFile)
  if (!existsSync(path)) return ''
  try {
    return readFileSync(path).toString('base64')
  } catch {
    return ''
  }
}

/** Favicon for a tab URL, matched by host. '' when the site has no cached icon
 *  (Chrome only stores what it has actually fetched). */
function faviconFor(url: string): string {
  if (!faviconCacheLoaded) loadFavicons()
  const host = hostOf(url)
  return host ? (faviconCache.get(host) ?? '') : ''
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/**
 * Load the Default profile's favicon table into memory once.
 *
 * Copied to tmp before reading: Chrome keeps the live DB open in WAL mode, and
 * a read against it while Chrome is running can fail with SQLITE_BUSY. The copy
 * is deleted immediately after — it is a cache, not user data worth keeping.
 */
function loadFavicons(): void {
  faviconCacheLoaded = true
  const src = join(CHROME_SUPPORT_DIR, 'Default', 'Favicons')
  if (!existsSync(src)) return
  const tmp = join(tmpdir(), `mm-favicons-${process.pid}.db`)
  try {
    copyFileSync(src, tmp)
    // Largest bitmap per icon: the phone renders these at ~21pt on a Retina
    // screen, so a 16px source would look soft.
    const sql = `SELECT f.url, hex(b.image_data) FROM favicons f
      JOIN favicon_bitmaps b ON b.icon_id = f.id
      WHERE length(b.image_data) > 0
      GROUP BY f.url HAVING b.width = MAX(b.width);`
    const r = spawnSync('sqlite3', [tmp, sql], {
      encoding: 'utf8',
      timeout: OSASCRIPT_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024
    })
    if (r.error || r.status !== 0) return
    for (const line of r.stdout.split('\n')) {
      const sep = line.indexOf('|')
      if (sep < 0) continue
      const host = hostOf(line.slice(0, sep))
      const hex = line.slice(sep + 1)
      if (!host || !hex || faviconCache.has(host)) continue
      faviconCache.set(host, Buffer.from(hex, 'hex').toString('base64'))
    }
    devLog.log(`[app-context] cached ${faviconCache.size} favicons`)
  } catch (err) {
    devLog.warn('[app-context] favicon load failed:', err)
  } finally {
    try {
      unlinkSync(tmp)
    } catch {
      /* best effort — a stale tmp copy is harmless */
    }
  }
}

/** Safari reports no groups, so a "which group is active" read is meaningless
 *  there; exported for the registry's validation path only. */
export { EMPTY_READING }
