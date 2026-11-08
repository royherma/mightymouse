import { describe, it, expect } from 'vitest'
import { CONFIG } from '@shared/config'
import {
  micOpenTimedOut,
  padChunkCount,
  segmentOutcome,
  shouldStartUtterance,
  staysArmed,
  handsFreeDisplay,
  longPressArmAction,
  micSourceForMirror,
  handsFreeMicClass
} from '../hands-free-rules'

const MIN = CONFIG.PHONE_REMOTE.MIN_RECORDING_MS

describe('padChunkCount', () => {
  // 100ms chunks, the recorder's timeslice.
  const ends = (n: number): number[] => Array.from({ length: n }, (_, i) => (i + 1) * 100)

  it('reaches back over the pad, not just to the cut', () => {
    // Speech fired at 1000ms with a 500ms pad: chunks covering 500-1000ms.
    expect(padChunkCount({ chunkEndsAt: ends(10), speechStartedAt: 1000, padMs: 500 })).toBe(5)
  })

  it('keeps everything when the buffer is shorter than the pad', () => {
    // The first utterance of a session: only 300ms exists, so all of it is pad.
    expect(padChunkCount({ chunkEndsAt: ends(3), speechStartedAt: 300, padMs: 500 })).toBe(3)
  })

  it('keeps at least one chunk when the pad is zero', () => {
    // Never zero: a cut with no chunks is a blob no decoder opens.
    expect(padChunkCount({ chunkEndsAt: ends(10), speechStartedAt: 1000, padMs: 0 })).toBe(1)
  })

  it('keeps the header chunk when speech starts immediately', () => {
    expect(padChunkCount({ chunkEndsAt: ends(1), speechStartedAt: 100, padMs: 500 })).toBe(1)
  })
})

describe('micOpenTimedOut', () => {
  it('cancels a mic still stuck opening', () => {
    expect(micOpenTimedOut('opening')).toBe(true)
  })

  // The 2026-08-15 regression: a short tap latches 'toggled' without bumping
  // the open generation, so the gen check lets the watchdog through and it
  // cancelled the recording at 6s while native capture kept running.
  it('never cancels a short tap that is already recording', () => {
    expect(micOpenTimedOut('toggled')).toBe(false)
  })

  it('leaves a held recording and an idle mic alone', () => {
    expect(micOpenTimedOut('recording')).toBe(false)
    expect(micOpenTimedOut('idle')).toBe(false)
  })
})

describe('segmentOutcome', () => {
  it('sends a normal utterance', () => {
    expect(segmentOutcome({ chunkCount: 3, durationMs: MIN + 500 })).toBe('send')
  })

  it('drops a cough rather than paying a whisper hop for it', () => {
    expect(segmentOutcome({ chunkCount: 2, durationMs: MIN - 1 })).toBe('drop-short')
  })

  it('treats exactly MIN as long enough', () => {
    expect(segmentOutcome({ chunkCount: 1, durationMs: MIN })).toBe('send')
  })

  // A discarding stop nulls ondataavailable, so an abandoned segment arrives
  // here with no chunks. It must not paste an empty clip -- that is what a
  // disarm mid-utterance and a manual hold takeover both look like.
  it('drops an abandoned segment even when it ran long', () => {
    expect(segmentOutcome({ chunkCount: 0, durationMs: 10_000 })).toBe('drop-empty')
  })
})

describe('shouldStartUtterance', () => {
  it('starts when armed with a live stream and no hold', () => {
    expect(shouldStartUtterance({ disposed: false, hasStream: true, manualHold: false })).toBe(true)
  })

  // design Q2b: press-and-hold coexists with armed. If the VAD also opened a
  // recorder here, the hold and the VAD would race to stop one stream.
  it('yields the recorder to a manual hold', () => {
    expect(shouldStartUtterance({ disposed: false, hasStream: true, manualHold: true })).toBe(false)
  })

  it('does not start after teardown', () => {
    expect(shouldStartUtterance({ disposed: true, hasStream: true, manualHold: false })).toBe(false)
  })

  it('does not start before the mic is open', () => {
    expect(shouldStartUtterance({ disposed: false, hasStream: false, manualHold: false })).toBe(false)
  })
})

describe('staysArmed', () => {
  const ok = { connected: true, error: null }

  it('stays armed while every gate holds', () => {
    expect(staysArmed(ok)).toBe(true)
  })

  // A segment finishing against a dead socket cannot paste anyway.
  it('disarms when the Mac goes away', () => {
    expect(staysArmed({ ...ok, connected: false })).toBe(false)
  })

  it('disarms when the mic or model fails', () => {
    expect(staysArmed({ ...ok, error: 'Microphone access needed' })).toBe(false)
  })
})

describe('micSourceForMirror', () => {
  // Screen-share audio while dictating: two getUserMedia calls on iOS re-prompt
  // and can leave one stream silent, so the mirror borrows the armed one.
  it('borrows the hands-free stream when one is open', () => {
    expect(micSourceForMirror(true)).toBe('share-handsfree')
  })

  it('opens its own when hands-free is not armed', () => {
    expect(micSourceForMirror(false)).toBe('open-own')
  })
})

describe('handsFreeDisplay', () => {
  it('is off when not armed, whatever the mic is doing', () => {
    expect(handsFreeDisplay(false, false)).toBe('off')
    expect(handsFreeDisplay(false, true)).toBe('off')
  })

  // ~15MB of model + wasm loads between the long-press and the first listen.
  // Without this state the button looks like it ignored the press.
  it('shows starting while the model loads', () => {
    expect(handsFreeDisplay(true, false)).toBe('starting')
  })

  it('shows listening once the VAD is running', () => {
    expect(handsFreeDisplay(true, true)).toBe('listening')
  })
})

describe('longPressArmAction', () => {
  it('arms on a silent hold with a live mic', () => {
    expect(longPressArmAction({ voiceHeard: false, micOpening: false, micRecording: true })).toBe('arm')
  })

  // Hold-and-talk is a dictation. This is the whole reason the gate exists:
  // arming here (the 2026-08-03 timing collision) silently discarded the
  // recording and left hands-free listening instead.
  it('stands down for the whole press once voice was heard', () => {
    expect(longPressArmAction({ voiceHeard: true, micOpening: false, micRecording: true })).toBe('stand-down')
    expect(longPressArmAction({ voiceHeard: true, micOpening: true, micRecording: false })).toBe('stand-down')
  })

  // A mic still opening has produced no samples, so silence is unproven --
  // arming there would eat a dictation whose permission prompt ran long.
  it('rechecks while the mic is still opening', () => {
    expect(longPressArmAction({ voiceHeard: false, micOpening: true, micRecording: false })).toBe('recheck')
  })

  it('never arms over a failed or reset mic', () => {
    expect(longPressArmAction({ voiceHeard: false, micOpening: false, micRecording: false })).toBe('stand-down')
  })
})

describe('handsFreeMicClass', () => {
  it('carries nothing when the mode is off', () => {
    expect(handsFreeMicClass('off')).toBe('')
    expect(handsFreeMicClass('off', true)).toBe('')
  })

  it('does not seat the button while armed but idle', () => {
    expect(handsFreeMicClass('listening')).not.toContain('handsFreeHot')
  })

  // The seated look is bounded by the utterance. A permanently seated mic
  // reads as stuck, which is why armed-idle above deliberately stays up.
  it('seats the button mid-utterance', () => {
    expect(handsFreeMicClass('listening', true)).toContain('handsFreeHot')
    expect(handsFreeMicClass('listening', true)).toContain('handsFree ')
  })

  it('never seats while the model is still loading', () => {
    expect(handsFreeMicClass('starting', true)).toBe(' handsFreeStarting')
  })
})
