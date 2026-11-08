/**
 * Pins the ANSI/ISO decision. An ISO Mac physically has one MORE key than an
 * ANSI one (§ left of Z). We detect the difference but deliberately draw the
 * ANSI board for both -- the user has an ISO Mac, tried the drawn § key, and asked
 * for it removed. These tests keep that a DECISION rather than something that
 * silently comes back the next time someone "fixes" the layout to match a real
 * keyboard.
 */
import { describe, it, expect } from 'vitest'
import {
  KEYBOARD_LAYOUTS,
  KEYBOARD_LAYOUT_ID,
  KEYBOARD_LAYOUT_FOR_HOST
} from './keyboard-layouts'
import { HOST_KEYBOARD } from '@shared/phone-remote-keys'

describe('the § key is not drawn on any board', () => {
  it.each(Object.values(KEYBOARD_LAYOUT_ID))('%s has no § key', (id) => {
    const displays = KEYBOARD_LAYOUTS[id].rows.flat().map((k) => k.display)
    expect(displays).not.toContain('§')
  })

  it('puts z directly after left shift on the Mac board', () => {
    const row = KEYBOARD_LAYOUTS[KEYBOARD_LAYOUT_ID.macUs].rows.find((r) =>
      r.some((k) => k.display === 'z')
    )
    expect(row?.map((k) => k.display).slice(0, 2)).toEqual(['⇧', 'z'])
  })
})

describe('host → layout routing', () => {
  it('draws the ANSI board for an ISO host, by choice', () => {
    expect(KEYBOARD_LAYOUT_FOR_HOST[HOST_KEYBOARD.macIso]).toBe(KEYBOARD_LAYOUT_ID.macUs)
    expect(KEYBOARD_LAYOUT_FOR_HOST[HOST_KEYBOARD.mac]).toBe(KEYBOARD_LAYOUT_ID.macUs)
  })

  it('routes every host keyboard to a layout that exists', () => {
    for (const host of Object.values(HOST_KEYBOARD)) {
      expect(KEYBOARD_LAYOUTS[KEYBOARD_LAYOUT_FOR_HOST[host]]).toBeDefined()
    }
  })
})
