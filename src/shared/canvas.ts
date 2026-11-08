import type { MediaAttachment, MightySession, RunFailReason } from './types'
import { runLabel } from './model-label'

export const CANVAS_SANDBOX = 'sandbox'
export const SESSION_DRAG_TYPE = 'application/x-mightymouse-session'
export const CODE_DRAG_TYPE = 'application/x-mightymouse-code'

export type CanvasSessionRef =
  | { kind: 'chat'; id: string }
  | { kind: 'code'; id: string; title: string; cwd?: string }

export function writeCodeDrag(dt: DataTransfer, ref: Omit<Extract<CanvasSessionRef, { kind: 'code' }>, 'kind'>): void {
  dt.setData(CODE_DRAG_TYPE, JSON.stringify(ref))
  dt.effectAllowed = 'copy'
}

export function readSessionDrag(dt: DataTransfer): CanvasSessionRef | null {
  const chat = dt.getData(SESSION_DRAG_TYPE)
  if (chat) return { kind: 'chat', id: chat }
  try {
    const code = JSON.parse(dt.getData(CODE_DRAG_TYPE) || 'null')
    return code?.id ? { kind: 'code', id: code.id, title: code.title ?? code.id, cwd: code.cwd } : null
  } catch {
    return null
  }
}

export const OPEN_CODE_EVENT = 'mm:open-code-session'

export type CanvasBubbleKind = 'idea' | 'question' | 'file' | 'step' | 'thread' | 'answer'
export type CanvasAuthor = 'you' | 'ai'

export interface CanvasBubble {
  id: string
  kind: CanvasBubbleKind
  text: string
  /** A MightyProject id, or CANVAS_SANDBOX when no project fits yet. */
  planet: string
  tags: string[]
  by: CanvasAuthor
  created: string
  /** Set on a step: the bubble whose thread it continues. */
  parent?: string
  /** Set on a thread bubble: the Mighty chat it opens. */
  sessionId?: string
  /** Set on a thread bubble for a Code session instead of a chat. */
  codeRef?: string
  imagePath?: string
  attachments?: MediaAttachment[]
  /** Where the person dropped it; layout leaves it there until Clean up. */
  at?: { x: number; y: number }
  w?: number
  h?: number
  task?: boolean
  media?: string[]
  /** Next moves offered for this bubble's thread, newest step last. */
  directions?: string[]
  done?: boolean
  /** Which backend and model wrote this answer, as runLabel() renders it. */
  ran?: string
  /** Set while the last filing or chat run for this bubble failed; cleared on retry. */
  stuck?: { stage: CanvasStage; reason: CanvasFail }
}

export type CanvasStage = 'file' | 'chat'
export type CanvasFail = RunFailReason | 'empty'

export interface CanvasLink {
  id: string
  from: string
  to: string
  why: string
  by: CanvasAuthor
}

export interface CanvasState {
  version: 1
  bubbles: CanvasBubble[]
  links: CanvasLink[]
  /** Spots the person dragged projects to; the rest arrange around them. */
  places?: Record<string, { x: number; y: number }>
  strokes?: CanvasStroke[]
  /** Projects added with + so they show even with no notes yet. */
  planets?: string[]
}

export type CanvasInk = 'ink' | 'accent' | 'green' | 'red'

/** A freehand drawing in world coordinates; points are flat x,y pairs. */
export interface CanvasStroke {
  id: string
  points: number[]
  ink: CanvasInk
}

export const EMPTY_CANVAS: CanvasState = { version: 1, bubbles: [], links: [] }

export interface CanvasBoardSummary {
  id: string
  title: string
  updated: string
  count: number
  current: boolean
}

/** What the dispatcher does with a new bubble: send it into a matching chat, start a chat, or keep it. */
export type CanvasAction = 'continue' | 'chat' | 'note'

/** What the model decides about one new bubble. Ids it names are already validated. */

export interface CanvasThought {
  action: CanvasAction
  planet: string
  guesses: string[]
  tags: string[]
  related: Array<{ id: string; why: string }>
  session?: { id: string; why: string }
  /** A chat already holding this note unanswered (a voice capture parks one); run there, not in a twin. */
  own?: string
  directions: string[]
}

export type CanvasThinkResult =
  | { ok: true; thought: CanvasThought }
  | { ok: false; reason: RunFailReason }
export type CanvasDirectionsResult =
  | { ok: true; directions: string[] }
  | { ok: false; reason: RunFailReason }

export interface CanvasThinkContext {
  projects: Array<{ id: string; name: string; about: string; inside?: string[] }>
  chats: Array<{ id: string; title: string; project: string | null; minutesAgo: number }>
  notes: Array<{ id: string; text: string; planet: string; tags: string[] }>
}

export function firstJson(text: string): Record<string, unknown> | null {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    return JSON.parse(m[0]) as Record<string, unknown>
  } catch {
    return null
  }
}

export const shortList = (v: unknown, max: number): string[] =>
  Array.isArray(v)
    ? v
        .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
        .map((x) => x.trim())
        .slice(0, max)
    : []

/** Parses the model's answer; any id it names that is not in `ctx` is dropped. */
export function readThought(
  answer: string,
  note: string,
  ctx: CanvasThinkContext
): CanvasThought | null {
  const j = firstJson(answer)
  if (!j) return null
  const projectIds = new Set(ctx.projects.map((p) => p.id))
  const noteIds = new Set(ctx.notes.map((b) => b.id))
  const chatIds = new Set(ctx.chats.map((c) => c.id))
  const planet =
    typeof j.planet === 'string' && projectIds.has(j.planet) ? j.planet : CANVAS_SANDBOX
  const related = (Array.isArray(j.related) ? j.related : [])
    .map((x) => x as { id?: unknown; why?: unknown })
    .filter((x) => typeof x.id === 'string' && noteIds.has(x.id))
    .slice(0, 3)
    .map((x) => ({ id: x.id as string, why: typeof x.why === 'string' ? x.why : 'related' }))
  const s = j.session as { id?: unknown; why?: unknown } | null | undefined
  const session =
    s && typeof s.id === 'string' && chatIds.has(s.id)
      ? { id: s.id, why: typeof s.why === 'string' ? s.why : 'same thread' }
      : undefined
  const tags = shortList(j.tags, 6).map((t) => t.toLowerCase())
  const wantsAnswer = j.action === 'chat' || j.action === 'continue' || isQuestion(note)
  const action: CanvasAction = !wantsAnswer ? 'note' : session ? 'continue' : 'chat'
  const guesses =
    planet === CANVAS_SANDBOX
      ? [...new Set(shortList(j.guesses, 6).filter((id) => projectIds.has(id)))].slice(0, 3)
      : []
  return {
    action,
    planet,
    guesses,
    tags: tags.length ? tags : localTags(note),
    related,
    session,
    directions: shortList(j.directions, 3)
  }
}

const FAIL_TEXT: Record<CanvasStage, Partial<Record<CanvasFail, string>> & { other: string }> = {
  file: {
    signed_out: 'Sign in to MightyMouse to sort this',
    out_of_credits: 'Out of credits - kept in Sandbox',
    timeout: 'Took too long to sort - kept in Sandbox',
    other: 'Could not sort it - kept in Sandbox'
  },
  chat: {
    signed_out: 'Sign in to MightyMouse to run this',
    out_of_credits: 'Out of credits for this chat',
    timeout: 'The chat took too long',
    empty: 'The chat finished with no answer',
    other: 'The chat failed'
  }
}

export const canvasFailText = (stage: CanvasStage, reason: CanvasFail): string =>
  FAIL_TEXT[stage][reason] ?? FAIL_TEXT[stage].other

export type CanvasChatStatus = 'running' | 'done' | 'failed'

export function chatStatus(s?: MightySession): CanvasChatStatus | undefined {
  if (!s) return undefined
  if (s.runId) return 'running'
  return s.turns.at(-1)?.ok === false ? 'failed' : 'done'
}

/** "Claude · opus" for the newest turn that names a backend. */
export function chatRan(s?: MightySession): string | undefined {
  const t = [...(s?.turns ?? [])].reverse().find((x) => x.backend)
  return t ? runLabel(t.backend, t.model) : undefined
}

const STOP = new Set(
  'about after again also been before being could does doing from have into just like make more most much need only other over same should some than that their them then there these they this those very want what when where which while will with would your'.split(
    ' '
  )
)

/** Cheap local tags so a bubble is findable even when the model call fails. */
export function localTags(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? []
  return [...new Set(words.filter((w) => !STOP.has(w)))].slice(0, 6)
}

export function isQuestion(text: string): boolean {
  return /\?\s*$|^(what|how|which|why|when|who|should|can|can ?u|could|would|will|please|pls|is|are|do|does)\b/i.test(
    text.trim()
  )
}
