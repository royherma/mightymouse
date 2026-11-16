import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { readSessionTranscript } from '../session-transcript'

const AT = '2026-11-16T10:00:00.000Z'

function claudeRoot(id: string, lines: object[]): string {
  const root = mkdtempSync(join(tmpdir(), 'mm-tx-delegate-'))
  const dir = join(root, '.claude', 'projects', '-cwd')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'))
  return root
}

function codexRoot(id: string, lines: object[]): string {
  const root = mkdtempSync(join(tmpdir(), 'mm-tx-delegate-'))
  const now = new Date()
  const dir = join(root, '.codex', 'sessions', String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `rollout-2026-11-16T10-00-00-${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'))
  return root
}

const claudeTool = (name: string, input: object): object => ({
  type: 'assistant',
  timestamp: AT,
  message: { role: 'assistant', content: [{ type: 'tool_use', name, input }] }
})

const codexCall = (name: string, args: object): object => ({
  type: 'response_item',
  timestamp: AT,
  payload: { type: 'function_call', name, arguments: JSON.stringify(args) }
})

const codexSays = (role: string, text: string): object => ({
  type: 'response_item',
  timestamp: AT,
  payload: { type: 'message', role, content: [{ type: 'input_text', text }] }
})

const ID = 'abfc7e33-c7b4-402d-ac6c-dfc31f7c5e75'
const steps = (turns: Array<{ role: string; text: string }>): string[] => turns.filter((t) => t.role === 'tool').map((t) => t.text.split(' · ')[0])

describe('a delegate step shows which agent was asked, not the raw tool name', () => {
  it('a Claude session calling the MightyMouse delegate tool reads "Asked Codex"', () => {
    const root = claudeRoot(ID, [claudeTool('mcp__mightymouse__delegate', { agent: 'codex', task: 'Review auth.ts' })])
    expect(steps(readSessionTranscript({ cwd: '/cwd', sessionId: ID }, root))).toEqual(['Asked Codex'])
  })

  it('a Codex session, whose arguments arrive as a JSON string, reads "Asked Claude"', () => {
    const root = codexRoot(ID, [codexCall('mightymouse.delegate', { agent: 'claude', task: 'Second opinion' })])
    expect(steps(readSessionTranscript({ sessionId: ID, facts: { agent: 'codex' } }, root))).toEqual(['Asked Claude'])
  })

  it('an agent with no friendly name is shown as given; a tool that only ends in "delegate" keeps its name', () => {
    const root = claudeRoot(ID, [
      claudeTool('mcp__mightymouse__delegate', { agent: 'opencode', task: 'x' }),
      claudeTool('mcp__other__undelegate', { agent: 'codex' }),
      claudeTool('mcp__mightymouse__delegate', { task: 'no agent named' })
    ])
    expect(steps(readSessionTranscript({ cwd: '/cwd', sessionId: ID }, root))).toEqual(['Asked opencode', 'mcp__other__undelegate', 'mcp__mightymouse__delegate'])
  })
})

describe('Codex AGENTS.md text injected as a user message is not shown as something the person typed', () => {
  it('drops the AGENTS.md block and keeps the real question', () => {
    const root = codexRoot(ID, [
      codexSays('user', '# AGENTS.md instructions for /Users/me/proj\n\n<INSTRUCTIONS>be terse</INSTRUCTIONS>'),
      codexSays('user', 'why is login slow?'),
      codexSays('assistant', 'The session lookup runs twice.')
    ])
    expect(readSessionTranscript({ sessionId: ID, facts: { agent: 'codex' } }, root).map((t) => [t.role, t.text])).toEqual([
      ['you', 'why is login slow?'],
      ['agent', 'The session lookup runs twice.']
    ])
  })
})
