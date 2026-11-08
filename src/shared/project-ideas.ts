import type { BusinessType, ProjectBrief } from './infra'
import { projectFacts } from './playbooks'

export const PROJECT_IDEA_KINDS =['finish', 'next', 'fix', 'try'] as const
export type ProjectIdeaKind = (typeof PROJECT_IDEA_KINDS)[number]

export interface ProjectIdea {
  kind: ProjectIdeaKind
  emoji?: string
  label: string
  prompt: string
  why?: string
  detail?: string
}

export type ProjectIdeaVerdict = 'done' | 'bad'

export interface ProjectIdeaFeedback {
  label: string
  why?: string
  verdict: ProjectIdeaVerdict
  at: number
}

export interface ProjectIdeasResult {
  ideas: ProjectIdea[]
  at: number
  stale: boolean
}

export interface ProjectSignals {
  name: string
  branch?: string
  uncommitted?: string[]
  unpushed?: number
  recentCommits?: string[]
  plans?: string[]
  notes?: string
  recentAsks?: string[]
  sessionTitles?: string[]
  feedback?: ProjectIdeaFeedback[]
  business?: BusinessType[]
  brief?: ProjectBrief
}

export const MAX_PROJECT_IDEAS = 6
const MAX_LABEL = 32
const MAX_PROMPT = 700
const PROMPT_HARD_CAP = 1200
const MAX_WHY = 90
const MAX_DETAIL = 140

function feedbackLines(feedback: ProjectIdeaFeedback[] | undefined, verdict: ProjectIdeaVerdict): string[] | undefined {
  const rows = (feedback ?? [])
    .filter((f) => f.verdict === verdict)
    .map((f) => (f.why ? `${f.label} (${f.why})` : f.label))
  return rows.length ? rows : undefined
}

export function projectIdeasPrompt(signals: ProjectSignals): string {
  const json = JSON.stringify(
    {
      project: signals.name,
      branch: signals.branch,
      uncommitted_files: signals.uncommitted?.length ? signals.uncommitted : undefined,
      unpushed_commits: signals.unpushed || undefined,
      recent_commits: signals.recentCommits?.length ? signals.recentCommits : undefined,
      plans_and_prds: signals.plans?.length ? signals.plans : undefined,
      notes_or_todo: signals.notes?.trim() || undefined,
      what_the_user_recently_asked_agents: signals.recentAsks?.length
        ? signals.recentAsks
        : undefined,
      recent_agent_session_titles: signals.sessionTitles?.length ? signals.sessionTitles : undefined,
      user_says_already_done: feedbackLines(signals.feedback, 'done'),
      user_rejected_as_not_useful: feedbackLines(signals.feedback, 'bad')
    },
    null,
    2
  )
  const facts = projectFacts(signals.business ?? [], signals.brief)
  return [
    'You help a developer decide what to hand a coding agent next in one project.',
    'Here is what we can see of the project and their recent work in it:',
    '',
    json,
    '',
    ...(facts ? [`${facts} Prefer ideas that move one of these numbers, and name it in "why" when one does.`, ''] : []),
    `Write up to ${MAX_PROJECT_IDEAS} ideas for what to start next. Mix these kinds:`,
    '- "finish": work that looks started and not closed (uncommitted files, a half-done ask, an open plan).',
    '- "next": the obvious next step toward a goal the plans or commits point at.',
    '- "fix": a bug or rough edge the recent work hints at.',
    '- "try": one bolder idea worth an experiment, grounded in this project.',
    'Rules:',
    '- Reply with a JSON array and nothing else. No prose, no code fence.',
    '- Each item: {"kind": "...", "emoji": "<one emoji>", "label": "...", "prompt": "...", "why": "...", "detail": "..."}.',
    `- "label": 2-5 words, under ${MAX_LABEL} characters, names the outcome. No trailing period.`,
    `- "prompt": the full instruction to the agent, under ${MAX_PROMPT} characters. Name the real files, plans or commits it builds on, and say what done looks like.`,
    `- "why": under ${MAX_WHY} characters, the evidence you saw ("3 files uncommitted in src/auth").`,
    `- "detail": under ${MAX_DETAIL} characters, one plain sentence on what the agent will do and what you get at the end. No file paths.`,
    '- Every idea must point at something in the data above. Never invent files or features.',
    '- Prefer finishing over starting. Do not repeat the same idea twice.',
    '- Never suggest anything in user_says_already_done: that work is finished even if the data still hints at it. Treat the signals behind it as closed.',
    '- Never suggest anything in user_rejected_as_not_useful or close to it. Learn what they do not want and aim elsewhere.',
    '- Plain words. If there is too little to go on, reply with [].'
  ].join('\n')
}

export type ProjectIdeaCheck = { done: true } | { done: false; reason: string }

export function doneCheckPrompt(idea: { label: string; prompt: string; why?: string }): string {
  return [
    'A developer says this task in the current repository is already finished:',
    '',
    JSON.stringify({ task: idea.label, what_it_asked_for: idea.prompt, evidence_it_was_open: idea.why }, null, 2),
    '',
    'Check the code, git log and git status in this folder to see if that is true. Read only: never edit, commit or run builds.',
    'Reply with one JSON object and nothing else: {"done": true} or {"done": false, "reason": "<under 90 characters, what is still missing>"}.',
    'If you cannot tell, reply {"done": true}.'
  ].join('\n')
}

export function parseDoneCheck(raw: string): ProjectIdeaCheck {
  const match = raw.match(/\{[^{}]*"done"[^{}]*\}/g)?.pop()
  try {
    const row = JSON.parse(match ?? '') as { done?: unknown; reason?: unknown }
    if (row.done !== false) return { done: true }
    const reason = typeof row.reason === 'string' ? row.reason.trim().slice(0, MAX_WHY) : ''
    return { done: false, reason: reason || 'Still looks unfinished' }
  } catch {
    return { done: true }
  }
}

function clip(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text && text.length <= max ? text : undefined
}

function firstEmoji(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const match = value
    .trim()
    .match(/^\p{Extended_Pictographic}[\u{1F3FB}-\u{1F3FF}]?\uFE0F?(?:\u200D\p{Extended_Pictographic}\uFE0F?)*/u)
  return match?.[0]
}

function lastJsonArray(raw: string): unknown[] | null {
  for (let end = raw.lastIndexOf(']'); end >= 0; end = raw.lastIndexOf(']', end - 1)) {
    for (
      let start = raw.lastIndexOf('[', end);
      start >= 0;
      start = raw.lastIndexOf('[', start - 1)
    ) {
      try {
        const parsed: unknown = JSON.parse(raw.slice(start, end + 1))
        if (Array.isArray(parsed) && (parsed.length === 0 || typeof parsed[0] === 'object'))
          return parsed
      } catch {
        continue
      }
    }
  }
  return null
}

export function parseProjectIdeas(raw: string): ProjectIdea[] {
  const parsed = lastJsonArray(raw)
  if (!parsed) return []
  const out: ProjectIdea[] = []
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const label = clip(row.label, MAX_LABEL)?.replace(/\.$/, '')
    const prompt = clip(row.prompt, PROMPT_HARD_CAP)
    if (!label || !prompt) continue
    if (out.some((i) => i.label.toLowerCase() === label.toLowerCase())) continue
    const kind = PROJECT_IDEA_KINDS.includes(row.kind as ProjectIdeaKind)
      ? (row.kind as ProjectIdeaKind)
      : 'next'
    out.push({
      kind,
      label,
      prompt,
      emoji: firstEmoji(row.emoji),
      why: clip(row.why, MAX_WHY),
      detail: clip(row.detail, MAX_DETAIL)
    })
    if (out.length === MAX_PROJECT_IDEAS) break
  }
  return out
}
