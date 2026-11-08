/**
 * One line of shared work, and the words that describe its state.
 *
 * Lives here rather than in CoordinationPanel because the session sheet shows
 * the same work the roster row does -- an agent's claim reads the same whether
 * you are scanning the list or standing inside that one session. Two copies of
 * these strings would drift into two different vocabularies for one thing,
 * which is the failure DESIGN.md rule 1 names.
 */

import type { CoordinationMessage, CoordinationWork } from './coordination'

const STAGE_LABELS = {
  scoped: 'Scoped',
  implemented: 'Built',
  verified: 'Checks reported',
  shipped: 'Release reported',
  observed: 'Usage reported'
} as const

const RECEIPT_LABELS: Record<string, string> = {
  accepted: 'Taken on',
  declined: 'Turned down',
  completed: 'Reported done'
}

export function workLine(item: {
  expired: boolean
  state: string
  stage: keyof typeof STAGE_LABELS
}): string {
  if (item.expired) return 'Owner stopped checking in'
  if (item.state === 'blocked') return 'Blocked'
  if (item.state === 'complete') return 'Reported done'
  if (item.state === 'released') return 'Ready for a new owner'
  return STAGE_LABELS[item.stage]
}

export function messageLine(state: string, offeredAt: number | null): string {
  if (state !== 'pending') return RECEIPT_LABELS[state] ?? state
  return offeredAt ? 'Delivered, no reply yet' : 'Waiting to be delivered'
}

export interface CoordField {
  label: string
  text: string
}

export function workFields(item: CoordinationWork): CoordField[] {
  const fields: CoordField[] = []
  const acceptance = item.acceptance.trim()
  if (acceptance) fields.push({ label: 'Done when', text: acceptance })
  const note = item.note.trim()
  if (note) fields.push({ label: 'Note', text: note })
  if (item.refs.length > 0) fields.push({ label: 'Files', text: item.refs.join(', ') })
  return fields
}

export function messageFields(message: CoordinationMessage): CoordField[] {
  const fields: CoordField[] = []
  const body = message.body.trim()
  if (body) fields.push({ label: '', text: body })
  const note = message.note.trim()
  if (note) fields.push({ label: 'Reply', text: note })
  if (message.refs.length > 0) fields.push({ label: 'Files', text: message.refs.join(', ') })
  return fields
}

export function holdingLine(state: string): string | null {
  return state === 'released' ? 'Nobody is holding this.' : null
}

export const workSubs = (item: CoordinationWork): string[] =>
  workFields(item).map((field) => `${field.label}: ${field.text}`)

export const messageSubs = (m: CoordinationMessage): string[] => [
  m.body,
  m.note && `Reply: ${m.note}`,
  m.refs.length > 0 ? `Files: ${m.refs.join(', ')}` : ''
]

export function Line({
  title,
  meta,
  subs,
  emoji
}: {
  title: string
  meta: string
  subs?: string[]
  emoji?: string
}): React.JSX.Element {
  return (
    <span className="coord-line">
      <span className="coord-line-main">
        {emoji && (
          <span className="coord-line-emoji" aria-hidden="true">
            {emoji}
          </span>
        )}
        <span className="coord-line-title">{title}</span>
        <span className="coord-line-meta">{meta}</span>
      </span>
      {subs?.filter(Boolean).map((sub) => (
        <span key={sub} className="coord-line-sub">
          {sub}
        </span>
      ))}
    </span>
  )
}
