import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { sessionAccountHome } from '../session-transcript'

const id = 'abfc7e33-c7b4-402d-ac6c-dfc31f7c5e75'
const turn = JSON.stringify({
  type: 'user',
  timestamp: '2026-11-01T10:00:00.000Z',
  message: { role: 'user', content: [{ type: 'text', text: 'ship it' }] }
})

function homeWith(configDir: string): string {
  const home = mkdtempSync(join(tmpdir(), 'mm-acct-home-'))
  mkdirSync(join(home, '.claude', 'projects'), { recursive: true })
  const dir = join(home, configDir, 'projects', '-cwd')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${id}.jsonl`), turn)
  return home
}

describe('sessionAccountHome', () => {
  it('a session in the default folder belongs to the default Claude account', () => {
    const home = homeWith('.claude')
    expect(sessionAccountHome({ cwd: '/cwd', sessionId: id }, home)).toEqual({ backend: 'claude', dir: join(home, '.claude') })
  })

  it('a session written by a second Claude account points at that account folder', () => {
    const home = homeWith('.claude-work')
    expect(sessionAccountHome({ cwd: '/cwd', sessionId: id }, home)).toEqual({ backend: 'claude', dir: join(home, '.claude-work') })
  })

  it('no transcript on disk means no account to show', () => {
    const home = homeWith('.claude')
    expect(sessionAccountHome({ cwd: '/elsewhere', sessionId: id }, home)).toBeNull()
    expect(sessionAccountHome({ cwd: '/cwd' }, home)).toBeNull()
  })
})
