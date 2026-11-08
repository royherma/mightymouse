/**
 * ask/approve/show at the handler layer, against the real store (fake
 * timers) so awaitResolution's own listener wiring is exercised rather than
 * mocked away. relay-send and the screenshot capture are the only mocks --
 * this suite never touches a socket or the filesystem for a real image.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const TEST_ROOT = join(tmpdir(), 'mm-agent-relay-verbs-test')

vi.mock('../../../store/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../store/paths')>()
  return {
    ...actual,
    PATHS: { ...actual.PATHS, ROOT: TEST_ROOT, AGENT_RELAY_LOG: join(TEST_ROOT, 'agent-relay-log.jsonl') }
  }
})

const agentRelayOffReason = vi.fn<() => string | null>(() => null)
const sendRelayPush = vi.fn()
vi.mock('../../relay-send', () => ({
  agentRelayOffReason: () => agentRelayOffReason(),
  sendRelayPush: (...args: unknown[]) => sendRelayPush(...args)
}))

const captureScreenshot = vi.fn<() => Promise<string | null>>()
vi.mock('../../../platform', () => ({
  captureScreenshot: () => captureScreenshot()
}))

describe('ask / approve / show verb handlers', () => {
  let mod: typeof import('../verbs')
  let store: typeof import('../../store')

  beforeEach(async () => {
    rmSync(TEST_ROOT, { recursive: true, force: true })
    mkdirSync(TEST_ROOT, { recursive: true })
    vi.useFakeTimers()
    vi.resetModules()
    agentRelayOffReason.mockReset()
    agentRelayOffReason.mockReturnValue(null)
    sendRelayPush.mockReset()
    sendRelayPush.mockResolvedValue({ ok: true, deviceLabel: "Roy's iPhone" })
    captureScreenshot.mockReset()
    store = await import('../../store')
    mod = await import('../verbs')
  })

  afterEach(() => {
    store.relayRequestStore.resetForTests()
    vi.useRealTimers()
    rmSync(TEST_ROOT, { recursive: true, force: true })
  })

  /** Clear a card AND run out its undo window. `dismiss` alone only takes the
   *  card off the surfaces -- the agent is deliberately not told until the
   *  window closes, so anything awaiting the verb hangs without this. */
  const dismissAndDeliver = (id: string, deviceId: string): void => {
    store.relayRequestStore.dismiss(id, deviceId)
    vi.advanceTimersByTime(store.RELAY_UNDO_WINDOW_MS)
  }

  it('ask resolves via chip when the phone taps an option', async () => {
    const runPromise = mod.VERB_HANDLERS.ask!.run({ question: 'which db?', options: ['sqlite', 'postgres'] })
    await vi.waitFor(() => expect(store.relayRequestStore.listPending()).toHaveLength(1))
    const pending = store.relayRequestStore.listPending()[0]!

    store.relayRequestStore.resolve(pending.id, { answer: 'postgres' }, 'device-a', 'chip')
    const result = await runPromise

    expect(JSON.parse(result.content[0]!.text)).toEqual({ answer: 'postgres', via: 'chip' })
  })

  it('ask resolves via typed when the phone free-types an answer', async () => {
    const runPromise = mod.VERB_HANDLERS.ask!.run({ question: 'name this table?' })
    await vi.waitFor(() => expect(store.relayRequestStore.listPending()).toHaveLength(1))
    const pending = store.relayRequestStore.listPending()[0]!

    store.relayRequestStore.resolve(pending.id, { answer: 'user_events' }, 'device-a', 'typed')
    const result = await runPromise

    expect(JSON.parse(result.content[0]!.text)).toEqual({ answer: 'user_events', via: 'typed' })
  })

  it('approve never auto-approves on timeout -- times out to approved:false with reason timeout', async () => {
    const runPromise = mod.VERB_HANDLERS.approve!.run({ action: 'deploy prod', risk: 'high', timeout_s: 1 })
    await vi.waitFor(() => expect(store.relayRequestStore.listPending()).toHaveLength(1))

    vi.advanceTimersByTime(1_001)
    const result = await runPromise

    expect(JSON.parse(result.content[0]!.text)).toEqual({
      approved: false,
      note: undefined,
      reason: 'timeout'
    })
  })

  it('approve never auto-approves on dismiss either -- clearing a card is not consent', async () => {
    const runPromise = mod.VERB_HANDLERS.approve!.run({ action: 'drop the users table', risk: 'high' })
    await vi.waitFor(() => expect(store.relayRequestStore.listPending()).toHaveLength(1))
    const pending = store.relayRequestStore.listPending()[0]!

    dismissAndDeliver(pending.id, 'device-a')
    const result = await runPromise

    expect(JSON.parse(result.content[0]!.text)).toEqual({
      approved: false,
      note: undefined,
      reason: 'dismissed'
    })
  })

  it('a dismissed ask tells the agent it was cleared, distinctly from a timeout', async () => {
    const runPromise = mod.VERB_HANDLERS.ask!.run({ question: 'which db?', options: ['postgres'] })
    await vi.waitFor(() => expect(store.relayRequestStore.listPending()).toHaveLength(1))
    const pending = store.relayRequestStore.listPending()[0]!

    dismissAndDeliver(pending.id, 'device-a')
    const result = await runPromise

    // isError so the agent treats it as a non-answer, and the word "Dismissed"
    // so it can tell a decision from silence.
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain('Dismissed')
    expect(result.content[0]!.text).not.toContain('Timed out')
  })

  it('dismiss is a no-op once a request has been answered -- first settle wins', async () => {
    const runPromise = mod.VERB_HANDLERS.ask!.run({ question: 'which db?' })
    await vi.waitFor(() => expect(store.relayRequestStore.listPending()).toHaveLength(1))
    const pending = store.relayRequestStore.listPending()[0]!

    store.relayRequestStore.resolve(pending.id, { answer: 'postgres' }, 'device-a', 'typed')
    expect(store.relayRequestStore.dismiss(pending.id, 'device-b')).toBe('already-resolved')

    const result = await runPromise
    expect(JSON.parse(result.content[0]!.text).answer).toBe('postgres')
  })

  it('an answer arriving after a dismiss is refused rather than overwriting it', async () => {
    const runPromise = mod.VERB_HANDLERS.ask!.run({ question: 'which db?' })
    await vi.waitFor(() => expect(store.relayRequestStore.listPending()).toHaveLength(1))
    const pending = store.relayRequestStore.listPending()[0]!

    dismissAndDeliver(pending.id, 'device-a')
    expect(store.relayRequestStore.resolve(pending.id, { answer: 'sqlite' }, 'device-b', 'typed')).toBe(
      'already-resolved'
    )

    const result = await runPromise
    expect(result.content[0]!.text).toContain('Dismissed')
  })

  it('a dismissed request leaves pending and does not pose as something you answered', async () => {
    const runPromise = mod.VERB_HANDLERS.ask!.run({ question: 'which db?' })
    await vi.waitFor(() => expect(store.relayRequestStore.listPending()).toHaveLength(1))
    const pending = store.relayRequestStore.listPending()[0]!

    dismissAndDeliver(pending.id, 'device-a')

    expect(store.relayRequestStore.listPending()).toHaveLength(0)
    expect(store.relayRequestStore.listRecentResolved(10).map((r) => r.id)).not.toContain(pending.id)
    expect(store.relayRequestStore.listDismissed(10).map((r) => r.id)).toContain(pending.id)

    await runPromise
  })

  it('approve carries risk:high through to the minted request for the response-path unlock gate', async () => {
    const runPromise = mod.VERB_HANDLERS.approve!.run({ action: 'drop table users', risk: 'high' })
    await vi.waitFor(() => expect(store.relayRequestStore.listPending()).toHaveLength(1))
    const pending = store.relayRequestStore.listPending()[0]!

    expect(pending.params.risk).toBe('high')

    store.relayRequestStore.resolve(pending.id, { approved: true }, 'device-a', 'chip')
    await runPromise
  })

  it('approve returns approved:true with a note when explicitly approved', async () => {
    const runPromise = mod.VERB_HANDLERS.approve!.run({ action: 'run migration' })
    await vi.waitFor(() => expect(store.relayRequestStore.listPending()).toHaveLength(1))
    const pending = store.relayRequestStore.listPending()[0]!

    store.relayRequestStore.resolve(pending.id, { approved: true, note: 'looks safe' }, 'device-a', 'chip')
    const result = await runPromise

    expect(JSON.parse(result.content[0]!.text)).toEqual({
      approved: true,
      note: 'looks safe',
      reason: undefined
    })
  })

  it('show with capture:true screenshots the Mac and sends without blocking', async () => {
    captureScreenshot.mockResolvedValue('/tmp/rewrite-ctx-shot.png')

    const result = await mod.VERB_HANDLERS.show!.run({ capture: true })

    expect(captureScreenshot).toHaveBeenCalled()
    expect(sendRelayPush).toHaveBeenCalledWith(
      expect.objectContaining({ params: expect.objectContaining({ imagePath: '/tmp/rewrite-ctx-shot.png' }) })
    )
    expect(result.isError).toBeFalsy()
    expect(result.content[0]!.text).toBe("Sent to Roy's iPhone.")
  })

  it('show with capture:true surfaces an actionable error when the screenshot fails', async () => {
    captureScreenshot.mockResolvedValue(null)

    const result = await mod.VERB_HANDLERS.show!.run({ capture: true })

    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toMatch(/Screen Recording permission/)
    expect(sendRelayPush).not.toHaveBeenCalled()
  })

  it('show with a bad image_path fails before minting anything', async () => {
    const badPath = join(TEST_ROOT, 'does-not-exist.png')
    expect(existsSync(badPath)).toBe(false)

    const result = await mod.VERB_HANDLERS.show!.run({ image_path: badPath })

    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain(badPath)
    expect(sendRelayPush).not.toHaveBeenCalled()
  })

  it('show with a real image_path and wait_for_ack blocks until acked', async () => {
    const goodPath = join(TEST_ROOT, 'diff.png')
    writeFileSync(goodPath, 'fake-png-bytes')

    const runPromise = mod.VERB_HANDLERS.show!.run({ image_path: goodPath, wait_for_ack: true })
    await vi.waitFor(() => expect(store.relayRequestStore.listPending()).toHaveLength(1))
    const pending = store.relayRequestStore.listPending()[0]!

    store.relayRequestStore.resolve(pending.id, { acked: true }, 'device-a', 'screen')
    const result = await runPromise

    expect(JSON.parse(result.content[0]!.text)).toEqual({ acked: true })
  })

  /**
   * The picture is what makes a card decidable in ONE tap: an `ask` that shows
   * the thing it is asking about needs no second card and no context switch.
   * Three surfaces had to widen together for that -- this handler, the server's
   * /relay-image gate (which returned 404 for any verb but `show`), and the NSE
   * attachment fetch. Nothing typechecks across those three, so these lock the
   * half that can be tested in-process.
   */
  it('ask carries a captured screenshot on the same card as the question', async () => {
    captureScreenshot.mockResolvedValue('/tmp/ask-shot.png')

    const runPromise = mod.VERB_HANDLERS.ask!.run({ question: 'Does this look right?', capture: true })
    await vi.waitFor(() => expect(store.relayRequestStore.listPending()).toHaveLength(1))
    const pending = store.relayRequestStore.listPending()[0]!

    expect(captureScreenshot).toHaveBeenCalled()
    expect(pending.params.imagePath).toBe('/tmp/ask-shot.png')

    store.relayRequestStore.resolve(pending.id, { answer: 'yes' }, 'device-a', 'screen')
    await runPromise
  })

  it('approve carries an image_path so a destructive call is not approved blind', async () => {
    const goodPath = join(TEST_ROOT, 'migration.png')
    writeFileSync(goodPath, 'fake-png-bytes')

    const runPromise = mod.VERB_HANDLERS.approve!.run({ action: 'Drop the table', image_path: goodPath })
    await vi.waitFor(() => expect(store.relayRequestStore.listPending()).toHaveLength(1))
    const pending = store.relayRequestStore.listPending()[0]!

    expect(pending.params.imagePath).toBe(goodPath)

    store.relayRequestStore.resolve(pending.id, { approved: false }, 'device-a', 'screen')
    await runPromise
  })

  // The shared resolver means one permission-copy fix reaches all three verbs.
  // If this regresses, ask silently sends a card with no picture instead of
  // telling the agent to grant Screen Recording -- a failure with no symptom.
  it('a failed capture on ask errors before minting, like show', async () => {
    captureScreenshot.mockResolvedValue(null)

    const result = await mod.VERB_HANDLERS.ask!.run({ question: 'q', capture: true })

    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toMatch(/Screen Recording permission/)
    expect(store.relayRequestStore.listPending()).toHaveLength(0)
    expect(sendRelayPush).not.toHaveBeenCalled()
  })

  it('relay-off guard fires before any verb mints a request', async () => {
    agentRelayOffReason.mockReturnValue('Agent relay is off in MightyMouse Settings.')

    const askResult = await mod.VERB_HANDLERS.ask!.run({ question: 'q' })
    const approveResult = await mod.VERB_HANDLERS.approve!.run({ action: 'a' })
    const showResult = await mod.VERB_HANDLERS.show!.run({ capture: true })

    expect(askResult.isError).toBe(true)
    expect(approveResult.isError).toBe(true)
    expect(showResult.isError).toBe(true)
    expect(store.relayRequestStore.listPending()).toHaveLength(0)
  })
})
