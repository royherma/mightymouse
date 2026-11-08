import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CoordinationStore } from '../store'
import { COORDINATION, type CoordinationMessage } from '../../../../shared/coordination'

const disposals: Array<() => void> = []
afterEach(() => {
  for (const close of disposals.splice(0).reverse()) close()
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mm-coord-recipient-'))
  disposals.push(() => rmSync(root, { recursive: true, force: true }))
  const clock = { now: 1_000_000 }
  const db = new CoordinationStore(join(root, 'test.sqlite'), () => clock.now)
  disposals.push(() => db.close())
  const base = { project: 'product-a', projectName: 'Product A', cwd: root, version: 'test' }
  const a = db.register({ ...base, session: 'one', harness: 'claude', label: 'Builder' }, 'a')
  const b = db.register({ ...base, session: 'two', harness: 'codex', label: 'Reviewer' }, 'b')
  clock.now += 60_000
  const elsewhere = db.register(
    { ...base, project: 'product-b', session: 'three', harness: 'claude', label: 'Reviewer' },
    'c'
  )
  return { db, a, b, elsewhere, clock }
}

const note = (to: string, key: string) => ({ to, key, subject: 's', body: 'b' })

describe('send resolves a label to the right agent', () => {
  it('a label shared across projects goes to the one in the sender project, even when the other checked in more recently', () => {
    const { db, b, elsewhere } = fixture()
    expect(elsewhere.lastSeen).toBeGreaterThan(b.lastSeen)
    const sent = db.call('send', note('Reviewer', 'k1'), 'a') as CoordinationMessage
    expect(sent.recipient).toBe(b.id)
    expect(db.call('inbox', {}, 'c')).toEqual([])
  })

  it('a label only another project has still reaches it', () => {
    const { db } = fixture()
    const d = db.register(
      { project: 'product-b', projectName: 'Product B', cwd: '/x', version: 'test', session: 'four', harness: 'codex', label: 'Only there' },
      'd'
    )
    const sent = db.call('send', note('Only there', 'k1'), 'a') as CoordinationMessage
    expect(sent.recipient).toBe(d.id)
    expect((db.call('inbox', {}, 'd') as CoordinationMessage[]).map((m) => m.id)).toEqual([sent.id])
  })

  it('backpressure counts the resolved agent, so addressing by label cannot overflow an inbox', () => {
    const { db, b } = fixture()
    for (let i = 0; i < COORDINATION.maxSessionPending; i++) db.call('send', note(b.id, `r-${i}`), 'a')
    expect(() => db.call('send', note('Reviewer', 'overflow'), 'a')).toThrow(/too many/)
    expect(() => db.call('send', note('two', 'overflow-2'), 'a')).toThrow(/too many/)
  })
})

describe('retireAbandoned only touches work whose owner has been quiet for a day', () => {
  it('a note to a recipient who checked in within the day stays pending', () => {
    const { db, b, clock } = fixture()
    db.call('send', note(b.id, 'k1'), 'a')
    clock.now += COORDINATION.abandonMs - 60_000
    db.call('heartbeat', {}, 'b')
    clock.now += 120_000
    expect(db.retireAbandoned()).toEqual({ notes: 0, claims: 0 })
    expect((db.call('inbox', {}, 'b') as CoordinationMessage[]).map((m) => m.state)).toEqual(['pending'])
  })

  it('an accepted note is left alone however quiet the recipient', () => {
    const { db, b, clock } = fixture()
    const sent = db.call('send', note(b.id, 'k1'), 'a') as CoordinationMessage
    db.call('ack', { message: sent.id, state: 'accepted' }, 'b')
    clock.now += COORDINATION.abandonMs + COORDINATION.leaseMs + 1
    db.call('heartbeat', {}, 'a')
    expect(db.retireAbandoned().notes).toBe(0)
    expect(db.snapshot().messages.find((m) => m.id === sent.id)?.state).toBe('accepted')
  })

  it('a claim whose lease lapsed less than a day ago is not released', () => {
    const { db, clock } = fixture()
    db.call('claim', { work: 'x', title: 'x', acceptance: 'x' }, 'b')
    clock.now += COORDINATION.leaseMs + COORDINATION.abandonMs - 60_000
    expect(db.retireAbandoned().claims).toBe(0)
    expect(db.snapshot().work[0].state).toBe('working')
    clock.now += 120_000
    expect(db.retireAbandoned().claims).toBe(1)
    expect(db.snapshot().work[0].state).toBe('released')
  })
})
