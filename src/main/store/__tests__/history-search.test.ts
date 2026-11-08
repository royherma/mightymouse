import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG } from '../../../shared/config'

const HOME = mkdtempSync(join(tmpdir(), 'mm-history-search-'))
mkdirSync(join(HOME, CONFIG.APP_NAME, 'backups'), { recursive: true })

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => HOME }
})

vi.mock('../prefs', () => ({
  PREFS: {
    getHistoryEncryption: () => false,
    getIncognito: () => false
  }
}))

vi.mock('electron', () => ({
  safeStorage: {
    encryptString: vi.fn(),
    decryptString: vi.fn(),
    isEncryptionAvailable: vi.fn(() => false)
  }
}))

const HISTORY_FILE = join(HOME, CONFIG.APP_NAME, 'rewrite-history.jsonl')

const ROWS = [
  { run_id: 'r:1', ts: '2026-05-30T09:00:00Z', mode: 'ask', instruction: 'plan the Safari demo', ok: true },
  { run_id: 'r:2', ts: '2026-06-01T09:00:00Z', mode: 'ask', instruction: 'tax question', result: 'Open Safari first', ok: true },
  { run_id: 'r:3', ts: '2026-06-02T09:00:00Z', mode: 'ask', instruction: 'chat', turns: [{ q: 'hi', a: 'try safari' }], ok: true },
  { run_id: 'r:4', ts: '2026-06-03T09:00:00Z', mode: 'ask', instruction: 'old safari wording', ok: true },
  { run_id: 'r:4', ts: '2026-06-03T09:01:00Z', mode: 'ask', instruction: 'rewritten, no match', ok: true },
  { run_id: 'r:5', ts: '2026-06-04T09:00:00Z', mode: 'ask', instruction: 'unrelated', ok: true }
]

describe('history search', () => {
  beforeEach(() => {
    writeFileSync(HISTORY_FILE, ROWS.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8')
    vi.resetModules()
  })

  it('matches instruction, result and turns, newest first, case-insensitive', async () => {
    const { HISTORY } = await import('../history')
    expect(HISTORY.readRecent(30, 'SAFARI').map((r) => r.run_id)).toEqual(['r:3', 'r:2', 'r:1'])
  })

  it('needs every word, and an empty query is the plain recent list', async () => {
    const { HISTORY } = await import('../history')
    expect(HISTORY.readRecent(30, 'safari demo').map((r) => r.run_id)).toEqual(['r:1'])
    expect(HISTORY.readRecent(30, '  ')).toHaveLength(5)
  })
})
