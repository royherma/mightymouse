import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * This file exists because the first version of this logic shipped and killed
 * the session on the phone's own first swipe — before the lock guard was even
 * acquired, so the feature did nothing at all and the log read as if a human had
 * walked up. The mocked away-mode test could not catch it: it fakes this
 * module out entirely. So the attribution rule gets tested against a real fake
 * uiohook, at the level where it actually broke.
 */
type Handler = (e: { x: number; y: number; keycode?: number }) => void

let handlers: Record<string, Handler[]> = {}
let available = true
let acquired = 0
let released = 0

vi.mock('../../capture/uiohook-manager', () => ({
  isAvailable: vi.fn(() => available),
  acquire: vi.fn(() => {
    acquired++
    return () => {
      released++
    }
  }),
  on: vi.fn((evt: string, cb: Handler) => {
    ;(handlers[evt] ??= []).push(cb)
    return () => {
      handlers[evt] = (handlers[evt] ?? []).filter((h) => h !== cb)
    }
  })
}))

vi.mock('../../../shared/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../shared/env')>()),
  devLog: { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

// The real module reaches `electron`. Captured rather than stubbed away, because
// whether the watch actually subscribes is the fix under test.
let syntheticListener: (() => void) | null = null

// The paste path is a SECOND synthesis route (System Events Cmd+V, not mm-input),
// so it registers its own listener. Captured separately: a fix that wires only
// one of the two still relocks the Mac on the path it missed.
let pasteListener: (() => void) | null = null

// local-input-watch.ts imports both `input` (domain object) and the flat
// `setSyntheticPasteListener` re-export from '../platform' — the mock must
// answer both shapes, or the domain-object call throws "input is undefined".
vi.mock('../../platform', () => ({
  input: {
    setSyntheticInputListener: vi.fn((cb: (() => void) | null) => {
      syntheticListener = cb
    })
  },
  setSyntheticPasteListener: vi.fn((cb: (() => void) | null) => {
    pasteListener = cb
  })
}))

/** What mm-input does on any synthesized event, from the watch's point of view. */
function macPostsInput(): void {
  if (syntheticListener) syntheticListener()
}

/** What pasteText does just before its System Events Cmd+V. */
function macPostsPaste(): void {
  if (pasteListener) pasteListener()
}

function emit(evt: string, x = 100, y = 100): void {
  for (const h of handlers[evt] ?? []) h({ x, y })
}

function emitKey(evt: 'keydown' | 'keyup', keycode: number): void {
  for (const h of handlers[evt] ?? []) h({ x: 0, y: 0, keycode })
}

async function freshModule(): Promise<typeof import('../local-input-watch')> {
  vi.resetModules()
  return import('../local-input-watch')
}

describe('local-input-watch', () => {
  beforeEach(() => {
    handlers = {}
    available = true
    acquired = 0
    released = 0
    syntheticListener = null
    pasteListener = null
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-05T12:00:00Z'))
  })

  describe('input the Mac generates on its own schedule', () => {
    // The 2026-08-09 lockout: Whisper transcribes on the MAC, so the transcript
    // types seconds after the socket message that asked for it.
    // `make why Q="dictation relock"`.
    it('does not fire on dictated text typed long after the phone spoke', async () => {
      const m = await freshModule()
      const onHuman = vi.fn()
      m.startLocalInputWatch(onHuman)

      m.noteAppGeneratedInput()
      // Whisper's real cost on the incident: transcribe 1796ms + transcode 279ms.
      vi.advanceTimersByTime(27_000)

      // 87 words land as per-char keydowns, each preceded by mm-input's stamp.
      for (let i = 0; i < 400; i++) {
        macPostsInput()
        emitKey('keydown', 40 + (i % 20))
        emitKey('keyup', 40 + (i % 20))
        vi.advanceTimersByTime(4)
      }

      expect(onHuman).not.toHaveBeenCalled()
    })

    // The 2026-08-12 lockout: pasteText fires Cmd+V through System Events, which
    // never touches mm-input, so the keydown arrived unattributed and relocked
    // the Mac. `make why Q="paste relock"`.
    it('does not fire on a Cmd+V the app itself pasted', async () => {
      const m = await freshModule()
      const onHuman = vi.fn()
      m.startLocalInputWatch(onHuman)

      // The inbound phone message stamp, then the paste's own async tail: a
      // clipboard write plus an osascript spawn (~170ms measured).
      m.noteAppGeneratedInput()
      vi.advanceTimersByTime(3_000)

      macPostsPaste()
      vi.advanceTimersByTime(170)
      emitKey('keydown', 9)
      emitKey('keyup', 9)

      expect(onHuman).not.toHaveBeenCalled()
    })

    it('registers the paste listener on arm and clears it on disarm', async () => {
      const m = await freshModule()
      m.startLocalInputWatch(vi.fn())
      expect(pasteListener).not.toBeNull()

      m.stopLocalInputWatch()
      expect(pasteListener).toBeNull()
    })

    it('still fires on a real key once the typing has stopped', async () => {
      const m = await freshModule()
      const onHuman = vi.fn()
      m.startLocalInputWatch(onHuman)

      macPostsInput()
      emitKey('keydown', 47)
      emitKey('keyup', 47)
      expect(onHuman).not.toHaveBeenCalled()

      // The stamp must not become a blanket amnesty: past QUIET_MS, a person
      // sitting down still ends the session.
      vi.advanceTimersByTime(5_000)
      emitKey('keydown', 47)
      expect(onHuman).toHaveBeenCalledTimes(1)
    })

    it('subscribes on arm and unsubscribes on disarm', async () => {
      const m = await freshModule()
      m.startLocalInputWatch(vi.fn())
      expect(syntheticListener).not.toBeNull()

      // Left dangling, the primitive layer holds a closure over a dead watch.
      m.stopLocalInputWatch()
      expect(syntheticListener).toBeNull()
    })
  })

  describe('attributing input to the phone', () => {
    it('does not fire on input caused by a phone message', async () => {
      const m = await freshModule()
      const onHuman = vi.fn()
      m.startLocalInputWatch(onHuman)

      m.noteAppGeneratedInput()
      vi.advanceTimersByTime(20)
      emit('mousedown')

      expect(onHuman).not.toHaveBeenCalled()
    })

    it('survives a whole gesture stream', async () => {
      const m = await freshModule()
      const onHuman = vi.fn()
      m.startLocalInputWatch(onHuman)

      // The exact shape that broke on device: a continuous swipe, each message
      // followed by the synthetic event it caused.
      for (let i = 0; i < 50; i++) {
        m.noteAppGeneratedInput()
        vi.advanceTimersByTime(16)
        emit('mousedown', 100 + i * 30, 100 + i * 30)
      }

      expect(onHuman).not.toHaveBeenCalled()
    })

    it('treats the moment the watch arms as phone activity', async () => {
      const m = await freshModule()
      const onHuman = vi.fn()
      // A session begins while the phone is already streaming. Arming from a
      // zeroed clock would attribute its next event to a human and tear down the
      // session it was just asked to protect.
      m.startLocalInputWatch(onHuman)

      vi.advanceTimersByTime(50)
      emit('mousedown')
      expect(onHuman).not.toHaveBeenCalled()
    })
  })

  describe('detecting a human', () => {
    it('fires once the phone has been quiet', async () => {
      const m = await freshModule()
      const onHuman = vi.fn()
      m.startLocalInputWatch(onHuman)

      m.noteAppGeneratedInput()
      vi.advanceTimersByTime(5_000)
      emit('keydown')

      expect(onHuman).toHaveBeenCalledTimes(1)
    })

    it('fires at most once per watch', async () => {
      const m = await freshModule()
      const onHuman = vi.fn()
      m.startLocalInputWatch(onHuman)

      vi.advanceTimersByTime(5_000)
      emit('keydown')
      emit('keydown')
      emit('mousedown')

      // Everything after the first is the user's own machine again; re-firing
      // would re-run the whole teardown on every subsequent keystroke.
      expect(onHuman).toHaveBeenCalledTimes(1)
    })

    it('ignores a nudge of the cursor', async () => {
      const m = await freshModule()
      const onHuman = vi.fn()
      m.startLocalInputWatch(onHuman)

      vi.advanceTimersByTime(5_000)
      // A bumped desk or a Bluetooth mouse waking is not a person choosing to
      // use the Mac. Firing on this made the feature unusable on device.
      emit('mousemove', 100, 100)
      emit('mousemove', 130, 118)

      expect(onHuman).not.toHaveBeenCalled()
    })

    it('fires once the cursor has travelled far enough to be a person', async () => {
      const m = await freshModule()
      const onHuman = vi.fn()
      m.startLocalInputWatch(onHuman)

      vi.advanceTimersByTime(5_000)
      // Reaching for the mouse and moving it covers hundreds of px. Walking up
      // to the Mac and moving the mouse used to leave it covered and unlocked.
      for (let i = 0; i <= 10; i++) emit('mousemove', 100 + i * 50, 100)

      expect(onHuman).toHaveBeenCalledTimes(1)
    })

    it('accumulates a slow deliberate drag', async () => {
      const m = await freshModule()
      const onHuman = vi.fn()
      m.startLocalInputWatch(onHuman)

      vi.advanceTimersByTime(5_000)
      // No single tick clears the threshold; the travel is what counts, so a
      // careful drag must register as much as a fast swipe.
      for (let i = 0; i <= 100; i++) emit('mousemove', 100 + i * 5, 100)

      expect(onHuman).toHaveBeenCalledTimes(1)
    })

    it('never accumulates travel the phone caused', async () => {
      const m = await freshModule()
      const onHuman = vi.fn()
      m.startLocalInputWatch(onHuman)

      // A long remote drag covers far more than the threshold. Counting it would
      // end the very session it belongs to — the bug that made an all-motion
      // watcher unusable, reintroduced through the back door.
      for (let i = 0; i < 200; i++) {
        m.noteAppGeneratedInput()
        vi.advanceTimersByTime(16)
        emit('mousemove', 100 + i * 40, 100)
      }

      expect(onHuman).not.toHaveBeenCalled()
    })

    it('does not carry phone travel over into a human reach', async () => {
      const m = await freshModule()
      const onHuman = vi.fn()
      m.startLocalInputWatch(onHuman)

      // A long phone drag, then the user picks up the real mouse and nudges it.
      // Banked phone travel must not make that first twitch trip the threshold.
      for (let i = 0; i < 50; i++) {
        m.noteAppGeneratedInput()
        vi.advanceTimersByTime(16)
        emit('mousemove', 100 + i * 40, 100)
      }
      vi.advanceTimersByTime(5_000)
      emit('mousemove', 2100, 100)
      emit('mousemove', 2120, 100)

      expect(onHuman).not.toHaveBeenCalled()
    })

    it('fires on a deliberate scroll', async () => {
      const m = await freshModule()
      const onHuman = vi.fn()
      m.startLocalInputWatch(onHuman)

      vi.advanceTimersByTime(5_000)
      // A real scroll is a burst, never one event -- which is exactly what
      // separates it from the cases below.
      emit('wheel')
      vi.advanceTimersByTime(30)
      emit('wheel')
      expect(onHuman).toHaveBeenCalledTimes(1)
    })

    // The 2026-08-09 beach relock: ONE wheel ended a 716-second covered session
    // mid-gesture, with nobody at the Mac. A lone wheel is indistinguishable
    // from our own late synthetic tail, so it must be corroborated.
    it('does not fire on a single isolated wheel', async () => {
      const m = await freshModule()
      const onHuman = vi.fn()
      m.startLocalInputWatch(onHuman)

      vi.advanceTimersByTime(5_000)
      emit('wheel')
      expect(onHuman).not.toHaveBeenCalled()

      // Still nothing much later -- the pending wheel must not sit there
      // waiting to be completed by an unrelated event minutes on.
      vi.advanceTimersByTime(60_000)
      expect(onHuman).not.toHaveBeenCalled()
    })

    it('does not pair two wheels that are far apart', async () => {
      const m = await freshModule()
      const onHuman = vi.fn()
      m.startLocalInputWatch(onHuman)

      vi.advanceTimersByTime(5_000)
      emit('wheel')
      vi.advanceTimersByTime(3_000)
      emit('wheel')
      expect(onHuman).not.toHaveBeenCalled()
    })

    it('does not let a synthetic wheel corroborate a real one', async () => {
      const m = await freshModule()
      const onHuman = vi.fn()
      m.startLocalInputWatch(onHuman)

      vi.advanceTimersByTime(5_000)
      // The phone posts a wheel (attributed), then a stray one lands right
      // after. Only the stray is unattributed, so it is still a lone wheel.
      m.noteAppGeneratedInput()
      emit('wheel')
      vi.advanceTimersByTime(700)
      emit('wheel')
      expect(onHuman).not.toHaveBeenCalled()
    })
  })

  describe('a held key is one decision', () => {
    it('drops auto-repeat of a held key', async () => {
      const m = await freshModule()
      const onHuman = vi.fn()
      m.startLocalInputWatch(onHuman)

      vi.advanceTimersByTime(5_000)
      emitKey('keydown', 36)
      expect(onHuman).toHaveBeenCalledTimes(1)

      // One held key generated 861 keydowns in a single session.
      // Re-armed for the postpone reading, the repeats must count for nothing.
      for (let i = 0; i < 100; i++) {
        m.rearmLocalInputWatch(onHuman)
        emitKey('keydown', 36)
      }
      expect(onHuman).toHaveBeenCalledTimes(1)
    })

    it('counts the same key again after its keyup — that is a second decision', async () => {
      const m = await freshModule()
      const onHuman = vi.fn()
      m.startLocalInputWatch(onHuman)

      vi.advanceTimersByTime(5_000)
      emitKey('keydown', 36)
      emitKey('keyup', 36)
      m.rearmLocalInputWatch(onHuman)
      emitKey('keydown', 36)

      expect(onHuman).toHaveBeenCalledTimes(2)
    })

    it('counts a different key while one is held', async () => {
      const m = await freshModule()
      const onHuman = vi.fn()
      m.startLocalInputWatch(onHuman)

      vi.advanceTimersByTime(5_000)
      emitKey('keydown', 36)
      m.rearmLocalInputWatch(onHuman)
      emitKey('keydown', 48)

      expect(onHuman).toHaveBeenCalledTimes(2)
    })
  })

  describe('arming', () => {
    it('refuses to arm with no event tap', async () => {
      const m = await freshModule()
      available = false

      m.startLocalInputWatch(vi.fn())
      // The caller reads this to decide NOT to suspend the lock — an unlocked
      // Mac with no re-lock trigger is the state this must never leave behind.
      expect(m.isLocalInputWatchActive()).toBe(false)
      expect(acquired).toBe(0)
    })

    it('releases the tap on disarm', async () => {
      const m = await freshModule()
      m.startLocalInputWatch(vi.fn())
      expect(m.isLocalInputWatchActive()).toBe(true)

      m.stopLocalInputWatch()
      expect(m.isLocalInputWatchActive()).toBe(false)
      expect(released).toBe(1)
      expect(handlers['keydown']).toHaveLength(0)
    })

    it('does not fire after being disarmed', async () => {
      const m = await freshModule()
      const onHuman = vi.fn()
      m.startLocalInputWatch(onHuman)
      m.stopLocalInputWatch()

      vi.advanceTimersByTime(5_000)
      emit('keydown')
      expect(onHuman).not.toHaveBeenCalled()
    })

    it('is idempotent', async () => {
      const m = await freshModule()
      m.startLocalInputWatch(vi.fn())
      m.startLocalInputWatch(vi.fn())
      expect(acquired).toBe(1)
    })
  })

  describe('re-arming', () => {
    it('reports a human again without cycling the tap', async () => {
      const m = await freshModule()
      const onHuman = vi.fn()
      m.startLocalInputWatch(onHuman)

      vi.advanceTimersByTime(5_000)
      emitKey('keydown', 36)
      m.rearmLocalInputWatch(onHuman)
      emitKey('keydown', 48)

      expect(onHuman).toHaveBeenCalledTimes(2)
      // Stop-then-start would work here and is why this function exists:
      // release() is refcounted down to hook.stop(), so cycling the watch per
      // keystroke tears down the global tap and throttles system-wide typing.
      expect(acquired).toBe(1)
      expect(released).toBe(0)
    })

    it('clears banked travel so the next twitch does not fire', async () => {
      const m = await freshModule()
      const onHuman = vi.fn()
      m.startLocalInputWatch(onHuman)

      vi.advanceTimersByTime(5_000)
      // Travel banked before the re-arm already did its job (it postponed the
      // curtain); carrying it over would trip the threshold on the next nudge.
      for (let i = 0; i <= 7; i++) emit('mousemove', 100 + i * 50, 100)
      m.rearmLocalInputWatch(onHuman)
      emit('mousemove', 470, 100)

      expect(onHuman).not.toHaveBeenCalled()
    })

    it('does nothing when the watch was never armed', async () => {
      const m = await freshModule()
      available = false
      m.startLocalInputWatch(vi.fn())

      const onHuman = vi.fn()
      m.rearmLocalInputWatch(onHuman)
      emit('keydown')

      expect(onHuman).not.toHaveBeenCalled()
    })
  })
  /**
   * The 2026-09-08 lockout. Every earlier incident here was a MISSING stamp;
   * this one was stamped correctly and still relocked, because `sinceStamp` is
   * read at delivery and the main thread was wedged behind blocking spawnSync.
   *
   * `blockTheLoop` is the whole point: moving the system clock WITHOUT running
   * timers is what a blocked event loop does to this module. `advanceTimersByTime`
   * cannot express it — it ticks the loop-turn interval in lockstep with
   * `Date.now()`, which is precisely the healthy case.
   */
  describe('input delivered late by a blocked event loop', () => {
    function blockTheLoop(ms: number): void {
      vi.setSystemTime(new Date(Date.now() + ms))
    }

    it('does not relock when a stamped keystroke is delivered after a stall', async () => {
      const m = await freshModule()
      const onHuman = vi.fn()
      m.startLocalInputWatch(onHuman)

      // handleTmuxAction stamps, posts ctrl+b, then calls sendAppContext() —
      // whose osascript chain blocks the main thread past the 3s timeout.
      macPostsInput()
      blockTheLoop(5_414)
      // uiohook's tap ran on its own pthread throughout; JS only sees it now.
      emitKey('keydown', 29)

      expect(onHuman).not.toHaveBeenCalled()
    })

    it('still relocks for a person who keeps typing after the loop recovers', async () => {
      const m = await freshModule()
      const onHuman = vi.fn()
      m.startLocalInputWatch(onHuman)

      macPostsInput()
      blockTheLoop(5_414)
      emitKey('keydown', 29)
      expect(onHuman).not.toHaveBeenCalled()

      // The stall guard must not become a blanket amnesty: once the loop turns
      // again, the next key is judged on timing as before.
      vi.advanceTimersByTime(5_000)
      emitKey('keydown', 47)

      expect(onHuman).toHaveBeenCalledTimes(1)
    })

    it('reports the numbers that separate a person from a late delivery', async () => {
      const m = await freshModule()
      m.startLocalInputWatch(vi.fn())
      expect(m.lastHumanVerdict()).toBeNull()

      vi.advanceTimersByTime(5_000)
      emitKey('keydown', 47)

      // `ended by human` alone wrote the identical journal line for both, which
      // is what made the incident take four wrong answers to diagnose.
      expect(m.lastHumanVerdict()?.sinceStampMs).toBeGreaterThan(600)
    })
  })
})
