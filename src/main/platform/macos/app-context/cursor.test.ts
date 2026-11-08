// Locks the Cursor adapter's PORTABILITY behavior, not its happy path (that was
// verified live: 4 windows, AXRaise raised one by index). Covers Cursor absent,
// no windows, a denied Accessibility grant, and the two parses that corrupt the
// dropdown invisibly.

import { describe, expect, it, vi, beforeEach } from 'vitest'

const runOsa = vi.fn<(script: string) => string | null>()
vi.mock('./osa', () => ({
  runOsa: (s: string) => runOsa(s),
  runOsaAsync: async (s: string) => runOsa(s),
  FIELD_SEP: '',
  OSASCRIPT_TIMEOUT_MS: 3000
}))

/** Spelled with escapes: the real separator is two invisible control bytes. */
const SEP = ''

/** One AppleScript payload: [index, window title, is-main] per window. */
function payload(windows: [string, string, boolean][]): string {
  return windows.map(([i, name, main]) => [i, name, String(main)].join(SEP) + SEP).join('')
}

describe('readCursor', () => {
  beforeEach(() => {
    vi.resetModules()
    runOsa.mockReset()
  })

  it('returns an empty reading when Cursor is not running', async () => {
    // The script's own `exists process` guard returns "" rather than throwing.
    runOsa.mockReturnValue('')
    const { readCursor } = await import('./cursor')
    expect((await readCursor())).toEqual({ items: [], groups: [], activeGroupId: '', tmuxZoomed: null })
  })

  it('returns an empty reading when the read fails outright', async () => {
    // null is the Accessibility-denied case: invisible on screen, and the most
    // likely real-world failure. It must degrade, never throw.
    runOsa.mockReturnValue(null)
    const { readCursor } = await import('./cursor')
    expect((await readCursor())).toEqual({ items: [], groups: [], activeGroupId: '', tmuxZoomed: null })
  })

  it('never reports items — Cursor tabs are unreachable', async () => {
    runOsa.mockReturnValue(payload([['1', 'a.ts — ShowAndTell', true]]))
    const { readCursor } = await import('./cursor')
    expect((await readCursor()).items).toEqual([])
  })

  it('keeps the LAST em-dash segment as the project', async () => {
    // Titles are "<file> — <project>". Splitting on the first segment labels
    // every window with the focused FILE, so the dropdown appears to rename
    // itself as you type.
    runOsa.mockReturnValue(payload([['1', 'server.ts — ShowAndTell', true]]))
    const { readCursor } = await import('./cursor')
    expect((await readCursor()).groups[0]?.name).toBe('ShowAndTell')
  })

  it('does not drop the last window', async () => {
    // The trailing separator leaves an empty final slot; an off-by-one in the
    // loop bound silently loses this third window (cmux shipped that bug).
    runOsa.mockReturnValue(
      payload([
        ['1', 'a — one', false],
        ['2', 'b — two', true],
        ['3', 'c — three', false]
      ])
    )
    const { readCursor } = await import('./cursor')
    const r = (await readCursor())
    expect(r.groups.map((g) => g.name)).toEqual(['one', 'two', 'three'])
    expect(r.activeGroupId).toBe('2')
  })

  it('labels a window with no folder open', async () => {
    // A bare "Cursor" title is a real state, not a failed read.
    runOsa.mockReturnValue(payload([['1', 'Cursor', true]]))
    const { readCursor } = await import('./cursor')
    expect((await readCursor()).groups[0]?.name).toBe('No folder')
  })
})

describe('activateCursorWindow', () => {
  beforeEach(() => {
    vi.resetModules()
    runOsa.mockReset()
  })

  it('refuses a non-numeric id without running a script', async () => {
    const { activateCursorWindow } = await import('./cursor')
    expect(activateCursorWindow('; do shell script "boom"')).toBe(false)
    expect(runOsa).not.toHaveBeenCalled()
  })

  it('refuses a zero or negative index', async () => {
    const { activateCursorWindow } = await import('./cursor')
    expect(activateCursorWindow('0')).toBe(false)
    expect(activateCursorWindow('-1')).toBe(false)
    expect(runOsa).not.toHaveBeenCalled()
  })

  it('reports failure when the window is gone', async () => {
    runOsa.mockReturnValue('no')
    const { activateCursorWindow } = await import('./cursor')
    expect(activateCursorWindow('9')).toBe(false)
  })

  it('raises a live window', async () => {
    runOsa.mockReturnValue('ok')
    const { activateCursorWindow } = await import('./cursor')
    expect(activateCursorWindow('2')).toBe(true)
  })
})
