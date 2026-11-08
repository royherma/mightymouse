import React, { useEffect, useRef, useState } from 'react'
import { Check, X } from 'lucide-react'
import { CONFIG } from '../../../shared/config'
import { claimClickable, claimFocusable } from '../cursor-overlay-claims'
import { Button } from './Button'

// The hover-preview/edit panel for a 'write' suggestion. The model already drafted
// the body (`draft`); this lets the user SEE the full text, optionally tweak it, and
// confirm — the (possibly edited) result is what the parent pastes AND logs beside
// the draft as the training signal. Expands to the RIGHT of the chip, sized up to
// CONFIG.SUGGESTIONS.PREVIEW_MAX_WIDTH so a longer draft reads bigger but never runs
// off-screen.
//
// TWO STAGES — this is the focus-safety fix:
//   1. READ-ONLY (default, on hover): renders the draft as plain text. Claims ONLY
//      clickable (so buttons work), NEVER focusable, and does NOT focus anything. The
//      cursor overlay therefore never grabs OS keyboard focus, so the target web
//      compose field (X/LinkedIn contenteditable) keeps its caret — a subsequent
//      paste lands where the user is typing. This is what was broken before: the old
//      panel mounted straight into an editable textarea that stole focus and blurred
//      the compose field, so the paste went nowhere.
//   2. EDIT (opt-in, on clicking the draft): swaps to a textarea, claims focusable,
//      and focuses it. Focus moves ONLY because the user explicitly chose to edit —
//      they're no longer relying on the compose field's caret, so stealing focus is
//      fine here. ⌘⏎ / ✓ confirms, Esc closes without dismissing the bubble.

const SURFACE = CONFIG.THEME_TOKENS.surface1
const SURFACE_STRONG = CONFIG.THEME_TOKENS.surface2
const TEXT = CONFIG.THEME_TOKENS.onSurface
const MUTED = CONFIG.THEME_TOKENS.muted
const ACCENT = CONFIG.THEME_TOKENS.accent
const BORDER = CONFIG.THEME_TOKENS.accentBorderSubtle
const MAX_W = CONFIG.SUGGESTIONS.PREVIEW_MAX_WIDTH

export function SuggestionPreview({
  draft,
  onConfirm,
  onClose,
  onEditingChange,
  confirmLabel,
  claims = { clickable: claimClickable, focusable: claimFocusable }
}: {
  draft: string
  /** Fired with the (possibly edited) final text the user confirmed. */
  onConfirm: (finalText: string) => void
  onClose: () => void
  /** Reports edit-mode transitions so the parent can suppress hover-off auto-close
   *  while the user is typing. */
  onEditingChange?: (editing: boolean) => void
  /** Verb for the confirm button in read mode. Defaults to the paste wording. */
  confirmLabel?: string
  /** Which window's interactivity to claim. Defaults to the cursor overlay; the
   *  selection bar passes its own, since the claims drive a specific window and
   *  the wrong one leaves this panel unclickable. */
  claims?: { clickable: () => () => void; focusable: () => () => void }
}): React.ReactElement {
  const [text, setText] = useState(draft)
  const [editing, setEditing] = useState(false)
  const taRef = useRef<HTMLTextAreaElement>(null)

  // Surface edit-mode to the parent (mouse-leave auto-close is suppressed while editing).
  useEffect(() => {
    onEditingChange?.(editing)
  }, [editing, onEditingChange])

  // Read-only stage claims ONLY clickable — so the panel's buttons receive the mouse
  // even after the bubble's hover claim releases. We deliberately do NOT claim
  // focusable here: focusable flips the overlay so it can take OS keyboard focus,
  // which blurs the target compose field. Held for the panel's whole life; released
  // on unmount (refcounted — the overlay reverts only once no owner is left).
  useEffect(() => {
    const releaseClickable = claims.clickable()
    return releaseClickable
  }, [claims])

  // Edit stage ONLY: claim focusable + focus the textarea so keystrokes route to it.
  // Scoped to `editing` so hovering (read-only) never touches focus. Releasing the
  // focusable claim when the user exits edit mode flips the overlay back to
  // click-through, restoring the no-focus-theft invariant for the next paste.
  useEffect(() => {
    if (!editing) return
    const releaseFocusable = claims.focusable()
    const ta = taRef.current
    if (ta) {
      ta.focus()
      ta.setSelectionRange(ta.value.length, ta.value.length)
    }
    return releaseFocusable
  }, [editing, claims])

  // Auto-grow the textarea (edit stage only) to fit its content.
  useEffect(() => {
    const ta = taRef.current
    if (!ta || !editing) return
    ta.style.height = 'auto'
    ta.style.height = `${ta.scrollHeight}px`
  }, [text, editing])

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'Enter' && e.metaKey) {
      e.preventDefault()
      onConfirm(text)
    }
  }

  const edited = text !== draft

  // Clicking a button moves DOM focus to it by default — which BLURS the target
  // compose field (the whole bug). preventDefault on mousedown keeps focus where it
  // is, so Paste/Confirm fire WITHOUT stealing the caret. Skip this in edit mode for
  // the textarea (it legitimately needs focus), but the action buttons still use it.
  const keepFocus = (e: React.MouseEvent): void => {
    e.preventDefault()
  }

  return (
    <div
      style={{
        width: MAX_W,
        background: SURFACE,
        border: `1px solid ${BORDER}`,
        borderRadius: 8,
        padding: 8,
        boxShadow: '0 6px 20px rgba(0,0,0,0.28)',
        display: 'flex',
        flexDirection: 'column',
        gap: 8
      }}
    >
      {editing ? (
        <textarea
          ref={taRef}
          data-no-drag
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          maxLength={CONFIG.SUGGESTIONS.MAX_WRITE_CHARS}
          rows={1}
          style={{
            width: '100%',
            resize: 'none',
            maxHeight: 240,
            overflowY: 'auto',
            background: SURFACE_STRONG,
            color: TEXT,
            border: `1px solid ${BORDER}`,
            borderRadius: 6,
            padding: '8px 9px',
            fontSize: 12.5,
            lineHeight: 1.45,
            fontFamily: 'inherit',
            outline: 'none'
          }}
        />
      ) : (
        <div
          data-no-drag
          onClick={() => setEditing(true)}
          title="Click to edit"
          style={{
            width: '100%',
            maxHeight: 240,
            overflowY: 'auto',
            background: SURFACE_STRONG,
            color: TEXT,
            border: `1px solid ${BORDER}`,
            borderRadius: 6,
            padding: '8px 9px',
            fontSize: 12.5,
            lineHeight: 1.45,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            userSelect: 'none',
            cursor: 'text'
          }}
        >
          {text}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ color: MUTED, fontSize: 10.5, fontWeight: 600 }}>
          {edited ? 'edited' : 'draft'} · {text.length} chars ·{' '}
          {editing ? '⌘⏎ to confirm' : 'tap to edit'}
        </span>
        <div data-no-drag style={{ display: 'flex', gap: 6 }}>
          <Button
            variant="bare"
            onMouseDown={keepFocus}
            onClick={onClose}
            aria-label="Discard preview"
            style={{
              display: 'grid',
              placeItems: 'center',
              width: 26,
              height: 26,
              borderRadius: 6,
              border: `1px solid ${BORDER}`,
              background: SURFACE_STRONG,
              color: MUTED,
              cursor: 'pointer'
            }}
          >
            <X size={13} strokeWidth={2.3} />
          </Button>
          <Button
            variant="bare"
            onMouseDown={editing ? undefined : keepFocus}
            onClick={() => onConfirm(text)}
            aria-label="Confirm and paste"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              height: 26,
              padding: '0 10px',
              borderRadius: 6,
              border: `1px solid ${CONFIG.THEME_TOKENS.accentBorderSubtle}`,
              background: CONFIG.THEME_TOKENS.accentBgSubtle,
              color: ACCENT,
              fontSize: 11,
              fontWeight: 800,
              cursor: 'pointer'
            }}
          >
            <Check size={13} strokeWidth={2.6} />
            {editing ? 'Confirm' : (confirmLabel ?? 'Paste')}
          </Button>
        </div>
      </div>
    </div>
  )
}
