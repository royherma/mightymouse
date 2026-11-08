import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readSessionTranscript } from '../session-transcript'

const id = 'abfc7e33-c7b4-402d-ac6c-dfc31f7c5e75'

function write(lines: object[]): string {
  const root = mkdtempSync(join(tmpdir(), 'mm-tx-compact-'))
  const dir = join(root, '.claude', 'projects', '-cwd')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'))
  return root
}

const say = (type: string, text: string, extra: object = {}): object => ({
  type,
  timestamp: '2026-09-21T10:00:00.000Z',
  message: { role: type, content: [{ type: 'text', text }] },
  ...extra
})

describe('readSessionTranscript after a compaction', () => {
  it('does not show the compaction summary as a message the person typed', () => {
    const root = write([
      say('user', 'first ask'),
      say('user', 'This session is being continued from a previous conversation...', { isCompactSummary: true }),
      say('user', 'next ask')
    ])
    expect(readSessionTranscript({ cwd: '/cwd', sessionId: id }, root).map((t) => t.text)).toEqual(['first ask', 'next ask'])
  })
})
