import { MIC_LATCH_CHROME_MS, type MicLiveState } from './mic-latch-chrome'

export type MicInertStampSource = 'latch' | 'chrome'
export type MicLeftoverSite = 'mic-btn' | 'cancel' | 'stop'

export function micInertAgeMs(now: number, inertSince: number | null): number | null {
  if (inertSince === null) return null
  return now - inertSince
}

export function micTraceInertStamp(source: MicInertStampSource): string {
  return `mic inert start src=${source} windowMs=${MIC_LATCH_CHROME_MS}`
}

export function micTraceLeftover(
  site: MicLeftoverSite,
  state: MicLiveState,
  inertSince: number | null,
  now = Date.now()
): string {
  const age = micInertAgeMs(now, inertSince)
  return `mic leftover ignored site=${site} state=${state} inertAgeMs=${age ?? 'none'}`
}

export function micTraceStop(params: {
  why: string
  discard: boolean
  state: MicLiveState
  gen: number
  inertSince: number | null
  now?: number
}): string {
  const age = micInertAgeMs(params.now ?? Date.now(), params.inertSince)
  return `mic stop why=${params.why} discard=${params.discard} state=${params.state} gen=${params.gen} inertAgeMs=${age ?? 'none'}`
}

/** Which toast nativeMicStopped will show — grep one line instead of replaying the session. */
export function micTraceNativeStopped(params: {
  discarded: boolean
  durationMs?: number
  jsDiscard: boolean
  silent: boolean
  transcribing?: boolean
}): string {
  const toast = params.jsDiscard
    ? params.silent
      ? 'none'
      : 'cancelled'
    : params.discarded
      ? 'hold-longer'
      : params.transcribing
        ? 'pending'
        : 'sent'
  return (
    `mic native-stopped swiftDiscarded=${params.discarded}` +
    ` durationMs=${params.durationMs ?? '?'}` +
    ` jsDiscard=${params.jsDiscard} toast=${toast}`
  )
}
