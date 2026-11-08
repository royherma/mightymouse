import { describe, it, expect, beforeEach, vi } from 'vitest'

// The suite runs on `environment: 'node'`, which has no localStorage. A map is
// the whole contract these prefs use, so stub it here rather than pull jsdom in
// for one file — same approach as referral-cache.test.ts.
const store = new Map<string, string>()
globalThis.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size
  }
} as Storage

// The native bridge is what makes drag ticks fire at all; stub it present so
// these tests exercise the PREF precedence rather than host detection.
vi.mock('./native-bridge', () => ({
  nativeBridge: { available: true, haptic: vi.fn(), hapticWarm: vi.fn() }
}))

import { nativeBridge } from './native-bridge'

const haptic = vi.mocked(nativeBridge.haptic)

/** Fresh module per case: the prefs are module-level state seeded from
 *  localStorage at import, which is exactly the seeding being tested. */
async function load(master: boolean, drag: boolean) {
  localStorage.setItem('mm-remote-haptics', master ? 'on' : 'off')
  localStorage.setItem('mm-remote-haptics-drag', drag ? 'on' : 'off')
  vi.resetModules()
  return await import('./haptics')
}

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
})

describe('drag haptics pref', () => {
  it('both on -> engage fires', async () => {
    const h = await load(true, true)
    h.hapticDragEngage()
    expect(haptic).toHaveBeenCalledTimes(1)
  })

  it('drag off -> engage is silent even with the master on', async () => {
    const h = await load(true, false)
    h.hapticDragEngage()
    expect(haptic).not.toHaveBeenCalled()
  })

  it('master off -> silent regardless of the drag pref', async () => {
    const h = await load(false, true)
    h.hapticDragEngage()
    h.hapticDragDetent(999, 999)
    expect(haptic).not.toHaveBeenCalled()
  })

  it('defaults ON when never set, like the master switch', async () => {
    vi.resetModules()
    const h = await import('./haptics')
    expect(h.getDragHapticsEnabled()).toBe(true)
  })

  it('release follows the MASTER switch, not the drag pref', async () => {
    const h = await load(true, false)
    h.hapticDragRelease()
    expect(haptic).toHaveBeenCalledTimes(1)
  })
})
