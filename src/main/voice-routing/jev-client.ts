// jev-client.ts — the ONLY place TypeSafe's System One API is called.
//
// Jev is a decision model: it ranks, it never writes. We hand it the transcript,
// the list of apps that are open and the list of skills/agents that could handle
// it, and it tells us which should receive the text. The transcript we paste is always the verbatim Whisper output — see
// the PRD's "What Jev decides, and what it does not".
//
// Wire format verified against docs.typesafe.ai on 2026-09-18:
//   - `state` may be a string, object or array; we send an object.
//   - Choice answers carry choice + probabilities + confidence.
//   - Score answers carry score + legend + confidence (NOT probabilities).
//   - Noul answers carry ONLY `noul` — asking for .confidence there returns
//     undefined, which is why the gate below reads Choice confidence alone.
//   - `criteria` values may ALSO be an object {what, not_for, examples} instead
//     of a plain string, specifically to sharpen the boundary between similar
//     options ("write descriptions that separate the options from each
//     other"). Not used here: fabricating not_for/examples per skill from no
//     real data would be a guess dressed as structure, worse than the honest
//     string. buildSinkCriteria stays string-only until a source of real
//     distinguishing facts exists per skill.
//   - `instructions` frames the question ("which team should handle this");
//     `criteria` is the answer set. They are deliberately separate fields, not
//     one prompt — see the sharper `helper` instructions below.
import { CONFIG } from '../../shared/config'
import { devLog } from '../../shared/env'
import { isAgentSinkId, groupAgentSinksByProject, type AgentSink } from './agent-sinks'
import { callJev } from '../actions/decide-transport'

const JEV_MODEL = 'jev-latest'

/** The documented confidence floor (docs.typesafe.ai/confidence). Below this Jev
 *  itself reports the answer as genuinely uncertain, so we never pre-select a
 *  destination — the card still shows the ranking, but a click is required. */
export const JEV_CONFIDENCE_FLOOR = 0.5

/** One candidate destination: an app, or a specific window/tab inside one. */
export interface JevSink {
  id: string
  label: string
  /** One line telling Jev what this destination IS. Becomes the Choice criteria,
   *  so this text is the whole basis of the ranking — see buildSinkCriteria. */
  description: string
}

export interface JevRanking {
  sinkId: string
  probabilities: Record<string, number>
  confidence: number
  /** Probabilities for the second column (skills + agents), keyed by sink id.
   *  Empty when that column is switched off or nothing was offered. */
  helperProbabilities: Record<string, number>
  /** The best skill/agent, or '' when none was offered or Jev picked none. */
  helperSinkId: string
  /** Jev's read on whether this should be submitted (Return pressed) rather than
   *  just pasted and left for the user to edit. */
  submitNow: boolean
  /** True when the transcript is a note to self rather than an instruction. */
  isNote: boolean
  /** True when the text refers to a screenshot the user just took, so the
   *  newest one should ride along to the destination. */
  wantsScreenshot: boolean
  latencyMs: number
  /** The raw answers, for a caller riding the action-engine questions in on
   *  `extra` — routing itself never reads this. */
  answers: Record<string, unknown>
  via: 'proxy' | 'direct'
  inputTokens: number
}

interface ChoiceAnswer {
  choice?: unknown
  probabilities?: unknown
  confidence?: unknown
}

/** Coerce the probability map to plain numbers, dropping anything unparseable.
 *  The map drives the percentages the user sees, so a NaN here would render as
 *  "NaN%" on the card rather than failing loudly somewhere we'd notice. */
function coerceProbabilities(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
  }
  return out
}

function pickConfidence(answer: ChoiceAnswer | undefined): number {
  const value = answer?.confidence
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function coerceNoul(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false
  const value = (raw as { noul?: unknown }).noul
  return typeof value === 'number' && value > 0.5
}

/** Build the Choice criteria: sink id -> what that destination is.
 *  Jev can only pick an id that appears here, so this map IS the set of legal
 *  destinations — it cannot invent one. */
function buildSinkCriteria(sinks: readonly JevSink[]): Record<string, string> {
  const criteria: Record<string, string> = {}
  for (const sink of sinks) criteria[sink.id] = sink.description
  return criteria
}

/** Prefix on the per-project fan-out question keys, so they can be found in
 *  the response by exact match without colliding with `target`/`helper`/etc. */
const AGENT_QUESTION_PREFIX = 'agents_in_'

function agentQuestionKey(slug: string): string {
  return `${AGENT_QUESTION_PREFIX}${slug}`
}

/** Speculative Fan-Out (docs.typesafe.ai/patterns/fan-out): "all questions are
 *  evaluated in parallel, so adding more questions to a call typically doesn't
 *  add any latency" — the opposite of the hierarchical_classification cookbook's
 *  beam search, which asks a project, waits, then asks a second call about the
 *  winner (up to 4 calls, blowing the 4s budget here). Instead this adds ONE
 *  `project` Choice plus one `agents_in_<slug>` Choice PER PROJECT to the SAME
 *  request Jev already answers for target/helper/send_now/is_note. Every
 *  per-project branch gets answered whether or not it wins; the code below
 *  reads only the winning project's branch and throws the rest away — that
 *  waste is the whole point of the pattern, since it buys zero extra latency
 *  for a full order of magnitude fewer sinks than fit in one flat list
 *  (measured: 74 agents = 3,254 tokens total either way, fan-out just avoids
 *  ranking 74 candidates against each other in one question). */
function buildAgentFanOutQuestions(agentSinks: readonly AgentSink[]): Record<string, unknown> {
  if (agentSinks.length === 0) return {}

  const groups = groupAgentSinksByProject(agentSinks)
  // One project: no fan-out value, ranking its agents directly is the same
  // number of questions as fanning out to a single branch.
  if (groups.length <= 1) return {}

  const projectCriteria: Record<string, string> = {}
  for (const group of groups) projectCriteria[group.slug] = group.description

  const questions: Record<string, unknown> = {
    project: {
      type: 'choice',
      instructions:
        'Which project does this dictated text concern. Match it to the project whose stated ' +
        'work is what the text is actually about, not merely the most recently touched one.',
      criteria: projectCriteria
    }
  }

  for (const group of groups) {
    questions[agentQuestionKey(group.slug)] = {
      type: 'choice',
      instructions:
        'Which running agent in this project should handle this dictated text. Prefer one ' +
        "already working on the exact subject the text is about, most of all one working right " +
        'now, over one merely idle in the same project.',
      criteria: buildSinkCriteria(group.sinks)
    }
  }

  return questions
}

/** Resolve the fan-out: read the `project` answer, then read ONLY that
 *  project's `agents_in_<slug>` answer, and ignore every other project's
 *  branch — the speculative answers this pattern generates on purpose. */
function resolveAgentFanOut(
  answers: Record<string, unknown>,
  agentSinks: readonly AgentSink[]
): { helperSinkId: string; probabilities: Record<string, number>; confidence: number } {
  const groups = groupAgentSinksByProject(agentSinks)
  if (groups.length === 0) return { helperSinkId: '', probabilities: {}, confidence: 0 }

  const projectAnswer = answers['project'] as ChoiceAnswer | undefined
  const projectSlug = typeof projectAnswer?.choice === 'string' ? projectAnswer.choice : ''
  const winningGroup = groups.find((g) => g.slug === projectSlug) ?? groups[0]

  const agentAnswer = answers[agentQuestionKey(winningGroup.slug)] as ChoiceAnswer | undefined
  const choice = typeof agentAnswer?.choice === 'string' ? agentAnswer.choice : ''
  const helperSinkId = winningGroup.sinks.some((s) => s.id === choice) ? choice : ''

  return {
    helperSinkId,
    probabilities: coerceProbabilities(agentAnswer?.probabilities),
    confidence: pickConfidence(agentAnswer)
  }
}

/**
 * Rank which open app should receive this transcript.
 *
 * Returns null on ANY failure — no key, network down, timeout, bad JSON, a
 * choice that isn't one of our sink ids. The caller treats null as "no ranking"
 * and falls back to the normal paste path, so routing can never make dictation
 * worse than it was before this feature existed.
 */
export async function rankSinks(
  transcript: string,
  sinks: readonly JevSink[],
  helperSinks: readonly JevSink[],
  frontmostSinkId: string,
  screenLine: string,
  extra?: { state: Record<string, unknown>; questions: Record<string, unknown> }
): Promise<JevRanking | null> {
  if (transcript.trim() === '') return null
  const hasExtraQuestions = extra !== undefined && Object.keys(extra.questions).length > 0
  if (sinks.length === 0 && helperSinks.length === 0 && !hasExtraQuestions) return null

  // Split the second column: agents fan out into a project question plus one
  // per-project agent question (buildAgentFanOutQuestions); skills stay on the
  // flat `helper` question they always used. When there's only one project (or
  // none), the fan-out is pointless and agentSinks fall back into the same flat
  // `helper` question as skills, unchanged from before this feature.
  const agentSinks = helperSinks.filter((s): s is AgentSink => isAgentSinkId(s.id)) as AgentSink[]
  const nonAgentHelperSinks = helperSinks.filter((s) => !isAgentSinkId(s.id))
  const agentFanOutQuestions = buildAgentFanOutQuestions(agentSinks)
  const fanOutActive = Object.keys(agentFanOutQuestions).length > 0
  const flatHelperSinks = fanOutActive ? nonAgentHelperSinks : helperSinks

  const body = {
    model: JEV_MODEL,
    state: {
      payload: transcript,
      payload_kind: 'voice_transcript',
      frontmost_sink_id: frontmostSinkId,
      // What the user was looking at while dictating. Free-form state, not a
      // question: dictation drops its subject ("update this UI"), and the page
      // in front is usually what that subject was.
      ...(screenLine === '' ? {} : { on_screen: screenLine }),
      sinks: sinks.map((s) => ({ id: s.id, label: s.label, description: s.description })),
      // Helpers are NOT repeated here: the fan-out questions below already carry
      // every agent's id and description in their criteria, and the duplicate
      // copy was 38KB of the 81KB body that 413'd at the proxy.
      ...(extra?.state ?? {})
    },
    questions: {
      // Asked only when there are apps to rank. With the skills/agents column on
      // there are none, and a Choice with an empty criteria map has no answer.
      ...(sinks.length > 0
        ? {
            target: {
              type: 'choice',
              instructions:
                'Which open destination should receive this dictated text. Prefer the one whose ' +
                'current work the text is about, not merely the one in front.',
              criteria: buildSinkCriteria(sinks)
            }
          }
        : {}),
      send_now: {
        type: 'noul',
        instructions:
          'This text is complete and ready to submit as-is, rather than a fragment the ' +
          'user still needs to edit before sending.'
      },
      is_note: {
        type: 'noul',
        instructions: 'This is a note to self, not an instruction addressed to an agent or person.'
      },
      // Phrased as "points at an image the destination must SEE" rather than
      // "mentions a screenshot", so "the screenshot bug is back" (the word, as a
      // subject) stays a no while "look at my last screenshot and fix this" is a
      // yes. Asked unconditionally: gating it on a folder scan cost 608ms of
      // blocked main thread before every ranking, and an extra question in one
      // fan-out call is free (see the helper question below).
      wants_screenshot: {
        type: 'noul',
        instructions:
          'This text refers to a screenshot or something on screen that the recipient ' +
          'must actually look at to act on it — for example "look at my last ' +
          'screenshot", "what does this error say", "fix what I just captured". ' +
          'Merely naming a screenshot as the subject of a sentence does not count.'
      },
      // Second column: skills, and agents when the fan-out below isn't active
      // (single project or none). Asked in the SAME call as the app ranking —
      // extra questions in one Speculative Fan-Out call don't add latency
      // (docs.typesafe.ai/patterns/fan-out), a second sequential call would.
      ...(flatHelperSinks.length > 0
        ? {
            helper: {
              type: 'choice',
              instructions:
                'Which skill or running agent should handle this dictated text: a skill runs ' +
                'once from scratch on the text as its argument, an agent already has context ' +
                'and mid-task state on a specific repo/subject. Prefer an agent whose stated ' +
                'subject or repo the text is clearly about — most of all one already working ' +
                'right now — over a skill that only generically matches. Fall back to a skill ' +
                'when no agent is a close match, or the text names a one-shot task a skill ' +
                'does verbatim. Prefer starting a NEW agent in a project when the text is a ' +
                'fresh task in that project rather than a continuation of what the agents ' +
                'already running there are part-way through — handing a new task to a busy ' +
                'agent buries it in work it was not asked to do.',
              criteria: buildSinkCriteria(flatHelperSinks)
            }
          }
        : {}),
      // Speculative Fan-Out: a `project` Choice plus one `agents_in_<slug>`
      // Choice per project, all answered in this same request. See
      // buildAgentFanOutQuestions for why this beats one flat agent list.
      ...agentFanOutQuestions,
      ...(extra?.questions ?? {})
    }
  }

  try {
    const result = await callJev(body, CONFIG.ACTIONS.DECIDE_TIMEOUT_MS)
    if (!result) return null
    const answers = result.answers

    const target = answers['target'] as ChoiceAnswer | undefined
    const sinkId = typeof target?.choice === 'string' ? target.choice : ''
    // Jev is told it may only pick from our criteria, but a destination we can't
    // deliver to is worse than no ranking at all — so verify rather than trust.
    // Skipped when no apps were offered: there was no question to answer.
    if (sinks.length > 0 && !sinks.some((s) => s.id === sinkId)) {
      devLog.warn('[jev] ranking returned an unknown sink id; ignoring')
      return null
    }

    const helper = answers['helper'] as ChoiceAnswer | undefined
    const flatHelperChoice = typeof helper?.choice === 'string' ? helper.choice : ''
    // Same verify-don't-trust rule as the app target above: a destination we
    // cannot deliver to is worse than offering none.
    const flatHelperSinkId = flatHelperSinks.some((s2) => s2.id === flatHelperChoice)
      ? flatHelperChoice
      : ''

    // Resolve the fan-out (winning project -> its agent question) when it was
    // asked, and merge its answer into the SAME flat shape route-voice.ts
    // already reads — the fan-out is invisible past this function.
    const fanOut = fanOutActive
      ? resolveAgentFanOut(answers, agentSinks)
      : { helperSinkId: '', probabilities: {} as Record<string, number>, confidence: 0 }
    // The fan-out wins when it actually named an agent; otherwise fall back to
    // the flat helper question (skills, or agents when fan-out wasn't active).
    const fanOutWon = fanOutActive && fanOut.helperSinkId !== ''

    const helperSinkId = fanOutWon ? fanOut.helperSinkId : flatHelperSinkId
    const helperProbabilities = fanOutActive
      ? { ...coerceProbabilities(helper?.probabilities), ...fanOut.probabilities }
      : coerceProbabilities(helper?.probabilities)
    const helperConfidence = fanOutWon ? fanOut.confidence : pickConfidence(helper)

    return {
      sinkId,
      helperSinkId,
      helperProbabilities,
      probabilities: coerceProbabilities(target?.probabilities),
      // The app question's confidence, or whichever helper question actually
      // decided the pre-selection, when no apps were offered.
      confidence: sinks.length > 0 ? pickConfidence(target) : helperConfidence,
      submitNow: coerceNoul(answers['send_now']),
      isNote: coerceNoul(answers['is_note']),
      wantsScreenshot: coerceNoul(answers['wants_screenshot']),
      latencyMs: result.latencyMs,
      answers,
      via: result.via,
      inputTokens: result.inputTokens
    }
  } catch (err) {
    devLog.warn('[jev] ranking call threw:', err)
    return null
  }
}
