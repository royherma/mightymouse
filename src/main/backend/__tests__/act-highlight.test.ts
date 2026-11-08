import { describe, it, expect, vi } from 'vitest'
import { RUN_EVENT } from '../../../shared/types'
import type { RunEvent } from '../../../shared/types'

// act-highlight reaches `electron` at module scope for the coordinate math.
// isActInputCommand never touches it, but the import still has to resolve.
vi.mock('electron', () => ({
  screen: { getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0 }, scaleFactor: 2 }) }
}))

const { isActInputCommand } = await import('../act-highlight')

function bashStart(command: string, id = 't1'): RunEvent {
  return { kind: RUN_EVENT.tool_start, id, name: 'Bash', input: { command } }
}

/**
 * The act agent runs mm-input through Bash, so no TS call site exists to stamp
 * it. Missing one of these shapes means Away Mode reads the agent's own
 * CGEvents as a human and relocks the Mac mid-run.
 */
describe('isActInputCommand', () => {
  it('matches a bare invocation', () => {
    expect(isActInputCommand(bashStart('/path/to/mm-input click 100 200'))).toBe(true)
  })

  it('matches the verbs the highlight parser ignores', () => {
    // No coordinates anywhere in these -- the reason this predicate exists
    // separately from parseActHighlightTarget.
    expect(isActInputCommand(bashStart('/p/mm-input type "hello world"'))).toBe(true)
    expect(isActInputCommand(bashStart('/p/mm-input key cmd+a'))).toBe(true)
    expect(isActInputCommand(bashStart('/p/mm-input scroll down 5'))).toBe(true)
  })

  it('matches when quoted, chained or prefixed', () => {
    expect(isActInputCommand(bashStart('cd /tmp && "/p/mm-input" click 1 2'))).toBe(true)
    expect(isActInputCommand(bashStart('sleep 1; /p/mm-input move 5 5'))).toBe(true)
  })

  it('ignores unrelated Bash and non-Bash tools', () => {
    expect(isActInputCommand(bashStart('ls -la /tmp'))).toBe(false)
    expect(isActInputCommand(bashStart('/p/mm-ui highlight 10 10'))).toBe(false)
    expect(
      isActInputCommand({ kind: RUN_EVENT.tool_start, id: 't', name: 'Read', input: {} })
    ).toBe(false)
  })

  it('ignores tool_end — it carries no command to match', () => {
    expect(
      isActInputCommand({ kind: RUN_EVENT.tool_end, id: 't1', output: '', isError: false })
    ).toBe(false)
  })
})
