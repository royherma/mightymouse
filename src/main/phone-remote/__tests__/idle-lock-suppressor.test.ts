import { describe, it, expect, beforeEach, vi } from 'vitest'

// The contract: acquire writes NO system setting and shows NO prompt, and the
// only command this module ever runs is the relock on release.

let commands: string[] = []
let swiftOk = true
let stayAwakeActive = true

vi.mock('child_process', () => ({
  exec: vi.fn(
    (
      cmd: string,
      _opts: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void
    ) => {
      commands.push(cmd)
      if (swiftOk) cb(null, '', '')
      else cb(new Error('exit 3'), '', 'dlsym failed')
    }
  )
}))

vi.mock('../stay-awake', () => ({
  isStayAwakeActive: vi.fn(() => stayAwakeActive)
}))

vi.mock('../../../shared/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../shared/env')>()),
  devLog: { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

async function freshModule(): Promise<typeof import('../idle-lock-suppressor')> {
  vi.resetModules()
  return import('../idle-lock-suppressor')
}

describe('idle-lock-suppressor', () => {
  beforeEach(() => {
    commands = []
    swiftOk = true
    stayAwakeActive = true
  })

  describe('acquire', () => {
    it('holds without running any command — no prompt, no system write', async () => {
      const m = await freshModule()

      const res = await m.suppressIdleLock()

      expect(res.ok).toBe(true)
      expect(m.isIdleLockSuppressed()).toBe(true)
      expect(commands).toHaveLength(0)
    })

    it('refuses when the display-sleep hold is not active', async () => {
      const m = await freshModule()
      stayAwakeActive = false

      const res = await m.suppressIdleLock()

      // Claiming a hold the blocker cannot back would let the Mac lock
      // mid-session with the phone believing it is protected.
      expect(res.ok).toBe(false)
      expect(m.isIdleLockSuppressed()).toBe(false)
      expect(commands).toHaveLength(0)
    })
  })

  describe('release', () => {
    it('relocks exactly once, via SACLockScreenImmediate', async () => {
      const m = await freshModule()
      await m.suppressIdleLock()

      const res = await m.endSessionAndLockMac()

      expect(res.ok).toBe(true)
      expect(m.isIdleLockSuppressed()).toBe(false)
      expect(commands).toHaveLength(1)
      expect(commands[0]).toContain('SACLockScreenImmediate')
    })

    it('does not lock a Mac it was never holding', async () => {
      const m = await freshModule()

      const res = await m.endSessionAndLockMac()

      // An ordinary quit must not lock a Mac the user left unlocked themselves.
      expect(res.ok).toBe(true)
      expect(commands).toHaveLength(0)
    })

    it('drops a live hold without SACLockScreenImmediate when relock is false', async () => {
      const m = await freshModule()
      await m.suppressIdleLock()

      const res = await m.endSessionAndLockMac({ relock: false })

      expect(res.ok).toBe(true)
      expect(m.isIdleLockSuppressed()).toBe(false)
      expect(commands).toHaveLength(0)
    })

    it('keeps holding when the relock lever fails', async () => {
      const m = await freshModule()
      await m.suppressIdleLock()

      swiftOk = false
      const res = await m.endSessionAndLockMac()

      // The lock did NOT engage — the caller keeps the cover up and can retry.
      expect(res.ok).toBe(false)
      expect(m.isIdleLockSuppressed()).toBe(true)

      swiftOk = true
      const retry = await m.endSessionAndLockMac()
      expect(retry.ok).toBe(true)
      expect(m.isIdleLockSuppressed()).toBe(false)
    })
  })

  describe('launch clear', () => {
    it('clears the flag and touches nothing — a crash left no setting to restore', async () => {
      const m = await freshModule()
      await m.suppressIdleLock()

      await m.clearIdleLockSuppressionOnLaunch()

      expect(m.isIdleLockSuppressed()).toBe(false)
      expect(commands).toHaveLength(0)
    })
  })

  describe('what this module must never do', () => {
    it('never reaches for osascript, sudo or sysadminctl', async () => {
      const m = await freshModule()
      await m.suppressIdleLock()
      await m.endSessionAndLockMac()
      await m.clearIdleLockSuppressionOnLaunch()

      for (const cmd of commands) {
        expect(cmd).not.toMatch(/osascript|sudo|sysadminctl/)
      }
    })
  })
})
