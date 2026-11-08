import type { ChatProjectWire } from '@shared/phone-remote-protocol'

/** One session row in the picker, mirrored from the server's 'chatSessions'. */
export type ChatSessionSummary = {
  id: string
  title: string
  updated: string
  messageCount: number
  preview: string
  /** A run is still going in this thread, per the Mac. The picker says so
   *  because the preview cannot: an unresolved turn previews its QUESTION, so a
   *  running thread and a finished one with a terse reply look identical. */
  running: boolean
  /** What that run is doing right now ("Reading  App.tsx"), merged in by App.tsx
   *  from the live 'chatSessionPhase' push. Only read when `running`. */
  phase?: string
  project?: ChatProjectWire
  /** Position of its section in the Mac sidebar: pinned projects, pinned chats, projects, loose chats. */
  group: number
  pinned?: boolean
}

/** One activity step of a turn: the backend's phase headline plus the specific
 *  subject it applies to (a filename, a command), '' when there is none. `n`
 *  counts how many consecutive identical events collapsed into this row -- see
 *  App.tsx's appendStep. */
export type ChatStep = { phase: string; detail: string; n: number }

/** One exchange in an open thread, mirrored from the server's 'chatSession'.
 *  `fromPhone` rather than the app's MightyRunSource: the phone bundle is
 *  deliberately kept ignorant of the Mac's domain types (same reason server.ts
 *  flattens it on the way out). */
export type ChatTurn = {
  fromPhone: boolean
  q: string
  a: string
  ts: string
  ok: boolean
  /** The activity steps this turn ran, attached when it settled. Absent on turns
   *  loaded from the Mac's history: steps are live-only, not persisted, so an
   *  older thread simply has no summary line rather than a fake empty one. */
  steps?: ChatStep[]
  /** Images and video this turn carries. Indices, not paths -- the phone asks
   *  /chat-media for item N of turn M and the Mac decides what that is. `mine`
   *  separates what the user attached from what the agent produced, which is
   *  what puts a photo in the ask bubble and a screenshot in the reply. */
  media?: { turn: number; item: number; kind: 'image' | 'video'; name: string; mine: boolean }[]
}

/** The thread currently open in the sheet, plus whether its history was capped. */
export type OpenChatThread = {
  id: string
  title: string
  turns: ChatTurn[]
  truncated: boolean
  /** A run is still going in this thread. Carried on the thread (not just the
   *  transient busy flag) so reopening or reconnecting mid-run resumes the
   *  in-flight view instead of presenting the unanswered turn as finished. */
  running: boolean
}

/**
 * Fold one phase event into the step list.
 *
 * Its own module rather than a helper inside App.tsx so it can be tested without
 * dragging the whole app's import graph (and the `@shared` alias, which only the
 * phone's own Vite config resolves) into a unit test. Pure by design: the
 * collapsing rules are the difference between a useful progress list and a wall
 * of noise, and both failure modes are invisible until a real 3-minute run hits
 * them.
 *
 * Two rules:
 *   - Consecutive identical (phase, detail) events COLLAPSE into the last row and
 *     bump its count. A streaming backend emits "Writing" on essentially every
 *     chunk; without this a single reply produces 40 identical rows and buries
 *     the tool calls that actually say what happened.
 *   - The list is capped at `limit`, dropping from the FRONT. Mid-run you want the
 *     last few things it did; the full trail is the Mac's job (Run Transcript
 *     Inspector), and on a phone every extra row pushes the answer off screen.
 */
export function appendStep(
  prev: ChatStep[],
  phase: string,
  detail: string,
  limit: number
): ChatStep[] {
  if (phase.trim() === '') return prev
  const last = prev[prev.length - 1]
  if (last && last.phase === phase && last.detail === detail) {
    const bumped = [...prev]
    bumped[bumped.length - 1] = { ...last, n: last.n + 1 }
    return bumped
  }
  const next = [...prev, { phase, detail, n: 1 }]
  return next.length > limit ? next.slice(next.length - limit) : next
}

/** What a live run says before its first phase arrives — the one moment there
 *  is genuinely nothing more specific to show. Every surface that renders a
 *  running state falls back to this, so they can't drift apart. */
export const RUNNING_FALLBACK = 'Running…'

/** How much of a step's detail the one-line toast keeps. A path or a shell
 *  command is the useful part of a phase, but the toast is a single centred
 *  line on a phone -- past this it wraps and starts covering the trackpad. */
const TOAST_DETAIL_MAX = 22

/**
 * The one-line label for a live run: the phase that's running right now, plus
 * as much of its detail as fits.
 *
 * Exists because a frozen "Running…" for the length of an agentic run is
 * indistinguishable from a hang -- the steps were already streaming in, but
 * only the expanded sheet ever showed them, and that costs a tap you can't
 * know is worth making. `fallback` covers the window before the first step
 * lands (and 'Stopping…', which has no step of its own).
 */
export function runningLabel(steps: ChatStep[], fallback: string): string {
  const last = steps[steps.length - 1]
  if (!last || last.phase.trim() === '') return fallback
  const detail = last.detail.replace(/\s+/g, ' ').trim()
  if (detail === '') return last.phase
  // Truncate from the FRONT: a path's tail (the filename) identifies it, its
  // head is the repo root every step shares.
  const short =
    detail.length > TOAST_DETAIL_MAX ? `…${detail.slice(detail.length - TOAST_DETAIL_MAX)}` : detail
  return `${last.phase}  ${short}`
}
