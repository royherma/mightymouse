import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mocked at the platform boundary rather than the binary: these tests are about
// the decision layer -- what gets pressed, what counts as proof, what is spoken
// -- and mm-ax's own behaviour is verified by running it against the real app.
const { activateApp, frontmostBundleId, waitForFrontmost, axPress, spawnSync } = vi.hoisted(
  () => ({
    activateApp: vi.fn(() => true),
    frontmostBundleId: vi.fn(() => 'com.openai.codex'),
    waitForFrontmost: vi.fn(async () => {}),
    axPress: vi.fn(),
    spawnSync: vi.fn(() => ({ status: 0 }))
  })
)

vi.mock('../platform', () => ({
  context: { activateApp, frontmostBundleId, waitForFrontmost, axPress }
}))

// `frontChatGpt` falls back to `open -b` when activateApp fails, so a test that
// mocks only the platform boundary shells out for real: ChatGPT LAUNCHES on the
// machine running the suite, exits 0, and the app-missing case reports success.
vi.mock('child_process', () => ({ spawnSync }))

import {
  startChatGptVoice,
  stopChatGptVoice,
  runIntentAction,
  describeFailure,
  CHATGPT_BUNDLE_ID
} from '../intent-actions'

/** The shape mm-ax resolves with, so a test names only what it varies. */
function axResult(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { status: 'ok', verified: true, pressed: 'Start voice chat', ms: 120, ...over }
}

beforeEach(() => {
  activateApp.mockReset().mockReturnValue(true)
  frontmostBundleId.mockReset().mockReturnValue(CHATGPT_BUNDLE_ID)
  waitForFrontmost.mockReset().mockResolvedValue(undefined)
  axPress.mockReset().mockResolvedValue(axResult())
  spawnSync.mockReset().mockReturnValue({ status: 0 })
})

describe('startChatGptVoice', () => {
  it('presses a voice button and reports success once verified', async () => {
    const result = await startChatGptVoice()
    expect(result.ok).toBe(true)
    const [req] = axPress.mock.calls[0]
    expect(req.bundleId).toBe(CHATGPT_BUNDLE_ID)
    // Both entry points offered: which one exists depends on the current view.
    expect(req.press).toEqual(['Start voice chat', 'Start new voice chat'])
  })

  it('guards against restarting a call that is already running', async () => {
    // The real failure this prevents: without an already-guard, the sidebar's
    // "Start new voice chat" button is pressable DURING a call, so asking
    // twice ends the session the user is in and opens a fresh one.
    const [req] = (await startChatGptVoice(), axPress.mock.calls[0])
    expect(req.already).toEqual(['Stop voice chat'])
  })

  it('proves the call started rather than trusting the press', async () => {
    const [req] = (await startChatGptVoice(), axPress.mock.calls[0])
    expect(req.verify).toEqual(['Stop voice chat'])
  })

  it('says it was already on, without claiming to have started it', async () => {
    axPress.mockResolvedValue(axResult({ status: 'already', verified: true, pressed: undefined }))
    const result = await startChatGptVoice()
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.spoken).toMatch(/already/i)
    expect(result.meta.alreadyInState).toBe(true)
  })

  it('does not claim success when the press could not be confirmed', async () => {
    // The dangerous case: the press was DELIVERED, so a naive implementation
    // reports success while the user sits in silence waiting for a call that
    // never opened.
    axPress.mockResolvedValue(axResult({ status: 'unverified', verified: false }))
    const result = await startChatGptVoice()
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('unverified')
  })

  it('never searches for a control when the app could not be raised', async () => {
    // Both doors: activateApp is the warm path, `open -b` the cold launch.
    // Raised means neither worked -- ChatGPT is not installed.
    activateApp.mockReturnValue(false)
    spawnSync.mockReturnValue({ status: 1 })
    const result = await startChatGptVoice()
    expect(result.ok).toBe(false)
    expect(axPress).not.toHaveBeenCalled()
  })

  it('reports a renamed or missing button as its own failure', async () => {
    // Distinct from app-missing because the fix is different: the app is fine,
    // its UI changed, and that is the signal telling us the labels need updating.
    axPress.mockResolvedValue(axResult({ status: 'not-found', verified: false }))
    const result = await startChatGptVoice()
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('control-missing')
  })

  it('carries structured metadata for a log line', async () => {
    axPress.mockResolvedValue(
      axResult({ pressed: 'Start new voice chat', confirmedBy: 'Stop voice chat', ms: 340 })
    )
    const result = await startChatGptVoice()
    if (!result.ok) throw new Error('unreachable')
    expect(result.meta).toMatchObject({
      action: 'startChatGptVoice',
      bundleId: CHATGPT_BUNDLE_ID,
      method: 'accessibility',
      verified: true,
      pressed: 'Start new voice chat',
      confirmedBy: 'Stop voice chat',
      ms: 340
    })
  })
})

describe('stopChatGptVoice', () => {
  it('presses stop', async () => {
    const result = await stopChatGptVoice()
    expect(result.ok).toBe(true)
    const [req] = axPress.mock.calls[0]
    expect(req.press).toEqual(['Stop voice chat'])
  })

  it('treats a missing stop button as already off, not as an error', async () => {
    // A voice session bills while open, so "turn it off" must succeed when it
    // is already off -- reporting failure would push a user to try again.
    axPress.mockResolvedValue(
      axResult({ status: 'not-found', verified: false, pressed: undefined })
    )
    const result = await stopChatGptVoice()
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.spoken).toMatch(/already off/i)
  })

  it('does not raise the app first', async () => {
    // Stopping must work with ChatGPT in the background: the user said it out
    // loud and is not looking at the screen.
    await stopChatGptVoice()
    expect(activateApp).not.toHaveBeenCalled()
  })
})

describe('runIntentAction', () => {
  it('runs a known action', async () => {
    const result = await runIntentAction('startChatGptVoice')
    expect(result.ok).toBe(true)
  })

  it('refuses an unknown name', async () => {
    const result = await runIntentAction('rm -rf /')
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('unknown-action')
    expect(axPress).not.toHaveBeenCalled()
  })

  it('refuses inherited Object members', async () => {
    // The name arrives off the network. `name in ACTIONS` would walk the
    // prototype chain and resolve every one of these to a real function.
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const result = await runIntentAction(name)
      if (result.ok) throw new Error(`${name} resolved to an action`)
      expect(result.reason).toBe('unknown-action')
    }
    expect(axPress).not.toHaveBeenCalled()
  })
})

describe('describeFailure', () => {
  it('returns a speakable sentence for every reason', () => {
    const reasons = [
      'unknown-action',
      'app-missing',
      'control-missing',
      'unverified',
      'failed'
    ] as const
    for (const reason of reasons) {
      const sentence = describeFailure(reason)
      // A reason code read aloud is useless to someone who is not looking at
      // a screen, which is every caller of this.
      expect(sentence).not.toContain(reason)
      expect(sentence.length).toBeGreaterThan(20)
      expect(sentence.trimEnd()).toMatch(/[.!]$/)
    }
  })
})
