/**
 * Continue-from-history, one case per row shape that actually exists on disk.
 *
 * Written after a fix that typechecked, passed 1624 tests, and still opened an empty
 * chat — because nothing covered the click path. The row shapes below were counted in
 * a real ~/MightyMouse/rewrite-history.jsonl: capture rows carry session_id, ask/act
 * rows didn't until recently, and older rows carry neither.
 */

import { describe, expect, it, vi } from 'vitest'
import type { HistoryEntry } from '../../../shared/types'
import { resolveSessionId, resumableTurns, resumeTarget } from '../resume-target'

/** A history row with only the fields these rules read. */
function row(over: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    run_id: 'run-1',
    ts: '2026-07-29T00:00:00.000Z',
    mode: 'ask',
    instruction: 'what is a monad',
    ...over
  } as HistoryEntry
}

/** Stands in for MIGHTY.findSessionIdByRunId with a fixed run→session map. */
function finder(map: Record<string, string> = {}) {
  return vi.fn((runId: string) => map[runId] ?? null)
}

describe('resumableTurns', () => {
  it('uses the row thread when it has one', () => {
    const turns = [
      { q: 'a', a: 'b' },
      { q: 'c', a: 'd' }
    ]
    expect(resumableTurns(row({ turns }))).toEqual(turns)
  })

  it('copies the thread instead of aliasing it', () => {
    // The IPC mutates what it gets back (panelState.history); handing out the stored
    // array would edit the history row in place.
    const turns = [{ q: 'a', a: 'b' }]
    const out = resumableTurns(row({ turns }))
    out.push({ q: 'x', a: 'y' })
    expect(turns).toHaveLength(1)
  })

  it('synthesizes one turn from a result-only row', () => {
    // Rewrite/act rows never carry `turns` — this is what makes them continuable.
    expect(resumableTurns(row({ mode: 'rewrite', result: 'the answer' }))).toEqual([
      { q: 'what is a monad', a: 'the answer' }
    ])
  })

  it('turns a listen transcript into the first message', () => {
    // Roy's "Start a convo". On a real listen row the transcript lands in BOTH
    // instruction and result (checked against rewrite-history.jsonl), so the
    // synthesized turn is the transcript asked and answered — one message to open on.
    const transcript = 'buy milk on the way home'
    const listen = row({
      mode: 'listen',
      capture_kind: 'listen',
      instruction: transcript,
      result: transcript
    })
    expect(resumableTurns(listen)).toEqual([{ q: transcript, a: transcript }])
  })

  it('a transcript that never landed leaves nothing to open', () => {
    // A failed transcription writes the row with no result. Resuming it must report
    // "nothing here", not open a blank chat — the symptom this whole fix is about.
    expect(resumableTurns(row({ mode: 'listen', capture_kind: 'listen', result: '' }))).toEqual([])
  })

  it('is empty for a row with neither turns nor result', () => {
    // A failed or still-running row — the IPC must answer ok:false, not crash.
    expect(resumableTurns(row())).toEqual([])
    expect(resumableTurns(row({ turns: [], result: '' }))).toEqual([])
  })
})

describe('resolveSessionId', () => {
  it('prefers the row session_id (capture rows, and ask/act rows since the fix)', () => {
    const find = finder({ 'run-1': 'sess-from-scan' })
    expect(resolveSessionId(row({ session_id: 'sess-on-row' }), find)).toBe('sess-on-row')
    // The cheap answer means we never pay for the scan.
    expect(find).not.toHaveBeenCalled()
  })

  it('falls back to the turn-level run_id stamp when the row has none', () => {
    // The pre-fix ask/act rows: nothing on the row, but the turn was stamped.
    expect(resolveSessionId(row(), finder({ 'run-1': 'sess-42' }))).toBe('sess-42')
  })

  it('is null for a legacy row that matches nothing', () => {
    // The majority of Roy's existing rows. Callers must seed a transient thread —
    // this is the case that has to NOT look like a session id.
    expect(resolveSessionId(row(), finder())).toBeNull()
  })

  it('does not scan when the row has no run_id', () => {
    const find = finder({ '': 'sess-wrong' })
    expect(resolveSessionId(row({ run_id: '' }), find)).toBeNull()
    expect(find).not.toHaveBeenCalled()
  })

  it('treats an empty session_id as absent, not as an answer', () => {
    expect(resolveSessionId(row({ session_id: '' }), finder({ 'run-1': 'sess-9' }))).toBe('sess-9')
  })
})

describe('resumeTarget — the shapes on disk', () => {
  it('capture:listen row → transcript turn + its recorded session', () => {
    const target = resumeTarget(
      row({
        mode: 'listen',
        capture_kind: 'listen',
        instruction: 'remind me to call the bank',
        result: 'remind me to call the bank',
        session_id: 'sess-listen'
      }),
      finder()
    )
    expect(target.sessionId).toBe('sess-listen')
    expect(target.turns).toHaveLength(1)
  })

  it('new ask row → its thread + the session hud-run recorded', () => {
    const target = resumeTarget(
      row({ turns: [{ q: 'hi', a: 'hello' }], session_id: 'sess-ask' }),
      finder()
    )
    expect(target).toEqual({ turns: [{ q: 'hi', a: 'hello' }], sessionId: 'sess-ask' })
  })

  it('act row with a result but no thread → one synthesized turn', () => {
    const target = resumeTarget(
      row({ mode: 'act', result: 'renamed 4 files', session_id: 'sess-act' }),
      finder()
    )
    expect(target.turns).toEqual([{ q: 'what is a monad', a: 'renamed 4 files' }])
    expect(target.sessionId).toBe('sess-act')
  })

  it('legacy row → resumable turns, but nothing to open', () => {
    // The row still continues as a transient thread; it just can't reopen a session.
    const target = resumeTarget(row({ result: 'old answer' }), finder())
    expect(target.turns).toHaveLength(1)
    expect(target.sessionId).toBeNull()
  })

  it('empty row → nothing to resume and nothing to open', () => {
    expect(resumeTarget(row(), finder())).toEqual({ turns: [], sessionId: null })
  })
})
