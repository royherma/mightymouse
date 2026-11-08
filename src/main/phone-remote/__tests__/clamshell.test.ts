import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

/**
 * The contract under test is "the machine never stays asleep-disabled longer
 * than the user's session". So these tests model pmset as real mutable machine
 * state -- a shared flag every command reads and writes -- rather than asserting
 * on call counts. That way a test failure means the MACHINE would have been left
 * in a bad state, which is the thing that actually matters here.
 */
let machineSleepDisabled = false
let execCalls: string[] = []
// Set to simulate the user dismissing the macOS password dialog.
let authWillCancel = false
// Set to simulate pmset failing outright (permissions, missing binary).
let pmsetWillFail = false

vi.mock('child_process', () => ({
  exec: vi.fn((cmd: string, _opts: unknown, cb: (e: Error | null, out: string, err: string) => void) => {
    execCalls.push(cmd)

    // Read path — VERBATIM `pmset -g` output captured from a real macOS 15
    // machine, including the adjacent `Sleep On Power Button 1` line.
    //
    // This fixture is the whole point of the test file. The first version mocked
    // `pmset -g custom` with an invented `disablesleep 1` line; both the code and
    // the mock shared the same wrong model of pmset, so 12 tests passed green
    // while the real revert was broken on-device. Reading the LIVE flag is
    // `pmset -g` → `SleepDisabled`, never `-g custom` → `disablesleep`.
    if (cmd.trim() === 'pmset -g' || cmd.includes('pmset -g ')) {
      const out = [
        'System-wide power settings:',
        ` SleepDisabled\t\t${machineSleepDisabled ? 1 : 0}`,
        'Currently in use:',
        ' standby              1',
        ' Sleep On Power Button 1',
        ' displaysleep         10',
        ' sleep                1',
        ''
      ].join('\n')
      cb(null, out, '')
      return
    }

    // Privileged writes go through osascript's admin dialog.
    if (cmd.includes('osascript')) {
      if (authWillCancel) {
        cb(new Error('exit 1'), '', 'User cancelled. (-128)')
        return
      }
      if (pmsetWillFail) {
        cb(new Error('exit 1'), '', 'pmset: command failed')
        return
      }
      if (cmd.includes('disablesleep 1')) machineSleepDisabled = true
      if (cmd.includes('disablesleep 0')) machineSleepDisabled = false
      cb(null, '', '')
      return
    }

    cb(null, '', '')
  })
}))

vi.mock('../../../shared/env', () => ({
  devLog: { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

vi.mock('../../../shared/config', () => ({
  CONFIG: { PHONE_REMOTE: { CLAMSHELL_REVERT_MS: 1000 } }
}))

describe('phone-remote clamshell', () => {
  beforeEach(() => {
    machineSleepDisabled = false
    execCalls = []
    authWillCancel = false
    pmsetWillFail = false
    vi.clearAllMocks()
    vi.resetModules()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('enables and disables system sleep end to end', async () => {
    const { enableClamshell, disableClamshell, isClamshellHeld } = await import('../clamshell')

    const on = await enableClamshell()
    expect(on.ok).toBe(true)
    expect(machineSleepDisabled).toBe(true)
    expect(isClamshellHeld()).toBe(true)

    const off = await disableClamshell()
    expect(off.ok).toBe(true)
    expect(machineSleepDisabled).toBe(false)
    expect(isClamshellHeld()).toBe(false)
  })

  it('reports cancelled (not an error) when the user dismisses the prompt', async () => {
    const { enableClamshell, isClamshellHeld } = await import('../clamshell')
    authWillCancel = true

    const res = await enableClamshell()
    expect(res.ok).toBe(false)
    expect(res.cancelled).toBe(true)
    // The machine must be untouched -- a cancelled prompt that still flipped the
    // flag would be the worst possible outcome.
    expect(machineSleepDisabled).toBe(false)
    expect(isClamshellHeld()).toBe(false)
  })

  it('surfaces a real failure as an error, not a cancel', async () => {
    const { enableClamshell } = await import('../clamshell')
    pmsetWillFail = true

    const res = await enableClamshell()
    expect(res.ok).toBe(false)
    expect(res.cancelled).toBe(false)
    expect(res.error).toBeTruthy()
    expect(machineSleepDisabled).toBe(false)
  })

  // ── Layer 2: the crash guard ────────────────────────────────────────────────

  it('LAYER 2: clears a stale flag left by a crashed session at launch', async () => {
    // Simulate: previous run set the flag, then was SIGKILLed without reverting.
    machineSleepDisabled = true

    const { revertClamshellOnLaunch, isClamshellHeld } = await import('../clamshell')
    await revertClamshellOnLaunch()

    // This is the single most important assertion in the file: reopening the app
    // must heal a Mac that would otherwise never sleep again.
    expect(machineSleepDisabled).toBe(false)
    expect(isClamshellHeld()).toBe(false)
  })

  it('LAYER 2: is a silent no-op (no admin prompt) when nothing is stale', async () => {
    machineSleepDisabled = false
    const { revertClamshellOnLaunch } = await import('../clamshell')

    await revertClamshellOnLaunch()

    // Must not prompt on every normal launch -- that would be intolerable.
    expect(execCalls.some((c) => c.includes('osascript'))).toBe(false)
    expect(machineSleepDisabled).toBe(false)
  })

  it('LAYER 2: never auto-restores clamshell on launch', async () => {
    machineSleepDisabled = true
    const { revertClamshellOnLaunch, isClamshellHeld } = await import('../clamshell')

    await revertClamshellOnLaunch()

    // Consent is scoped to a session. Restoring it here would recreate the exact
    // "outlived its session" hazard the module exists to prevent.
    expect(isClamshellHeld()).toBe(false)
    expect(machineSleepDisabled).toBe(false)
  })

  // ── Layer 3: the disconnect watchdog ────────────────────────────────────────

  it('LAYER 3: reverts after the phone stays gone past the grace window', async () => {
    vi.useFakeTimers()
    const { enableClamshell, armIdleRevert } = await import('../clamshell')

    await enableClamshell()
    expect(machineSleepDisabled).toBe(true)

    armIdleRevert()
    await vi.advanceTimersByTimeAsync(1500)

    expect(machineSleepDisabled).toBe(false)
  })

  it('LAYER 3: a reconnect inside the window cancels the revert', async () => {
    vi.useFakeTimers()
    const { enableClamshell, armIdleRevert, cancelIdleRevert } = await import('../clamshell')

    await enableClamshell()
    armIdleRevert()

    // Phone drops and comes right back -- an ordinary Wi-Fi blip must not kill a
    // lid-closed session.
    await vi.advanceTimersByTimeAsync(400)
    cancelIdleRevert()
    await vi.advanceTimersByTimeAsync(3000)

    expect(machineSleepDisabled).toBe(true)
  })

  it('LAYER 3: does not arm when clamshell was never enabled', async () => {
    vi.useFakeTimers()
    const { armIdleRevert } = await import('../clamshell')

    armIdleRevert()
    await vi.advanceTimersByTimeAsync(3000)

    // No prompt, no work -- the watchdog is scoped to a held flag.
    expect(execCalls.some((c) => c.includes('osascript'))).toBe(false)
  })

  // ── Idempotence + adoption ──────────────────────────────────────────────────

  it('adopts an already-set flag without a second prompt', async () => {
    machineSleepDisabled = true
    const { enableClamshell, isClamshellHeld } = await import('../clamshell')

    const res = await enableClamshell()

    expect(res.ok).toBe(true)
    expect(isClamshellHeld()).toBe(true)
    expect(execCalls.some((c) => c.includes('osascript'))).toBe(false)
  })

  it('disable is a silent no-op when the flag is already clear', async () => {
    const { disableClamshell } = await import('../clamshell')

    const res = await disableClamshell()

    expect(res.ok).toBe(true)
    // The quit path calls this unconditionally -- prompting for a password on
    // every quit would be unusable.
    expect(execCalls.some((c) => c.includes('osascript'))).toBe(false)
  })

  // ── Regression: the read-the-wrong-command bug ──────────────────────────────

  it('REGRESSION: reads the LIVE flag via `pmset -g`, not `pmset -g custom`', async () => {
    machineSleepDisabled = true
    const { isSystemSleepDisabled } = await import('../clamshell')

    expect(await isSystemSleepDisabled()).toBe(true)

    // `-g custom` prints the saved PROFILE and never contains SleepDisabled, so
    // querying it reports "off" on a machine that is genuinely awake-locked --
    // which silently breaks every revert path. Shipped that bug once; this
    // asserts the command itself, since the return value alone can't tell the
    // two commands apart.
    expect(execCalls.some((c) => c.includes('-g custom'))).toBe(false)
    expect(execCalls.some((c) => c.trim() === 'pmset -g')).toBe(true)
  })

  it('REGRESSION: does not mistake `Sleep On Power Button 1` for the flag', async () => {
    // Real `pmset -g` output carries several lines ending in 1. A naive
    // whole-line /\b1\b/ match against the wrong line reports sleep as disabled
    // forever, so the app would prompt for a password on every quit trying to
    // "revert" a flag that was never set.
    machineSleepDisabled = false
    const { isSystemSleepDisabled } = await import('../clamshell')

    expect(await isSystemSleepDisabled()).toBe(false)
  })

  it('does not claim success when pmset lies about setting the flag', async () => {
    const { enableClamshell, isClamshellHeld } = await import('../clamshell')
    const cp = await import('child_process')

    // pmset exits 0 but the flag never actually lands (seen with MDM policy).
    vi.mocked(cp.exec).mockImplementation(
      // @ts-expect-error -- narrowed test double
      (cmd: string, _o: unknown, cb: (e: Error | null, o: string, s: string) => void) => {
        if (cmd.includes('pmset -g')) cb(null, ' SleepDisabled\t\t0\n sleep 1\n', '')
        else cb(null, '', '')
      }
    )

    const res = await enableClamshell()

    // Reporting success here would tell the user their lid is covered when it
    // isn't -- they'd shut the laptop and lose the session.
    expect(res.ok).toBe(false)
    expect(isClamshellHeld()).toBe(false)
  })
})
