import { describe, it, expect, beforeEach, vi } from 'vitest'

// Fake powerSaveBlocker with the real semantics we depend on: ids are handed out
// monotonically, and isStarted() reflects start/stop. Tracking every id lets the
// tests assert the module never orphans one (the battery-leak failure mode).
const started = new Map<number, boolean>()
let nextId = 0

vi.mock('electron', () => ({
  powerSaveBlocker: {
    start: vi.fn((_type: string) => {
      const id = nextId++
      started.set(id, true)
      return id
    }),
    stop: vi.fn((id: number) => {
      started.set(id, false)
    }),
    isStarted: vi.fn((id: number) => started.get(id) === true)
  }
}))

// Only devLog is stubbed. The rest of env must stay real: config.ts calls
// readAppEnv()/pickByEnv() at module scope, and this file now imports CONFIG for
// the watchdog's grace window, so a bare object mock takes the whole suite down.
vi.mock('../../../shared/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../shared/env')>()),
  devLog: { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

// The watchdog reads the count through an injected source, so the suite feeds
// it directly rather than standing up the credential store.
let pairedCount = 0

const activeCount = (): number => [...started.values()].filter(Boolean).length

describe('phone-remote stay-awake', () => {
  beforeEach(async () => {
    started.clear()
    nextId = 0
    pairedCount = 0
    vi.clearAllMocks()
    vi.resetModules()
  })

  it('blocks display sleep on start and releases it on stop', async () => {
    const { startStayAwake, stopStayAwake, isStayAwakeActive } = await import('../stay-awake')
    const { powerSaveBlocker } = await import('electron')

    startStayAwake(true)
    expect(isStayAwakeActive()).toBe(true)
    // 'prevent-display-sleep' is load-bearing -- 'prevent-app-suspension' would
    // let the screen sleep, which is the bug this module exists to fix.
    expect(powerSaveBlocker.start).toHaveBeenCalledWith('prevent-display-sleep')

    stopStayAwake()
    expect(isStayAwakeActive()).toBe(false)
    expect(activeCount()).toBe(0)
  })

  it('is idempotent -- a double start holds exactly one blocker', async () => {
    const { startStayAwake, stopStayAwake } = await import('../stay-awake')
    const { powerSaveBlocker } = await import('electron')

    startStayAwake(true)
    startStayAwake(true)
    startStayAwake(true)

    expect(powerSaveBlocker.start).toHaveBeenCalledTimes(1)
    expect(activeCount()).toBe(1)

    // One stop must fully release -- if a second blocker had been orphaned the
    // display would stay pinned awake after the remote was switched off.
    stopStayAwake()
    expect(activeCount()).toBe(0)
  })

  it('tolerates stop when nothing is held', async () => {
    const { stopStayAwake, isStayAwakeActive } = await import('../stay-awake')
    const { powerSaveBlocker } = await import('electron')

    // The app-quit path calls this unconditionally, usually with the remote off.
    expect(() => stopStayAwake()).not.toThrow()
    expect(powerSaveBlocker.stop).not.toHaveBeenCalled()
    expect(isStayAwakeActive()).toBe(false)
  })

  it('can restart after a stop', async () => {
    const { startStayAwake, stopStayAwake, isStayAwakeActive } = await import('../stay-awake')

    startStayAwake(true)
    stopStayAwake()
    startStayAwake(true)

    expect(isStayAwakeActive()).toBe(true)
    expect(activeCount()).toBe(1)
  })

  it('recovers if start throws -- no stuck id disabling later starts', async () => {
    const { startStayAwake, isStayAwakeActive } = await import('../stay-awake')
    const { powerSaveBlocker } = await import('electron')

    vi.mocked(powerSaveBlocker.start).mockImplementationOnce(() => {
      throw new Error('power management unavailable')
    })

    expect(() => startStayAwake(true)).not.toThrow()
    expect(isStayAwakeActive()).toBe(false)

    // A failed start must leave the module startable -- if it cached a bogus id
    // the idempotence guard would skip every future start.
    startStayAwake(true)
    expect(isStayAwakeActive()).toBe(true)
  })

  it('clears its id even if stop throws', async () => {
    const { startStayAwake, stopStayAwake, isStayAwakeActive } = await import('../stay-awake')
    const { powerSaveBlocker } = await import('electron')

    startStayAwake(true)
    vi.mocked(powerSaveBlocker.stop).mockImplementationOnce(() => {
      throw new Error('already released')
    })

    expect(() => stopStayAwake()).not.toThrow()
    expect(isStayAwakeActive()).toBe(false)
  })

  // The leak these cover was live in production: startStayAwake() was tied to
  // the phone-remote SERVER lifecycle while nothing released it on disconnect,
  // so enabling Phone Remote lit the display until the user toggled it back off
  // -- measured at 7m48s and climbing via `pmset -g assertions`, with no phone
  // ever connected.
  describe('disconnect watchdog', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    it('releases the block when the phone stays gone', async () => {
      const { startStayAwake, armIdleLockRearm, isStayAwakeActive } = await import('../stay-awake')
      const { CONFIG } = await import('../../../shared/config')

      startStayAwake(true)
      armIdleLockRearm()

      // Still held one tick before the deadline: releasing early would sleep the
      // display mid-session, the exact failure the module exists to prevent.
      vi.advanceTimersByTime(CONFIG.PHONE_REMOTE.IDLE_LOCK_REARM_MS - 1)
      expect(isStayAwakeActive()).toBe(true)

      vi.advanceTimersByTime(1)
      expect(isStayAwakeActive()).toBe(false)
      expect(activeCount()).toBe(0)
    })

    it('keeps the block when the phone returns inside the grace window', async () => {
      const { startStayAwake, armIdleLockRearm, cancelIdleLockRearm, isStayAwakeActive } =
        await import('../stay-awake')
      const { CONFIG } = await import('../../../shared/config')

      startStayAwake(true)
      armIdleLockRearm()
      cancelIdleLockRearm()

      // An ordinary Wi-Fi blip (screen lock, pocket) must cost nothing.
      vi.advanceTimersByTime(CONFIG.PHONE_REMOTE.IDLE_LOCK_REARM_MS * 2)
      expect(isStayAwakeActive()).toBe(true)
    })

    it('does not let a stale watchdog release a later session', async () => {
      const { startStayAwake, stopStayAwake, armIdleLockRearm, isStayAwakeActive } =
        await import('../stay-awake')
      const { CONFIG } = await import('../../../shared/config')

      startStayAwake(true)
      armIdleLockRearm()
      stopStayAwake()

      // User re-enables before the old timer would have fired. If stopStayAwake()
      // left it armed, this block dies for no reason a user could explain.
      startStayAwake(true)
      vi.advanceTimersByTime(CONFIG.PHONE_REMOTE.IDLE_LOCK_REARM_MS * 2)
      expect(isStayAwakeActive()).toBe(true)
    })

    it('arms nothing when no block is held', async () => {
      const { armIdleLockRearm, isStayAwakeActive } = await import('../stay-awake')
      const { CONFIG } = await import('../../../shared/config')

      armIdleLockRearm()
      vi.advanceTimersByTime(CONFIG.PHONE_REMOTE.IDLE_LOCK_REARM_MS * 2)
      expect(isStayAwakeActive()).toBe(false)
    })

    // Roy's Mac idle-locked on 2026-09-09 because his pocketed iPhone read as
    // an abandoned session: the socket closes on visibilitychange, the short
    // window released the blocker, macOS locked, and the phone could not undo
    // it. No window is right -- a week away looks exactly like a pocket -- so a
    // paired device means the watchdog never arms. A week of fake time proves
    // it is the absence of a timer and not a longer one.
    it('never releases the block on a timer once a device is paired', async () => {
      pairedCount = 1
      const { startStayAwake, armIdleLockRearm, isStayAwakeActive, setPairedDeviceCountSource } =
        await import('../stay-awake')
      setPairedDeviceCountSource(() => pairedCount)

      startStayAwake(true)
      armIdleLockRearm()

      vi.advanceTimersByTime(7 * 24 * 60 * 60 * 1000)
      expect(isStayAwakeActive()).toBe(true)
    })

    // The explicit acts still release it: the user turning stay-awake off, the
    // server stopping, app quit. All three land on stopStayAwake().
    it('still releases when the user turns stay-awake off', async () => {
      pairedCount = 1
      const { startStayAwake, stopStayAwake, isStayAwakeActive, setPairedDeviceCountSource } =
        await import('../stay-awake')
      setPairedDeviceCountSource(() => pairedCount)

      startStayAwake(true)
      expect(isStayAwakeActive()).toBe(true)

      stopStayAwake()
      expect(isStayAwakeActive()).toBe(false)
    })

    it('keeps the short window when nothing is paired', async () => {
      pairedCount = 0
      const { startStayAwake, armIdleLockRearm, isStayAwakeActive, setPairedDeviceCountSource } =
        await import('../stay-awake')
      setPairedDeviceCountSource(() => pairedCount)
      const { CONFIG } = await import('../../../shared/config')

      startStayAwake(true)
      armIdleLockRearm()

      vi.advanceTimersByTime(CONFIG.PHONE_REMOTE.IDLE_LOCK_REARM_MS)
      expect(isStayAwakeActive()).toBe(false)
    })
  })

  // Measured on Roy's Mac 2026-08-14: `pmset -g assertions` showed Electron
  // holding NoDisplaySleepAssertion for 1h11m with Phone Remote enabled, stay-
  // awake on and no phone ever paired. The watchdog above existed but was wired
  // only to onDisconnect, which a phone that never connects never reaches.
  describe('never-connected server', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    it('releases the block when the server starts with no phone connected', async () => {
      const { startStayAwake, isStayAwakeActive } = await import('../stay-awake')
      const { CONFIG } = await import('../../../shared/config')

      // The launch-restore / toggle-on path: a server event, no phone involved.
      startStayAwake(false)
      expect(isStayAwakeActive()).toBe(true)

      vi.advanceTimersByTime(CONFIG.PHONE_REMOTE.IDLE_LOCK_REARM_MS - 1)
      expect(isStayAwakeActive()).toBe(true)

      vi.advanceTimersByTime(1)
      expect(isStayAwakeActive()).toBe(false)
      expect(activeCount()).toBe(0)
    })

    it('keeps the block when a phone connects inside the window', async () => {
      const { startStayAwake, cancelIdleLockRearm, isStayAwakeActive } =
        await import('../stay-awake')
      const { CONFIG } = await import('../../../shared/config')

      startStayAwake(false)
      // What onConnect does at phone-remote.ts:2324.
      cancelIdleLockRearm()

      vi.advanceTimersByTime(CONFIG.PHONE_REMOTE.IDLE_LOCK_REARM_MS * 2)
      expect(isStayAwakeActive()).toBe(true)
    })

    it('holds indefinitely when a phone is already connected', async () => {
      const { startStayAwake, isStayAwakeActive } = await import('../stay-awake')
      const { CONFIG } = await import('../../../shared/config')

      // Away Mode's call. A release armed here would let the display sleep,
      // which re-arms macOS's idle lock and locks out the phone being served.
      startStayAwake(true)

      vi.advanceTimersByTime(CONFIG.PHONE_REMOTE.IDLE_LOCK_REARM_MS * 2)
      expect(isStayAwakeActive()).toBe(true)
    })
  })
})
