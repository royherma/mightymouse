/**
 * Why THIS phone failed to connect, recorded on the phone.
 *
 * Flushed two ways: POST /connect-log as soon as a dial is refused (the Mac
 * is reachable by definition — it just said no), and again over the WS on the
 * next onopen as a fallback. nativeBridge.log stays on the phone's os_log
 * and never reaches the Mac; this buffer is what does.
 *
 * Privacy: an outcome and a host, never a credential. The credential appears
 * only as a present/absent boolean, on the same reasoning as the Mac journal.
 */

import { CONFIG } from '@shared/config'
import { capabilities } from './host-capabilities'
import { nativeBridge } from './native-bridge'
import {
  CONNECT_LOG_MAX_ENTRIES,
  formatAttempt,
  type ConnectAttempt,
  type ConnectOutcome
} from '@shared/phone-connect-log'

export type { ConnectAttempt, ConnectOutcome }
export { formatAttempt }

const STORAGE_KEY = 'mm-connect-log'

function read(): ConnectAttempt[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as ConnectAttempt[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function write(entries: ConnectAttempt[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
  } catch {
    // Losing the log is always better than failing the connect it exists to explain.
  }
}

export function recordAttempt(
  outcome: ConnectOutcome,
  fields: {
    detail?: string | null
    host?: string | null
    hadCredential?: boolean
    attempt?: number
    opened?: boolean
  } = {}
): void {
  const entries = read()
  entries.push({
    at: Date.now(),
    outcome,
    detail: fields.detail ?? null,
    host: fields.host ?? null,
    hadCredential: fields.hadCredential ?? false,
    attempt: fields.attempt ?? 0,
    ...(typeof fields.opened === 'boolean' ? { opened: fields.opened } : {}),
    // Stamped here rather than at each call site so no future outcome can
    // forget them. Read live: `capabilities` is frozen at page load, but the
    // handler can attach after that, and the gap between the two IS the
    // diagnosis for a native app that came up believing it was a PWA.
    shell: capabilities.shell,
    handler: nativeBridge.available,
    bootstrap: nativeBridge.bootstrapPresent()
  })
  if (entries.length > CONNECT_LOG_MAX_ENTRIES) {
    entries.splice(0, entries.length - CONNECT_LOG_MAX_ENTRIES)
  }
  write(entries)
}

export function readAttempts(): ConnectAttempt[] {
  return read()
}

export function drainAttempts(): ConnectAttempt[] {
  const entries = read()
  if (entries.length > 0) write([])
  return entries
}

/** POST the buffer to the host that just refused the WS. Drains first so a
 *  later onopen cannot replay the same rows; restores the buffer if the POST
 *  does not land. Never throws. */
export async function flushAttemptsToHost(host: string): Promise<boolean> {
  const entries = drainAttempts()
  if (entries.length === 0) return true
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CONFIG.PHONE_REMOTE.CONNECT_LOG_FLUSH_MS)
  try {
    const res = await fetch(`https://${host}${CONFIG.PHONE_REMOTE.CONNECT_LOG_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries }),
      mode: 'cors',
      signal: controller.signal
    })
    if (res.ok) return true
  } catch {
    // WS onopen drain is the fallback.
  } finally {
    clearTimeout(timer)
  }
  const merged = [...entries, ...read()]
  if (merged.length > CONNECT_LOG_MAX_ENTRIES) {
    merged.splice(0, merged.length - CONNECT_LOG_MAX_ENTRIES)
  }
  write(merged)
  return false
}
