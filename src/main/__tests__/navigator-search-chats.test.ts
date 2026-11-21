import { describe, expect, it, vi } from 'vitest'
import type { MightySession, MightyTurn } from '../../shared/types'

const sessions = vi.hoisted(() => [] as MightySession[])
vi.mock('../store/mighty', () => ({ MIGHTY: { readSessions: () => sessions } }))

const { searchConversations } = await import('../navigator-search')

const turn = (q: string, a: string): MightyTurn => ({ source: 'chat', q, a, ts: '2026-11-20T00:00:00Z', ok: true }) as MightyTurn
const session = (id: string, title: string, turns: MightyTurn[]): MightySession =>
  ({ schema_version: 1, id, title, created: '2026-11-20T00:00:00Z', updated: `2026-11-20T0${id.length}:00:00Z`, turns }) as MightySession

describe('navigator search: Recent chats are real conversations only', () => {
  it('a voice dictation saved as an unsent one-line session is not offered as a chat', async () => {
    sessions.splice(0, sessions.length,
      session('dict', 'pick up the dry cleaning', [turn('pick up the dry cleaning', '')]),
      session('real', 'dry cleaning hours', [turn('when does the dry cleaning shop close', 'At 7 pm.')])
    )
    const hits = await searchConversations('dry cleaning', [])
    expect(hits.map((h) => h.id)).toEqual(['chat:real'])
  })

  it('a reply that is only whitespace does not make it a conversation', async () => {
    sessions.splice(0, sessions.length, session('blank', 'groceries', [turn('groceries list', '   ')]))
    expect(await searchConversations('groceries', [])).toEqual([])
  })

  it('a dictation the user went on to send and get answered is a conversation', async () => {
    sessions.splice(0, sessions.length,
      session('later', 'trip plan', [turn('trip plan', ''), turn('trip plan for Bangkok', 'Day one: Chatuchak.')])
    )
    const hits = await searchConversations('trip', [])
    expect(hits.map((h) => h.id)).toEqual(['chat:later'])
  })
})
