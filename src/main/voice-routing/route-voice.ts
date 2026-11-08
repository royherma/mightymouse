// route-voice.ts — the entry point the capture path calls when a recording ends.
//
// Flow: collect the open apps -> ask Jev which one this belongs in -> show the
// ranked card -> deliver whatever the user picks. Every step can fail, and every
// failure falls back to the behaviour that shipped before this feature: the
// transcript is already on the clipboard and (unless routing took over) already
// pasted, so the worst case is the user pastes it themselves.
import { PREFS } from '../store/prefs'
import { MIGHTY } from '../store/mighty'
import { appendRoutingDecision, recentPickCounts } from './routing-log'
import { collectSinks, type DesktopSink } from './sinks'
import { rankSinks, JEV_CONFIDENCE_FLOOR, type JevRanking, type JevSink } from './jev-client'
import { collectAgentSinks, type AgentSink } from './agent-sinks'
import { collectNewAgentSinks, type NewAgentSink } from './new-agent-sink'
import { collectSkillSinks, type SkillSink } from './skill-sinks'
import { findLastScreenshot } from './screenshot-attach'
import { readScreenContext, forRanking, forDelivery, type ScreenContext } from './screen-context'
import { findPageOwner, type PageOwner } from './page-owner'
import { devLog } from '../../shared/env'
import { warmJev, canDecide } from '../actions/decide-transport'
import { prepareActions, resolveActions } from '../actions/engine'
import type { ActionCardPayload } from '../../shared/action-engine'

export interface RankedSink {
  sink: DesktopSink
  /** 0-100, already rounded for display. */
  percent: number
}

/** A second-column destination: a skill to run, an agent to hand this to, or a
 *  brand-new agent to start for it. */
export type HelperSink = SkillSink | AgentSink | NewAgentSink

export interface RankedHelper {
  sink: HelperSink
  percent: number
}

export interface VoiceRoute {
  runId: string
  transcript: string
  ranked: RankedSink[]
  /** Skills and agents, already ranked. Empty when both toggles are off. When
   *  this is non-empty `ranked` is empty: the two are alternatives, not columns
   *  shown side by side. */
  rankedHelpers: RankedHelper[]
  /** Jev's pick in the second column, or '' when it had none. */
  suggestedHelperId: string
  /** The sink Jev picked, or '' when it was too unsure to pre-select one. */
  suggestedSinkId: string
  confidence: number
  submitNow: boolean
  /** True when confidence cleared the floor. Below it the card still shows the
   *  ranking, but nothing is pre-selected and Enter does not fire. */
  confident: boolean
  /** Absolute path of the screenshot to send with the transcript, or '' when
   *  the text didn't refer to one (or none was recent enough to attach). */
  screenshotPath: string
  /** What was on screen when the recording started, as the header to prepend to
   *  a skill's or agent's text. '' when there was nothing worth naming — see
   *  screen-context.ts. Apps get nothing: a paste is the verbatim transcript. */
  screenHeader: string
  /** The same reading unsplit, so the card can list what it is sending rather
   *  than re-parsing the header back apart. */
  screen: ScreenContext | null
  latencyMs: number
  actionCard: ActionCardPayload | null
  picks: Record<string, number>
}

/** Sort sinks by Jev's probability and keep the top few. Sinks Jev gave no
 *  probability at all sort last at 0 rather than being dropped, so the expanded
 *  list can still offer them. */
function rankByProbability(sinks: readonly DesktopSink[], ranking: JevRanking): RankedSink[] {
  return sinks
    .map((sink) => ({ sink, percent: Math.round((ranking.probabilities[sink.id] ?? 0) * 100) }))
    .sort((a, b) => b.percent - a.percent)
}

/** Same ordering for the second column, against its own probability map. */
function rankHelpers(sinks: readonly HelperSink[], ranking: JevRanking): RankedHelper[] {
  return sinks
    .map((sink) => ({
      sink,
      percent: Math.round((ranking.helperProbabilities[sink.id] ?? 0) * 100)
    }))
    .sort((a, b) => b.percent - a.percent)
}

/** The skills and agents to offer, per the two column toggles. Collected before
 *  the ranking call because both lists are local reads with no network cost. */
function collectHelpers(): HelperSink[] {
  const helpers: HelperSink[] = []
  if (PREFS.getVoiceRoutingAgents()) {
    helpers.push(...collectAgentSinks())
    // Derived from the agents rather than collected separately: the projects
    // worth starting a session in are exactly the ones already being worked in.
    // Built from the STALE-INCLUSIVE list on purpose: a project whose agents
    // have all aged out is precisely where a fresh session is the right answer,
    // and passing the filtered list would drop the project's row entirely.
    helpers.push(...collectNewAgentSinks(collectAgentSinks({ includeStale: true }), MIGHTY.listProjects()))
  }
  if (PREFS.getVoiceRoutingSkills()) helpers.push(...collectSkillSinks())
  return helpers
}

const MAX_OLDER_AGENTS = 20

function olderAgents(offered: readonly HelperSink[]): RankedHelper[] {
  if (!PREFS.getVoiceRoutingAgents()) return []
  const ids = new Set(offered.map((h) => h.id))
  return collectAgentSinks({ includeStale: true })
    .filter((s) => !ids.has(s.id))
    .slice(0, MAX_OLDER_AGENTS)
    .map((sink) => ({ sink, percent: 0 }))
}

function withPageOwner(helpers: JevSink[], owner: PageOwner | null): JevSink[] {
  if (!owner) return helpers
  return helpers.map((h) => (h.id === owner.sinkId ? { ...h, description: `${h.description} ${owner.phrase}` } : h))
}

const PICK_HINT_MIN = 2

function withPickHints(helpers: readonly HelperSink[], picks: Record<string, number>): JevSink[] {
  return helpers.map((h) =>
    (picks[h.id] ?? 0) >= PICK_HINT_MIN
      ? { ...h, description: `${h.description} The user has sent ${picks[h.id]} recent notes here.` }
      : h
  )
}

/**
 * Rank the open apps for this transcript. Returns null when routing is off, has
 * no way to reach Jev (not signed in), or Jev could not answer — the
 * caller then does nothing different from what it did before this feature existed.
 */
export async function routeVoiceNote(
  runId: string,
  transcript: string,
  fromHistory = false
): Promise<VoiceRoute | null> {
  if (!PREFS.getVoiceRouting()) return null
  const t0 = Date.now()
  warmJev()

  if (!(await canDecide())) {
    devLog.warn('[routing] enabled but not signed in; skipping')
    return null
  }

  // Skills and agents REPLACE the apps rather than sitting beside them: once you
  // can send a voice note to the thing that does the work, picking the window to
  // paste it into is the worse answer. So when either toggle is on we never
  // collect the apps and never ask Jev to rank them — which also takes an
  // osascript call and a whole Choice question off a path budgeted at 4s.
  const helpers = collectHelpers()
  const useApps = helpers.length === 0

  const {
    sinks,
    frontmostSinkId,
    screen: screenFromSinks
  } = useApps
    ? await collectSinks()
    : { sinks: [] as DesktopSink[], frontmostSinkId: '', screen: null }
  if (useApps && sinks.length === 0) return null

  // Helpers path: this is the only screen read. Async — spawnSync here freezes the skeleton.
  // fromHistory: the screen and the last screenshot are from NOW, the words are not.
  const screen = fromHistory ? null : useApps ? screenFromSinks : await readScreenContext()
  const tScreen = Date.now()

  const agentHelpers = helpers.filter((h): h is AgentSink => h.kind === 'agent')
  const [prepared, owner] = await Promise.all([
    prepareActions(runId, 'voice', transcript),
    findPageOwner(screen?.url ?? '', agentHelpers)
  ])
  const tActions = Date.now()

  const picks = recentPickCounts()
  const ranking = await rankSinks(
    transcript,
    sinks,
    withPageOwner(withPickHints(helpers, picks), owner),
    frontmostSinkId,
    forRanking(screen),
    prepared ? { state: prepared.state, questions: prepared.questions } : undefined
  )
  console.log(
    `[route] ${runId} sinks+screen=${tScreen - t0}ms actions=${tActions - tScreen}ms jev=${Date.now() - tActions}ms`
  )
  if (!ranking) return null

  const actionCard = prepared
    ? resolveActions(prepared, ranking.answers, {
        latencyMs: ranking.latencyMs,
        via: ranking.via,
        inputTokens: ranking.inputTokens
      })
    : null

  // Scanned only when Jev said the text points at an image. The folder walk is
  // 600ms of blocking readdir+stat, and the overwhelming majority of notes never
  // mention a screenshot, so paying it up front froze the card for nothing.
  const lastShot = ranking.wantsScreenshot && !fromHistory ? findLastScreenshot() : null

  // Both lists ship WHOLE. The card shows the top few collapsed and expands
  // to the rest on hover, so cutting here would make that impossible.
  const ranked = rankByProbability(sinks, ranking)
  const rankedHelpers = rankHelpers(helpers, ranking)
  const jevConfident = ranking.confidence >= JEV_CONFIDENCE_FLOOR
  // Jev sure of something else = the words named another agent; unsure = the page decides.
  const ownerPick = !jevConfident && owner?.strength === 'used' ? owner.sinkId : ''
  const confident = jevConfident || ownerPick !== ''

  // Every option Jev actually ranked, apps and helpers together, highest
  // percent first — this is what makes a bad pick diagnosable afterwards.
  const options = [...ranked, ...rankedHelpers]
    .map((r) => ({
      id: r.sink.id,
      label: r.sink.label,
      description: r.sink.description,
      percent: r.percent
    }))
    .sort((a, b) => b.percent - a.percent)

  appendRoutingDecision({
    runId,
    transcript,
    chars: transcript.length,
    frontmostSinkId,
    screen,
    suggestedSinkId: ranking.sinkId,
    confidence: ranking.confidence,
    latencyMs: ranking.latencyMs,
    options,
    pageOwner: owner
  })

  return {
    runId,
    transcript,
    ranked,
    rankedHelpers: [...rankedHelpers, ...olderAgents(helpers)],
    suggestedHelperId: jevConfident ? ranking.helperSinkId : ownerPick,
    suggestedSinkId: confident ? ranking.sinkId : '',
    confidence: ranking.confidence,
    submitNow: ranking.submitNow,
    confident,
    screenshotPath: lastShot && ranking.wantsScreenshot ? lastShot.path : '',
    picks,
    screenHeader: forDelivery(screen),
    screen,
    latencyMs: ranking.latencyMs,
    actionCard
  }
}
