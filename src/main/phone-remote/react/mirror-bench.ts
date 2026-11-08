/**
 * What the mirror ACTUALLY delivered, measured on the device that has to paint
 * it. Exists because the encoder side could only ever report what it asked for
 * -- the Mac logs "1280x800@20" whether or not a single frame of that arrives,
 * and on the glasses it largely did not.
 *
 * Deliberately a rolling summary rather than a stats stream: the question is
 * "is this build faster than the last one", which needs one comparable number
 * per run, not a log line per second. `window.mmBench()` dumps it on demand.
 */

/** The fields worth reading out of an inbound-rtp report. Plain numbers so the
 *  sampler is testable without a browser or a live peer connection. */
export interface MirrorSample {
  /** Monotonic ms. Deltas only -- never rendered as a wall clock. */
  at: number
  framesDecoded: number
  /** Cumulative seconds the picture was frozen, per the WebRTC spec's own
   *  definition (a gap > max(3 * interframe, 150ms)). The single best proxy
   *  for "it looks janky", which is why it is reported even though a viewer
   *  cannot feel a count -- they feel the seconds. */
  totalFreezesDuration: number
  freezeCount: number
  frameWidth: number
  frameHeight: number
  packetsReceived: number
  packetsLost: number
  /** Frames that ARRIVED, whether or not they were decoded. The discriminator
   *  between the two things freezeCount cannot tell apart: nothing arriving is
   *  a STATIC screen (screen capture emits only on change, so a reading pause
   *  looks identical to a stall), while frames arriving and not being decoded
   *  is a real stall. Comparing codecs on freeze counts without this is
   *  comparing how much the tester happened to scroll. */
  framesReceived: number
  /** Cumulative bytes on the wire. The RECEIVED half of the link: the Mac's
   *  `sendK=` said 272k while `estimate=` read 0, and nothing on this side
   *  could say which number was real. Delta / dt is the answer. */
  bytesReceived: number
}

export interface BenchSummary {
  /** Seconds of stream the summary covers. Under ~2s the fps figure is noise,
   *  which is why `format` refuses to print a verdict below that. */
  elapsedS: number
  avgFps: number
  /** Worst one-second-ish window seen. The average hides exactly the stutter
   *  the user is complaining about, so the minimum is the honest headline. */
  minFps: number
  resolution: string
  freezeCount: number
  freezeSeconds: number
  lostPct: number
  /** Seconds where frames ARRIVED, so the window was live content rather than a
   *  reading pause. Divide any freeze figure by this, not by elapsedS. */
  activeS: number
  /** Fraction of the window that was live content, 0-1. Two BENCH lines are
   *  only comparable when this is comparable -- a codec judged over 20s of
   *  scrolling against one judged over 20s of reading is not a measurement. */
  activeRatio: number
  /** Frames that arrived but were never decoded. THIS is stall; a static screen
   *  contributes zero to it however long it lasts. */
  droppedFrames: number
}

const MIN_MEANINGFUL_S = 2

/** Frames per second below which a sample counts as a STATIC screen rather than
 *  a stalled one. Not zero: an idle desktop still ticks a clock or blinks a
 *  cursor, which arrives as an occasional frame and would otherwise mark the
 *  whole reading pause as active. */
const STATIC_FPS = 1

export class MirrorBench {
  private first: MirrorSample | null = null
  private last: MirrorSample | null = null
  private minFps = Infinity
  // Summed per sample rather than derived at the end: whether a given second
  // was live content is only knowable from that second's own delta, and it is
  // gone by the time summary() runs.
  private activeS = 0

  /** Feed one poll. Returns the running summary, or null until two samples
   *  exist -- every figure here is a delta, so a single sample says nothing. */
  add(s: MirrorSample): BenchSummary | null {
    if (!this.first) {
      this.first = s
      this.last = s
      return null
    }
    const prev = this.last as MirrorSample
    const dt = (s.at - prev.at) / 1000
    // A zero/backwards gap means a duplicate or reordered poll, not a stall --
    // dividing by it would post an Infinity fps and poison minFps for the run.
    if (dt > 0) {
      const fps = (s.framesDecoded - prev.framesDecoded) / dt
      const arrivedFps = (s.framesReceived - prev.framesReceived) / dt
      const active = arrivedFps > STATIC_FPS
      if (active) this.activeS += dt
      // minFps is the headline "worst stutter" figure, and a reading pause is
      // not stutter -- it is the screen not changing. Scoring idle windows here
      // is what made min=0.0fps the normal reading on a perfectly good stream,
      // and made two codec runs incomparable.
      if (active && fps >= 0) this.minFps = Math.min(this.minFps, fps)
    }
    this.last = s
    return this.summary()
  }

  summary(): BenchSummary | null {
    const a = this.first
    const b = this.last
    if (!a || !b || b === a) return null
    const elapsedS = (b.at - a.at) / 1000
    if (elapsedS <= 0) return null
    const packets = b.packetsReceived - a.packetsReceived
    const lost = b.packetsLost - a.packetsLost
    return {
      elapsedS,
      avgFps: (b.framesDecoded - a.framesDecoded) / elapsedS,
      minFps: this.minFps === Infinity ? 0 : this.minFps,
      resolution: `${b.frameWidth}x${b.frameHeight}`,
      freezeCount: b.freezeCount - a.freezeCount,
      freezeSeconds: b.totalFreezesDuration - a.totalFreezesDuration,
      activeS: this.activeS,
      activeRatio: elapsedS > 0 ? this.activeS / elapsedS : 0,
      // Arrived minus decoded. Clamped at 0: the two counters are sampled from
      // one report but advance independently, so a frame counted as received
      // just before it is decoded reads as a phantom negative.
      droppedFrames: Math.max(
        0,
        b.framesReceived - a.framesReceived - (b.framesDecoded - a.framesDecoded)
      ),
      // Lost / (lost + received) -- the denominator is what was SENT, so a
      // received-only denominator would flatter a badly dropping link.
      lostPct: packets + lost > 0 ? (lost / (packets + lost)) * 100 : 0
    }
  }

  reset(): void {
    this.first = null
    this.last = null
    this.minFps = Infinity
    this.activeS = 0
  }
}

/** Wall clock, Bangkok, on every emitted line. `active=NN/NNs` is elapsed since
 *  the connection opened, which cannot be joined to "it got choppy around the
 *  end of the video" -- the tester's report is in wall time and nothing in the
 *  log was. Fixed to Asia/Bangkok rather than the host zone so a log read on a
 *  different machine still lines up with when it was felt. */
export function stamp(now: Date = new Date()): string {
  return now.toLocaleTimeString('en-GB', { timeZone: 'Asia/Bangkok', hour12: false })
}

/** Unambiguous by eye and by voice on a low-res glasses readout: no vowels (so
 *  no accidental words), and no 0/O/1/I/5/S pairs. */
const CODE_ALPHABET = 'BCDFGHJKLMNPQRTVWXYZ2346789'

/** A short handle for ONE mirror session, minted where the bench resets. Roy
 *  reads it off the glasses and says "#K7QW got choppy"; the same code is on
 *  every BENCH log line, so the run is greppable from a spoken report. Four
 *  chars is ~531k combinations -- collisions across a day of runs are not a
 *  concern, and length is, since this is read at glasses resolution. */
export function sessionCode(): string {
  let out = ''
  for (let i = 0; i < 4; i++) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
  }
  return out
}

/** Elapsed as m:ss. Wall clock alone answers "when", not "how far into the
 *  run" -- and "it went bad near the end of the video" is a duration, so the
 *  reading has to be one too. Minutes are not zero-padded (0:07, 12:07) because
 *  the leading digit is what the eye tracks. */
export function elapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** One line, comparable between runs by eye. This IS the benchmark output --
 *  keep the field order stable so two lines can be diffed at a glance. */
export function format(s: BenchSummary | null, code?: string): string {
  const t = stamp()
  // On every line including the degenerate ones: "#K7QW never got past warming
  // up" is a report, and it is unreadable if the code only prints once numbers
  // exist.
  const id = code ? `#${code} ` : ''
  if (!s) return `[${t}] ${id}BENCH no samples yet`
  if (s.elapsedS < MIN_MEANINGFUL_S)
    return `[${t}] ${id}BENCH warming up (${s.elapsedS.toFixed(1)}s)`
  const since = elapsed(s.elapsedS)
  // avg is over ACTIVE seconds, not wall clock: frames only flow when the
  // screen changes, so dividing by elapsed made a codec look worse purely
  // because the tester spent longer reading. `active=` is printed alongside so
  // two lines can be checked for comparability before being compared at all.
  const avgActive = s.activeS > 0 ? s.avgFps * (s.elapsedS / s.activeS) : 0
  return (
    `[${t}] ${id}+${since} BENCH ${s.resolution} avg=${avgActive.toFixed(1)}fps ` +
    `min=${s.minFps.toFixed(1)}fps ` +
    `freeze=${s.freezeCount}/${s.freezeSeconds.toFixed(1)}s lost=${s.lostPct.toFixed(1)}% ` +
    `stall=${s.droppedFrames} active=${s.activeS.toFixed(0)}/${s.elapsedS.toFixed(0)}s ` +
    `(${Math.round(s.activeRatio * 100)}%)`
  )
}

/** Pull the one inbound video report out of a getStats result. Typed loosely
 *  because RTCStatsReport's entries are not statically known and the shape
 *  differs across browsers -- every field is read defensively for that reason. */
export function sampleFromStats(report: RTCStatsReport, now: number): MirrorSample | null {
  let found: MirrorSample | null = null
  report.forEach((r: Record<string, unknown>) => {
    if (r.type !== 'inbound-rtp' || r.kind !== 'video') return
    const n = (k: string): number => (typeof r[k] === 'number' ? (r[k] as number) : 0)
    found = {
      at: now,
      framesDecoded: n('framesDecoded'),
      totalFreezesDuration: n('totalFreezesDuration'),
      freezeCount: n('freezeCount'),
      frameWidth: n('frameWidth'),
      frameHeight: n('frameHeight'),
      packetsReceived: n('packetsReceived'),
      packetsLost: n('packetsLost'),
      // Absent on some implementations, where n() yields 0 -- that reads as a
      // permanently static screen (active=0s), which is visible in the line
      // rather than silently flattering the numbers.
      framesReceived: n('framesReceived'),
      bytesReceived: n('bytesReceived')
    }
  })
  return found
}

/** Which candidate pair ICE selected, as `route=<local>/<remote>` (e.g.
 *  `route=host/srflx`, `route=relay/relay`).
 *
 *  Reads the pair flagged `selected`, falling back to the `succeeded` pair that
 *  the transport points at -- Chrome and Safari disagree about which of those
 *  they populate, and a missing field here must degrade to 'unknown' rather
 *  than misreport a route. */
function selectedPair(report: RTCStatsReport): Record<string, unknown> | null {
  let pair: Record<string, unknown> | null = null
  report.forEach((r: Record<string, unknown>) => {
    if (r.type === 'transport' && typeof r.selectedCandidatePairId === 'string') {
      const t = report.get(r.selectedCandidatePairId) as Record<string, unknown> | undefined
      if (t) pair = t
    }
  })
  if (!pair) {
    report.forEach((r: Record<string, unknown>) => {
      if (r.type !== 'candidate-pair') return
      if (r.selected === true || (!pair && r.state === 'succeeded')) pair = r
    })
  }
  return pair
}

/** What the RECEIVER thinks it can accept, in kbps, or -1 when unreported.
 *
 *  The decisive reading for the chronic 184k: the Mac's availableOutgoingBitrate
 *  parks at exactly 184k on a LAN route with 0% loss and 20-50ms rtt, which is a
 *  CAP rather than congestion. If this number reads ~184k too, the glasses are
 *  the ones asking for it and no sender-side knob can beat it -- two sender-side
 *  fixes were already spent on that assumption (see docs/gotchas.md).
 *
 *  -1, not 0, when absent: Safari does not populate availableIncomingBitrate on
 *  every build, and a 0 would read as "the receiver wants nothing" -- the most
 *  alarming possible value -- when it means "no answer". */
export function incomingEstimateKbps(report: RTCStatsReport): number {
  const p = selectedPair(report)
  const v = p?.availableIncomingBitrate
  return typeof v === 'number' ? Math.round(v / 1000) : -1
}

export function routeFromStats(report: RTCStatsReport): string {
  const p = selectedPair(report)
  if (!p) return 'route=unknown'
  const side = (id: unknown): string => {
    if (typeof id !== 'string') return '?'
    const c = report.get(id) as Record<string, unknown> | undefined
    return (c?.candidateType as string | undefined) ?? '?'
  }
  return `route=${side(p.localCandidateId)}/${side(p.remoteCandidateId)}`
}

/** Route as two short words for the overlay, where `routeFromStats`'s
 *  `route=relay/prflx` form is too wide to sit beside the other columns.
 *  Local side only: it is the one that says LAN-vs-tunnel, which is the whole
 *  question being asked of this field. */
export function shortRoute(report: RTCStatsReport): string {
  const p = selectedPair(report)
  if (!p) return '?'
  const id = p.localCandidateId
  if (typeof id !== 'string') return '?'
  const c = report.get(id) as Record<string, unknown> | undefined
  return (c?.candidateType as string | undefined) ?? '?'
}

/** Round-trip time and jitter, ms, or -1 when the report does not carry them.
 *
 *  Paired with the bitrate on one line because they separate the two ways a
 *  link goes bad: a picture starved by a low cap reads as low kbps with a
 *  healthy rtt, while one ruined by a congested path reads as fine kbps with
 *  rtt climbing. Either alone is ambiguous.
 *
 *  -1 rather than 0 for the same reason as `incomingEstimateKbps`: 0ms rtt is a
 *  plausible-looking value that would read as a perfect link. */
export function linkTimingMs(report: RTCStatsReport): { rtt: number; jitter: number } {
  const p = selectedPair(report)
  const rtt = p?.currentRoundTripTime
  let jitter = -1
  report.forEach((r: Record<string, unknown>) => {
    if (r.type === 'inbound-rtp' && r.kind === 'video' && typeof r.jitter === 'number') {
      jitter = Math.round(r.jitter * 1000)
    }
  })
  return { rtt: typeof rtt === 'number' ? Math.round(rtt * 1000) : -1, jitter }
}
