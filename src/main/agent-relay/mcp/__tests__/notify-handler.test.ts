/**
 * The notify verb end-to-end at the handler layer: relay-off guard fires
 * before mint, a successful push returns the device label, and a failed
 * send stays a soft warning (§6c: send failing must not fail the tool call,
 * since the request already lives in the store for the HUD/Code sheet).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { RelayRequest } from '../../store'

const agentRelayOffReason = vi.fn<() => string | null>()
const sendRelayPush = vi.fn()
vi.mock('../../relay-send', () => ({
  agentRelayOffReason: () => agentRelayOffReason(),
  sendRelayPush: (request: RelayRequest) => sendRelayPush(request)
}))

const mint = vi.fn()
vi.mock('../../store', () => ({
  relayRequestStore: { mint: (...args: unknown[]) => mint(...args) },
  onRelayStoreChanged: vi.fn(() => () => {}),
  // A real value, not a stub: verbs.ts builds notify's zod schema from it at
  // import time, so a mock missing it throws before any test body runs.
  RELAY_NOTIFY_STATES: ['done', 'progress']
}))

function mintedRequest(overrides: Partial<RelayRequest> = {}): RelayRequest {
  return {
    id: 'req-1',
    verb: 'notify',
    params: { title: 'Build finished' },
    createdAt: Date.now(),
    timeoutMs: 1_000,
    status: 'resolved',
    response: {},
    resolvedAt: Date.now(),
    resolvedBy: null,
    resolvedVia: null,
    ...overrides
  }
}

describe('notify verb handler', () => {
  beforeEach(() => {
    vi.resetModules()
    agentRelayOffReason.mockReset()
    sendRelayPush.mockReset()
    mint.mockReset()
  })

  it('fails fast with the relay-off guide string and never mints a request', async () => {
    agentRelayOffReason.mockReturnValue(
      'Agent relay is off in MightyMouse Settings. Turn it on to let this agent reach your phone.'
    )
    const { VERB_HANDLERS } = await import('../verbs')

    const result = await VERB_HANDLERS.notify!.run({ title: 'Build finished' })

    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toBe(
      'Agent relay is off in MightyMouse Settings. Turn it on to let this agent reach your phone.'
    )
    expect(mint).not.toHaveBeenCalled()
    expect(sendRelayPush).not.toHaveBeenCalled()
  })

  it('mints and sends, returning the device label on success', async () => {
    agentRelayOffReason.mockReturnValue(null)
    mint.mockReturnValue(mintedRequest())
    sendRelayPush.mockResolvedValue({ ok: true, deviceLabel: "Pat's iPhone" })
    const { VERB_HANDLERS } = await import('../verbs')

    const result = await VERB_HANDLERS.notify!.run({ title: 'Build finished' })

    expect(mint).toHaveBeenCalledWith(
      'notify',
      expect.objectContaining({ title: 'Build finished' })
    )
    expect(result.isError).toBeFalsy()
    expect(result.content[0]?.text).toBe("Sent to Pat's iPhone.")
  })

  it('mints the request even when the push send fails, and returns a soft warning not an error', async () => {
    agentRelayOffReason.mockReturnValue(null)
    mint.mockReturnValue(mintedRequest())
    sendRelayPush.mockResolvedValue({
      ok: false,
      reason: 'no-device',
      detail: 'No phone paired yet. Pair one in MightyMouse Settings to get pushes.'
    })
    const { VERB_HANDLERS } = await import('../verbs')

    const result = await VERB_HANDLERS.notify!.run({ title: 'Build finished' })

    expect(mint).toHaveBeenCalled()
    expect(result.isError).toBeFalsy()
    expect(result.content[0]?.text).toBe(
      "Saved, but the push didn't go out: No phone paired yet. Pair one in MightyMouse Settings to get pushes."
    )
  })

  // Pins what stops a card contradicting its own body: the headline is DERIVED
  // from the state, never worded by the caller.
  describe('state drives the headline', () => {
    beforeEach(() => {
      agentRelayOffReason.mockReturnValue(null)
      mint.mockReturnValue(mintedRequest())
      sendRelayPush.mockResolvedValue({ ok: true, deviceLabel: "Pat's iPhone" })
    })

    // 'waiting' is GONE, not reworded. A notify settles inside
    // mint(), so it never waited on anyone, and its "Waiting on You" headline
    // read exactly like `ask` -- the one verb that blocks and renders reply
    // buttons. Rejected rather than remapped: silently landing it on 'done'
    // would tell someone a stopped agent had finished.
    it('refuses the deleted waiting state instead of mapping it to a neighbour', async () => {
      const { VERB_HANDLERS } = await import('../verbs')
      const { state } = VERB_HANDLERS.notify!.inputSchema

      expect(state!.safeParse('waiting').success).toBe(false)
      expect(state!.safeParse('done').success).toBe(true)
    })

    // Same defect as 'waiting', one state over: it printed
    // "⛔ Can't Continue" on a card that resolves at mint, so the outcome line
    // read "Delivered" under a demand and the buttons that would unblock the
    // agent did not exist. Rejected, not remapped -- 'progress' would claim a
    // stopped agent was still working. `approve` is the verb it meant.
    it('refuses the deleted blocked state instead of mapping it to a neighbour', async () => {
      const { VERB_HANDLERS } = await import('../verbs')
      const { state } = VERB_HANDLERS.notify!.inputSchema

      expect(state!.safeParse('blocked').success).toBe(false)
      expect(state!.safeParse('progress').success).toBe(true)
    })

    // ❓ is how the lock screen tells an answerable card from an unanswerable
    // one -- `ask` carries it, and a notify resolves at mint, so none of these
    // can take a reply. A state glyph leaking it would put a question mark on
    // a card whose buttons do not exist.
    it('never puts the ask glyph on a notify, whatever the state', async () => {
      const { VERB_HANDLERS } = await import('../verbs')

      for (const state of ['done', 'progress'] as const) {
        mint.mockClear()
        await VERB_HANDLERS.notify!.run({ state })
        expect(mint.mock.calls[0][1].title).not.toContain('❓')
      }
    })

    it('keeps a stated title when nobody is claimed to be waiting', async () => {
      const { VERB_HANDLERS } = await import('../verbs')

      await VERB_HANDLERS.notify!.run({ state: 'done', title: 'Deploy green', body: 'All 42 pass.' })

      expect(mint).toHaveBeenCalledWith(
        'notify',
        expect.objectContaining({ title: 'Deploy green' })
      )
    })

    it('derives a title for every state, so no state can mint a blank headline', async () => {
      const { VERB_HANDLERS } = await import('../verbs')
      const expected = {
        done: '✅ All Done',
        progress: '⏳ Still Working'
      } as const

      for (const [state, title] of Object.entries(expected)) {
        mint.mockClear()
        await VERB_HANDLERS.notify!.run({ state: state as keyof typeof expected })
        expect(mint).toHaveBeenCalledWith('notify', expect.objectContaining({ title, state }))
      }
    })

    // Fire-and-forget means nobody is on the other end by construction, so an
    // unstated notify is 'done' -- resolved here rather than at each render
    // site, where the phone, HUD and cloud fallback would each pick their own.
    it("defaults an unstated notify to 'done'", async () => {
      const { VERB_HANDLERS } = await import('../verbs')

      await VERB_HANDLERS.notify!.run({ title: 'Deploy #412 live' })

      expect(mint).toHaveBeenCalledWith('notify', expect.objectContaining({ state: 'done' }))
    })

    // The state writes the headline, but news that IS its own headline should
    // not be forced under a generic status word.
    it('lets an explicit title override the state title, keeping the state', async () => {
      const { VERB_HANDLERS } = await import('../verbs')

      await VERB_HANDLERS.notify!.run({ title: 'Deploy #412 live', state: 'done' })

      expect(mint).toHaveBeenCalledWith(
        'notify',
        expect.objectContaining({ title: 'Deploy #412 live', state: 'done' })
      )
    })

    it('passes idle through to mint only when it is true', async () => {
      const { VERB_HANDLERS } = await import('../verbs')

      await VERB_HANDLERS.notify!.run({ title: 'Ready for you', idle: true })
      expect(mint).toHaveBeenCalledWith('notify', expect.objectContaining({ idle: true }))

      mint.mockClear()
      await VERB_HANDLERS.notify!.run({ title: 'Build finished' })
      expect(mint.mock.calls[0][1].idle).toBeUndefined()
    })

    it('carries the idle recap through mint, stripped of markdown', async () => {
      const { VERB_HANDLERS } = await import('../verbs')

      await VERB_HANDLERS.notify!.run({
        title: 'Ready for you',
        idle: true,
        last: 'Fixed the **login** redirect, tests green'
      })
      expect(mint).toHaveBeenCalledWith(
        'notify',
        expect.objectContaining({ last: 'Fixed the login redirect, tests green' })
      )
    })
  })
})
