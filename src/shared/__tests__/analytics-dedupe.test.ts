import { describe, it, expect } from 'vitest'
import { createDedupeTracker, DEDUPE_WINDOW_MS } from '../analytics-dedupe'

/** Tracker driven by a hand-cranked clock, so the window is tested without sleeping. */
function trackerAt(start = 1_000_000): {
  dup: (event: string, props?: Record<string, unknown>) => boolean
  advance: (ms: number) => void
} {
  let now = start
  const t = createDedupeTracker(() => now)
  return {
    dup: (event, props) => t.isDuplicate(event, props),
    advance: (ms) => {
      now += ms
    }
  }
}

describe('analytics dedupe', () => {
  it('lets the first emission through', () => {
    const { dup } = trackerAt()
    expect(dup('app_launch')).toBe(false)
  })

  it('suppresses an identical event inside the window', () => {
    const { dup } = trackerAt()
    dup('onboarding_step_viewed', { step: 2, key: 'screen' })
    expect(dup('onboarding_step_viewed', { step: 2, key: 'screen' })).toBe(true)
  })

  it('collapses the real 3s-poll storm that caused this guard', () => {
    // The observed bug: a 3s poll logged one step view 94 times. A 5s window means
    // the storm reports periodically rather than being silenced outright.
    const { dup, advance } = trackerAt()
    let sent = 0
    for (let i = 0; i < 94; i++) {
      if (!dup('onboarding_step_viewed', { step: 2, key: 'screen' })) sent++
      advance(3_000)
    }
    expect(sent).toBeLessThan(60) // was 94
    expect(sent).toBeGreaterThan(0) // never fully silent
  })

  it('allows the same event again once the window has passed', () => {
    const { dup, advance } = trackerAt()
    dup('portal_page_view', { route: '/' })
    advance(DEDUPE_WINDOW_MS + 1)
    expect(dup('portal_page_view', { route: '/' })).toBe(false)
  })

  it('keeps genuine long-gap repeats, which real users produce', () => {
    // 165 sign-in and 15 onboarding repeats in prod sat >60s apart — real revisits.
    const { dup, advance } = trackerAt()
    dup('portal_admin_viewed')
    advance(4_771_000) // the measured median gap for this event
    expect(dup('portal_admin_viewed')).toBe(false)
  })

  it('treats different props as different events', () => {
    // Consecutive wizard steps share a name and differ only in props.
    const { dup } = trackerAt()
    expect(dup('onboarding_step_viewed', { step: 1, key: 'accessibility' })).toBe(false)
    expect(dup('onboarding_step_viewed', { step: 2, key: 'screen' })).toBe(false)
    expect(dup('onboarding_step_viewed', { step: 3, key: 'microphone' })).toBe(false)
  })

  it('is insensitive to prop key ORDER', () => {
    // Two code paths building the same logical event must collapse, so the key
    // cannot be a raw JSON.stringify of the props object.
    const { dup } = trackerAt()
    dup('run_completed', { ok: true, mode: 'act' })
    expect(dup('run_completed', { mode: 'act', ok: true })).toBe(true)
  })

  it('suppresses INTERLEAVED storms, which a single-slot tracker cannot', () => {
    // Two effects polling A,B,A,B: with only "last event" state, each sees the
    // other as previous, so nothing ever matches and the guard does nothing.
    const { dup, advance } = trackerAt()
    dup('a')
    dup('b')
    advance(1_000)
    expect(dup('a')).toBe(true)
    expect(dup('b')).toBe(true)
  })

  it('distinguishes events whose names collide with concatenated props', () => {
    // Guards the key builder against ambiguity between the name and prop values.
    const { dup } = trackerAt()
    expect(dup('ab', { c: 1 })).toBe(false)
    expect(dup('a', { b: 'c1' })).toBe(false)
  })

  it('does not leak unboundedly on high-cardinality props', () => {
    // A props field carrying a timestamp/cursor would otherwise grow the map forever.
    const { dup, advance } = trackerAt()
    for (let i = 0; i < 5_000; i++) {
      dup('cursor_moved', { x: i })
      advance(10)
    }
    // Still functioning correctly after heavy churn.
    expect(dup('cursor_moved', { x: 999_999 })).toBe(false)
    expect(dup('cursor_moved', { x: 999_999 })).toBe(true)
  })

  it('keeps separate trackers independent', () => {
    const a = trackerAt()
    const b = trackerAt()
    a.dup('app_launch')
    expect(b.dup('app_launch')).toBe(false)
  })

  it('treats no-props and empty-props as the same event', () => {
    const { dup } = trackerAt()
    dup('panel_dismissed')
    expect(dup('panel_dismissed', {})).toBe(true)
  })
})
