import { describe, expect, it } from 'vitest'
import {
  MirrorBench,
  elapsed,
  format,
  linkTimingMs,
  routeFromStats,
  shortRoute,
  stamp,
  type MirrorSample
} from './mirror-bench'

/** Cumulative counters, the way a real inbound-rtp report delivers them.
 *
 *  framesReceived defaults to framesDecoded -- a decoded frame was necessarily
 *  received, so the healthy case is the default and a test that wants a STALL
 *  states the gap explicitly. Defaulting it to 0 instead made every fixture
 *  read as a static screen. */
function sample(at: number, over: Partial<MirrorSample> = {}): MirrorSample {
  const framesDecoded = over.framesDecoded ?? 0
  return {
    at,
    framesDecoded,
    totalFreezesDuration: 0,
    freezeCount: 0,
    frameWidth: 960,
    frameHeight: 600,
    packetsReceived: 0,
    packetsLost: 0,
    framesReceived: framesDecoded,
    ...over
  }
}

describe('MirrorBench', () => {
  it('reports nothing until two samples exist', () => {
    const b = new MirrorBench()
    expect(b.add(sample(0))).toBeNull()
    expect(b.summary()).toBeNull()
  })

  it('averages fps across the whole run, not the last tick', () => {
    const b = new MirrorBench()
    b.add(sample(0))
    b.add(sample(1000, { framesDecoded: 20 }))
    const s = b.add(sample(2000, { framesDecoded: 40 }))
    expect(s?.avgFps).toBeCloseTo(20)
    expect(s?.elapsedS).toBeCloseTo(2)
  })

  it('keeps the WORST window as minFps -- the average hides the stutter', () => {
    const b = new MirrorBench()
    b.add(sample(0))
    b.add(sample(1000, { framesDecoded: 20 })) // healthy second
    const s = b.add(sample(2000, { framesDecoded: 23 })) // 3fps second
    expect(s?.minFps).toBeCloseTo(3)
    // The average alone would read 11.5fps and look merely mediocre.
    expect(s?.avgFps).toBeCloseTo(11.5)
  })

  it('computes loss against packets SENT, not just received', () => {
    const b = new MirrorBench()
    b.add(sample(0))
    const s = b.add(sample(1000, { packetsReceived: 90, packetsLost: 10 }))
    expect(s?.lostPct).toBeCloseTo(10)
  })

  it('ignores a duplicate/reordered poll instead of posting Infinity fps', () => {
    const b = new MirrorBench()
    b.add(sample(0))
    b.add(sample(1000, { framesDecoded: 20 }))
    const s = b.add(sample(1000, { framesDecoded: 20 })) // same timestamp
    expect(s?.minFps).toBeGreaterThanOrEqual(0)
    expect(Number.isFinite(s?.minFps ?? Infinity)).toBe(true)
  })

  it('reports freeze count and seconds as deltas over the run', () => {
    const b = new MirrorBench()
    b.add(sample(0, { freezeCount: 2, totalFreezesDuration: 1 }))
    const s = b.add(sample(3000, { freezeCount: 5, totalFreezesDuration: 2.5 }))
    expect(s?.freezeCount).toBe(3)
    expect(s?.freezeSeconds).toBeCloseTo(1.5)
  })

  it('reset clears the run so a new mirror is not averaged with the old one', () => {
    const b = new MirrorBench()
    b.add(sample(0))
    b.add(sample(1000, { framesDecoded: 20 }))
    b.reset()
    expect(b.summary()).toBeNull()
  })

  // The reason this whole distinction exists: a reading pause and a broken
  // decoder both show ~0 decoded fps, and comparing two codecs on that number
  // compares how much the tester scrolled.
  it('a STATIC screen is not counted as active time', () => {
    const b = new MirrorBench()
    b.add(sample(0))
    b.add(sample(1000, { framesDecoded: 20 })) // one live second
    const s = b.add(sample(11_000, { framesDecoded: 20 })) // ten seconds of reading
    expect(s?.activeS).toBeCloseTo(1)
    expect(s?.elapsedS).toBeCloseTo(11)
    expect(s?.droppedFrames).toBe(0)
  })

  it('a STALL is frames arriving that never decode', () => {
    const b = new MirrorBench()
    b.add(sample(0))
    const s = b.add(sample(1000, { framesDecoded: 2, framesReceived: 20 }))
    expect(s?.droppedFrames).toBe(18)
    expect(s?.activeS).toBeCloseTo(1)
  })

  it('minFps ignores idle windows -- a reading pause is not stutter', () => {
    const b = new MirrorBench()
    b.add(sample(0))
    b.add(sample(1000, { framesDecoded: 20 }))
    const s = b.add(sample(2000, { framesDecoded: 20 })) // nothing changed on screen
    expect(s?.minFps).toBeCloseTo(20)
  })

  it('static and stall are distinguishable at the same decoded fps', () => {
    // Both decode 0 frames in the second. Only one is a defect.
    const staticRun = new MirrorBench()
    staticRun.add(sample(0))
    const st = staticRun.add(sample(1000))

    const stalled = new MirrorBench()
    stalled.add(sample(0))
    const sl = stalled.add(sample(1000, { framesReceived: 15 }))

    expect(st?.avgFps).toBeCloseTo(sl?.avgFps ?? -1)
    expect(st?.droppedFrames).toBe(0)
    expect(sl?.droppedFrames).toBe(15)
  })
})

describe('format', () => {
  it('refuses a verdict on a sub-2s run rather than printing noise', () => {
    const b = new MirrorBench()
    b.add(sample(0))
    b.add(sample(500, { framesDecoded: 3 }))
    expect(format(b.summary())).toContain('warming up')
  })

  it('prints resolution, avg, min, freeze and loss once the run is meaningful', () => {
    const b = new MirrorBench()
    b.add(sample(0))
    b.add(sample(3000, { framesDecoded: 60, packetsReceived: 100 }))
    const line = format(b.summary())
    expect(line).toContain('960x600')
    expect(line).toContain('avg=20.0fps')
    expect(line).toContain('lost=0.0%')
  })

  it('says so when there is nothing to report', () => {
    expect(format(null)).toContain('no samples')
  })

  // Every line, including the two that report nothing -- "it got choppy toward
  // the end" is a wall-clock report, and a warming-up or no-samples line is
  // exactly where a run's start needs pinning.
  it('stamps wall clock on every line, warming-up and empty included', () => {
    const b = new MirrorBench()
    b.add(sample(0))
    expect(format(null)).toMatch(/^\[\d\d:\d\d:\d\d\]/)
    expect(format(b.summary())).toMatch(/^\[\d\d:\d\d:\d\d\]/)
    b.add(sample(3000, { framesDecoded: 60, packetsReceived: 100 }))
    expect(format(b.summary())).toMatch(/^\[\d\d:\d\d:\d\d\] \+\d+:\d\d BENCH /)
  })

  // The wall clock says WHEN, the elapsed says HOW FAR IN. "It degrades toward
  // the end of the video" is a report on the second axis, and no reading in the
  // log carried it.
  it('prints elapsed alongside the wall clock', () => {
    const b = new MirrorBench()
    b.add(sample(0))
    b.add(sample(75_000, { framesDecoded: 900, packetsReceived: 100 }))
    expect(format(b.summary())).toContain('+1:15')
  })

  // Fixed to Bangkok, not the host zone, so a log read anywhere still lines up
  // with when the tester felt it.
  it('reads in Bangkok time regardless of the host zone', () => {
    expect(stamp(new Date('2026-08-12T00:00:00Z'))).toBe('07:00:00')
  })
})

describe('elapsed', () => {
  it('reads as m:ss, zero-padding the seconds', () => {
    expect(elapsed(0)).toBe('0:00')
    expect(elapsed(7)).toBe('0:07')
    // 65s must not render '1:5' -- an unpadded seconds field is unreadable at a
    // glance, which is the only way this figure is ever read.
    expect(elapsed(65)).toBe('1:05')
    expect(elapsed(600)).toBe('10:00')
  })

  it('does not roll over past an hour -- a long run reads 90:00, not 1:30:00', () => {
    expect(elapsed(5400)).toBe('90:00')
  })

  it('floors rather than rounding, so it never reads ahead of the run', () => {
    expect(elapsed(9.9)).toBe('0:09')
  })
})

describe('routeFromStats', () => {
  /** Minimal stand-in for RTCStatsReport: forEach + get, which is all it uses. */
  function reportOf(entries: Record<string, Record<string, unknown>>): RTCStatsReport {
    return {
      forEach: (fn: (v: Record<string, unknown>) => void) => Object.values(entries).forEach(fn),
      get: (id: string) => entries[id]
    } as unknown as RTCStatsReport
  }

  const pairEntries = (localType: string, remoteType: string): Record<string, Record<string, unknown>> => ({
    L: { type: 'local-candidate', candidateType: localType },
    R: { type: 'remote-candidate', candidateType: remoteType },
    P: { type: 'candidate-pair', state: 'succeeded', localCandidateId: 'L', remoteCandidateId: 'R' }
  })

  it('reads the pair the transport points at', () => {
    const r = reportOf({
      ...pairEntries('host', 'host'),
      T: { type: 'transport', selectedCandidatePairId: 'P' }
    })
    expect(routeFromStats(r)).toBe('route=host/host')
  })

  it('names a relay route -- the case that costs 10x the bandwidth', () => {
    const r = reportOf({
      ...pairEntries('relay', 'relay'),
      T: { type: 'transport', selectedCandidatePairId: 'P' }
    })
    expect(routeFromStats(r)).toBe('route=relay/relay')
  })

  it('falls back to the succeeded pair when no transport entry exists', () => {
    expect(routeFromStats(reportOf(pairEntries('srflx', 'relay')))).toBe('route=srflx/relay')
  })

  it('says unknown rather than guessing when there is no pair at all', () => {
    expect(routeFromStats(reportOf({ X: { type: 'inbound-rtp' } }))).toBe('route=unknown')
  })
})

describe('shortRoute and linkTimingMs -- the debug HUD rig column', () => {
  function reportOf(entries: Record<string, Record<string, unknown>>): RTCStatsReport {
    return {
      forEach: (fn: (v: Record<string, unknown>) => void) => Object.values(entries).forEach(fn),
      get: (id: string) => entries[id]
    } as unknown as RTCStatsReport
  }

  const pair = (extra: Record<string, unknown> = {}): Record<string, Record<string, unknown>> => ({
    L: { type: 'local-candidate', candidateType: 'relay' },
    P: { type: 'candidate-pair', state: 'succeeded', localCandidateId: 'L', ...extra }
  })

  it('reports the LOCAL candidate type -- the half that says LAN vs tunnel', () => {
    expect(shortRoute(reportOf(pair()))).toBe('relay')
  })

  it('says ? rather than guessing when no pair has been selected', () => {
    expect(shortRoute(reportOf({ X: { type: 'inbound-rtp' } }))).toBe('?')
  })

  it('converts rtt and jitter from seconds to whole ms', () => {
    const r = reportOf({
      ...pair({ currentRoundTripTime: 0.034 }),
      I: { type: 'inbound-rtp', kind: 'video', jitter: 0.006 }
    })
    expect(linkTimingMs(r)).toEqual({ rtt: 34, jitter: 6 })
  })

  it('returns -1, never 0, for a figure the report does not carry', () => {
    // 0ms rtt is a plausible-looking reading of a perfect link, so the absent
    // case must not be spellable as a good one.
    expect(linkTimingMs(reportOf(pair()))).toEqual({ rtt: -1, jitter: -1 })
  })

  it('ignores an audio inbound-rtp when reading video jitter', () => {
    const r = reportOf({
      ...pair(),
      A: { type: 'inbound-rtp', kind: 'audio', jitter: 0.5 }
    })
    expect(linkTimingMs(r).jitter).toBe(-1)
  })
})
