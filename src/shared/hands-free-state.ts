/**
 * The states hands-free dictation can be in, shared by the Mac HUD card and the
 * phone's `HandsFreePill` so one mode never gets two vocabularies. The phone
 * derives its value in `hands-free-rules.ts`; the Mac's host renderer reports
 * its own over `CHANNELS.handsFreeHostState`.
 *
 * `starting` is load-bearing on both surfaces: ~15MB of VAD model loads before
 * the first word can land, and a mic that only lights up once ready reads as a
 * dropped gesture.
 */
export const HANDS_FREE_STATE = {
  off: 'off',
  /** Mic granted, VAD model still loading. */
  starting: 'starting',
  /** Armed and waiting for speech. */
  listening: 'listening',
  /** Speech in progress right now — the phone seats its mic, the HUD lights up. */
  speaking: 'speaking',
  failed: 'failed'
} as const

export type HandsFreeState = (typeof HANDS_FREE_STATE)[keyof typeof HANDS_FREE_STATE]

/** What the host renderer reports up. `message` is set only on `failed`. */
export interface HandsFreeHostState {
  state: HandsFreeState
  message?: string
}
