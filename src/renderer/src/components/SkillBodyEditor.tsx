import React, { useEffect, useMemo, useRef, useState } from 'react'
import { SkillInfo } from '../../../shared/types'
import { Button } from './Button'

interface Props {
  value: string
  onChange: (next: string) => void
  placeholder?: string
  rows?: number
  disabled?: boolean
  /** Extra class on the textarea (the chip editor uses `qae-textarea`). */
  textareaClassName?: string
  /** Forwarded to the textarea (e.g. the panel's `id="i"`). */
  textareaId?: string
  /** Inline style on the textarea (e.g. the panel's error border). */
  textareaStyle?: React.CSSProperties
  /** External ref to the underlying textarea (panel reuses it for focus/Tab). */
  inputRef?: React.RefObject<HTMLTextAreaElement>
  /**
   * Parent keydown handler. The editor handles Arrow/Enter/Tab/Esc ONLY while the
   * skill menu is open; every other key (and all keys when the menu is closed) is
   * forwarded here, so the panel's Enter-submit / Tab-reuse / Esc-close still work.
   */
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  /** Rendered as a sibling after the textarea inside the wrap (e.g. the mode badge). */
  children?: React.ReactNode
}

// A `/word` token: slash + at least one skill-name char (letters, digits, dash).
// Used both to highlight known skills in the body and to detect the active query
// the caret is sitting in.
const SLASH_TOKEN = /\/[A-Za-z0-9][A-Za-z0-9-]*/g
// The query under the caret: a slash, then name chars, anchored at the caret end.
const ACTIVE_QUERY = /\/([A-Za-z0-9-]*)$/

interface ActiveSlash {
  /** Index of the `/` in the text. */
  start: number
  /** The partial name typed after the slash (may be ''). */
  query: string
}

// Find the slash-command the caret is currently inside, if any. Returns null when
// the caret isn't right after a `/foo` token (so the dropdown stays closed).
function activeSlashAt(text: string, caret: number): ActiveSlash | null {
  const before = text.slice(0, caret)
  const m = before.match(ACTIVE_QUERY)
  if (!m) return null
  // Don't trigger mid-word: the char before the slash must be start-of-text or
  // whitespace, so a URL like `http://x` never opens the menu.
  const slashIdx = caret - m[0].length
  const prev = slashIdx > 0 ? text[slashIdx - 1] : ' '
  if (prev && !/\s/.test(prev)) return null
  return { start: slashIdx, query: m[1] }
}

/**
 * Textarea for a quick-action chip body with Claude Code skill awareness:
 *  - type `/` → a dropdown of the user's skills, filtered as you type
 *  - ↑/↓ to move, Enter/Tab to insert `/name `, Esc to dismiss
 *  - `/skill` tokens that match a real skill render highlighted (green); unknown
 *    ones stay dim. The highlight is painted by a mirror <div> behind a
 *    transparent textarea — identical box metrics keep them pixel-aligned.
 */
export default function SkillBodyEditor({
  value,
  onChange,
  placeholder,
  rows = 4,
  disabled,
  textareaClassName = 'qae-textarea',
  textareaId,
  textareaStyle,
  inputRef,
  onKeyDown,
  children
}: Props): React.ReactElement {
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [active, setActive] = useState<ActiveSlash | null>(null)
  const [selIdx, setSelIdx] = useState(0)
  // Pixel position of the `/` the menu anchors to, relative to the wrap. Null until
  // measured. Anchoring here (vs full-width) keeps the menu beside what you're typing.
  // `openUp` flips the menu above the caret when the panel window (auto-fit to content,
  // so there's no viewport slack below) doesn't have room to drop it down.
  const [caret, setCaret] = useState<{ left: number; top: number; openUp: boolean } | null>(
    null
  )
  // Use the caller's ref when given (panel reuses it for focus/Tab), else our own.
  const ownRef = useRef<HTMLTextAreaElement>(null)
  const taRef = inputRef ?? ownRef
  const mirrorRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLDivElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    window.api.skillsList().then(setSkills).catch(() => setSkills([]))
  }, [])

  const knownNames = useMemo(() => new Set(skills.map((s) => s.name)), [skills])

  // Measure where the active `/` sits in the textarea, in pixels. We render the text
  // up to that index into an offscreen div that mirrors the textarea's box exactly,
  // cap it with a 0-width marker, then read the marker's offset. This is the standard
  // textarea-caret-coordinate trick — textareas expose no native caret rect.
  useEffect(() => {
    if (!active || !measureRef.current || !taRef.current) {
      setCaret(null)
      return
    }
    const marker = measureRef.current.querySelector<HTMLElement>('.sbe-caret-marker')
    if (!marker) return
    const ta = taRef.current
    // Clamp so the fixed-width menu never spills past the textarea's right edge.
    const MENU_W = 340
    const maxLeft = Math.max(0, ta.clientWidth - MENU_W)
    const lineDrop = 18 // caret line height (1.45 × 12px) plus a little breathing room
    const top = marker.offsetTop - ta.scrollTop + lineDrop
    // The panel window auto-fits to its content height, so there's no viewport slack
    // below it — a menu dropped straight down runs off the actual window edge and gets
    // hard-clipped by the OS BrowserWindow bounds. Flip it above the caret whenever
    // there isn't enough room below (measured against the window, not just the wrap).
    const MENU_MAX_H = 220
    const taRect = ta.getBoundingClientRect()
    const spaceBelow = window.innerHeight - (taRect.top + top)
    const openUp = spaceBelow < MENU_MAX_H
    setCaret({
      left: Math.min(marker.offsetLeft - ta.scrollLeft, maxLeft),
      top: openUp ? marker.offsetTop - ta.scrollTop - lineDrop : top,
      openUp
    })
  }, [active, value])

  // The filtered list shown in the dropdown (cap so a huge skills dir stays usable).
  const matches = useMemo(() => {
    if (!active) return []
    const q = active.query.toLowerCase()
    const hits = skills.filter((s) => s.name.toLowerCase().includes(q))
    // Prefix matches first, then substring — most relevant on top.
    hits.sort((a, b) => {
      const ap = a.name.toLowerCase().startsWith(q) ? 0 : 1
      const bp = b.name.toLowerCase().startsWith(q) ? 0 : 1
      return ap - bp || a.name.localeCompare(b.name)
    })
    return hits.slice(0, 8)
  }, [active, skills])

  // Keep the mirror scrolled in lockstep with the textarea so highlights track
  // when the body overflows and scrolls.
  const syncScroll = () => {
    if (mirrorRef.current && taRef.current) {
      mirrorRef.current.scrollTop = taRef.current.scrollTop
      mirrorRef.current.scrollLeft = taRef.current.scrollLeft
    }
  }

  const recomputeActive = (text: string, caret: number) => {
    const next = activeSlashAt(text, caret)
    setActive(next)
    setSelIdx(0)
  }

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const text = e.target.value
    onChange(text)
    recomputeActive(text, e.target.selectionStart ?? text.length)
  }

  const insertSkill = (name: string) => {
    if (!active || !taRef.current) return
    const ta = taRef.current
    const caret = ta.selectionStart ?? value.length
    const before = value.slice(0, active.start)
    const after = value.slice(caret)
    const inserted = `/${name} `
    const next = before + inserted + after
    onChange(next)
    setActive(null)
    // Restore the caret right after the inserted token + trailing space.
    const newCaret = before.length + inserted.length
    requestAnimationFrame(() => {
      ta.focus()
      ta.setSelectionRange(newCaret, newCaret)
    })
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // The skill menu owns Arrow/Enter/Tab/Esc ONLY while it's open with matches.
    // Everything else — and all keys when the menu is closed — falls through to the
    // parent handler (panel Enter-submit / Tab-reuse / Esc-close stays intact).
    if (active && matches.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelIdx((i) => (i + 1) % matches.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelIdx((i) => (i - 1 + matches.length) % matches.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        insertSkill(matches[selIdx].name)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setActive(null)
        return
      }
    }
    onKeyDown?.(e)
  }

  // After arrow-key caret moves / clicks, re-evaluate whether we're in a slash token.
  const handleSelect = (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    const ta = e.currentTarget
    recomputeActive(ta.value, ta.selectionStart ?? ta.value.length)
  }

  // Build the highlighted mirror: split the text into plain spans and `/token`
  // spans, marking each token known/unknown. The trailing space keeps the mirror's
  // last line height matching the textarea when the body ends on a newline.
  const segments = useMemo(() => {
    // Empty: the textarea's native ::placeholder is hidden by our transparent
    // text-fill, so the mirror paints the placeholder instead (muted).
    if (value === '' && placeholder) {
      return [
        <span key="ph" className="sbe-placeholder">
          {placeholder}
        </span>
      ]
    }
    const out: React.ReactNode[] = []
    let last = 0
    let m: RegExpExecArray | null
    SLASH_TOKEN.lastIndex = 0
    let i = 0
    while ((m = SLASH_TOKEN.exec(value)) !== null) {
      if (m.index > last) out.push(<span key={`t${i}`}>{value.slice(last, m.index)}</span>)
      const name = m[0].slice(1)
      const cls = knownNames.has(name) ? 'sbe-skill-known' : 'sbe-skill-unknown'
      out.push(
        <span key={`s${i}`} className={cls}>
          {m[0]}
        </span>
      )
      last = m.index + m[0].length
      i++
    }
    out.push(<span key="tail">{value.slice(last) + '​'}</span>)
    return out
  }, [value, knownNames, placeholder])

  return (
    <div className="sbe-wrap" ref={wrapRef}>
      {/* `data-ph` marks the frames where the mirror is painting the "last: …"
          hint instead of typed text. The empty textarea underneath has nothing to
          scroll, so the mirror can't borrow its scrollTop (syncScroll) — CSS lets
          this layer scroll itself, and only then, so typed text keeps tracking
          the textarea exactly. */}
      <div
        className="sbe-mirror"
        ref={mirrorRef}
        data-ph={value === '' && placeholder ? 'true' : undefined}
        aria-hidden="true"
      >
        {segments}
      </div>
      {/* Offscreen twin of the textarea, used only to measure the caret's pixel
          position: text up to the `/`, then a zero-width marker we read the offset of. */}
      <div className="sbe-mirror sbe-measure" ref={measureRef} aria-hidden="true">
        {active ? value.slice(0, active.start) : ''}
        <span className="sbe-caret-marker" />
      </div>
      <textarea
        ref={taRef}
        id={textareaId}
        className={`${textareaClassName} sbe-textarea`}
        value={value}
        disabled={disabled}
        style={textareaStyle}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onScroll={syncScroll}
        onSelect={handleSelect}
        onClick={handleSelect}
        onBlur={() => {
          // Delay so a mousedown on a dropdown row fires before we close.
          setTimeout(() => setActive(null), 120)
        }}
        placeholder={placeholder}
        rows={rows}
        spellCheck={false}
      />
      {children}
      {active && matches.length > 0 && caret && (
        <div
          className="sbe-menu"
          style={
            caret.openUp
              ? { left: Math.max(0, caret.left), bottom: `calc(100% - ${caret.top}px)` }
              : { left: Math.max(0, caret.left), top: caret.top }
          }
        >
          {matches.map((s, idx) => (
            <Button
              variant="bare"
              key={s.name}
              className={`sbe-menu-item ${idx === selIdx ? 'active' : ''}`}
              // mousedown (not click) so it beats the textarea blur.
              onMouseDown={(e) => {
                e.preventDefault()
                insertSkill(s.name)
              }}
              onMouseEnter={() => setSelIdx(idx)}
            >
              <span className="sbe-menu-name">/{s.name}</span>
              {s.description && <span className="sbe-menu-desc">{s.description}</span>}
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}
