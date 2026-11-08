/**
 * Pins the inline Skin row's contents.
 *
 * The row used to be a filter over SKIN_OPTIONS, which holds BUILT-INS ONLY, so
 * a worn `remote:` skin matched nothing and the row collapsed to a single
 * unselected "Pro II". A one-option row reads as the current state, so tapping
 * it wrote proII over the real choice -- the skin appearing to change by itself
 * across restarts. Every case below is about the worn skin surviving.
 */
import { describe, it, expect } from 'vitest'
import { inlineSkinRow, SKIN_OPTIONS, INLINE_SKINS } from './skins'
import type { InstallableSkin } from '@shared/types'

const PROMOTED = SKIN_OPTIONS.filter((o) => INLINE_SKINS.has(o.id)).map((o) => o.id)

describe('inlineSkinRow', () => {
  it('always offers the promoted skin', () => {
    for (const id of PROMOTED) {
      expect(inlineSkinRow('proII').map((o) => o.id)).toContain(id)
    }
  })

  // THE regression. Against the old SKIN_OPTIONS filter this row came back
  // holding only 'proII', so the worn skin had no button and no active state.
  it('includes a worn REMOTE skin, which is not in SKIN_OPTIONS', () => {
    const worn = 'remote:mil-spec-2' as InstallableSkin
    const row = inlineSkinRow(worn, 'Field Unit')
    expect(row.map((o) => o.id)).toContain(worn)
  })

  it('names a worn remote skin with the label the Mac supplied', () => {
    const worn = 'remote:mil-spec-2' as InstallableSkin
    const entry = inlineSkinRow(worn, 'Field Unit').find((o) => o.id === worn)
    expect(entry?.label).toBe('Field Unit')
  })

  // An uninstalled skin (or a push that raced the manifest read) has no label.
  // A blank button is worse than an ugly one: it looks like a rendering bug and
  // there is nothing to tap back to.
  it('falls back to the id when no label is supplied', () => {
    const worn = 'remote:gone' as InstallableSkin
    const entry = inlineSkinRow(worn).find((o) => o.id === worn)
    expect(entry?.label).toBe('remote:gone')
  })

  // The invariant the whole fix exists to guarantee: whatever is worn is always
  // present, so the row can always show which skin is actually on.
  it('contains the worn skin for every built-in too', () => {
    for (const o of SKIN_OPTIONS) {
      expect(inlineSkinRow(o.id).map((r) => r.id)).toContain(o.id)
    }
  })

  it('does not duplicate the worn skin when it is already promoted', () => {
    for (const id of PROMOTED) {
      const row = inlineSkinRow(id)
      expect(row.filter((o) => o.id === id)).toHaveLength(1)
    }
  })

  // A remote label must never rename a built-in: the built-in's own label is
  // authoritative, and the worn-label argument only describes a remote skin.
  it('ignores a stray label when the worn skin is a built-in', () => {
    const entry = inlineSkinRow('proII', 'Field Unit').find((o) => o.id === 'proII')
    expect(entry?.label).toBe('Pro II')
  })
})
