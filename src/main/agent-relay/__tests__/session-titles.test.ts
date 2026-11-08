import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:os')>()), homedir: () => env.home }))
vi.mock('../../backend/runner', () => ({ runBackend: vi.fn() }))
vi.mock('../factory/execution', () => ({ projectBrief: vi.fn(), projectBusiness: vi.fn() }))

env.home = mkdtempSync(join(tmpdir(), 'mm-titles-'))
afterAll(() => rmSync(env.home, { recursive: true, force: true }))
const { sessionAiTitle, sessionFirstAsk } = await import('../project-ideas')

const cwd = '/Users/me/my_app.v2'
let n = 0
function transcript(lines: unknown[]): string {
  const id = `sess-${++n}`
  const dir = join(env.home, '.claude', 'projects', '-Users-me-my-app-v2')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${id}.jsonl`), lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n'))
  return id
}

describe('sessionAiTitle', () => {
  it('reads the newest AI title, decoding quotes and unicode', () => {
    const id = transcript([
      { type: 'user', message: { content: 'hi' } },
      { type: 'ai-title', aiTitle: 'Old name' },
      { type: 'assistant', message: { content: 'ok' } },
      { type: 'ai-title', aiTitle: 'Fix "login" on café page' }
    ])
    expect(sessionAiTitle(cwd, id)).toBe('Fix "login" on café page')
  })

  it('has no title for a transcript without one, or a session with no transcript', () => {
    expect(sessionAiTitle(cwd, transcript([{ type: 'user', message: { content: 'hi' } }]))).toBeUndefined()
    expect(sessionAiTitle(cwd, 'no-such-session')).toBeUndefined()
  })

  it('ignores a blank title', () => {
    expect(sessionAiTitle(cwd, transcript([{ type: 'ai-title', aiTitle: '   ' }]))).toBeUndefined()
  })
})

describe('sessionFirstAsk', () => {
  it('skips an attached file path and system blocks to find the words the person typed', () => {
    const id = transcript([
      { type: 'user', message: { content: '<command-name>/clear</command-name>' } },
      { type: 'user', message: { content: '/Users/me/.cache/clipaste/shot-1.png\nMake   the header smaller' } }
    ])
    expect(sessionFirstAsk(cwd, id)).toBe('Make the header smaller')
  })
})
