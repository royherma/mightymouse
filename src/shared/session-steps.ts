import { CONFIG } from './config'
import { sessionIsCompacting } from './relay-status'
import type { AgentRelaySessionInfo, AgentTranscriptTurn } from './types'

type StepTurn = { kind: string; at: number; role?: string; text?: string }

export type StepRow<T> = T | { kind: 'steps'; at: number; texts: string[] }

export function foldSteps<T extends StepTurn>(turns: T[], showSteps: boolean): StepRow<T>[] {
  const rows: StepRow<T>[] = []
  for (const turn of turns) {
    if (turn.kind !== 'said' || turn.role !== 'tool') {
      rows.push(turn)
      continue
    }
    if (!showSteps) continue
    const prev = rows[rows.length - 1] as StepRow<T> | undefined
    if (prev && prev.kind === 'steps' && 'texts' in prev) prev.texts.push(turn.text ?? '')
    else rows.push({ kind: 'steps', at: turn.at, texts: [turn.text ?? ''] })
  }
  return rows
}

function toolSummary(text: string): string {
  const first = text.split('\n').map((line) => line.trim()).find(Boolean) ?? text.trim()
  if (!/\s/.test(first)) return first
  const named = /^([A-Z][A-Za-z0-9_]+|[a-z]+(?:_[a-z0-9]+)+):/.exec(first)
  return named ? named[1] : first
}

export function toolParts(text: string): { name: string; detail: string } {
  const at = text.indexOf(' \u00b7 ')
  if (at === -1) return { name: toolSummary(text), detail: '' }
  return { name: text.slice(0, at).trim(), detail: text.slice(at + 3).trim() }
}

export function waitingWords(
  session: AgentRelaySessionInfo,
  spoken: Pick<AgentTranscriptTurn, 'role'>[],
  ended: boolean
): string {
  if (ended) return CONFIG.UI_LABELS.CODE_SESSION_ENDED
  if (session.sessionId === undefined) return CONFIG.UI_LABELS.CODE_SESSION_STARTING
  if (sessionIsCompacting(session, Date.now())) return CONFIG.UI_LABELS.CODE_SESSION_COMPACTING
  const heard = spoken.some((t) => t.role !== 'you')
  return heard ? CONFIG.UI_LABELS.CODE_SESSION_THINKING : CONFIG.UI_LABELS.CODE_SESSION_READING
}
