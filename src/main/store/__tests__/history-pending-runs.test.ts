import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG } from '../../../shared/config'

// The pending-row lifecycle is the whole point of long-running unattended agents:
// before it, a run the app never saw finish (crash / force-quit / power loss) left
// NO history row at all — an hour of work with zero evidence it happened. These
// tests pin the two halves of that contract:
//   1. a spawn writes a `pending` row, and a completion re-writes it away
//   2. a `pending` row that survives a restart settles to `interrupted`, exactly once
//
// Same temp-home trick as history-encryption.test.ts: paths.ts captures os.homedir()
// at eval time, so the temp home must exist and homedir() must already return it
// BEFORE history.ts (→ paths.ts) is first imported.
const HOME = mkdtempSync(join(tmpdir(), 'mm-history-pending-'))
mkdirSync(join(HOME, CONFIG.APP_NAME, 'backups'), { recursive: true })

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => HOME }
})

// Encryption off + incognito off for these tests: this file is about the run
// lifecycle, not the cipher (history-encryption.test.ts owns that).
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

const HISTORY_PATH = join(HOME, CONFIG.APP_NAME, 'rewrite-history.jsonl')

type HistoryModule = typeof import('../history')

/** Fresh module (and so a fresh warm cache) over the given on-disk rows. */
async function loadHistory(lines: string[] = []): Promise<HistoryModule> {
  writeFileSync(HISTORY_PATH, lines.length ? lines.join('\n') + '\n' : '', 'utf-8')
  vi.resetModules()
  return import('../history')
}

/** A minimal row; `over` supplies whatever the assertion under test cares about. */
function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    run_id: 'run-1',
    ts: '2026-07-16T08:00:00Z',
    duration_s: 0,
    instruction: 'do the thing',
    mode: 'act',
    selection: '',
    selection_chars: 0,
    ok: true,
    backend: 'claude',
    model: 'sonnet',
    ctx_attached: false,
    ...over
  }
}

function readRows(): Record<string, unknown>[] {
  const { readFileSync } = require('node:fs') as typeof import('node:fs')
  return readFileSync(HISTORY_PATH, 'utf-8')
    .split('\n')
    .filter((l: string) => l.trim() !== '')
    .map((l: string) => JSON.parse(l))
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('appendPending', () => {
  it('writes a pending row that is NOT marked ok', async () => {
    const { HISTORY } = await loadHistory()
    HISTORY.appendPending(row() as never)

    const rows = readRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].run_state).toBe('pending')
    // An unsettled run is not a success. If we never hear back, this is the truth
    // that stays frozen on disk.
    expect(rows[0].ok).toBe(false)
  })

  it('is hidden by the run completing — latest-wins on the same run_id', async () => {
    const { HISTORY } = await loadHistory()
    HISTORY.appendPending(row({ run_id: 'r1' }) as never)
    // The completion path re-writes the same run_id with no run_state.
    HISTORY.append(row({ run_id: 'r1', ok: true, result: 'done' }) as never)

    // Both rows are on disk (append-only)...
    expect(readRows()).toHaveLength(2)
    // ...but a reader sees ONE run, settled. A normal run looks exactly as it did
    // before pending rows existed — that's the compatibility contract.
    const recent = HISTORY.readRecent()
    expect(recent).toHaveLength(1)
    expect(recent[0].ok).toBe(true)
    expect(recent[0].result).toBe('done')
  })
})

describe('reconcilePendingRuns', () => {
  it('settles a pending row left by a dead session to interrupted', async () => {
    // A row from a previous app session that never got to finish.
    const { HISTORY } = await loadHistory([
      JSON.stringify(row({ run_id: 'r1', ok: false, run_state: 'pending' }))
    ])

    expect(HISTORY.reconcilePendingRuns()).toBe(1)

    const recent = HISTORY.readRecent()
    expect(recent).toHaveLength(1)
    expect(recent[0].ok).toBe(false)
    // The work is gone; the evidence it ran is not. That's the whole ship gate.
    expect(readRows().at(-1)?.run_state).toBe('interrupted')
    // The instruction survives, so the user can see WHAT was cut off.
    expect(recent[0].instruction).toBe('do the thing')
  })

  it('leaves a run that DID settle before the quit alone', async () => {
    // pending followed by its own completion — the app died later, after this run
    // finished. Dragging it back to interrupted would be a lie.
    const { HISTORY } = await loadHistory([
      JSON.stringify(row({ run_id: 'r1', ok: false, run_state: 'pending' })),
      JSON.stringify(row({ run_id: 'r1', ok: true, result: 'done' }))
    ])

    expect(HISTORY.reconcilePendingRuns()).toBe(0)
    expect(HISTORY.readRecent()[0].ok).toBe(true)
  })

  it('is idempotent — a second launch settles nothing new', async () => {
    const { HISTORY } = await loadHistory([
      JSON.stringify(row({ run_id: 'r1', ok: false, run_state: 'pending' }))
    ])

    expect(HISTORY.reconcilePendingRuns()).toBe(1)
    // Without this, every launch would append another interrupted row forever.
    expect(HISTORY.reconcilePendingRuns()).toBe(0)
  })

  it('settles each stuck run once, across several', async () => {
    const { HISTORY } = await loadHistory([
      JSON.stringify(row({ run_id: 'r1', ok: false, run_state: 'pending' })),
      JSON.stringify(row({ run_id: 'r2', ok: false, run_state: 'pending' })),
      JSON.stringify(row({ run_id: 'r3', ok: true }))
    ])

    expect(HISTORY.reconcilePendingRuns()).toBe(2)
    expect(HISTORY.readRecent().every((r) => r.ok === false || r.run_id === 'r3')).toBe(true)
  })

  it('does nothing when nothing is pending', async () => {
    const { HISTORY } = await loadHistory([JSON.stringify(row({ ok: true }))])
    expect(HISTORY.reconcilePendingRuns()).toBe(0)
  })

  it('treats a legacy row with no run_state as settled', async () => {
    // Every row written before this feature has no run_state. They must not be
    // dragged into the new lifecycle.
    const { HISTORY } = await loadHistory([JSON.stringify(row({ ok: true, run_state: undefined }))])
    expect(HISTORY.reconcilePendingRuns()).toBe(0)
  })
})
