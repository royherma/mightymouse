/** Screen-mirror stream quality. Was hand-declared identically in several
 *  components -- copies of one union that had to be kept in sync by hand.
 *  One home, imported everywhere.
 *
 *  'glasses' is not a user choice -- it is selected by the host (see
 *  qualityForHost) because a 600x600 viewport cannot display more than its own
 *  width. Encoding 1280x800 into it spent 2.8x the pixels for zero visible
 *  detail, and the cost landed as dropped frames on the weakest decoder we
 *  ship to. */
export type MirrorQuality = 'capped' | 'native' | 'glasses'

/** WHAT the phone shows while screen sharing is on:
 *  - 'mirror'   a copy of the Mac's primary display (shipped first, the default)
 *  - 'extended' the phone's OWN desktop on a virtual display, so the Mac's real
 *               monitor keeps showing the user's work
 *  - 'audio'    no screen at all -- phone mic only, for hands-free voice (the
 *               peer connection still exists so the mic transceiver works, it
 *               just never gets a video transceiver or a <video> sink)
 *  Same one-home rule as MirrorQuality above -- App.tsx, SettingsBody.tsx and
 *  both layouts import this rather than re-declaring the union. */
export type MirrorMode = 'mirror' | 'extended' | 'audio'

export const MIRROR_MODE_DEFAULT: MirrorMode = 'mirror'

/** The quality actually sent to the Mac, given what the user picked and what
 *  host is asking. A cursorless host overrides the picker unconditionally: the
 *  Settings choice is reachable there (the deck is swipe-navigable), so a user
 *  could otherwise select 'native' and ask a 600px screen for a 4Mbps 1280x800
 *  stream it can neither show nor decode in time.
 *
 *  Pure and exported so the rule is testable without a browser -- the browser
 *  half (which host am I) is the caller's job. */
export function qualityForHost(picked: MirrorQuality, cursorless: boolean): MirrorQuality {
  return cursorless ? 'glasses' : picked
}

/** The codec the glasses negotiate for the mirror.
 *
 *  H.264 was chosen for its hardware decoder (see MIRROR_CODEC history below).
 *  VP9 is the trade being measured: it carries the screen-content tooling
 *  H.264 has no equivalent for -- QP capping when the screen is static, palette
 *  mode for flat UI -- which is what makes contentHint='text' mean anything.
 *  The risk is the other half of that trade: if the glasses decode VP9 in
 *  software, fps falls at the same resolution and this goes straight back to
 *  'video/H264'. */
export const MIRROR_PREFERRED_CODEC = 'video/VP9'

/** Reorder codecs to put `preferred` first, preserving the relative order of
 *  everything else so the rest of the negotiation is untouched.
 *
 *  Returns the input UNCHANGED when `preferred` is absent -- a codec list must
 *  still be offered in full, or the mirror negotiates nothing and fails to
 *  connect rather than merely looking worse. */
export function preferCodecOrder<T extends { mimeType: string }>(
  codecs: readonly T[],
  preferred: string = MIRROR_PREFERRED_CODEC
): T[] {
  const want = preferred.toLowerCase()
  const isPreferred = (c: T): boolean => c.mimeType.toLowerCase() === want
  const hits = codecs.filter(isPreferred)
  if (hits.length === 0) return [...codecs]
  return [...hits, ...codecs.filter((c) => !isPreferred(c))]
}

/** Floor and starting point for the ENCODER's rate controller, in kbps.
 *
 *  Intent: the estimator ramps from a conservative floor and re-enters it after
 *  any idle gap -- measured on the glasses as `sending 450x288@0` seconds after
 *  the mirror reported ready, then a slow climb the user reads as "it went
 *  blurry then sharpened". Both sit below MIRROR_MAX_BITRATE_GLASSES.
 *
 *  EFFECT UNMEASURED under VP9, and do not reach for the obvious disproof: a
 *  peer read `estimate=180k` (far under this 800k) as proving the hints dead.
 *  It proves nothing. These are libvpx rate-controller hints; the number in the
 *  log is `availableOutgoingBitrate`, goog-cc's NETWORK estimate. Different
 *  layers -- a starved link cannot disprove an encoder floor. Settling it means
 *  reading the encoder's own output bitrate under a delivered munge. On H.264
 *  they are genuinely inert (libvpx-only), which is why the codec the munge
 *  targets is load-bearing -- see mungeGlassesBitrate below. */
const GLASSES_MIN_BITRATE_KBPS = 800
const GLASSES_START_BITRATE_KBPS = 1200

/** Add x-google-min-bitrate/start-bitrate to the fmtp lines of the codec the
 *  glasses actually negotiate.
 *
 *  There is no API for either -- setParameters exposes maxBitrate and nothing
 *  below it -- so the only way to reach the estimator is the SDP. Munging is
 *  ugly and this is why it is confined to one pure function with tests rather
 *  than a regex inline at the negotiation site.
 *
 *  It targeted H264 payloads ONLY, which is why it measured inert on 2026-08-11
 *  (estimate parked at 180k for minutes, limitation=none): the x-google-* keys
 *  are libvpx knobs and nothing was reading them off an H.264 fmtp line. The
 *  keys were never disproven -- they were never delivered. Now that
 *  MIRROR_PREFERRED_CODEC is VP9 the payload it lands on is a libvpx one, so
 *  this is on the codec that has the knobs for the first time. If the estimate
 *  still parks at 180k under VP9, THAT is the disproof, and the two constants
 *  above should go with the rest of it.
 *
 *  Returns the SDP UNCHANGED when the preferred codec has no payload or the
 *  keys are already present: a malformed answer fails negotiation outright, so
 *  every branch that isn't a confident match must be a no-op. */
export function mungeGlassesBitrate(sdp: string, preferred: string = MIRROR_PREFERRED_CODEC): string {
  // 'video/VP9' -> 'VP9'. The rtpmap line carries the bare encoding name, never
  // the mime type setCodecPreferences speaks in.
  const name = preferred.replace(/^.*\//, '')
  const rtpmap = new RegExp(`^a=rtpmap:(\\d+)\\s+${name}\\/`, 'i')
  const payloads = new Set<string>()
  for (const line of sdp.split(/\r?\n/)) {
    const m = rtpmap.exec(line)
    if (m) payloads.add(m[1])
  }
  if (payloads.size === 0) return sdp

  const eol = sdp.includes('\r\n') ? '\r\n' : '\n'
  const seen = new Set<string>()
  const out = sdp.split(/\r?\n/).map((line) => {
    const m = /^a=fmtp:(\d+)\s+(.*)$/.exec(line)
    if (!m || !payloads.has(m[1])) return line
    seen.add(m[1])
    if (m[2].includes('x-google-min-bitrate')) return line
    return `a=fmtp:${m[1]} ${m[2]};x-google-min-bitrate=${GLASSES_MIN_BITRATE_KBPS};x-google-start-bitrate=${GLASSES_START_BITRATE_KBPS}`
  })

  // A payload can be declared with rtpmap and no fmtp at all (no format
  // parameters to state). Appending the line it never had is the only way the
  // hint reaches that codec.
  const missing = [...payloads].filter((p) => !seen.has(p))
  for (const p of missing) {
    out.push(
      `a=fmtp:${p} x-google-min-bitrate=${GLASSES_MIN_BITRATE_KBPS};x-google-start-bitrate=${GLASSES_START_BITRATE_KBPS}`
    )
  }
  return out.join(eol)
}
