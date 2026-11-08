import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  MIC_LATCH_CHROME_MS,
  micChromeHitNode,
  micChromeIsInert,
  micChromeVisible,
  micIgnoreStopTap
} from '../mic-latch-chrome'

describe('micChromeIsInert', () => {
  it('is only inert while inside the leftover window', () => {
    expect(micChromeIsInert(1000, null)).toBe(false)
    expect(micChromeIsInert(1000, 1000)).toBe(true)
    expect(micChromeIsInert(1000 + MIC_LATCH_CHROME_MS - 1, 1000)).toBe(true)
    expect(micChromeIsInert(1000 + MIC_LATCH_CHROME_MS, 1000)).toBe(false)
  })
})

describe('micIgnoreStopTap', () => {
  it('blocks ghost stop taps on the mic while inert', () => {
    expect(micIgnoreStopTap('toggled', 1000, null)).toBe(false)
    expect(micIgnoreStopTap('toggled', 1100, 1000)).toBe(true)
    expect(micIgnoreStopTap('recording', 1100, 1000)).toBe(true)
    expect(micIgnoreStopTap('opening', 1100, 1000)).toBe(false)
    expect(micIgnoreStopTap('toggled', 1000 + MIC_LATCH_CHROME_MS, 1000)).toBe(false)
  })
})

describe('micChromeVisible', () => {
  it('shows Cancel/Stop only while latched and recording, never over chat', () => {
    expect(micChromeVisible(true, false, false)).toBe(false)
    expect(micChromeVisible(true, true, false)).toBe(true)
    expect(micChromeVisible(true, true, true)).toBe(false)
    expect(micChromeVisible(false, true, false)).toBe(false)
  })
})

describe('micChromeHitNode', () => {
  it('walks a text-like node to its parent button', () => {
    const button = { closest: () => button } as unknown as Element
    const text = { parentElement: button } as unknown as EventTarget
    expect(micChromeHitNode(button)).toBe(button)
    expect(micChromeHitNode(text)).toBe(button)
    expect(micChromeHitNode(null)).toBe(null)
  })
})

describe('use-dictation guards leftover mic taps in one place', () => {
  it('uses micSidePress, micIgnoreStopTap, and stamps inert at latch', () => {
    const src = readFileSync(resolve(__dirname, '../hooks/use-dictation.ts'), 'utf8')
    expect(src).toMatch(/micSidePress/)
    expect(src).toMatch(/micIgnoreStopTap/)
    expect(src).toMatch(/micChromeVisible/)
    expect(src).toMatch(/micTraceLeftover/)
    expect(src).toMatch(/micLatchedAtRef\.current = Date\.now\(\)/)
    expect(src).not.toMatch(/micChromeHitNode/)
    expect(src).not.toMatch(/document\.addEventListener\('pointerdown', swallow/)
  })
})
