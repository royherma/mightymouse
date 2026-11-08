import { showCanvasWindow } from './canvas-window'
import { isCurrentUserAdmin } from './auth'
import { app, BrowserWindow } from 'electron'
import { showSettingsWindow } from './settings-window'
import { focusUpgradeWindow } from './upgrade-window'
import { broadcastBalance } from './billing'
import { CHANNELS } from '../shared/ipc'
import { CONFIG } from '../shared/config'
import { PREFS } from './store/prefs'
import { applyDockIcon } from './dock'
import { getMightyWindow, showAgentInCodeTab, showMightyWindow } from './mighty/mighty-window'
import { queueAgentUrl } from './side-browser'
import { modLinkUrl } from './browser-task/shared-mods'
import { isCodeTab } from '../shared/types'
import type { CheckoutReturnStatus, CodeTab } from '../shared/types'
import { devLog } from '../shared/env'
import { track } from './analytics'
import { ANALYTICS_EVENT } from '../shared/analytics-events'

/**
 * {CONFIG.PROTOCOL_SCHEME}:// deep-link handling (mightymouse:// in prod/dev,
 * mightymouse-staging:// in a staging packaged build). Stripe checkout redirects
 * back to <scheme>://billing/success?session_id=... (or .../cancel), the OS hands
 * the URL to the app, and we route it here: focus the app, open Settings, and push
 * a result + fresh balance to the renderer.
 *
 * DEV CAVEAT: a custom scheme only resolves to an INSTALLED, packaged build.
 * `setAsDefaultProtocolClient` from an unpackaged `electron` dev binary is
 * unreliable on macOS, so verify this on a packaged staging build. For the inner
 * loop, unit-test parseDeepLink and manually `open "mightymouse://billing/success"`
 * against an installed app. The crediting itself does NOT depend on this — the
 * Stripe webhook grants credits regardless of whether the user returns.
 */

export type DeepLinkRoute =
  | { kind: 'checkout'; status: CheckoutReturnStatus; sessionId?: string }
  | { kind: 'onboard'; email: string }
  // agent-relay PRD §7 "Open the screen": every notify/ask/approve/show card
  // carries this so any Mac-side surface can jump straight to phone-remote
  // pairing/mirror instead of a bare Settings link.
  | { kind: 'phone-remote' }
  // <scheme>://code/<tab> — straight to the Code tab, so a card, a script or a
  // link can land on one agent's conversation instead of on Settings.
  | { kind: 'code'; tab?: CodeTab; session?: string }
  | { kind: 'canvas' }
  | { kind: 'mod'; id: string }
  | { kind: 'unknown' }

/**
 * Parse a mightymouse:// URL into a route. Pure + total — never throws, returns
 * { kind: 'unknown' } for anything we don't recognise. Extracted so it's testable
 * without Electron.
 */
export function parseDeepLink(rawUrl: string): DeepLinkRoute {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { kind: 'unknown' }
  }
  if (url.protocol !== `${CONFIG.PROTOCOL_SCHEME}:`) return { kind: 'unknown' }

  // <scheme>://billing/success → host 'billing', path '/success'.
  const action = url.pathname.replace(/^\/+/, '').toLowerCase()
  if (url.hostname === 'billing' && (action === 'success' || action === 'cancel')) {
    return {
      kind: 'checkout',
      status: action as CheckoutReturnStatus,
      sessionId: url.searchParams.get('session_id') ?? undefined
    }
  }
  // <scheme>://onboard?email=... — the landing page hands off the download email
  // so the sign-in screen pre-fills it (near-100% email match → attribution).
  if (url.hostname === 'onboard') {
    const email = (url.searchParams.get('email') ?? '').trim()
    if (email) return { kind: 'onboard', email }
  }
  // <scheme>://phone-remote — the "Open the screen" affordance.
  if (url.hostname === 'phone-remote') return { kind: 'phone-remote' }
  if (url.hostname === 'canvas') return { kind: 'canvas' }
  if (url.hostname === 'mod' && /^[0-9a-z]{10}$/.test(action)) return { kind: 'mod', id: action.toUpperCase() }
  // <scheme>://code, or <scheme>://code/agents to name the sub-tab. An
  // unrecognised tab falls back to the Code tab's own default rather than
  // failing the link.
  if (url.hostname === 'code') {
    const session = url.searchParams.get('session')?.trim() || undefined
    if (session) return { kind: 'code', session }
    return { kind: 'code', tab: isCodeTab(action) ? action : undefined }
  }
  return { kind: 'unknown' }
}

/**
 * Bring the app to the foreground and show Settings (where billing UI lives).
 * `preferUpgrade` returns the buyer to the upgrade window when that's what
 * started the checkout — it renders the success/failure state itself, so opening
 * Settings over it would hide the outcome behind the wrong window.
 */
function focusApp(preferUpgrade = false): void {
  if (preferUpgrade && focusUpgradeWindow()) {
    if (isMac && app.dock) void app.dock.show()
    setImmediate(() => applyDockIcon())
    return
  }
  // dock.show() is what raises an accessory app to the front, so call it even when
  // the Dock pref is off — otherwise the Settings window opens behind the browser
  // the user just came from.
  if (isMac && app.dock) void app.dock.show()
  showSettingsWindow()
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && win.isMinimized()) win.restore()
  }
  // Settle back to the user's pref: without this, a deep link would permanently
  // reveal a Dock icon they opted out of. Deferred so the show() above still does
  // its job of raising the window before we hide the icon again.
  setImmediate(() => applyDockIcon())
}

const isMac = process.platform === 'darwin'

/** Notify every open window that the checkout deep link returned. */
function pushCheckoutReturn(status: CheckoutReturnStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(CHANNELS.billingCheckoutReturn, status)
  }
}

/**
 * Handle one inbound deep link. Safe to call before/after whenReady — the
 * cold-start buffering in index.ts ensures windows exist by the time we route.
 */
export async function handleDeepLink(rawUrl: string): Promise<void> {
  const route = parseDeepLink(rawUrl)
  // Onboard handoff: stash the download email so the sign-in screen pre-fills it.
  // Pure side effect on PREFS; the auth window reads it when it mounts.
  if (route.kind === 'onboard') {
    devLog.log('[deeplink] onboard email handoff')
    PREFS.setPendingAuthEmail(route.email)
    focusApp()
    return
  }
  if (route.kind === 'phone-remote') {
    devLog.log('[deeplink] open phone-remote')
    showSettingsWindow('phoneRemote')
    return
  }
  if (route.kind === 'canvas') {
    if (await isCurrentUserAdmin()) showCanvasWindow()
    return
  }
  if (route.kind === 'mod') {
    devLog.log('[deeplink] open shared mod')
    queueAgentUrl(modLinkUrl(route.id))
    showMightyWindow()
    getMightyWindow()?.webContents.send(CHANNELS.sideBrowserOpenUrl)
    return
  }
  if (route.kind === 'code') {
    devLog.log('[deeplink] open code', route.tab ?? '(default)')
    if (isMac && app.dock) void app.dock.show()
    if (route.session) showAgentInCodeTab({ ref: route.session })
    else showMightyWindow(false, undefined, undefined, true, route.tab)
    setImmediate(() => applyDockIcon())
    return
  }
  if (route.kind !== 'checkout') {
    devLog.warn('[deeplink] ignored unrecognised url:', rawUrl)
    return
  }
  devLog.log('[deeplink] checkout return:', route.status, route.sessionId ?? '')
  track(ANALYTICS_EVENT.checkout_returned, { result: route.status })
  focusApp(true)
  pushCheckoutReturn(route.status)
  // On success, refresh the balance so the new credits show immediately. The
  // webhook is the source of truth; this is just a fast UI nudge (and it may race
  // the webhook by a beat — the renderer also keeps a short poll as a backstop).
  if (route.status === 'success') await broadcastBalance()
}
