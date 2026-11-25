import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  listeners: new Map<string, (...args: unknown[]) => void>(),
  menu: null as null | { webContents: { send: (...a: unknown[]) => void; sent: unknown[][]; finishLoad: () => void } }
}))

vi.mock('electron', () => {
  class FakeWindow {
    private loadDone: (() => void) | null = null
    webContents = {
      sent: [] as unknown[][],
      send: (...a: unknown[]) => this.webContents.sent.push(a),
      once: (_evt: string, cb: () => void) => (this.loadDone = cb),
      focus: () => {},
      finishLoad: () => this.loadDone?.()
    }
    constructor() {
      h.menu = this as never
    }
    setAlwaysOnTop(): void {}
    on(): void {}
    loadURL(): Promise<void> {
      return Promise.resolve()
    }
    loadFile(): Promise<void> {
      return Promise.resolve()
    }
    isDestroyed(): boolean {
      return false
    }
    hide(): void {}
    setSize(): void {}
    getSize(): number[] {
      return [300, 200]
    }
    static fromWebContents(): object {
      return { isDestroyed: () => false, show: () => {}, webContents: { focus: () => {} } }
    }
  }
  return {
    BrowserWindow: FakeWindow,
    screen: {},
    ipcMain: {
      handle: (ch: string, fn: (...a: unknown[]) => unknown) => h.handlers.set(ch, fn),
      on: (ch: string, fn: (...a: unknown[]) => void) => h.listeners.set(ch, fn)
    }
  }
})
vi.mock('../platform', () => ({ chrome: { windowOptions: () => ({}), showOnAllWorkspaces: () => {} } }))

const { registerPopoverMenu } = await import('../popover-menu')
const { CHANNELS } = await import('../../shared/ipc')

const request = (id: string) => ({ items: [{ id, label: id }], width: 240, anchor: { x: 0, y: 0, width: 10, height: 10 } })
const show = (id: string): Promise<string | null> =>
  h.handlers.get(CHANNELS.popoverMenu)!({ sender: {} }, request(id)) as Promise<string | null>
const pick = (id: string): void => h.listeners.get(CHANNELS.popoverMenuPick)!({ sender: h.menu!.webContents }, id)

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const PENDING = Symbol('pending')
const state = async <T,>(p: Promise<T>): Promise<T | typeof PENDING> => Promise.race([p, settle().then(() => PENDING)])

beforeEach(() => {
  h.handlers.clear()
  h.listeners.clear()
  registerPopoverMenu()
})

describe('popover menu replies', () => {
  it('a second open while the window is still loading answers the first with null instead of dropping it', async () => {
    const first = show('a')
    const second = show('b')
    h.menu!.webContents.finishLoad()

    expect(await state(first)).toBeNull()
    expect(await state(second)).toBe(PENDING)

    pick('b')
    expect(await second).toBe('b')
  })
})
