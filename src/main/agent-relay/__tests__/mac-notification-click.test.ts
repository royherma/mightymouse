/**
 * A click on the Mac card must GO somewhere. It used to only write a log line,
 * so tapping a notification did nothing at all while its buttons worked fine --
 * the failure reads as "deep linking is missing" rather than as a dead handler.
 *
 * The contract asserted here: a click resolves the SAME origin the HUD's
 * "Go to <agent>" button resolves, and when there is no pane to land on it
 * falls back to the deck instead of silently doing nothing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { RelayRequest } from '../store'

type Handler = (...args: unknown[]) => void

const handlers = new Map<string, Handler>()
const show = vi.fn()
const ctorArgs: unknown[] = []

class FakeNotification {
  static isSupported = (): boolean => true
  constructor(opts: unknown) {
    ctorArgs.push(opts)
  }
  on(event: string, handler: Handler): this {
    handlers.set(event, handler)
    return this
  }
  show = show
}

vi.mock('electron', () => ({ Notification: FakeNotification }))

const resolveOrigin = vi.fn<() => Promise<string>>()
const isOriginResolvable = vi.fn<() => boolean>()
vi.mock('../origin-resolver', () => ({
  resolveOrigin: () => resolveOrigin(),
  isOriginResolvable: () => isOriginResolvable()
}))

const showDeckWindow = vi.fn()
vi.mock('../../deck-window', () => ({ showDeckWindow: () => showDeckWindow() }))

const storeGet = vi.fn<() => RelayRequest | undefined>()
vi.mock('../store', () => ({
  relayRequestStore: {
    get: () => storeGet(),
    resolve: vi.fn()
  }
}))

vi.mock('../picker-keys', () => ({ sendPaneText: vi.fn() }))
vi.mock('../mcp/http-listener', () => ({ listedAgentSessions: () => [] }))

const request = {
  id: 'req-1',
  verb: 'notify',
  params: { origin: { tmuxPane: '%3' }, title: 'hi', body: 'there' }
} as unknown as RelayRequest

/** A FINISHED notify -- state !== 'progress', so wantsReply() is true and macOS
 *  draws an alert whose body cannot be clicked. This is the card the bug was on. */
const finishedNotify = {
  id: 'req-2',
  verb: 'notify',
  params: { origin: { tmuxPane: '%3' }, title: 'done', body: 'finished', state: 'done' }
} as unknown as RelayRequest

async function clickWith(resolvable: boolean, via: string): Promise<void> {
  const { showMacRelayNotification } = await import('../mac-notification')
  isOriginResolvable.mockReturnValue(resolvable)
  resolveOrigin.mockResolvedValue(via)
  storeGet.mockReturnValue(request)
  showMacRelayNotification(request)
  handlers.get('click')?.()
}

/** The deck loads through a dynamic import(), which settles a few microtasks
 *  after the click -- polling is what makes that deterministic. */
async function deckOpened(): Promise<boolean> {
  try {
    await vi.waitFor(() => expect(showDeckWindow).toHaveBeenCalled(), { timeout: 1000 })
    return true
  } catch {
    return false
  }
}

describe('mac notification click', () => {
  beforeEach(() => {
    vi.resetModules()
    handlers.clear()
    resolveOrigin.mockReset()
    isOriginResolvable.mockReset()
    showDeckWindow.mockReset()
    storeGet.mockReset()
    show.mockReset()
    ctorArgs.length = 0
  })

  it('resolves the origin -- the same destination as the HUD button', async () => {
    await clickWith(true, 'tmux-pane')
    await vi.waitFor(() => expect(resolveOrigin).toHaveBeenCalled())
    expect(await deckOpened()).toBe(false)
  })

  it('opens the deck when the origin cannot be resolved', async () => {
    await clickWith(false, 'none')
    expect(resolveOrigin).not.toHaveBeenCalled()
    expect(await deckOpened()).toBe(true)
  })

  it('falls back to the deck when every resolve strategy misses', async () => {
    await clickWith(true, 'none')
    await vi.waitFor(() => expect(resolveOrigin).toHaveBeenCalled())
    expect(await deckOpened()).toBe(true)
  })

  // The regression that shipped: the click handler was correct and still
  // unreachable, because a reply-style card never emits 'click'. Only the
  // button proves the pane is reachable from THIS card.
  it('offers a Go to agent button on a card whose body cannot be clicked', async () => {
    const { showMacRelayNotification } = await import('../mac-notification')
    isOriginResolvable.mockReturnValue(true)
    storeGet.mockReturnValue(finishedNotify)
    showMacRelayNotification(finishedNotify)
    const opts = ctorArgs.at(-1) as { hasReply: boolean; actions: { text: string }[] }
    expect(opts.hasReply).toBe(true)
    expect(opts.actions.map((a) => a.text)).toContain('Go to agent')
  })

  it('the Go to agent button resolves the origin instead of answering', async () => {
    const { showMacRelayNotification } = await import('../mac-notification')
    isOriginResolvable.mockReturnValue(true)
    resolveOrigin.mockResolvedValue('tmux-pane')
    storeGet.mockReturnValue(finishedNotify)
    showMacRelayNotification(finishedNotify)
    const opts = ctorArgs.at(-1) as { actions: { text: string }[] }
    const index = opts.actions.findIndex((a) => a.text === 'Go to agent')
    handlers.get('action')?.({}, index)
    await vi.waitFor(() => expect(resolveOrigin).toHaveBeenCalled())
  })

  it('omits the button when there is no origin to reach', async () => {
    const { showMacRelayNotification } = await import('../mac-notification')
    isOriginResolvable.mockReturnValue(false)
    storeGet.mockReturnValue(finishedNotify)
    showMacRelayNotification(finishedNotify)
    const opts = ctorArgs.at(-1) as { actions: { text: string }[] }
    expect(opts.actions).toHaveLength(0)
  })
})