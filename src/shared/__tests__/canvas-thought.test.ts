import { describe, expect, it } from 'vitest'
import { CANVAS_SANDBOX, CODE_DRAG_TYPE, SESSION_DRAG_TYPE, isQuestion, readSessionDrag, readThought, writeCodeDrag, type CanvasThinkContext } from '../canvas'

const ctx: CanvasThinkContext = {
  projects: [
    { id: 'p-shop', name: 'Shop', about: 'store' },
    { id: 'p-app', name: 'App', about: 'mac app' },
    { id: 'p-site', name: 'Site', about: 'landing' },
    { id: 'p-blog', name: 'Blog', about: 'posts' }
  ],
  chats: [{ id: 'c-icons', title: 'Icon sizes', project: 'p-app', minutesAgo: 4 }],
  notes: ['n1', 'n2', 'n3', 'n4'].map((id) => ({ id, text: id, planet: CANVAS_SANDBOX, tags: [] }))
}

const answer = (j: Record<string, unknown>): string => `Sure, here you go:\n${JSON.stringify(j)}\nDone.`

describe('isQuestion', () => {
  it('reads casual asks as questions even with no question mark', () => {
    for (const text of [
      'canu make the icons bigger',
      'can u fix the header',
      'could you check the logs',
      'would it be faster with a cache',
      'will this break the build',
      'please start the server',
      'pls rename the tab',
      'what broke',
      'the header is too tall?',
      '  Should we ship it  '
    ]) {
      expect(isQuestion(text), text).toBe(true)
    }
  })

  it('leaves statements and look-alike words as notes', () => {
    for (const text of ['canvas zoom feels slow', 'the icons look off', 'Isolate the payment bug', 'whatever works', 'pleased with the new logo', 'cannot log in on staging']) {
      expect(isQuestion(text), text).toBe(false)
    }
  })
})

describe('readThought', () => {
  it('answers a casual ask the filer called a note', () => {
    const t = readThought(answer({ action: 'note', planet: 'p-app' }), 'canu make the icons bigger', ctx)
    expect(t?.action).toBe('chat')
  })

  it('continues the matched chat when an answer is wanted, and starts a new one when the chat id is unknown', () => {
    expect(readThought(answer({ action: 'note', session: { id: 'c-icons' } }), 'could you make those icons bigger', ctx)).toMatchObject({
      action: 'continue',
      session: { id: 'c-icons', why: 'same thread' }
    })
    const t = readThought(answer({ action: 'continue', session: { id: 'c-made-up' } }), 'make it bigger', ctx)
    expect(t?.action).toBe('chat')
    expect(t?.session).toBeUndefined()
  })

  it('files a plain statement as a note even when it matches a chat', () => {
    expect(readThought(answer({ action: 'note', session: { id: 'c-icons' } }), 'the icons look off', ctx)?.action).toBe('note')
  })

  it('offers up to three known project guesses only when the note lands in Sandbox', () => {
    const unsure = readThought(answer({ planet: 'p-nope', guesses: ['p-shop', 'p-ghost', 'p-shop', 'p-app', 'p-site', 'p-blog'] }), 'x', ctx)
    expect(unsure?.planet).toBe(CANVAS_SANDBOX)
    expect(unsure?.guesses).toEqual(['p-shop', 'p-app', 'p-site'])
    expect(readThought(answer({ planet: 'p-shop', guesses: ['p-app'] }), 'x', ctx)?.guesses).toEqual([])
  })

  it('drops related notes the model invented and keeps at most three', () => {
    const t = readThought(answer({ related: [{ id: 'ghost' }, { id: 'n1', why: 'same' }, { id: 'n2' }, { id: 'n3' }, { id: 'n4' }] }), 'x', ctx)
    expect(t?.related).toEqual([
      { id: 'n1', why: 'same' },
      { id: 'n2', why: 'related' },
      { id: 'n3', why: 'related' }
    ])
  })

  it('lowercases model tags and falls back to words from the note', () => {
    expect(readThought(answer({ tags: ['Icons', ' UI '] }), 'x', ctx)?.tags).toEqual(['icons', 'ui'])
    expect(readThought(answer({}), 'Bigger toolbar icons please', ctx)?.tags).toEqual(['bigger', 'toolbar', 'icons', 'please'])
  })

  it('returns null when the model answered with no JSON', () => {
    expect(readThought('I could not decide.', 'x', ctx)).toBeNull()
    expect(readThought('{ not json }', 'x', ctx)).toBeNull()
  })
})

describe('readSessionDrag', () => {
  const transfer = (data: Record<string, string>): DataTransfer =>
    ({ getData: (type: string) => data[type] ?? '', setData: (type: string, v: string) => (data[type] = v), effectAllowed: 'none' }) as unknown as DataTransfer

  it('reads a dragged chat, and prefers it when both kinds are present', () => {
    expect(readSessionDrag(transfer({ [SESSION_DRAG_TYPE]: 'chat-1' }))).toEqual({ kind: 'chat', id: 'chat-1' })
    expect(readSessionDrag(transfer({ [SESSION_DRAG_TYPE]: 'chat-1', [CODE_DRAG_TYPE]: '{"id":"code-1"}' }))?.kind).toBe('chat')
  })

  it('round-trips a dragged Code session written by writeCodeDrag', () => {
    const dt = transfer({})
    writeCodeDrag(dt, { id: 'code-1', title: 'Fix login', cwd: '/w/app' })
    expect(dt.effectAllowed).toBe('copy')
    expect(readSessionDrag(dt)).toEqual({ kind: 'code', id: 'code-1', title: 'Fix login', cwd: '/w/app' })
  })

  it('titles a Code session with no title by its id', () => {
    expect(readSessionDrag(transfer({ [CODE_DRAG_TYPE]: '{"id":"code-2"}' }))).toEqual({ kind: 'code', id: 'code-2', title: 'code-2', cwd: undefined })
  })

  it('ignores a file, text, broken JSON or a payload with no id', () => {
    for (const data of [{}, { 'text/plain': 'hello' }, { [CODE_DRAG_TYPE]: '{broken' }, { [CODE_DRAG_TYPE]: '{"title":"x"}' }, { [CODE_DRAG_TYPE]: 'null' }]) {
      expect(readSessionDrag(transfer(data)), JSON.stringify(data)).toBeNull()
    }
  })
})
