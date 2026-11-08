import React, { useRef, useState } from 'react'
import { ThumbsUp, ThumbsDown, Check } from 'lucide-react'
import type { FeedbackRating } from '../../../shared/types'
import { Button } from './Button'

// How long the "Saved ✓" confirmation stays up after a note is committed.
const SAVED_FLASH_MS = 1600

/**
 * FeedbackRow — feedback under a finished run. Two shapes, keyed by `noteOnly`:
 *
 *  • Default (AI answer: ask / act / rewrite) — 👍 / 👎 that store immediately AND
 *    reveal a one-line note box. The note is the gold signal the model learns from:
 *      • 👎 → "what did you expect instead?"  (a correction the model stops repeating)
 *      • 👍 → "what worked well?"             (reinforcement the model keeps doing)
 *    The thumb alone is a valid rating; the box is a bonus, never a gate.
 *
 *  • noteOnly (user-generated capture: screenshot / screen-recording / listen) —
 *    NO thumbs. There's no AI answer to rate, so up/down is meaningless; we show
 *    only an "Add note" box. The note saves with rating=null (see FeedbackEntry).
 *
 * Optimistic in both shapes — the thumb fills / the note saves on blur/Enter via a
 * submit for the same run (latest-wins in the store, so re-submitting is safe).
 *
 * Self-contained on purpose: one instance per row, owns its own note draft. The
 * parent only supplies the current rating + an onSubmit(run_id-bound) callback.
 */
export function FeedbackRow({
  rating,
  note,
  noteOnly = false,
  onSubmit
}: {
  rating: FeedbackRating | null
  note: string | null
  /** Capture card (no AI answer) — show the note box only, no thumbs. */
  noteOnly?: boolean
  onSubmit: (rating: FeedbackRating | null, note?: string) => void
}): React.ReactElement {
  // Open the note box whenever a thumb is the current rating (so re-opening a row
  // shows whatever note was attached, on either side). In noteOnly mode the box is
  // always open — it's the only control there is.
  const [noteOpen, setNoteOpen] = useState(noteOnly || rating !== null)
  const [draft, setDraft] = useState(note ?? '')
  // Brief "Saved ✓" confirmation after a note is committed (Enter or blur), so the
  // user knows their note actually persisted — without it the save is invisible.
  const [saved, setSaved] = useState(false)
  // The value last committed, so a no-op blur (focus out without editing) doesn't
  // re-flash "Saved". Starts at the incoming note so re-opening an existing row is quiet.
  const lastSavedRef = useRef<string>((note ?? '').trim())
  const flashRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flashSaved = (): void => {
    setSaved(true)
    if (flashRef.current) clearTimeout(flashRef.current)
    flashRef.current = setTimeout(() => setSaved(false), SAVED_FLASH_MS)
  }

  const pick = (next: FeedbackRating): void => {
    // Keep any draft when re-picking the SAME thumb; clear it when flipping sides
    // (a 👍 note isn't a 👎 note). The box opens for both thumbs now.
    const keep = next === rating ? draft.trim() || undefined : undefined
    if (next !== rating) {
      setDraft('')
      lastSavedRef.current = ''
    }
    onSubmit(next, keep)
    setNoteOpen(true)
  }

  const saveNote = (): void => {
    // In noteOnly mode there's no thumb — a null rating is a valid note-only save.
    // In thumbs mode, a note without a thumb has nothing to attach to, so bail.
    if (!noteOnly && !rating) return
    const text = draft.trim()
    // An empty note in noteOnly mode is a no-op (nothing to persist, no thumb).
    if (noteOnly && !text && !lastSavedRef.current) return
    // Keep the current thumb (or null for a capture); attach/refresh the note.
    onSubmit(rating, text || undefined)
    // Confirm only when the note actually changed — a bare focus-out shouldn't claim
    // a save that didn't happen.
    if (text !== lastSavedRef.current) {
      lastSavedRef.current = text
      flashSaved()
    }
  }

  // Capture card (screenshot / recording / listen): no AI answer to rate, so we show
  // only an "Add note" box. Saves with rating=null.
  if (noteOnly) {
    return (
      <div className="feedback-row">
        <span className="feedback-label">Add note</span>
        <input
          type="text"
          className="feedback-note"
          placeholder="Add a note (optional)"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={saveNote}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
        />
        {saved && (
          <span className="feedback-saved" role="status" aria-live="polite">
            <Check size={12} strokeWidth={2.5} />
            Saved
          </span>
        )}
      </div>
    )
  }

  return (
    <div className="feedback-row">
      <span className="feedback-label">Was this good?</span>
      <Button
        variant="bare"
        className={`feedback-thumb ${rating === 'up' ? 'on up' : ''}`}
        onClick={() => pick('up')}
        aria-label="Good result"
        title="Good result"
      >
        <ThumbsUp size={13} strokeWidth={2.25} />
      </Button>
      <Button
        variant="bare"
        className={`feedback-thumb ${rating === 'down' ? 'on down' : ''}`}
        onClick={() => pick('down')}
        aria-label="Missed what I wanted"
        title="Missed what I wanted"
      >
        <ThumbsDown size={13} strokeWidth={2.25} />
      </Button>
      {noteOpen && (
        <input
          type="text"
          className="feedback-note"
          placeholder={rating === 'up' ? 'What worked well? (optional)' : 'What did you expect instead?'}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={saveNote}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.currentTarget.blur()
            }
          }}
        />
      )}
      {/* Confirmation that the note persisted — fades out on its own. aria-live so a
          screen reader announces the save too. */}
      {saved && (
        <span className="feedback-saved" role="status" aria-live="polite">
          <Check size={12} strokeWidth={2.5} />
          Saved
        </span>
      )}
    </div>
  )
}
