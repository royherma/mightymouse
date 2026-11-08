// Locks the cmux adapter's PORTABILITY behavior, not its happy path.
//
// The happy path was verified live against cmux 0.64.17 (8 tabs, 11 terminals,
// ids joining to the session file 8/8 and 11/11). What these tests protect is
// everything that differs on someone ELSE's Mac: cmux absent, cmux present but
// closed, an older build missing a property, and a session file that is stale,
// missing, or corrupt. Every one of those must degrade to a smaller reading --
// never a throw, and never a lost tab list.

import { describe, expect, it, vi, beforeEach } from 'vitest'

const runOsa = vi.fn<(script: string) => string | null>()
vi.mock('./osa', () => ({
  runOsa: (s: string) => runOsa(s),
  runOsaAsync: async (s: string) => runOsa(s),
  FIELD_SEP: '',
  OSASCRIPT_TIMEOUT_MS: 3000
}))

const readFileSync = vi.fn<() => string>()
const existsSync = vi.fn<() => boolean>()
vi.mock('fs', () => ({
  readFileSync: () => readFileSync(),
  existsSync: () => existsSync()
}))

const spawnSync = vi.fn<(cmd: string, args: string[]) => Record<string, unknown>>()
vi.mock('child_process', () => ({
  spawnSync: (cmd: string, args: string[]) => spawnSync(cmd, args)
}))

const resolveBinary = vi.fn<() => string | null>()
vi.mock('../resolve-binary', () => ({
  resolveBinary: () => resolveBinary()
}))

const SEP = ''
const BLOCK = SEP + SEP

/** A session-file panel cmux launched into tmux — `checkpointId` IS the session name. */
function tmuxPanel(id: string, session: string): Record<string, unknown> {
  return {
    type: 'terminal',
    id,
    title: session,
    terminal: { resumeBinding: { kind: 'tmux', checkpointId: session } }
  }
}

/** A `list-panes -a` stdout block. Rows are `session|paneId|active|zoom|title`. */
function panesOut(rows: [string, string, boolean, boolean, string][]): string {
  return rows.map(([s, id, act, z, t]) => [s, id, act ? '1' : '0', z ? '1' : '0', t].join('|')).join('\n')
}

/** One AppleScript payload: tabs block, then the selected tab's terminal ids. */
function payload(tabs: [string, string, boolean, string][], termIds: string[]): string {
  const g = tabs.map(([id, name, sel, count]) => [id, name, String(sel), count].join(SEP) + SEP).join('')
  return g + BLOCK + termIds.map((t) => t + SEP).join('')
}

describe('readCmux', () => {
  beforeEach(async () => {
    vi.resetModules()
    runOsa.mockReset()
    readFileSync.mockReset()
    existsSync.mockReset()
    existsSync.mockReturnValue(false)
    spawnSync.mockReset()
    resolveBinary.mockReset()
    resolveBinary.mockReturnValue('/opt/homebrew/bin/tmux')
  })

  it('returns an empty reading when cmux is not installed', async () => {
    // runOsa swallows the "application isn't running" error and yields null.
    runOsa.mockReturnValue(null)
    const { readCmux } = await import('./cmux')
    expect((await readCmux())).toEqual({ items: [], groups: [], activeGroupId: '', tmuxZoomed: null })
  })

  it('returns an empty reading when cmux is running with no windows', async () => {
    runOsa.mockReturnValue('')
    const { readCmux } = await import('./cmux')
    expect((await readCmux())).toEqual({ items: [], groups: [], activeGroupId: '', tmuxZoomed: null })
  })

  it('keeps the tab list when an older build cannot report terminal counts', async () => {
    // The AppleScript `try` leaves the count field EMPTY rather than failing the
    // whole script -- this is the regression that would otherwise blank the bar.
    runOsa.mockImplementation((s) =>
      s.includes('focused terminal') ? 'p1' : payload([['t1', 'COT', true, '']], ['p1'])
    )
    const { readCmux } = await import('./cmux')
    const r = (await readCmux())
    expect(r.groups.map((g) => g.name)).toEqual(['COT'])
    expect(r.groups[0].itemCount).toBe(0)
    expect(r.activeGroupId).toBe('t1')
  })

  it('survives a missing session file, falling back to positional names', async () => {
    existsSync.mockReturnValue(false)
    runOsa.mockImplementation((s) =>
      s.includes('focused terminal') ? 'p2' : payload([['t1', 'COT', true, '2']], ['p1', 'p2'])
    )
    const { readCmux } = await import('./cmux')
    const r = (await readCmux())
    expect(r.items.map((i) => i.title)).toEqual(['Terminal 1', 'Terminal 2'])
    expect(r.items[1].active).toBe(true)
    expect(r.groups[0].subtitle).toBe('')
  })

  it('survives a corrupt session file without losing navigation', async () => {
    existsSync.mockReturnValue(true)
    readFileSync.mockReturnValue('{ not json')
    runOsa.mockImplementation((s) =>
      s.includes('focused terminal') ? null : payload([['t1', 'COT', true, '1']], ['p1'])
    )
    const { readCmux } = await import('./cmux')
    const r = (await readCmux())
    // Ids -- the only load-bearing field -- are intact; titles degrade.
    expect(r.items.map((i) => i.id)).toEqual(['p1'])
    expect(r.items[0].title).toBe('Terminal 1')
    // A null `focused` must mark nothing active rather than throw.
    expect(r.items[0].active).toBe(false)
  })

  it('decorates from the session file when tab and terminal ids join', async () => {
    existsSync.mockReturnValue(true)
    readFileSync.mockReturnValue(
      JSON.stringify({
        windows: [
          {
            tabManager: {
              workspaces: [{ workspaceId: 't1', currentDirectory: '/Users/x/Desktop/Development/cot' }]
            }
          }
        ],
        panels: [{ type: 'terminal', id: 'p1', title: 'jul-26-s-c' }]
      })
    )
    runOsa.mockImplementation((s) =>
      s.includes('focused terminal') ? 'p1' : payload([['t1', 'COT', true, '1']], ['p1'])
    )
    const { readCmux } = await import('./cmux')
    const r = (await readCmux())
    expect(r.items[0].title).toBe('jul-26-s-c')
    expect(r.groups[0].subtitle).toBe('Development/cot')
  })

  it('reports the zoom of the tmux session the FOCUSED panel attached to', async () => {
    // The whole point of the join: two panels, two tmux sessions, and the flag
    // must come from the focused one. Reading the wrong panel would show
    // another agent's zoom state, which looks identical on device.
    existsSync.mockReturnValue(true)
    readFileSync.mockReturnValue(JSON.stringify({ panels: [tmuxPanel('p1', 'sess-a'), tmuxPanel('p2', 'sess-b')] }))
    runOsa.mockImplementation((s) =>
      s.includes('focused terminal') ? 'p2' : payload([['t1', 'COT', true, '2']], ['p1', 'p2'])
    )
    spawnSync.mockReturnValue({
      status: 0,
      stdout: panesOut([
        ['sess-a', '%1', true, false, 'other agent'],
        ['sess-b', '%9', true, true, 'my agent']
      ])
    })
    const { readCmux } = await import('./cmux')
    const r = (await readCmux())
    expect(r.tmuxZoomed).toBe(true)
    expect(r.panes?.map((p) => p.id)).toEqual(['%9'])
  })

  it('takes zoom from the ACTIVE pane, not whichever row came first', async () => {
    // window_zoomed_flag repeats on every row of the window; a non-active row's
    // copy describes a pane the phone is not looking at.
    existsSync.mockReturnValue(true)
    readFileSync.mockReturnValue(JSON.stringify({ panels: [tmuxPanel('p1', 'sess-a')] }))
    runOsa.mockImplementation((s) =>
      s.includes('focused terminal') ? 'p1' : payload([['t1', 'COT', true, '1']], ['p1'])
    )
    spawnSync.mockReturnValue({
      status: 0,
      stdout: panesOut([
        ['sess-a', '%1', false, true, 'first'],
        ['sess-a', '%2', true, true, 'active']
      ])
    })
    const { readCmux } = await import('./cmux')
    const r = (await readCmux())
    expect(r.tmuxZoomed).toBe(true)
    expect(r.panes?.find((p) => p.active)?.id).toBe('%2')
  })

  it('keeps the pane id tmux issued, never a positional index', async () => {
    // pane_index shifts when a sibling dies; re-resolving an index against a
    // list read a moment later is this repo's three-time "wrong thing switched".
    existsSync.mockReturnValue(true)
    readFileSync.mockReturnValue(JSON.stringify({ panels: [tmuxPanel('p1', 'sess-a')] }))
    runOsa.mockImplementation((s) =>
      s.includes('focused terminal') ? 'p1' : payload([['t1', 'COT', true, '1']], ['p1'])
    )
    spawnSync.mockReturnValue({
      status: 0,
      stdout: panesOut([
        ['sess-a', '%42', false, false, 'a'],
        ['sess-a', '%47', true, false, 'b']
      ])
    })
    const { readCmux } = await import('./cmux')
    expect((await readCmux()).panes?.map((p) => p.id)).toEqual(['%42', '%47'])
  })

  it('strips the live status glyph off a pane title', async () => {
    // The glyph changes on its own between reads and its meaning is unverified,
    // so it must not reach a label.
    existsSync.mockReturnValue(true)
    readFileSync.mockReturnValue(JSON.stringify({ panels: [tmuxPanel('p1', 'sess-a')] }))
    runOsa.mockImplementation((s) =>
      s.includes('focused terminal') ? 'p1' : payload([['t1', 'COT', true, '1']], ['p1'])
    )
    spawnSync.mockReturnValue({
      status: 0,
      stdout: panesOut([['sess-a', '%1', true, false, '\u2733 mm-phone-shot-debugging']])
    })
    const { readCmux } = await import('./cmux')
    expect((await readCmux()).panes?.[0].title).toBe('mm-phone-shot-debugging')
  })

  it('falls back to Pane N for a default or empty title', async () => {
    // 22 of 55 live panes reported the literal default or nothing at all;
    // passing those through fills the sheet with identical and blank rows.
    existsSync.mockReturnValue(true)
    readFileSync.mockReturnValue(JSON.stringify({ panels: [tmuxPanel('p1', 'sess-a')] }))
    runOsa.mockImplementation((s) =>
      s.includes('focused terminal') ? 'p1' : payload([['t1', 'COT', true, '1']], ['p1'])
    )
    spawnSync.mockReturnValue({
      status: 0,
      stdout: panesOut([
        ['sess-a', '%1', true, false, '\u2733 Claude Code'],
        ['sess-a', '%2', false, false, ''],
        ['sess-a', '%3', false, false, 'real-name']
      ])
    })
    const { readCmux } = await import('./cmux')
    expect((await readCmux()).panes?.map((p) => p.title)).toEqual(['Pane 1', 'Pane 2', 'real-name'])
  })

  it('keeps a title that itself contains the field separator', async () => {
    existsSync.mockReturnValue(true)
    readFileSync.mockReturnValue(JSON.stringify({ panels: [tmuxPanel('p1', 'sess-a')] }))
    runOsa.mockImplementation((s) =>
      s.includes('focused terminal') ? 'p1' : payload([['t1', 'COT', true, '1']], ['p1'])
    )
    spawnSync.mockReturnValue({
      status: 0,
      stdout: panesOut([['sess-a', '%1', true, false, 'build | test']])
    })
    const { readCmux } = await import('./cmux')
    expect((await readCmux()).panes?.[0].title).toBe('build | test')
  })

  it('answers null and no panes for a panel running a plain shell', async () => {
    // No resumeBinding means there is no tmux and so no zoom to be in. `false`
    // would light the button's unzoomed state on a pane that cannot zoom, and
    // an empty array would put a third chip on a terminal with no third level.
    existsSync.mockReturnValue(true)
    readFileSync.mockReturnValue(JSON.stringify({ panels: [{ type: 'terminal', id: 'p1', title: '~' }] }))
    runOsa.mockImplementation((s) =>
      s.includes('focused terminal') ? 'p1' : payload([['t1', 'COT', true, '1']], ['p1'])
    )
    const { readCmux } = await import('./cmux')
    const r = (await readCmux())
    expect(r.tmuxZoomed).toBeNull()
    expect(r.panes).toBeUndefined()
    expect(spawnSync).not.toHaveBeenCalled()
  })

  it('answers null when the tmux server cannot be reached', async () => {
    existsSync.mockReturnValue(true)
    readFileSync.mockReturnValue(JSON.stringify({ panels: [tmuxPanel('p1', 'sess-a')] }))
    runOsa.mockImplementation((s) =>
      s.includes('focused terminal') ? 'p1' : payload([['t1', 'COT', true, '1']], ['p1'])
    )
    spawnSync.mockReturnValue({ status: 1, stdout: '', stderr: 'no server running' })
    const { readCmux } = await import('./cmux')
    const r = (await readCmux())
    expect(r.tmuxZoomed).toBeNull()
    expect(r.panes).toBeUndefined()
  })

  it('answers null when the session died between the two reads', async () => {
    // Reached tmux, matched no row: claiming anything about a gone pane is worse
    // than saying nothing.
    existsSync.mockReturnValue(true)
    readFileSync.mockReturnValue(JSON.stringify({ panels: [tmuxPanel('p1', 'sess-gone')] }))
    runOsa.mockImplementation((s) =>
      s.includes('focused terminal') ? 'p1' : payload([['t1', 'COT', true, '1']], ['p1'])
    )
    spawnSync.mockReturnValue({ status: 0, stdout: panesOut([['sess-other', '%1', true, true, 'x']]) })
    const { readCmux } = await import('./cmux')
    const r = (await readCmux())
    expect(r.tmuxZoomed).toBeNull()
    expect(r.panes).toBeUndefined()
  })

  it('keeps the tab list when tmux is not installed at all', async () => {
    existsSync.mockReturnValue(true)
    readFileSync.mockReturnValue(JSON.stringify({ panels: [tmuxPanel('p1', 'sess-a')] }))
    runOsa.mockImplementation((s) =>
      s.includes('focused terminal') ? 'p1' : payload([['t1', 'COT', true, '1']], ['p1'])
    )
    resolveBinary.mockReturnValue(null)
    const { readCmux } = await import('./cmux')
    const r = (await readCmux())
    expect(r.tmuxZoomed).toBeNull()
    expect(r.panes).toBeUndefined()
    expect(r.groups.map((g) => g.name)).toEqual(['COT'])
  })

  it('shortens a path-shaped tab name so it does not duplicate the subtitle', async () => {
    // cmux names an unrenamed tab after its directory, abbreviated with a
    // leading ellipsis -- which is neither an absolute nor a `~` path.
    runOsa.mockImplementation((s) =>
      s.includes('focused terminal')
        ? null
        : payload([['t1', '…/Desktop/Development/video-editor-marketplace', true, '1']], ['p1'])
    )
    const { readCmux } = await import('./cmux')
    expect((await readCmux()).groups[0].name).toBe('video-editor-marketplace')
  })

  it('ignores a truncated trailing record rather than emitting a blank row', async () => {
    runOsa.mockImplementation((s) =>
      s.includes('focused terminal') ? null : `t1${SEP}COT${SEP}true${SEP}1${SEP}t2${SEP}half` + BLOCK
    )
    const { readCmux } = await import('./cmux')
    expect((await readCmux()).groups.map((g) => g.id)).toEqual(['t1'])
  })
})
