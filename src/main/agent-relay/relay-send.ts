/**
 * Sends one push through the agent-relay Edge Function. The Mac
 * never talks to APNs directly -- the .p8 key lives only in Supabase secrets.
 * This module owns exactly one job: turn a minted RelayRequest into a push,
 * or fail with a stated, actionable reason. Retry/backoff and the health line
 * both read this module's return shape rather than re-deriving failure modes.
 */

import { appendFileSync } from 'fs'
import { CONFIG } from '../../shared/config'
import { devLog } from '../../shared/env'
import { getSupabase } from '../supabase'
import { PATHS } from '../store/paths'
import { PREFS } from '../store/prefs'
import { pushableDevice } from '../phone-remote/server'
import { showMacRelayNotification } from './mac-notification'
import { registerCloudAnswer } from './cloud-answers'
import { relayRequestStore, type RelayRequest } from './store'
import { interviewPushSuffix, isInterview } from '../../shared/relay-interview'
import { relayProject } from './project-avatar-png'
import { passesNotifyLevel } from '../../shared/relay-push-filter'

export type RelaySendResult =
  | { ok: true; deviceLabel: string }
  | { ok: false; reason: 'relay-off' | 'no-device' | 'no-token' | 'not-signed-in' | 'send-failed'; detail: string }

async function currentJwt(): Promise<string> {
  const { data } = await getSupabase().auth.getSession()
  return data.session?.access_token ?? ''
}

/** "relay toggle off -> MCP calls fail fast ... the error string IS the
 *  guide." Checked first and unconditionally -- every other failure path
 *  below assumes the toggle already said yes. */
export function agentRelayOffReason(): string | null {
  return PREFS.getAgentRelayEnabled()
    ? null
    : 'Agent relay is off in MightyMouse Settings. Turn it on to let this agent reach your phone.'
}

/** Dev-only escape hatch (MM_RELAY_LOOPBACK_PUSH=1): append the push to a local
 *  JSONL instead of sending it, so the notify->answer->unblock loop runs with no
 *  phone and no APNs round trip. Never reachable in a packaged build -- the env
 *  var is read from the Mac's own process, and every other path is untouched. */
function loopbackPush(request: RelayRequest): RelaySendResult | null {
  if (process.env.MM_RELAY_LOOPBACK_PUSH !== '1') return null
  const row = {
    ts: new Date().toISOString(),
    requestId: request.id,
    verb: request.verb,
    title: titleFor(request) ?? null
  }
  try {
    appendFileSync(PATHS.AGENT_RELAY_LOOPBACK_LOG, JSON.stringify(row) + '\n', 'utf-8')
  } catch (err) {
    console.error('[agent-relay] loopback push write failed', err)
  }
  console.log('[agent-relay] loopback push', row)
  return { ok: true, deviceLabel: 'loopback (no phone)' }
}

/** A MIRROR, not a transport: the same card appears on the Mac whether or not a
 *  phone is reachable, and first answer wins -- so answering here while a
 *  push is in flight is a supported outcome rather than a conflict.
 *
 *  Reads the Mac's own switches, which is the whole point: the phone's filter
 *  no longer decides what the Mac shows. Never throws into the send path -- a
 *  mirror that fails must not cost the push it mirrors. */
function showMacAlert(request: RelayRequest): void {
  try {
    const mac = PREFS.getAgentRelayMacAlerts()
    if (!mac.enabled || !mac.filter[request.verb]) return

    // Same exemption the phone's floor has: the floor mutes an agent NARRATING,
    // and a turn-end ping or a finished turn is the one update a person is
    // actually waiting on.
    const announces = request.params.idle === true || request.params.state === 'done'
    if (
      request.verb === 'notify' &&
      !announces &&
      !passesNotifyLevel(mac.notifyLevel, request.params.level)
    ) {
      return
    }

    // Required lazily: a static import pulls BrowserWindow in at module load,
    // which breaks every test of this file that has no Electron runtime. Only
    // the card path needs a window at all.
    if (mac.renderer === 'card') {
      ;(require('../hud-window') as typeof import('../hud-window')).startRelayHud(request)
    } else {
      showMacRelayNotification(request)
    }
  } catch (err) {
    devLog.warn('[agent-relay] mac alert failed', err)
  }
}

export async function sendRelayPush(request: RelayRequest): Promise<RelaySendResult> {
  if (!PREFS.getAgentRelayEnabled()) {
    return { ok: false, reason: 'relay-off', detail: agentRelayOffReason()! }
  }

  // BEFORE the phone gates, deliberately. The mirror
  // used to sit below them, which meant a `return` for a phone-muted verb was
  // also a return for the Mac -- turning off updates on the phone silently
  // killed every Mac alert of that kind. They are two surfaces with two answers
  // now, so neither can mute the other.
  showMacAlert(request)

  // Muted is not failed: the caller logs ok:false as something gone wrong, and
  // a push the user deliberately turned off is working as asked. The card is
  // already in the store by now -- minting happens before this function is
  // called -- so muting costs the buzz and never the message.
  if (!PREFS.getAgentRelayPushFilter()[request.verb]) {
    return { ok: true, deviceLabel: 'muted (push filter)' }
  }

  // Severity floor, notify only -- `level` exists on no other verb, so an
  // ask/approve can never be silenced by it.
  //
  // `idle` is exempt: the floor mutes CHATTY notifies (an agent narrating with
  // no severity tagged), and a turn-end ping is neither chatty nor untagged --
  // it is a distinct thing the user opted into behind its own switch. Without
  // this, "Only buzz me about problems" silently ate every turn-end ping and
  // the two switches cancelled each other with nothing on screen saying so.
  // `done` is exempt for the same reason `idle` is: the floor mutes an agent
  // NARRATING, and "finished, nothing needed" is the end of the work rather
  // than a step in it -- the one notify a person is actually waiting on. Only
  // `progress` is left for the floor to mute, which is the chatter it was
  // written for.
  const announces = request.params.idle === true || request.params.state === 'done'
  if (
    request.verb === 'notify' &&
    !announces &&
    !passesNotifyLevel(PREFS.getAgentRelayNotifyLevel(), request.params.level)
  ) {
    return { ok: true, deviceLabel: 'muted (notify level)' }
  }

  const loopback = loopbackPush(request)
  if (loopback) return loopback

  const device = pushableDevice()
  if (device.deviceId === null) {
    const detail =
      device.reason === 'no-device'
        ? 'No phone paired yet. Pair one in MightyMouse Settings to get pushes.'
        : 'Your paired phone has not registered for pushes yet. Open the MightyMouse app on it once.'
    return { ok: false, reason: device.reason, detail }
  }

  const jwt = await currentJwt()
  if (!jwt) {
    return {
      ok: false,
      reason: 'not-signed-in',
      detail: 'Sign in to MightyMouse on this Mac to send pushes.'
    }
  }

  // BEFORE the push, and awaited: the phone can hold the card within a second
  // of APNs accepting it, and answering a row that does not exist yet is a 404.
  await registerCloudAnswer(request.id, device.credential)

  const project = relayProject(request.params)

  // Hoisted out of the fetch so the log below can print the object that was
  // ACTUALLY sent rather than a second construction of it -- the audit row is
  // written at mint time in store.ts and never sees the push body at all.
  const payload = {
    deviceToken: device.pushToken,
    requestId: request.id,
    verb: request.verb,
    title: titleFor(request),
    // Without a body the fallback path (NSE not running, or its fetch
    // failing) delivers a bare title and silently drops the message --
    // which is what shipped. See bodyFor for the per-verb content.
    body: bodyFor(request),
    // WHO is asking, never what they asked. The generic titles are per-verb
    // but not per-session, so two agents open at once produced two banners
    // no one could tell apart. A repo/branch/session label is not prompt
    // content -- it carries no code and no secret -- so it rides where the
    // question text deliberately does not.
    from: request.params.from?.slice(0, 60),
    // The NSE draws the icon from these with no network; the picture itself comes from /relay-avatar.
    project: project?.name.slice(0, 60),
    projectIcon: project?.icon,
    level: request.verb === 'notify' ? request.params.level : undefined,
    // Rides the push for every verb, unlike body: a drill has to be
    // identifiable on the lock screen, which is the one surface a person
    // acts on before any card is rendered.
    test: request.params.test === true,
    // The ONLY prompt-derived text that rides the push, and a deliberate
    // exception to the "question stays on the Mac" rule above: option labels
    // are the agent's own short answers ("Decaf"), and without them a
    // collapsed banner cannot say that any buttons exist. The server
    // truncates them into a hint; the full list still only reaches the phone
    // through the NSE's authed fetch.
    // An interview sends NO buttons: an action button resolves in the
    // background without opening the app, answering Q1 and stranding the
    // person with no route to Q2.
    options:
      request.verb === 'ask' && !isInterview(request.params.questions)
        ? request.params.options
        : undefined,
    bundleId: CONFIG.AGENT_RELAY.IOS_BUNDLE_ID
  }

  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), CONFIG.AGENT_RELAY.PUSH_TIMEOUT_MS)
  try {
    const resp = await fetch(`${CONFIG.BILLING.EDGE_FUNCTION_URL}/${CONFIG.AGENT_RELAY.PUSH_FN}`, {
      method: 'POST',
      signal: abort.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
      body: JSON.stringify(payload)
    })
    const body = (await resp.json().catch(() => ({}))) as { sent?: boolean; error?: string }
    if (!resp.ok || body.sent !== true) {
      return {
        ok: false,
        reason: 'send-failed',
        detail: body.error ?? `Push relay returned ${resp.status}`
      }
    }
    // The verb decides the category, and the bundle decides WHICH app is asked
    // to resolve it -- a push accepted for the wrong app still returns sent:true
    // and simply renders with whatever categories that app registered. Both are
    // logged together because either alone reads as a success.
    devLog.log('[agent-relay] push accepted', {
      verb: request.verb,
      bundleId: CONFIG.AGENT_RELAY.IOS_BUNDLE_ID,
      device: device.label,
      // A card that shows no choices has two causes that look identical on the
      // phone: the agent never offered any, or they were offered and dropped
      // somewhere between here and the glass. Only this end can say which.
      options: request.params.options?.length ?? 0,
      from: request.params.from ?? '(none)',
      project: payload.project ?? '(none)'
    })
    // The whole wire body on one line, so "what did that card actually say"
    // is answerable after the fact. deviceToken is dropped -- it is a
    // credential, and every other field is already visible on the lock screen.
    const { deviceToken: _token, ...wire } = payload
    devLog.log('[agent-relay] push payload', JSON.stringify(wire))
    scheduleFetchWatchdog(request.id)
    return { ok: true, deviceLabel: device.label }
  } catch (err) {
    return {
      ok: false,
      reason: 'send-failed',
      detail: err instanceof Error ? err.message : String(err)
    }
  } finally {
    clearTimeout(timer)
  }
}

/** APNs said sent, but did the NSE ever come back for the content? Without this
 *  warn, an NSE-side failure leaves no Mac-side trace at all. 45s is well past
 *  the NSE's ~30s iOS budget, so a firing is a verdict, not a race. */
const NSE_FETCH_WATCHDOG_MS = 45_000
function scheduleFetchWatchdog(requestId: string): void {
  const timer = setTimeout(() => {
    const current = relayRequestStore.get(requestId)
    // Resolved-before-fetch is fine (answered on the Mac); fetched is success.
    if (!current || current.fetched || current.status !== 'pending') return
    devLog.warn('[agent-relay] push accepted but NEVER fetched -- NSE-side failure', {
      requestId,
      verb: current.verb,
      hint: 'phone NSE could not reach GET /relay-request: check paired-device revoke (make phone-log), tunnel /whoami, or device os_log "relay content fetch failed"'
    })
  }, NSE_FETCH_WATCHDOG_MS)
  timer.unref()
}

/** Retire the iPhone card for a request that is no longer answerable.
 *
 * WHY: every other surface already clears itself off the store's change feed --
 * the HUD dismisses, the deck re-renders from the `relayPending` snapshot. The
 * lock screen was the one surface with no such path, so a card answered on the
 * Mac (or timed out) stayed there looking tappable indefinitely, and tapping it
 * did nothing at all: silently, because the request it names is gone. That
 * silence is the defect -- a dead button is indistinguishable from a broken one
 *
 * Deliberately quiet about failure. This runs on EVERY resolution, including
 * the overwhelmingly common one where no phone is paired and nothing was ever
 * pushed. There is nothing for a caller to do about a failed clear, and a
 * resolution must never fail because a cleanup did.
 */
export async function sendRelayClearPush(request: RelayRequest): Promise<void> {
  if (!PREFS.getAgentRelayEnabled()) return
  // No filter check: the filter governs whether a card is POSTED. Once one is
  // on the phone, retiring it is cleanup -- honouring the filter here would
  // strand exactly the cards a user muted mid-session.
  const device = pushableDevice()
  if (device.deviceId === null) return

  const jwt = await currentJwt()
  if (!jwt) return

  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), CONFIG.AGENT_RELAY.PUSH_TIMEOUT_MS)
  try {
    await fetch(`${CONFIG.BILLING.EDGE_FUNCTION_URL}/${CONFIG.AGENT_RELAY.PUSH_FN}`, {
      method: 'POST',
      signal: abort.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({
        deviceToken: device.pushToken,
        requestId: request.id,
        verb: request.verb,
        clear: true,
        bundleId: CONFIG.AGENT_RELAY.IOS_BUNDLE_ID
      })
    })
    devLog.log('[agent-relay] clear push sent', { id: request.id, status: request.status })
  } catch {
    // See above: a phone that never got the card, or is offline, is the normal
    // case. iOS also drops the notification itself when the app next launches.
  } finally {
    clearTimeout(timer)
  }
}

/** Same generic-title-per-verb posture as the Edge function's own fallback --
 *  content-free even before it leaves the Mac (§5 item 2: never let a
 *  question's text ride the push payload). */
function titleFor(request: RelayRequest): string | undefined {
  if (request.verb === 'notify' && request.params.title) {
    return request.params.title.slice(0, 120)
  }
  return undefined
}

/** Every verb's content rides the push: the NSE's
 *  tunnel fetch failed often enough that ask/approve/show arrived as a bare
 *  title with no message. The NSE still overwrites with the fetched card when
 *  it works; this is the fallback iOS shows when it doesn't. */
function bodyFor(request: RelayRequest): string | undefined {
  const p = request.params
  const content =
    request.verb === 'notify'
      ? // An idle ping carries no news, so its body was a bare prompt for the
        // next instruction. `last` is the recap that makes the banner say where
        // the session left off; a stated body still outranks it.
        (p.body ?? (p.idle ? p.last : undefined))
      : request.verb === 'ask'
        ? p.question
        : request.verb === 'approve'
          ? [p.action, p.detail].filter(Boolean).join(' — ')
          : p.caption
  if (!content) return undefined
  // The lock screen's buttons answer question 1 only, so a push that doesn't
  // say so makes one tap look like the whole thing is done.
  const suffix = interviewPushSuffix(p.questions, request.buffered)
  const full = suffix ? `${content} ${suffix}` : content
  return full.slice(0, 300)
}
