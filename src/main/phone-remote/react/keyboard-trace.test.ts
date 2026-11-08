import { describe, expect, it } from 'vitest'
import { kbTrace, formatKbTrace, setKbTraceSink } from './keyboard-trace'

// The trace is a DIAGNOSTIC, which makes it the one thing that must not lie:
// a fix is about to be judged on what it prints. A trace that silently drops
// the decisive line, or collapses two different events into one, sends the
// next session chasing the wrong cause -- which is exactly the failure mode
// this file was written to end.
describe('kbTrace', () => {
  it('keeps distinct events in order, oldest first', () => {
    kbTrace('sheet', { open: true })
    kbTrace('input:blur', { sheet: true })
    const lines = formatKbTrace().split('\n')
    expect(lines[lines.length - 2]).toContain('sheet open=true')
    expect(lines[lines.length - 1]).toContain('input:blur sheet=true')
  })

  it('collapses an identical repeat into a count instead of evicting the signal', () => {
    // The real shape: iOS fires the same resize continuously while a keyboard
    // animates. Three identical lines must cost ONE row, or a burst pushes the
    // pointerdown that started it out of the buffer.
    const before = formatKbTrace().split('\n').length
    kbTrace('vv:resize', { occluded: 300, verdict: 'keep' })
    kbTrace('vv:resize', { occluded: 300, verdict: 'keep' })
    kbTrace('vv:resize', { occluded: 300, verdict: 'keep' })
    const lines = formatKbTrace().split('\n')
    expect(lines).toHaveLength(before + 1)
    expect(lines[lines.length - 1]).toContain('(x3)')
  })

  it('does NOT collapse a resize whose values changed', () => {
    // The whole point of the log: occlusion 300 -> 0 is the teardown edge. If
    // that folded into the previous row as a repeat, the trace would hide the
    // exact transition being hunted.
    kbTrace('vv:resize', { occluded: 300, verdict: 'keep' })
    kbTrace('vv:resize', { occluded: 0, verdict: 'teardown' })
    const lines = formatKbTrace().split('\n')
    expect(lines[lines.length - 1]).toContain('occluded=0 verdict=teardown')
    expect(lines[lines.length - 1]).not.toContain('(x')
  })
})

// The auto-send is the whole point now: nobody should have to copy anything.
// These lock the two ways it silently fails -- never firing, or firing per
// event and burying the signal it was added to surface.
describe('kbTrace auto-send', () => {
  it('ships one debounced block containing the burst, not one per event', async () => {
    const blocks: string[] = []
    setKbTraceSink((text) => blocks.push(text))
    kbTrace('sheet', { open: true })
    kbTrace('vv:resize', { occluded: 300, verdict: 'keep' })
    kbTrace('input:blur', { sheet: true })
    expect(blocks).toHaveLength(0) // still inside the quiet window
    await new Promise((r) => setTimeout(r, 800))
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toContain('sheet open=true')
    expect(blocks[0]).toContain('input:blur sheet=true')
  })

  it('never re-sends a line it already sent', async () => {
    const blocks: string[] = []
    setKbTraceSink((text) => blocks.push(text))
    kbTrace('first', {})
    await new Promise((r) => setTimeout(r, 800))
    kbTrace('second', {})
    await new Promise((r) => setTimeout(r, 800))
    const last = blocks[blocks.length - 1]
    expect(last).toContain('second')
    expect(last).not.toContain('first')
  })
})
