import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { CoordinationStore } from '../store'
import { CoordinationService } from '../service'
import {
  COORDINATION,
  type CoordinationMessage,
  type CoordinationSession,
  type CoordinationSnapshot,
  type CoordinationWork
} from '../../../../shared/coordination'

const disposals: Array<() => void> = []
afterEach(() => {
  for (const close of disposals.splice(0).reverse()) close()
})
function fixture(): {
  root: string
  db: CoordinationStore
  a: CoordinationSession
  b: CoordinationSession
  c: CoordinationSession
  clock: { now: number }
} {
  const root = mkdtempSync(join(tmpdir(), 'mm-coordination-'))
  disposals.push(() => rmSync(root, { recursive: true, force: true }))
  const clock = { now: 1_000_000 }
  const db = new CoordinationStore(join(root, 'test.sqlite'), () => clock.now)
  disposals.push(() => db.close())
  const base = { project: 'product-a', projectName: 'Product A', cwd: root, version: 'test' }
  const a = db.register({ ...base, session: 'one', harness: 'claude', label: 'Builder' }, 'a')
  const b = db.register({ ...base, session: 'two', harness: 'codex', label: 'Reviewer' }, 'b')
  const c = db.register(
    { ...base, project: 'product-b', session: 'three', harness: 'gemini', label: 'Other product' },
    'c'
  )
  return { root, db, a, b, c, clock }
}

describe('durable handoffs', () => {
  it('retries once, preserves pending reads, scopes receipts, and persists acceptance after restart', () => {
    const { root, db, b } = fixture()
    const input = {
      to: b.id,
      key: 'request-1',
      subject: 'Review',
      body: 'Check the fixture.',
      refs: [root]
    }
    const sent = db.call('send', input, 'a') as CoordinationMessage
    expect(db.call('send', input, 'a')).toEqual(sent)
    expect(() => db.call('send', { ...input, body: 'Changed' }, 'a')).toThrow(/retry key/)
    expect(db.call('inbox', {}, 'a')).toEqual([])
    expect((db.call('inbox', {}, 'b') as CoordinationMessage[])[0].state).toBe('pending')
    expect(db.call('inbox', {}, 'b') as CoordinationMessage[]).toHaveLength(1)
    expect(() => db.call('ack', { message: sent.id, state: 'completed' }, 'a')).toThrow(
      /not addressed/
    )
    db.call('ack', { message: sent.id, state: 'accepted', note: 'Reviewing' }, 'b')
    const reopened = new CoordinationStore(join(root, 'test.sqlite'))
    try {
      expect((reopened.call('inbox', {}, 'b') as CoordinationMessage[])[0].state).toBe('accepted')
    } finally {
      reopened.close()
    }
    db.call('ack', { message: sent.id, state: 'completed', note: 'Checked' }, 'b')
    expect(db.call('inbox', {}, 'b')).toEqual([])
    expect(() => db.call('ack', { message: sent.id, state: 'accepted' }, 'b')).toThrow(
      /final receipt/
    )
  })
  it('keeps other projects out of status and rejects invented credentials and recipients', () => {
    const { db, c } = fixture()
    expect(() => db.call('status', {}, 'invented')).toThrow(/Join/)
    expect(JSON.stringify(db.call('status', {}, 'a'))).not.toContain(c.id)
    expect(() => db.call('send', { to: 'nobody', key: 'x', subject: 'x', body: 'x' }, 'a')).toThrow(
      /joined shared work/
    )
    expect(JSON.stringify(db.snapshot())).not.toContain('tokenHash')
  })
  it('carries a note to an agent in another project, which reads and completes it', () => {
    const { db, a, c } = fixture()
    expect(a.project).not.toBe(c.project)
    const sent = db.call(
      'send',
      { to: c.id, key: 'x', subject: 'Cross repo', body: 'Please check.' },
      'a'
    ) as CoordinationMessage
    expect(sent.recipient).toBe(c.id)
    const inbox = db.call('inbox', {}, 'c') as CoordinationMessage[]
    expect(inbox.map((m) => m.id)).toEqual([sent.id])
    db.call('ack', { message: sent.id, state: 'completed', note: 'Done there' }, 'c')
    const receipt = (db.call('status', {}, 'a') as CoordinationSnapshot).messages.find(
      (m) => m.id === sent.id
    )
    expect(receipt?.state).toBe('completed')
    expect(receipt?.note).toBe('Done there')
  })
  it('keeps a single owner, fences expired workers, and requires completion evidence', () => {
    const { db, clock } = fixture()
    const args = {
      work: 'recovery',
      title: 'Recover connection',
      acceptance: 'Reconnect restores the flow.'
    }
    const first = db.call('claim', args, 'a') as CoordinationWork
    expect(() => db.call('claim', args, 'b')).toThrow(/Another session/)
    clock.now += COORDINATION.leaseMs + 1
    const second = db.call('claim', args, 'b') as CoordinationWork
    expect(second.generation).toBe(first.generation + 1)
    expect(() =>
      db.call(
        'update',
        {
          work: args.work,
          generation: first.generation,
          state: 'complete',
          note: 'done',
          refs: ['result.txt']
        },
        'a'
      )
    ).toThrow(/Ownership/)
    expect(() =>
      db.call(
        'update',
        { work: args.work, generation: second.generation, state: 'complete', note: 'done' },
        'b'
      )
    ).toThrow(/evidence/)
    db.call(
      'update',
      {
        work: args.work,
        generation: second.generation,
        state: 'complete',
        note: 'checked',
        refs: ['result.txt']
      },
      'b'
    )
    expect(() => db.call('claim', args, 'a')).toThrow(/complete/)
  })
  it('renews live claims but never revives an expired one through heartbeat', () => {
    const { db, clock } = fixture()
    db.call('claim', { work: 'x', title: 'x', acceptance: 'x' }, 'a')
    clock.now += 1_000
    db.call('heartbeat', {}, 'a')
    expect(db.snapshot().work[0].expiresAt).toBe(clock.now + COORDINATION.leaseMs)
    clock.now += COORDINATION.leaseMs + 1
    db.call('heartbeat', {}, 'a')
    expect(db.snapshot().work[0].expired).toBe(true)
  })
  it('sends by session or label and retires notes and claims a day after their owner went quiet', () => {
    const { db, b, clock } = fixture()
    const note = { key: 'k', subject: 's', body: 'b' }
    expect((db.call('send', { ...note, to: 'Reviewer' }, 'a') as CoordinationMessage).recipient).toBe(b.id)
    expect((db.call('send', { ...note, key: 'k2', to: 'two' }, 'a') as CoordinationMessage).recipient).toBe(b.id)
    expect(() => db.call('send', { ...note, key: 'k3', to: 'Nobody' }, 'a')).toThrow(/joined/)
    db.call('claim', { work: 'x', title: 'x', acceptance: 'x' }, 'b')
    clock.now += COORDINATION.abandonMs + COORDINATION.leaseMs + 1
    db.call('heartbeat', {}, 'a')
    expect(db.retireAbandoned()).toEqual({ notes: 2, claims: 1 })
    const snap = db.snapshot()
    expect(snap.messages.every((m) => m.state === 'declined' && /stopped checking in/.test(m.note))).toBe(true)
    expect(snap.work[0].state).toBe('released')
    expect(db.retireAbandoned()).toEqual({ notes: 0, claims: 0 })
  })
  it('paginates events without gaps and applies recipient backpressure', () => {
    const { db, b } = fixture()
    for (let i = 0; i < COORDINATION.maxSessionPending; i++) {
      db.call('send', { to: b.id, key: `r-${i}`, subject: 'x', body: 'x' }, 'a')
    }
    expect(() =>
      db.call('send', { to: b.id, key: 'overflow', subject: 'x', body: 'x' }, 'a')
    ).toThrow(/too many/)
    let cursor = 0
    const ids = new Set<number>()
    let more = true
    while (more) {
      const page = db.snapshot('product-a', cursor)
      page.events.forEach((e) => ids.add(e.seq))
      cursor = page.cursor
      more = page.hasMore
    }
    expect(ids.size).toBe(COORDINATION.maxSessionPending)
  })
})

describe('real HTTP boundary', () => {
  it('requires credentials, rejects browser origins, and roundtrips a scoped handoff', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mm-coordination-http-'))
    disposals.push(() => rmSync(root, { recursive: true, force: true }))
    const service = new CoordinationService(root)
    disposals.push(() => service.close())
    const server: Server = createServer((req, res) => {
      void service.handle(req, res)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    disposals.push(() => {
      server.closeAllConnections()
      server.close()
    })
    const address = server.address() as { port: number }
    const url = `http://127.0.0.1:${address.port}${COORDINATION.route}`
    const operator = readFileSync(join(root, COORDINATION.keyFile), 'utf8')
    const call = async <T = unknown>(
      op: string,
      args: object,
      token = operator,
      origin?: string
    ): Promise<{ status: number; body: { result: T } }> => {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          ...(origin ? { Origin: origin } : {})
        },
        body: JSON.stringify({ op, args })
      })
      return { status: response.status, body: (await response.json()) as { result: T } }
    }
    expect((await call('overview', {}, 'wrong')).status).not.toBe(200)
    expect((await call('enable', { enabled: true }, operator, 'https://example.com')).status).toBe(
      403
    )
    expect((await call('enable', { enabled: true })).status).toBe(200)
    type Joined = { participant: CoordinationSession; token: string }
    const registerSession = async (session: string, harness: string): Promise<Joined> =>
      (
        await call<Joined>('register', {
          project: 'p',
          projectName: 'P',
          session,
          harness,
          label: session,
          cwd: root,
          version: 'test'
        })
      ).body.result
    const a = await registerSession('one', 'claude')
    const b = await registerSession('two', 'codex')
    const message = (
      await call<CoordinationMessage>(
        'send',
        { to: b.participant.id, key: 'nonce', subject: 'Read fixture', body: 'Return the nonce.' },
        a.token
      )
    ).body.result
    expect((await call<CoordinationMessage[]>('inbox', {}, b.token)).body.result[0].id).toBe(
      message.id
    )
    expect(
      (await call('ack', { message: message.id, state: 'completed', note: 'nonce' }, b.token))
        .status
    ).toBe(200)
    expect((await call('enable', { enabled: false }, a.token)).status).not.toBe(200)
    expect((await call<CoordinationSnapshot>('overview', {})).body.result.messages[0].state).toBe(
      'completed'
    )
  })
})
