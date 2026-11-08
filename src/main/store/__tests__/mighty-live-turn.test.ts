import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG } from '../../../shared/config'
import type { MightyTurn } from '../../../shared/types'

// Same pattern as mighty-artifacts.test.ts: PATHS derives every path from os.homedir()
// at module-eval time, so the temp home must exist and the mock must be active BEFORE
// mighty.ts (→ paths.ts) is first imported.
const HOME = mkdtempSync(join(tmpdir(), 'mm-live-turn-'))
mkdirSync(join(HOME, CONFIG.APP_NAME, 'mighty'), { recursive: true })

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => HOME }
})

// File-scope, not per-describe: a describe-local afterAll would delete HOME out from
// under the blocks that follow it, and every store call would then fail on ENOENT.
afterAll(() => rmSync(HOME, { recursive: true, force: true }))

let MIGHTY: typeof import('../mighty').MIGHTY
let sessionsPath: string

const RUN = 'run_abc'
const ask = (q: string): MightyTurn => ({
  source: 'chat',
  q,
  a: '',
  ts: '2026-07-17T01:00:00Z',
  ok: true,
  backend: 'ollama'
})

// The bug this whole path exists to prevent: a run in flight used to leave the store
// holding a session with a title and ZERO turns, so expanding the panel mid-answer
// opened Mighty on an empty "New conversation" next to a sidebar row showing the real
// title. startTurn makes the question durable at run start; resolveTurn fills the same
// row in place (never appends a second one) and clears the running mark.
describe('MIGHTY.startTurn / resolveTurn', () => {
  beforeAll(async () => {
    MIGHTY = (await import('../mighty')).MIGHTY
    sessionsPath = (await import('../paths')).PATHS.MIGHTY_SESSIONS
  })

  beforeEach(() => rmSync(sessionsPath, { force: true }))

  it('makes the question visible before any answer exists', () => {
    const id = MIGHTY.startTurn(undefined, ask('is this model local?'), RUN)
    const s = MIGHTY.getSession(id)!

    // The empty-pane bug, asserted directly: turns must NOT be empty mid-run.
    expect(s.turns).toHaveLength(1)
    expect(s.turns[0].q).toBe('is this model local?')
    expect(s.turns[0].a).toBe('')
    expect(s.title).toBe('is this model local?')
    expect(s.runId).toBe(RUN)
  })

  it('resolves in place — one turn, not two, and the run mark clears', () => {
    const id = MIGHTY.startTurn(undefined, ask('q1'), RUN)
    expect(MIGHTY.resolveTurn(id, RUN, { a: 'the answer', ok: true })).toBe(true)

    const s = MIGHTY.getSession(id)!
    // Ship gate 2: a started+resolved turn appearing twice is the main regression risk.
    expect(s.turns).toHaveLength(1)
    expect(s.turns[0].q).toBe('q1')
    expect(s.turns[0].a).toBe('the answer')
    expect(s.runId).toBeUndefined()
  })

  it('appends to the bound session on a follow-up instead of forking a new one', () => {
    const id = MIGHTY.startTurn(undefined, ask('q1'), RUN)
    MIGHTY.resolveTurn(id, RUN, { a: 'a1', ok: true })
    const same = MIGHTY.startTurn(id, ask('q2'), 'run_2')
    MIGHTY.resolveTurn(same, 'run_2', { a: 'a2', ok: true })

    expect(same).toBe(id)
    expect(MIGHTY.listSessions()).toHaveLength(1)
    expect(MIGHTY.getSession(id)!.turns.map((t) => t.a)).toEqual(['a1', 'a2'])
  })

  it('resolves an aborted/failed run too, so the bubble can never hang forever', () => {
    const id = MIGHTY.startTurn(undefined, ask('q1'), RUN)
    MIGHTY.resolveTurn(id, RUN, { a: 'Error: stopped', ok: false })

    const s = MIGHTY.getSession(id)!
    expect(s.runId).toBeUndefined()
    expect(s.turns[0].ok).toBe(false)
    expect(s.turns[0].a).toBe('Error: stopped')
  })

  it('ignores a late resolve from a superseded run', () => {
    const id = MIGHTY.startTurn(undefined, ask('q1'), RUN)
    MIGHTY.resolveTurn(id, RUN, { a: 'real answer', ok: true })

    // A zombie run reporting in after the session moved on must not clobber the answer.
    expect(MIGHTY.resolveTurn(id, 'run_stale', { a: 'stale', ok: true })).toBe(false)
    expect(MIGHTY.getSession(id)!.turns[0].a).toBe('real answer')
  })

  it('no-ops on an unknown session instead of throwing', () => {
    expect(MIGHTY.resolveTurn('nope', RUN, { a: 'x', ok: true })).toBe(false)
  })

  it('keeps a mid-run session listed (its title and turns agree)', () => {
    const id = MIGHTY.startTurn(undefined, ask('mid-run q'), RUN)
    const listed = MIGHTY.listSessions().find((s) => s.id === id)

    // listSessions filters blank leftovers (no turns AND no title). A live run has both,
    // so the sidebar row and the chat pane now show the same thing.
    expect(listed).toBeDefined()
    expect(listed!.turns).toHaveLength(1)
  })

  // Sending a parked listen transcript. Before this, startTurn pushed unconditionally,
  // so the transcript appeared twice: once orphaned with no answer, once with the reply.
  it('claims a parked unsent turn instead of appending a twin', () => {
    const transcript = 'remind me to call the bank'
    const id = MIGHTY.appendTurn(undefined, { ...ask(transcript), source: 'listen' })
    expect(MIGHTY.getSession(id)!.turns).toHaveLength(1)

    MIGHTY.startTurn(id, ask(transcript), RUN)

    const s = MIGHTY.getSession(id)!
    expect(s.turns).toHaveLength(1)
    expect(s.turns[0].run_id).toBe(RUN)
    // And it still resolves normally, into that same row.
    MIGHTY.resolveTurn(id, RUN, { a: 'Added.', ok: true })
    expect(MIGHTY.getSession(id)!.turns).toHaveLength(1)
    expect(MIGHTY.getSession(id)!.turns[0].a).toBe('Added.')
  })

  it('appends when the question differs from the parked one', () => {
    const id = MIGHTY.appendTurn(undefined, { ...ask('the transcript'), source: 'listen' })
    MIGHTY.startTurn(id, ask('something else entirely'), RUN)
    expect(MIGHTY.getSession(id)!.turns).toHaveLength(2)
  })

  it('never claims a turn that already belongs to a run', () => {
    // A still-running turn has the same empty-answer shape. Overwriting it would
    // destroy the in-flight question and detach its run.
    const id = MIGHTY.startTurn(undefined, ask('first q'), RUN)
    MIGHTY.startTurn(id, ask('first q'), 'run_2')
    const s = MIGHTY.getSession(id)!
    expect(s.turns).toHaveLength(2)
    expect(s.turns[0].run_id).toBe(RUN)
    expect(s.turns[1].run_id).toBe('run_2')
  })
})

// History rows key off run ids; sessions key off session ids. The session's own
// `runId` is only a "this run is live" mark — resolveTurn deletes it — so it could
// never answer "which session owns this FINISHED run?". That gap is why History's
// Continue opened a blank "New conversation" for every settled row: the only rows it
// could resolve were ones still in flight. findSessionIdByRunId closes it by matching
// the durable turn-level run_id instead.
describe('MIGHTY.findSessionIdByRunId', () => {
  beforeEach(() => rmSync(sessionsPath, { force: true }))

  it('finds the session of a FINISHED run — the case that used to open a blank chat', () => {
    const id = MIGHTY.startTurn(undefined, ask('q1'), RUN)
    MIGHTY.resolveTurn(id, RUN, { a: 'a1', ok: true })

    // The regression guard: session.runId is gone by now, so this must NOT depend on it.
    expect(MIGHTY.getSession(id)!.runId).toBeUndefined()
    expect(MIGHTY.findSessionIdByRunId(RUN)).toBe(id)
  })

  it('finds a run mid-flight too', () => {
    const id = MIGHTY.startTurn(undefined, ask('q1'), RUN)
    expect(MIGHTY.findSessionIdByRunId(RUN)).toBe(id)
  })

  it('picks the session holding the run, not merely the newest one', () => {
    const first = MIGHTY.startTurn(undefined, ask('q1'), RUN)
    MIGHTY.resolveTurn(first, RUN, { a: 'a1', ok: true })
    const second = MIGHTY.startTurn(undefined, ask('q2'), 'run_2')
    MIGHTY.resolveTurn(second, 'run_2', { a: 'a2', ok: true })

    expect(second).not.toBe(first)
    // listSessions is newest-first, so a naive "return the first match" would answer
    // `second` here — continuing an old row would silently land in a newer chat.
    expect(MIGHTY.findSessionIdByRunId(RUN)).toBe(first)
  })

  it('finds a run on a later turn, not just the first', () => {
    const id = MIGHTY.startTurn(undefined, ask('q1'), RUN)
    MIGHTY.resolveTurn(id, RUN, { a: 'a1', ok: true })
    MIGHTY.startTurn(id, ask('q2'), 'run_2')
    MIGHTY.resolveTurn(id, 'run_2', { a: 'a2', ok: true })

    expect(MIGHTY.findSessionIdByRunId('run_2')).toBe(id)
  })

  // Rows written before the turn-level stamp existed, and plain bad input. Both must
  // return null so callers fall back to seeding a transient thread rather than throw.
  it('returns null for an unknown or empty run id', () => {
    MIGHTY.startTurn(undefined, ask('q1'), RUN)
    expect(MIGHTY.findSessionIdByRunId('run_nope')).toBeNull()
    expect(MIGHTY.findSessionIdByRunId('')).toBeNull()
  })
})

// `runId` is persisted but only resolveTurn clears it, which a killed process never
// reaches. Every surface reads "running" as `runId !== undefined`, so an interrupted
// session showed as thinking forever and Stop couldn't clear it (abortRun no-ops).
describe('MIGHTY.reconcileInterruptedSessions', () => {
  beforeEach(() => rmSync(sessionsPath, { force: true }))

  it('clears a runId stranded by a previous app lifetime', () => {
    const id = MIGHTY.startTurn(undefined, ask('what happened here?'), RUN)
    expect(MIGHTY.getSession(id)!.runId).toBe(RUN)

    expect(MIGHTY.reconcileInterruptedSessions()).toBe(1)

    const s = MIGHTY.getSession(id)!
    // The whole point: nothing downstream can call this thread running any more.
    expect(s.runId).toBeUndefined()
    expect(s.turns[0].a).toBe(CONFIG.MIGHTY.INTERRUPTED_REPLY)
    expect(s.turns[0].ok).toBe(false)
  })

  it('patches the dangling turn in place rather than appending one', () => {
    const id = MIGHTY.startTurn(undefined, ask('q1'), RUN)
    MIGHTY.reconcileInterruptedSessions()

    // A second turn here would show the question twice, the same regression
    // resolveTurn guards against.
    expect(MIGHTY.getSession(id)!.turns).toHaveLength(1)
  })

  it('leaves a settled session completely alone', () => {
    const id = MIGHTY.startTurn(undefined, ask('q1'), RUN)
    MIGHTY.resolveTurn(id, RUN, { a: 'the real answer', ok: true })

    expect(MIGHTY.reconcileInterruptedSessions()).toBe(0)
    expect(MIGHTY.getSession(id)!.turns[0].a).toBe('the real answer')
    expect(MIGHTY.getSession(id)!.turns[0].ok).toBe(true)
  })

  // The reply landed but the process died before resolveTurn wrote the mark away.
  // Clearing the mark is right; overwriting the answer the user can already read is not.
  it('keeps an answered trailing turn when only the mark was lost', () => {
    const id = MIGHTY.startTurn(undefined, ask('q1'), RUN)
    MIGHTY.answerLastTurn(id, { a: 'answered before the crash', ok: true })

    MIGHTY.reconcileInterruptedSessions()

    const s = MIGHTY.getSession(id)!
    expect(s.runId).toBeUndefined()
    expect(s.turns[0].a).toBe('answered before the crash')
    expect(s.turns[0].ok).toBe(true)
  })

  it('settles every stranded session, not just the newest', () => {
    const first = MIGHTY.startTurn(undefined, ask('q1'), RUN)
    const second = MIGHTY.startTurn(undefined, ask('q2'), 'run_2')

    expect(MIGHTY.reconcileInterruptedSessions()).toBe(2)
    expect(MIGHTY.getSession(first)!.runId).toBeUndefined()
    expect(MIGHTY.getSession(second)!.runId).toBeUndefined()
  })

  // Boot runs it before anything reads sessions; a second pass (or a later boot)
  // must find nothing left to do.
  it('is idempotent', () => {
    MIGHTY.startTurn(undefined, ask('q1'), RUN)
    expect(MIGHTY.reconcileInterruptedSessions()).toBe(1)
    expect(MIGHTY.reconcileInterruptedSessions()).toBe(0)
  })

  // What Stop does when abortRun finds nothing alive (mighty.ts + phone-remote.ts
  // both take this path). It must reach the session from the run id ALONE, since
  // that is all either stop handler is given.
  it('settles a stranded run reached by id, the way Stop does', () => {
    const id = MIGHTY.startTurn(undefined, ask('q1'), RUN)

    const found = MIGHTY.findSessionIdByRunId(RUN)
    expect(found).toBe(id)
    expect(MIGHTY.resolveTurn(found!, RUN, { a: CONFIG.MIGHTY.STOPPED_REPLY, ok: false })).toBe(true)

    const s = MIGHTY.getSession(id)!
    expect(s.runId).toBeUndefined()
    expect(s.turns[0].a).toBe(CONFIG.MIGHTY.STOPPED_REPLY)
  })
})

// The runId-free counterpart. Smart dictation's capture turn is written by
// logCapture with an empty answer and produced by a SEPARATE backend run, so
// nothing links the two — resolveTurn can't reach it. Before answerLastTurn
// existed, every listen session on disk ended at `a: ''`: the answer lived only
// on the HUD card and in history, so the Mighty window and a phone with the
// thread open both showed a question with no reply.
describe('MIGHTY.answerLastTurn', () => {
  const listen = (q: string): MightyTurn => ({
    source: 'listen',
    q,
    a: '',
    ts: '2026-07-24T12:10:48Z',
    ok: true,
    backend: ''
  })

  beforeEach(() => rmSync(sessionsPath, { force: true }))

  it('fills an unanswered trailing turn that has no runId', () => {
    const id = MIGHTY.appendTurn(undefined, listen('what are my open tasks?'))
    expect(MIGHTY.getSession(id)!.turns[0].a).toBe('')

    expect(MIGHTY.answerLastTurn(id, { a: 'You have 3.', ok: true, backend: 'claude' })).toBe(true)

    const s = MIGHTY.getSession(id)!
    // Patched in place — a second turn here would show the question twice.
    expect(s.turns).toHaveLength(1)
    expect(s.turns[0].a).toBe('You have 3.')
    expect(s.turns[0].backend).toBe('claude')
  })

  it('refuses to overwrite an answer the user has already read', () => {
    const id = MIGHTY.appendTurn(undefined, listen('q'))
    MIGHTY.answerLastTurn(id, { a: 'first', ok: true })

    expect(MIGHTY.answerLastTurn(id, { a: 'late clobber', ok: true })).toBe(false)
    expect(MIGHTY.getSession(id)!.turns[0].a).toBe('first')
  })

  it('no-ops on an unknown session instead of throwing', () => {
    expect(MIGHTY.answerLastTurn('nope', { a: 'x', ok: true })).toBe(false)
  })
})

describe('sending something else over a parked dictation', () => {
  it('leaves one message and names the chat after it', () => {
    const id = MIGHTY.appendTurn(undefined, { ...ask('how is seo going'), source: 'listen', backend: '' })
    expect(MIGHTY.getSession(id)!.title).toBe('how is seo going')

    MIGHTY.truncateLastTurn(id)
    MIGHTY.startTurn(id, ask('fill in this form'), RUN)

    const s = MIGHTY.getSession(id)!
    expect(s.turns.map((t) => t.q)).toEqual(['fill in this form'])
    expect(s.title).toBe('fill in this form')
  })
})
