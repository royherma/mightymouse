import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG } from '../../../shared/config'

// readAllEntries() used to hand out the live warm-cache array. The resumeSession
// handler chained `.reverse()` on it, which mutates in place — so one Continue on a
// history row permanently flipped the shared cache, and every later readRecent()
// walked from the OLDEST row. The History flyout then rendered oldest-first (a May 30
// "testing" row pinned to the top) until the app was restarted.
//
// Same temp-home trick as the sibling history tests: paths.ts captures os.homedir()
// at eval time, so the temp home must exist and homedir() must already return it
// BEFORE history.ts (→ paths.ts) is first imported.
const HOME = mkdtempSync(join(tmpdir(), 'mm-history-cache-'))
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

// Three rows, oldest→newest on disk — the order history is actually written in.
const ROWS = [
  { run_id: 'r:old', ts: '2026-05-30T09:33:43Z', mode: 'ask', instruction: 'testing', ok: true },
  { run_id: 'r:mid', ts: '2026-06-02T06:50:06Z', mode: 'ask', instruction: 'transribe this', ok: true },
  { run_id: 'r:new', ts: '2026-07-29T07:07:33Z', mode: 'ask', instruction: 'newest row', ok: true }
]

describe('history cache isolation', () => {
  beforeEach(() => {
    writeFileSync(HISTORY_FILE, ROWS.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8')
    vi.resetModules()
  })

  it('readRecent stays newest-first after a caller reverses readAllEntries', async () => {
    const { HISTORY } = await import('../history')

    expect(HISTORY.readRecent(30)[0]?.instruction).toBe('newest row')

    // Exactly what the resumeSession handler used to do to find a run by id.
    HISTORY.readAllEntries().reverse()

    // The cache must be untouched — this returned 'testing' before the fix.
    expect(HISTORY.readRecent(30)[0]?.instruction).toBe('newest row')
  })

  it('readAllEntries hands out a copy, not the live cache', async () => {
    const { HISTORY } = await import('../history')

    const a = HISTORY.readAllEntries()
    const b = HISTORY.readAllEntries()
    expect(a).not.toBe(b)

    a.reverse()
    expect(HISTORY.readAllEntries()[0]?.run_id).toBe('r:old')
  })
})
