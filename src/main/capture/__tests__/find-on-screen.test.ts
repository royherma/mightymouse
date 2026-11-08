import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { OcrRect } from '../ocr'

// Mock the OCR call + electron.screen so the resolver is testable with no Vision
// binary, no real screenshot, and a deterministic scale factor of 1 (logical
// points == image pixels), which keeps the expected centers easy to read.
const mockRects = vi.fn()
vi.mock('../ocr', () => ({ ocrRects: (...a: unknown[]) => mockRects(...a) }))
vi.mock('electron', () => ({
  screen: { getPrimaryDisplay: () => ({ scaleFactor: 1 }) }
}))

import { findOnScreen } from '../find-on-screen'

const rect = (text: string, x: number, y: number, w = 80, h = 20, conf = 0.95): OcrRect => ({
  text,
  x,
  y,
  w,
  h,
  conf
})

describe('findOnScreen', () => {
  beforeEach(() => mockRects.mockReset())

  it('returns null when OCR finds nothing', async () => {
    mockRects.mockResolvedValue([])
    expect(await findOnScreen('Export', 'shot.png')).toBeNull()
  })

  it('returns null for a blank target', async () => {
    mockRects.mockResolvedValue([rect('Export', 100, 200)])
    expect(await findOnScreen('   ', 'shot.png')).toBeNull()
  })

  it('resolves an exact label to its box center', async () => {
    mockRects.mockResolvedValue([rect('File', 10, 10), rect('Export', 100, 200, 80, 20)])
    // center of (100,200,80,20) = (140, 210)
    expect(await findOnScreen('Export', 'shot.png')).toEqual({ x: 140, y: 210 })
  })

  it('matches a label that is a leading run of a longer line', async () => {
    mockRects.mockResolvedValue([rect('Export as PNG', 100, 200, 200, 20)])
    expect(await findOnScreen('Export', 'shot.png')).toEqual({ x: 200, y: 210 })
  })

  it('is case- and punctuation-insensitive', async () => {
    mockRects.mockResolvedValue([rect('Sign In', 50, 50, 100, 20)])
    expect(await findOnScreen('sign-in', 'shot.png')).toEqual({ x: 100, y: 60 })
  })

  it('returns null when no line clears the score floor', async () => {
    mockRects.mockResolvedValue([rect('Completely unrelated text', 0, 0)])
    expect(await findOnScreen('Export', 'shot.png')).toBeNull()
  })

  it('prefers the higher-scoring line over a weak partial', async () => {
    mockRects.mockResolvedValue([
      rect('Export options panel', 10, 10, 200, 20), // partial overlap
      rect('Export', 300, 400, 80, 20) // exact
    ])
    expect(await findOnScreen('Export', 'shot.png')).toEqual({ x: 340, y: 410 })
  })

  it('never throws when OCR fails — returns null', async () => {
    // OCR failure surfaces as an empty rect list (runOcr swallows spawn errors to
    // '' upstream), so the resolver must treat "no rects" as "not found", never
    // throw. This is the load-bearing degrade-gracefully guarantee.
    mockRects.mockResolvedValue([])
    let threw = false
    const v = await findOnScreen('Export', 'shot.png').catch(() => {
      threw = true
      return null
    })
    expect(threw).toBe(false)
    expect(v).toBeNull()
  })
})
