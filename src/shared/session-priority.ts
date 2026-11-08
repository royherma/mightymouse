import { CONFIG } from './config'
import type { AgentRelaySessionInfo, AgentTranscriptTurn } from './types'

export const PRIORITY_LIMITS = { agents: 100, questions: 50, bytes: 60 * 1024, text: 1200 } as const
export const PRIORITY_OLD_MS = 30 * 60 * 1000
export const PRIORITY_DROP_MS = 2 * 60 * 60 * 1000
export type PriorityLevel = 0 | 1 | 2 | 3 | 4
export type PrioritySource = 'rule' | 'model' | 'cache' | 'unknown'
export interface SessionPriorityRow {
  key: string
  fingerprint: string
  level: PriorityLevel | null
  heat: number | null
  stale?: boolean
  source: PrioritySource
  reason: string
  checkedAt: number
}
export interface SessionPriorityResult {
  requestId: string
  checkedAt: number
  status: 'complete' | 'partial' | 'unavailable'
  rows: SessionPriorityRow[]
}
export interface SuggestedReply {
  text: string
  evidence: AgentTranscriptTurn
  scope: string
}
export const PRIORITY_COPY = CONFIG.UI_LABELS.SESSION_PRIORITY

export function priorityKey(session: AgentRelaySessionInfo): string {
  return session.sessionId || `${session.label}:${session.pid ?? ''}:${session.since ?? ''}`
}

export function priorityFingerprint(session: AgentRelaySessionInfo): string {
  return JSON.stringify([
    session.sessionId,
    session.tldr,
    session.preview,
    session.waiting,
    session.busySince,
    session.handedBackAt,
    session.stale,
    session.canWrapUp
  ])
}

export function localPriority(
  session: AgentRelaySessionInfo,
  now = Date.now()
): SessionPriorityRow {
  const row: SessionPriorityRow = {
    key: priorityKey(session),
    fingerprint: priorityFingerprint(session),
    level: null,
    heat: null,
    source: 'unknown',
    reason: PRIORITY_COPY.missing,
    checkedAt: now
  }
  if (session.stale) return { ...row, reason: PRIORITY_COPY.stale }
  if (!session.sessionId) return { ...row, reason: PRIORITY_COPY.identity }
  if ((session.waiting ?? 0) > 0) {
    return { ...row, level: 4, heat: 100, source: 'rule', reason: PRIORITY_COPY.human }
  }
  return row
}

export function priorityWeight(row?: SessionPriorityRow): number {
  if (row?.level === 4) return 6
  if (row?.level === 3) return 5
  if (row?.level == null) return -1
  return row.level
}

export function suggestedReply(turns: readonly AgentTranscriptTurn[]): SuggestedReply | null {
  const latest = turns[turns.length - 1]
  if (!latest || latest.role !== 'agent') return null
  const paragraphs = latest.text.split(/\n\s*\n/)
  const scope = paragraphs
    .find((part) => /\b(?:say|reply|type)\s+["'“‘`*]*go\b/i.test(part))
    ?.trim()
  if (!scope || scope.length > PRIORITY_LIMITS.text) return null
  if (/\b(?:do not|don't|never|not ready)\b/i.test(scope)) return null
  if (
    /\b(?:deploy|publish|purchase|pay|delete|destroy|drop|merge|release|production|permission|sudo)\b/i.test(
      scope
    )
  )
    return null
  if (
    !/\b(?:implement|build|fix|edit|update|continue|start|add|wire|work|picker|code)\b/i.test(scope)
  )
    return null
  return { text: PRIORITY_COPY.go, evidence: latest, scope }
}
