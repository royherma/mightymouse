import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG } from '../../../shared/config'

// Same trick as prefs.test.ts: paths.ts captures os.homedir() at eval time, so the
// temp home must exist and homedir() must return it BEFORE feedback.ts (→ paths.ts)
// is first imported. Create the dir, mock homedir, then dynamic-import FEEDBACK.
const HOME = mkdtempSync(join(tmpdir(), 'mm-feedback-'))
mkdirSync(join(HOME, CONFIG.APP_NAME), { recursive: true })

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => HOME }
})

// safeStorage isn't available under vitest; pass plaintext through both ways.
vi.mock('../safe-storage', () => ({
  encryptLine: (plain: string) => plain,
  decryptLine: (line: string) => line
}))

const file = join(HOME, CONFIG.APP_NAME, 'rewrite-feedback.jsonl')

let FEEDBACK: typeof import('../feedback').FEEDBACK

describe('FEEDBACK', () => {
  beforeAll(async () => {
    FEEDBACK = (await import('../feedback')).FEEDBACK
  })

  afterAll(() => {
    rmSync(HOME, { recursive: true, force: true })
  })

  it('records, reads back, and lets the latest rating win for a run_id', () => {
    FEEDBACK.record({ run_id: 'r1', rating: 'up' })
    expect(FEEDBACK.get('r1')?.rating).toBe('up')

    // Re-rate: a second append must override the first (latest-wins).
    FEEDBACK.record({ run_id: 'r1', rating: 'down', note: 'too long, one line' })
    expect(FEEDBACK.get('r1')?.rating).toBe('down')
    expect(FEEDBACK.get('r1')?.note).toBe('too long, one line')
  })

  it('returns null for an unrated run and exposes all() as a run_id map', () => {
    expect(FEEDBACK.get('never-rated')).toBeNull()
    FEEDBACK.record({ run_id: 'r2', rating: 'up' })
    const all = FEEDBACK.all()
    expect(all['r2']?.rating).toBe('up')
    expect(all['r1']?.rating).toBe('down')
  })

  it('recentCorrections surfaces only 👎-with-note, newest-first', () => {
    FEEDBACK.record({ run_id: 'c1', rating: 'down', note: 'wanted bullet points' })
    FEEDBACK.record({ run_id: 'c2', rating: 'down' }) // down but NO note → excluded
    FEEDBACK.record({ run_id: 'c3', rating: 'up', note: 'great' }) // up → excluded
    const corrections = FEEDBACK.recentCorrections(10)
    const runIds = corrections.map((c) => c.run_id)
    expect(runIds).toContain('c1')
    expect(runIds).not.toContain('c2')
    expect(runIds).not.toContain('c3')
    // Every surfaced row is a down-with-note.
    expect(corrections.every((c) => c.rating === 'down' && !!c.note)).toBe(true)
  })

  it('recentPraises surfaces only 👍-with-note, newest-first', () => {
    FEEDBACK.record({ run_id: 'p1', rating: 'up', note: 'loved the tone' })
    FEEDBACK.record({ run_id: 'p2', rating: 'up' }) // up but NO note → excluded
    FEEDBACK.record({ run_id: 'p3', rating: 'down', note: 'too long' }) // down → excluded
    const praises = FEEDBACK.recentPraises(10)
    const runIds = praises.map((p) => p.run_id)
    expect(runIds).toContain('p1')
    expect(runIds).not.toContain('p2')
    expect(runIds).not.toContain('p3')
    // Every surfaced row is an up-with-note.
    expect(praises.every((p) => p.rating === 'up' && !!p.note)).toBe(true)
  })

  it('tolerates a corrupt line on cold load (skips it, keeps valid rows)', async () => {
    // Write a fresh file with one junk line + one good line, then re-import to force a
    // cold cache load through decodeLine's try/catch.
    writeFileSync(file, 'not json\n' + JSON.stringify({ run_id: 'ok', rating: 'up', ts: '2026-06-06T00:00:00Z' }) + '\n')
    vi.resetModules()
    const fresh = (await import('../feedback')).FEEDBACK
    expect(fresh.get('ok')?.rating).toBe('up')
  })
})
