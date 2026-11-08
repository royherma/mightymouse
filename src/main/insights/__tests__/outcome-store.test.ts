import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOutcomeStore, type Outcome } from '../outcome-store'

vi.mock('../store/safe-storage', () => ({
  encryptLine: (plain: string) => plain,
  decryptLine: (line: string) => line
}))

// record() early-returns when Incognito is on; the real PREFS reads
// ~/MightyMouse/incognito-toggle.txt, which makes this test depend on the dev
// machine's live toggle. Mock it OFF so the store always writes here.
vi.mock('../../store/prefs', () => ({
  PREFS: { getIncognito: () => false }
}))

let tmpRoot: string | null = null

afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true })
  tmpRoot = null
})

describe('OutcomeStore', () => {
  it('round-trips rows and computes accept rates by app bucket', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'mm-outcomes-'))
    const store = createOutcomeStore(join(tmpRoot, 'rewrite-outcomes.jsonl'))
    const accepted: Outcome = {
      ts: '2026-06-02T00:00:00.000Z',
      front_app: 'Mail',
      mode: 'rewrite',
      instruction_stem: 'reply yes and confirm',
      shown_index: 0,
      accepted: true
    }
    const dismissed: Outcome = {
      ...accepted,
      ts: '2026-06-02T00:01:00.000Z',
      shown_index: 1,
      accepted: false
    }

    store.record(accepted)
    store.record(dismissed)

    expect(store.readRecent(2)).toEqual([dismissed, accepted])
    expect(store.acceptRateByContext({ front_app: 'Mail' }).get('reply yes and confirm')).toMatchObject({
      accepted: 1,
      dismissed: 1,
      rate: 0.5
    })
  })

  it('readAll returns every row (newest-first) and preserves gen_ms', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'mm-outcomes-'))
    const store = createOutcomeStore(join(tmpRoot, 'rewrite-outcomes.jsonl'))
    const base: Outcome = {
      ts: '2026-06-02T00:00:00.000Z',
      front_app: 'Mail',
      mode: 'rewrite',
      instruction_stem: 'reply',
      shown_index: 0,
      accepted: true,
      gen_ms: 1234
    }
    // More rows than the default OUTCOME_RECENT cap would matter for, to prove
    // readAll() isn't truncating like readRecent().
    for (let i = 0; i < 5; i++) {
      store.record({ ...base, ts: `2026-06-02T00:0${i}:00.000Z`, shown_index: i })
    }
    const all = store.readAll()
    expect(all).toHaveLength(5)
    expect(all[0].shown_index).toBe(4) // newest first
    expect(all.every((r) => r.gen_ms === 1234)).toBe(true)
  })

  it('round-trips the decision field', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'mm-outcomes-'))
    const store = createOutcomeStore(join(tmpRoot, 'rewrite-outcomes.jsonl'))
    store.record({
      ts: '2026-06-02T00:00:00.000Z',
      front_app: 'Mail',
      mode: 'rewrite',
      instruction_stem: 'reply',
      shown_index: 0,
      accepted: false,
      decision: 'superseded'
    })
    expect(store.readAll()[0].decision).toBe('superseded')
  })

  it('decodes legacy rows that have no gen_ms', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'mm-outcomes-'))
    const store = createOutcomeStore(join(tmpRoot, 'rewrite-outcomes.jsonl'))
    // A row written before gen_ms existed: still valid, gen_ms undefined.
    store.record({
      ts: '2026-06-01T00:00:00.000Z',
      front_app: 'Notes',
      mode: 'ask',
      instruction_stem: 'summarize',
      shown_index: 0,
      accepted: false
    })
    const [row] = store.readAll()
    expect(row.gen_ms).toBeUndefined()
    expect(row.front_app).toBe('Notes')
  })
})
