/**
 * The Mac's end of the cloud answer path: a push arrives over APNs whatever this
 * Mac's network is doing, but answering needed /relay-respond on this machine.
 * ALWAYS SECOND -- resolve() is first-answer-wins. Only an id and an HMAC leave.
 */

import { CONFIG } from '../../shared/config'
import { devLog } from '../../shared/env'
import { getSupabase } from '../supabase'
import { PREFS } from '../store/prefs'
import { relayRequestStore, type RelayResolvedVia, type RelayResponse } from './store'

async function currentJwt(): Promise<string> {
  const { data } = await getSupabase().auth.getSession()
  return data.session?.access_token ?? ''
}

async function callPending(action: 'register' | 'claim', extra: Record<string, unknown> = {}) {
  const jwt = await currentJwt()
  if (!jwt) return null

  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), CONFIG.AGENT_RELAY.PUSH_TIMEOUT_MS)
  try {
    const resp = await fetch(
      `${CONFIG.BILLING.EDGE_FUNCTION_URL}/${CONFIG.AGENT_RELAY.PENDING_FN}`,
      {
        method: 'POST',
        signal: abort.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ action, ...extra })
      }
    )
    if (!resp.ok) return null
    return (await resp.json().catch(() => null)) as { answers?: CloudAnswer[] } | null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

interface CloudAnswer {
  request_id: string
  answer: string | null
  approved: boolean | null
  dismissed: boolean | null
}

export async function registerCloudAnswer(requestId: string, credential: string): Promise<void> {
  if (!PREFS.getAgentRelayEnabled()) return
  // HMAC'd SERVER-side: a key here ships in the app, letting anyone with the
  // binary mint a secret for a guessed request id -- what the secret prevents.
  await callPending('register', { requestId, answerSecret: credential })
}

/** `via` reuses existing values: the cloud is a transport, not a kind of answer. */
function applyAnswer(row: CloudAnswer): void {
  if (row.dismissed) {
    relayRequestStore.dismiss(row.request_id, null)
    devLog.log('[agent-relay] cloud answer applied (dismiss)', { requestId: row.request_id })
    return
  }

  const response: RelayResponse =
    row.approved !== null ? { approved: row.approved } : { answer: row.answer ?? '' }
  const via: RelayResolvedVia = row.approved !== null ? 'chip' : 'typed'

  const result = relayRequestStore.resolve(row.request_id, response, null, via)
  // 'unknown' is normal after a restart (in-memory store) AND what a real id
  // mismatch looks like -- so log it, never swallow it.
  devLog.log('[agent-relay] cloud answer applied', { requestId: row.request_id, result, via })
}

let pollTimer: ReturnType<typeof setInterval> | null = null

/** Started at app boot and kept running while the relay is off (each tick
 *  short-circuits), so toggling the setting needs no restart. */
export function startCloudAnswerPolling(): void {
  if (pollTimer) return
  pollTimer = setInterval(async () => {
    if (!PREFS.getAgentRelayEnabled()) return
    // Nothing pending means nothing can be answered -- skip the round trip.
    if (relayRequestStore.listPending().length === 0) return

    const body = await callPending('claim')
    if (!body?.answers?.length) return
    for (const row of body.answers) applyAnswer(row)
  }, CONFIG.AGENT_RELAY.CLOUD_POLL_MS)
  pollTimer.unref()
}

export function stopCloudAnswerPolling(): void {
  if (!pollTimer) return
  clearInterval(pollTimer)
  pollTimer = null
}
