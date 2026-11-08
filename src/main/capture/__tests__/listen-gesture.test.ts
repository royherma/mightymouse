// The listen gesture machine — tap, double-tap, long-press, and the release-grace
// blip guard.
//
// Worth testing now because it just became testable: this logic used to be inline
// in the uiohook keydown/keyup callbacks, reachable only through a global OS hook.
// It's shared by TWO input sources (the ⌘⌥⇧L chord and the fn key, which arrives
// from a native CGEvent tap), so a regression here silently breaks one of them.
//
// Edges are driven directly rather than through uiohook: the machine takes a press
// and a release, and knows nothing about where they came from — which is exactly
// the property that lets fn reuse it.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CONFIG } from '../../../shared/config'

vi.mock('./uiohook-manager', () => ({
  acquire: () => () => {},
  isAvailable: () => false,
  on: () => () => {}
}))

import {
  handleListenPress,
  handleListenRelease,
  __resetListenStateForTests,
  type Handlers
} from '../capture-hotkey'

/** Only the listen-relevant handlers do anything here; the rest satisfy the type. */
function makeHandlers(sessionActive = false): Handlers {
  const noop = (): void => {}
  return {
    onTap: noop,
    onHoldStart: noop,
    onPressWhileRecording: noop,
    isRecording: () => false,
    onRewrite: noop,
    onListen: vi.fn(),
    isListenSessionActive: vi.fn(() => sessionActive),
    onListenDoubleTap: vi.fn(),
    onListenHoldSmart: vi.fn(),
    onListenHoldProgress: vi.fn(),
    onListenRouteNow: noop,
    onListenSubmitNow: noop,
    canSubmitListen: () => false,
    onHistory: noop,
    onMain: noop,
    onChat: noop,
    onSuggest: noop,
    onStop: noop,
    onToggleSelectionBar: noop,
    onArmCancel: noop,
    isCapturing: () => false
  }
}

/** The 60ms debounce a release waits out before it's trusted. Kept as a local
 *  literal, not an import: the module deliberately doesn't export it, and a test
 *  that reads the value from the code under test can't catch it changing. */
const RELEASE_GRACE_MS = 60

const flags = CONFIG as { LISTEN_DOUBLE_TAP_HANDS_FREE: boolean }
const shippedDoubleTap = flags.LISTEN_DOUBLE_TAP_HANDS_FREE

describe('listen gesture machine', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    __resetListenStateForTests()
    flags.LISTEN_DOUBLE_TAP_HANDS_FREE = true
  })

  afterEach(() => {
    flags.LISTEN_DOUBLE_TAP_HANDS_FREE = shippedDoubleTap
    __resetListenStateForTests()
    vi.useRealTimers()
  })

  it('with double-tap hands-free off, a quick second tap stops the session instead', () => {
    flags.LISTEN_DOUBLE_TAP_HANDS_FREE = false
    const h = makeHandlers(false)
    handleListenPress(h)
    handleListenRelease(h)
    vi.advanceTimersByTime(RELEASE_GRACE_MS + 1)
    vi.mocked(h.isListenSessionActive).mockReturnValue(true)

    vi.advanceTimersByTime(CONFIG.LISTEN_DOUBLE_TAP_MS - RELEASE_GRACE_MS - 10)
    handleListenPress(h)
    handleListenRelease(h)
    vi.advanceTimersByTime(RELEASE_GRACE_MS + 1)

    expect(h.onListenDoubleTap).not.toHaveBeenCalled()
    expect(h.onListen).toHaveBeenCalledTimes(2)
  })

  it('a tap with no session running starts one, and does not toggle it back off', () => {
    const h = makeHandlers(false)
    handleListenPress(h)
    expect(h.onListen).toHaveBeenCalledTimes(1)

    handleListenRelease(h)
    vi.advanceTimersByTime(RELEASE_GRACE_MS + 1)
    // Released before the smart threshold, but THIS press is the one that started
    // the session — so it keeps running rather than being toggled straight off.
    expect(h.onListen).toHaveBeenCalledTimes(1)
    expect(h.onListenHoldSmart).not.toHaveBeenCalled()
  })

  it('a tap landing on a running session stops it on release', () => {
    const h = makeHandlers(true)
    handleListenPress(h)
    // Session already live: the press must NOT toggle immediately, because the
    // hold might still upgrade it to smart dictation.
    expect(h.onListen).not.toHaveBeenCalled()

    handleListenRelease(h)
    vi.advanceTimersByTime(RELEASE_GRACE_MS + 1)
    // Released before the threshold = a deliberate second tap to stop.
    expect(h.onListen).toHaveBeenCalledTimes(1)
  })

  it('two presses inside the double-tap window go hands-free', () => {
    const h = makeHandlers(false)
    handleListenPress(h)
    handleListenRelease(h)
    vi.advanceTimersByTime(RELEASE_GRACE_MS + 1)

    vi.advanceTimersByTime(CONFIG.LISTEN_DOUBLE_TAP_MS - RELEASE_GRACE_MS - 10)
    handleListenPress(h)

    expect(h.onListenDoubleTap).toHaveBeenCalledTimes(1)
    // The hands-free press must not ALSO arm a smart-upgrade hold: tap 1's timer
    // is cancelled, so nothing fires ~1s into the hands-free session.
    vi.advanceTimersByTime(CONFIG.LISTEN_SMART_HOLD_MS * 2)
    expect(h.onListenHoldSmart).not.toHaveBeenCalled()
  })

  it('two presses OUTSIDE the double-tap window do not go hands-free', () => {
    const h = makeHandlers(false)
    handleListenPress(h)
    handleListenRelease(h)
    vi.advanceTimersByTime(CONFIG.LISTEN_DOUBLE_TAP_MS + 10)

    handleListenPress(h)
    expect(h.onListenDoubleTap).not.toHaveBeenCalled()
  })

  it('holding past the threshold upgrades to smart dictation, once', () => {
    const h = makeHandlers(false)
    handleListenPress(h)

    vi.advanceTimersByTime(CONFIG.LISTEN_SMART_HOLD_MS + 10)
    expect(h.onListenHoldSmart).toHaveBeenCalledTimes(1)

    // Releasing after the upgrade already fired must not toggle the session off.
    const listenCalls = (h.onListen as ReturnType<typeof vi.fn>).mock.calls.length
    handleListenRelease(h)
    vi.advanceTimersByTime(RELEASE_GRACE_MS + 1)
    expect(h.onListen).toHaveBeenCalledTimes(listenCalls)
  })

  // The blip guard, and the thing that used to be broken about it.
  //
  // macOS can deliver a keyup+keydown pair in the middle of one continuous
  // physical hold. The guard's job is to swallow that pair so the hold survives.
  // It used to ask isDoubleTapPress(), which measures PRESS-to-press over a 400ms
  // window -- a blip re-presses ~60ms after the original press, so it was always
  // inside that window and every blip killed the hold and fired hands-free.
  //
  // The fix measures RELEASE-to-press instead: the two edges of a blip are the
  // same hold, while a person lifting and pressing again cannot beat 40ms.
  it('a spurious release blip mid-hold does not break the hold', () => {
    const h = makeHandlers(false)
    handleListenPress(h)

    handleListenRelease(h)
    // The re-press of a real blip is effectively simultaneous with its keyup --
    // same physical hold, not two deliberate actions.
    vi.advanceTimersByTime(5)
    handleListenPress(h)

    // The blip is noise: no hands-free, and the original hold is still armed.
    expect(h.onListenDoubleTap).not.toHaveBeenCalled()
    vi.advanceTimersByTime(CONFIG.LISTEN_SMART_HOLD_MS + 10)
    expect(h.onListenHoldSmart).toHaveBeenCalledTimes(1)
  })

  it('a real double-tap still fires when tap 2 lands inside the release grace', () => {
    // The case that makes the fix non-trivial: a fast human double-tap arrives
    // while the release is STILL pending its 60ms grace, exactly like a blip.
    // Only the release-to-press gap separates them, so this must not regress.
    const h = makeHandlers(false)
    handleListenPress(h)
    handleListenRelease(h)

    vi.advanceTimersByTime(RELEASE_GRACE_MS - 5)
    handleListenPress(h)

    expect(h.onListenDoubleTap).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(CONFIG.LISTEN_SMART_HOLD_MS * 2)
    expect(h.onListenHoldSmart).not.toHaveBeenCalled()
  })

  it('repeat presses while the key is already down are ignored', () => {
    const h = makeHandlers(false)
    handleListenPress(h)
    // uiohook fires keydown repeatedly while a key is physically held. Only the
    // first is real; repeats must not re-arm anything or double-fire the upgrade.
    handleListenPress(h)
    handleListenPress(h)

    expect(h.onListen).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(CONFIG.LISTEN_SMART_HOLD_MS + 10)
    expect(h.onListenHoldSmart).toHaveBeenCalledTimes(1)
  })

  it('a press from one source and a release from another is coherent', () => {
    // The point of sharing one machine: ⌘⌥⇧L down then fn up (or vice versa) must
    // read as a single press/release, not a wedged hold. Both call the same pair.
    const h = makeHandlers(true)
    handleListenPress(h)
    handleListenRelease(h)
    vi.advanceTimersByTime(RELEASE_GRACE_MS + 1)

    expect(h.onListen).toHaveBeenCalledTimes(1)
    // State is clean afterwards: the next press starts a fresh gesture.
    vi.advanceTimersByTime(CONFIG.LISTEN_DOUBLE_TAP_MS + 10)
    const fresh = makeHandlers(false)
    handleListenPress(fresh)
    expect(fresh.onListenDoubleTap).not.toHaveBeenCalled()
    expect(fresh.onListen).toHaveBeenCalledTimes(1)
  })
})
