/**
 * Who needs the user, who can wait, who is ready to wrap up.
 *
 * Five levels replace the five roster state words for exactly one screen: the
 * roster still drives "Waiting on you" (blocked/waiting rules, no model
 * involved). This module layers a SCORE on top, 0 (done, nothing asked) to 4
 * (stuck until you answer), and folds that score plus the roster's own rules
 * into three groups. Pure and side-effect free like coordination-roster.ts --
 * the rule pass here has to be the same code whether Jev answered or not.
 */

import type { AgentRelaySessionInfo } from './types'
import type { RosterAgent } from './coordination-roster'

export const ATTENTION_LEVELS = 5
export const ATTENTION_MIN_LEVEL = 0
export const ATTENTION_MAX_LEVEL = ATTENTION_LEVELS - 1

export type AttentionGroup = 'talk' | 'wait' | 'wrap'

export interface AttentionCandidate {
  agent: RosterAgent
  relay?: AgentRelaySessionInfo
}

export interface AttentionRow {
  agent: RosterAgent
  relay?: AgentRelaySessionInfo
  group: AttentionGroup
  level: number
  /** The agent's own words for why it lands here. Empty when a rule placed it
   *  with no readable text to quote (e.g. blocked work with no relay tldr). */
  reason: string
  /** True once Jev actually scored this row rather than a rule placing it. */
  scored: boolean
}

function ruleLevel(candidate: AttentionCandidate): number | null {
  const { agent, relay } = candidate
  if (agent.work.some((w) => w.state === 'blocked' || w.expired)) return ATTENTION_MAX_LEVEL
  if (agent.messages.some((m) => !m.outgoing && m.message.state === 'pending')) {
    return ATTENTION_MAX_LEVEL
  }
  if (agent.state === 'waiting') return ATTENTION_MAX_LEVEL - 1
  if (agent.state === 'gone') return 0
  if (relay?.canWrapUp && agent.state === 'idle' && !hasReadableWords(relay)) return 0
  return null
}

/** The one line a row can show as its reason, straight from the relay session
 *  -- never guessed from a label. Absent entirely when the agent has nothing
 *  readable, which is also the signal that Jev must not be asked about it. */
export function hasReadableWords(relay: AgentRelaySessionInfo | undefined): boolean {
  return Boolean(relay?.tldr || relay?.preview)
}

function reasonFor(candidate: AttentionCandidate): string {
  const { agent, relay } = candidate
  const blocked = agent.work.find((w) => w.state === 'blocked' || w.expired)
  if (blocked) return blocked.expired ? 'Stopped checking in on its claim' : 'Stuck on its work'
  const pending = agent.messages.find((m) => !m.outgoing && m.message.state === 'pending')
  if (pending) return `Asking: ${pending.message.subject}`
  return relay?.tldr || relay?.preview || ''
}

/** Where a scored (or rule-placed) row lands. Matches the design's five levels:
 *  0 finished/nothing asked, 1 idle, 2 working fine, 3 wants a reply soon,
 *  4 stuck -- 0-1 can wrap up or wait, 2 waits, 3-4 need a reply now. */
export function groupForLevel(level: number, canWrapUp: boolean): AttentionGroup {
  if (level >= 3) return 'talk'
  if (level === 0 && canWrapUp) return 'wrap'
  return 'wait'
}

/**
 * Build the rows Jev is allowed to see: rules have already placed a stuck
 * claim, a pending handoff, a cold agent or a wrap-up-ready idle agent, and a
 * cold session is never checked at all (mirrors buildRoster's own `showCold`
 * boundary -- an agent nobody has heard from does not get scored either).
 * Everything left either has no readable words (also skipped -- guessing from
 * a label is worse than no score) or genuinely needs Jev's read.
 */
export function candidatesForJev(candidates: readonly AttentionCandidate[]): AttentionCandidate[] {
  return candidates.filter((c) => ruleLevel(c) === null && hasReadableWords(c.relay))
}

/** Turn every candidate into a row: rule-placed rows keep their level, scored
 *  rows take the position Jev returned (already clamped by the caller), and
 *  anything neither rule nor Jev could place defaults to level 1 (idle) so it
 *  reads as "can wait" rather than silently vanishing from every group. */
export function buildAttentionRows(
  candidates: readonly AttentionCandidate[],
  scores: ReadonlyMap<string, number>
): AttentionRow[] {
  return candidates.map((candidate) => {
    const rule = ruleLevel(candidate)
    const canWrapUp = candidate.relay?.canWrapUp === true
    if (rule !== null) {
      return {
        agent: candidate.agent,
        relay: candidate.relay,
        group: groupForLevel(rule, canWrapUp),
        level: rule,
        reason: reasonFor(candidate),
        scored: false
      }
    }
    const scored = scores.get(candidate.agent.session.id)
    const level = scored === undefined ? 1 : clampLevel(scored)
    return {
      agent: candidate.agent,
      relay: candidate.relay,
      group: groupForLevel(level, canWrapUp),
      level,
      reason: reasonFor(candidate),
      scored: scored !== undefined
    }
  })
}

export function clampLevel(score: number): number {
  return Math.min(ATTENTION_MAX_LEVEL, Math.max(ATTENTION_MIN_LEVEL, Math.round(score)))
}

/** Cache key: re-score only when a session's own facts changed. Bucketing
 *  `lastSeen` to the minute means a session that is merely still alive
 *  (heartbeats every few seconds) does not force a re-check on every poll --
 *  only a real state change does, matching "a reload with nothing new makes
 *  zero calls" from the design. */
export function attentionCacheKey(candidate: AttentionCandidate): string {
  const { agent, relay } = candidate
  const lastSeenBucket = Math.floor(agent.session.lastSeen / 60_000)
  const workKey = agent.work.map((w) => `${w.id}:${w.state}:${w.stage}:${w.expired}`).join(',')
  const msgKey = agent.messages
    .map((m) => `${m.message.id}:${m.message.state}:${m.outgoing}`)
    .join(',')
  const relayKey = relay ? `${relay.tldr ?? ''}|${relay.preview ?? ''}|${relay.canWrapUp ?? false}` : ''
  return `${agent.session.id}:${lastSeenBucket}:${agent.state}:${workKey}:${msgKey}:${relayKey}`
}

export interface AttentionGroups {
  talk: AttentionRow[]
  wait: AttentionRow[]
  wrap: AttentionRow[]
}

/** Split rows into the three screen groups, each kept in a stable order
 *  (highest level / longest quiet first) so the caller can freeze that order
 *  while the pointer is over the list. */
export function groupAttentionRows(rows: readonly AttentionRow[]): AttentionGroups {
  const groups: AttentionGroups = { talk: [], wait: [], wrap: [] }
  for (const row of rows) groups[row.group].push(row)
  const byLevelThenQuiet = (a: AttentionRow, b: AttentionRow): number =>
    b.level - a.level || b.agent.quietFor - a.agent.quietFor
  groups.talk.sort(byLevelThenQuiet)
  groups.wait.sort(byLevelThenQuiet)
  groups.wrap.sort((a, b) => b.agent.quietFor - a.agent.quietFor)
  return groups
}
