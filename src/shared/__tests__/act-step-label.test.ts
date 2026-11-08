import { describe, it, expect } from 'vitest'
import { actStepLabel } from '../act-step-label'
import { RUN_EVENT, type RunEvent } from '../types'

function bash(command: string): RunEvent {
  return { kind: RUN_EVENT.tool_start, id: 't1', name: 'Bash', input: { command } }
}

describe('actStepLabel', () => {
  it('reads a click off the mm-input grammar the agent was taught', () => {
    // The label the whole feature exists for: what the user sees on the mirror
    // when the agent drives their Mac. Coordinates included because a WRONG
    // click is the failure they need to catch, and only the numbers show it.
    expect(actStepLabel(bash('/path/to/mm-input click 10 20'))).toBe('click 10,20')
    expect(actStepLabel(bash('mm-input doubleclick 812 340'))).toBe('doubleclick 812,340')
  })

  it('shows what was typed, not just that typing happened', () => {
    expect(actStepLabel(bash("mm-input type 'cats'"))).toBe('type “cats”')
    expect(actStepLabel(bash('mm-input key "cmd+t"'))).toBe('key “cmd+t”')
  })

  it('renders a drag as both of its ends', () => {
    // Drag is the one verb whose midpoint (what the highlight overlay uses)
    // would be actively misleading as a label — it names a spot neither end
    // of the gesture touched.
    expect(actStepLabel(bash('mm-input drag 5 6 70 80'))).toBe('drag 5,6 → 70,80')
  })

  it('still reports an mm-input call it cannot parse', () => {
    // A blank bubble mid-run reads as "it froze". A vague true label beats
    // dropping the only evidence the agent did something.
    expect(actStepLabel(bash('mm-input somethingnew --weird'))).toBe('acting on screen')
  })

  it('labels ordinary tools without pretending they are screen actions', () => {
    expect(actStepLabel(bash('ls -la'))).toBe('run ls -la')
    expect(actStepLabel({ kind: RUN_EVENT.tool_start, id: 'a', name: 'WebSearch', input: {} })).toBe('WebSearch')
  })

  it('truncates a long command instead of overflowing the bubble', () => {
    const label = actStepLabel(bash('echo ' + 'x'.repeat(200)))!
    expect(label.length).toBeLessThanOrEqual(64)
    expect(label.endsWith('…')).toBe(true)
  })

  it('ignores every event that is not the START of a tool call', () => {
    // tool_end fires for the same action; emitting both would double every
    // step in the list.
    expect(actStepLabel({ kind: RUN_EVENT.tool_end, id: 't1', output: 'ok', isError: false })).toBeNull()
    expect(actStepLabel({ kind: RUN_EVENT.text, text: 'hello' })).toBeNull()
  })
})
