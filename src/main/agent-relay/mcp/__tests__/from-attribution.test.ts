/**
 * `from` is the join key every surface filters on, and an agent that omits
 * `--from` used to mint a card with no sender at all. `senderMatchKey('')`
 * matches no live session (every session key is non-empty), so the phone thread
 * dropped the card from EVERY thread at SessionList.tsx:430 while the verb still
 * answered "Sent to <device>" -- a card reaching the store is a send. Five
 * orphaned `show` cards were found that way, each one a picture the user asked
 * for and never saw.
 *
 * These drive the real verb handlers, because the bug was never in the render
 * guards (those were correct and simply unreachable) -- it was in what the mint
 * put on the card. The assertion seam is sendRelayPush, which receives the
 * minted request itself.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'

const { TEST_ROOT } = vi.hoisted(() => {
  const { join } = require('path')
  const { tmpdir } = require('os')
  return { TEST_ROOT: join(tmpdir(), 'mm-agent-relay-from-attribution-test') }
})

vi.mock('../../../store/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../store/paths')>()
  return {
    ...actual,
    PATHS: { ...actual.PATHS, ROOT: TEST_ROOT, AGENT_RELAY_LOG: join(TEST_ROOT, 'agent-relay-log.jsonl') }
  }
})

const sendRelayPush = vi.fn()
vi.mock('../../relay-send', () => ({
  agentRelayOffReason: () => null,
  sendRelayPush: (...args: unknown[]) => sendRelayPush(...args)
}))

/** The live session table. Real in the app, empty in a test process -- so the
 *  one row the pane match needs is supplied here. */
const sessions: Array<{ label: string; since: number; stated?: string; origin?: { tmuxPane?: string } }> = []
vi.mock('../http-listener', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../http-listener')>()
  return { ...actual, listedAgentSessions: () => sessions }
})

const PANE = '%53'

describe('a card with no --from is attributed from its origin', () => {
  let mod: typeof import('../verbs')
  let store: typeof import('../../store')
  let shot: string

  beforeEach(async () => {
    rmSync(TEST_ROOT, { recursive: true, force: true })
    mkdirSync(TEST_ROOT, { recursive: true })
    shot = join(TEST_ROOT, 'probe.png')
    writeFileSync(shot, 'fake-png-bytes')
    sessions.length = 0
    sendRelayPush.mockReset()
    sendRelayPush.mockResolvedValue({ ok: true, deviceLabel: "Pat's iPhone" })
    vi.resetModules()
    store = await import('../../store')
    mod = await import('../verbs')
  })

  afterEach(() => {
    store.relayRequestStore.resetForTests()
    rmSync(TEST_ROOT, { recursive: true, force: true })
  })

  const mintedFrom = (): string | undefined =>
    sendRelayPush.mock.calls[0]![0].params.from

  it('THE regression: show without --from lands on the pane owner, not nowhere', async () => {
    sessions.push({ label: 'showandtell - mirror-agent-replies-phone', since: 1, origin: { tmuxPane: PANE } })

    const result = await mod.VERB_HANDLERS.show!.run({
      image_path: shot,
      origin: { tmuxPane: PANE }
    })

    expect(result.isError).toBeFalsy()
    expect(mintedFrom()).toBe('showandtell - mirror-agent-replies-phone')
  })

  it('prefers `stated` over `label` -- that is the string the thread filters on', async () => {
    // senderMatchKey(s.stated ?? s.label) is the comparison at
    // SessionList.tsx:430 and agent-face.ts:72. Matching `label` when a session
    // states a name would attribute the card to a key no thread compares.
    sessions.push({
      label: 'showandtell - dev',
      stated: 'the image fixer',
      since: 1,
      origin: { tmuxPane: PANE }
    })

    await mod.VERB_HANDLERS.show!.run({ image_path: shot, origin: { tmuxPane: PANE } })

    expect(mintedFrom()).toBe('the image fixer')
  })

  it('an explicit --from always wins -- attribution never overrides the agent', async () => {
    sessions.push({ label: 'showandtell - dev', since: 1, origin: { tmuxPane: PANE } })

    await mod.VERB_HANDLERS.show!.run({
      image_path: shot,
      from: 'what I called myself',
      origin: { tmuxPane: PANE }
    })

    expect(mintedFrom()).toBe('what I called myself')
  })

  it('leaves `from` unset when the pane matches nothing, rather than guessing', async () => {
    // Attributing this to the only live session would put one agent's picture in
    // another's thread. An unattributed card is the lesser wrong.
    sessions.push({ label: 'showandtell - dev', since: 1, origin: { tmuxPane: '%99' } })

    await mod.VERB_HANDLERS.show!.run({ image_path: shot, origin: { tmuxPane: PANE } })

    expect(mintedFrom()).toBeUndefined()
  })

  it('attributes notify the same way -- every verb shares the one join key', async () => {
    sessions.push({ label: 'showandtell - dev', since: 1, origin: { tmuxPane: PANE } })

    await mod.VERB_HANDLERS.notify!.run({ body: 'build green', origin: { tmuxPane: PANE } })

    expect(mintedFrom()).toBe('showandtell - dev')
  })
})
