import React, { useRef } from 'react'
import { useIpcSubscriptions } from './hooks/useIpcSubscriptions'
import type { SoundName } from '../../shared/types'

import screenshotUrl from './sounds/screenshot.wav'
import recordStartUrl from './sounds/record-start.wav'
import recordStopUrl from './sounds/record-stop.wav'
import doneUrl from './sounds/done.wav'
import successUrl from './sounds/success.wav'
import errorUrl from './sounds/error.wav'
import thinkingUrl from './sounds/thinking.wav'

const URLS: Record<SoundName, string> = {
  screenshot: screenshotUrl,
  'record-start': recordStartUrl,
  'record-stop': recordStopUrl,
  done: doneUrl,
  success: successUrl,
  error: errorUrl,
  thinking: thinkingUrl
}

/**
 * Hidden, persistent window whose only job is to play UI sound effects.
 * The main process owns the "when" (it sends playSound IPC); this owns the
 * "how" (Web Audio, so playback is cross-platform — no afplay/native deps).
 * Lives for the whole app session so a sound can fire even when no other
 * window is open (e.g. screenshot / recording-start).
 */
export default function SoundApp(): React.ReactElement {
  // Preload one Audio per sound so the first play has no fetch/decode lag.
  const players = useRef<Record<SoundName, HTMLAudioElement> | null>(null)
  if (players.current === null) {
    players.current = Object.fromEntries(
      (Object.keys(URLS) as SoundName[]).map((name) => {
        const a = new Audio(URLS[name])
        a.preload = 'auto'
        return [name, a]
      })
    ) as Record<SoundName, HTMLAudioElement>
  }

  useIpcSubscriptions(() => [
    window.api.onPlaySound((name) => {
      const a = players.current?.[name]
      if (!a) return
      a.currentTime = 0 // restart so rapid repeats retrigger
      void a.play().catch(() => {}) // ignore autoplay/decoding errors
    })
  ])

  return <div style={{ display: 'none' }} />
}
