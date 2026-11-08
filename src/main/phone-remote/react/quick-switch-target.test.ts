/**
 * Locks the one contract quick-switch keeps regressing on: the app the phone
 * SHOWS as the target and the app it ASKS the Mac to activate must always be
 * the same app. Both come from quickSwitchTargetIndex, so these cases pin its
 * arithmetic to what the Mac's quickSwitchApps() does with the same inputs.
 *
 */
import { describe, it, expect } from 'vitest'
import { quickSwitchTargetIndex, type QuickSwitchTarget } from './TouchpadControls'

function apps(n: number): QuickSwitchTarget[] {
  return Array.from({ length: n }, (_, i) => ({
    name: `App${i}`,
    bundleId: `com.example.app${i}`,
    iconPngBase64: ''
  }))
}

describe('quickSwitchTargetIndex', () => {
  it('steps forward from the anchor, not from the top of the list', () => {
    const list = apps(5)
    // The regression: with the anchor on app2, one step must land on app3.
    // Reading apps[steps] instead would answer app1 -- the stale-preview bug.
    expect(quickSwitchTargetIndex(list, 'com.example.app2', 1)).toBe(3)
    expect(quickSwitchTargetIndex(list, 'com.example.app2', 2)).toBe(4)
  })

  it('starts at index 0 with no anchor (first tap of a session)', () => {
    expect(quickSwitchTargetIndex(apps(5), null, 1)).toBe(1)
  })

  it('starts at index 0 when the anchor app has quit', () => {
    // Matches the Mac's indexOf -> -1 -> from = 0 fallback.
    expect(quickSwitchTargetIndex(apps(5), 'com.example.gone', 1)).toBe(1)
  })

  it('wraps past the end so the button is never a dead no-op', () => {
    const list = apps(3)
    expect(quickSwitchTargetIndex(list, 'com.example.app2', 1)).toBe(0)
    // A full lap returns to where it started.
    expect(quickSwitchTargetIndex(list, 'com.example.app1', 3)).toBe(1)
  })

  it('never resolves to the app already in front, given 2+ apps', () => {
    // Always stepping OFF our own index is what killed the dead-tap bug.
    const list = apps(4)
    for (let i = 0; i < list.length; i++) {
      const target = quickSwitchTargetIndex(list, list[i].bundleId, 1)
      expect(target).not.toBe(i)
    }
  })

  it('walks A -> B -> C -> D across repeated single taps', () => {
    // Each tap re-anchors on what the previous one resolved, exactly as the
    // send path does. Forward progress, never a two-app ping-pong.
    const list = apps(4)
    let anchor: string | null = null
    const walked: string[] = []
    for (let tap = 0; tap < 4; tap++) {
      const next = list[quickSwitchTargetIndex(list, anchor, 1)]
      walked.push(next.name)
      anchor = next.bundleId
    }
    expect(walked).toEqual(['App1', 'App2', 'App3', 'App0'])
  })
})
