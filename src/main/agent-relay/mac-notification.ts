/**
 * The relay card as a native macOS notification -- the same buttons, reply box
 * and picture the iPhone gets, on the Mac, with no device build in the loop.
 *
 * WHY this exists: every iOS notification change costs a physical-device
 * install plus an APNs round trip, and the two surfaces that could already be
 * tested (the HUD card, `bin/mm-relay`) share no code with a *notification* --
 * they render React and print text. So the one thing that kept breaking, what
 * a notification actually shows and what its buttons do, had no fast loop at
 * all. This is that loop: `Notification.actions` is macOS's `UNNotificationAction`,
 * `hasReply` is its `UNTextInputNotificationAction`, and both resolve through
 * `relayRequestStore.resolve` -- the exact call the phone's `/relay-respond`
 * makes. A working notification here means the verb/store/resolve half works;
 * only the iOS category registration remains device-only.
 *
 * Answers race the phone deliberately: first answer wins (§6b), so replying on
 * the Mac while a push is in flight is a supported outcome, not a conflict.
 */

import { Notification } from 'electron'
import type { NotificationAction } from 'electron'
import { devLog } from '../../shared/env'
import { relayRequestStore } from './store'
import { sendPaneText } from './picker-keys'
import { resolveOrigin, isOriginResolvable } from './origin-resolver'
import { listedAgentSessions } from './mcp/http-listener'
import { interviewPushSuffix, isInterview } from '../../shared/relay-interview'
import type { RelayRequest } from './store'

/** The label that reaches the agent's pane from a card whose BODY cannot be
 *  clicked. `hasReply: true` makes macOS draw an alert, and on an alert the
 *  body is the reply affordance -- the 'click' event never fires at all, so a
 *  finished notify had no way through despite the handler being wired. This
 *  button is that way. Matches the HUD's "Go to <agent>" wording. */
const GO_TO_AGENT = 'Go to agent'

/** macOS renders at most two actions before collapsing the rest behind a
 *  "chevron", the same ceiling iOS has -- so `approve` spends both on the
 *  decision and lets a plain click be "open", exactly as the iOS category
 *  does. Kept in lockstep with `RelayNotificationCategory.all` in ios/. */
function actionsFor(request: RelayRequest): NotificationAction[] {
  switch (request.verb) {
    case 'approve':
      return [
        { type: 'button', text: 'Approve' },
        { type: 'button', text: "Don't" }
      ]
    case 'ask':
      // Chips only when the agent offered them: an `ask` with no options is
      // answered by the reply box instead, and a bare "Answer" button that
      // opens nothing would be a dead control. An interview offers neither --
      // every control here answers question 1 and cannot reach question 2, so
      // the HUD card next to it is the only honest way in.
      if (isInterview(request.params.questions)) return []
      return (request.params.options ?? [])
        .slice(0, 2)
        .map((text) => ({ type: 'button' as const, text }))
    default:
      // A notify spends neither slot on answering, so the one that reaches the
      // agent is free -- and on a reply-style card it is the ONLY way there.
      return isOriginResolvable(request.params.origin)
        ? [{ type: 'button', text: GO_TO_AGENT }]
        : []
  }
}

/** `ask` takes free text, and so does a FINISHED `notify` -- the card announcing
 *  a turn ended is the one a person answers with the next instruction. `approve`
 *  is a two-way decision by definition, and a reply box on it would offer a third
 *  answer the agent cannot receive.
 *
 *  The two go to opposite places (see the 'reply' handler): an ask RESOLVES a
 *  waiting request, a notify TYPES into the pane. Same rule as the phone's
 *  `notifyReply` category (ios NotificationService `resolveCategory`) -- these
 *  are two implementations of one product decision, so they must move together. */
function wantsReply(request: RelayRequest): boolean {
  if (request.verb === 'notify') return isFinishedNotify(request)
  return request.verb === 'ask' && !isInterview(request.params.questions)
}

/** Finished = not mid-progress, or an idle turn-end ping. A `progress` notify
 *  has nothing to reply to yet, so it stays a plain card. */
function isFinishedNotify(request: RelayRequest): boolean {
  return request.params.state !== 'progress' || request.params.idle === true
}

function titleFor(request: RelayRequest): string {
  switch (request.verb) {
    case 'ask':
      return 'Your agent needs an answer'
    case 'approve':
      return request.params.risk === 'high' ? 'Approval needed' : 'Approval needed'
    case 'show':
      return 'Your agent sent you something'
    default:
      return request.params.title ?? 'Your agent has an update'
  }
}

function bodyFor(request: RelayRequest): string {
  const body =
    request.params.question ??
    request.params.action ??
    request.params.caption ??
    request.params.body ??
    // Same idle gap the push had: no news of its own, so the recap is the only
    // thing that can say where the session left off.
    (request.params.idle ? request.params.last : undefined) ??
    ''
  // A multi-question ask says so here: the buttons answer question 1 only, and
  // without the count a tap looks like it finished the whole thing.
  const suffix = interviewPushSuffix(request.params.questions, request.buffered)
  return suffix ? `${body}\n${suffix}` : body
}

/** The one destination a card can send you to, shared by the body click and the
 *  "Go to agent" button. Always lands somewhere: an unresolvable origin (or a
 *  resolve where every strategy missed) opens the deck rather than no-opping,
 *  which is what reads as a broken notification. */
function goToOrigin(requestId: string, origin: RelayRequest['params']['origin']): void {
  if (!isOriginResolvable(origin)) {
    devLog.log('[agent-relay] mac notification -> deck (origin unresolvable)', { requestId })
    openDeck(requestId)
    return
  }
  void resolveOrigin(origin).then((via) => {
    devLog.log('[agent-relay] mac notification -> origin', { requestId, via })
    if (via === 'none') openDeck(requestId)
  })
}

/** Lazy on purpose: a static import pulls BrowserWindow into every module that
 *  imports this one, and the deck is only needed on the fallback path. */
function openDeck(requestId: string): void {
  void import('../deck-window').then(({ showDeckWindow }) => {
    devLog.log('[agent-relay] mac notification click -> deck', { requestId })
    showDeckWindow()
  })
}

/**
 * Shows one relay request as a macOS notification. Returns false when the
 * platform can't display one, so the caller can say so rather than reporting a
 * silent success -- a notification that never appeared is the failure mode this
 * whole module exists to make visible.
 */
export function showMacRelayNotification(request: RelayRequest): boolean {
  if (!Notification.isSupported()) {
    devLog.warn('[agent-relay] mac notification unsupported')
    return false
  }

  const actions = actionsFor(request)
  const notification = new Notification({
    title: titleFor(request),
    subtitle: request.params.from,
    body: bodyFor(request),
    // The picture rides the card itself, so "does this look right?" is decided
    // in the notification instead of sending the user off to find an image.
    // Same widened gate as the phone: any verb may carry one, not just `show`.
    icon: request.params.imagePath,
    hasReply: wantsReply(request),
    replyPlaceholder: 'Type your answer',
    actions,
    // Without this macOS collapses the actions behind a hover-only chevron, so
    // the buttons exist but are invisible until the pointer lands -- which
    // reads exactly like the buttons never rendered.
    closeButtonText: 'Dismiss'
  })

  // `bodyClickable` is the field that would have made the alert-vs-banner bug
  // obvious on sight: macOS turns a hasReply card into an ALERT, and an alert's
  // body is the reply box, so 'click' never fires there. Logging the derived
  // fact rather than just hasReply means a dead card is visible in one line
  // instead of inferred from a missing one. `reachesOrigin` is the companion:
  // together they answer "could the user get to the agent from this card at
  // all?", which is the whole question this module keeps getting wrong.
  const bodyClickable = !wantsReply(request)
  const reachesOrigin = bodyClickable || actions.some((a) => a.text === GO_TO_AGENT)
  devLog.log('[agent-relay] mac notification shown', {
    requestId: request.id,
    verb: request.verb,
    actions: actions.map((a) => a.text),
    hasReply: wantsReply(request),
    bodyClickable,
    reachesOrigin,
    originResolvable: isOriginResolvable(request.params.origin),
    hasImage: Boolean(request.params.imagePath)
  })
  // Loud, because it is always a product bug: the card is on screen and there
  // is no way from it to the agent. Cheaper to see here than to reproduce.
  if (!reachesOrigin) {
    devLog.warn('[agent-relay] mac notification has NO route to the agent', {
      requestId: request.id,
      verb: request.verb,
      why: isOriginResolvable(request.params.origin) ? 'no button offered' : 'origin unresolvable'
    })
  }

  notification.on('reply', (_event, reply) => {
    // A settled notify has nothing left to resolve, so routing it through
    // `resolve` would return 'already-resolved' every time and drop the text.
    // It goes to the pane instead -- the same split the phone makes between its
    // `answer` and `reply` fields (server.ts handleRelayRespond).
    if (request.verb === 'notify') {
      // The pid rides the SESSION, not the request -- and it is what makes the
      // non-tmux fallback reachable at all (sendPaneText returns 'skipped' for
      // an undefined pid). Matched on the pane so a reaped session cannot type
      // into whatever owns that pane now, same gate as agentRelaySessionReply.
      const pane = request.params.origin?.tmuxPane
      const session = pane
        ? listedAgentSessions().find((s) => s.origin?.tmuxPane === pane)
        : undefined
      void sendPaneText(request.params.origin, reply, session?.facts?.pid).then((via) => {
        devLog.log('[agent-relay] mac notification reply typed', {
          requestId: request.id,
          length: reply.length,
          via
        })
      })
      return
    }
    // Log the outcome, not just the arrival: `resolve` returning
    // 'already-resolved' is the difference between "your answer was dropped"
    // and "the phone beat you to it", and those need opposite fixes.
    const outcome = relayRequestStore.resolve(request.id, { answer: reply }, null, 'typed')
    devLog.log('[agent-relay] mac notification reply', {
      requestId: request.id,
      length: reply.length,
      empty: reply.trim() === '',
      outcome
    })
  })

  notification.on('action', (_event, index) => {
    const chosen = actions[index]?.text
    if (!chosen) {
      devLog.warn('[agent-relay] mac notification action out of range', {
        requestId: request.id,
        index,
        actions: actions.length
      })
      return
    }
    // Reaches the pane instead of answering: routing this through `resolve`
    // would settle the request with the literal string "Go to agent".
    if (chosen === GO_TO_AGENT) {
      devLog.log('[agent-relay] mac notification action -> origin', { requestId: request.id })
      goToOrigin(request.id, request.params.origin)
      return
    }
    const outcome =
      request.verb === 'approve'
        ? relayRequestStore.resolve(request.id, { approved: chosen === 'Approve' }, null, 'chip')
        : relayRequestStore.resolve(request.id, { answer: chosen }, null, 'chip')
    devLog.log('[agent-relay] mac notification action', {
      requestId: request.id,
      chosen,
      outcome
    })
  })

  // The three events that previously left NO trace. A typed answer that lands
  // on `close` instead of `reply` is invisible in both the audit log (nothing
  // resolves) and here -- which is exactly the "it looked like it cancelled"
  // report this instrumentation exists to decide.
  notification.on('close', () => {
    devLog.log('[agent-relay] mac notification closed', {
      requestId: request.id,
      status: relayRequestStore.get(request.id)?.status ?? 'gone'
    })
  })

  // A click is "take me there", the same promise the HUD's "Go to <agent>"
  // button makes and the same one an iOS tap makes -- so it resolves the SAME
  // origin rather than inventing a third destination. Re-read from the store
  // instead of closing over request.params.origin: a session can move panes
  // while the card sits in Notification Center.
  notification.on('click', () => {
    const live = relayRequestStore.get(request.id)
    const origin = live?.params.origin ?? request.params.origin
    devLog.log('[agent-relay] mac notification clicked', {
      requestId: request.id,
      status: live?.status ?? 'gone'
    })
    goToOrigin(request.id, origin)
  })

  notification.on('failed', (_event, error) => {
    devLog.warn('[agent-relay] mac notification failed', { requestId: request.id, error })
  })

  notification.show()
  return true
}
