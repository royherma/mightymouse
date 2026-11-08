/** One shape × one colour, hashed from a stable id. Same id, same face. */

import { senderMatchKey } from './relay-cards'
import type { AgentRelaySessionInfo } from './types'

export const AGENT_SHAPES = ['circle', 'squircle', 'quatrefoil', 'hexagon', 'diamond'] as const
export type AgentShape = (typeof AGENT_SHAPES)[number]

/** Skip green/amber/red/muted so a face cannot be misread as session health. */
export const AGENT_FACE_COLORS = [
  'var(--accent)',
  'var(--orange)',
  'var(--yellow)',
  'var(--violet)',
  'var(--blue)',
  'var(--cyan)',
  'var(--rose)',
  'rgba(166, 124, 82, 1)',
  'rgba(232, 120, 180, 1)',
  'rgba(64, 168, 168, 1)'
] as const

export const AGENT_FACE_COUNT = AGENT_SHAPES.length * AGENT_FACE_COLORS.length

export const AGENT_FACE_SIZE = {
  list: 22,
  row: 18,
  chip: 14,
  detail: 22
} as const

export interface FaceSession {
  sessionId?: string
  label: string
  stated?: string
  project?: AgentRelaySessionInfo['project']
}

export interface AgentFacePair {
  shape: AgentShape
  color: string
}

function fnv1a(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return Math.abs(h | 0)
}

/** Empty id still lands on a defined pair so a missing identity cannot crash. */
export function avatarFor(id: string): AgentFacePair {
  const slot = fnv1a(id) % AGENT_FACE_COUNT
  return {
    shape: AGENT_SHAPES[slot % AGENT_SHAPES.length],
    color: AGENT_FACE_COLORS[Math.floor(slot / AGENT_SHAPES.length)]
  }
}

/** UUID when the shim sent one, so a rename does not reshuffle the face. */
export function sessionFaceId(session: FaceSession): string {
  const id = session.sessionId?.trim()
  return id || session.label
}

/** Cards join on stated ?? label (the existing `from` key), then the session id. */
export function senderFaceId(
  from: string | undefined,
  sessions: ReadonlyArray<FaceSession>
): string {
  if (!from) return ''
  const match = sessions.find((s) => senderMatchKey(s.stated ?? s.label) === senderMatchKey(from))
  return match ? sessionFaceId(match) : from
}
