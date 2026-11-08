import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

const h = vi.hoisted(() => ({ turns: [] as Array<{ role: string; at: string; text: string }> }))

vi.mock('../../store/paths', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')
  return { PATHS: { ROOT: mkdtempSync(path.join(tmpdir(), 'mm-page-reply-')) } }
})
vi.mock('../session-transcript', () => ({ readSessionTranscript: () => h.turns }))

import { PATHS } from '../../store/paths'
import { handlePageReply, pageReplyKey, setPageReplyHost, type PageReplyHost } from '../page-reply'

type Session = Parameters<PageReplyHost['send']>[0]

interface Sent {
  handled: boolean
  status: number
  body: unknown
  headers: Record<string, string>
}

function request(
  method: string,
  url: string,
  opts: { headers?: Record<string, string>; body?: unknown; raw?: string } = {}
): Promise<Sent> {
  return new Promise((resolve) => {
    const req = new PassThrough() as unknown as IncomingMessage & PassThrough
    req.method = method
    req.url = url
    req.headers = { host: 'localhost:17772', ...opts.headers }
    const sent: Sent = { handled: false, status: 0, body: undefined, headers: {} }
    const res = {
      writeHead(code: number, headers?: Record<string, string>) {
        sent.status = code
        sent.headers = headers ?? {}
        return res
      },
      end(text?: string) {
        try {
          sent.body = text ? JSON.parse(text) : undefined
        } catch {
          sent.body = text
        }
        resolve(sent)
      }
    }
    sent.handled = handlePageReply(req, res as unknown as ServerResponse)
    if (!sent.handled) return resolve(sent)
    if (method === 'POST') req.end(opts.raw ?? JSON.stringify(opts.body ?? {}))
  })
}

const session = (over: Record<string, unknown> = {}): Session =>
  ({ sessionId: 'sess-a', label: 'Fix checkout', cwd: '/Users/dev/shop', tldr: 'Fixing the cart', ...over }) as unknown as Session

function hostWith(sessions: Session[], over: Partial<PageReplyHost> = {}) {
  const send = vi.fn<PageReplyHost['send']>().mockResolvedValue('tmux')
  const start = vi.fn<PageReplyHost['start']>().mockResolvedValue({ ok: true, pane: '%9' })
  setPageReplyHost({
    find: (ref) => sessions.find((s) => (s as unknown as { sessionId: string }).sessionId === ref),
    send,
    start,
    byPane: () => undefined,
    ...over
  })
  return { send, start }
}

const PNG = `data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}`
const post = (route: string, body: Record<string, unknown>, headers?: Record<string, string>): Promise<Sent> =>
  request('POST', `/page/${route}`, { body, headers })
const valid = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  session: 'sess-a',
  key: pageReplyKey('sess-a'),
  text: 'looks good, ship it',
  ...over
})

beforeEach(() => {
  h.turns = []
  setPageReplyHost(undefined)
})

describe('page reply: which requests it takes', () => {
  it('leaves every URL outside /page/ to the rest of the server', async () => {
    const sent = await request('GET', '/mcp')
    expect(sent.handled).toBe(false)
    expect(sent.status).toBe(0)
  })

  it('answers an unknown /page/ route with 404', async () => {
    expect((await request('GET', '/page/nope')).status).toBe(404)
  })
})

describe('page reply: handing out the key', () => {
  it('gives a local caller a 32-character key that is different for every session', async () => {
    const a = await request('GET', '/page/key?session=sess-a')
    const b = await request('GET', '/page/key?session=sess-b')
    expect(a.status).toBe(200)
    expect((a.body as { key: string }).key).toMatch(/^[0-9a-f]{32}$/)
    expect((a.body as { key: string }).key).toBe(pageReplyKey('sess-a'))
    expect((b.body as { key: string }).key).not.toBe((a.body as { key: string }).key)
  })

  it('refuses any request a web page made, and never lets a page read the answer', async () => {
    for (const origin of ['https://evil.example', 'http://localhost:3000', 'null']) {
      const sent = await request('GET', '/page/key?session=sess-a', { headers: { origin } })
      expect(sent.status, origin).toBe(403)
      expect(sent.body).toBeUndefined()
    }
    const ok = await request('GET', '/page/key?session=sess-a')
    expect(Object.keys(ok.headers).map((k) => k.toLowerCase())).not.toContain('access-control-allow-origin')
  })

  it('refuses a Host that is not this machine, so a rebound domain cannot fetch it', async () => {
    for (const host of ['evil.example:17772', 'localhost.evil.example', '192.168.1.20:17772', '']) {
      const sent = await request('GET', '/page/key?session=sess-a', { headers: { host } })
      expect(sent.status, host).toBe(403)
    }
    expect((await request('GET', '/page/key?session=sess-a', { headers: { host: '127.0.0.1:17772' } })).status).toBe(200)
  })

  it('refuses a request that names no session', async () => {
    expect((await request('GET', '/page/key')).status).toBe(403)
  })

  it('keeps the signing secret in a file only this user can read', () => {
    pageReplyKey('sess-a')
    const file = join(PATHS.ROOT, 'page-reply-secret')
    expect(readFileSync(file, 'utf8')).toMatch(/^[0-9a-f]{64}$/)
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })
})

describe('page reply: sending a message into a session', () => {
  it('delivers the trimmed text and says which page it came from', async () => {
    const { send } = hostWith([session()])
    const sent = await post('reply', valid({ text: '  looks good, ship it \n', page: 'Checkout\n  review ' }))
    expect(sent.status).toBe(200)
    expect(sent.body).toEqual({ ok: true })
    expect(send).toHaveBeenCalledTimes(1)
    const [to, text, files, context] = send.mock.calls[0]
    expect((to as unknown as { sessionId: string }).sessionId).toBe('sess-a')
    expect(text).toBe('looks good, ship it')
    expect(files).toEqual([])
    expect(context).toBe('[sent from the page Checkout review ]\n')
  })

  it('refuses a missing key, a wrong key, and a key that belongs to another session', async () => {
    const { send } = hostWith([session(), session({ sessionId: 'sess-b' })])
    const bad = [
      valid({ key: undefined }),
      valid({ key: '0'.repeat(32) }),
      valid({ key: pageReplyKey('sess-b') }),
      valid({ key: pageReplyKey('sess-a').slice(0, 31) }),
      valid({ key: `${pageReplyKey('sess-a')}0` }),
      valid({ session: 42 })
    ]
    for (const body of bad) {
      const sent = await post('reply', body)
      expect(sent.status, JSON.stringify(body.key)).toBe(403)
    }
    expect(send).not.toHaveBeenCalled()
  })

  it('refuses a page on another site even when it holds a valid key', async () => {
    const { send } = hostWith([session()])
    for (const origin of ['https://evil.example', 'http://localhost.evil.example', 'http://192.168.1.20:3000']) {
      expect((await post('reply', valid(), { origin })).status, origin).toBe(403)
    }
    expect(send).not.toHaveBeenCalled()
    for (const origin of ['null', 'file://', 'http://localhost:5173', 'http://127.0.0.1']) {
      expect((await post('reply', valid(), { origin })).status, origin).toBe(200)
    }
  })

  it('says the session has ended instead of typing into a dead one', async () => {
    const stale = hostWith([session({ staleSince: 1 })])
    expect(await post('reply', valid())).toMatchObject({ status: 410, body: { ok: false, reason: 'ended' } })
    expect(stale.send).not.toHaveBeenCalled()
    hostWith([])
    expect((await post('reply', valid())).status).toBe(410)
  })

  it('rejects an empty message and a body that is not JSON', async () => {
    const { send } = hostWith([session()])
    expect((await post('reply', valid({ text: '   ' }))).status).toBe(400)
    expect((await post('reply', valid({ text: 7 }))).status).toBe(400)
    expect((await request('POST', '/page/reply', { raw: 'session=sess-a' })).status).toBe(400)
    expect(send).not.toHaveBeenCalled()
  })

  it('caps a huge message at the chat limit', async () => {
    const { send } = hostWith([session()])
    await post('reply', valid({ text: 'x'.repeat(9000) }))
    expect(send.mock.calls[0][1]).toHaveLength(4000)
  })

  it('reports a failure when the message could not be typed into the session', async () => {
    hostWith([session()], { send: vi.fn<PageReplyHost['send']>().mockResolvedValue('skipped') })
    expect(await post('reply', valid())).toMatchObject({ status: 502, body: { ok: false } })
  })

  it('saves at most three real images, inside its own folder, and ignores everything else', async () => {
    const { send } = hostWith([session()])
    const images = ['/etc/passwd', 'data:text/html;base64,PGI+', { evil: true }, PNG, PNG, PNG, PNG]
    const blocked = await post('reply', valid({ text: '', images: images.slice(0, 3) }))
    expect(blocked.status).toBe(400)
    const sent = await post('reply', valid({ text: '', images: [PNG, 'data:text/html;base64,PGI+', PNG, PNG, PNG] }))
    expect(sent.status).toBe(200)
    const files = send.mock.calls[0][2]
    expect(files).toHaveLength(2)
    const dir = join(PATHS.ROOT, 'page-reply-images')
    for (const file of files) {
      expect(file.startsWith(`${dir}/`)).toBe(true)
      expect(file.endsWith('.png')).toBe(true)
      expect(readFileSync(file, 'utf8')).toBe('png-bytes')
    }
    expect(readdirSync(dir).length).toBeGreaterThanOrEqual(2)
  })
})

describe('page reply: showing the page what the session is doing', () => {
  it('refuses to show a transcript without the key', async () => {
    hostWith([session()])
    h.turns = [{ role: 'assistant', at: 't', text: 'secret plan' }]
    const sent = await request('GET', '/page/context?session=sess-a&key=wrong')
    expect(sent.status).toBe(403)
    expect(JSON.stringify(sent.body)).not.toContain('secret plan')
  })

  it('shows the last six spoken turns, without tool output, each clipped', async () => {
    hostWith([session({ busySince: 5 })])
    h.turns = [
      ...Array.from({ length: 7 }, (_, i) => ({ role: 'assistant', at: `t${i}`, text: `turn ${i}` })),
      { role: 'tool', at: 't', text: 'ls -la output' },
      { role: 'assistant', at: 't', text: '   ' },
      { role: 'user', at: 't8', text: 'y'.repeat(900) }
    ]
    const sent = await request('GET', `/page/context?session=sess-a&key=${pageReplyKey('sess-a')}`)
    const body = sent.body as { name: string; workingOn: string; state: string; turns: Array<{ text: string }> }
    expect(sent.status).toBe(200)
    expect(body).toMatchObject({ name: 'Fix checkout', workingOn: 'Fixing the cart', state: 'working' })
    expect(body.turns.map((t) => t.text.slice(0, 6))).toEqual(['turn 2', 'turn 3', 'turn 4', 'turn 5', 'turn 6', 'yyyyyy'])
    expect(body.turns[5].text).toBe(`${'y'.repeat(700)}…`)
  })

  it('a session that is gone reads as ended, with no turns', async () => {
    hostWith([])
    h.turns = [{ role: 'assistant', at: 't', text: 'left over' }]
    const sent = await request('GET', `/page/context?session=sess-a&key=${pageReplyKey('sess-a')}`)
    expect(sent.body).toEqual({ state: 'ended', turns: [] })
  })
})

describe('page reply: starting a new session from a page', () => {
  it('starts it in the folder of the session the page belongs to', async () => {
    const { start } = hostWith([session()])
    const sent = await post('new', valid({ text: 'try a dark version', page: 'Review' }))
    expect(sent).toMatchObject({ status: 200, body: { ok: true, pane: '%9' } })
    expect(start).toHaveBeenCalledWith({
      project: 'shop',
      cwd: '/Users/dev/shop',
      message: '[about the page Review]\ntry a dark version',
      paths: []
    })
  })

  it('falls back to the project that owns the page file once the session is gone', async () => {
    const { start } = hostWith([])
    await post('new', valid({ href: 'file:///Users/dev/shop/.claude/artifacts/review.html', page: 'Review' }))
    expect(start.mock.calls[0][0]).toMatchObject({ project: 'shop', cwd: '/Users/dev/shop' })
    expect(start.mock.calls[0][0].message.startsWith('[about the page Review at /Users/dev/shop/.claude/artifacts/review.html]\n')).toBe(true)
  })

  it('refuses when it cannot tell which project the page belongs to', async () => {
    const { start } = hostWith([])
    for (const href of ['https://evil.example/.claude/artifacts/x.html', 'file:///Users/dev/notes.html', undefined]) {
      expect(await post('new', valid({ href })), String(href)).toMatchObject({ status: 410, body: { reason: 'no project' } })
    }
    expect(start).not.toHaveBeenCalled()
  })

  it('refuses a wrong key before starting anything', async () => {
    const { start } = hostWith([session()])
    expect((await post('new', valid({ key: 'f'.repeat(32) }))).status).toBe(403)
    expect(start).not.toHaveBeenCalled()
  })

  it('hands the new session key only to the page that started it', async () => {
    const fresh = session({ sessionId: 'sess-new' })
    hostWith([session()], { byPane: (pane) => (pane === '%9' ? fresh : undefined) })
    const key = pageReplyKey('sess-a')
    expect((await request('GET', `/page/started?session=sess-a&key=${key}&pane=%2542`)).status).toBe(403)
    await post('new', valid())
    expect((await request('GET', `/page/started?session=sess-b&key=${pageReplyKey('sess-b')}&pane=%259`)).status).toBe(403)
    expect((await request('GET', '/page/started?session=sess-a&key=wrong&pane=%259')).status).toBe(403)
    const sent = await request('GET', `/page/started?session=sess-a&key=${key}&pane=%259`)
    expect(sent.body).toEqual({ session: 'sess-new', key: pageReplyKey('sess-new') })
  })
})
