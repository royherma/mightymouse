import { describe, it, expect } from 'vitest'
import {
  COMPANION_RENDERERS,
  DEFAULT_COMPANION_RENDERER,
  toCompanionRenderer,
  type CompanionRendererId
} from '../companion-renderers'

describe('companion-renderers', () => {
  it('exposes each renderer id exactly once, with a label and description', () => {
    const ids = COMPANION_RENDERERS.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const r of COMPANION_RENDERERS) {
      expect(r.label.length).toBeGreaterThan(0)
      expect(r.description.length).toBeGreaterThan(0)
    }
  })

  it('lists the default renderer', () => {
    expect(COMPANION_RENDERERS.some((r) => r.id === DEFAULT_COMPANION_RENDERER)).toBe(true)
  })

  it('toCompanionRenderer passes valid ids through unchanged', () => {
    for (const r of COMPANION_RENDERERS) {
      expect(toCompanionRenderer(r.id)).toBe(r.id)
    }
  })

  it('toCompanionRenderer coerces any unknown/empty/nullish value to the default', () => {
    const bad: (string | null | undefined)[] = ['', 'mouse2d', 'nope', 'MOUSE3D', null, undefined]
    for (const v of bad) {
      expect(toCompanionRenderer(v)).toBe(DEFAULT_COMPANION_RENDERER)
    }
  })

  it('is exhaustive over the CompanionRendererId union', () => {
    // Compile-time guard: every union member must be a listed id. If a new id is
    // added to the type without a COMPANION_RENDERERS entry, this switch stops
    // being exhaustive and TS errors here.
    const seen: Record<CompanionRendererId, boolean> = {
      mouse3d: false,
      warp2d: false,
      placeholder: false
    }
    for (const r of COMPANION_RENDERERS) seen[r.id] = true
    expect(Object.values(seen).every(Boolean)).toBe(true)
  })
})
