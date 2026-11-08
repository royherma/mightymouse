import React, { useRef, useState } from 'react'
import { Sparkles } from 'lucide-react'
import { CONFIG } from '../../../shared/config'
import { SuggestionPreview } from './SuggestionPreview'
import { useHoverIntent } from '../hooks/useHoverIntent'

// ── Suggestion Lab ────────────────────────────────────────────────────────────
// A SERVER-FREE sandbox for the WRITE suggestion bubble's hover → preview → edit →
// paste interaction. Lives in the Playground window (a normal, focusable, fully-
// interactive BrowserWindow) so we can iterate the behavior in SECONDS against
// canned drafts — no 10-17s suggestion round-trip, no cursor-overlay click-through
// / focus-theft games to fight while designing the UX.
//
// WHY this exists: the real bubble renders inside the fullscreen click-through
// cursor overlay. On macOS that overlay receives NO mouse-move events at rest
// (verified: setIgnoreMouseEvents forward:true still delivered zero hover events to
// its DOM), so the chips' onMouseEnter never fires when the bubble pops under a
// stationary cursor → no hover, no preview, dead clicks. That's an OVERLAY-DELIVERY
// problem, separate from the interaction DESIGN. Here we nail the design (single
// preview at a time, hover-to-open, hover-off-to-dismiss, edit + confirm, paste
// lands the exact text) in a window where hover/click just work. Once the design is
// locked, we port it back + solve overlay delivery separately.
//
// THE COMPOSER IS A REAL, FOCUSED TEXTAREA — this is the whole point. The actual
// bug is about FOCUS: I click into the composer, my caret lives there, then I hover
// a chip's preview. The preview must NOT steal that caret while I read it; clicking
// Paste must insert the draft AT MY CARET and leave the composer focused. A static
// "result" div couldn't test that. So paste is mocked at the MECHANISM level (no AX
// + Cmd+V) but lands the text into a genuinely-focused field via the DOM, so the
// focus-vs-clickability behavior is exercised for real:
//   - read-only preview claims NO focus  → composer keeps its caret while I read.
//   - Paste                              → inserts at the composer's caret, refocuses it.
//   - Edit (pencil)                      → focus moves to the preview's textarea ONLY then.

const SURFACE = CONFIG.THEME_TOKENS.surface1
const SURFACE_STRONG = CONFIG.THEME_TOKENS.surface2
const TEXT = CONFIG.THEME_TOKENS.onSurface
const MUTED = CONFIG.THEME_TOKENS.muted
const BLUE = CONFIG.THEME_TOKENS.accent
const BORDER = CONFIG.THEME_TOKENS.accentBorderSubtle
const GAP = 8

// Canned drafts — one short, one long (to exercise the scroll + auto-grow paths),
// plus a non-write "run" chip with no draft (hover should NOT open a panel).
type LabChip = { label: string; mode: string; kind: 'write' | 'run'; draft?: string }
const LAB_CHIPS: LabChip[] = [
  {
    label: 'Reply: thank them + one specific follow-up',
    mode: 'write',
    kind: 'write',
    draft: 'Really appreciate you sharing this. The point about shipping the seatbelt before the speed resonated. Quick follow-up: how do you decide which guardrail is worth the latency when the team is moving fast?'
  },
  {
    label: 'Reply: agree, add a sharper example',
    mode: 'write',
    kind: 'write',
    draft: 'Hard agree. The version I keep coming back to: a refactor that fights the architecture is the architecture asking for a second look, not the change. Cheapest signal I have for "is this in-scope" is whether the pattern already exists one import away.\n\nWhen it does, extend it. When the same shape shows up a third time, that is the extraction telling you it is overdue. Everything before that is speculative.'
  },
  { label: 'Summarize this thread', mode: 'ask', kind: 'run' }
]

// One chip row, mirroring SuggestionChip's hover/preview contract exactly:
//  - onMouseEnter opens THIS chip's preview (and the list closes any other → one panel).
//  - the GROUP wrapper's onMouseLeave auto-closes on hover-off, UNLESS editing.
//  - clicking the chip body "pastes" the draft as-is (mocked).
function LabChipRow({
  chip,
  index,
  previewOpen,
  onOpenPreview,
  onClosePreview,
  onPaste
}: {
  chip: LabChip
  index: number
  previewOpen: boolean
  onOpenPreview: () => void
  onClosePreview: () => void
  onPaste: (text: string) => void
}): React.ReactElement {
  const [hover, setHover] = useState(false)
  const [editing, setEditing] = useState(false)
  const hasDraft = chip.kind === 'write' && (chip.draft || '').length > 0
  // Grace-timer close: bridges the chip↔panel seam (see useHoverIntent). Mirrors the
  // live SuggestionChip in CursorApp so the lab tests the real behavior.
  const { cancelClose, scheduleClose } = useHoverIntent(onClosePreview)

  return (
    <div
      style={{ position: 'relative' }}
      onMouseEnter={cancelClose}
      onMouseLeave={() => {
        if (previewOpen && !editing) scheduleClose()
      }}
    >
      <div
        role="button"
        onMouseEnter={() => {
          cancelClose()
          setHover(true)
          if (hasDraft) onOpenPreview()
        }}
        onMouseLeave={() => setHover(false)}
        onClick={() => (hasDraft ? onPaste(chip.draft || '') : undefined)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: GAP,
          minHeight: 30,
          padding: '6px 8px',
          borderRadius: 6,
          cursor: 'pointer',
          background: hover ? CONFIG.THEME_TOKENS.accentBgSubtle : SURFACE_STRONG,
          boxShadow: hover ? `inset 0 0 0 1px ${BORDER}` : 'none',
          transition: 'background 120ms ease, box-shadow 120ms ease'
        }}
      >
        <span style={{ width: 20, color: hover ? BLUE : MUTED, fontWeight: 700, fontSize: 11 }}>
          {index + 1}
        </span>
        <span
          style={{
            flex: 1,
            color: TEXT,
            fontWeight: 650,
            fontSize: 12,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {chip.label}
        </span>
        <span
          style={{
            textAlign: 'center',
            borderRadius: 6,
            padding: '3px 8px',
            color: BLUE,
            background: CONFIG.THEME_TOKENS.accentBgSubtle,
            border: `1px solid ${BORDER}`,
            fontSize: 10,
            fontWeight: 800,
            textTransform: 'uppercase'
          }}
        >
          {chip.kind === 'write' ? 'write' : chip.mode}
        </span>
      </div>
      {previewOpen && hasDraft && (
        <div
          style={{ position: 'absolute', left: '100%', top: 0, paddingLeft: GAP, zIndex: 10 }}
        >
          <SuggestionPreview
            draft={chip.draft || ''}
            onEditingChange={setEditing}
            onConfirm={(finalText) => {
              onClosePreview()
              onPaste(finalText)
            }}
            onClose={onClosePreview}
          />
        </div>
      )}
    </div>
  )
}

export function SuggestionLab(): React.ReactElement {
  // Single-preview invariant: the list owns which chip's preview is open.
  const [openIndex, setOpenIndex] = useState<number | null>(null)
  // The mock composer — a REAL focused textarea. `composerFocused` mirrors whether
  // it currently holds the caret so we can SEE focus theft the instant it happens.
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const [composerText, setComposerText] = useState('Type here first, leave your caret, THEN hover a chip. Paste should drop in at the caret and keep this field focused.')
  const [composerFocused, setComposerFocused] = useState(false)
  const [pasteCount, setPasteCount] = useState(0)

  // Insert `text` at the composer's caret (like a real paste), then refocus it.
  // This is the behavior the live paste must match: land at the caret, field stays
  // focused. We splice into state at the saved selection so the result is identical
  // to a Cmd+V into a focused field.
  const onPaste = (text: string): void => {
    const ta = composerRef.current
    const start = ta?.selectionStart ?? composerText.length
    const end = ta?.selectionEnd ?? composerText.length
    const next = composerText.slice(0, start) + text + composerText.slice(end)
    setComposerText(next)
    setPasteCount((c) => c + 1)
    // Refocus + drop the caret after the inserted text, next tick (after re-render).
    requestAnimationFrame(() => {
      const el = composerRef.current
      if (!el) return
      el.focus()
      const caret = start + text.length
      el.setSelectionRange(caret, caret)
    })
  }

  return (
    <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      {/* The bubble mock — same chrome the real cursor bubble uses. */}
      <div
        style={{
          width: 340,
          background: SURFACE,
          border: `1px solid ${BORDER}`,
          borderRadius: 12,
          padding: 12,
          boxShadow: '0 10px 30px rgba(0,0,0,0.35)'
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: GAP,
            marginBottom: GAP,
            color: MUTED,
            fontSize: 11,
            fontWeight: 600
          }}
        >
          <Sparkles size={13} color={BLUE} strokeWidth={2.3} />
          <span>Suggestions (lab)</span>
        </div>
        <div style={{ display: 'grid', gap: 6 }}>
          {LAB_CHIPS.map((chip, i) => (
            <LabChipRow
              key={`${chip.mode}:${chip.label}`}
              chip={chip}
              index={i}
              previewOpen={openIndex === i}
              onOpenPreview={() => setOpenIndex(i)}
              onClosePreview={() => setOpenIndex((cur) => (cur === i ? null : cur))}
              onPaste={onPaste}
            />
          ))}
        </div>
      </div>

      {/* The mock composer — a REAL focused field. Watch the focus pill: it must
          stay GREEN ("focused") while you hover/read a preview, and after Paste. */}
      <div style={{ width: 360 }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 8
          }}
        >
          <span style={{ color: MUTED, fontSize: 11, fontWeight: 700 }}>
            Mock composer (your caret lives here)
          </span>
          <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span
              style={{
                fontSize: 10,
                fontWeight: 800,
                textTransform: 'uppercase',
                padding: '2px 7px',
                borderRadius: 6,
                color: composerFocused ? CONFIG.THEME_TOKENS.onSurface : MUTED,
                background: composerFocused
                  ? 'rgba(var(--green-rgb),0.18)'
                  : CONFIG.THEME_TOKENS.surface2,
                border: `1px solid ${composerFocused ? 'rgba(var(--green-rgb),0.5)' : BORDER}`
              }}
            >
              {composerFocused ? '● focused' : '○ blurred'}
            </span>
            <span style={{ color: MUTED, fontSize: 10, fontWeight: 700 }}>
              {pasteCount} paste{pasteCount === 1 ? '' : 's'}
            </span>
          </span>
        </div>
        <textarea
          ref={composerRef}
          value={composerText}
          onChange={(e) => setComposerText(e.target.value)}
          onFocus={() => setComposerFocused(true)}
          onBlur={() => setComposerFocused(false)}
          rows={6}
          style={{
            width: '100%',
            resize: 'vertical',
            background: SURFACE_STRONG,
            color: TEXT,
            border: `1px solid ${composerFocused ? BLUE : BORDER}`,
            borderRadius: 8,
            padding: '10px 11px',
            fontSize: 12.5,
            lineHeight: 1.5,
            fontFamily: 'inherit',
            outline: 'none'
          }}
        />
        <div style={{ marginTop: 6, color: MUTED, fontSize: 10.5, lineHeight: 1.4 }}>
          ✅ pass: click in, type, hover a chip → pill stays <b>focused</b>; Paste inserts
          at the caret and the pill stays <b>focused</b>. ❌ fail: pill flips to{' '}
          <b>blurred</b> on hover/Paste.
        </div>
      </div>
    </div>
  )
}
