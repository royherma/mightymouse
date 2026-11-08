/**
 * The navigator overlay's filter. The keyword table exists because a user types
 * 'mic', not 'Listen' -- if the query misses, the overlay looks broken and they
 * close it. Worth pinning: every word must match (not any), the hidden keywords
 * are searched alongside the visible label, and an empty query shows everything
 * rather than nothing.
 */

import { describe, it, expect } from 'vitest'
import { matchesTarget, shortcutTargets, SCREEN_TARGETS, type NavigatorTarget } from '../navigator-targets'

const target = (over: Partial<NavigatorTarget> = {}): NavigatorTarget => ({
  id: 'screen:x',
  category: 'screen',
  label: 'Phone Remote',
  detail: 'Pair your iPhone.',
  icon: 'Smartphone',
  keywords: 'qr pairing scan',
  ...over
})

describe('matchesTarget', () => {
  it('shows every target for an empty or whitespace query', () => {
    expect(matchesTarget(target(), '')).toBe(true)
    expect(matchesTarget(target(), '   ')).toBe(true)
  })

  it('matches the visible label case-insensitively', () => {
    expect(matchesTarget(target(), 'PHONE')).toBe(true)
    expect(matchesTarget(target(), 'remote')).toBe(true)
  })

  it('matches a hidden keyword the label never shows', () => {
    // The whole reason the keyword table exists.
    expect(matchesTarget(target(), 'qr')).toBe(true)
  })

  it('matches words in the detail line', () => {
    expect(matchesTarget(target(), 'iphone')).toBe(true)
  })

  it('requires every typed word, not just one', () => {
    expect(matchesTarget(target(), 'phone qr')).toBe(true)
    expect(matchesTarget(target(), 'phone zebra')).toBe(false)
  })

  it('rejects a query that appears nowhere', () => {
    expect(matchesTarget(target(), 'spreadsheet')).toBe(false)
  })

  it('matches on a target with no detail or keywords', () => {
    const bare = target({ detail: undefined, keywords: undefined })
    expect(matchesTarget(bare, 'phone')).toBe(true)
    expect(matchesTarget(bare, 'qr')).toBe(false)
  })

  it('matches a mid-word substring, so partial typing still finds the row', () => {
    expect(matchesTarget(target(), 'hon')).toBe(true)
  })
})

describe('target tables', () => {
  it('gives every screen target a unique id', () => {
    const ids = SCREEN_TARGETS.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('gives every shortcut target a unique id and a label', () => {
    const targets = shortcutTargets()
    expect(targets.length).toBeGreaterThan(0)
    const ids = targets.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const t of targets) {
      expect(t.label.trim()).not.toBe('')
      expect(t.icon.trim()).not.toBe('')
      expect(t.category).toBe('shortcut')
    }
  })

  it('does not collide shortcut ids with screen ids', () => {
    const all = [...shortcutTargets(), ...SCREEN_TARGETS].map((t) => t.id)
    expect(new Set(all).size).toBe(all.length)
  })

  it("finds Listen by 'mic', the case the keyword table was written for", () => {
    const listen = shortcutTargets().find((t) => t.id === 'shortcut:listen')
    expect(listen).toBeDefined()
    expect(matchesTarget(listen as NavigatorTarget, 'mic')).toBe(true)
  })
})
