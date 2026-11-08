import { describe, it, expect, beforeEach, vi } from 'vitest'

/** Swift sets the bridge in `makeUIView`, before React mounts -- so an emit
 *  reaching an empty subscriber set is the NORMAL cold-launch ordering for a
 *  notification tap. It used to iterate nothing and drop the tap silently. */

interface NativeWindowLike {
  __mmNative?: { emit(event: unknown): void }
}

/** Fresh module per test: the buffer and the subscriber set are module state.
 *  `window` is stubbed because the suite runs on the `node` environment and
 *  `installNativeEventSink` returns early without one. */
async function loadBridge(): Promise<{
  subscribe: (fn: (e: unknown) => void, claims?: string[]) => () => void
  emit: (e: unknown) => void
  setDropReporter: (fn: (e: unknown) => void) => void
}> {
  vi.resetModules()
  vi.stubGlobal('window', globalThis)
  const mod = await import('../native-bridge')
  const emit = (globalThis as unknown as NativeWindowLike).__mmNative?.emit
  if (!emit) throw new Error('native event sink not installed')
  return {
    subscribe: mod.subscribeNativeIntent as (fn: (e: unknown) => void, claims?: string[]) => () => void,
    emit,
    setDropReporter: mod.setIntentDropReporter as (fn: (e: unknown) => void) => void
  }
}

const tap = (requestId: string): Record<string, string> => ({
  type: 'openRelayRequest',
  requestId
})

describe('native intent buffer', () => {
  beforeEach(() => {
    delete (globalThis as unknown as NativeWindowLike).__mmNative
  })

  it('replays a tap that arrived before any subscriber existed', async () => {
    const { subscribe, emit } = await loadBridge()
    emit(tap('req-1'))

    const seen: unknown[] = []
    subscribe((e) => seen.push(e))

    expect(seen).toEqual([tap('req-1')])
  })

  it('delivers live once a subscriber is attached', async () => {
    const { subscribe, emit } = await loadBridge()
    const seen: unknown[] = []
    subscribe((e) => seen.push(e))

    emit(tap('req-1'))

    expect(seen).toEqual([tap('req-1')])
  })

  it('replays each buffered tap exactly once', async () => {
    const { subscribe, emit } = await loadBridge()
    emit(tap('req-1'))

    const first: unknown[] = []
    subscribe((e) => first.push(e))
    // A second subscriber must not re-receive what the first already handled --
    // two layouts mount CodeSheet, and a double-replay would fight the user.
    const second: unknown[] = []
    subscribe((e) => second.push(e))

    expect(first).toHaveLength(1)
    expect(second).toHaveLength(0)
  })

  it('keeps the newest taps and reports the evicted ones', async () => {
    const { subscribe, emit, setDropReporter } = await loadBridge()
    const dropped: unknown[] = []
    setDropReporter((e) => dropped.push(e))

    for (let i = 0; i < 20; i += 1) emit(tap(`req-${i}`))

    const seen: Record<string, string>[] = []
    subscribe((e) => seen.push(e as Record<string, string>))

    // Cap is 16, oldest evicted: a newer tap is the one the user is waiting on.
    expect(seen).toHaveLength(16)
    expect(seen[0].requestId).toBe('req-4')
    expect(seen[15].requestId).toBe('req-19')
    // The 4 evicted ones are journaled, not silently gone.
    expect(dropped).toHaveLength(4)
  })

  it('never buffers a stale high-frequency intent', async () => {
    const { subscribe, emit } = await loadBridge()
    // Worthless late: it would paint a waveform for audio that already finished.
    emit({ type: 'nativeMicLevel', level: 0.4 })
    emit(tap('req-1'))

    const seen: Record<string, string>[] = []
    subscribe((e) => seen.push(e as Record<string, string>))

    expect(seen).toHaveLength(1)
    expect(seen[0].type).toBe('openRelayRequest')
  })

  it('keeps a tap buffered until the subscriber that claims it mounts', async () => {
    const { subscribe, emit } = await loadBridge()
    emit({ type: 'openDraw' })

    const early: unknown[] = []
    subscribe((e) => early.push(e), [])
    emit({ type: 'openDraw' })
    const draw: unknown[] = []
    subscribe((e) => draw.push(e), ['openDraw'])

    expect(draw).toEqual([{ type: 'openDraw' }, { type: 'openDraw' }])
  })
})
