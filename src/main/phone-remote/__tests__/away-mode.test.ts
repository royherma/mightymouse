import { describe, it, expect, beforeEach, vi } from 'vitest'
import { CONFIG } from '../../../shared/config'
import { formatDuration } from '../../../shared/relay-cards'
import type { LocalInputKind } from '../local-input-watch'

// Two invariants: the lock is never suspended without a working way to restore
// it, and the grace window NEVER locks. `ops` records call order because the
// ORDER is the contract (watch before hold, lock back before uncover).

let ops: string[] = []

let watchAvailable = true
let watchActive = false
let humanCb: ((kind: LocalInputKind) => void) | null = null

let acquireOk = true
let releaseOk = true
let holdHeld = false

let curtainShown = false

vi.mock('../idle-lock-suppressor', () => ({
  suppressIdleLock: vi.fn(async () => {
    if (!acquireOk) return { ok: false, error: 'no hold' }
    holdHeld = true
    ops.push('hold:acquire')
    return { ok: true }
  }),
  endSessionAndLockMac: vi.fn(async (opts?: { relock?: boolean }) => {
    if (!holdHeld) return { ok: true }
    if (opts?.relock === false) {
      holdHeld = false
      ops.push('hold:release')
      return { ok: true }
    }
    if (!releaseOk) return { ok: false, error: 'relock lever failed' }
    holdHeld = false
    ops.push('hold:release')
    return { ok: true }
  }),
  isIdleLockSuppressed: vi.fn(() => holdHeld)
}))

// The blocker IS the hold (idle-lock-suppressor.ts): while it is alive macOS's idle lock
// stays disarmed, so `stayAwakeOn` is the world's answer, not the module's cache.
let stayAwakeOn = false

vi.mock('../stay-awake', () => ({
  startStayAwake: vi.fn(() => {
    stayAwakeOn = true
    ops.push('stayawake:start')
  }),
  stopStayAwake: vi.fn(() => {
    stayAwakeOn = false
    ops.push('stayawake:stop')
  }),
  isStayAwakeActive: vi.fn(() => stayAwakeOn),
  armIdleLockRearm: vi.fn(() => {
    ops.push('stayawake:graceRelease')
  })
}))

vi.mock('../privacy-curtain', () => ({
  showCurtain: vi.fn(() => {
    curtainShown = true
    ops.push('curtain:show')
  }),
  hideCurtain: vi.fn(() => {
    curtainShown = false
    ops.push('curtain:hide')
  }),
  isCurtainVisible: vi.fn(() => curtainShown)
}))

vi.mock('../local-input-watch', () => ({
  startLocalInputWatch: vi.fn((cb: (kind: LocalInputKind) => void) => {
    if (!watchAvailable) return
    watchActive = true
    humanCb = cb
    ops.push('watch:start')
  }),
  stopLocalInputWatch: vi.fn(() => {
    watchActive = false
    humanCb = null
    ops.push('watch:stop')
  }),
  isLocalInputWatchActive: vi.fn(() => watchActive),
  rearmLocalInputWatch: vi.fn((cb: (kind: LocalInputKind) => void) => {
    if (!watchActive) return
    humanCb = cb
    ops.push('watch:rearm')
  }),
  // Read by handback() on the human branch, to journal WHY it judged a human.
  // A mock missing it throws inside the teardown, which surfaces as the session
  // never leaving 'covered' rather than as a missing export.
  lastHumanVerdict: vi.fn(() => null)
}))

const trackMock = vi.fn()
vi.mock('../../analytics', () => ({
  track: (...args: unknown[]) => trackMock(...args)
}))

// Mocked for its side effect as much as for the spy: the real module writes to
// disk on every call, and these tests must not touch the user's journal.
const journalMock = vi.fn()
vi.mock('../connection-journal', () => ({
  recordJournal: (...args: unknown[]) => journalMock(...args)
}))

/** The journal events recorded so far, in order. */
const journalled = (): string[] => journalMock.mock.calls.map((c) => c[0] as string)
const detailOf = (event: string): string | undefined =>
  journalMock.mock.calls.find((c) => c[0] === event)?.[1]?.detail

vi.mock('child_process', () => ({
  exec: vi.fn(
    (
      _cmd: string,
      _opts: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void
    ) => {
      cb(null, ' displaysleep 10 (display sleep prevented by Electron)\n', '')
    }
  )
}))

vi.mock('../../../shared/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../shared/env')>()),
  devLog: { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

// pmset reports 10 minutes and it is used as-is — there is no upper clamp.
const DELAY_MS = 10 * 60 * 1000
const GRACE_MS = CONFIG.PHONE_REMOTE.CURTAIN_ON_PHONE_GONE_MS
// Longer than the grace window, so grace tests observe the grace cover alone.
const NEVER_COVER_MS = GRACE_MS * 2

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

// The real watch reports a human AT MOST ONCE per arm — mirror that.
// Defaults to keydown so the kind only matters where a test names it.
async function human(kind: LocalInputKind = 'keydown'): Promise<void> {
  const cb = humanCb
  humanCb = null
  cb?.(kind)
  await flush()
}

async function freshModule(): Promise<typeof import('../away-mode')> {
  vi.resetModules()
  return import('../away-mode')
}

describe('away-mode', () => {
  beforeEach(() => {
    ops = []
    watchAvailable = true
    watchActive = false
    humanCb = null
    acquireOk = true
    releaseOk = true
    holdHeld = false
    stayAwakeOn = false
    curtainShown = false
    trackMock.mockClear()
    journalMock.mockClear()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-07T12:00:00Z'))
  })

  describe('the invariant: no suspended lock without a way back', () => {
    it('refuses to hold when the input watch cannot arm', async () => {
      const m = await freshModule()
      watchAvailable = false

      const res = await m.beginAwayMode()

      expect(res).toEqual({ ok: false, reason: 'no-input-watch' })
      expect(m.getAwayModeState()).toBe('off')
      expect(ops).not.toContain('hold:acquire')
    })

    // Every other teardown releases the blocker via handback(), which this
    // branch never reaches — so a leak here holds the display awake until the
    // app quits, the exact battery bug stay-awake.ts is built to prevent.
    it('releases the display blocker when the hold cannot be acquired', async () => {
      const m = await freshModule()
      acquireOk = false

      const res = await m.beginAwayMode()

      expect(res.ok).toBe(false)
      expect(ops).toContain('stayawake:stop')
      expect(ops).toContain('watch:stop')
      expect(stayAwakeOn).toBe(false)
      expect(m.getAwayModeState()).toBe('off')
    })

    // macOS can tear the blocker down underneath a live session, which re-arms
    // the idle lock — so `held` is a stale cache and returning ok here hands
    // the phone a login window it cannot dismiss.
    it('re-acquires when the blocker died underneath a held session', async () => {
      const m = await freshModule()
      await m.beginAwayMode({ coverDelayOverrideMs: NEVER_COVER_MS })
      expect(m.getAwayModeState()).toBe('held')

      // The OS drops it. Nothing tells us; only isStayAwakeActive() knows.
      stayAwakeOn = false
      ops = []

      const res = await m.beginAwayMode({ coverDelayOverrideMs: NEVER_COVER_MS })

      expect(res.ok).toBe(true)
      expect(ops).toContain('hold:acquire')
      expect(stayAwakeOn).toBe(true)
    })

    it('arms the way back before taking the capability', async () => {
      const m = await freshModule()
      await m.beginAwayMode()

      expect(ops.indexOf('watch:start')).toBeLessThan(ops.indexOf('hold:acquire'))
    })

    it('restores the lock before uncovering', async () => {
      const m = await freshModule()
      await m.beginAwayMode()
      vi.advanceTimersByTime(DELAY_MS)
      await m.handback()

      expect(ops.indexOf('hold:release')).toBeLessThan(ops.indexOf('curtain:hide'))
    })
  })

  describe('begin', () => {
    it('holds immediately but does not cover — the user may still be at the desk', async () => {
      const m = await freshModule()
      const res = await m.beginAwayMode()

      expect(res.ok).toBe(true)
      expect(m.getAwayModeState()).toBe('held')
      expect(holdHeld).toBe(true)
      expect(curtainShown).toBe(false)
    })

    it('covers after the delay and fires onCovered', async () => {
      const m = await freshModule()
      const onCovered = vi.fn()
      await m.beginAwayMode({ onCovered })

      vi.advanceTimersByTime(DELAY_MS - 1)
      expect(curtainShown).toBe(false)

      vi.advanceTimersByTime(1)
      expect(m.getAwayModeState()).toBe('covered')
      expect(curtainShown).toBe(true)
      expect(onCovered).toHaveBeenCalledTimes(1)
    })

    it('disarms the watch when the hold fails', async () => {
      const m = await freshModule()
      acquireOk = false

      const res = await m.beginAwayMode()

      expect(res.ok).toBe(false)
      expect(res.reason).toBe('failed')
      expect(m.getAwayModeState()).toBe('off')
      expect(ops).toContain('watch:stop')
    })

    it('is idempotent while the hold is real', async () => {
      const m = await freshModule()
      await m.beginAwayMode()
      const res = await m.beginAwayMode()

      expect(res.ok).toBe(true)
      expect(ops.filter((o) => o === 'hold:acquire')).toHaveLength(1)
    })

    it('re-acquires when state says held but the lock came back underneath', async () => {
      const m = await freshModule()
      await m.beginAwayMode()

      // The OS relocked behind our back (fast user switch, MDM, anything).
      holdHeld = false
      const res = await m.beginAwayMode()

      expect(res.ok).toBe(true)
      expect(holdHeld).toBe(true)
      expect(ops.filter((o) => o === 'hold:acquire')).toHaveLength(2)
    })
  })

  describe('handback', () => {
    it('puts everything back', async () => {
      const m = await freshModule()
      await m.beginAwayMode()
      vi.advanceTimersByTime(DELAY_MS)

      await m.handback()

      expect(m.getAwayModeState()).toBe('off')
      expect(holdHeld).toBe(false)
      expect(curtainShown).toBe(false)
      expect(watchActive).toBe(false)
    })

    it('is safe when nothing is running', async () => {
      const m = await freshModule()
      await m.handback()

      expect(m.getAwayModeState()).toBe('off')
      expect(ops).not.toContain('hold:release')
    })

    it('tears down without relocking when asked — quit is a local action', async () => {
      const m = await freshModule()
      await m.beginAwayMode()
      vi.advanceTimersByTime(DELAY_MS)

      await m.handback('disconnect', { relock: false })

      expect(m.getAwayModeState()).toBe('off')
      expect(holdHeld).toBe(false)
      expect(curtainShown).toBe(false)
      expect(watchActive).toBe(false)
      const { endSessionAndLockMac } = await import('../idle-lock-suppressor')
      expect(vi.mocked(endSessionAndLockMac).mock.calls.at(-1)?.[0]).toEqual({ relock: false })
    })

    it('holds the cover up when the relock fails', async () => {
      const m = await freshModule()
      await m.beginAwayMode()
      vi.advanceTimersByTime(DELAY_MS)

      releaseOk = false
      await m.handback()

      // Never expose a desktop on a machine that will not lock.
      expect(curtainShown).toBe(true)
      expect(m.getAwayModeState()).toBe('covered')
      expect(watchActive).toBe(true)

      releaseOk = true
      await m.handback()
      expect(curtainShown).toBe(false)
      expect(m.getAwayModeState()).toBe('off')
    })

    it('does not fire onEndedByHuman on an ordinary teardown', async () => {
      const m = await freshModule()
      const onEndedByHuman = vi.fn()
      await m.beginAwayMode({ onEndedByHuman })

      await m.handback()

      expect(onEndedByHuman).not.toHaveBeenCalled()
    })

    it('emits one session event with who ended it', async () => {
      const m = await freshModule()
      await m.beginAwayMode()
      vi.advanceTimersByTime(DELAY_MS)

      await human()

      expect(trackMock).toHaveBeenCalledTimes(1)
      expect(trackMock.mock.calls[0][1]).toMatchObject({ covered: true, ended_by: 'human' })
    })
  })

  describe('local input means two things', () => {
    it('postpones the cover while the user is still at the desk', async () => {
      const m = await freshModule()
      await m.beginAwayMode()

      vi.advanceTimersByTime(DELAY_MS - 1_000)
      await human()
      vi.advanceTimersByTime(DELAY_MS - 1)
      expect(curtainShown).toBe(false)

      vi.advanceTimersByTime(1)
      expect(curtainShown).toBe(true)
      expect(m.getAwayModeState()).toBe('covered')
    })

    // The postpone log shipped printing a flat "10m away" no matter how long the
    // Mac had actually been idle -- formatDuration rounds to whole minutes, so a
    // 9m30s gap displayed as the untouched delay and the one number the line
    // exists to show was the one it could never show. Seconds, and a real gap.
    it('reports the true idle gap, down to a few seconds', async () => {
      const { devLog } = await import('../../../shared/env')
      const m = await freshModule()
      await m.beginAwayMode()

      // The mock accumulates across tests in this file, so read the LAST line
      // rather than an index into the whole run.
      const lastLine = (): string => {
        const lines = vi
          .mocked(devLog.log)
          .mock.calls.map((c) => c.join(' '))
          .filter((l) => l.includes('idle'))
        return lines[lines.length - 1] ?? ''
      }

      // First input has no predecessor to measure against.
      await human()
      vi.advanceTimersByTime(10_000)
      await human()

      // 10s must survive as 10s: rounding this to "0m" is the shipped bug.
      expect(lastLine()).toContain('idle 10s')
      expect(lastLine()).toContain(`curtain was ${DELAY_MS / 1000 - 10}s away`)

      vi.advanceTimersByTime(90_000)
      await human()
      expect(lastLine()).toContain('idle 90s')
    })

    it('keeps postponing across a working session', async () => {
      const m = await freshModule()
      await m.beginAwayMode()

      for (let i = 0; i < 5; i++) {
        vi.advanceTimersByTime(DELAY_MS - 5_000)
        await human()
      }

      expect(curtainShown).toBe(false)
      expect(m.getAwayModeState()).toBe('held')
    })

    it('hands back once covered — the user came back', async () => {
      const m = await freshModule()
      const onEndedByHuman = vi.fn()
      await m.beginAwayMode({ onEndedByHuman })
      vi.advanceTimersByTime(DELAY_MS)

      await human()

      expect(m.getAwayModeState()).toBe('off')
      expect(curtainShown).toBe(false)
      expect(holdHeld).toBe(false)
      expect(onEndedByHuman).toHaveBeenCalledTimes(1)
    })

    // The regression this locks: a postpone CEILING used to live here and covered
    // the screen on someone typing at their own desk (282 real keystrokes in 108s
    // of a 600s delay, 2026-08-08). Typing must postpone forever.
    it('never covers while someone keeps typing, however long', async () => {
      const m = await freshModule()
      await m.beginAwayMode()

      for (let i = 0; i < 1000; i++) {
        vi.advanceTimersByTime(DELAY_MS - 1000)
        await human()
      }

      expect(m.getAwayModeState()).toBe('held')
      expect(curtainShown).toBe(false)
    })

    it('never covers after the session ended', async () => {
      const m = await freshModule()
      await m.beginAwayMode()
      await m.handback()

      vi.advanceTimersByTime(DELAY_MS * 3)

      expect(curtainShown).toBe(false)
      expect(m.getAwayModeState()).toBe('off')
    })
  })

  describe('the grace window NEVER locks', () => {
    it('phone gone for the whole window: covers, keeps every hold', async () => {
      const m = await freshModule()
      await m.beginAwayMode({ coverDelayOverrideMs: NEVER_COVER_MS })

      m.armCurtainOnPhoneGone()
      vi.advanceTimersByTime(GRACE_MS)

      // The regression that must never come back: this path locked the Mac
      // while the phone was the only way back in.
      expect(m.getAwayModeState()).toBe('covered')
      expect(curtainShown).toBe(true)
      expect(holdHeld).toBe(true)
      expect(ops).not.toContain('hold:release')
      expect(ops).not.toContain('stayawake:graceRelease')
    })

    it('stands down when the phone comes back', async () => {
      const m = await freshModule()
      await m.beginAwayMode({ coverDelayOverrideMs: NEVER_COVER_MS })

      m.armCurtainOnPhoneGone()
      m.cancelCurtainOnPhoneGone()
      vi.advanceTimersByTime(GRACE_MS)

      expect(curtainShown).toBe(false)
      expect(m.getAwayModeState()).toBe('held')
    })

    it('does nothing when Away Mode is off', async () => {
      const m = await freshModule()
      m.armCurtainOnPhoneGone()
      vi.advanceTimersByTime(GRACE_MS)

      expect(curtainShown).toBe(false)
      expect(m.getAwayModeState()).toBe('off')
    })

    // The 2026-08-09 repro: the phone dropped, the user kept typing, and the window
    // covered his screen 600s later to the second. Postponing armed the COVER
    // timer only, so the grace timer ran on with nobody consulting the watch.
    it('a human at the Mac stands the window down, phone still gone', async () => {
      const m = await freshModule()
      await m.beginAwayMode({ coverDelayOverrideMs: NEVER_COVER_MS })

      m.armCurtainOnPhoneGone()
      vi.advanceTimersByTime(GRACE_MS - 1_000)
      await human()
      vi.advanceTimersByTime(GRACE_MS)

      expect(curtainShown).toBe(false)
      expect(m.getAwayModeState()).toBe('held')
    })

    // The other half: standing the window down must not make the Mac
    // uncoverable. Once the typing stops, the cover timer owns it.
    it('still covers after the human stops, on the cover delay', async () => {
      const m = await freshModule()
      await m.beginAwayMode()

      m.armCurtainOnPhoneGone()
      vi.advanceTimersByTime(DELAY_MS - 1_000)
      await human()
      expect(curtainShown).toBe(false)

      vi.advanceTimersByTime(DELAY_MS)

      expect(curtainShown).toBe(true)
      expect(detailOf('covered')).toBe('Mac untouched for the delay')
    })

    it('leaves an already-covered session covered — no second cover', async () => {
      const m = await freshModule()
      await m.beginAwayMode({ coverDelayOverrideMs: 1_000 })
      vi.advanceTimersByTime(1_000)
      expect(m.getAwayModeState()).toBe('covered')

      m.armCurtainOnPhoneGone()
      vi.advanceTimersByTime(GRACE_MS)

      expect(m.getAwayModeState()).toBe('covered')
      expect(ops.filter((o) => o === 'curtain:show')).toHaveLength(1)
    })

    it('hands the display-sleep blocker to stay-awake when handback finds the phone gone', async () => {
      const m = await freshModule()
      await m.beginAwayMode({ coverDelayOverrideMs: NEVER_COVER_MS })
      m.armCurtainOnPhoneGone()
      vi.advanceTimersByTime(GRACE_MS)

      await human()

      expect(m.getAwayModeState()).toBe('off')
      expect(ops).toContain('stayawake:graceRelease')
    })

    it('does not start the release countdown when the phone is still here', async () => {
      const m = await freshModule()
      await m.beginAwayMode()
      await m.handback()

      expect(ops).not.toContain('stayawake:graceRelease')
    })
  })

  describe('the cover watchdog', () => {
    it('takes down a cover that outlived its session', async () => {
      const m = await freshModule()
      await m.beginAwayMode()
      await m.handback()

      // A cover raised by a path nobody anticipated, after the teardown.
      curtainShown = true
      vi.advanceTimersByTime(2_000)

      expect(curtainShown).toBe(false)
    })
  })

  // devLog is IS_DEV-only and its file is truncated by `make restart`, so in a
  // packaged build the journal is the ONLY record of why protection did or did
  // not happen. These assert the reason survives, not that a line was printed.
  describe('the durable journal', () => {
    it('records the hold with the delay it will cover after', async () => {
      const m = await freshModule()
      await m.beginAwayMode()

      expect(journalled()).toContain('away-held')
      expect(detailOf('away-held')).toContain(formatDuration(DELAY_MS))
    })

    it('records a refusal with its reason and no hold', async () => {
      const m = await freshModule()
      watchAvailable = false

      await m.beginAwayMode()

      expect(journalled()).toContain('away-refused')
      expect(journalled()).not.toContain('away-held')
      expect(detailOf('away-refused')).toContain('no-input-watch')
    })

    it('records a failed lock acquisition as a refusal', async () => {
      const m = await freshModule()
      acquireOk = false

      await m.beginAwayMode()

      expect(journalled()).toContain('away-refused')
      expect(journalled()).not.toContain('away-held')
      expect(detailOf('away-refused')).toContain('failed')
    })

    it('records the cover with the trigger that raised it, verbatim', async () => {
      const m = await freshModule()
      await m.beginAwayMode()
      vi.advanceTimersByTime(DELAY_MS)

      expect(detailOf('covered')).toBe('Mac untouched for the delay')
    })

    it('distinguishes a grace-window cover from an idle one', async () => {
      const m = await freshModule()
      await m.beginAwayMode({ coverDelayOverrideMs: NEVER_COVER_MS })

      m.armCurtainOnPhoneGone()
      vi.advanceTimersByTime(GRACE_MS)

      expect(detailOf('covered')).toBe('phone gone for the grace window')
    })

    it('records who ended the session', async () => {
      const m = await freshModule()
      await m.beginAwayMode()
      vi.advanceTimersByTime(DELAY_MS)

      await human()

      expect(detailOf('away-ended')).toContain('ended by human')
    })

    // The one that matters: these two must never both fire for one session, or
    // the log claims the lock came back on a Mac that is still unlocked.
    it('records relock-failed and NOT away-ended when the lock does not come back', async () => {
      const m = await freshModule()
      await m.beginAwayMode()
      vi.advanceTimersByTime(DELAY_MS)

      releaseOk = false
      await m.handback()

      expect(journalled()).toContain('relock-failed')
      expect(journalled()).not.toContain('away-ended')
    })

    it('stays silent on a teardown with no session behind it', async () => {
      const m = await freshModule()
      await m.handback()

      expect(journalled()).not.toContain('away-ended')
    })

    // The breakdown is the only thing that would name input that isn't a person:
    // a count alone reads the same whether a key chattered or the 400px move
    // accumulator re-tripped, and those need opposite fixes.
    it('names the postpone kinds, dominant first, on away-ended', async () => {
      const m = await freshModule()
      await m.beginAwayMode()

      for (let i = 0; i < 10; i++) {
        vi.advanceTimersByTime(250)
        await human('mousemove')
      }
      vi.advanceTimersByTime(250)
      await human('keydown')
      // Past the cover so the last human() is a handback, not an 11th postpone.
      vi.advanceTimersByTime(DELAY_MS)
      await human()

      const detail = detailOf('away-ended') ?? ''
      expect(detail).toContain('11 postpones')
      expect(detail).toMatch(/mousemove 10, keydown 1/)
    })

    it('resets the kind breakdown between sessions', async () => {
      const m = await freshModule()
      await m.beginAwayMode()
      vi.advanceTimersByTime(250)
      await human('wheel')
      vi.advanceTimersByTime(DELAY_MS)
      await human()
      journalMock.mockClear()

      // A second session must not inherit the first session's wheel postpone.
      await m.beginAwayMode()
      vi.advanceTimersByTime(250)
      await human('mousedown')
      vi.advanceTimersByTime(DELAY_MS)
      await human()

      const detail = detailOf('away-ended') ?? ''
      expect(detail).toContain('mousedown')
      expect(detail).not.toContain('wheel')
    })

    it('records an orphaned cover the watchdog had to take down', async () => {
      const m = await freshModule()
      await m.beginAwayMode()
      await m.handback()

      curtainShown = true
      vi.advanceTimersByTime(2_000)

      expect(journalled()).toContain('cover-orphaned')
    })
  })

  describe('requestCoverNow', () => {
    const ARM_MS = CONFIG.PHONE_REMOTE.AWAY_COVER_ARM_MS

    it('covers a held session without locking', async () => {
      const m = await freshModule()
      await m.beginAwayMode()

      const res = await m.requestCoverNow()

      expect(res.ok).toBe(true)
      expect(m.getAwayModeState()).toBe('covered')
      expect(curtainShown).toBe(true)
      expect(holdHeld).toBe(true)
      expect(ops).not.toContain('hold:release')
    })

    it('is a no-op when already covered', async () => {
      const m = await freshModule()
      await m.requestCoverNow()
      ops = []

      const res = await m.requestCoverNow()

      expect(res.ok).toBe(true)
      expect(m.getAwayModeState()).toBe('covered')
      expect(ops).not.toContain('hold:release')
      expect(ops).not.toContain('curtain:show')
    })

    it('starts a session already covered from off', async () => {
      const m = await freshModule()
      const res = await m.requestCoverNow()

      expect(res.ok).toBe(true)
      expect(m.getAwayModeState()).toBe('covered')
      expect(curtainShown).toBe(true)
      expect(holdHeld).toBe(true)
    })

    it('does not lock on the click that asked for the cover', async () => {
      const m = await freshModule()
      await m.requestCoverNow()

      await human('mousedown')

      expect(m.getAwayModeState()).toBe('covered')
      expect(holdHeld).toBe(true)
      expect(ops).not.toContain('hold:release')
    })

    it('locks on a walk-up after the arm window', async () => {
      const m = await freshModule()
      await m.requestCoverNow()
      vi.advanceTimersByTime(ARM_MS)

      await human('mousedown')

      expect(m.getAwayModeState()).toBe('off')
      expect(holdHeld).toBe(false)
    })
  })

  describe('parseDisplaySleepMs', () => {
    it('reads the configured value even while our own blocker suppresses it', async () => {
      const m = await freshModule()
      const out = ' displaysleep 10 (display sleep prevented by Electron)'
      expect(m.parseDisplaySleepMs(out)).toBe(10 * 60 * 1000)
    })

    it('treats 0 (never) as no value', async () => {
      const m = await freshModule()
      expect(m.parseDisplaySleepMs(' displaysleep 0')).toBeNull()
    })

    it('treats a missing line as no value', async () => {
      const m = await freshModule()
      expect(m.parseDisplaySleepMs(' sleep 15\n disksleep 10')).toBeNull()
    })
  })
})
