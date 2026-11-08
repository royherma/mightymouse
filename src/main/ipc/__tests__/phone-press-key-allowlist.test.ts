import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ typeText: vi.fn(), pressKeys: vi.fn(async () => undefined), mayControl: true }))

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', getPath: () => '/tmp', getAppPath: () => process.cwd() },
  screen: {},
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../../platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../platform')>()
  return { ...actual, input: { ...actual.input, typeText: h.typeText, pressKeys: h.pressKeys } }
})
vi.mock('../phone-remote', () => ({ phoneMayControlMac: () => h.mayControl }))
vi.mock('../phone-remote-context', () => ({ sendAppContext: () => undefined, clipboardHasContent: () => false }))

const { handlePressKey, handleTmuxAction } = await import('../phone-remote-pointer')

type PressKey = Parameters<typeof handlePressKey>[0]
const press = (key: unknown, modifiers?: unknown): void =>
  handlePressKey({ type: 'pressKey', key, modifiers } as unknown as PressKey)

beforeEach(() => {
  h.typeText.mockClear()
  h.pressKeys.mockClear()
  h.mayControl = true
})

describe('phone pressKey allowlist', () => {
  it('sends a known key with known modifiers', () => {
    press('return', ['cmd'])
    expect(h.typeText).toHaveBeenCalledWith('cmd+return', 'key')
  })

  it('drops a key name or modifier that is not in the vocabulary', () => {
    press('return; rm -rf ~')
    press('a+cmd')
    press('return', ['cmd', 'sudo'])
    press('return', 'cmd')
    press({ toString: () => 'return' })
    expect(h.typeText).not.toHaveBeenCalled()
  })

  it('sends nothing while the Mac has not granted control', () => {
    h.mayControl = false
    press('return')
    expect(h.typeText).not.toHaveBeenCalled()
  })
})

describe('phone tmuxAction allowlist', () => {
  it('drops an action outside the closed set', () => {
    handleTmuxAction({ type: 'tmuxAction', action: 'kill-server' } as unknown as Parameters<typeof handleTmuxAction>[0])
    handleTmuxAction({ type: 'tmuxAction', action: '__proto__' } as unknown as Parameters<typeof handleTmuxAction>[0])
    expect(h.pressKeys).not.toHaveBeenCalled()
  })
})
