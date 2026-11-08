/**
 * Tests for per-step stream timing: adapter parseStep + runner summarizeSteps.
 *
 * Covers:
 *   1. codex parseStep maps item.started/completed (command_execution) to a StreamStep
 *   2. codex parseStep ignores non-tool items (agent_message) and junk lines
 *   3. claude parseStep maps tool_use (start) and tool_result (end)
 *   4. summarizeSteps reads a steps.jsonl and returns count + slowest-first
 *   5. summarizeSteps returns null when no steps file exists
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { BACKENDS } from '../adapters'
import { summarizeSteps } from '../runner'

const codex = BACKENDS.codex
const claude = BACKENDS.claude

describe('codex.parseStep', () => {
  it('maps a command_execution start + completed', () => {
    const start = codex.parseStep!(
      JSON.stringify({
        type: 'item.started',
        item: { id: 'item_0', type: 'command_execution', command: '/bin/zsh -lc "ffmpeg -i a.mov"' }
      })
    )
    expect(start).toMatchObject({ id: 'item_0', edge: 'start', kind: 'command_execution' })
    expect(start?.cmd).toContain('ffmpeg')

    const end = codex.parseStep!(
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'item_0', type: 'command_execution', exit_code: 0 }
      })
    )
    expect(end).toMatchObject({ id: 'item_0', edge: 'end', exit: 0 })
  })

  it('ignores agent_message items and unparseable lines', () => {
    expect(
      codex.parseStep!(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message' } }))
    ).toBeNull()
    expect(codex.parseStep!('not json')).toBeNull()
  })
})

describe('claude.parseStep', () => {
  it('maps tool_use (start) and tool_result (end)', () => {
    const start = claude.parseStep!(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'which whisper' } }] }
      })
    )
    expect(start).toMatchObject({ id: 'tu_1', edge: 'start', kind: 'Bash' })

    const end = claude.parseStep!(
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', is_error: false }] }
      })
    )
    expect(end).toMatchObject({ id: 'tu_1', edge: 'end', exit: 0 })
  })
})

describe('summarizeSteps', () => {
  let dir: string
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('reads steps.jsonl and returns count + slowest-first', () => {
    dir = mkdtempSync(join(tmpdir(), 'steps-'))
    const rows = [
      { i: 0, kind: 'command_execution', cmd: 'find', startMs: 10, durMs: 500 },
      { i: 1, kind: 'command_execution', cmd: 'mdfind', startMs: 600, durMs: 22000 },
      { i: 2, kind: 'command_execution', cmd: 'whisper-cli', startMs: 22700, durMs: 4000 }
    ]
    writeFileSync(join(dir, 'steps.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')

    const sum = summarizeSteps(dir)
    expect(sum?.stepCount).toBe(3)
    expect(sum?.slowest[0].cmd).toBe('mdfind') // slowest first
    expect(sum?.slowest[0].durMs).toBe(22000)
  })

  it('returns null when no steps file exists', () => {
    dir = mkdtempSync(join(tmpdir(), 'steps-empty-'))
    expect(summarizeSteps(dir)).toBeNull()
  })
})
