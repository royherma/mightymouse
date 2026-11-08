import { describe, it, expect, vi } from 'vitest'
import { mkdirSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

vi.mock('../../supabase', () => ({ getSupabase: vi.fn() }))

import { runTerminal } from '../runner'
import { PATHS } from '../../store/paths'

const MINE = '223ea9f7-5713-4586-ad58-9e28af92dd1e'
const OTHER = 'b5df6c91-be74-419f-a064-9ad112b0ecc7'

describe('runTerminal', () => {
  it('shows one run as command, raw output, then stderr and exit, without another run mixed in', () => {
    mkdirSync(dirname(PATHS.LOG), { recursive: true })
    writeFileSync(
      PATHS.LOG,
      [
        `=== RUN ${OTHER} ===`,
        `[10/8/2026, 12:56:00 PM] [${OTHER}] claude spawn: other-command`,
        `[${OTHER}] cold spawn`,
        `=== RUN ${MINE} ===`,
        `[10/8/2026, 12:57:10 PM] [${MINE}] claude spawn: my-command`,
        `[${MINE}] cold spawn`,
        `[${OTHER}] claude exit code: 0 (total: 1.00s)`,
        `[${MINE}] [STDERR] first line`,
        'second line',
        `[${MINE}] claude exit code: 1 (startup: 5ms, total: 2.00s)`,
        ''
      ].join('\n')
    )
    const runDir = join(dirname(PATHS.LOG), 'run-terminal-test')
    mkdirSync(runDir, { recursive: true })
    writeFileSync(join(runDir, '.out-a.txt'), `{"type":"init"}\n\n${'x'.repeat(2500)}\n`)

    expect(runTerminal(MINE, runDir).split('\n')).toEqual([
      '[10/8/2026, 12:57:10 PM] claude spawn: my-command',
      'cold spawn',
      '{"type":"init"}',
      `${'x'.repeat(2000)} … +500 more`,
      '[STDERR] first line',
      'second line',
      'claude exit code: 1 (startup: 5ms, total: 2.00s)'
    ])
    expect(runTerminal(MINE, undefined)).not.toContain('"type":"init"')
    expect(runTerminal('00000000-0000-0000-0000-000000000000', undefined)).toBe('')
  })
})
