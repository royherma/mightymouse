import { describe, it, expect } from 'vitest'
import { appendStep, runningLabel, RUNNING_FALLBACK } from './chat-steps'
import type { ChatStep } from './chat-steps'

// The step list is the whole fix for "it feels stuck", and both of its failure
// modes are invisible until a real multi-minute run hits them: without the
// collapse rule a streaming reply buries every tool call under 40 identical
// "Writing" rows, and without the cap a long act pushes the answer off screen.
// Cheaper to pin here than to rediscover on a phone.
describe('appendStep', () => {
  const LIMIT = 5

  it('appends distinct phases in order', () => {
    let steps: ChatStep[] = []
    steps = appendStep(steps, 'Reading', 'config.ts', LIMIT)
    steps = appendStep(steps, 'Running command', 'npm test', LIMIT)
    expect(steps.map((s) => [s.phase, s.detail, s.n])).toEqual([
      ['Reading', 'config.ts', 1],
      ['Running command', 'npm test', 1]
    ])
  })

  it('collapses consecutive identical events into one row and counts them', () => {
    let steps: ChatStep[] = []
    for (let i = 0; i < 40; i++) steps = appendStep(steps, 'Writing', '', LIMIT)
    expect(steps).toHaveLength(1)
    expect(steps[0].n).toBe(40)
  })

  it('treats the same phase with a different detail as a NEW step', () => {
    // Two different files read back to back are two real events, not a repeat --
    // collapsing on phase alone would hide which files were touched.
    let steps: ChatStep[] = []
    steps = appendStep(steps, 'Reading', 'a.ts', LIMIT)
    steps = appendStep(steps, 'Reading', 'b.ts', LIMIT)
    expect(steps).toHaveLength(2)
  })

  it('re-opens a row when an identical phase returns after another one', () => {
    // Only CONSECUTIVE duplicates collapse: Writing → Reading → Writing is a
    // real back-and-forth and reads as progress.
    let steps: ChatStep[] = []
    steps = appendStep(steps, 'Writing', '', LIMIT)
    steps = appendStep(steps, 'Reading', 'a.ts', LIMIT)
    steps = appendStep(steps, 'Writing', '', LIMIT)
    expect(steps.map((s) => s.phase)).toEqual(['Writing', 'Reading', 'Writing'])
  })

  it('caps the list, dropping the OLDEST steps', () => {
    let steps: ChatStep[] = []
    for (let i = 0; i < 12; i++) steps = appendStep(steps, `Step ${i}`, '', LIMIT)
    expect(steps).toHaveLength(LIMIT)
    // The tail is what you want mid-run; the full trail is the Mac's job.
    expect(steps[0].phase).toBe('Step 7')
    expect(steps[LIMIT - 1].phase).toBe('Step 11')
  })

  it('ignores empty phases rather than adding a blank row', () => {
    const steps = appendStep([], '   ', 'detail', LIMIT)
    expect(steps).toEqual([])
  })

  it('does not mutate the array it was given', () => {
    const before: ChatStep[] = [{ phase: 'Reading', detail: 'a.ts', n: 1 }]
    const after = appendStep(before, 'Reading', 'a.ts', LIMIT)
    expect(before[0].n).toBe(1)
    expect(after[0].n).toBe(2)
  })
})

// The toast is the ONLY progress most runs ever show -- the expanded card costs
// a tap you can't know is worth making. So the label has to stay one readable
// line whatever the adapter emits, and it has to keep moving: a frozen string
// for three minutes is what "it's stuck" actually looks like.
describe('runningLabel', () => {
  it('falls back before any step has arrived', () => {
    expect(runningLabel([], RUNNING_FALLBACK)).toBe('Running…')
  })

  it('shows the phase alone when a step carries no detail', () => {
    expect(runningLabel([{ phase: 'Thinking', detail: '', n: 1 }], RUNNING_FALLBACK)).toBe('Thinking')
  })

  it('reads the LAST step, so the label tracks the run', () => {
    const steps: ChatStep[] = [
      { phase: 'Reading', detail: 'a.ts', n: 1 },
      { phase: 'Writing', detail: 'b.ts', n: 1 }
    ]
    expect(runningLabel(steps, RUNNING_FALLBACK)).toBe('Writing  b.ts')
  })

  // Truncates from the FRONT: the tail of a path is the filename that
  // identifies it, the head is the repo root every step shares.
  it('keeps the identifying tail of a long detail', () => {
    const label = runningLabel(
      [{ phase: 'Reading', detail: 'src/main/phone-remote/react/App.tsx', n: 1 }],
      RUNNING_FALLBACK
    )
    expect(label).toBe('Reading  …e-remote/react/App.tsx')
    expect(label).toContain('App.tsx')
  })

  // A phase whose detail is a wrapped shell command arrives with newlines; the
  // toast is one line, so a raw \n would silently blow the row's height open.
  it('flattens whitespace in the detail', () => {
    expect(
      runningLabel([{ phase: 'Running command', detail: 'npm\n  test', n: 1 }], RUNNING_FALLBACK)
    ).toBe('Running command  npm test')
  })

  // An empty phase is how the step list marks "nothing to say" (appendStep drops
  // these), so the label must not render a bare detail with no verb in front.
  it('falls back on a blank phase rather than showing a naked detail', () => {
    expect(runningLabel([{ phase: '   ', detail: 'a.ts', n: 1 }], RUNNING_FALLBACK)).toBe('Running…')
  })
})
