/**
 * Battery + hostname pushed to the phone so the widget has
 * something to show without the Mac being reachable. `powerMonitor` has no
 * percentage anywhere in its surface -- see battery-status.ts for why that
 * read goes through `pmset` instead. `on-ac`/`on-battery` still fire the
 * charging EDGE; percent itself is polled and compared against the last-sent
 * payload so an unrelated wake-up doesn't reset the throttle for nothing.
 */
import { powerMonitor } from 'electron'
import platform, { system } from '../platform'
import { CONFIG } from '../../shared/config'
import { getAnalyticsUser } from '../analytics'
import { sendToPhone } from './server'
import type { PhoneRemoteEvent } from '../../shared/phone-remote-protocol'

function currentHostStatus(): Omit<Extract<PhoneRemoteEvent, { type: 'hostStatus' }>, 'type'> {
  const battery = system.getBatteryStatus()
  return {
    batteryPercent: battery.percent,
    charging: battery.charging,
    hostname: system.getComputerName(),
    at: Date.now(),
    capabilities: platform.capabilities,
    accountId: getAnalyticsUser()
  }
}

let lastSentAt = 0
let lastPayload: string | null = null
let watching = false

// Thing #5 of the five "locks" (see idle-lock-suppressor.ts): pure OBSERVATION
// of whether macOS is showing its password screen right now. Reading it never
// changes anything -- it only tells the phone what to display. Tracked from
// powerMonitor edges since launch; Electron has no getter, so a Mac already
// locked at app launch reads as unlocked until it unlocks.
let macAtPasswordScreen = false

/** Always sends — the connect-time push, so a phone connecting to a genuinely
 *  locked Mac is told plainly instead of staring at a login window. The wire
 *  type stays `macLockState`: the phone bundle ships prebuilt, and the name is
 *  accurate on that side (the Mac IS locked). */
export function sendPasswordScreenStateToPhone(): void {
  sendToPhone({ type: 'macLockState', locked: macAtPasswordScreen })
}

/** Always sends -- the connect-time push a fresh phone session needs
 *  regardless of the throttle, since it has never seen a value yet. */
export function sendHostStatusToPhone(): void {
  const status = currentHostStatus()
  lastSentAt = Date.now()
  lastPayload = JSON.stringify(status)
  sendToPhone({ type: 'hostStatus', ...status })
}

/** Throttled push for a background change (battery drain, AC plug/unplug).
 *  Skips a push whose payload is identical to the last one sent, so a
 *  same-percent poll firing inside the window doesn't reset the throttle
 *  clock for no reason. */
function pushIfChanged(): void {
  const status = currentHostStatus()
  const payload = JSON.stringify(status)
  if (payload === lastPayload) return
  if (Date.now() - lastSentAt < CONFIG.PHONE_REMOTE.HOST_STATUS_THROTTLE_MS) return
  lastSentAt = Date.now()
  lastPayload = payload
  sendToPhone({ type: 'hostStatus', ...status })
}

/** Idempotent: safe to call on every connect, only ever arms one interval. */
export function startHostStatusWatch(): void {
  if (watching) return
  watching = true
  powerMonitor.on('on-ac', pushIfChanged)
  powerMonitor.on('on-battery', pushIfChanged)
  powerMonitor.on('lock-screen', () => {
    macAtPasswordScreen = true
    sendPasswordScreenStateToPhone()
  })
  powerMonitor.on('unlock-screen', () => {
    macAtPasswordScreen = false
    sendPasswordScreenStateToPhone()
  })
  const pollTimer = setInterval(pushIfChanged, CONFIG.PHONE_REMOTE.HOST_STATUS_THROTTLE_MS)
  pollTimer.unref()
}
