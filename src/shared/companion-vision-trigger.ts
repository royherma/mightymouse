/**
 * Live Voice Companion — screen-aware vision trigger (Phase 4 of the PRD,
 * prds/active/2026-07-12-1783824131-live-voice-companion.md §5).
 *
 * A voice turn should NOT attach a screenshot on every utterance — per the
 * PRD's reality-check table, a vision frame costs real image tokens on top of
 * a text turn, and "always on" cadence could get expensive fast if every turn
 * paid for one. This is a cheap, synchronous keyword gate (matches the
 * `mightBeRecall` gate's role in the history-recall pipeline: a free filter
 * before anything that costs money runs) — a simple regex over a small named
 * keyword list, not a classifier call.
 *
 * Named const array + typed function per the repo's no-magic-strings rule —
 * nothing compares a transcript against a hand-typed string inline.
 */

/**
 * Words/phrases that suggest the user is referencing something currently on
 * their screen. Deliberately small and cheap — false positives just attach a
 * screenshot that goes unused by the answer; false negatives just mean the
 * companion answers without seeing the screen. Neither is catastrophic, so
 * this stays a simple keyword list rather than a tuned classifier.
 */
export const COMPANION_VISION_TRIGGER_KEYWORDS = [
  'this',
  'that',
  'here',
  'screen',
  'look at',
  'see this',
  'see that',
  'what is this',
  "what's this",
  'on my screen',
  'this page',
  'this window',
  'this error',
  'this code'
] as const

export type CompanionVisionTriggerKeyword = (typeof COMPANION_VISION_TRIGGER_KEYWORDS)[number]

/** One compiled `\bword\b` (or phrase) matcher per keyword, built once at module load. */
const TRIGGER_PATTERN = new RegExp(
  `\\b(${COMPANION_VISION_TRIGGER_KEYWORDS.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
  'i'
)

/**
 * True if `transcript` looks like it's referencing on-screen content. Pure,
 * synchronous, no I/O — safe to call on every transcript before deciding
 * whether to pay for a screenshot + vision attach.
 */
export function looksLikeScreenReference(transcript: string): boolean {
  const t = transcript.trim()
  if (!t) return false
  return TRIGGER_PATTERN.test(t)
}
