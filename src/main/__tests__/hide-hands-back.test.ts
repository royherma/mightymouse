import { describe, it, expect, vi, beforeEach } from 'vitest'

const calls: string[] = []

vi.mock('electron', () => ({
  app: { hide: () => {} },
  screen: {},
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))
vi.mock('../analytics', () => ({ track: () => {} }))
vi.mock('../platform', () => ({ captureContext: async () => ({}), chrome: {} }))
vi.mock('../ipc/panel-state', () => ({
  getPanelState: () => null,
  buildCtxLabel: () => '',
  buildCtxIdentity: () => ({}),
  actionVisible: () => true
}))
vi.mock('../store/actions', () => ({ ACTIONS: { load: () => [] } }))
vi.mock('../store/prefs', () => ({ PREFS: {} }))
vi.mock('../platform/macos/frontmost-watch', () => ({ currentForeignFrontmostBundleId: () => 'com.google.Chrome' }))
vi.mock('../platform/macos/activate-app', () => ({
  activateApp: (id: string) => {
    calls.push(`activate ${id}`)
    return true
  }
}))

const { hideHandingBack } = await import('../panel-window')

function fakeWindow(focused: boolean): Parameters<typeof hideHandingBack>[0] {
  return {
    isDestroyed: () => false,
    isFocused: () => focused,
    hide: () => calls.push('hide')
  } as unknown as Parameters<typeof hideHandingBack>[0]
}

describe('hideHandingBack', () => {
  beforeEach(() => {
    calls.length = 0
    Object.defineProperty(process, 'platform', { value: 'darwin' })
  })

  it('puts the previous app in front BEFORE hiding a focused window', () => {
    hideHandingBack(fakeWindow(true))
    expect(calls).toEqual(['activate com.google.Chrome', 'hide'])
  })

  it('only hides when the window was not in front', () => {
    hideHandingBack(fakeWindow(false))
    expect(calls).toEqual(['hide'])
  })
})
