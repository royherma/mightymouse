import { describe, it, expect, vi, beforeEach } from 'vitest'

// spawnSync is mocked per-test so these run without touching real `defaults`
// (and so the "user customized their pointer" branch is testable at all --
// com.apple.universalaccess is SIP-protected, so a test can't write a real
// value to read back).
const spawnSyncMock = vi.hoisted(() => vi.fn())
vi.mock('child_process', () => ({ spawnSync: spawnSyncMock }))
vi.mock('../../../shared/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../shared/env')>()),
  devLog: { warn: vi.fn(), log: vi.fn(), error: vi.fn() },
}))

import { getCursorAppearance } from './cursor-appearance'

/** Reply to `defaults read <domain> <key>` from a key->stdout map. Any key not
 *  in the map answers like a real unset key does: non-zero status, no output. */
function mockDefaults(values: Record<string, string>): void {
  spawnSyncMock.mockImplementation((...callArgs: unknown[]) => {
    // ['defaults', ['read', <domain>, <key>], <options>] -- the key is the
    // third element of the ARGS ARRAY, not the third call argument.
    const args = callArgs[1] as string[]
    const key = args[2]
    if (key in values) return { status: 0, stdout: values[key] }
    return { status: 1, stdout: '' }
  })
}

describe('getCursorAppearance', () => {
  // mockClear, NOT mockReset: reset() strips the implementation and the
  // default `defaults`-shaped reply along with it, so a test that never calls
  // mockDefaults() (or one running after the throwing test) gets a mock
  // returning undefined and blows up inside the helper rather than under test.
  beforeEach(() => {
    spawnSyncMock.mockClear()
    mockDefaults({})
  })

  it('falls back to the stock macOS pointer when no keys are set', () => {
    mockDefaults({})
    expect(getCursorAppearance()).toEqual({ size: 1, fill: '#ffffff', outline: '#000000' })
  })

  it('converts macOS 0..1 float triplets to css rgb', () => {
    mockDefaults({ cursorFillColor: '1 0.5 0', cursorOutlineColor: '0 0 1' })
    const a = getCursorAppearance()
    expect(a.fill).toBe('rgb(255, 128, 0)')
    expect(a.outline).toBe('rgb(0, 0, 255)')
  })

  it('reads a customized pointer size', () => {
    mockDefaults({ mouseDriverCursorSize: '2.5' })
    expect(getCursorAppearance().size).toBe(2.5)
  })

  it('falls back per-field, so one customized setting keeps stock defaults for the rest', () => {
    mockDefaults({ cursorFillColor: '0 1 0' })
    const a = getCursorAppearance()
    expect(a.fill).toBe('rgb(0, 255, 0)')
    expect(a.size).toBe(1)
    expect(a.outline).toBe('#000000')
  })

  it('rejects an out-of-range size rather than scaling the cursor absurdly', () => {
    mockDefaults({ mouseDriverCursorSize: '99' })
    expect(getCursorAppearance().size).toBe(1)
  })

  it('rejects unparseable colors instead of emitting broken css', () => {
    mockDefaults({ cursorFillColor: 'not a color', cursorOutlineColor: '1 0' })
    const a = getCursorAppearance()
    expect(a.fill).toBe('#ffffff')
    expect(a.outline).toBe('#000000')
  })

  it('clamps out-of-range color components into 0..255', () => {
    mockDefaults({ cursorFillColor: '2 -1 0.5' })
    expect(getCursorAppearance().fill).toBe('rgb(255, 0, 128)')
  })

  it('survives spawnSync throwing', () => {
    spawnSyncMock.mockImplementation(() => {
      throw new Error('spawn failed')
    })
    expect(getCursorAppearance()).toEqual({ size: 1, fill: '#ffffff', outline: '#000000' })
  })
})
