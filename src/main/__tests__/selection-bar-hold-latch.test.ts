import { describe, it, expect, vi, beforeEach } from 'vitest'

// A hold (run/hover/edit) that outlives the bar used to latch the watcher shut:
// every path that clears a hold is gated on !isSelectionBarBusy(), so once one
// survived the window going away, no selection ever raised the bar again until
// the app restarted. That is the "it worked once, then never again" bug.

let visible = false
const fakeWin = {
  isDestroyed: () => false,
  isVisible: () => visible,
  isFocusable: () => false,
  getBounds: () => ({ x: 0, y: 0, width: 428, height: 66 }),
  setBounds: vi.fn(),
  showInactive: vi.fn(() => {
    visible = true
  }),
  hide: vi.fn(() => {
    visible = false
  }),
  focus: vi.fn(),
  blur: vi.fn(),
  setFocusable: vi.fn(),
  setAlwaysOnTop: vi.fn(),
  setVisibleOnAllWorkspaces: vi.fn(),
  once: vi.fn((_e: string, cb: () => void) => cb()),
  on: vi.fn(),
  close: vi.fn(),
  loadURL: vi.fn(),
  loadFile: vi.fn(),
  webContents: { send: vi.fn() }
}

vi.mock('electron', () => ({
  BrowserWindow: function () {
    return fakeWin
  },
  screen: {
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1800, height: 1000 } }),
    getCursorScreenPoint: () => ({ x: 500, y: 500 })
  }
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))
vi.mock('../store/prefs', () => ({
  PREFS: {
    getSelectionBarFast: () => false,
    getBackend: () => 'claude',
    getCtxToggle: () => false
  }
}))
vi.mock('../ipc/panel-state', () => ({
  buildCtxIdentity: () => ({ ctxApp: '', ctxURL: '' }),
  buildCtxLabel: () => ''
}))

const {
  showSelectionBar,
  hideSelectionBar,
  isSelectionBarBusy,
  isSelectionBarVisible,
  setSelectionBarHold
} = await import('../selection-bar-window')

const ACTIONS = [{ key: 'fix', label: 'Fix', instruction: 'fix it' }]

describe('selection bar holds never latch the watcher shut', () => {
  beforeEach(() => {
    visible = false
    hideSelectionBar()
  })

  it('is not busy once the bar is gone, whatever hold was set', () => {
    showSelectionBar(500, 500, ACTIONS, 10, 'hello there', {})
    setSelectionBarHold('run', true)
    expect(isSelectionBarBusy()).toBe(true)

    // The window goes away without hideSelectionBar() clearing the flags.
    fakeWin.hide()
    expect(isSelectionBarBusy()).toBe(false)
  })

  it('shows again after a run hold outlived the previous bar', () => {
    showSelectionBar(500, 500, ACTIONS, 10, 'hello there', {})
    setSelectionBarHold('run', true)
    fakeWin.hide()

    showSelectionBar(700, 700, ACTIONS, 20, 'new selection', {})
    expect(isSelectionBarVisible()).toBe(true)
  })

  it('still lets a live run own the bar', () => {
    showSelectionBar(500, 500, ACTIONS, 10, 'hello there', {})
    setSelectionBarHold('run', true)
    // Bar is still up and mid-run: a new selection must not yank the preview away.
    showSelectionBar(700, 700, ACTIONS, 20, 'other text', {})
    expect(isSelectionBarBusy()).toBe(true)
  })

  it('a hover hold on a hidden bar does not block the next show', () => {
    showSelectionBar(500, 500, ACTIONS, 10, 'hello there', {})
    setSelectionBarHold('hover', true)
    fakeWin.hide()
    showSelectionBar(700, 700, ACTIONS, 20, 'new selection', {})
    expect(isSelectionBarVisible()).toBe(true)
  })
})
