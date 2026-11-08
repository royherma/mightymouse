import { useCallback, useEffect, useRef, useState } from 'react'
import { buildRoster, type Roster, type RosterAgent } from '../../../shared/coordination-roster'
import type { CoordinationSnapshot } from '../../../shared/coordination'
import type { AgentRelaySessionInfo } from '../../../shared/types'
import { useInterval } from './useInterval'
import {
  localPriority,
  priorityFingerprint,
  priorityKey,
  PRIORITY_DROP_MS,
  PRIORITY_OLD_MS,
  type SessionPriorityResult,
  type SessionPriorityRow
} from '../../../shared/session-priority'

export interface SessionPriorityState {
  rows: Map<string, SessionPriorityRow>
  busy: boolean
  failed: boolean
  result: SessionPriorityResult | null
  changed: boolean
  old: boolean
  rank: () => Promise<void>
  clear: () => void
  roster: Roster | null
  sharedFor: (session: AgentRelaySessionInfo) => RosterAgent | undefined
}

export function useSessionPriority(
  sessions: readonly AgentRelaySessionInfo[],
  archived: readonly AgentRelaySessionInfo[] = []
): SessionPriorityState {
  const skip = useRef<string[]>([])
  skip.current = archived.map(priorityKey)
  const [coordination, setCoordination] = useState<CoordinationSnapshot | null>(null)
  useEffect(() => {
    let live = true
    void window.api
      .coordinationGet()
      .then((snapshot) => {
        if (live) setCoordination(snapshot)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [sessions.length])
  const roster = coordination ? buildRoster(coordination, false) : null
  const [result, setResult] = useState<SessionPriorityResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const active = useRef(false)
  const sequence = useRef(0)
  const rank = useCallback(async () => {
    if (active.current) return
    active.current = true
    const requestId = String(++sequence.current)
    setBusy(true)
    setFailed(false)
    try {
      void window.api
        .coordinationGet()
        .then(setCoordination)
        .catch(() => {})
      const next = await window.api.coordinationAttention({ requestId, skip: skip.current })
      if (next.requestId !== String(sequence.current)) return
      setResult(next)
    } catch {
      setFailed(true)
    } finally {
      active.current = false
      setBusy(false)
    }
  }, [])
  const [now, setNow] = useState(() => Date.now())
  useInterval(() => setNow(Date.now()), result ? 60_000 : null)
  const age = result ? now - result.checkedAt : 0
  if (result && age > PRIORITY_DROP_MS) setResult(null)
  const old = age > PRIORITY_OLD_MS
  const saved = new Map(result?.rows.map((row) => [row.key, row]) ?? [])
  const changed = Boolean(
    result &&
    (old || sessions.some(
      (session) => saved.get(priorityKey(session))?.fingerprint !== priorityFingerprint(session)
    ))
  )
  const rows = new Map(
    sessions.map((session) => {
      const row = saved.get(priorityKey(session))
      const local = localPriority(session)
      if (!row) return [local.key, local] as const
      if (row.fingerprint === local.fingerprint) return [local.key, row] as const
      return [local.key, local.source === 'rule' ? local : { ...row, stale: true }] as const
    })
  )
  return {
    rows,
    busy,
    failed,
    result,
    changed,
    old,
    rank,
    clear: () => setResult(null),
    roster,
    sharedFor: (session: AgentRelaySessionInfo) =>
      roster?.projects
        .flatMap((project) => project.agents)
        .find((agent) => session.sessionId && agent.session.session === session.sessionId),
  }
}
