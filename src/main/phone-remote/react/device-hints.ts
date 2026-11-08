/**
 * What the browser will tell us about the device beyond the User-Agent.
 *
 * The UA alone caps out at the model FAMILY -- every iPhone reports "iPhone" --
 * which is why the Mac's paired-devices list can show two identical rows.
 *
 * Three sources, in descending order of what they can actually answer:
 * the native shell reads the hardware directly and injects it; Chromium's
 * `userAgentData` hands over a model on request; iOS Safari and the Home Screen
 * PWA answer nothing at all, and that remains a platform ceiling rather than a
 * gap to work around (every alternative signal is a fingerprinting vector).
 *
 * Display metadata and coarse analytics only. Never load-bearing: a browser that
 * refuses returns nulls and every caller carries on.
 */
import { nativeBridge } from './native-bridge'

/** Chromium's high-entropy hint API. Not in lib.dom yet, and absent entirely on
 *  WebKit/Gecko -- hence the structural type plus the runtime guard. */
type UserAgentDataLike = {
  getHighEntropyValues?: (hints: string[]) => Promise<{
    model?: string
    platformVersion?: string
  }>
}

export type DeviceHints = {
  /** "Pixel 8 Pro". Null on any non-Chromium browser, including all of iOS. */
  deviceModel: string | null
  /** "14" / "18.2". Chromium reports the platform version numerically. */
  osVersion: string | null
}

export const NO_HINTS: DeviceHints = { deviceModel: null, osVersion: null }

/**
 * Ask the browser for the model and platform version.
 *
 * ASYNC BY PLATFORM DESIGN, and that is the trap: `getHighEntropyValues`
 * returns a Promise, so a caller that fires its request without awaiting this
 * sends nulls and the fields silently never arrive. Await it BEFORE building
 * the pair request, not alongside it.
 *
 * Never rejects -- an unsupported browser and a refused request are the same
 * answer here (we don't know), and neither should be able to break pairing.
 */
export async function readDeviceHints(): Promise<DeviceHints> {
  cachedHints = await resolveDeviceHints()
  return cachedHints
}

/** Last resolved hints, for callers that cannot await.
 *
 *  The WS connect path is synchronous and re-entered on every reconnect, so it
 *  reads this instead. Primed by `primeDeviceHints()` at startup; a connect that
 *  wins the race just sends nulls and the NEXT reconnect carries the values --
 *  acceptable because this is display metadata, and the server latches whatever
 *  it has rather than overwriting a known value with a null. */
let cachedHints: DeviceHints = NO_HINTS

export function deviceHints(): DeviceHints {
  // Resolved on demand rather than served stale, so the native shell never loses
  // the race described above: its answer is injected before the bundle boots and
  // needs no await, but `readDeviceHints()` is async and only reaches the cache a
  // microtask later -- which a first connect can beat.
  if (!cachedHints.deviceModel) {
    const native = nativeBridge.device()
    if (native.deviceModel) cachedHints = native
  }
  return cachedHints
}

/** Fire-and-forget warm-up. Called once at boot so the first reconnect after a
 *  page load already has an answer to send. */
export function primeDeviceHints(): void {
  void readDeviceHints()
}

async function resolveDeviceHints(): Promise<DeviceHints> {
  // The native shell first, and synchronously: it is the ONE iOS client that can
  // name its own hardware, and it has already injected the answer by the time
  // this runs. Everything below is the Chromium path, which returns nulls on
  // every iOS browser including the WKWebView this is hosted in.
  const native = nativeBridge.device()
  if (native.deviceModel) return native
  try {
    const uaData = (navigator as Navigator & { userAgentData?: UserAgentDataLike }).userAgentData
    if (typeof uaData?.getHighEntropyValues !== 'function') return NO_HINTS
    const values = await uaData.getHighEntropyValues(['model', 'platformVersion'])
    return {
      // Chromium returns '' (not undefined) for a hint it won't answer, and an
      // empty string would overwrite a good stored value with nothing.
      deviceModel: values.model || null,
      osVersion: values.platformVersion || null
    }
  } catch {
    return NO_HINTS
  }
}
