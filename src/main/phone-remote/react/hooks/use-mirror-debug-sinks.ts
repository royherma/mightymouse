import { useEffect } from 'react'

import { setHapticDebugLogSink } from '../haptics'
import { setKbTraceSink } from '../keyboard-trace'
import { setSessionDetailLogSink } from '../SessionDetail'

import type { PhoneRemoteMessage } from '@shared/phone-remote-protocol'

/**
 * Wires every module-level debug sink to the open socket. The phone has no
 * console the Mac can read, so on-device behavior only becomes visible by
 * riding the WS as `debugLog` lines.
 */
export function useMirrorDebugSinks(send: (msg: PhoneRemoteMessage) => void): void {
  // Give haptics.ts a way to report to the Mac's dev log: the phone has no
  // console we can read remotely, so on-device behavior rides the open WS.
  useEffect(() => {
    setHapticDebugLogSink((message) => send({ type: 'debugLog', message }))
  }, [send])

  useEffect(() => {
    setKbTraceSink((text) => send({ type: 'debugLog', message: `kb-trace\n${text}` }))
  }, [send])

  useEffect(() => {
    setSessionDetailLogSink((message) => send({ type: 'debugLog', message }))
  }, [send])

  useEffect(() => {
    // Sink for useNotchPath's temporary measure/decide trace. Throttled by
    // rotation below is not enough here -- the ResizeObserver fires many times
    // per rotation and each one is a line, so keep only lines that change.
    let lastTrace = ''
    ;(window as unknown as { __notchTrace?: (s: string) => void }).__notchTrace = (s) => {
      if (s === lastTrace) return
      lastTrace = s
      send({ type: 'debugLog', message: `notch ${s}` })
    }
    let seq = 0
    const report = (tag: string): void => {
      const pad = document.querySelector('.proTouchpad') as HTMLElement | null
      const root = document.querySelector('.proRoot')
      const d = document.getElementById('proNotchDynamicPath')?.getAttribute('d') ?? ''
      // Rightmost x the path mentions, which is where the painted pad ends.
      const xs = (d.match(/[ML] *(-?[\d.]+)/g) ?? []).map((s) => parseFloat(s.slice(1)))
      send({
        type: 'debugLog',
        message:
          `rot#${seq++} ${tag} vp=${window.innerWidth}x${window.innerHeight}` +
          ` orient=${root?.getAttribute('data-orient')}` +
          ` mirror=${root?.getAttribute('data-mirror')}` +
          ` mirrorW=${getComputedStyle(document.documentElement).getPropertyValue('--pro-mirror-w').trim() || 'unset'}` +
          ` pad=${pad ? `${Math.round(pad.offsetWidth)}x${Math.round(pad.offsetHeight)}` : 'none'}` +
          ` pathMaxX=${xs.length ? Math.round(Math.max(...xs)) : 'NO-PATH'}`
      })
    }
    // iOS fires a burst of resize events per rotation; logging each would bury
    // the settled reads that actually answer the question. One block per
    // rotation, keyed on the orientation actually changing.
    let lastPortrait: boolean | null = null
    const onRot = (): void => {
      const portrait = window.innerHeight >= window.innerWidth
      if (portrait === lastPortrait) return
      lastPortrait = portrait
      report('evt')
      // Sample the settling curve: the bug is a value that never gets
      // corrected, so the interesting reads are AFTER the burst.
      setTimeout(() => report('+250ms'), 250)
      setTimeout(() => report('+1500ms'), 1500)
    }
    window.addEventListener('orientationchange', onRot)
    window.addEventListener('resize', onRot)
    return () => {
      window.removeEventListener('orientationchange', onRot)
      window.removeEventListener('resize', onRot)
      delete (window as unknown as { __notchTrace?: (s: string) => void }).__notchTrace
    }
  }, [send])
}
