import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  advanced: false,
  settingsOpened: [] as unknown[],
  loaded: [] as Array<Record<string, string>>,
  sent: [] as unknown[][]
}))

vi.mock('electron', () => {
  class FakeWindow {
    webContents = {
      on: () => {},
      send: (...args: unknown[]) => h.sent.push(args),
      isCrashed: () => false,
      setZoomLevel: () => {},
      getZoomLevel: () => 0
    }
    on(): void {}
    show(): void {}
    focus(): void {}
    isDestroyed(): boolean {
      return false
    }
    loadURL(): void {}
    loadFile(_path: string, opts: { query: Record<string, string> }): void {
      h.loaded.push(opts.query)
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
vi.mock('../../store/settings', () => ({ SETTINGS: { advancedMode: () => h.advanced } }))
vi.mock('../../settings-window', () => ({
  showSettingsWindow: (section: unknown) => h.settingsOpened.push(section)
}))

async function freshModule(): Promise<typeof import('../mighty-window')> {
  vi.resetModules()
  return import('../mighty-window')
}

beforeEach(() => {
  h.advanced = false
  h.settingsOpened = []
  h.loaded = []
  h.sent = []
})

describe('showMightyWindow with Advanced off', () => {
  it('a plain open goes to Phone Remote settings, not the main window', async () => {
    const { showMightyWindow } = await freshModule()
    showMightyWindow()
    expect(h.settingsOpened).toEqual(['phoneRemote'])
    expect(h.loaded).toHaveLength(0)
  })

  it('opening the Library with nothing selected (tray History) opens the main window on the Library', async () => {
    const { showMightyWindow } = await freshModule()
    showMightyWindow(false, undefined, '')
    expect(h.settingsOpened).toEqual([])
    expect(h.loaded).toEqual([{ window: 'mighty', simple: '1', focus: '' }])
  })

  it('opening a capture card lands on that capture in the Library', async () => {
    const { showMightyWindow } = await freshModule()
    showMightyWindow(false, undefined, '/Users/me/Captures/2026-11-07 10.12')
    expect(h.settingsOpened).toEqual([])
    expect(h.loaded[0]).toMatchObject({ simple: '1', focus: '/Users/me/Captures/2026-11-07 10.12' })
  })

  it('a second capture open reuses the window and tells it which folder to select', async () => {
    const { showMightyWindow } = await freshModule()
    showMightyWindow(false, undefined, '')
    showMightyWindow(false, undefined, '/Users/me/Captures/b')
    expect(h.loaded).toHaveLength(1)
    expect(h.sent.at(-1)?.[1]).toBe('/Users/me/Captures/b')
    expect(h.settingsOpened).toEqual([])
  })

  it('a session open with Advanced off still goes to Phone Remote settings', async () => {
    const { showMightyWindow } = await freshModule()
    showMightyWindow(false, 'session-1')
    expect(h.settingsOpened).toEqual(['phoneRemote'])
    expect(h.loaded).toHaveLength(0)
  })
})

describe('showMightyWindow with Advanced on', () => {
  it('a plain open opens the main window', async () => {
    h.advanced = true
    const { showMightyWindow } = await freshModule()
    showMightyWindow()
    expect(h.settingsOpened).toEqual([])
    expect(h.loaded).toHaveLength(1)
    expect(h.loaded[0].simple).toBeUndefined()
  })
})
