import { beforeEach, describe, expect, it, vi } from 'vitest'

const frontmost = vi.hoisted(() => ({ id: 'com.cmuxterm.app' }))
const calls = vi.hoisted(() => ({
  cmuxPane: vi.fn(() => true),
  cmuxTerminal: vi.fn(() => true),
  cmuxTab: vi.fn(() => true),
  chromeTab: vi.fn(() => true)
}))

vi.mock('../frontmost-watch', () => ({
  currentFrontmostBundleId: () => frontmost.id,
  currentForeignFrontmostBundleId: () => frontmost.id
}))
vi.mock('../app-switcher-list', () => ({
  listSwitchableApps: () => [{ bundleId: 'com.apple.finder', name: 'Finder', iconPngBase64: 'icon' }]
}))
vi.mock('./osa', () => ({ runOsa: () => null, runOsaAsync: async () => null, FIELD_SEP: '\u0001\u0002' }))
vi.mock('./cmux', () => ({
  readCmux: async () => ({ items: [], groups: [], activeGroupId: '', tmuxZoomed: null }),
  activateCmuxPane: calls.cmuxPane,
  activateCmuxTerminal: calls.cmuxTerminal,
  activateCmuxTab: calls.cmuxTab
}))
vi.mock('./chrome', () => ({
  readChrome: async () => ({ items: [], groups: [], activeGroupId: '', tmuxZoomed: null }),
  readActiveTab: async () => null,
  activateChromeTab: calls.chromeTab,
  activateChromeProfile: vi.fn(() => true)
}))
vi.mock('./cursor', () => ({ readCursor: vi.fn(), activateCursorWindow: vi.fn() }))

import { activateAppGroup, activateAppItem, activateAppPane, readAppContext } from './index'

beforeEach(() => {
  frontmost.id = 'com.cmuxterm.app'
  for (const fn of Object.values(calls)) fn.mockClear()
})

describe('ids arriving from the phone before they reach a script or tmux', () => {
  it('passes a real tmux pane id through', () => {
    expect(activateAppPane('%47')).toBe(true)
    expect(calls.cmuxPane).toHaveBeenCalledWith('%47')
  })

  it.each(['%47; tmux kill-server', '47', '%', '%1234567890', '%4\n7', ''])('refuses pane id %j', (id) => {
    expect(activateAppPane(id)).toBe(false)
    expect(calls.cmuxPane).not.toHaveBeenCalled()
  })

  it.each(['tab\nend tell', 'a\u0000b', 'x\u007f', '', 'x'.repeat(129)])('refuses item and group id %j', (id) => {
    expect(activateAppItem(id)).toBe(false)
    expect(activateAppGroup(id)).toBe(false)
    expect(calls.cmuxTerminal).not.toHaveBeenCalled()
    expect(calls.cmuxTab).not.toHaveBeenCalled()
  })

  it('routes a plausible id to the frontmost app adapter only', () => {
    frontmost.id = 'com.google.Chrome'
    expect(activateAppItem('3')).toBe(true)
    expect(calls.chromeTab).toHaveBeenCalledWith('chrome', '3')
    expect(calls.cmuxTerminal).not.toHaveBeenCalled()
  })

  it('has nothing to activate in an app without an adapter, or a pane in a browser', () => {
    frontmost.id = 'com.apple.finder'
    expect(activateAppItem('1')).toBe(false)
    frontmost.id = 'com.google.Chrome'
    expect(activateAppPane('%1')).toBe(false)
  })
})

describe('readAppContext for an app with no adapter', () => {
  it('still names the app and its icon so the phone shows the chip', async () => {
    frontmost.id = 'com.apple.finder'
    expect(await readAppContext()).toMatchObject({ adapterId: null, bundleId: 'com.apple.finder', appName: 'Finder', appIconPngBase64: 'icon' })
  })
})
