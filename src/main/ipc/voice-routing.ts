// voice-routing.ts — IPC for the "where should this go?" card.
//
// Holds the in-flight route (the ranked sinks plus the transcript) because the
// card sends back a sink ID and nothing else: the transcript must never make a
// round-trip through a renderer just to come back for pasting.
import { clipboard, ipcMain } from 'electron'
import { homedir } from 'os'
import { CHANNELS } from '../../shared/ipc'
import { expireProposals } from '../actions/engine'
import type { AgentHarness, VoiceRoutePickPayload, VoiceRoutingMode } from '../../shared/types'
import type { DeliverResult } from '../voice-routing/deliver'
import {
  closeVoiceRouteCard,
  moveVoiceRouteCard,
  sendVoiceRouteEnhanced,
  sendVoiceRouteResult,
  setVoiceRouteAbandonListener,
  setVoiceRouteHeight,
  setVoiceRouteSearchFocus,
  setVoiceRouteWidth,
  voiceRouteRunId,
  voiceRouteSearchActive
} from '../voice-route-window'
import { deliverToSink } from '../voice-routing/deliver'
import { pasteText, context } from '../platform'
import { PREFS } from '../store/prefs'
import { appendRoutingOutcome } from '../voice-routing/routing-log'
import type { DesktopSink } from '../voice-routing/sinks'
import { deliverToAgent, goToAgent } from '../voice-routing/deliver-helper'
import type { AgentSink } from '../voice-routing/agent-sinks'
import {
  defaultCodeUiHarness,
  projectRootFor,
  startNewAgent,
  type NewAgentFailure,
  type NewAgentSink
} from '../voice-routing/new-agent-sink'
import { agentMessageBody } from '../../shared/attachments'
import { retryFailedRoute, routeHeldTranscript, routeHistoryText } from '../voice-routing/offer'
import { HISTORY } from '../store/history'
import type { HelperSink } from '../voice-routing/route-voice'
import { showAgentInCodeTab, takeAgentForCodeTab } from '../mighty/mighty-window'
import { CONFIG } from '../../shared/config'
import { recordOpeningTurn } from './phone-remote-chat'
import type { StartedAgent } from '../../shared/types'
import { chosenText, chosenVariantLabel, enhanceRoute, variantText } from '../voice-routing/enhance'
import type { EnhanceDestination, EnhanceInput } from '../voice-routing/enhance-prompt'

interface PendingRoute {
  runId: string
  transcript: string
  sinks: DesktopSink[]
  /** The second column's destinations, carried for the same reason as `sinks`:
   *  the card sends back an id and nothing else. */
  helpers: HelperSink[]
  suggestedSinkId: string
  suggestedHelperId: string
  /** Screenshot to send along with the transcript, '' when there is none. */
  screenshotPath: string
  /** What was on screen, prepended to a skill's or agent's text so a dictated
   *  "update this UI" names the page it meant. '' when there was nothing to
   *  say. Apps never get it — a paste stays the verbatim transcript. */
  screenHeader: string
  /** Don't paste the transcript when this card is dismissed without a pick.
   *  Two reasons reach here: hover mode already pasted it before the card
   *  opened, and Option means the user chose to route rather than paste. */
  skipReleasePaste: boolean
  submitNow: boolean
}

let pending: PendingRoute | null = null

// Must be >= the 30 rows panel.ts hands the history list, or a visible row routes nothing.
const HISTORY_ROUTE_ROWS = 30

/** Where the last delivery landed, kept AFTER `pending` is cleared so the
 *  result card's "Go to it" button has something to open. One slot, not a list:
 *  only the card currently on screen can be acted on, and the next send
 *  replaces it. */
interface Landing {
  runId: string
  /** The session this send started, null for every other kind. */
  started: StartedAgent | null
  name: string
  where: string
  /** The running agent the text went to, when it already existed. */
  agent: AgentSink | null
  kind: 'new-agent' | 'agent' | 'skill' | 'app'
  /** Bundle id, for an app destination. */
  bundleId: string
}

let landed: Landing | null = null

/** Whether a landing is somewhere we can actually take the user. */
function canOpen(l: Landing | null): boolean {
  if (!l) return false
  if (l.kind === 'agent') return l.agent !== null
  return l.started !== null
}

// A skill has no project of its own, so it runs where the user last worked.
function skillHome(route: PendingRoute): NewAgentSink {
  const recent = route.helpers.find((h): h is NewAgentSink => h.kind === 'new-agent')
  if (recent) return recent
  return { kind: 'new-agent', id: '', label: '', description: '', project: 'Home', cwd: homedir(), hostBundleId: '' }
}

function skillPrompt(skill: string, said: string, harness: AgentHarness | undefined): string {
  return (harness ?? defaultCodeUiHarness()) === 'claude' ? `/${skill} ${said}` : `Use the ${skill} skill. ${said}`
}

export function setPendingRoute(route: PendingRoute | null): void {
  // A second recording replaces the first card. The route being displaced was
  // never delivered and its transcript is no longer on the clipboard (the new
  // recording overwrote it), so paste it the normal way before it is dropped —
  // otherwise the first dictation lands nowhere and looks like it failed.
  if (pending && (!route || route.runId !== pending.runId)) releasePendingRoute(pending.runId)
  pending = route
}

/**
 * Hand the transcript back to the plain paste when the card ends without a
 * pick. capture/index.ts skips its auto-paste the moment the card is SHOWN, so
 * without this the user dictates, ignores the card, and the words land nowhere
 * — which looks exactly like dictation failing. Every path that retires a card
 * without delivering goes through here.
 */
export function releasePendingRoute(runId: string): void {
  expireProposals(runId)
  const route = pending
  if (!route || route.runId !== runId) return
  pending = null
  if (route.skipReleasePaste) return
  if (!PREFS.getListenAutoPaste()) return
  pasteText(route.transcript).catch((err) =>
    console.error('voice-routing: fallback paste failed:', err)
  )
}

export function dismissVoiceRoute(runId: string): void {
  releasePendingRoute(runId)
  closeVoiceRouteCard()
}

export function markRouteDelivered(runId: string): void {
  if (pending?.runId === runId) pending = null
}

/** Start a fresh agent and hand it the transcript as its first instruction.
 *  Shaped to the same DeliverResult the other three paths return, so the pick
 *  handler's outcome logging and toast need no special case. A new session has
 *  no prompt box left sitting for the user, so a successful spawn is submitted. */
function startNewAgentFor(
  sink: NewAgentSink,
  route: PendingRoute,
  payload: VoiceRoutePickPayload
): Promise<DeliverResult> {
  const files = route.screenshotPath === '' ? [] : [route.screenshotPath]
  const text = agentMessageBody(files, route.screenHeader + route.transcript)
  // A plain row click sends no harness. Default to the first one that is
  // actually installed rather than a hardcoded 'claude', which on a Mac without
  // it spawned nothing and logged a warning the user never sees.
  const harness = payload.harness ?? defaultCodeUiHarness()
  if (!harness) {
    return Promise.resolve({
      ok: false,
      submitted: false,
      reason: 'Install Claude Code or Codex to start a session here.'
    })
  }
  const name = `a new ${HARNESS_NAME[harness]} session in ${sink.project}`
  if (landed?.runId === route.runId) landed = { ...landed, name }
  const since = Date.now()
  return projectRootFor(sink.cwd).then(async (cwd) => {
    const result = await startNewAgent({ ...sink, cwd }, text, harness, { reveal: false })
    if (!result.ok) return { ok: false, submitted: false, reason: reasonText(result, harness) }
    recordOpeningTurn({ pane: result.pane, cwd }, route.transcript, files)
    const started: StartedAgent = { cwd, project: sink.project, pane: result.pane, message: route.transcript, files, since }
    if (landed?.runId === route.runId) landed = { ...landed, started, where: IN_APP_WHERE }
    return { ok: true, submitted: true }
  })
}

const IN_APP_WHERE = `It's open in ${CONFIG.APP_NAME}, under Code.`

const HARNESS_NAME: Record<AgentHarness, string> = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', cursor: 'Cursor', tmux: 'shell' }

/** The failure in words the user can act on. Never the raw cause: "cli-missing"
 *  names our enum, not the thing they need to install. */
function reasonText(result: { reason: NewAgentFailure; detail: string }, harness: string): string {
  if (result.reason === 'cli-missing') return `${result.detail || harness} isn't installed`
  if (result.reason === 'no-terminal') return 'no terminal to open it in'
  return "the terminal didn't start"
}

function pickRoute(payload: VoiceRoutePickPayload): void {
  const route = pending
  if (!route || route.runId !== payload.runId) return
  const sink = route.sinks.find((s) => s.id === payload.sinkId)
  const helper = sink ? undefined : route.helpers.find((h) => h.id === payload.sinkId)
  if (!sink && !helper) return

  // Clear first: delivery is async and the card must not accept a second pick
  // while the first one is still activating apps.
  pending = null
  const said = chosenText(route.runId, route.transcript)

  // Remember the destination so the result card can offer to open it. Set
  // BEFORE delivery because the new-agent branch fills in its pane id as it
  // resolves, and that write needs a record to attach to.
  landed = {
    runId: route.runId,
    started: null,
    name: '',
    where: '',
    agent: helper && helper.kind === 'agent' ? helper : null,
    kind: sink ? 'app' : (helper!.kind as Landing['kind']),
    bundleId: sink ? sink.bundleId : ''
  }

  // A skill or an agent doesn't paste into an app, so the submit flag never
  // reaches it. 'goto' raises an existing agent's session, see deliver-helper.ts.
  const delivery = sink
    ? deliverToSink(said, sink, payload.mode, payload.submit)
    : helper!.kind === 'skill'
      ? startNewAgentFor(
          skillHome(route),
          { ...route, transcript: skillPrompt(helper!.skillName, said, payload.harness) },
          payload
        )
      : helper!.kind === 'new-agent'
        ? startNewAgentFor(helper! as NewAgentSink, { ...route, transcript: said }, payload)
        : deliverToAgent(
            route.screenHeader,
            said,
            helper!,
            payload.mode,
            route.screenshotPath
          )
  const chosenId = sink ? sink.id : helper!.id
  const shownName = sink ? sink.appName : helper!.label

  void delivery.then((result) => {
    const isNewAgent = helper?.kind === 'new-agent'
    const startsSession = isNewAgent || helper?.kind === 'skill'
    if (!result.ok && isNewAgent && !pending) pending = route
    appendRoutingOutcome({
      runId: route.runId,
      chosenSinkId: chosenId,
      overrode: chosenId !== route.suggestedSinkId && chosenId !== route.suggestedHelperId,
      mode: payload.mode,
      submitted: result.submitted,
      via: payload.query === undefined ? 'row' : 'search',
      query: payload.query ?? '',
      variant: chosenVariantLabel(route.runId) || undefined
    })
    sendVoiceRouteResult({
      runId: route.runId,
      sinkId: chosenId,
      ok: result.ok,
      submitted: result.submitted,
      appName: (isNewAgent && landed?.runId === route.runId && landed.name) || shownName,
      // Only somewhere there is actually something to open, and only when the
      // send worked. 'goto' already took the user there, so offering a second
      // trip would be noise. An app is excluded for the same reason a paste
      // needs no button: you watched it land.
      canGo: result.ok && (payload.mode !== 'goto' || startsSession) && canOpen(landed),
      canPickAgain: !result.ok && isNewAgent && pending?.runId === route.runId,
      where: startsSession && result.ok && landed?.runId === route.runId ? landed.where : '',
      reason: result.reason ?? ''
    })
  })
}

export function sendSuggestedRoute(): boolean {
  const route = pending
  if (!route || voiceRouteRunId() !== route.runId || voiceRouteSearchActive()) return false
  const sinkId = route.helpers.length > 0 ? route.suggestedHelperId : route.suggestedSinkId
  if (sinkId === '') return false
  pickRoute({ runId: route.runId, sinkId, mode: 'paste', submit: route.submitNow })
  return true
}

function enhanceDestination(route: PendingRoute, sinkId: string): EnhanceDestination {
  const pickedId = sinkId || route.suggestedHelperId || route.suggestedSinkId || route.helpers[0]?.id
  const helper = route.helpers.find((h) => h.id === pickedId)
  if (helper?.kind === 'agent') return { kind: 'agent', project: helper.project, branch: helper.branch, task: helper.session.tldr }
  if (helper?.kind === 'new-agent') return { kind: 'new-agent', project: helper.project }
  if (helper?.kind === 'skill') return { kind: 'skill', name: helper.skillName, description: helper.description }
  const sink = route.sinks.find((s) => s.id === pickedId)
  return { kind: 'app', name: sink?.appName || 'the app they were using' }
}

function enhancePending(runId: string, sinkId: string, select?: number): boolean {
  const route = pending
  if (!route || route.runId !== runId) return false
  const input = (): EnhanceInput => ({
    transcript: route.transcript,
    destination: enhanceDestination(route, sinkId),
    screenHeader: route.screenHeader
  })
  enhanceRoute(route.runId, input, sendVoiceRouteEnhanced, select)
  return true
}

function copyEnhanceRow(runId: string, index: number): void {
  const route = pending
  if (!route || route.runId !== runId) return
  clipboard.writeText(variantText(runId, index, route.transcript))
  expireProposals(runId)
  pending = null
  closeVoiceRouteCard()
}

export function enhanceSuggestedRoute(): boolean {
  const route = pending
  if (!route || voiceRouteRunId() !== route.runId || voiceRouteSearchActive()) return false
  return enhancePending(route.runId, '')
}

export function registerVoiceRoutingHandlers(): void {
  setVoiceRouteAbandonListener(releasePendingRoute)

  ipcMain.handle(CHANNELS.voiceRoutingConfigGet, () => ({
    mode: PREFS.getVoiceRoutingMode(),
    offerGoTo: PREFS.getVoiceRoutingGoTo(),
    showSkills: PREFS.getVoiceRoutingSkills(),
    showAgents: PREFS.getVoiceRoutingAgents()
  }))

  ipcMain.handle(
    CHANNELS.voiceRoutingConfigSet,
    (
      _,
      patch: {
        mode?: VoiceRoutingMode
        offerGoTo?: boolean
        showSkills?: boolean
        showAgents?: boolean
      }
    ) => {
      if (patch.mode !== undefined) PREFS.setVoiceRoutingMode(patch.mode)
      if (patch.offerGoTo !== undefined) PREFS.setVoiceRoutingGoTo(patch.offerGoTo)
      if (patch.showSkills !== undefined) PREFS.setVoiceRoutingSkills(patch.showSkills)
      if (patch.showAgents !== undefined) PREFS.setVoiceRoutingAgents(patch.showAgents)
    }
  )

  // The HUD asking for the ranking it deliberately skipped. Ranking takes a
  // second or two, so the card shows its own spinner and this only reports
  // whether a card ever appeared.
  ipcMain.handle(CHANNELS.voiceRouteFromHud, async (_, payload: { runId: string }) =>
    routeHeldTranscript(payload.runId)
  )

  ipcMain.handle(CHANNELS.voiceRouteFromHistory, async (_, payload: { runId: string }) => {
    const row = HISTORY.readRecent(HISTORY_ROUTE_ROWS).find((r) => r.run_id === payload.runId)
    return row ? routeHistoryText(row.instruction) : false
  })

  ipcMain.handle(CHANNELS.codeTakeStartedAgent, takeAgentForCodeTab)

  ipcMain.on(CHANNELS.voiceRouteRetry, (_, payload: { runId: string }) => {
    void retryFailedRoute(payload.runId)
  })

  ipcMain.on(
    CHANNELS.voiceRouteEnhance,
    (_, payload: { runId: string; sinkId: string; select?: number; copy?: boolean }) => {
      if (payload.copy) copyEnhanceRow(payload.runId, payload.select ?? -1)
      else enhancePending(payload.runId, payload.sinkId, payload.select)
    }
  )

  ipcMain.on(CHANNELS.voiceRoutePick, (_, payload: VoiceRoutePickPayload) => pickRoute(payload))

  // Raise a destination WITHOUT delivering. Deliberately does not clear
  // `pending`: the transcript is still undelivered and the card is still up, so
  // this is a way to look at an agent before deciding where the text goes —
  // walking between sessions, not a second kind of send. A new-agent row has no
  // window to raise yet, so it is simply not offered one in the card.
  ipcMain.on(CHANNELS.voiceRouteGo, (_, payload: { runId: string; sinkId: string }) => {
    const route = pending
    // After a send there is no `pending` any more, but there IS a landing — the
    // result card's "Go to it" comes through here with an empty sinkId. This is
    // the same button either side of the send: before it, a look at a candidate;
    // after it, the trip to where the words actually went.
    if (!route && payload.sinkId === '' && landed?.runId === payload.runId) {
      const l = landed
      if (l.started) showAgentInCodeTab(l.started)
      else if (l.kind === 'agent' && l.agent) void goToAgent(l.agent)
      return
    }
    if (!route || route.runId !== payload.runId) return

    const sink = route.sinks.find((s) => s.id === payload.sinkId)
    if (sink) {
      context.activateApp(sink.bundleId)
      return
    }

    const helper = route.helpers.find((h) => h.id === payload.sinkId)
    if (!helper) return
    if (helper.kind === 'agent') void goToAgent(helper)
  })

  ipcMain.on(CHANNELS.voiceRouteDismiss, (_, payload: { runId: string }) => {
    dismissVoiceRoute(payload.runId)
  })

  ipcMain.on(CHANNELS.voiceRouteSearchFocus, (_, payload: { runId: string; on: boolean }) => {
    setVoiceRouteSearchFocus(payload.runId, payload.on)
  })

  ipcMain.on(CHANNELS.voiceRouteResize, (_, payload: { runId: string; height: number }) => {
    setVoiceRouteHeight(payload.runId, payload.height)
  })

  ipcMain.on(CHANNELS.voiceRouteWidth, (_, payload: { runId: string; width: number }) => {
    setVoiceRouteWidth(payload.runId, payload.width)
  })

  ipcMain.on(CHANNELS.voiceRouteMove, (_, payload: { runId: string; dx: number; dy: number }) => {
    moveVoiceRouteCard(payload.runId, payload.dx, payload.dy)
  })
}
