import { describe, it, expect, vi, beforeEach } from 'vitest'

// quick-switch now directly activates an app by bundle id instead of faking a
// Cmd+Tab HUD cycle -- see the module header for why. These mocks stand in
// for the MRU app list and the native activation call so these tests can
// exercise the CLAMPING and SERIALIZATION logic without touching real apps.

const activateApp = vi.hoisted(() => vi.fn(() => true))
const listSwitchableApps = vi.hoisted(() => vi.fn())

vi.mock('./activate-app', () => ({ activateApp }))
vi.mock('./app-switcher-list', () => ({ listSwitchableApps }))
vi.mock('../../../shared/env', () => ({
  devLog: { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import {
  quickSwitchApps,
  afterQuickSwitchQueue,
  resetQuickSwitchAnchor,
  getQuickSwitchAnchor,
  QUICK_SWITCH_MAX_STEPS
} from './quick-switch'

interface FakeApp {
  name: string
  bundleId: string
  iconPngBase64: string
}

/** A fake MRU list, index 0 = frontmost, same shape as listSwitchableApps(). */
function fakeApps(n: number): FakeApp[] {
  return Array.from({ length: n }, (_, i) => ({
    name: `App${i}`,
    bundleId: `com.example.app${i}`,
    iconPngBase64: ''
  }))
}

/** The bundleId of each activateApp call, in order. */
function bundleIdsSent(): string[] {
  return activateApp.mock.calls.map(([bundleId]: [string]) => bundleId)
}

beforeEach(() => {
  activateApp.mockClear()
  activateApp.mockReturnValue(true)
  listSwitchableApps.mockReset()
  listSwitchableApps.mockReturnValue(fakeApps(10))
  // Each test starts with no "current app" memory, as on a fresh launch.
  resetQuickSwitchAnchor()
})

describe('quickSwitchApps', () => {
  it('steps forward from the first app on the opening tap', async () => {
    const target = await quickSwitchApps(2)
    expect(activateApp).toHaveBeenCalledTimes(1)
    expect(activateApp).toHaveBeenCalledWith('com.example.app2')
    expect(target?.bundleId).toBe('com.example.app2')
  })

  it('walks FORWARD on each tap instead of bouncing between two apps', async () => {
    // The bug this fix exists for: with an ordering that never reorders,
    // indexing from the top made every steps=1 tap resolve to the same app,
    // so taps alternated A -> B -> A -> B and often no-op'd entirely.
    for (let i = 0; i < 4; i++) await quickSwitchApps(1)
    expect(bundleIdsSent()).toEqual([
      'com.example.app1',
      'com.example.app2',
      'com.example.app3',
      'com.example.app4'
    ])
  })

  it('never targets the app it is already on', async () => {
    listSwitchableApps.mockReturnValue(fakeApps(3))
    for (let i = 0; i < 6; i++) await quickSwitchApps(1)
    const sent = bundleIdsSent()
    for (let i = 1; i < sent.length; i++) expect(sent[i]).not.toBe(sent[i - 1])
  })

  it('wraps past the end of the list back to the start', async () => {
    listSwitchableApps.mockReturnValue(fakeApps(3))
    for (let i = 0; i < 4; i++) await quickSwitchApps(1)
    expect(bundleIdsSent()).toEqual([
      'com.example.app1',
      'com.example.app2',
      'com.example.app0',
      'com.example.app1'
    ])
  })

  it('laps the list when steps exceeds its length, rather than sticking at the end', async () => {
    listSwitchableApps.mockReturnValue(fakeApps(3))
    await quickSwitchApps(5)
    expect(bundleIdsSent()).toEqual(['com.example.app2'])
  })

  it('restarts from the top when the app it was on has quit', async () => {
    await quickSwitchApps(1)
    expect(bundleIdsSent()).toEqual(['com.example.app1'])
    // app1 is gone from the list -> anchor no longer found -> walk from index 0.
    listSwitchableApps.mockReturnValue([fakeApps(10)[0], ...fakeApps(10).slice(2)])
    await quickSwitchApps(1)
    expect(bundleIdsSent()[1]).toBe('com.example.app2')
  })

  it('clamps a runaway count to the max', async () => {
    await quickSwitchApps(999)
    expect(bundleIdsSent()).toEqual([`com.example.app${QUICK_SWITCH_MAX_STEPS}`])
  })

  it('treats a zero, negative, or fractional count as one step', async () => {
    for (const bad of [0, -5, 0.4]) {
      activateApp.mockClear()
      resetQuickSwitchAnchor()
      await quickSwitchApps(bad)
      expect(bundleIdsSent()).toEqual(['com.example.app1'])
    }
  })

  it('degrades a non-finite count to one step instead of throwing', async () => {
    for (const bad of [NaN, Infinity]) {
      activateApp.mockClear()
      resetQuickSwitchAnchor()
      await expect(quickSwitchApps(bad)).resolves.toBeDefined()
      expect(bundleIdsSent()).toEqual(['com.example.app1'])
    }
  })

  it('does not advance the anchor when activation fails', async () => {
    activateApp.mockReturnValueOnce(false)
    await expect(quickSwitchApps(1)).resolves.toBeUndefined()
    // The failed target must not become "where we are" -- otherwise one failed
    // activate silently skips an app on the next tap.
    await quickSwitchApps(1)
    expect(bundleIdsSent()).toEqual(['com.example.app1', 'com.example.app1'])
  })

  it('resolves undefined and does not call activateApp when the list is empty', async () => {
    listSwitchableApps.mockReturnValue([])
    await expect(quickSwitchApps(1)).resolves.toBeUndefined()
    expect(activateApp).not.toHaveBeenCalled()
  })

  it('does not serialize on its own -- callers must use afterQuickSwitchQueue', async () => {
    // quickSwitchApps() no longer owns a queue (owning one caused a deadlock
    // when called from inside an afterQuickSwitchQueue() job -- see that
    // function's header comment). Serialization is afterQuickSwitchQueue's
    // job now, tested below. listSwitchableApps/activateApp are synchronous
    // here, so overlap is checked by calling them concurrently via Promise.all
    // and confirming all three calls landed.
    await Promise.all([quickSwitchApps(1), quickSwitchApps(2), quickSwitchApps(3)])
    expect(activateApp).toHaveBeenCalledTimes(3)
    // Which apps they land on depends on interleaving (each tap advances the
    // shared anchor) -- serialization is afterQuickSwitchQueue's job, asserted
    // in its own describe block. Only the call count is meaningful here.
  })
})

describe('getQuickSwitchAnchor', () => {
  it('is null before the first tap, then names the app we landed on', async () => {
    expect(getQuickSwitchAnchor()).toBeNull()
    const target = await quickSwitchApps(1)
    expect(getQuickSwitchAnchor()).toBe(target?.bundleId)
  })

  it('tracks every hop so the phone can walk from the same index the Mac does', async () => {
    // The contract QuickSwitchOverlay depends on: reapplying the Mac's own
    // arithmetic to (anchor, steps) must name the app the Mac actually
    // activated. Broken previously because the phone assumed apps[0] was
    // current -- listSwitchableApps() does not reorder after an activate, so
    // the preview froze on one tile while the Mac walked forward.
    const apps = fakeApps(10)
    for (const steps of [1, 1, 3, 1]) {
      const before = getQuickSwitchAnchor()
      const from = before ? apps.findIndex((a) => a.bundleId === before) : -1
      const predicted = apps[((from === -1 ? 0 : from) + steps) % apps.length]

      const target = await quickSwitchApps(steps)

      expect(target?.bundleId).toBe(predicted.bundleId)
      expect(getQuickSwitchAnchor()).toBe(predicted.bundleId)
    }
  })

  it('is unchanged when activation fails, so the next tap retries from the same place', async () => {
    await quickSwitchApps(1)
    const anchor = getQuickSwitchAnchor()

    activateApp.mockReturnValueOnce(false)
    expect(await quickSwitchApps(1)).toBeUndefined()
    expect(getQuickSwitchAnchor()).toBe(anchor)
  })
})

describe('afterQuickSwitchQueue', () => {
  it('runs queued jobs one after another, never concurrently', async () => {
    let active = 0
    let maxActive = 0
    const order: number[] = []
    const job = (n: number): Promise<void> =>
      afterQuickSwitchQueue(async () => {
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise((r) => setTimeout(r, 5))
        order.push(n)
        active--
      })

    await Promise.all([job(1), job(2), job(3)])

    expect(maxActive).toBe(1)
    expect(order).toEqual([1, 2, 3])
  })

  it('does not deadlock when a queued job itself calls quickSwitchApps', async () => {
    // Regression test: quickSwitchApps() used to manage its own `inFlight`
    // queue. Calling it from inside an afterQuickSwitchQueue() job made that
    // inner queue await a promise that couldn't resolve until the outer job
    // finished -- a real deadlock that hung every phone-remote quick-switch
    // tap silently (no error, no timeout, the promise just never settled).
    await expect(
      Promise.race([
        afterQuickSwitchQueue(async () => {
          await quickSwitchApps(1)
          return 'done'
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('deadlocked')), 200))
      ])
    ).resolves.toBe('done')
  })

  it('still runs the next queued job after a prior job rejects', async () => {
    const order: string[] = []
    await expect(
      afterQuickSwitchQueue(async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')

    await afterQuickSwitchQueue(async () => {
      order.push('second')
    })

    expect(order).toEqual(['second'])
  })
})
