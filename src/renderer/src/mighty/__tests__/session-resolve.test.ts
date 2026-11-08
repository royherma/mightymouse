import { describe, it, expect } from 'vitest'
import { tabDisplayViewMode } from '../tab-view-mode'
import {
  shouldSkipSessionResolve,
  shouldWipeUnboundPane
} from '../session-resolve'

describe('shouldSkipSessionResolve — mount vs first-send', () => {
  it('does not skip on first mount (ref null, bound prop)', () => {
    expect(shouldSkipSessionResolve('s1', null)).toBe(false)
  })

  it('skips after send() sets ref before the sessionId prop catches up', () => {
    expect(shouldSkipSessionResolve('s1', 's1')).toBe(true)
  })

  it('does not skip when navigating to a different session', () => {
    expect(shouldSkipSessionResolve('s2', 's1')).toBe(false)
  })
})

describe('shouldWipeUnboundPane — first send + parent re-render', () => {
  it('does not wipe while chat() runs and sessionId prop is still null', () => {
    expect(shouldWipeUnboundPane(null, true)).toBe(false)
  })

  it('wipes a truly empty unbound pane', () => {
    expect(shouldWipeUnboundPane(null, false)).toBe(true)
  })

  it('never wipes a bound pane', () => {
    expect(shouldWipeUnboundPane('s1', false)).toBe(false)
    expect(shouldWipeUnboundPane('s1', true)).toBe(false)
  })
})

describe('addPane regression — viewMode stable + in-flight protected', () => {
  it('one-pane tab stays on grid branch so PaneGrid does not remount on addPane', () => {
    const tab = { viewMode: undefined }
    expect(tabDisplayViewMode(tab)).toBe('grid')
    expect(tabDisplayViewMode(tab)).toBe('grid')
  })

  it('sidebar refresh during first send does not qualify for unbound wipe', () => {
    expect(shouldWipeUnboundPane(null, true)).toBe(false)
  })

  it('after onSessionCreated, bound resolve skips redundant fetch', () => {
    expect(shouldSkipSessionResolve('s1', 's1')).toBe(true)
  })
})
