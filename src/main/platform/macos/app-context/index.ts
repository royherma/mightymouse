// app-context/index.ts — the adapter registry behind Phone Remote's app-aware bar.
//
// Same bargain as BACKENDS in src/main/backend/adapters.ts: one entry per app,
// and adding an app is appending an adapter rather than branching a caller.
// Everything above this file (the wire, the IPC handler, the React bar) speaks
// only the neutral AppContext vocabulary and never learns which app it is
// talking to.
//
// An adapter is CODE, not config: each app has its own AppleScript dialect
// ("active tab index" vs "select tab") and many expose nothing at all. That is
// why there is no user-editable mapping here — see the PRD's section 8.

import { devLog } from '../../../../shared/env'
import {
  APP_ADAPTER,
  EMPTY_READING,
  isOwnBundleId,
  type AppAdapterId,
  type AppContext,
  type AppContextReading
} from '../../../../shared/app-context'
import { listSwitchableApps } from '../app-switcher-list'
import { currentForeignFrontmostBundleId, currentFrontmostBundleId } from '../frontmost-watch'
import { runOsa } from './osa'
import { activateChromeProfile, activateChromeTab, readActiveTab, readChrome } from './chrome'
import { activateCmuxTab, activateCmuxTerminal, readCmux,
  activateCmuxPane
} from './cmux'
import { activateCursorWindow, readCursor } from './cursor'

interface AppAdapter {
  id: AppAdapterId
  /** Bundle ids this adapter claims. Chromium forks share Chrome's scripting
   *  dictionary, so they can be added here without new code. */
  bundleIds: string[]
  /** Preferred label — the scriptable name beats the switcher's display name
   *  for a browser ("Google Chrome"). '' keeps whatever the switcher reported. */
  appName: string
  read(): AppContextReading | Promise<AppContextReading>
  activateItem(id: string): boolean
  activateGroup(id: string): boolean
  /** Focus a tmux pane inside the focused terminal. Optional because the level is
   *  per-terminal, not per-adapter: a browser tab has nothing inside it, and half
   *  of a live cmux window's panels are plain shells with no panes at all. */
  activatePane?(id: string): boolean
}

const ADAPTERS: readonly AppAdapter[] = [
  {
    id: APP_ADAPTER.chrome,
    bundleIds: ['com.google.Chrome'],
    appName: 'Google Chrome',
    read: () => readChrome(APP_ADAPTER.chrome),
    activateItem: (id) => activateChromeTab(APP_ADAPTER.chrome, id),
    activateGroup: activateChromeProfile
  },
  {
    id: APP_ADAPTER.safari,
    bundleIds: ['com.apple.Safari'],
    appName: 'Safari',
    read: () => readChrome(APP_ADAPTER.safari),
    activateItem: (id) => activateChromeTab(APP_ADAPTER.safari, id),
    // Safari has no profile concept, so it reports zero groups and the bar
    // drops that control entirely.
    activateGroup: () => false
  },
  {
    id: APP_ADAPTER.cmux,
    bundleIds: ['com.cmuxterm.app'],
    appName: 'cmux',
    read: readCmux,
    activateItem: activateCmuxTerminal,
    activateGroup: activateCmuxTab,
    activatePane: activateCmuxPane
  },
  {
    id: APP_ADAPTER.cursor,
    bundleIds: ['com.todesktop.230313mzl4w4u92'],
    appName: 'Cursor',
    read: readCursor,
    // Editor tabs are unreachable in an Electron AX tree — see cursor.ts. The
    // right dropdown renders nothing, the mirror of Safari's missing groups.
    activateItem: () => false,
    activateGroup: activateCursorWindow
  }
]

function adapterFor(bundleId: string): AppAdapter | null {
  return ADAPTERS.find((a) => a.bundleIds.includes(bundleId)) ?? null
}

/** Bundle id of the frontmost app. NSWorkspace cache first — System Events enumerates every process (~800ms+) and freezes paint. Not the quick-switch MRU (see quick-switch.ts). */
export function frontmostBundleId(): string {
  const cached = currentFrontmostBundleId()
  if (cached) return cached
  return (
    runOsa(
      'tell application "System Events" to return bundle identifier of first application process whose frontmost is true'
    ) ?? ''
  )
}

/**
 * The app the USER was last in, never one of our own windows.
 *
 * Every MightyMouse surface (HUD, route card, panel) activating registers as a
 * frontmost change, and routing reads this AFTER its card is already up — so the
 * raw reading reported Electron for every voice note instead of the Chrome tab
 * the note was about. Falls back to the raw reading when no foreign app has been
 * seen yet (a fresh watcher), which is still better than nothing.
 */
export function userFacingFrontmostBundleId(): string {
  const foreign = currentForeignFrontmostBundleId()
  if (foreign) return foreign
  const raw = frontmostBundleId()
  return isOwnBundleId(raw) ? '' : raw
}

/** How long to keep asking macOS whether the app we activated is frontmost yet. */
const FRONTMOST_SETTLE_TIMEOUT_MS = 1200
/** Gap between polls. Each check is a cache read; this is a wait for
 *  NSWorkspace to publish the activation, not a spawn. */
const FRONTMOST_POLL_GAP_MS = 60

/**
 * Wait until `bundleId` is actually frontmost, or give up.
 *
 * Returns TRUE only when the app really came to the front. A caller about to
 * send a keystroke MUST check this: on false the keystroke would land in
 * whatever app is frontmost instead, which for an agent chat means submitting
 * into the wrong window.
 *
 * Activation is ASYNCHRONOUS: `NSRunningApplication.activate` files a request
 * and returns (measured: 55ms), while the app becomes frontmost later. So
 * reading the context straight after an activate reports the app we just
 * switched AWAY from — which is what left the keyboard bar naming the old app.
 *
 * Polls rather than sleeping a fixed guess: the cache is usually current on
 * the first check once NSWorkspace has published the activation.
 *
 * ASYNC on purpose. The old bare `do/while` froze the Electron main thread
 * for up to the full timeout when each poll was a spawnSync.
 */
export async function waitForFrontmost(bundleId: string): Promise<boolean> {
  const deadline = Date.now() + FRONTMOST_SETTLE_TIMEOUT_MS
  do {
    if (frontmostBundleId() === bundleId) return true
    await new Promise((r) => setTimeout(r, FRONTMOST_POLL_GAP_MS))
  } while (Date.now() < deadline)
  return false
}

/**
 * Everything the phone's app-aware bar renders from, in one shot.
 *
 * `adapterId: null` (an app with no adapter, or one we cannot read) is a normal
 * answer, not an error — the phone shows the app chip alone and drops the
 * dropdowns.
 */
export async function readAppContext(): Promise<AppContext> {
  const bundleId = frontmostBundleId()
  const adapter = bundleId ? adapterFor(bundleId) : null
  const identity = frontmostIdentity(bundleId)

  if (!adapter) return { adapterId: null, ...identity, ...EMPTY_READING }

  const reading = await adapter.read()

  return {
    adapterId: adapter.id,
    ...identity,
    appName: adapter.appName || identity.appName,
    ...reading
  }
}

export async function readFrontmostScreen(): Promise<{
  bundleId: string
  appName: string
  title: string
  url: string
} | null> {
  const bundleId = userFacingFrontmostBundleId()
  if (!bundleId) return null
  const adapter = adapterFor(bundleId)
  const appName = adapter?.appName || bundleId
  if (adapter && (adapter.id === APP_ADAPTER.chrome || adapter.id === APP_ADAPTER.safari)) {
    const tab = await readActiveTab(adapter.id)
    return { bundleId, appName, title: tab?.title ?? '', url: tab?.url ?? '' }
  }
  return { bundleId, appName, title: '', url: '' }
}

/** Longest id any adapter hands out is a uuid (36) plus room for a profile dir. */
const MAX_ID_LENGTH = 128

/**
 * The floor every adapter's id clears, checked before one reaches a script.
 * Control characters are the interesting rejects — a newline in an interpolated
 * string is how a one-line `tell` becomes two statements, even after quoting.
 * Non-empty and length-bounded rule out the rest.
 */
function isPlausibleItemId(id: string): boolean {
  if (!id || id.length > MAX_ID_LENGTH) return false
  // Explicit code-point walk, not a regex: the range this rejects is literal
  // control bytes, and embedding those in a character class makes the source
  // itself unreadable and easy to corrupt.
  for (const ch of id) {
    const code = ch.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return false
  }
  return true
}

/**
 * Activate an item (tab / terminal) by the id the Mac itself handed out.
 *
 * Validation is SHAPE, not membership. It used to re-read the whole adapter to
 * prove the id was on screen, which cost a second AppleScript enumeration
 * (~170ms) on the critical path of every dropdown tap — the tap ran five serial
 * round-trips and felt it.
 *
 * Dropping it is safe because the read was never the injection defense: every
 * adapter interpolates through its own AppleScript string escape, and a
 * non-member id simply fails the `whose id is …` lookup inside the script and
 * returns false. What the read did add was a guarantee the id is *currently*
 * on screen — and it could not actually deliver that, since the item can close
 * between the read and the activate. So the check below is the honest one: it
 * rejects anything that isn't the right kind of token before it reaches a
 * script, and the script itself rejects anything that isn't really there.
 *
 * Deliberately NOT a shared format pattern: Chrome's ids are tab indices and
 * profile dir names, cmux's are uuids. One regex loose enough for all three
 * proves nothing, so each adapter keeps its own strict parse (Chrome's
 * parseInt, cmux's escaped lookup) and this only screens out lengths and
 * control characters no id of any adapter ever has.
 */
export function activateAppItem(itemId: string): boolean {
  const adapter = adapterFor(frontmostBundleId())
  if (!adapter) return false
  if (!isPlausibleItemId(itemId)) {
    devLog.warn('[app-context] refused malformed item id')
    return false
  }
  return adapter.activateItem(itemId)
}

/**
 * Focus a tmux pane by the id tmux issued (`%47`).
 *
 * A tighter gate than items and groups get: this id becomes a tmux command
 * argument, and everything arriving over the socket is attacker-controllable once
 * the tunnel is on. `%` plus digits is tmux's whole vocabulary here, so anything
 * else is refused rather than sanitised.
 */
export function activateAppPane(paneId: string): boolean {
  const adapter = adapterFor(frontmostBundleId())
  if (!adapter?.activatePane) return false
  if (!/^%\d{1,9}$/.test(paneId)) {
    devLog.warn('[app-context] refused malformed pane id')
    return false
  }
  return adapter.activatePane(paneId)
}

/** Activate a group (profile / cmux tab). Same shape rule as items. */
export function activateAppGroup(groupId: string): boolean {
  const adapter = adapterFor(frontmostBundleId())
  if (!adapter) return false
  if (!isPlausibleItemId(groupId)) {
    devLog.warn('[app-context] refused malformed group id')
    return false
  }
  return adapter.activateGroup(groupId)
}

/**
 * Name + icon of the frontmost app, reusing the app-switcher's already-cached
 * icon pipeline rather than rendering a second one — the frontmost app is by
 * definition running, so it is always a row in that list.
 *
 * Falls back to the bare bundle id as a label: a chip reading "com.foo.Bar" is
 * still more useful than an empty slot, and this whole path is best-effort.
 */
function frontmostIdentity(
  bundleId: string
): Pick<AppContext, 'bundleId' | 'appName' | 'appIconPngBase64'> {
  if (!bundleId) return { bundleId: '', appName: '', appIconPngBase64: '' }
  const match = listSwitchableApps().find((a) => a.bundleId === bundleId)
  return {
    bundleId,
    appName: match?.name || bundleId,
    appIconPngBase64: match?.iconPngBase64 ?? ''
  }
}
