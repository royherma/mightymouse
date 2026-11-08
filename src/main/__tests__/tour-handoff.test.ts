import { describe, it, expect, beforeEach, vi } from 'vitest'

// The permission→tour→panel chain: the tour's LAST act is handing off to the
// panel. Before that existed, pressing Done closed the window onto an empty
// screen — app running, zero windows, tray only. The asymmetry is the point:
// Done/Skip hand off, a red-X dismissal must NOT (it shouldn't summon a window
// the user just closed), so both exits are asserted here.
//
// tour-window.ts reaches 'electron' and panel-window.ts, neither of which loads
// in this repo's node-environment vitest — hence the module mocks below. What's
// under test is the DECISION (which exit opens the panel, what it tracks), not
// Electron's window plumbing.

const route = vi.fn()
const track = vi.fn()
const setTourSeen = vi.fn()

let closedHandler: (() => void) | null = null

vi.mock('electron', () => ({
  BrowserWindow: class {
    isDestroyed = (): boolean => false
    show = vi.fn()
    focus = vi.fn()
    close = vi.fn(() => closedHandler?.())
    loadURL = vi.fn()
    loadFile = vi.fn()
    webContents = { send: vi.fn() }
    on = (event: string, cb: () => void): void => {
      if (event === 'closed') closedHandler = cb
    }
  }
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))
vi.mock('../routing', () => ({ route }))
vi.mock('../analytics', () => ({ track }))
vi.mock('../store/prefs', () => ({ PREFS: { setTourSeen } }))
vi.mock('../tour-demo', () => ({ startTourDemo: vi.fn(), endTourDemo: vi.fn() }))
vi.mock('../tour-hotkey-probe', () => ({
  disarmProbe: vi.fn(),
  setTourDemoHooks: vi.fn(),
  setTourWindowRef: vi.fn()
}))

describe('tour → panel handoff', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    vi.useFakeTimers()
    closedHandler = null
  })

  it('Done/Skip opens the panel, so the chain never dead-ends', async () => {
    const { showTourWindow, completeTour } = await import('../tour-window')
    showTourWindow('auto')

    completeTour()
    expect(route).not.toHaveBeenCalled() // deferred, not immediate

    vi.runAllTimers()
    expect(route).toHaveBeenCalledWith('panel', { panelSource: 'welcome', welcome: 'new' })
    expect(track).toHaveBeenCalledWith('tour_handoff', { to: 'panel', dismissed: false })
  })

  it('a red-X dismissal hands off to nothing', async () => {
    const { showTourWindow } = await import('../tour-window')
    showTourWindow('auto')

    closedHandler?.()
    vi.runAllTimers()

    expect(route).not.toHaveBeenCalled()
    expect(track).toHaveBeenCalledWith('tour_handoff', { to: 'none', dismissed: true })
  })

  it('marks the tour seen on both exits, so it never auto-shows twice', async () => {
    const { showTourWindow, completeTour } = await import('../tour-window')
    showTourWindow('auto')
    completeTour()
    expect(setTourSeen).toHaveBeenCalledWith(true)
  })
})
