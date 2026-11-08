/**
 * Phone Remote -- app-context push to the phone: frontmost-app + running-apps
 * watchers, the clipboard/app-switch/window-layout state pushes they trigger,
 * and the interest gate that keeps a disconnected phone from being paid for.
 */
import { clipboard } from 'electron'
import { PERMISSIONS, context } from '../platform'
import { isWindowLayoutKind } from '../platform/geometry'
import { isPhoneConnected, sendToPhone, type PhoneRemoteMessage } from '../phone-remote/server'
import { noteScreenStreamInput } from '../capture/screen-stream'
import { devLog } from '../../shared/env'

let appContextReading = false
let appContextStale = false

export function sendAppContext(): void {
  if (appContextReading) {
    appContextStale = true
    return
  }
  appContextReading = true
  void context
    .readAppContext()
    .then((appContext) => sendToPhone({ type: 'appContextState', context: appContext }))
    .catch((err) => devLog.warn('[phone-remote] app context read failed:', err))
    .finally(() => {
      appContextReading = false
      if (!appContextStale) return
      appContextStale = false
      sendAppContext()
    })
}

const APP_CONTEXT_INTEREST_MS = 60_000
let appContextAskedAt = 0

export function markAppContextAsked(): void {
  appContextAskedAt = Date.now()
}

export function barIsLikelyVisible(): boolean {
  return isPhoneConnected() && Date.now() - appContextAskedAt < APP_CONTEXT_INTEREST_MS
}

let unsubscribeFrontmost: (() => void) | null = null
let unsubscribeRunningApps: (() => void) | null = null

export function watchFrontmostForPhone(): void {
  unsubscribeFrontmost?.()
  unsubscribeFrontmost = context.onFrontmostAppChange((_bundleId, spawnEcho) => {
    // A spawn echo is the watcher (re)starting -- which happens on every phone
    // connect -- not the screen changing. Heralding it downscaled the mirror and
    // stalled the encoder ~2s per connect (PRD 2026-08-18-1787030000). The app
    // bar below still gets it: a respawn may have missed a real switch.
    if (!spawnEcho) {
      // ABOVE the bar-visibility gate on purpose. Switching apps on the MAC sends
      // no phone message, so CHANGES_THE_SCREEN never fired for it and the glasses
      // met a full-size repaint keyframe at whatever the estimate had collapsed to
      // while the screen sat still -- the "slow to switch" symptom. NSWorkspace
      // publishes the activation before the repaint lands, which is the only
      // moment early enough to downscale first. The bar being off screen doesn't
      // make the mirror any less slow.
      noteScreenStreamInput('switch')
    }
    if (!barIsLikelyVisible()) return
    sendAppContext()
  })
  unsubscribeRunningApps?.()
  // A launch/quit is the ONE app-list change the phone cannot ask for: every
  // other sendAppSwitchList() call answers a phone message, and the phone only
  // asks on connect and on its own switch actions. Without this an app started
  // after connecting stays invisible to the ring until the user taps the
  // switcher -- which is the whole bug. Gated on Accessibility to match every
  // other producer of this list; without it listSwitchableApps() is empty.
  unsubscribeRunningApps = context.onRunningAppsChange(() => {
    if (!isPhoneConnected()) return
    if (!PERMISSIONS.hasAccessibility(false)) return
    sendAppSwitchList()
  })
}

export function unwatchFrontmostForPhone(): void {
  unsubscribeFrontmost?.()
  unsubscribeFrontmost = null
  unsubscribeRunningApps?.()
  unsubscribeRunningApps = null
  appContextAskedAt = 0
}

export function clipboardHasContent(): boolean {
  return clipboard.availableFormats().length > 0
}

export function sendClipboardState(): void {
  sendToPhone({ type: 'clipboardStateResult', hasContent: clipboardHasContent() })
}

export function sendAppSwitchList(): void {
  sendToPhone({
    type: 'appSwitchList',
    apps: context.listSwitchableApps(),
    anchorBundleId: context.getQuickSwitchAnchor()
  })
}

export function sendWindowLayoutState(): void {
  sendToPhone({ type: 'windowLayoutState', canRestore: context.hasRestoreStash() })
}

export function handleWindowLayout(
  msg: Extract<PhoneRemoteMessage, { type: 'windowLayout' }>,
  phoneMayControlMac: () => boolean
): void {
  if (!phoneMayControlMac()) return
  if (!isWindowLayoutKind(msg.kind)) return
  // Only apps the phone was actually offered. Without this the wire could
  // name any bundle id on the machine and have its window moved.
  const switchable = new Set(context.listSwitchableApps().map((a) => a.bundleId))
  const bundleIds = (Array.isArray(msg.bundleIds) ? msg.bundleIds : []).filter((id) =>
    switchable.has(id)
  )
  const result = context.applyWindowLayout(msg.kind, bundleIds)
  // AX moves a window without activating it, so a tiled app that was behind
  // another stays behind it and reads as "that one didn't move". Raise in
  // reverse so slot 1 ends up frontmost.
  for (const bundleId of [...result.applied].reverse()) context.activateApp(bundleId)
  // The sheet's Restore button is shown or hidden off this.
  sendWindowLayoutState()
}

export function handleAppSwitchOpen(phoneMayControlMac: () => boolean): void {
  if (!phoneMayControlMac()) return
  sendAppSwitchList()
  sendAppContext()
}

export function handleAppSwitchActivate(
  msg: Extract<PhoneRemoteMessage, { type: 'appSwitchActivate' }>,
  phoneMayControlMac: () => boolean
): void {
  if (!phoneMayControlMac()) return
  void context.afterQuickSwitchQueue(async () => {
    if (!context.activateApp(msg.bundleId)) return
    // The walk origin has to follow, or the next burst counts forward from
    // whatever app the last quickSwitchApps() call left behind.
    context.setQuickSwitchAnchor(msg.bundleId)
    sendAppSwitchList()
    // The keyboard bar names the frontmost app, and we just changed it.
    // Waited for, not read straight away: activation is async, so an
    // immediate read still answers with the app we switched away from.
    await context.waitForFrontmost(msg.bundleId)
    sendAppContext()
  })
}

export function handleAppSwitchMru(phoneMayControlMac: () => boolean): void {
  // Same list as appSwitchOpen, minus any popup semantics -- the phone uses
  // it to label/picture the quick-switch destination before firing a burst.
  if (!phoneMayControlMac()) return
  sendAppSwitchList()
}

export function handleAppSwitchQuick(
  msg: Extract<PhoneRemoteMessage, { type: 'appSwitchQuick' }>,
  phoneMayControlMac: () => boolean
): void {
  if (!phoneMayControlMac()) return
  // Queued behind any prior tap so a rapid re-tap reads the MRU list only
  // after the previous tap's activate has actually landed, never a stale
  // snapshot mid-switch (see afterQuickSwitchQueue's comment).
  void context.afterQuickSwitchQueue(async () => {
    const landed = await context.quickSwitchApps(msg.steps)
    sendAppSwitchList()
    // Same reason as appSwitchActivate: the bar's app chip is now wrong,
    // and activation lands after the call that requested it returns.
    if (landed) await context.waitForFrontmost(landed.bundleId)
    sendAppContext()
  })
}

export function handleAppContext(phoneMayControlMac: () => boolean): void {
  if (!phoneMayControlMac()) return
  // Marks the bar as on screen, so frontmost-app switches push to it until
  // this goes stale. See barIsLikelyVisible().
  markAppContextAsked()
  sendAppContext()
}

export function handleClipboardState(): void {
  sendClipboardState()
}
