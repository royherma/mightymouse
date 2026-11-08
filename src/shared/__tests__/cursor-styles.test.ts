import { describe, it, expect } from 'vitest'
import {
  CURSOR_STYLES,
  DEFAULT_CURSOR_STYLE,
  toCursorStyle,
  visibleCursorStyles
} from '../cursor-styles'

describe('cursor-styles', () => {
  it('exposes each style id exactly once, with a label and description', () => {
    const ids = CURSOR_STYLES.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const s of CURSOR_STYLES) {
      expect(s.label.length).toBeGreaterThan(0)
      expect(s.description.length).toBeGreaterThan(0)
    }
  })

  it('lists the default style', () => {
    expect(CURSOR_STYLES.some((s) => s.id === DEFAULT_CURSOR_STYLE)).toBe(true)
  })

  it('toCursorStyle passes valid ids through unchanged', () => {
    for (const s of CURSOR_STYLES) {
      expect(toCursorStyle(s.id)).toBe(s.id)
    }
  })

  it('toCursorStyle coerces any unknown/empty/nullish value to the default', () => {
    const bad: (string | null | undefined)[] = ['', 'nope', 'HEATTRAIL', null, undefined]
    for (const v of bad) expect(toCursorStyle(v)).toBe(DEFAULT_CURSOR_STYLE)
  })

  describe('admin gating', () => {
    it('hides admin-only styles from normal users', () => {
      const visible = visibleCursorStyles(false)
      expect(visible.every((s) => !s.adminOnly)).toBe(true)
      expect(visible).not.toContainEqual(expect.objectContaining({ id: 'heatTrail' }))
    })

    it('shows every style to admins', () => {
      expect(visibleCursorStyles(true)).toEqual(CURSOR_STYLES)
    })

    // The default must never be admin-gated: a normal user whose pref falls back
    // to the default would otherwise land on a style their picker cannot show.
    it('keeps the default style visible to normal users', () => {
      expect(visibleCursorStyles(false).some((s) => s.id === DEFAULT_CURSOR_STYLE)).toBe(true)
    })

    it('leaves normal users a non-empty picker', () => {
      expect(visibleCursorStyles(false).length).toBeGreaterThan(0)
    })
  })
})
