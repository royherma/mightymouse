import { describe, expect, it, vi } from 'vitest'
import { deliverTask, parseRoute, routeCandidates, routePrompt } from '../task-route'

const sessions = [
  { ref: 'sid-landing', title: 'Landing page lock protection', recap: 'Adding a spam lock to the landing page' },
  { ref: 'sid-phone', title: 'Phone chat edge cases', recap: 'Fixing empty and long messages in phone chat' }
]

describe('parseRoute', () => {
  it.each([
    ['2', 1],
    ['2.', 1],
    ['Session 2', 1],
    ['  1\n', 0],
    ['NEW', null],
    ['new', null],
    ['**NEW**', null],
    ['3', null],
    ['0', null],
    ['', null],
    ['I am not sure', null]
  ])('%j -> %j', (raw, want) => {
    expect(parseRoute(raw, 2)).toBe(want)
  })
})

describe('routePrompt', () => {
  it('numbers every session with its title and recap, and carries the message', () => {
    const prompt = routePrompt('why do empty phone messages vanish?', sessions)
    expect(prompt).toContain('1. Landing page lock protection - Adding a spam lock')
    expect(prompt).toContain('2. Phone chat edge cases - Fixing empty and long messages')
    expect(prompt).toContain('Message: why do empty phone messages vanish?')
  })

  it('drops untitled candidates and caps the list', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ ref: `r${i}`, title: `t${i}` }))
    expect(routeCandidates([{ ref: 'x', title: '' }, ...many])).toHaveLength(20)
  })
})

describe('deliverTask', () => {
  const io = (route: string | null, replyOk: boolean) => ({
    route: vi.fn(async () => route),
    reply: vi.fn(async () => ({ ok: replyOk })),
    startNew: vi.fn(async () => {})
  })

  it('sends to the picked open session and starts nothing', async () => {
    const x = io('sid-phone', true)
    expect(await deliverTask('empty messages?', sessions, x)).toEqual({ kind: 'existing', ref: 'sid-phone' })
    expect(x.reply).toHaveBeenCalledWith('sid-phone', 'empty messages?')
    expect(x.startNew).not.toHaveBeenCalled()
  })

  it('starts a new session when nothing fits', async () => {
    const x = io(null, true)
    expect(await deliverTask('add a dark mode to billing', sessions, x)).toEqual({ kind: 'new' })
    expect(x.reply).not.toHaveBeenCalled()
    expect(x.startNew).toHaveBeenCalledWith('add a dark mode to billing')
  })

  it('falls back to a new session with the same message when the picked one has closed', async () => {
    const x = io('sid-phone', false)
    expect(await deliverTask('empty messages?', sessions, x)).toEqual({ kind: 'new', pickedClosed: 'sid-phone' })
    expect(x.startNew).toHaveBeenCalledWith('empty messages?')
  })

  it('skips the model when no session is open', async () => {
    const x = io('sid-phone', true)
    await deliverTask('hello', [], x)
    expect(x.route).not.toHaveBeenCalled()
    expect(x.startNew).toHaveBeenCalledWith('hello')
  })
})
