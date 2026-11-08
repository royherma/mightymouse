import { describe, it, expect, vi, beforeEach } from 'vitest'

// The bug this pins: the panel stopped responding to its own close
// button. cancel/panelHide/resize all reached main and all silently no-opped,
// because every one of them starts with `if (!panelWindow) return` and the
// module-level `panelWindow` had gone null while the real window was still on
// screen. No error, no log — the panel just ignored input.
//
// Two things put it in that state, both reproduced below:
//   1. closePanelWindow() nulled the ref EAGERLY, right after close(). close()
//      only REQUESTS a close, so a close that doesn't complete left a live
//      window behind a dead reference.
//   2. the 'closed' handler nulled unconditionally, so a LATE closed event from
//      an already-replaced window wiped the ref to the current, live one.

class FakeWindow {
  destroyed = false
  visible = true
  bounds = { x: 0, y: 0, width: 520, height: 250 }
  closeCalls = 0
  url: string
  private handlers: Record<string, Array<(...a: unknown[]) => void>> = {}

  constructor(url = 'http://localhost:5273/?window=panel') {
    this.url = url
    ALL_WINDOWS.push(this as unknown as FakeWindow)
  }

  webContents = { getURL: () => this.url, send: () => {} }
  on(ev: string, fn: (...a: unknown[]) => void): void {
    ;(this.handlers[ev] ||= []).push(fn)
  }
  emit(ev: string): void {
    for (const fn of this.handlers[ev] ?? []) fn()
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  isVisible(): boolean {
    return this.visible && !this.destroyed
  }
  isFocusable(): boolean {
    return true
  }
  isMinimized(): boolean {
    return false
  }
  getBounds(): typeof this.bounds {
    return { ...this.bounds }
  }
  setBounds(b: Partial<typeof this.bounds>): void {
    this.bounds = { ...this.bounds, ...b }
  }
  /** close() only REQUESTS a close — it does NOT destroy synchronously. That
   *  asynchrony is the whole bug, so the fake must not shortcut it. */
  close(): void {
    this.closeCalls++
  }
  /** The real destroy, as Electron would do it once the close completes. */
  finishClose(): void {
    this.destroyed = true
    this.emit('closed')
  }
  show(): void {}
  showInactive(): void {}
  focus(): void {}
  hide(): void {
    this.visible = false
  }
  loadURL(): void {}
  loadFile(): void {}
}

let ALL_WINDOWS: FakeWindow[] = []

vi.mock('electron', () => ({
  app: { hide: () => {} },
  screen: {
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1728, height: 1000 } }),
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1728, height: 1000 } }),
    getCursorScreenPoint: () => ({ x: 100, y: 100 })
  },
  BrowserWindow: Object.assign(
    function (this: unknown) {
      return new FakeWindow()
    } as unknown as new () => FakeWindow,
    { getAllWindows: () => ALL_WINDOWS }
  )
}))

vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))
vi.mock('../analytics', () => ({ track: () => {} }))
vi.mock('../platform', () => ({
  captureContext: async () => ({}),
  chrome: { windowOptions: () => ({}), showOnAllWorkspaces: () => {} }
}))
vi.mock('../ipc/panel-state', () => ({
  getPanelState: () => null,
  buildCtxLabel: () => '',
  buildCtxIdentity: () => ({}),
  actionVisible: () => true
}))
vi.mock('../store/actions', () => ({ ACTIONS: { load: () => [] } }))
vi.mock('../store/prefs', () => ({ PREFS: {} }))

import {
  createPanelWindow,
  closePanelWindow,
  hidePanelWindow,
  resizePanelWindow,
  getPanelWindow
} from '../panel-window'

/** How many times resolvePanelWindow() had to rescue a stale reference. Correct
 *  code never needs to — see the assertions for why this is the only signal that
 *  distinguishes a right reference from a rescued wrong one. */
const recoveries = (): number => recoverLog.length
let recoverLog: string[] = []

describe('panel window reference survives a close that never completes', () => {
  beforeEach(() => {
    ALL_WINDOWS = []
    // Drain any window a previous test left adopted.
    const stale = getPanelWindow()
    if (stale) (stale as unknown as FakeWindow).finishClose?.()
    ALL_WINDOWS = []
    recoverLog = []
    vi.spyOn(console, 'log').mockImplementation((msg: unknown) => {
      if (typeof msg === 'string' && msg.includes('recovered stale panelWindow')) {
        recoverLog.push(msg)
      }
    })
  })

  it('keeps operating on the window when close() does not destroy it', () => {
    const win = createPanelWindow() as unknown as FakeWindow

    // The user hits the close button. close() is requested but — for whatever
    // reason — the window does not actually go away.
    closePanelWindow()
    expect(win.closeCalls).toBe(1)
    expect(win.isDestroyed()).toBe(false)

    // THE BUG: with the ref eagerly nulled, this second attempt did nothing at
    // all. The user clicked X again and again against a dead reference.
    closePanelWindow()
    expect(win.closeCalls).toBe(2)

    // Same for every other guarded op — these were the silent no-ops measured
    // live over the debug port.
    resizePanelWindow(340)
    expect(win.getBounds().height).toBe(340)

    hidePanelWindow()
    expect(win.isVisible()).toBe(false)

    // …and the ref must never have gone stale in the first place. Without this
    // the test passes on the BUGGY code too: resolvePanelWindow() recovers the
    // window from getAllWindows() either way, masking the very null it exists to
    // survive. The recovery log is the only observable difference between "the
    // ref was correct" and "the ref was wrong and we papered over it".
    expect(recoveries()).toBe(0)
  })

  it('a late closed event from an old window does not orphan the new one', () => {
    const first = createPanelWindow() as unknown as FakeWindow
    closePanelWindow()
    first.finishClose() // old window really goes away, fires 'closed'

    // A fresh panel opens.
    const second = createPanelWindow() as unknown as FakeWindow
    expect(second).not.toBe(first)

    // A duplicate/late 'closed' from the ALREADY-dead first window must not
    // clear the reference to the live second one.
    const before = recoveries()
    first.emit('closed')

    resizePanelWindow(400)
    expect(second.getBounds().height).toBe(400)
    // Same reasoning as above: the resize succeeds either way via the safety
    // net, so the orphaning is only visible as a recovery.
    expect(recoveries()).toBe(before)
  })

  it('never builds a second panel while one is already on screen', () => {
    const first = createPanelWindow()
    const again = createPanelWindow()
    expect(again).toBe(first)
    expect(ALL_WINDOWS.filter((w) => !w.isDestroyed())).toHaveLength(1)
  })
})
