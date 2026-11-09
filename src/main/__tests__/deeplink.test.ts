import { describe, it, expect, vi, beforeEach } from 'vitest'

// deeplink.ts imports electron + two main-process modules at load time; the test
// runner has no Electron, so stub them. vi.mock is hoisted above the file, so the
// spies it references must live in vi.hoisted() (also hoisted) to avoid a TDZ error.
const H = vi.hoisted(() => {
  const send = vi.fn()
  return {
    send,
    showSettingsWindow: vi.fn(),
    broadcastBalance: vi.fn(async () => {}),
    // Default false = "no upgrade window open", so the existing tests keep
    // asserting the Settings fallback. Flipped per-test for the upgrade path.
    focusUpgradeWindow: vi.fn(() => false),
    fakeWin: {
      isDestroyed: () => false,
      isMinimized: () => false,
      restore: vi.fn(),
      webContents: { send }
    }
  }
})

// `hide` is exercised via applyDockIcon: focusApp() raises the app with dock.show()
// then settles back to the pref (default off) on a setImmediate.
vi.mock('electron', () => ({
  app: { dock: { show: vi.fn(async () => {}), hide: vi.fn(), isVisible: vi.fn(() => false) }, setActivationPolicy: vi.fn() },
  BrowserWindow: { getAllWindows: () => [H.fakeWin] }
}))
vi.mock('../settings-window', () => ({ showSettingsWindow: H.showSettingsWindow }))
vi.mock('../billing', () => ({ broadcastBalance: H.broadcastBalance }))
vi.mock('../upgrade-window', () => ({ focusUpgradeWindow: H.focusUpgradeWindow }))
vi.mock('../canvas-window', () => ({ showCanvasWindow: vi.fn() }))
vi.mock('../mighty/mighty-window', () => ({ getMightyWindow: () => null, showAgentInCodeTab: vi.fn(), showMightyWindow: vi.fn() }))
vi.mock('../side-browser', () => ({ queueAgentUrl: vi.fn() }))
vi.mock('../browser-task/shared-mods', () => ({ modLinkUrl: (id: string) => `mod/${id}` }))

import { parseDeepLink, handleDeepLink } from '../deeplink'
import { CHANNELS } from '../../shared/ipc'
import { CONFIG } from '../../shared/config'

// Read the scheme rather than hardcoding 'mightymouse' — it is 'mightymouse-staging'
// whenever the resolved env is staging, which under vitest (IS_DEV) is always. A
// literal here made every case fail for the one uninteresting reason, and made the
// wrong-path cases below pass for the wrong reason.
const SCHEME = CONFIG.PROTOCOL_SCHEME

describe('parseDeepLink', () => {
  it('parses a success URL with session_id', () => {
    expect(parseDeepLink(`${SCHEME}://billing/success?session_id=cs_test_123`)).toEqual({
      kind: 'checkout',
      status: 'success',
      sessionId: 'cs_test_123'
    })
  })

  it('parses a cancel URL (no session_id)', () => {
    expect(parseDeepLink(`${SCHEME}://billing/cancel`)).toEqual({
      kind: 'checkout',
      status: 'cancel',
      sessionId: undefined
    })
  })

  it('is case-insensitive on the action', () => {
    expect(parseDeepLink(`${SCHEME}://billing/SUCCESS`)).toMatchObject({ status: 'success' })
  })

  it('returns unknown for a wrong scheme', () => {
    expect(parseDeepLink('https://mightymouse.app/billing/success')).toEqual({ kind: 'unknown' })
  })

  it('returns unknown for an unrecognised host/action', () => {
    expect(parseDeepLink(`${SCHEME}://billing/refund`)).toEqual({ kind: 'unknown' })
    expect(parseDeepLink(`${SCHEME}://auth/login`)).toEqual({ kind: 'unknown' })
  })

  it('never throws on garbage input', () => {
    expect(parseDeepLink('not a url')).toEqual({ kind: 'unknown' })
    expect(parseDeepLink('')).toEqual({ kind: 'unknown' })
  })

  it('parses an onboard email handoff', () => {
    expect(parseDeepLink(`${SCHEME}://onboard?email=roy%40example.com`)).toEqual({
      kind: 'onboard',
      email: 'pat@example.com'
    })
  })

  it('returns unknown for an onboard link with no email', () => {
    expect(parseDeepLink(`${SCHEME}://onboard`)).toEqual({ kind: 'unknown' })
    expect(parseDeepLink(`${SCHEME}://onboard?email=`)).toEqual({ kind: 'unknown' })
  })
})

describe('handleDeepLink', () => {
  beforeEach(() => {
    H.send.mockClear()
    H.showSettingsWindow.mockClear()
    H.broadcastBalance.mockClear()
    H.focusUpgradeWindow.mockClear()
    H.focusUpgradeWindow.mockReturnValue(false)
  })

  it('on success: focuses Settings, pushes return, refreshes balance', async () => {
    await handleDeepLink(`${SCHEME}://billing/success?session_id=cs_1`)
    expect(H.showSettingsWindow).toHaveBeenCalled()
    expect(H.send).toHaveBeenCalledWith(CHANNELS.billingCheckoutReturn, 'success')
    expect(H.broadcastBalance).toHaveBeenCalled()
  })

  it('on cancel: pushes return but does NOT refresh balance', async () => {
    await handleDeepLink(`${SCHEME}://billing/cancel`)
    expect(H.send).toHaveBeenCalledWith(CHANNELS.billingCheckoutReturn, 'cancel')
    expect(H.broadcastBalance).not.toHaveBeenCalled()
  })

  // The upgrade window renders the success/failure state itself, so raising
  // Settings over it would hide the outcome the buyer came back to see.
  it('returns the buyer to the upgrade window when one is open, not Settings', async () => {
    H.focusUpgradeWindow.mockReturnValue(true)
    await handleDeepLink(`${SCHEME}://billing/success?session_id=cs_1`)
    expect(H.focusUpgradeWindow).toHaveBeenCalled()
    expect(H.showSettingsWindow).not.toHaveBeenCalled()
    expect(H.send).toHaveBeenCalledWith(CHANNELS.billingCheckoutReturn, 'success')
  })

  it('ignores an unrecognised URL (no side effects)', async () => {
    await handleDeepLink(`${SCHEME}://nope`)
    expect(H.showSettingsWindow).not.toHaveBeenCalled()
    expect(H.send).not.toHaveBeenCalled()
  })
})
