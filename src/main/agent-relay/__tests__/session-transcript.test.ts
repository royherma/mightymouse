import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { claudeTranscriptPaths, readSessionTranscript } from '../session-transcript'

const home = '/Users/ada_dev'
const cwd = '/Users/ada_dev/Desktop/ShowAndTell'
const id = 'abfc7e33-c7b4-402d-ac6c-dfc31f7c5e75'

describe('claudeTranscriptPaths', () => {
  it('offers both encodings when the cwd has an underscore', () => {
    expect(claudeTranscriptPaths(home, cwd, id)).toEqual([
      `${home}/.claude/projects/-Users-ada-dev-Desktop-ShowAndTell/${id}.jsonl`,
      `${home}/.claude/projects/-Users-ada_dev-Desktop-ShowAndTell/${id}.jsonl`
    ])
  })

  it('offers one path when the two encodings agree', () => {
    expect(claudeTranscriptPaths(home, '/Users/ada/app', id)).toHaveLength(1)
  })

  it('refuses a session id that could escape the directory', () => {
    expect(claudeTranscriptPaths(home, cwd, '../etc')).toEqual([])
  })
})

describe('readSessionTranscript', () => {
  const write = (lines: object[]): string => {
    const root = mkdtempSync(join(tmpdir(), 'mm-tx-'))
    const dir = join(root, '.claude', 'projects', '-cwd')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'))
    return root
  }

  const say = (type: string, text: string): object => ({
    type,
    timestamp: '2026-09-21T10:00:00.000Z',
    message: { role: type, content: [{ type: 'text', text }] }
  })

  it('reads both sides of the conversation', () => {
    const root = write([say('user', 'ship it'), say('assistant', 'done')])
    expect(readSessionTranscript({ cwd: '/cwd', sessionId: id }, root)).toEqual([
      { role: 'you', at: Date.parse('2026-09-21T10:00:00.000Z'), text: 'ship it' },
      { role: 'agent', at: Date.parse('2026-09-21T10:00:00.000Z'), text: 'done' }
    ])
  })

  it('drops the blobs the harness injects, keeping what the person typed', () => {
    const root = write([say('user', '<system-reminder>rules</system-reminder>'), say('user', 'hi')])
    expect(readSessionTranscript({ cwd: '/cwd', sessionId: id }, root).map((t) => t.text)).toEqual(['hi'])
  })

  it('shows a tool name so a working stretch is not a silent gap', () => {
    const root = write([
      { type: 'assistant', timestamp: '2026-09-21T10:00:00.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash' }] } }
    ])
    expect(readSessionTranscript({ cwd: '/cwd', sessionId: id }, root)).toEqual([
      { role: 'tool', at: Date.parse('2026-09-21T10:00:00.000Z'), text: 'Bash' }
    ])
  })

  it('carries what the tool ran on, or the row expands to nothing', () => {
    const root = write([
      {
        type: 'assistant',
        timestamp: '2026-09-21T10:00:00.000Z',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              name: 'Bash',
              input: { command: 'grep -rn foo src', description: 'Search for foo' }
            }
          ]
        }
      }
    ])
    expect(readSessionTranscript({ cwd: '/cwd', sessionId: id }, root).map((t) => t.text)).toEqual([
      'Bash \u00b7 Search for foo\ngrep -rn foo src'
    ])
  })

  it('names the task a status flip is about, not the row id', () => {
    const root = write([
      {
        type: 'assistant',
        timestamp: '2026-09-21T10:00:00.000Z',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              name: 'TaskUpdate',
              input: { taskId: '2', status: 'completed', subject: 'Ship the fix' }
            }
          ]
        }
      }
    ])
    expect(readSessionTranscript({ cwd: '/cwd', sessionId: id }, root).map((t) => t.text)).toEqual([
      'TaskUpdate \u00b7 Ship the fix (completed)'
    ])
  })

  it('falls back to any short argument so an unknown tool still says something', () => {
    const root = write([
      {
        type: 'assistant',
        timestamp: '2026-09-21T10:00:00.000Z',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              name: 'mcp__thing__do',
              input: { simulatorId: '5B45F476-72D2', deviceName: 'iPhone 17' }
            }
          ]
        }
      }
    ])
    expect(readSessionTranscript({ cwd: '/cwd', sessionId: id }, root).map((t) => t.text)).toEqual([
      'mcp__thing__do \u00b7 iPhone 17'
    ])
  })

  it('stays a bare name when the call carried no arguments', () => {
    const root = write([
      {
        type: 'assistant',
        timestamp: '2026-09-21T10:00:00.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'ReadNotifications', input: {} }]
        }
      }
    ])
    expect(readSessionTranscript({ cwd: '/cwd', sessionId: id }, root).map((t) => t.text)).toEqual([
      'ReadNotifications'
    ])
  })

  it('is empty when no transcript exists', () => {
    expect(readSessionTranscript({ cwd: '/cwd', sessionId: id }, mkdtempSync(join(tmpdir(), 'mm-tx-')))).toEqual([])
  })
})
