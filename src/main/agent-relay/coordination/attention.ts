import { CONFIG } from '../../../shared/config'
import { devLog } from '../../../shared/env'
import type { AgentRelaySessionInfo } from '../../../shared/types'
import { buildRoster, type RosterAgent } from '../../../shared/coordination-roster'
import {
  attentionCacheKey,
  candidatesForJev,
  buildAttentionRows,
  type AttentionCandidate,
  type AttentionRow
} from '../../../shared/coordination-attention'
import { getCoordinationService } from '../mcp/http-listener'
import { callJev, type DecideBody } from '../../actions/decide-transport'

interface CacheEntry {
  key: string
  score: number
}

const cache = new Map<string, CacheEntry>()

function joinCandidates(relaySessions: readonly AgentRelaySessionInfo[]): AttentionCandidate[] {
  const roster = buildRoster(getCoordinationService().snapshot(), false)
  const byJoinKey = new Map(relaySessions.map((r) => [r.sessionId, r]))
  const agents: RosterAgent[] = roster.projects.flatMap((p) => p.agents)
  return agents
    .slice()
    .sort((a, b) => b.session.lastSeen - a.session.lastSeen)
    .slice(0, CONFIG.COORDINATION_ATTENTION.MAX_AGENTS)
    .map((agent) => ({ agent, relay: byJoinKey.get(agent.session.session) }))
}

function buildQuestionForCandidate(candidate: AttentionCandidate): Record<string, unknown> {
  const words = candidate.relay?.tldr || candidate.relay?.preview || ''
  return {
    type: 'score',
    instructions:
      `This coding agent's own status line: "${words}". How urgently does the person running ` +
      'it need to look at it right now -- by whether it needs a reply, not how busy it looks.',
    criteria: [
      'finished, nothing to answer',
      'idle, nothing pending',
      'working fine on its own',
      'wants a reply soon',
      'stuck until answered'
    ]
  }
}

async function scoreChunk(
  chunk: readonly AttentionCandidate[]
): Promise<Map<string, number>> {
  const questions: Record<string, unknown> = {}
  for (const candidate of chunk) {
    questions[candidate.agent.session.id] = buildQuestionForCandidate(candidate)
  }
  const body: DecideBody = { state: {}, questions }
  const payload = JSON.stringify(body)
  const started = Date.now()
  devLog.log(`[coordination-attention] body ${payload.length}B agents=${chunk.length}`)
  const result = await callJev(body, CONFIG.COORDINATION_ATTENTION.CALL_TIMEOUT_MS)
  devLog.log(`[coordination-attention] ${Date.now() - started}ms agents=${chunk.length}`)
  const scores = new Map<string, number>()
  if (!result) return scores
  for (const candidate of chunk) {
    const answer = result.answers[candidate.agent.session.id] as { score?: number } | undefined
    if (typeof answer?.score === 'number') scores.set(candidate.agent.session.id, answer.score)
  }
  return scores
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * Rule-placed rows never reach Jev. Everything else re-scores only when its
 * cache key changed since the last call, so a reload with nothing new makes
 * zero calls -- the PRD's own line.
 */
export async function computeAttention(
  relaySessions: readonly AgentRelaySessionInfo[]
): Promise<AttentionRow[]> {
  const candidates = joinCandidates(relaySessions)
  const toScore = candidatesForJev(candidates)

  const stillScored = new Map<string, number>()
  const needsCall: AttentionCandidate[] = []
  for (const candidate of toScore) {
    const key = attentionCacheKey(candidate)
    const cached = cache.get(candidate.agent.session.id)
    if (cached && cached.key === key) {
      stillScored.set(candidate.agent.session.id, cached.score)
    } else {
      needsCall.push(candidate)
    }
  }

  if (needsCall.length > 0) {
    const results = await Promise.all(
      chunks(needsCall, CONFIG.COORDINATION_ATTENTION.CHUNK_SIZE).map(scoreChunk)
    )
    for (const scores of results) {
      for (const [id, score] of scores) {
        stillScored.set(id, score)
        const candidate = needsCall.find((c) => c.agent.session.id === id)
        if (candidate) cache.set(id, { key: attentionCacheKey(candidate), score })
      }
    }
  }

  return buildAttentionRows(candidates, stillScored)
}
