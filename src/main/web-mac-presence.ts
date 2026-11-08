import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { CONFIG } from '../shared/config'
import { withTimeout } from './auth'
import { getSupabase } from './supabase'
import { PATHS } from './store/paths'
import { PREFS } from './store/prefs'
import { getTunnelHostname } from './phone-remote/cloudflare-tunnel'

const PRESENCE_INTERVAL_MS = 30_000
const PRESENCE_REQUEST_TIMEOUT_MS = 8_000
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

let interval: ReturnType<typeof setInterval> | null = null
let inFlight = false
let publishAgain = false
let deviceId: string | null = null

function getDeviceId(): string | null {
  if (deviceId) return deviceId
  try {
    if (existsSync(PATHS.WEB_MAC_PRESENCE_ID)) {
      const saved = readFileSync(PATHS.WEB_MAC_PRESENCE_ID, 'utf-8').trim()
      if (UUID_RE.test(saved)) {
        deviceId = saved
        return saved
      }
    }
    const generated = randomUUID()
    writeFileSync(PATHS.WEB_MAC_PRESENCE_ID, generated, { encoding: 'utf-8', mode: 0o600 })
    deviceId = generated
    return generated
  } catch (error) {
    console.error('[web-mac-presence] device id unavailable:', error)
    return null
  }
}

async function publishPresence(): Promise<void> {
  if (interval === null || PREFS.getIncognito()) return
  if (inFlight) {
    publishAgain = true
    return
  }
  const id = getDeviceId()
  if (!id) return
  inFlight = true
  try {
    const supabase = getSupabase()
    const session = await withTimeout(
      supabase.auth.getSession(),
      PRESENCE_REQUEST_TIMEOUT_MS,
      null
    )
    const userId = session?.data.session?.user.id
    if (!userId || interval === null || PREFS.getIncognito()) return
    const { error } = await supabase.from('web_mac_presence').upsert(
      { user_id: userId, device_id: id, app_version: CONFIG.APP_VERSION, tunnel_host: getTunnelHostname() },
      { onConflict: 'user_id,device_id' }
    ).abortSignal(AbortSignal.timeout(PRESENCE_REQUEST_TIMEOUT_MS))
    if (error) {
      console.warn('[web-mac-presence] heartbeat failed:', error.message)
    }
  } catch (error) {
    console.warn('[web-mac-presence] heartbeat failed:', error)
  } finally {
    inFlight = false
    if (publishAgain) {
      publishAgain = false
      void publishPresence()
    }
  }
}

export function refreshWebMacPresence(): void {
  void publishPresence()
}

export function startWebMacPresence(): void {
  if (interval !== null) return
  interval = setInterval(() => void publishPresence(), PRESENCE_INTERVAL_MS)
  void publishPresence()
}

export function stopWebMacPresence(): void {
  if (interval === null) return
  clearInterval(interval)
  interval = null
}
