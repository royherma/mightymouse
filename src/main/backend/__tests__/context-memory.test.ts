/**
 * Tests for context-memory.ts
 *
 * Covers:
 *   1. Budget truncation — blob never exceeds MEMORY_CHAR_BUDGET
 *   2. Opt-out path — ambient disabled produces history-only blob (or empty)
 *   3. Redaction respected — raw text from context events is never dumped verbatim
 *   4. Empty-source path — no history + ambient off = empty string (no regression)
 *   5. assembleHistoryMemory — same-mode preference, cross-mode fallback
 *   6. buildMemoryBlob delimiter — always starts with "## Recent context" when non-empty
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { buildMemoryBlob, assembleAmbientContext, assembleHistoryMemory, assembleFeedbackMemory, MEMORY_CHAR_BUDGET } from '../context-memory'

// ── Module mocks ──────────────────────────────────────────────────────────────

// Mock the fs module so tests don't touch the real filesystem
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => ''),
    readdirSync: vi.fn(() => [])
  }
})

// Mock PREFS so we control the ambient-context + feedback toggles
vi.mock('../../store/prefs', () => ({
  PREFS: {
    getContextLog: vi.fn(() => false),
    getFeedbackEnabled: vi.fn(() => true)
  }
}))

// Mock PATHS so the module can be imported without a real filesystem
vi.mock('../../store/paths', () => ({
  PATHS: {
    CONTEXT_LOG_DIR: '/fake/context-log',
    HISTORY: '/fake/rewrite-history.jsonl'
  }
}))

// Mock HISTORY so we control what readRecent / readAllEntries return
vi.mock('../../store/history', () => ({
  HISTORY: {
    readRecent: vi.fn(() => []),
    readAllEntries: vi.fn(() => [])
  }
}))

// Mock FEEDBACK so we control the notes (corrections + praises + capture notes)
// folded into the prompt
vi.mock('../../store/feedback', () => ({
  FEEDBACK: {
    recentCorrections: vi.fn(() => []),
    recentPraises: vi.fn(() => []),
    recentNotes: vi.fn(() => [])
  }
}))

import { existsSync, readFileSync } from 'fs'
import { PREFS } from '../../store/prefs'
import { HISTORY } from '../../store/history'
import { FEEDBACK } from '../../store/feedback'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeContextEvent(
  type: 'focus' | 'text',
  app: string,
  opts: { title?: string; url?: string; text?: string; offsetMs?: number } = {}
): string {
  const ts = new Date(Date.now() - (opts.offsetMs ?? 0)).toISOString()
  const ev: Record<string, unknown> = { ts, type, app }
  if (opts.title) ev.title = opts.title
  if (opts.url) ev.url = opts.url
  if (opts.text) ev.text = opts.text
  return JSON.stringify(ev)
}

function makeHistoryItem(
  instruction: string,
  mode: 'rewrite' | 'ask' | 'act' = 'rewrite',
  opts: { ok?: boolean; result?: string } = {}
) {
  return {
    run_id: `r-${Math.random().toString(36).slice(2)}`,
    instruction,
    mode,
    ts: new Date().toISOString(),
    backend: 'claude',
    selection_preview: '',
    ok: opts.ok !== false,
    result: opts.result
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('buildMemoryBlob', () => {
  beforeEach(() => {
    vi.mocked(existsSync).mockReturnValue(false)
    vi.mocked(readFileSync).mockReturnValue('')
    vi.mocked(PREFS.getContextLog).mockReturnValue(false)
    vi.mocked(PREFS.getFeedbackEnabled).mockReturnValue(true)
    vi.mocked(HISTORY.readRecent).mockReturnValue([])
    vi.mocked(HISTORY.readAllEntries).mockReturnValue([])
    vi.mocked(FEEDBACK.recentCorrections).mockReturnValue([])
    vi.mocked(FEEDBACK.recentPraises).mockReturnValue([])
    vi.mocked(FEEDBACK.recentNotes).mockReturnValue([])
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('returns empty string when ambient is off and no history', () => {
    vi.mocked(PREFS.getContextLog).mockReturnValue(false)
    vi.mocked(HISTORY.readRecent).mockReturnValue([])
    const result = buildMemoryBlob({ mode: 'rewrite' })
    expect(result).toBe('')
  })

  it('returns empty string when ambientEnabled=false override and no history', () => {
    vi.mocked(HISTORY.readRecent).mockReturnValue([])
    const result = buildMemoryBlob({ mode: 'ask', ambientEnabled: false })
    expect(result).toBe('')
  })

  it('returns history-only blob when ambient is off but history exists', () => {
    vi.mocked(PREFS.getContextLog).mockReturnValue(false)
    vi.mocked(HISTORY.readRecent).mockReturnValue([
      makeHistoryItem('make it shorter', 'rewrite', { result: 'It is now shorter.' })
    ])
    const result = buildMemoryBlob({ mode: 'rewrite' })
    expect(result).not.toBe('')
    expect(result).toContain('## Recent context')
    expect(result).toContain('make it shorter')
    // Ambient section must NOT appear
    expect(result).not.toContain('Recent activity')
  })

  it('starts with "## Recent context" delimiter when non-empty', () => {
    vi.mocked(HISTORY.readRecent).mockReturnValue([
      makeHistoryItem('explain this', 'ask')
    ])
    const result = buildMemoryBlob({ mode: 'ask' })
    expect(result.startsWith('## Recent context')).toBe(true)
  })

  it('never exceeds MEMORY_CHAR_BUDGET', () => {
    // Create a massive history (many long instructions) to force budget truncation
    const bigHistory = Array.from({ length: 30 }, (_, i) =>
      makeHistoryItem(
        `instruction-${i}: ${'x'.repeat(120)}`,
        'rewrite',
        { result: 'y'.repeat(120) }
      )
    )
    vi.mocked(HISTORY.readRecent).mockReturnValue(bigHistory)
    const result = buildMemoryBlob({ mode: 'rewrite', ambientEnabled: false })
    expect(result.length).toBeLessThanOrEqual(MEMORY_CHAR_BUDGET)
  })

  it('appends truncation marker when budget is exceeded', () => {
    // Force budget overflow by generating an ambient section with 5 unique apps,
    // each with very long window titles and unique URLs, plus full history items.
    // The ambient section alone at max (5 apps × 3 lines × ~100 chars) = ~1500.
    // Combined with history section, the raw blob > MEMORY_CHAR_BUDGET.
    vi.mocked(existsSync).mockReturnValue(true)
    vi.mocked(PREFS.getContextLog).mockReturnValue(true)

    // 5 unique apps with maximally long titles (each title is 80 chars, triggering truncation)
    // + URLs + text snippets — each app segment is ~280 chars
    // 5 segments × 280 chars = 1400 chars for ambient alone, + header + history = over 1500
    const recentEvents = [
      // 5 unique apps, each with focus + text events
      ...Array.from({ length: 5 }, (_, i) => [
        makeContextEvent('focus', `ApplicationName${i}`, {
          title: `A Very Long Window Title That Helps Us Test The Budget Limit ${i}`.slice(0, 79),
          url: `https://hostname-with-a-fairly-long-name-${i}.example.com/path/to/resource`,
          offsetMs: i * 5000
        }),
        makeContextEvent('text', `ApplicationName${i}`, {
          text: `Some redacted text the user was typing in this application number ${i}`.slice(0, 59),
          offsetMs: i * 5000 + 1000
        })
      ]).flat()
    ].join('\n')
    vi.mocked(readFileSync).mockReturnValue(recentEvents)

    // Also add history items
    vi.mocked(HISTORY.readRecent).mockReturnValue(
      Array.from({ length: 4 }, () =>
        makeHistoryItem('x'.repeat(80), 'rewrite', { result: 'y'.repeat(60) })
      )
    )

    const result = buildMemoryBlob({ mode: 'rewrite' })
    // Budget must always be respected
    expect(result.length).toBeLessThanOrEqual(MEMORY_CHAR_BUDGET)
    // If total raw content exceeded budget, the truncation marker must appear
    // (We know it does here because 5 apps × ~280 chars + history > 1500)
    expect(result).toContain('memory truncated')
  })

  it('ambient section absent when ambientEnabled=false override', () => {
    vi.mocked(HISTORY.readRecent).mockReturnValue([
      makeHistoryItem('test instruction', 'rewrite')
    ])
    const result = buildMemoryBlob({ mode: 'rewrite', ambientEnabled: false })
    expect(result).not.toContain('Recent activity')
    expect(result).toContain('Past instructions')
  })
})

describe('assembleAmbientContext', () => {
  beforeEach(() => {
    vi.mocked(existsSync).mockReturnValue(false)
    vi.mocked(readFileSync).mockReturnValue('')
    vi.mocked(PREFS.getContextLog).mockReturnValue(false)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('returns empty string when context log is disabled', () => {
    vi.mocked(PREFS.getContextLog).mockReturnValue(false)
    expect(assembleAmbientContext()).toBe('')
  })

  it('returns empty string when context log dir does not exist', () => {
    vi.mocked(PREFS.getContextLog).mockReturnValue(true)
    vi.mocked(existsSync).mockReturnValue(false)
    expect(assembleAmbientContext()).toBe('')
  })

  it('returns empty string when log files have no recent events', () => {
    vi.mocked(PREFS.getContextLog).mockReturnValue(true)
    vi.mocked(existsSync).mockImplementation((p) => typeof p === 'string' && p.includes('context-log'))
    // All events are from 2 hours ago (outside 20-min window)
    const oldEvent = makeContextEvent('focus', 'Safari', { title: 'Google', url: 'https://google.com', offsetMs: 2 * 60 * 60 * 1000 })
    vi.mocked(readFileSync).mockReturnValue(oldEvent)
    expect(assembleAmbientContext()).toBe('')
  })

  it('includes app name from recent focus events', () => {
    vi.mocked(PREFS.getContextLog).mockReturnValue(true)
    vi.mocked(existsSync).mockImplementation((p) => typeof p === 'string' && p.includes('context-log'))
    const recentEvent = makeContextEvent('focus', 'Notion', {
      title: 'My Project Notes',
      url: 'https://www.notion.so/page',
      offsetMs: 60000 // 1 minute ago
    })
    vi.mocked(readFileSync).mockReturnValue(recentEvent)
    const result = assembleAmbientContext()
    expect(result).toContain('Notion')
  })

  it('never exposes raw text verbatim — only a short redacted snippet', () => {
    vi.mocked(PREFS.getContextLog).mockReturnValue(true)
    vi.mocked(existsSync).mockImplementation((p) => typeof p === 'string' && p.includes('context-log'))

    // A text event with already-redacted content (redaction happens in context-logger, not here)
    const textEvent = makeContextEvent('text', 'Chrome', {
      text: 'Authorization: Bearer [token] some other stuff that goes very long beyond snippet limit yes',
      offsetMs: 30000 // 30s ago
    })
    vi.mocked(readFileSync).mockReturnValue(textEvent)
    const result = assembleAmbientContext()

    // The raw event text (which is already redacted by logger) may appear as a snippet,
    // but it must be capped at 60 chars per snippet, not dumped in full
    const lines = result.split('\n')
    for (const line of lines) {
      if (line.includes('was writing')) {
        // The snippet in the line should not contain the full long text
        const snippetMatch = line.match(/"([^"]+)"/)
        if (snippetMatch) {
          expect(snippetMatch[1].length).toBeLessThanOrEqual(61) // 60 + possible ellipsis char
        }
      }
    }
  })

  it('skips junk URLs (chrome://, about:, data:)', () => {
    vi.mocked(PREFS.getContextLog).mockReturnValue(true)
    vi.mocked(existsSync).mockImplementation((p) => typeof p === 'string' && p.includes('context-log'))

    const junkUrlEvent = makeContextEvent('focus', 'Chrome', {
      url: 'chrome://newtab/',
      offsetMs: 10000
    })
    vi.mocked(readFileSync).mockReturnValue(junkUrlEvent)
    const result = assembleAmbientContext()
    // Should not contain the chrome:// URL at all
    expect(result).not.toContain('chrome://newtab')
  })
})

describe('assembleHistoryMemory', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('returns empty string when no history', () => {
    vi.mocked(HISTORY.readRecent).mockReturnValue([])
    expect(assembleHistoryMemory('rewrite')).toBe('')
  })

  it('prefers same-mode entries', () => {
    vi.mocked(HISTORY.readRecent).mockReturnValue([
      makeHistoryItem('ask question A', 'ask'),
      makeHistoryItem('rewrite B', 'rewrite', { result: 'B rewritten' }),
      makeHistoryItem('rewrite C', 'rewrite', { result: 'C rewritten' })
    ])
    const result = assembleHistoryMemory('rewrite')
    // rewrite items should appear first
    const rewriteIdx = result.indexOf('rewrite B')
    const askIdx = result.indexOf('ask question A')
    expect(rewriteIdx).toBeGreaterThanOrEqual(0)
    // ask item is cross-mode — may or may not appear, but rewrite comes first
    if (askIdx !== -1) {
      expect(rewriteIdx).toBeLessThan(askIdx)
    }
  })

  it('includes result snippet for rewrite mode', () => {
    vi.mocked(HISTORY.readRecent).mockReturnValue([
      makeHistoryItem('make it shorter', 'rewrite', { result: 'Short version here.' })
    ])
    const result = assembleHistoryMemory('rewrite')
    expect(result).toContain('Short version here.')
  })

  it('does not include result snippet for ask mode items', () => {
    vi.mocked(HISTORY.readRecent).mockReturnValue([
      makeHistoryItem('explain this', 'ask', { result: 'This is the answer: blah blah blah.' })
    ])
    const result = assembleHistoryMemory('ask')
    // ask mode items don't get result snippets (too verbose)
    expect(result).not.toContain('This is the answer')
  })

  it('excludes failed runs', () => {
    vi.mocked(HISTORY.readRecent).mockReturnValue([
      makeHistoryItem('failed instruction', 'rewrite', { ok: false }),
      makeHistoryItem('good instruction', 'rewrite', { ok: true })
    ])
    const result = assembleHistoryMemory('rewrite')
    expect(result).toContain('good instruction')
    expect(result).not.toContain('failed instruction')
  })

  it('tags cross-mode items with mode label', () => {
    vi.mocked(HISTORY.readRecent).mockReturnValue([
      makeHistoryItem('convert this file', 'act'),
      makeHistoryItem('make it shorter', 'rewrite')
    ])
    // When asking for 'ask' mode, both are cross-mode
    const result = assembleHistoryMemory('ask')
    // Cross-mode items should be tagged
    expect(result).toMatch(/\(rewrite\)|\(act\)/)
  })
})

describe('assembleFeedbackMemory', () => {
  beforeEach(() => {
    vi.mocked(PREFS.getFeedbackEnabled).mockReturnValue(true)
    vi.mocked(HISTORY.readAllEntries).mockReturnValue([])
    vi.mocked(FEEDBACK.recentCorrections).mockReturnValue([])
    vi.mocked(FEEDBACK.recentPraises).mockReturnValue([])
    vi.mocked(FEEDBACK.recentNotes).mockReturnValue([])
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  function makeCorrection(run_id: string, note: string) {
    return { run_id, rating: 'down' as const, note, ts: new Date().toISOString() }
  }

  function makePraise(run_id: string, note: string) {
    return { run_id, rating: 'up' as const, note, ts: new Date().toISOString() }
  }

  function makeNote(run_id: string, note: string) {
    return { run_id, rating: null, note, ts: new Date().toISOString() }
  }

  it('returns empty string when feedback is disabled', () => {
    vi.mocked(PREFS.getFeedbackEnabled).mockReturnValue(false)
    vi.mocked(FEEDBACK.recentCorrections).mockReturnValue([makeCorrection('r1', 'wanted bullets')])
    expect(assembleFeedbackMemory()).toBe('')
  })

  it('returns empty string when there are no notes on either side', () => {
    vi.mocked(FEEDBACK.recentCorrections).mockReturnValue([])
    vi.mocked(FEEDBACK.recentPraises).mockReturnValue([])
    vi.mocked(FEEDBACK.recentNotes).mockReturnValue([])
    expect(assembleFeedbackMemory()).toBe('')
  })

  it('folds a 👍 note into a "they liked" line', () => {
    vi.mocked(FEEDBACK.recentPraises).mockReturnValue([makePraise('r1', 'kept the warm tone')])
    const result = assembleFeedbackMemory()
    expect(result).toContain('they liked: kept the warm tone')
  })

  it('surfaces praises even when there are no corrections', () => {
    vi.mocked(FEEDBACK.recentCorrections).mockReturnValue([])
    vi.mocked(FEEDBACK.recentPraises).mockReturnValue([makePraise('r1', 'perfect length')])
    expect(assembleFeedbackMemory()).toContain('they liked: perfect length')
  })

  it('lists corrections before praises', () => {
    vi.mocked(FEEDBACK.recentCorrections).mockReturnValue([makeCorrection('r1', 'too long')])
    vi.mocked(FEEDBACK.recentPraises).mockReturnValue([makePraise('r2', 'nailed the tone')])
    const result = assembleFeedbackMemory()
    expect(result.indexOf('they wanted: too long')).toBeLessThan(result.indexOf('they liked: nailed the tone'))
  })

  it('folds the note into a "they wanted" line', () => {
    vi.mocked(FEEDBACK.recentCorrections).mockReturnValue([makeCorrection('r1', 'cut it to one line')])
    const result = assembleFeedbackMemory()
    expect(result).toContain('they wanted: cut it to one line')
  })

  it('names the instruction the note corrected when history has the run', () => {
    vi.mocked(FEEDBACK.recentCorrections).mockReturnValue([makeCorrection('r1', 'use bullet points')])
    vi.mocked(HISTORY.readAllEntries).mockReturnValue([
      { ...makeHistoryItem('summarize this email', 'rewrite'), run_id: 'r1' }
    ] as never)
    const result = assembleFeedbackMemory()
    expect(result).toContain('summarize this email')
    expect(result).toContain('use bullet points')
  })

  it('still surfaces the note when the run is missing from history', () => {
    vi.mocked(FEEDBACK.recentCorrections).mockReturnValue([makeCorrection('orphan', 'be more concise')])
    vi.mocked(HISTORY.readAllEntries).mockReturnValue([])
    const result = assembleFeedbackMemory()
    expect(result).toContain('they wanted: be more concise')
    // No instruction prefix when the run isn't found
    expect(result).not.toContain('for "')
  })

  it('folds a note-only capture note into a "they noted" line', () => {
    vi.mocked(FEEDBACK.recentNotes).mockReturnValue([makeNote('cap1', 'debugging this crash')] as never)
    const result = assembleFeedbackMemory()
    expect(result).toContain('they noted: debugging this crash')
  })

  it('lists capture notes after corrections and praises', () => {
    vi.mocked(FEEDBACK.recentCorrections).mockReturnValue([makeCorrection('r1', 'too long')])
    vi.mocked(FEEDBACK.recentPraises).mockReturnValue([makePraise('r2', 'great tone')])
    vi.mocked(FEEDBACK.recentNotes).mockReturnValue([makeNote('cap1', 'saving for later')] as never)
    const result = assembleFeedbackMemory()
    expect(result.indexOf('they liked: great tone')).toBeLessThan(result.indexOf('they noted: saving for later'))
  })

  it('feeds feedback into buildMemoryBlob as a leading section', () => {
    vi.mocked(FEEDBACK.recentCorrections).mockReturnValue([makeCorrection('r1', 'shorter please')])
    const result = buildMemoryBlob({ mode: 'rewrite', ambientEnabled: false })
    expect(result).toContain('shorter please')
    expect(result).toContain('## Recent context')
  })
})
