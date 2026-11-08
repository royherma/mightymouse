/**
 * Retiring the "your turn" lock-screen card when a person types into the session.
 *
 * The bug this locks down: an idle notify settles at mint (it asks nothing), so
 * it never reaches the store's change feed as a retirement and the clear-push
 * wiring on `onRelayStoreChanged` never fires for it. The card sat on the lock
 * screen looking tappable forever, long after the session had moved on -- the user,
 * on device, with "Tell it what's next" still offered on a turn he had already
 * taken. `UserPromptSubmit` is the signal it is dead: typing answers "your
 * turn" by construction.
 *
 * Driven through the real store so the ping shape is the one `verbs.ts` mints.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'path'
import { tmpdir } from 'os'
import { mkdirSync, rmSync } from 'fs'

const TEST_ROOT = join(tmpdir(), 'mm-idle-card-clear-test')

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

describe('idleNotifiesForSession', () => {
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

  it('finds the idle ping for the session that was typed into', () => {
    const ping = mod.relayRequestStore.mint('notify', {
      title: 'Your turn',
      from: 'ShowAndTell/dev',
      sessionId: 'sess-a',
      idle: true
    })

    const found = mod.relayRequestStore.idleNotifiesForSession('sess-a', undefined)
    expect(found.map((r) => r.id)).toEqual([ping.id])
  })

  it('never returns another session id ping', () => {
    mod.relayRequestStore.mint('notify', {
      title: 'Your turn',
      from: 'ShowAndTell/dev',
      sessionId: 'sess-b',
      idle: true
    })

    // The whole point of keying on the id: two panes in one checkout share a
    // `from`, so a name-only match would clear the sibling's live card too.
    expect(mod.relayRequestStore.idleNotifiesForSession('sess-a', undefined)).toEqual([])
  })

  it('falls back to the sender name for pings from a shim too old to send an id', async () => {
    const ping = mod.relayRequestStore.mint('notify', {
      title: 'Your turn',
      from: 'solo/dev',
      idle: true
    })

    const { senderMatchKey } = await import('../../../shared/relay-cards')
    const found = mod.relayRequestStore.idleNotifiesForSession(
      'sess-solo',
      senderMatchKey('solo/dev')
    )
    expect(found.map((r) => r.id)).toEqual([ping.id])
  })

  it('ignores a non-idle notify: only "your turn" is answered by typing', () => {
    mod.relayRequestStore.mint('notify', {
      title: 'Build finished',
      from: 'ShowAndTell/dev',
      sessionId: 'sess-a'
    })

    expect(mod.relayRequestStore.idleNotifiesForSession('sess-a', undefined)).toEqual([])
  })

  it('ignores a show card, which stays on the phone deliberately', () => {
    // A `show` is delivered CONTENT, not a question. Typing in the session does
    // not invalidate an image someone may still want to look at, so it must
    // survive the sweep that retires the asks.
    mod.relayRequestStore.mint('show', {
      title: 'Screenshot',
      from: 'ShowAndTell/dev',
      sessionId: 'sess-a'
    })

    expect(mod.relayRequestStore.idleNotifiesForSession('sess-a', undefined)).toEqual([])
  })
})
