/**
 * The message-vs-draft split, which decides what a chat shows when you open it.
 *
 * The bug this covers: a listen transcript rendered as a sent message under a reply
 * that never arrives, and a first attempt at fixing it leaked one session's draft
 * into the next chat you switched to.
 */

import { describe, expect, it } from 'vitest'
import type { MightySession, MightyTurn } from '../../../../shared/types'
import { neverSent, splitPendingDraft } from '../pending-draft'

function turn(q: string, a: string): MightyTurn {
  return { source: 'chat', q, a, ts: '2026-07-29T00:00:00.000Z', ok: true } as MightyTurn
}

function session(turns: MightyTurn[], over: Partial<MightySession> = {}): MightySession {
  return {
    schema_version: 1,
    id: 'sess-1',
    created: '2026-07-29T00:00:00.000Z',
    updated: '2026-07-29T00:00:00.000Z',
    title: 't',
    turns,
    ...over
  } as MightySession
}

describe('splitPendingDraft', () => {
  it('hands a lone unsent transcript to the composer', () => {
    // The listen-capture shape: one turn, no answer. Nothing to render yet.
    const view = splitPendingDraft(session([turn('buy milk', '')]), false)
    expect(view).toEqual({ turns: [], draft: 'buy milk' })
  })

  it('leaves a fully answered conversation alone', () => {
    const turns = [turn('hi', 'hello'), turn('more', 'sure')]
    const view = splitPendingDraft(session(turns), false)
    expect(view.turns).toHaveLength(2)
    expect(view.draft).toBe('')
  })

  it('splits only the trailing unsent turn, keeping the history above it', () => {
    const view = splitPendingDraft(session([turn('hi', 'hello'), turn('follow up', '')]), false)
    expect(view.turns).toEqual([turn('hi', 'hello')])
    expect(view.draft).toBe('follow up')
  })

  it('keeps the pending bubble visible while a run is in flight', () => {
    // Same shape, opposite meaning: this empty answer is about to be streamed into.
    // Splitting it would erase the user's question mid-run.
    const view = splitPendingDraft(session([turn('thinking about this', '')]), true)
    expect(view.turns).toHaveLength(1)
    expect(view.draft).toBe('')
  })

  it('ignores an empty question, so a blank turn never becomes a blank draft', () => {
    const view = splitPendingDraft(session([turn('', '')]), false)
    expect(view.draft).toBe('')
    expect(view.turns).toHaveLength(1)
  })

  it('reports no draft for an empty or missing session', () => {
    // A fresh pane and a not-yet-loaded pane must both leave the composer alone —
    // this is the case that leaked another chat's transcript into "New conversation".
    expect(splitPendingDraft(session([]), false)).toEqual({ turns: [], draft: '' })
    expect(splitPendingDraft(null, false)).toEqual({ turns: [], draft: '' })
    expect(splitPendingDraft(undefined, false)).toEqual({ turns: [], draft: '' })
  })

  it('gives every session its own answer, so switching chats cannot carry a draft', () => {
    // Switching A → B → A: the draft is derived from the session each time, never
    // remembered from the previous one.
    const withDraft = session([turn('transcript', '')], { id: 'a' })
    const answered = session([turn('hi', 'hello')], { id: 'b' })
    expect(splitPendingDraft(withDraft, false).draft).toBe('transcript')
    expect(splitPendingDraft(answered, false).draft).toBe('')
    expect(splitPendingDraft(withDraft, false).draft).toBe('transcript')
  })

  it('does not mutate the session it reads', () => {
    const turns = [turn('hi', 'hello'), turn('unsent', '')]
    const s = session(turns)
    splitPendingDraft(s, false)
    expect(s.turns).toHaveLength(2)
  })
})

describe('neverSent', () => {
  it('is true only for a chat holding nothing but an unsent dictation', () => {
    expect(neverSent(session([turn('how is seo going', '')]))).toBe(true)
    expect(neverSent(session([turn('hi', 'hello')]))).toBe(false)
    expect(neverSent(session([turn('first send, still running', '')], { runId: 'r1' }))).toBe(false)
    expect(neverSent(session([{ ...turn('stopped before a reply', ''), run_id: 'r1' }]))).toBe(false)
    expect(neverSent(session([]))).toBe(false)
  })
})
