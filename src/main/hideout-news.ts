import { HIDEOUT_STUCK_VERDICTS, projectOf, type HideoutAsk } from '../shared/hideout'
import type { AgentRelaySessionInfo } from '../shared/types'
import { readSessionChecklist } from './agent-relay/session-checklist'

type ProjectLook = { verdict: string; handedBackAt: number; tldr?: string }
export type HideoutLook = { projects: Record<string, ProjectLook>; asks: Record<string, string> }
export type HideoutNews = { key: string; project: string; line: string; detail?: string }

const FINISHED = [
  '{p} just wrapped up.',
  '{p} is done. Your move.',
  '{p} finished. Come take a look.',
  '{p} says it is done. Trust, but check.',
  '{p} crossed the finish line.',
  'Ding. {p} is done.'
]
const NEEDS = [
  '{p} needs you. {q}',
  'Quick one from {p}. {q}',
  '{p} wants your call. {q}',
  '{p} is tapping its foot. {q}',
  '{p} has a question. {q}'
]
const lastPick = new Map<string[], number>()

export function pickLine(bank: string[], vars: Record<string, string>): string {
  const last = lastPick.get(bank) ?? -1
  let i = Math.floor(Math.random() * bank.length)
  if (i === last) i = (i + 1) % bank.length
  lastPick.set(bank, i)
  return bank[i].replace(/\{(\w)\}/g, (_, k: string) => vars[k] ?? '')
}

const question = (q: string): string => q.trim().replace(/[.?!]*$/, '?')

export function takeLook(
  list: AgentRelaySessionInfo[],
  verdicts: Record<string, string>,
  asks: HideoutAsk[]
): HideoutLook {
  const projects: Record<string, ProjectLook> = {}
  for (const s of list) {
    const p = projectOf(s)
    const prev = projects[p]
    const verdict = (s.sessionId && verdicts[s.sessionId]) || prev?.verdict || ''
    projects[p] = {
      verdict,
      handedBackAt: Math.max(prev?.handedBackAt ?? 0, s.handedBackAt ?? 0),
      tldr: s.tldr ?? prev?.tldr
    }
  }
  return { projects, asks: Object.fromEntries(asks.map((a) => [a.id, a.project ?? 'An agent'])) }
}

function finished(before: ProjectLook | undefined, now: ProjectLook): boolean {
  if (!before) return false
  return (
    now.handedBackAt > before.handedBackAt || (now.verdict === 'done' && before.verdict !== 'done')
  )
}

export function newsBetween(
  before: HideoutLook,
  now: HideoutLook,
  asks: HideoutAsk[]
): HideoutNews[] {
  const news: HideoutNews[] = []
  for (const [p, look] of Object.entries(now.projects)) {
    if (!finished(before.projects[p], look)) continue
    news.push({
      key: `done:${p}:${look.handedBackAt}:${look.verdict}`,
      project: p,
      line: pickLine(FINISHED, { p }),
      detail: look.tldr
    })
  }
  for (const a of asks) {
    if (before.asks[a.id]) continue
    const p = a.project ?? 'An agent'
    news.push({
      key: `ask:${a.id}`,
      project: p,
      line: pickLine(NEEDS, { p, q: question(a.question) })
    })
  }
  return news
}

function joinAnd(items: string[]): string {
  return items.length < 2
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

export function sinceLastLook(before: HideoutLook, now: HideoutLook): string | null {
  const entries = Object.entries(now.projects)
  const stuck = (v?: string): boolean => HIDEOUT_STUCK_VERDICTS.includes(v ?? '')
  const changes = [
    ...entries
      .filter(([p, look]) => finished(before.projects[p], look))
      .map(([p]) => `${p} finished`),
    ...[
      ...new Set(
        Object.entries(now.asks)
          .filter(([id]) => !before.asks[id])
          .map(([, p]) => p)
      )
    ].map((p) => `${p} has a new question`),
    ...entries
      .filter(
        ([p, look]) =>
          before.projects[p] && stuck(look.verdict) && !stuck(before.projects[p].verdict)
      )
      .map(([p]) => `${p} got stuck`),
    ...entries.filter(([p]) => !before.projects[p]).map(([p]) => `${p} started`),
    ...Object.keys(before.projects)
      .filter((p) => !now.projects[p])
      .map((p) => `${p} stopped`)
  ]
  if (!changes.length) return null
  const shown = changes.slice(0, 4)
  const more = changes.length - shown.length
  return `Since you last looked, ${joinAnd(more ? [...shown, `${more} more`] : shown)}.`
}

export function recapToday(list: AgentRelaySessionInfo[]): string {
  const byProject = new Map<string, { done: string[]; tldr?: string }>()
  for (const s of list) {
    const p = projectOf(s)
    const row = byProject.get(p) ?? { done: [] }
    const checklist = readSessionChecklist(s.sessionId)
    row.done.push(
      ...(checklist?.items.filter((i) => i.status === 'completed').map((i) => i.label) ?? [])
    )
    row.tldr ??= s.tldr
    byProject.set(p, row)
  }
  if (!byProject.size) return 'No agents ran today that I can see.'
  const rows = [...byProject.entries()]
    .sort((a, b) => b[1].done.length - a[1].done.length)
    .slice(0, 4)
  const lines = rows.map(([p, r]) => {
    const n = r.done.length
    if (!n)
      return r.tldr
        ? `${p} is on: ${r.tldr.replace(/[.]*$/, '')}.`
        : `${p} hasn't ticked anything off yet.`
    return `${p} got ${n} ${n === 1 ? 'thing' : 'things'} done, last one: ${r.done[n - 1].replace(/[.]*$/, '')}.`
  })
  const total = [...byProject.values()].reduce((n, r) => n + r.done.length, 0)
  const n = byProject.size
  const lead = total
    ? `${total} ${total === 1 ? 'thing' : 'things'} done across ${n} ${n === 1 ? 'agent' : 'agents'}.`
    : ''
  return [lead, ...lines].filter(Boolean).join(' ')
}
