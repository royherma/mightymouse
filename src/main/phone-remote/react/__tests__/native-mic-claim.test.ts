import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PHONE_AUDIO_TO } from '@shared/types'

interface NativeWindowLike {
  __mmNative?: { emit(event: unknown): void }
}

async function loadBridge() {
  vi.resetModules()
  vi.stubGlobal('window', globalThis)
  const mod = await import('../native-bridge')
  const emit = (globalThis as unknown as NativeWindowLike).__mmNative?.emit
  if (!emit) throw new Error('native event sink not installed')
  return { mod, emit }
}

describe('native mic claim', () => {
  beforeEach(() => {
    delete (globalThis as unknown as NativeWindowLike).__mmNative
  })

  it('is claimed from nativeMicStart until the recorder reports stopped', async () => {
    const { mod, emit } = await loadBridge()
    const seen: boolean[] = []
    mod.subscribeNativeMicClaim((c) => seen.push(c))
    expect(mod.nativeMicClaimed()).toBe(false)
    mod.nativeBridge.nativeMicStart(PHONE_AUDIO_TO.paste, false)
    expect(mod.nativeMicClaimed()).toBe(true)
    emit({ type: 'nativeMicLevel', level: 0.3 })
    expect(mod.nativeMicClaimed()).toBe(true)
    emit({ type: 'nativeMicStopped' })
    expect(mod.nativeMicClaimed()).toBe(false)
    expect(seen).toEqual([true, false])
  })

  it('releases the claim when the recorder fails, so the mirror gets its sound back', async () => {
    const { mod, emit } = await loadBridge()
    mod.nativeBridge.nativeMicStart(PHONE_AUDIO_TO.paste, false)
    emit({ type: 'nativeMicFailed', reason: 'denied' })
    expect(mod.nativeMicClaimed()).toBe(false)
  })

  it('notifies only on a real change, and stops notifying after unsubscribe', async () => {
    const { mod } = await loadBridge()
    const seen: boolean[] = []
    const off = mod.subscribeNativeMicClaim((c) => seen.push(c))
    mod.setNativeMicClaim(true)
    mod.setNativeMicClaim(true)
    mod.setNativeMicClaim(false)
    off()
    mod.setNativeMicClaim(true)
    expect(seen).toEqual([true, false])
  })
})
