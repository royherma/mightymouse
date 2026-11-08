/**
 * The handoff join, which decides whether a row reads "Handed back".
 *
 * The bug this locks down: `from` is a human NAME, and Cursor/VS Code export no
 * session-id env var, so two panes in one checkout send a byte-identical one.
 * Joining an idle ping on the name alone marked BOTH rows "Handed back" when
 * only one agent had stopped -- the user watched a session claim it had handed back
 * while it was still writing.
 *
 * Driven through the real store so the ping shape is the one `verbs.ts` mints,
 * not a hand-built map that could drift from it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'path'
import { tmpdir } from 'os'
import { mkdirSync, rmSync } from 'fs'

const TEST_ROOT = join(tmpdir(), 'mm-handoff-join-test')

vi.mock('../../store/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/paths')>()
  return {
    ...actual,
    PATHS: {
      ...actual.PATHS,
      ROOT: TEST_ROOT,
      AGENT_RELAY_LOG: join(TEST_ROOT, 'agent-relay-log.jsonl')
    }
  }
})

describe('handoffResolver', () => {
  let mod: typeof import('../store')

  beforeEach(async () => {
    rmSync(TEST_ROOT, { recursive: true, force: true })
    mkdirSync(TEST_ROOT, { recursive: true })
    vi.resetModules()
    mod = await import('../store')
  })

  afterEach(() => {
    mod.relayRequestStore.resetForTests()
    rmSync(TEST_ROOT, { recursive: true, force: true })
  })

  it('gives the handoff to the twin that pinged, never to its silent sibling', () => {
    const shared = 'ShowAndTell/dev'
    const ping = mod.relayRequestStore.mint('notify', {
      title: 'Ready for you',
      from: shared,
      sessionId: 'sess-twin-a',
      idle: true
    })

    const rows = [
      { sessionId: 'sess-twin-a', label: shared },
      { sessionId: 'sess-twin-b', label: shared }
    ]
    const idleFor = mod.handoffResolver(rows)

    expect(idleFor(rows[0]), 'the pinging twin handed back').toBe(ping.createdAt)
    // The whole bug in one assertion: the sibling shares the name and stopped
    // nothing, so it must stay blank while it keeps working.
    expect(idleFor(rows[1]), 'the silent twin must NOT inherit it').toBeUndefined()
  })

  it('still joins on the name for a lone row, so pings minted before the id survive', () => {
    // Every ping stored before `sessionId` rode the wire is name-keyed only. An
    // id-only join would blank the handoff on every existing row until its agent
    // next stopped, which reads as a regression rather than a fix.
    const ping = mod.relayRequestStore.mint('notify', {
      title: 'Ready for you',
      from: 'solo/dev',
      idle: true
    })

    const rows = [{ sessionId: 'sess-solo', label: 'solo/dev' }]
    expect(mod.handoffResolver(rows)(rows[0])).toBe(ping.createdAt)
  })

  it('withholds a name-only ping when two rows answer to that name', () => {
    // The unsafe half of the fallback above: with no id on the ping there is no
    // way to tell which twin stopped, so neither may claim it. Blank is the only
    // honest answer -- guessing is what put "Handed back" on a live agent.
    const shared = 'ShowAndTell/dev'
    mod.relayRequestStore.mint('notify', { title: 'Ready', from: shared, idle: true })

    const rows = [
      { sessionId: 'sess-twin-a', label: shared },
      { sessionId: 'sess-twin-b', label: shared }
    ]
    const idleFor = mod.handoffResolver(rows)
    expect(idleFor(rows[0])).toBeUndefined()
    expect(idleFor(rows[1])).toBeUndefined()
  })

  it('prefers the stated name over the derived label, matching what the card shows', () => {
    // A named session joins on the name a person sees, not the repo/branch
    // string underneath it -- the same key `sessionRow` renders from.
    const ping = mod.relayRequestStore.mint('notify', {
      title: 'Ready',
      from: 'the-relay-fix',
      idle: true
    })

    const rows = [{ sessionId: 'sess-named', stated: 'the-relay-fix', label: 'ShowAndTell/dev' }]
    expect(mod.handoffResolver(rows)(rows[0])).toBe(ping.createdAt)
  })
})
