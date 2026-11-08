import { readdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { AgentChecklist, AgentChecklistItem } from '../../shared/types'

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/
const GOAL_PREFIX = 'GOAL:'
const WAITING_PREFIX = 'WAITING ON ROY:'
const MAX_ITEMS = 40
const SUBJECT_MAX = 300

export function checklistDir(home: string, sessionId: string): string {
  if (!home || !sessionId || !SAFE_ID.test(sessionId)) return ''
  return join(home, '.claude', 'tasks', sessionId)
}

function numericId(name: string): number {
  const n = Number(name.replace(/\.json$/, ''))
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER
}

const ENTITIES: Record<string, string> = {
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&amp;': '&'
}

// Subjects arrive HTML-escaped from some harnesses; a rail row must not read
// "&lt;sessionId&gt;". `&amp;` resolves last or it would re-escape the rest.
function decode(text: string): string {
  return text.replace(/&(?:lt|gt|quot|#39|amp);/g, (m) => ENTITIES[m] ?? m)
}

function status(raw: unknown): AgentChecklistItem['status'] {
  if (raw === 'completed') return 'completed'
  if (raw === 'in_progress') return 'in_progress'
  return 'pending'
}

export function readSessionChecklist(sessionId: string | undefined): AgentChecklist | undefined {
  const dir = checklistDir(process.env.HOME || homedir(), sessionId ?? '')
  if (!dir) return undefined

  let names: string[]
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json'))
  } catch {
    return undefined
  }
  if (names.length === 0) return undefined

  names.sort((a, b) => numericId(a) - numericId(b))

  let goal: string | undefined
  const items: AgentChecklistItem[] = []
  for (const name of names) {
    let parsed: { subject?: unknown; status?: unknown }
    try {
      parsed = JSON.parse(readFileSync(join(dir, name), 'utf8'))
    } catch {
      continue
    }
    const subject = typeof parsed.subject === 'string' ? decode(parsed.subject).trim() : ''
    if (!subject) continue

    if (subject.startsWith(GOAL_PREFIX)) {
      // Last GOAL wins: a second one means the user moved the goal, and the dir is
      // walked oldest-id first, so keeping the first showed a retired goal.
      goal = subject.slice(GOAL_PREFIX.length).trim().slice(0, SUBJECT_MAX)
      continue
    }
    if (items.length >= MAX_ITEMS) continue

    const waiting = subject.startsWith(WAITING_PREFIX)
    items.push({
      label: (waiting ? subject.slice(WAITING_PREFIX.length).trim() : subject).slice(0, SUBJECT_MAX),
      status: status(parsed.status),
      waiting: waiting || undefined
    })
  }

  if (!goal && items.length === 0) return undefined
  return { goal, items, done: items.filter((i) => i.status === 'completed').length }
}

export function checklistProgress(sessionId: string | undefined): number | undefined {
  const list = readSessionChecklist(sessionId)
  return list && list.items.length > 0 ? list.done / list.items.length : undefined
}
