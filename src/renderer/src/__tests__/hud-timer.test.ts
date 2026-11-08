import { describe, it, expect } from 'vitest'
import { timerTransition, parseFrozenMs } from '../hud-timer'

// The user-visible bug this locks: after a phone-remote recording stopped, the
// HUD kept counting up through transcription, so the Mac looked like it was still
// listening — then the number jumped BACKWARDS when the run finished on the real
// clip length. The freeze was a one-way latch and the phone path never set it.

describe('hud timer freeze/resume', () => {
  it('freezes at the value main sent', () => {
    expect(timerTransition(true, '12.4s', null)).toEqual({ kind: 'freeze', at: '12.4s' })
  })

  it('leaves the timer alone when the payload says nothing about it', () => {
    // A plain phase update ("Transcribing…" → "Almost there…") must not disturb an
    // existing freeze. This is the tri-state: absent ≠ false.
    expect(timerTransition(undefined, undefined, '12.4s')).toEqual({ kind: 'unchanged' })
  })

  it('does not blank the timer on a freeze that carries no value', () => {
    expect(timerTransition(true, undefined, '12.4s')).toEqual({ kind: 'unchanged' })
  })

  it('resumes on an explicit false, rebasing to the frozen value', () => {
    // The frozen span is time the user was told had stopped counting, so the
    // resumed clock picks up from 12.4s rather than the card's full age.
    expect(timerTransition(false, undefined, '12.4s')).toEqual({
      kind: 'resume',
      rebaseToMs: 12400
    })
  })

  it('resumes without a rebase when nothing was frozen', () => {
    expect(timerTransition(false, undefined, null)).toEqual({ kind: 'resume', rebaseToMs: null })
  })

  it('never rebases the clock into the future on a malformed freeze', () => {
    // A negative/garbage value would otherwise set startTime ahead of now and the
    // timer would count down.
    expect(parseFrozenMs('nonsense')).toBe(0)
    expect(parseFrozenMs('-5s')).toBe(0)
  })

  it('keeps a capture frozen across the whole transcription phase', () => {
    // The exact sequence that regressed: freeze on mic-close, then several phase
    // updates. The card must still be frozen at the clip length at the end.
    let frozen: string | null = null
    const apply = (f: boolean | undefined, v: string | undefined): void => {
      const t = timerTransition(f, v, frozen)
      if (t.kind === 'freeze') frozen = t.at
      if (t.kind === 'resume') frozen = null
    }
    apply(true, '12.4s') // mic closed
    apply(true, '12.4s') // "Transcribing…"
    apply(undefined, undefined) // a phase update with no timer opinion
    expect(frozen).toBe('12.4s')
  })
})
