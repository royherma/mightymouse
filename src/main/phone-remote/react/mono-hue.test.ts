import { describe, expect, it } from 'vitest'
import type { AppContextGroup } from '@shared/app-context'
import { monoHues } from './mono-hue'

const group = (id: string, iconPngBase64?: string): AppContextGroup => ({
  id,
  name: id,
  active: true,
  itemCount: 0,
  iconPngBase64
})

/** Roy's real cmux tabs — the data that broke the previous hash-only version,
 *  where two of these landed 0.5° apart and rendered as one color. */
const REAL_CMUX = [
  'tg-paperclip',
  'COT',
  'mighty-mouse',
  'TG Side Projects',
  'hyperframes',
  'video-editor-marketplace',
  'techguyver-you',
  'tg-growth'
]

describe('monoHues', () => {
  it('gives every group on screen its own hue', () => {
    const hues = monoHues(REAL_CMUX.map((id) => group(id)))
    expect(new Set(hues.values()).size).toBe(REAL_CMUX.length)
  })

  it('keeps a hue on the same id when unrelated groups come and go', () => {
    const all = monoHues(REAL_CMUX.map((id) => group(id)))
    // Drop the LAST group: no earlier group loses its slot, so no one reshuffles.
    const fewer = monoHues(REAL_CMUX.slice(0, -1).map((id) => group(id)))
    for (const id of REAL_CMUX.slice(0, -1)) expect(fewer.get(id)).toBe(all.get(id))
  })

  it('skips groups that have a real avatar', () => {
    const hues = monoHues([group('a'), group('b', 'iVBORw0KGgo='), group('c')])
    expect(hues.has('b')).toBe(false)
    expect(hues.size).toBe(2)
  })

  it('stays in range and terminates past the slot count', () => {
    const many = Array.from({ length: 40 }, (_, n) => group(`tab-${n}`))
    const hues = monoHues(many)
    expect(hues.size).toBe(40)
    for (const h of hues.values()) {
      expect(h).toBeGreaterThanOrEqual(0)
      expect(h).toBeLessThan(360)
    }
  })

  it('handles an empty list', () => {
    expect(monoHues([]).size).toBe(0)
  })
})
