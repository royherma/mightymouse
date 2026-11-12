import { beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (...args: unknown[]) => void

const h = vi.hoisted(() => ({
  windows: [] as Array<{
    crashed: boolean
    destroyed: boolean
    reloads: number
    sent: unknown[][]
    wcHandlers: Record<string, Handler>
  }>,
  loaded: 0
}))

vi.mock('electron', () => {
  class FakeWindow {
    state = { crashed: false, destroyed: false, reloads: 0, sent: [] as unknown[][], wcHandlers: {} as Record<string, Handler> }
    handlers: Record<string, Handler> = {}
    webContents = {
      on: (event: string, fn: Handler) => {
        this.state.wcHandlers[event] = fn
      },
      send: (...args: unknown[]) => {
        if (this.state.crashed) throw new Error('Render frame was disposed before WebFrameMain could be accessed')
        this.state.sent.push(args)
      },
      isCrashed: () => this.state.crashed,
      reload: () => {
        this.state.reloads++
        this.state.crashed = false
      },
      setZoomLevel: () => {},
      getZoomLevel: () => 0
    }
    constructor() {
      h.windows.push(this.state)
    }
    on(event: string, fn: Handler): void {
      this.handlers[event] = fn
    }
    show(): void {}
    focus(): void {}
    isDestroyed(): boolean {
      return this.state.destroyed
    }
    destroy(): void {
      this.state.destroyed = true
      this.handlers['closed']?.()
    }
    loadURL(): void {
      h.loaded++
    }
    loadFile(): void {
      h.loaded++
    }
    static getAllWindows(): FakeWindow[] {
      return []
    }
  }
  const area = { x: 0, y: 0, width: 1512, height: 860 }
  return {
    BrowserWindow: FakeWindow,
    screen: { getPrimaryDisplay: () => ({ workArea: area }), getAllDisplays: () => [{ workArea: area }] }
  }
})
vi.mock('../../platform', () => ({ chrome: { windowOptions: () => ({}) } }))
vi.mock('../../side-browser', () => ({ tabUnderCursor: () => null }))
vi.mock('../../store/prefs', () => ({
  PREFS: {
    getMightyWindowBounds: () => null,
    getMightyName: () => 'MightyMouse',
    getMightyLastMode: () => null,
    getMightyLastCodeSession: () => null,
    getMightyZoomLevel: () => 0
  }
}))
vi.mock('../../store/settings', () => ({ SETTINGS: { advancedMode: () => true } }))
vi.mock('../../settings-window', () => ({ showSettingsWindow: () => {} }))

async function freshModule(): Promise<typeof import('../mighty-window')> {
  vi.resetModules()
  return import('../mighty-window')
}

function crashRenderer(win: (typeof h.windows)[number], reason = 'crashed'): void {
  win.crashed = true
  win.wcHandlers['render-process-gone']?.({}, { reason, exitCode: 5 })
}

beforeEach(() => {
  h.windows = []
  h.loaded = 0
  vi.useRealTimers()
})

describe('Mighty window after its renderer crashes', () => {
  it('reloads the page so later sends reach a live frame instead of a disposed one', async () => {
    const { showMightyWindow, getMightyWindow } = await freshModule()
    showMightyWindow()
    crashRenderer(h.windows[0])

    expect(h.windows[0].reloads).toBe(1)
    expect(() => getMightyWindow()?.webContents.send('agent-relay-status', {})).not.toThrow()
    expect(h.windows[0].sent).toEqual([['agent-relay-status', {}]])
  })

  it('hands back no window while the renderer is still dead, so broadcasts skip it', async () => {
    vi.useFakeTimers()
    const { showMightyWindow, getMightyWindow } = await freshModule()
    showMightyWindow()
    crashRenderer(h.windows[0])
    crashRenderer(h.windows[0])

    expect(h.windows[0].reloads).toBe(1)
    expect(getMightyWindow()).toBeNull()
  })

  it('a crash loop stops reloading, and the next open builds a fresh window', async () => {
    vi.useFakeTimers()
    const { showMightyWindow } = await freshModule()
    showMightyWindow()
    crashRenderer(h.windows[0])
    crashRenderer(h.windows[0])

    showMightyWindow(false, undefined, '/Users/me/Captures/a')
    expect(h.windows[0].destroyed).toBe(true)
    expect(h.windows).toHaveLength(2)
    expect(h.loaded).toBe(2)
  })

  it('a clean exit is not treated as a crash', async () => {
    const { showMightyWindow } = await freshModule()
    showMightyWindow()
    h.windows[0].wcHandlers['render-process-gone']?.({}, { reason: 'clean-exit', exitCode: 0 })
    expect(h.windows[0].reloads).toBe(0)
  })
})
