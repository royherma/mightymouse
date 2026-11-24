import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readSessionTranscript } from '../session-transcript'

const id = 'abfc7e33-c7b4-402d-ac6c-dfc31f7c5e75'
const user = (text: string): object => ({ type: 'user', timestamp: '2026-11-22T10:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text }] } })

function chatOf(texts: string[]): string[] {
  const root = mkdtempSync(join(tmpdir(), 'mm-tags-'))
  const dir = join(root, '.claude', 'projects', '-cwd')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${id}.jsonl`), texts.map((t) => JSON.stringify(user(t))).join('\n'))
  return readSessionTranscript({ cwd: '/cwd', sessionId: id }, root).map((t) => t.text)
}

describe('task-notification and slash-command tags stay out of the chat', () => {
  it.each([
    '<task-notification>\n<task-id>bz1</task-id>\n<status>completed</status>\n</task-notification>',
    '<command-name>/clear</command-name>\n<command-message>clear</command-message>',
    '<command-message>compact</command-message>',
    '<local-command-stdout>(no content)</local-command-stdout>'
  ])('%s is dropped', (tag) => {
    expect(chatOf([tag, 'ship the release notes'])).toEqual(['ship the release notes'])
  })

  it('a typed message that only mentions a tag is kept', () => {
    expect(chatOf(['why is <task-notification> in my chat'])).toEqual(['why is <task-notification> in my chat'])
  })
})
