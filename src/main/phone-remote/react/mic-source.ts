import { nativeBridge, type GlassesSource } from './native-bridge'

// AudioCapture owns the whole AVAudioSession, so the page can only ASK for the
// glasses and then be told what the route actually became
// (`nativeMicStarted.source`).

const MIC_SOURCE_PREF_KEY = 'mm-remote-mic-source'

export function getMicSource(): GlassesSource {
  try {
    return localStorage.getItem(MIC_SOURCE_PREF_KEY) === 'glasses' ? 'glasses' : 'phone'
  } catch {
    return 'phone'
  }
}

export function setMicSource(value: GlassesSource): void {
  try {
    localStorage.setItem(MIC_SOURCE_PREF_KEY, value)
  } catch {
    // Best-effort; Swift still gets told below, so this session is correct.
  }
  nativeBridge.glassesMicSource(value)
}

/** Swift holds the choice in memory only, so a reconnecting page has to say it
 *  again or a stored `glasses` silently records from the phone. */
export function syncMicSourceToNative(): void {
  if (!nativeBridge.available) return
  nativeBridge.glassesMicSource(getMicSource())
}
