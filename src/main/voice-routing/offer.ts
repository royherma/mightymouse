// offer.ts — the one function the capture path calls.
//
// Kept apart from route-voice.ts so the capture path imports a single boolean
// promise and knows nothing about sinks, Jev or card windows. Returns TRUE only
// when the routing card actually took responsibility for delivering the text;
// every other outcome returns false and the caller's normal paste runs.
import { randomUUID } from 'crypto'
import { basename } from 'path'
import {
  closeVoiceRouteCard,
  openVoiceRouteCard,
  sendActionCard,
  sendVoiceRouteResult,
  showVoiceRouteCard
} from '../voice-route-window'
import { setPendingRoute } from '../ipc/voice-routing'
import { routeVoiceNote } from './route-voice'
import { screenshotThumb } from './screenshot-attach'
import type { RankedHelper } from './route-voice'
import { proposeActions, expireProposals } from '../actions/engine'
import { takeDecideFailure } from '../actions/decide-transport'
import { CONFIG } from '../../shared/config'
import { PREFS } from '../store/prefs'
import { devLog } from '../../shared/env'

/** First line of the transcript, for the card's "routing this" line. */
function previewOf(transcript: string): string {
  const firstLine = transcript.trim().split('\n')[0] ?? ''
  return firstLine.length > 90 ? `${firstLine.slice(0, 89)}…` : firstLine
}

/** Band titles the skeleton draws, in the order VoiceRouteApp stacks them. Read
 *  from the same two toggles route-voice.ts branches on, so the placeholder has
 *  the shape the real answer will have and the card does not re-lay-out when the
 *  rows land. Titles must match the ones VoiceRouteApp builds its columns with. */
function pendingBands(): string[] {
  const bands: string[] = []
  if (PREFS.getVoiceRoutingSkills()) bands.push('Skills')
  if (PREFS.getVoiceRoutingAgents()) bands.push('Agents', 'New agent')
  return bands.length > 0 ? bands : ['Apps']
}

/** In 'hover' mode the transcript waits here instead of being ranked, until the
 *  user hovers the HUD card and clicks "voice route". Only ever one: a second
 *  recording's transcript replaces the first, and the first was already pasted
 *  normally (hover mode never suppresses the paste), so nothing is lost. */
let held: { runId: string; transcript: string } | null = null

/** True when this runId still has a transcript waiting for a hover click. */
export function heldTranscript(runId: string): string {
  return held && held.runId === runId ? held.transcript : ''
}

export function holdForHover(runId: string, transcript: string): void {
  held = { runId, transcript }
}

/**
 * Rank the held transcript NOW and show the card, because the user asked for it
 * from the HUD. Returns false when there was nothing held or the ranking failed
 * — the transcript is on the clipboard and was already pasted either way, so a
 * failure here costs the user nothing beyond the card not appearing.
 */
export async function routeHeldTranscript(runId: string): Promise<boolean> {
  const transcript = heldTranscript(runId)
  if (transcript === '') return false
  held = null
  // Hover mode already pasted this transcript the normal way, so the card must
  // not paste it again if the user walks away from it.
  return showRouteFor(runId, transcript, true)
}

export async function offerVoiceRoute(
  runId: string,
  transcript: string,
  routeNow = false,
  submitNow = false
): Promise<boolean> {
  // Hover mode: rank nothing, suppress nothing. The normal auto-paste runs and
  // the card is only built if the user asks for it, so a dictation they never
  // hover costs zero Jev calls and zero window scans.
  if (PREFS.getVoiceRoutingMode() === 'hover' && !routeNow) {
    holdForHover(runId, transcript)
    return false
  }
  // Shift (routeNow) is the user saying "I'll pick where this goes". Walking away
  // from that card must leave the words nowhere rather than dropping them into
  // whatever app happened to be in front — the paste is what they pressed Shift
  // to avoid. The transcript stays on the clipboard either way.
  return showRouteFor(runId, transcript, routeNow, false, submitNow)
}

let failed: { runId: string; transcript: string; fromHistory: boolean } | null = null

// skipReleasePaste: the caller already pasted the words, so a dismissed card must not repeat it.
export async function retryFailedRoute(runId: string): Promise<boolean> {
  if (!failed || failed.runId !== runId) return false
  const { transcript, fromHistory } = failed
  failed = null
  return showRouteFor(runId, transcript, true, fromHistory)
}

export async function routeHistoryText(text: string): Promise<boolean> {
  if (text.trim() === '') return false
  return showRouteFor(randomUUID(), text, true, true)
}

async function showRouteFor(
  runId: string,
  transcript: string,
  skipReleasePaste = false,
  fromHistory = false,
  forceSubmit = false
): Promise<boolean> {
  // Up BEFORE the ranking, not after it: routeVoiceNote takes 1-3s, and that
  // used to be spent with nothing on screen, so the click read as a no-op. The
  // card opens holding the words and a skeleton of the bands it is about to
  // fill, then the real rows replace them below.
  openVoiceRouteCard({ runId, preview: previewOf(transcript), bands: pendingBands() })
  try {
    const route = await routeVoiceNote(runId, transcript, fromHistory)
    console.log(
      `[actions] ${runId} card=${route?.actionCard ? route.actionCard.proposals.length + ' proposals' : 'none'} ranked=${route?.ranked.length ?? 0} helpers=${route?.rankedHelpers.length ?? 0}`
    )
    if (route?.actionCard) sendActionCard(route.actionCard)
    // EITHER list is enough to be worth showing. Checking only `ranked` meant the
    // card never appeared once skills/agents replaced the apps, because that path
    // leaves `ranked` empty on purpose — see route-voice.ts. A command proposal
    // counts too: "turn the volume up" ranks no sink but is the point of the card,
    // and pasting those words into the front app is exactly the wrong outcome.
    if (!route || (route.ranked.length === 0 && route.rankedHelpers.length === 0)) {
      if (route?.actionCard?.isCommand) return true
      // A failed call is not the same as "nothing to suggest": closing on an
      // error made a broken ranking look identical to a working one with no
      // matches, so the card stays up and says what went wrong. Only when the
      // ranking itself never came back — a route that ranked nothing still
      // ranked, and showing an error over its rows is what broke clicking.
      const failure = route === null ? takeDecideFailure() : ''
      if (failure !== '') {
        sendVoiceRouteResult({
          runId,
          ok: false,
          submitted: false,
          appName: '',
          canGo: false,
          canRetry: true,
          reason: failure
        })
        failed = { runId, transcript, fromHistory }
        return false
      }
      // The skeleton is up and nothing is coming to replace it, so take it down
      // rather than leaving the user reading placeholder rows that never fill.
      closeVoiceRouteCard()
      return false
    }

    // collectSinks ran inside routeVoiceNote; re-reading here would cost a second
    // osascript. Instead the ranked list carries the full sink objects we need.
    setPendingRoute({
      runId,
      transcript,
      sinks: route.ranked.map((r) => r.sink),
      helpers: route.rankedHelpers.map((r) => r.sink),
      suggestedSinkId: route.suggestedSinkId,
      suggestedHelperId: route.suggestedHelperId,
      screenshotPath: route.screenshotPath,
      screenHeader: route.screenHeader,
      skipReleasePaste,
      submitNow: route.submitNow || forceSubmit
    })

    showVoiceRouteCard({
      runId,
      options: route.ranked.map((r) => ({
        sinkId: r.sink.id,
        label: r.sink.label,
        appName: r.sink.appName,
        percent: r.percent
      })),
      helperOptions: route.rankedHelpers.map((r) => ({
        sinkId: r.sink.id,
        label: r.sink.label,
        kind: r.sink.kind,
        description: r.sink.description,
        percent: r.percent,
        project: 'project' in r.sink ? r.sink.project : '',
        branch: 'branch' in r.sink ? r.sink.branch : '',
        cwd: r.sink.kind === 'agent' ? (r.sink.session.cwd ?? '') : 'cwd' in r.sink ? r.sink.cwd : '',
        activity: 'activity' in r.sink ? r.sink.activity : ''
      })),
      suggestedHelperId: route.suggestedHelperId,
      suggestedSinkId: route.suggestedSinkId,
      confident: route.confident,
      submitNow: route.submitNow || forceSubmit,
      offerGoTo: PREFS.getVoiceRoutingGoTo(),
      // Basename only: the card says WHICH shot is coming along without
      // printing the user's home directory across the screen.
      screenshotName: route.screenshotPath === '' ? '' : basename(route.screenshotPath),
      screenshotThumb: screenshotThumb(route.screenshotPath),
      preview: previewOf(transcript),
      picks: route.picks,
      latencyMs: route.latencyMs,
      // Resolved per card rather than once at startup: the user can install a
      // CLI while the app runs, and this costs a cached lookup.
      newAgentHost: await newAgentHostName(route.rankedHelpers),
      sent: {
        appName: route.screen?.appName ?? '',
        title: route.screen?.title ?? '',
        url: route.screen?.url ?? '',
        screenshotName: route.screenshotPath === '' ? '' : basename(route.screenshotPath),
        transcript
      }
    })
    return true
  } catch (err) {
    devLog.warn('[routing] offer failed, falling back to plain paste:', err)
    closeVoiceRouteCard()
    return false
  }
}

// Opens the card only AFTER the engine proposes something: unlike a dictation
// nobody asked for this one, so opening first would flash an empty panel.
export async function offerIdleActions(): Promise<boolean> {
  const runId = randomUUID()
  const card = await proposeActions(runId, 'idle', '')
  if (!card || card.proposals.length === 0) {
    expireProposals(runId)
    return false
  }
  openVoiceRouteCard({ runId, preview: '', bands: [] })
  sendActionCard(card)
  return true
}

async function newAgentHostName(helpers: readonly RankedHelper[]): Promise<string> {
  return helpers.some((h) => h.sink.kind === 'new-agent') ? CONFIG.APP_NAME : ''
}
